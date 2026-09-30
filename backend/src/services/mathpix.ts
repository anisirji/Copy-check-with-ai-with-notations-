import fs from "node:fs/promises";
import sharp from "sharp";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Block, PageMeta } from "../types.js";

const APP_ID = process.env.MATHPIX_APP_ID;
const APP_KEY = process.env.MATHPIX_APP_KEY;
const ENDPOINT = "https://api.mathpix.com/v3/text";

/**
 * Stage 3b — Mathpix enrichment for STEM equations.
 *
 * Only fires when MATHPIX_APP_ID + MATHPIX_APP_KEY are set. For each block
 * classified as `equation` by the vision cascade, we crop the page image to
 * the block bbox, send it to Mathpix, and replace the block's `text` with
 * the LaTeX Mathpix returns.
 *
 * This is the "specialised OCR" step in the arch doc's escalation ladder —
 * VLMs are wrong about equations often enough that a dedicated model here
 * meaningfully improves grading accuracy for math/physics/chemistry.
 */
export async function enrichWithMathpix(
  blocks: Block[],
  pages: PageMeta[],
): Promise<Block[]> {
  if (!APP_ID || !APP_KEY) return blocks;

  const equationBlocks = blocks.filter((b) => b.type === "equation");
  if (equationBlocks.length === 0) return blocks;

  const pageByNum = new Map(pages.map((p) => [p.page, p]));
  const tmpDir = path.join(process.cwd(), ".mathpix-crops");
  await fs.mkdir(tmpDir, { recursive: true });

  const enriched = new Map<string, string>();
  for (const b of equationBlocks) {
    const page = pageByNum.get(b.page);
    if (!page) continue;
    try {
      const cropPath = path.join(tmpDir, `${randomUUID()}.png`);
      const left = Math.floor(b.bbox.x * page.width);
      const top = Math.floor(b.bbox.y * page.height);
      const w = Math.max(20, Math.floor(b.bbox.width * page.width));
      const h = Math.max(20, Math.floor(b.bbox.height * page.height));
      await sharp(page.imagePath)
        .extract({ left, top, width: w, height: h })
        .toFile(cropPath);
      const latex = await callMathpix(cropPath);
      await fs.unlink(cropPath).catch(() => {});
      if (latex) enriched.set(b.id, latex);
    } catch (err) {
      console.warn(`[mathpix] ${b.id} failed: ${(err as Error).message}`);
    }
  }

  return blocks.map((b) =>
    enriched.has(b.id) ? { ...b, text: enriched.get(b.id)! } : b,
  );
}

async function callMathpix(imagePath: string): Promise<string | null> {
  const bytes = await fs.readFile(imagePath);
  const body = {
    src: `data:image/png;base64,${bytes.toString("base64")}`,
    formats: ["latex_normal"],
    ocr: ["math", "text"],
  };
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      app_id: APP_ID!,
      app_key: APP_KEY!,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Mathpix ${res.status}`), {
      status: res.status,
    });
  }
  const data = (await res.json()) as { latex_normal?: string; text?: string };
  return data.latex_normal ?? data.text ?? null;
}
