import fs from "node:fs/promises";
import path from "node:path";
import type { PipelineResult } from "../types.js";
import { renderAnnotated } from "./renderer.js";
import { buildAnnotations } from "./annotator.js";

/** Finish rendering before replacing any visible review artifacts. Original
 * scans and PDFs are never rewritten by teacher grading corrections. */
export async function saveGradingRevision(
  result: PipelineResult,
  evaluationPath: string,
): Promise<void> {
  const runDirectory = path.dirname(evaluationPath);
  const staging = await fs.mkdtemp(path.join(runDirectory, ".review-"));
  try {
    result.annotations = buildAnnotations(result.grading, result.blocks);
    if (result.annotationGrounding)
      result.annotationGrounding.updatedAt = new Date().toISOString();
    const pages = result.pages.filter(
      (page) =>
        result.quality.find((q) => q.page === page.page)?.acceptable !== false,
    );
    const rendered = await renderAnnotated(pages, result.annotations, staging);
    const targets = rendered.annotatedPagePaths.map((file) =>
      path.join(runDirectory, path.basename(file)),
    );
    result.outputs.annotatedPagePaths = targets;
    result.outputs.evaluatedPdf = path.join(runDirectory, "evaluated.pdf");
    result.outputs.evaluationJson = evaluationPath;
    await fs.copyFile(
      rendered.annotatedPdfPath,
      path.join(staging, "evaluated.pdf"),
    );
    await fs.writeFile(
      path.join(staging, "evaluation.json"),
      JSON.stringify(result, null, 2),
    );
    for (let index = 0; index < targets.length; index++) {
      await fs.rename(rendered.annotatedPagePaths[index], targets[index]);
    }
    await fs.rename(
      rendered.annotatedPdfPath,
      path.join(runDirectory, "annotated.pdf"),
    );
    await fs.rename(
      path.join(staging, "evaluated.pdf"),
      result.outputs.evaluatedPdf,
    );
    await fs.rename(path.join(staging, "evaluation.json"), evaluationPath);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
