/**
 * Strip red teacher-pen marks (ticks, crosses, underlines, numbers) from a
 * scanned answer sheet and rebuild a clean PDF.
 *
 * Usage:
 *   pnpm tsx scripts/clean-teacher-marks.ts <input.pdf> <out-dir> [--label=<name>]
 *
 * Pipeline per page:
 *   1) pdftoppm  → PNG at 200dpi
 *   2) sharp raw → whiten red-dominant pixels
 *   3) pdf-lib   → reassemble annotated-clean pages into a single PDF
 *
 * "Red dominant" = R clearly above G/B AND enough absolute red. We keep pencil
 * strokes and dark blue ink untouched. Threshold is tuned to leave student
 * writing intact while removing typical red-pen marks.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";

interface CleanOptions {
  redAbsMin: number; // absolute R threshold
  rMinusG: number; // R - G difference
  rMinusB: number; // R - B difference
  softenLightRed: boolean; // also drop pinkish highlights
}

const DEFAULT_OPTIONS: CleanOptions = {
  redAbsMin: 110,
  rMinusG: 35,
  rMinusB: 35,
  softenLightRed: true,
};

async function runPdftoppm(pdf: string, outPrefix: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pdftoppm", ["-png", "-r", "200", pdf, outPrefix]);
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`pdftoppm exited ${code}`)),
    );
  });
}

async function whitenRedPixels(
  input: string,
  output: string,
  opts: CleanOptions,
): Promise<void> {
  const image = sharp(input).removeAlpha();
  const meta = await image.metadata();
  if (!meta.width || !meta.height) throw new Error(`bad image: ${input}`);
  const { data, info } = await image
    .raw()
    .toBuffer({ resolveWithObject: true });

  const px = new Uint8ClampedArray(
    data.buffer,
    data.byteOffset,
    data.byteLength,
  );
  for (let i = 0; i < px.length; i += info.channels) {
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    const isRed =
      r >= opts.redAbsMin && r - g >= opts.rMinusG && r - b >= opts.rMinusB;
    const isLightRed =
      opts.softenLightRed &&
      r >= 180 &&
      r - g >= 15 &&
      r - b >= 15 &&
      g > 120 &&
      b > 120;
    if (isRed || isLightRed) {
      px[i] = 255;
      px[i + 1] = 255;
      px[i + 2] = 255;
    }
  }

  await sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  })
    .png()
    .toFile(output);
}

async function pngsToPdf(pngs: string[], outPdf: string): Promise<void> {
  const pdf = await PDFDocument.create();
  for (const png of pngs) {
    const bytes = await fs.readFile(png);
    const img = await pdf.embedPng(bytes);
    const page = pdf.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
  await fs.writeFile(outPdf, await pdf.save());
}

async function cleanPaper(
  inputPdf: string,
  outDir: string,
  label: string,
): Promise<{ cleanedPdf: string; pages: string[] }> {
  await fs.mkdir(outDir, { recursive: true });
  const tmpDir = path.join(outDir, `.raw-${label}`);
  const cleanedDir = path.join(outDir, "pages");
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.mkdir(cleanedDir, { recursive: true });

  await runPdftoppm(inputPdf, path.join(tmpDir, "page"));
  const files = (await fs.readdir(tmpDir))
    .filter((f) => f.endsWith(".png"))
    .sort();
  if (files.length === 0) throw new Error("pdftoppm produced no pages");

  const cleanedPages: string[] = [];
  for (const f of files) {
    const inPng = path.join(tmpDir, f);
    const outPng = path.join(cleanedDir, f);
    await whitenRedPixels(inPng, outPng, DEFAULT_OPTIONS);
    cleanedPages.push(outPng);
  }

  const cleanedPdf = path.join(outDir, `${label}-clean.pdf`);
  await pngsToPdf(cleanedPages, cleanedPdf);
  await fs.rm(tmpDir, { recursive: true, force: true });

  return { cleanedPdf, pages: cleanedPages };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const label = (
    args.find((a) => a.startsWith("--label="))?.split("=")[1] ??
    path.basename(positional[0] ?? "paper", path.extname(positional[0] ?? ""))
  )
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (positional.length < 2) {
    console.error(
      "usage: clean-teacher-marks <input.pdf> <out-dir> [--label=x]",
    );
    process.exit(1);
  }
  const [pdf, outDir] = positional;
  const { cleanedPdf, pages } = await cleanPaper(
    path.resolve(pdf),
    path.resolve(outDir),
    label,
  );
  console.log(`[${label}] cleaned ${pages.length} pages → ${cleanedPdf}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
