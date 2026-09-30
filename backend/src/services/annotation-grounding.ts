import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import type { Block, PageMeta, QuestionGrading, RubricEval } from "../types.js";
import type { ProviderRegistry } from "../providers/index.js";
import { extractJson } from "./util-json.js";
import { writeJsonAtomic } from "./file-store.js";

const exec = promisify(execFile);
type BBox = Block["bbox"];
export interface TextRegion {
  id: string;
  page: number;
  text: string;
  bbox: BBox;
  kind: "text" | "diagram";
  words: { text: string; bbox: BBox }[];
}
interface Placement {
  questionId: string;
  criterionId: string;
  regionId: string;
  firstWord?: number;
  lastWord?: number;
  feedback?: string;
}
export interface GroundingReport {
  version: 1;
  updatedAt: string;
  placed: number;
  unlocated: { questionId: string; criterionId: string }[];
}
const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Coordinates come exclusively from a local detector. The model selects IDs
 * and word ranges while inspecting the scan; it never invents coordinates. */
export async function groundAnnotationEvidence(
  grading: QuestionGrading[],
  blocks: Block[],
  pages: PageMeta[],
  registry: ProviderRegistry,
  cacheFile: string,
): Promise<GroundingReport> {
  const regions = await detectTextRegions(pages, cacheFile);
  const audit: unknown[] = [];
  const blockById = new Map(blocks.map((b) => [b.id, b]));
  for (const page of pages) {
    const candidates = regions.filter((r) => r.page === page.page);
    if (!candidates.length) continue;
    const criteria = grading.flatMap((g) =>
      g.rubricEvaluation
        .filter(
          (e) =>
            !e.evidenceRegion &&
            blockById.get(e.evidenceBlockId ?? "")?.page === page.page,
        )
        .map((e) => ({
          questionId: g.questionId,
          criterionId: e.criterionId,
          concept: e.concept,
          evidence: e.evidence,
          status: e.status,
        })),
    );
    if (!criteria.length) continue;
    try {
      const response = await registry.call("vision-primary", {
        images: [
          {
            mimeType: "image/png",
            base64: (await fs.readFile(page.imagePath)).toString("base64"),
          },
        ],
        temperature: 0,
        prompt: `Locate the evidence for existing marking decisions on this scanned answer sheet. DO NOT grade or change marks.
The supplied regions have real pixel-derived coordinates. Their OCR text can be wrong; read the IMAGE to identify the correct region.
For each criterion select exactly one regionId from this page. For text, select the tightest relevant consecutive words by zero-based firstWord and lastWord. Prefer the final result line for a calculation. For diagrams use only a region whose kind is diagram. A blank or an unlocatable answer must be omitted, never guessed. Ignore crossed-out words. Different criteria may share a region only when that writing supports both.
For an incorrect/partial/missing criterion also give feedback: one brief teaching correction, at most 100 characters, addressing the student's specific error. Do not merely repeat the concept heading. Do not contradict the supplied decision. Omit feedback on correct answers.
Return ONLY {"placements":[{"questionId":"...","criterionId":"...","regionId":"...","firstWord":0,"lastWord":2,"feedback":"..."}]}.
Criteria: ${JSON.stringify(criteria)}
Regions (word indexes are their positions in words): ${JSON.stringify(candidates.map((r) => ({ id: r.id, kind: r.kind, text: r.text, words: r.words.map((w) => w.text), bbox: r.bbox })))}`,
      });
      const parsed = extractJson<{ placements?: Placement[] }>(response.text);
      audit.push({
        page: page.page,
        provider: response.provider,
        model: response.model,
        response: parsed,
      });
      applyEvidencePlacements(
        grading,
        candidates,
        parsed?.placements ?? [],
        new Set(criteria.map((c) => `${c.questionId}:${c.criterionId}`)),
        page.width / page.height,
      );
      await writeJsonAtomic(
        path.join(path.dirname(cacheFile), "annotation-grounding.json"),
        { updatedAt: new Date().toISOString(), audit },
      );
    } catch (error) {
      console.warn(
        `[annotations] page ${page.page}: ${(error as Error).message}. Unlocated marks remain in the margin.`,
      );
    }
  }
  const unlocated = grading.flatMap((g) =>
    g.rubricEvaluation
      .filter((e) => !e.evidenceRegion)
      .map((e) => ({ questionId: g.questionId, criterionId: e.criterionId })),
  );
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    placed:
      grading.reduce((s, g) => s + g.rubricEvaluation.length, 0) -
      unlocated.length,
    unlocated,
  };
}

