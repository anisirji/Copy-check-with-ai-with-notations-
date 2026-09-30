import fs from "node:fs/promises";
import type { Block, PageMeta } from "../types.js";
import { ProviderRegistry } from "../providers/index.js";
import { extractJson } from "./util-json.js";

const VISION_PROMPT = `You are a page-understanding module for a handwritten answer-sheet grading system.

Look at the attached page image. Identify every distinct region of student writing.
For each region, return a block with:
  - "type": one of "question_number" | "text" | "equation" | "diagram" | "table" | "crossed_out" | "other"
  - "text": faithful transcription of what is written (LaTeX-style for math, describe diagrams briefly)
  - "bbox": bounding box normalized to 0..1 relative to the page — { x, y, width, height }
     where (x, y) is the top-left corner. Full precision (e.g. 0.152).

Rules:
- Question numbers (e.g. "1.", "Q3", "(a)", "(i)") are their own blocks of type "question_number".
- Group each paragraph / line-cluster of an answer into ONE text block; don't split every line.
- Include crossed-out content as its own block with type "crossed_out".
- Skip decorative borders, page numbers, printed exam letterhead.
- Return ONLY a JSON array. No prose. No fences.

Format:
[
  { "type": "...", "text": "...", "bbox": { "x": ..., "y": ..., "width": ..., "height": ... } },
  ...
]`;

interface RawBlock {
  type: Block["type"];
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
}

/**
 * Stage 3 — Vision extraction.
 *
 * Uses the provider cascade. When `consensus=true` (default for handwritten
 * pages) it also runs a second-opinion VLM from a different family and merges
 * the two. A block's text and geometry stay paired; alternate readings are
 * retained as uncertainty instead of replacing one line with another.
 */
export async function extractBlocks(
  pages: PageMeta[],
  registry: ProviderRegistry,
  opts: { consensus?: boolean } = {},
): Promise<Block[]> {
  const useConsensus = opts.consensus ?? false;
  const all: Block[] = [];

  for (const page of pages) {
    const imageBytes = await fs.readFile(page.imagePath);
    const base64 = imageBytes.toString("base64");

    const primary = await callVision(registry, "vision-primary", base64);
    let blocks = parseBlocks(primary.rawBlocks, page.page, "p");

    if (useConsensus) {
      try {
        const secondary = await callVision(
          registry,
          "vision-second-opinion",
          base64,
        );
        const secondBlocks = parseBlocks(secondary.rawBlocks, page.page, "s");
        blocks = mergeBlocks(blocks, secondBlocks);
      } catch (err) {
        console.warn(
          `[vision] second-opinion failed on page ${page.page}: ${(err as Error).message}`,
        );
      }
    }

    all.push(...blocks);
  }

  return all;
}

async function callVision(
  registry: ProviderRegistry,
  role: "vision-primary" | "vision-second-opinion",
  base64: string,
) {
  const resp = await registry.call(role, {
    prompt: VISION_PROMPT,
    images: [{ mimeType: "image/png", base64 }],
    temperature: 0.1,
  });
  const parsed = extractJson<RawBlock[]>(resp.text);
  return {
    rawBlocks: Array.isArray(parsed) ? parsed : [],
    provider: resp.provider,
  };
}

function parseBlocks(raw: RawBlock[], page: number, idPrefix: string): Block[] {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return raw.map((b, i) => ({
    id: `${idPrefix}${page}_b${i + 1}`,
    page,
    type: b.type,
    text: b.text ?? "",
    bbox: {
      x: clamp(b.bbox?.x ?? 0),
      y: clamp(b.bbox?.y ?? 0),
      width: clamp(b.bbox?.width ?? 0),
      height: clamp(b.bbox?.height ?? 0),
    },
  }));
}

/**
 * Merge primary + secondary blocks.
 * - Blocks that overlap ≥ 60% IoU are considered the same region; keep the
 *   primary's paired text/bbox and retain different secondary text as uncertainty.
 * - Secondary content already read elsewhere is not duplicated at another box.
 */
export function mergeBlocks(primary: Block[], secondary: Block[]): Block[] {
  const out: Block[] = [];
  const usedSecondary = new Set<number>();
  for (const p of primary) {
    let bestJ = -1;
    let bestIoU = 0;
    for (let j = 0; j < secondary.length; j++) {
      if (usedSecondary.has(j)) continue;
      if (secondary[j].page !== p.page) continue;
      const iou = bboxIoU(p.bbox, secondary[j].bbox);
      if (iou > bestIoU) {
        bestIoU = iou;
        bestJ = j;
      }
    }
    if (bestJ !== -1 && bestIoU >= 0.6) {
      usedSecondary.add(bestJ);
      const s = secondary[bestJ];
      out.push({
        ...p,
        // Never replace text independently of its geometry. A longer reading
        // can be a completely different line at an inaccurate VLM coordinate.
        ...(normalizeReading(s.text) !== normalizeReading(p.text)
          ? { ocrAlternatives: [...(p.ocrAlternatives ?? []), s.text] }
          : {}),
      });
    } else {
      out.push(p);
    }
  }
  for (let j = 0; j < secondary.length; j++) {
    if (!usedSecondary.has(j)) {
      const s = secondary[j];
      // A second coordinate for an already-read label/line is not new writing.
      const duplicate = primary.some(
        (p) =>
          p.page === s.page &&
          p.type === s.type &&
          normalizeReading(p.text) === normalizeReading(s.text),
      );
      if (!duplicate) out.push(s);
    }
  }
  return out;
}

function normalizeReading(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function bboxIoU(a: Block["bbox"], b: Block["bbox"]): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}
