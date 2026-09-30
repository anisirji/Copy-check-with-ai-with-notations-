import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import type { Annotation, PageMeta } from "../types.js";
import { annotationLayout, buildAnnotationSvg } from "./annotation-svg.js";

export async function renderAnnotated(
  pages: PageMeta[],
  annotations: Annotation[],
  outDir: string,
): Promise<{ annotatedPagePaths: string[]; annotatedPdfPath: string }> {
  await fs.mkdir(outDir, { recursive: true });

  const annotatedPagePaths: string[] = [];
  for (const page of pages) {
    const pageAnnotations = annotations.filter((a) => a.page === page.page);
    const layout = annotationLayout(page.width, page.height, pageAnnotations);
    const svg = buildAnnotationSvg(page.width, page.height, pageAnnotations);
    const outPath = path.join(outDir, `page-${page.page}-annotated.png`);
    await sharp(page.imagePath)
      .extend({
        top: layout.top,
        left: layout.left,
        right: layout.right,
        bottom: layout.height - layout.top - page.height,
        background: "#fffefa",
      })
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .png()
      .toFile(outPath);
    annotatedPagePaths.push(outPath);
  }

  const pdf = await PDFDocument.create();
  for (const p of annotatedPagePaths) {
    const bytes = await fs.readFile(p);
    const img = await pdf.embedPng(bytes);
    const pg = pdf.addPage([img.width, img.height]);
    pg.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
  const annotatedPdfPath = path.join(outDir, "annotated.pdf");
  await fs.writeFile(annotatedPdfPath, await pdf.save());

  return { annotatedPagePaths, annotatedPdfPath };
}