/** Validate all model-selected handles. Invalid/foreign IDs and word ranges
 * never become ink coordinates; multiple placements for one criterion are ambiguous. */
export function applyEvidencePlacements(
  grading: QuestionGrading[],
  regions: TextRegion[],
  placements: Placement[],
  allowed?: Set<string>,
  aspectRatio = 0.707,
): void {
  const byId = new Map(regions.map((r) => [r.id, r]));
  const counts = new Map<string, number>();
  for (const p of placements)
    counts.set(
      `${p.questionId}:${p.criterionId}`,
      (counts.get(`${p.questionId}:${p.criterionId}`) ?? 0) + 1,
    );
  for (const p of placements) {
    const key = `${p.questionId}:${p.criterionId}`;
    if (counts.get(key) !== 1 || (allowed && !allowed.has(key))) continue;
    const ev = grading
      .find((g) => g.questionId === p.questionId)
      ?.rubricEvaluation.find((e) => e.criterionId === p.criterionId);
    const region = byId.get(p.regionId);
    if (!ev || !region || ev.evidenceRegion) continue;
    if (/diagram|bohr|sketch/i.test(ev.concept) && region.kind !== "diagram")
      continue;
    let bbox = region.bbox;
    if (region.kind === "text" && region.words.length) {
      if (
        !Number.isInteger(p.firstWord) ||
        !Number.isInteger(p.lastWord) ||
        p.firstWord! < 0 ||
        p.lastWord! < p.firstWord! ||
        p.lastWord! >= region.words.length
      )
        continue;
      bbox = unionBoxes(
        region.words.slice(p.firstWord, p.lastWord! + 1).map((w) => w.bbox),
      );
    }
    if (!validBox(bbox)) continue;
    const obstacles = regions
      .filter((r) => r.page === region.page)
      .flatMap((r) => (r.words.length ? r.words.map((w) => w.bbox) : [r.bbox]));
    const placementBox =
      region.kind === "diagram"
        ? {
            ...bbox,
            x: Math.max(0, bbox.x - 0.018),
            width: Math.min(
              1 - Math.max(0, bbox.x - 0.018),
              bbox.width + 0.036,
            ),
          }
        : bbox;
    ev.evidenceRegion = {
      page: region.page,
      bbox,
      source: "local_ocr",
      mark: chooseInkPosition(placementBox, obstacles, aspectRatio),
    };
    if (
      ev.status !== "correct" &&
      typeof p.feedback === "string" &&
      p.feedback.trim()
    )
      ev.feedback = p.feedback.trim().slice(0, 160);
  }
}

/** Check the full drawn mark against every detected word, including words
 * outside the quoted evidence. The clear outer margin is the final fallback. */
export function chooseInkPosition(
  bbox: BBox,
  obstacles: BBox[],
  aspectRatio = 0.707,
): { x: number; y: number } {
  const cy = bbox.y + bbox.height / 2;
  const candidates = [
    { x: bbox.x + bbox.width + 0.022, y: cy },
    { x: bbox.x - 0.025, y: cy },
    {
      x: bbox.x + bbox.width + 0.01,
      y: bbox.y + bbox.height + 0.022 * aspectRatio,
    },
  ];
  for (const point of candidates) {
    const mark = {
      x: point.x - 0.0115,
      y: point.y - 0.0155 * aspectRatio,
      width: 0.03,
      height: 0.027 * aspectRatio,
    };
    if (
      mark.x < 0 ||
      mark.y < 0 ||
      mark.x + mark.width > 0.997 ||
      mark.y + mark.height > 1
    )
      continue;
    if (
      !obstacles.some(
        (b) =>
          mark.x < b.x + b.width + 0.004 &&
          mark.x + mark.width > b.x - 0.004 &&
          mark.y < b.y + b.height + 0.0015 &&
          mark.y + mark.height > b.y - 0.0015,
      )
    )
      return point;
  }
  return { x: 1.017, y: cy };
}

