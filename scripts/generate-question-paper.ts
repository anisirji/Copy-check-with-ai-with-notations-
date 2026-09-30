/**
 * Reverse-engineer a question paper from a scanned student answer sheet.
 *
 * For each page, we ask the vision cascade to look at the answers the student
 * wrote and reconstruct the ORIGINAL question paper they were answering. The
 * result is written to:
 *
 *   <out-dir>/<label>-questions.json  — machine-readable extract
 *   <out-dir>/<label>-questions.md    — human-readable review sheet
 *   <out-dir>/<label>-questions.pdf   — the paper you upload into the flow
 *
 * Usage:
 *   pnpm tsx scripts/generate-question-paper.ts <answer-sheet.pdf> <out-dir> [--label=<name>] [--subject=<biology|math|...>] [--total=<n>]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { pdfToPages } from "../backend/src/services/preprocess.js";
import { ProviderRegistry } from "../backend/src/providers/index.js";
import { extractJson } from "../backend/src/services/util-json.js";

interface ReconstructedQuestion {
  id: string;
  prompt: string;
  maxMarks: number | null;
  subject: string;
}

const RECONSTRUCT_PROMPT = `You are looking at a scanned school answer sheet. Reconstruct the QUESTION PAPER the student was answering — output only the questions, not the answers.

Structural rules (prefer the SIMPLEST structure visible on the page):
- Read the labels the student used ("Ans 1", "Ans 1(a)", "Q2 (i)"). Those tell you the question ids.
- Emit ONE question per label the student ACTUALLY used. Do not invent sub-parts. Do not fabricate "6(iv)" if there is no "iv)" on the page.
- If the student wrote only "Q6" + one paragraph, emit ONE question "6". Do not split it into 6(a), 6(b), 6(c) unless there are 3 visually distinct answer segments with sub-part labels.
- If the paper uses roman numerals ("i)", "ii)") under a parent, emit "1(i)", "1(ii)" — do NOT nest as "1(a)(i)" unless there are also (a)/(b) labels visible on the page.
- Preserve labels EXACTLY as written when possible (e.g. keep "1(a)" if that's what the student wrote); never re-letter them.

Wording rules:
- Infer the most likely ORIGINAL question. Use the student's answer as a strong hint. Prefer standard Indian school phrasings (CBSE/ICSE tone).
- If the student wrote a single term (e.g. "Terrestrial", "Trophic level"), phrase the question so that ONE-WORD term is the expected answer — NOT a full definition. Use "Name…" / "What is called…" / "Which is…" phrasings.
- If the answer is genuinely a definition (multiple sentences explaining a concept), phrase as "Define <term>." or "What is <term>?".
- If the student wrote fill-in-the-blank answers, phrase the question with a "_____" where the answer goes.
- If the student wrote a computation, phrase the question in terms of the given values (e.g. "Find the area of a rectangle 9 cm × 3 2/3 cm.").
- If the answer looks incorrect, still reconstruct the question as it likely appeared on the paper. Do not "fix" toward the wrong answer.

Housekeeping:
- Do NOT include headers, name/date/roll fields, page numbers, or teacher marks.
- Marks: if the paper shows a mark allocation, put it in maxMarks. Otherwise use null and a downstream step will assign marks.
- Subject: one of "math" | "physics" | "chemistry" | "biology" | "general".

Return ONLY a JSON array. No prose, no code fences.

[
  { "id": "1(a)", "prompt": "Fill in the blank: The producers of a food chain are _____.", "maxMarks": 1, "subject": "biology" },
  ...
]
If the page has no answerable questions (cover page, blank rough work), return [].`;

async function reconstructFromAnswerSheet(
  answerPdf: string,
  workDir: string,
  registry: ProviderRegistry,
): Promise<ReconstructedQuestion[]> {
  await fs.mkdir(workDir, { recursive: true });
  const pages = await pdfToPages(answerPdf, workDir);

  const merged = new Map<string, ReconstructedQuestion>();
  for (const page of pages) {
    const bytes = await fs.readFile(page.imagePath);
    const resp = await registry.call("question-extraction", {
      prompt: RECONSTRUCT_PROMPT,
      images: [{ mimeType: "image/png", base64: bytes.toString("base64") }],
      temperature: 0.2,
    });
    const arr = extractJson<ReconstructedQuestion[]>(resp.text);
    if (!Array.isArray(arr)) continue;
    for (const q of arr) {
      if (!q?.id || !q?.prompt) continue;
      const key = q.id.trim().toLowerCase().replace(/\s+/g, "");
      if (merged.has(key)) continue;
      merged.set(key, {
        id: q.id.trim(),
        prompt: q.prompt.trim(),
        maxMarks: typeof q.maxMarks === "number" ? q.maxMarks : null,
        subject: typeof q.subject === "string" ? q.subject : "general",
      });
    }
  }
  return Array.from(merged.values());
}

async function writeMarkdown(
  qs: ReconstructedQuestion[],
  file: string,
  header: { label: string; totalMarks?: number; subject?: string },
): Promise<void> {
  const lines = [
    `# ${header.label} — question paper (reconstructed)`,
    "",
    header.subject ? `**Subject:** ${header.subject}` : "",
    header.totalMarks != null ? `**Total marks:** ${header.totalMarks}` : "",
    "",
    ...qs.map(
      (q) =>
        `**${q.id}** ${q.maxMarks != null ? `[${q.maxMarks}]` : ""}\n\n${q.prompt}\n`,
    ),
  ].filter(Boolean);
  await fs.writeFile(file, lines.join("\n"));
}

async function writePdf(
  qs: ReconstructedQuestion[],
  file: string,
  header: { label: string; totalMarks?: number; subject?: string },
): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);

  const pageSize: [number, number] = [612, 792]; // US Letter
  const margin = 54;
  const bodySize = 12;
  const lineGap = 4;
  const maxWidth = pageSize[0] - margin * 2;

  let page = pdf.addPage(pageSize);
  let y = pageSize[1] - margin;

  const drawText = (
    text: string,
    fontRef: typeof font,
    size: number,
    leftPad = 0,
  ): void => {
    const wrapped = wrap(text, fontRef, size, maxWidth - leftPad);
    for (const line of wrapped) {
      if (y < margin + size) {
        page = pdf.addPage(pageSize);
        y = pageSize[1] - margin;
      }
      page.drawText(line, {
        x: margin + leftPad,
        y: y - size,
        size,
        font: fontRef,
      });
      y -= size + lineGap;
    }
  };

  drawText(`${header.label.toUpperCase()} — Unit Test`, bold, 18);
  y -= 6;
  const meta = [
    header.subject ? `Subject: ${header.subject}` : null,
    header.totalMarks != null ? `Total Marks: ${header.totalMarks}` : null,
    "Time: 45 minutes",
  ]
    .filter(Boolean)
    .join("   |   ");
  drawText(meta, font, bodySize);
  y -= 10;

  for (const q of qs) {
    if (y < margin + 40) {
      page = pdf.addPage(pageSize);
      y = pageSize[1] - margin;
    }
    const head = `${q.id}${q.maxMarks != null ? `  [${q.maxMarks} mark${q.maxMarks === 1 ? "" : "s"}]` : ""}`;
    drawText(head, bold, bodySize);
    drawText(q.prompt, font, bodySize, 16);
    y -= 6;
  }

  await fs.writeFile(file, await pdf.save());
}

function wrap(
  text: string,
  font: { widthOfTextAtSize: (s: string, size: number) => number },
  size: number,
  maxWidth: number,
): string[] {
  const sanitized = text.replace(/[\r]/g, "").split(/\n/);
  const out: string[] = [];
  for (const paragraph of sanitized) {
    const words = paragraph.split(/\s+/);
    let line = "";
    for (const word of words) {
      const cleanWord = word.replace(/[^\x20-\x7E]/g, "?");
      const candidate = line ? `${line} ${cleanWord}` : cleanWord;
      if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
        out.push(line);
        line = cleanWord;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length < 2) {
    console.error(
      "usage: generate-question-paper <answer-sheet.pdf> <out-dir> [--label=x] [--subject=biology] [--total=20]",
    );
    process.exit(1);
  }
  const [answerPdf, outDir] = positional;
  const label = (
    args.find((a) => a.startsWith("--label="))?.split("=")[1] ??
    path.basename(answerPdf, path.extname(answerPdf))
  )
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const subject = args.find((a) => a.startsWith("--subject="))?.split("=")[1];
  const totalRaw = args.find((a) => a.startsWith("--total="))?.split("=")[1];
  const totalMarks = totalRaw ? Number(totalRaw) : undefined;

  const registry = ProviderRegistry.default();
  const active = registry.configured();
  if (active.length === 0) {
    throw new Error("No providers configured — check .env");
  }
  console.log(`[${label}] providers: ${active.map((p) => p.name).join(", ")}`);

  const workDir = path.resolve(outDir, ".work");
  const qs = await reconstructFromAnswerSheet(
    path.resolve(answerPdf),
    workDir,
    registry,
  );
  await fs.rm(workDir, { recursive: true, force: true });

  await fs.mkdir(outDir, { recursive: true });
  const jsonPath = path.resolve(outDir, `${label}-questions.json`);
  const mdPath = path.resolve(outDir, `${label}-questions.md`);
  const pdfPath = path.resolve(outDir, `${label}-questions.pdf`);
  await fs.writeFile(jsonPath, JSON.stringify(qs, null, 2));
  await writeMarkdown(qs, mdPath, { label, subject, totalMarks });
  await writePdf(qs, pdfPath, { label, subject, totalMarks });

  console.log(
    `[${label}] reconstructed ${qs.length} questions → ${path.relative(process.cwd(), pdfPath)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
