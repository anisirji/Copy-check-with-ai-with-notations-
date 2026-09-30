/**
 * Re-run reconciliation + normalization + mapping on every existing run,
 * update each grading's answerBlockIds, and rebuild the review payload.
 *
 * Purely offline — no LLM/vision calls. Grading marks are preserved as-is;
 * only the STRUCTURE of what belongs to which question is refreshed.
 * Use this after fixing pipeline stages (reconciler, mapper, canonical) so
 * existing runs pick up the improved data model without any API cost.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { attachReviews } from "../backend/src/services/review.js";
import { reconcileAnswerBlocks } from "../backend/src/services/reconcile-answer-blocks.js";
import { normalizeAnswerMarkers } from "../backend/src/services/answer-marker-normalizer.js";
import { mapBlocksToQuestions } from "../backend/src/services/mapper.js";
import { findOwnershipConflicts } from "../backend/src/services/reconcile-answer-blocks.js";
import type {
  Block,
  ExamConfig,
  PipelineResult,
} from "../backend/src/types.js";

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
    const blocksPath = path.join(OUTPUT_DIR, dir, "blocks.json");
    let doc: PipelineResult;
    let rawBlocks: Block[];
    try {
      doc = JSON.parse(await fs.readFile(evalPath, "utf-8"));
      rawBlocks = JSON.parse(await fs.readFile(blocksPath, "utf-8"));
    } catch {
      continue;
    }
    let exam: ExamConfig | undefined = doc.exam;
    if (!exam && doc.examId) {
      try {
        exam = JSON.parse(
          await fs.readFile(path.join(EXAM_DIR, `${doc.examId}.json`), "utf-8"),
        );
      } catch {
        // continue without exam — canonical still works with rubric-only fallback
      }
    }
    if (!exam) {
      console.log(`- ${dir} (no exam, skip)`);
      continue;
    }

    const reconciled = reconcileAnswerBlocks(rawBlocks);
    const normalized = normalizeAnswerMarkers(reconciled);
    const mapping = mapBlocksToQuestions(normalized, exam);
    const conflicts = findOwnershipConflicts(mapping);
    for (const c of conflicts) {
      const [, ...drop] = c.questionIds;
      for (const qid of drop) {
        mapping[qid] = mapping[qid].filter((id) => id !== c.blockId);
      }
    }

    // Refresh each grading's answerBlockIds against the new mapping. Do NOT
    // recompute marks — those came from the graders and are preserved.
    for (const g of doc.grading) {
      g.answerBlockIds = mapping[g.questionId] ?? [];
      if (g.semantic) g.semantic.answerBlockIds = g.answerBlockIds;
    }
    // Persist the fresh mapping alongside so debug tools can see it.
    await fs.writeFile(
      path.join(OUTPUT_DIR, dir, "mapping.json"),
      JSON.stringify(mapping, null, 2),
    );
    doc.blocks = normalized;
    attachReviews(doc.grading, exam.questions, normalized);
    await fs.writeFile(evalPath, JSON.stringify(doc, null, 2));
    touched += 1;
    console.log(
      `✓ ${dir} (dropped ${rawBlocks.length - reconciled.length} dup blocks, ${conflicts.length} ownership conflicts)`,
    );
  }
  console.log(`\ntouched ${touched} evaluations`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
