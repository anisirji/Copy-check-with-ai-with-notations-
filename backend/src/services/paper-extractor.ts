import fs from "node:fs/promises";
import { pdfToPages } from "./preprocess.js";
import { ProviderRegistry } from "../providers/index.js";
import { extractJson } from "./util-json.js";

const PAPER_PROMPT = `You are extracting questions from a printed question-paper page.

For each question, return:
  - id      — as written on the paper (e.g. "Q1", "Q3(a)", "2.i"). Keep it verbatim.
  - prompt  — the question text as written (LaTeX-style for math, describe diagrams briefly).
  - maxMarks — marks assigned to that question if visible on the paper. If not visible use null.
  - subject — best guess: "math" | "physics" | "chemistry" | "biology" | "general".

Rules:
- Skip headers ("School:", "Class:", "Total Marks:") and general instructions.
- Include sub-parts as their own questions if each is separately marked (e.g. "3(a)", "3(b)").
- If several blanks or sub-parts share one mark allocation, keep them together as one question with all sub-part labels in its prompt. Do not infer a separate mark for each blank or repeat the shared marks on each part.
- Preserve parent totals: a task marked 2 × 3½ = 7 with six instructions for each atom is ONE 7-mark question (or two explicitly marked 3.5-mark questions), never twelve 1-mark questions. Count a printed mark allocation once. Preserve all instructions and the atom/section labels.
- Return ONLY a JSON array, no prose, no fences.
- If the page has no questions (e.g. cover page), return [].

Format:
[
  { "id": "Q1", "prompt": "...", "maxMarks": 5, "subject": "chemistry" },
  ...
]`;

export interface ExtractedQuestion {
  id: string;
  prompt: string;
  maxMarks: number | null;
  subject: "math" | "physics" | "chemistry" | "biology" | "general";
}

/**
 * Phase 1 — Extract questions from a printed question-paper PDF.
 *
 * Rasterizes each page and runs it through the vision cascade. De-duplicates
 * across pages by id (a long question spread over 2 pages should be returned
 * once). Returns questions in the order they appear.
 */
export async function extractQuestions(
  paperPdfPath: string,
  registry: ProviderRegistry,
  workDir: string,
): Promise<ExtractedQuestion[]> {
  await fs.mkdir(workDir, { recursive: true });
  const pages = await pdfToPages(paperPdfPath, workDir);

  const all: ExtractedQuestion[] = [];
  const seen = new Set<string>();

  for (const page of pages) {
    const bytes = await fs.readFile(page.imagePath);
    const resp = await registry.call("question-extraction", {
      prompt: PAPER_PROMPT,
      images: [{ mimeType: "image/png", base64: bytes.toString("base64") }],
      temperature: 0.1,
    });
    const parsed = extractJson<ExtractedQuestion[]>(resp.text);
    if (!Array.isArray(parsed)) continue;
    for (const q of parsed) {
      if (!q.id || !q.prompt) continue;
      const key = q.id.toLowerCase().replace(/\s+/g, "");
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({
        id: q.id.trim(),
        prompt: q.prompt.trim(),
        maxMarks: typeof q.maxMarks === "number" ? q.maxMarks : null,
        subject:
          (
            ["math", "physics", "chemistry", "biology", "general"] as const
          ).find((s) => s === q.subject) ?? "general",
      });
    }
  }

  return all;
}