export function unionBoxes(boxes: BBox[]): BBox {
  const x = Math.min(...boxes.map((b) => b.x)),
    y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
  };
}
function validBox(b: BBox) {
  return (
    Object.values(b).every(Number.isFinite) &&
    b.x >= 0 &&
    b.y >= 0 &&
    b.width > 0 &&
    b.height > 0 &&
    b.x + b.width <= 1.001 &&
    b.y + b.height <= 1.001
  );
}

export async function detectTextRegions(
  pages: PageMeta[],
  cacheFile: string,
): Promise<TextRegion[]> {
  const hashes = await Promise.all(
    pages.map(async (p) => ({
      page: p.page,
      hash: digest(await fs.readFile(p.imagePath)),
    })),
  );
  try {
    const cached = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    if (
      cached.version === 5 &&
      JSON.stringify(cached.hashes) === JSON.stringify(hashes)
    )
      return cached.regions;
  } catch {
    /* cache miss */
  }
  let regions: TextRegion[] = [];
  if (process.platform === "darwin") {
    const source = fileURLToPath(
      new URL("./recognize-text.m", import.meta.url),
    );
    const dir = path.join(
      os.tmpdir(),
      `scholiphi-text-${digest(await fs.readFile(source)).slice(0, 12)}`,
    );
    const binary = path.join(dir, "recognize-text");
    await fs.mkdir(dir, { recursive: true });
    try {
      await fs.access(binary);
    } catch {
      const temp = `${binary}-${randomUUID()}`;
      await exec(
        "clang",
        [
          "-fobjc-arc",
          "-framework",
          "Foundation",
          "-framework",
          "Vision",
          source,
          "-o",
          temp,
        ],
        { timeout: 60_000 },
      );
      await fs.rename(temp, binary);
    }
    const { stdout } = await exec(
      binary,
      pages.map((p) => p.imagePath),
      { timeout: 60_000, maxBuffer: 15 * 1024 * 1024 },
    );
    const found = JSON.parse(stdout) as {
      regions: Omit<TextRegion, "id" | "page" | "kind">[];
    }[];
    regions = found.flatMap((p, i) =>
      p.regions
        .filter((r) => validBox(r.bbox))
        .map((r, j) => ({
          ...r,
          id: `p${pages[i].page}-line${j}`,
          page: pages[i].page,
          kind: "text" as const,
        })),
    );
  } else {
    // Tesseract supplies local line/word geometry on other supported hosts.
    for (const p of pages) {
      const { stdout } = await exec(
        "tesseract",
        [p.imagePath, "stdout", "tsv"],
        { timeout: 60_000, maxBuffer: 15 * 1024 * 1024 },
      );
      const lines = new Map<string, TextRegion>();
      for (const row of stdout.split("\n").slice(1)) {
        const c = row.split("\t");
        if (c[0] !== "5" || !c[11]?.trim()) continue;
        const id = `p${p.page}-line${c.slice(2, 5).join("-")}`;
        const bbox = {
          x: +c[6] / p.width,
          y: +c[7] / p.height,
          width: +c[8] / p.width,
          height: +c[9] / p.height,
        };
        if (!validBox(bbox)) continue;
        const line = lines.get(id) ?? {
          id,
          page: p.page,
          kind: "text",
          text: "",
          bbox,
          words: [],
        };
        line.words.push({ text: c[11], bbox });
        line.text = line.words.map((w) => w.text).join(" ");
        line.bbox = unionBoxes(line.words.map((w) => w.bbox));
        lines.set(id, line);
      }
      regions.push(...lines.values());
    }
  }
  for (const p of pages)
    regions.push(
      ...(await detectLabelledDiagrams(
        p,
        regions.filter((r) => r.page === p.page),
      )),
    );
  await writeJsonAtomic(cacheFile, { version: 5, hashes, regions });
  return regions;
}

/** Detect dark diagram strokes below a recognized diagram heading. Bounding
 * boxes are trimmed to actual pixels, not estimated by the language model.
 * Unlabelled/low-contrast figures remain unlocated for review. */
