/**
 * Backfill the new `grading.review` payload onto every existing
 * evaluation.json that predates the review-computation step.
 * Purely offline — no LLM calls.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { attachReviews } from "../backend/src/services/review.js";
import type { ExamConfig, PipelineResult } from "../backend/src/types.js";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const OUTPUT_DIR = path.join(ROOT, "output");
const EXAM_DIR = path.join(ROOT, "store", "exams");

async function main(): Promise<void> {
  const dirs = (await fs.readdir(OUTPUT_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  let touched = 0;
  for (const dir of dirs) {
    const evalPath = path.join(OUTPUT_DIR, dir, "evaluation.json");
    let raw: string;
    try {
      raw = await fs.readFile(evalPath, "utf-8");
    } catch {
      continue;
    }
    const doc = JSON.parse(raw) as PipelineResult;
    let exam: ExamConfig | undefined = doc.exam;
    if (!exam && doc.examId) {
      try {
        exam = JSON.parse(
          await fs.readFile(path.join(EXAM_DIR, `${doc.examId}.json`), "utf-8"),
        );
      } catch {
        // fall through — no exam found, we still attach reviews using rubric already on grading
      }
    }
    attachReviews(doc.grading, exam?.questions ?? [], doc.blocks);
    await fs.writeFile(evalPath, JSON.stringify(doc, null, 2));
    touched += 1;
    console.log(`✓ ${dir}`);
  }
  console.log(`\ntouched ${touched} evaluations`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
