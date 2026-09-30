import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { PageMeta } from "../types.js";

/**
 * Stage 2 — PDF → per-page PNGs at 200 DPI via `pdftoppm` (poppler).
 * We shell out instead of using node-canvas/pdfjs to avoid a native build step.
 * Returns per-page metadata with pixel dimensions so annotation bboxes
 * (normalized 0..1) can be denormalized later.
 */
export async function pdfToPages(
  pdfPath: string,
  outDir: string,
): Promise<PageMeta[]> {
  await fs.mkdir(outDir, { recursive: true });
  const prefix = path.join(outDir, "page");
  await runPdftoppm(pdfPath, prefix);

  const entries = (await fs.readdir(outDir))
    .filter((f) => /^page-\d+\.png$/.test(f))
    .sort((a, b) => extractPageNum(a) - extractPageNum(b));

  const pages: PageMeta[] = [];
  for (const file of entries) {
    const p = extractPageNum(file);
    const imagePath = path.join(outDir, file);
    const meta = await sharp(imagePath).metadata();
    pages.push({
      page: p,
      imagePath,
      width: meta.width ?? 0,
      height: meta.height ?? 0,
    });
  }
  return pages;
}

/** Reuse original PNG scans byte-for-byte during cached verification. */
export async function copySourcePages(
  sourcePages: PageMeta[],
  outDir: string,
): Promise<PageMeta[]> {
  if (!sourcePages.length)
    throw new Error("At least one source page is required");
  const seen = new Set<number>();
  const verified: PageMeta[] = [];
  for (const source of [...sourcePages].sort((a, b) => a.page - b.page)) {
    if (
      !Number.isInteger(source.page) ||
      source.page < 1 ||
      seen.has(source.page)
    )
      throw new Error("Source page numbers must be unique positive integers");
    seen.add(source.page);
    const metadata = await sharp(source.imagePath).metadata();
    if (metadata.format !== "png" || !metadata.width || !metadata.height)
      throw new Error("Source pages must be valid PNG images");
    if (source.width !== metadata.width || source.height !== metadata.height)
      throw new Error(
        `Source page ${source.page} dimensions do not match the image`,
      );
    const imagePath = path.join(outDir, `page-${source.page}.png`);
    if (path.resolve(source.imagePath) === path.resolve(imagePath))
      throw new Error("Reuse source pages in a new output directory");
    verified.push({
      page: source.page,
      imagePath,
      width: metadata.width,
      height: metadata.height,
    });
  }
  await fs.mkdir(outDir, { recursive: true });
  for (const page of verified) {
    const source = sourcePages.find((p) => p.page === page.page)!;
    await fs.copyFile(source.imagePath, page.imagePath);
  }
  return verified;
}

function runPdftoppm(pdfPath: string, prefix: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("pdftoppm", ["-png", "-r", "200", pdfPath, prefix]);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`pdftoppm exited ${code}: ${stderr}`)),
    );
  });
}

function extractPageNum(name: string): number {
  const m = name.match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}