async function detectLabelledDiagrams(
  page: PageMeta,
  text: TextRegion[],
): Promise<TextRegion[]> {
  const found: TextRegion[] = [];
  for (const label of text.filter((r) => /\bdiagram\b/i.test(r.text))) {
    const top = label.bbox.y + label.bbox.height + 0.009;
    const next = Math.min(
      ...text.filter((r) => r.bbox.y > top + 0.045).map((r) => r.bbox.y),
      top + 0.22,
    );
    if (next - top < 0.05) continue;
    const left = Math.max(0, label.bbox.x - 0.035),
      right = Math.min(1, label.bbox.x + label.bbox.width + 0.12);
    const crop = {
      left: Math.floor(left * page.width),
      top: Math.floor(top * page.height),
      width: Math.floor((right - left) * page.width),
      height: Math.floor((next - top - 0.01) * page.height),
    };
    if (crop.width < 1 || crop.height < 1) continue;
    const { data, info } = await sharp(page.imagePath)
      .extract(crop)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const mask = new Uint8Array(info.width * info.height);
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++) {
        const i = (y * info.width + x) * info.channels,
          r = data[i],
          g = data[i + 1],
          b = data[i + 2];
        const greenRule = g > r + 8 && g > b + 3;
        const darkPencil =
          !greenRule &&
          Math.max(r, g, b) < 125 &&
          Math.max(r, g, b) - Math.min(r, g, b) < 30;
        const blueInk = b > r * 1.18 && b > g * 1.05 && r < 130;
        if (darkPencil || blueInk) mask[y * info.width + x] = 1;
      }
    const figure = largestInkComponent(mask, info.width, info.height);
    if (
      !figure ||
      figure.height < page.height * 0.035 ||
      figure.width < page.width * 0.04
    )
      continue;
    found.push({
      id: `p${page.page}-diagram${found.length}`,
      page: page.page,
      kind: "diagram",
      text: `Diagram below: ${label.text}`,
      words: [],
      bbox: {
        x: (crop.left + figure.x) / page.width,
        y: (crop.top + figure.y) / page.height,
        width: figure.width / page.width,
        height: figure.height / page.height,
      },
    });
  }
  return found;
}

/** Bridge small pencil gaps, then discard disconnected bleed-through specks.
 * Returning one connected figure avoids stretching its box to distant noise. */
export function largestInkComponent(
  mask: Uint8Array,
  width: number,
  height: number,
): BBox | undefined {
  const joined = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++)
    if (mask[i]) {
      const x = i % width,
        y = Math.floor(i / width);
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx,
            yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < width && yy < height)
            joined[yy * width + xx] = 1;
        }
    }
  let best: BBox | undefined;
  let bestArea = 0;
  const components: BBox[] = [];
  const queue = new Int32Array(mask.length);
  for (let start = 0; start < joined.length; start++) {
    if (!joined[start]) continue;
    let head = 0,
      tail = 1,
      count = 0,
      minX = width,
      minY = height,
      maxX = 0,
      maxY = 0;
    queue[0] = start;
    joined[start] = 0;
    while (head < tail) {
      const i = queue[head++],
        x = i % width,
        y = Math.floor(i / width);
      if (mask[i]) {
        count++;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      for (const next of [
        x ? i - 1 : -1,
        x + 1 < width ? i + 1 : -1,
        y ? i - width : -1,
        y + 1 < height ? i + width : -1,
      ]) {
        if (next >= 0 && joined[next]) {
          joined[next] = 0;
          queue[tail++] = next;
        }
      }
    }
    const w = maxX - minX + 1,
      h = maxY - minY + 1,
      area = w * h;
    if (count >= 80 && w > 15 && h > 15) {
      const box = { x: minX, y: minY, width: w, height: h };
      components.push(box);
      if (area > bestArea) {
        best = box;
        bestArea = area;
      }
    }
  }
  if (!best) return undefined;
  // A pencil figure can have disconnected arcs. Include substantial nearby
  // components, while ignoring distant text/bleed-through and tiny specks.
  const anchor = best;
  const neighbours = components.filter((b) => {
    const dx = Math.max(
      0,
      anchor.x - (b.x + b.width),
      b.x - (anchor.x + anchor.width),
    );
    const dy = Math.max(
      0,
      anchor.y - (b.y + b.height),
      b.y - (anchor.y + anchor.height),
    );
    return dx <= width * 0.18 && dy <= height * 0.12;
  });
  return unionBoxes(neighbours);
}
