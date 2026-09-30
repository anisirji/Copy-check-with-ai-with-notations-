import { runDirectory } from "./file-store.js";
import fs from "node:fs/promises";
import path from "node:path";
import { copySourcePages, pdfToPages } from "./preprocess.js";
import { gatePages } from "./quality.js";
import { extractBlocks } from "./vision.js";
import { mapBlocksToQuestions } from "./mapper.js";
import { normalizeAnswerMarkers } from "./answer-marker-normalizer.js";
import {
  findOwnershipConflicts,
  reconcileAnswerBlocks,
} from "./reconcile-answer-blocks.js";
import { toSemanticAnswers } from "./semantic.js";
import { runGrader, runValidator } from "./grader.js";
import { needsSecondGrader, needsValidator, reconcile } from "./consensus.js";
import { buildAnnotations } from "./annotator.js";
import { inferAll } from "./mistake-tag.js";
import { renderAnnotated } from "./renderer.js";
import { buildAnalytics } from "./analytics.js";
import { attachReviews } from "./review.js";
import { enrichWithMathpix } from "./mathpix.js";
import { ProviderRegistry } from "../providers/index.js";
import {
  blockSchema,
  type EvaluationRules,
  type ExamConfig,
  type PageMeta,
  type PipelineResult,
  type QuestionGrading,
} from "../types.js";
import { assertExamMarks } from "./exam-marks.js";
import { groundAnnotationEvidence } from "./annotation-grounding.js";

export interface RunOptions {
  runId: string;
  pdfPath: string;
  exam: ExamConfig;
  outputRoot: string;
  registry?: ProviderRegistry;
  onProgress?: (stage: string, detail?: unknown) => void;
  /** Fail instead of invoking OCR when regrading a cached run. */
  requireCachedBlocks?: boolean;
  /** Copy these exact scans instead of rasterizing the supplied PDF again. */
  sourcePages?: PageMeta[];
  /** Injectable for offline tests; production uses pixel-derived evidence geometry. */
  annotationGrounder?: typeof groundAnnotationEvidence;
}

/**
 * Full copy-checking pipeline (per COPY_CHECKING_ARCHITECTURE.md):
 *
 *  1. quality gate        → PASS / REJECT
 *  2. preprocess          → page PNGs with dimensions
 *  3. vision extraction   → cascade + dual-VLM consensus
 *  3b. Mathpix enrichment → per-equation crops for STEM questions
 *  4. question mapping    → question ↔ blocks
 *  5. semantic answer     → concepts / equations / steps / diagrams
 *  6. grader A            → best rubric reasoner (Claude by default)
 *  7. confidence gate     → skip grader B if grader A is very confident + clean
 *  8. grader B + validator → family-diverse (arch doc: no anchoring)
 *  9. annotator           → deterministic drawing instructions
 * 10. renderer            → SVG overlay + annotated PDF
 * 11. analytics           → weakest concepts + automation rate
 * 12. finalize            → original.pdf + evaluation.json + evaluated.pdf
 */
export async function runPipeline(opts: RunOptions): Promise<PipelineResult> {
  const { runId, pdfPath, exam, outputRoot, onProgress } = opts;
  assertExamMarks(exam);
  const registry = opts.registry ?? ProviderRegistry.default();
  const configured = registry.configured();
  if (configured.length === 0) {
    throw new Error(
      "No LLM providers configured — set at least GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or GROQ_API_KEY.",
    );
  }
  onProgress?.("providers:configured", configured);

  const runDir = runDirectory(outputRoot, runId);
  const pagesDir = path.join(runDir, "pages");
  const blocksPath = path.join(runDir, "blocks.json");
  // Validate required cache before preprocessing or any provider work. A dev
  // regrade must not silently turn into another paid extraction run.
  let requiredBlocks;
  if (opts.requireCachedBlocks) {
    try {
      requiredBlocks = blockSchema
        .array()
        .min(1)
        .parse(JSON.parse(await fs.readFile(blocksPath, "utf-8")));
    } catch (err) {
      throw new Error(
        `Cached blocks are missing or invalid; regrade stopped before OCR: ${(err as Error).message}`,
      );
    }
  }
  await fs.mkdir(pagesDir, { recursive: true });

  onProgress?.("preprocess:start");
  const pages = opts.sourcePages
    ? await copySourcePages(opts.sourcePages, pagesDir)
    : await pdfToPages(pdfPath, pagesDir);
  onProgress?.("preprocess:done", {
    pages: pages.length,
    reusedSourcePages: !!opts.sourcePages,
  });

  onProgress?.("quality:start");
  const quality = await gatePages(pages);
  onProgress?.("quality:done", { quality });
  const rejected = quality.filter((q) => !q.acceptable);
  if (rejected.length === quality.length) {
    throw new Error(
      `Quality gate rejected all ${quality.length} pages. Rescan the sheet.`,
    );
  }
  const okPages = pages.filter(
    (p) => quality.find((q) => q.page === p.page)?.acceptable,
  );

  onProgress?.("vision:start");
  let blocks;
  try {
    blocks =
      requiredBlocks ??
      blockSchema
        .array()
        .min(1)
        .parse(JSON.parse(await fs.readFile(blocksPath, "utf-8")));
    onProgress?.("vision:cached", { blocks: blocks.length });
  } catch (err) {
    if (opts.requireCachedBlocks) {
      throw new Error(
        `Cached blocks are missing or invalid; regrade stopped before OCR: ${(err as Error).message}`,
      );
    }
    blocks = await extractBlocks(okPages, registry, { consensus: true });
    await fs.writeFile(blocksPath, JSON.stringify(blocks, null, 2));
  }
  onProgress?.("vision:done", { blocks: blocks.length });

  // 3b — Mathpix enrichment for STEM questions (no-op if key not set)
  onProgress?.("mathpix:start");
  const stemSubjects = new Set(
    exam.questions
      .filter((q) => ["math", "physics", "chemistry"].includes(q.subject ?? ""))
      .map((q) => q.id),
  );
  if (stemSubjects.size > 0 && !opts.requireCachedBlocks) {
    blocks = await enrichWithMathpix(blocks, okPages);
    await fs.writeFile(blocksPath, JSON.stringify(blocks, null, 2));
  }
  onProgress?.("mathpix:done");

  // Reconcile primary + secondary vision streams — merge near-duplicate blocks
  // BEFORE mapping so drifted secondary copies can't cross question boundaries.
  const reconcileAudit: import("./reconcile-answer-blocks.js").ReconcileAudit[] =
    [];
  const reconciledBlocks = reconcileAnswerBlocks(blocks, (event) => {
    reconcileAudit.push(event);
    onProgress?.("reconcile:pair", event);
  });
  await fs.writeFile(
    path.join(runDir, "reconcile-audit.json"),
    JSON.stringify(reconcileAudit, null, 2),
  );
  onProgress?.("reconcile:done", {
    dropped: blocks.length - reconciledBlocks.length,
  });

  // Defensive normalization: split leading "Ans a>"-style markers inside
  // text blocks into synthetic canonical question_number blocks so the
  // mapper can resolve unambiguously. See answer-marker-normalizer.ts.
  const normalizerAudit: import("./answer-marker-normalizer.js").NormalizerAudit[] =
    [];
  const normalizedBlocks = normalizeAnswerMarkers(reconciledBlocks, (event) => {
    normalizerAudit.push(event);
    onProgress?.("normalize:marker", event);
  });
  await fs.writeFile(
    path.join(runDir, "normalizer-audit.json"),
    JSON.stringify(normalizerAudit, null, 2),
  );
  onProgress?.("normalize:done", {
    added: normalizedBlocks.length - reconciledBlocks.length,
    synthetic: normalizerAudit.length,
  });

  onProgress?.("mapping:start");
  const mapping = mapBlocksToQuestions(normalizedBlocks, exam);
  const ownershipConflicts = findOwnershipConflicts(mapping);
  if (ownershipConflicts.length > 0) {
    // Invariant: one block belongs to at most one canonical question. If we
    // see a conflict, keep the FIRST assignment (the one the mapper made in
    // reading order) and drop the block from every subsequent bucket so a
    // teacher never sees leaked evidence in an unrelated review card.
    for (const conflict of ownershipConflicts) {
      const [keep, ...drop] = conflict.questionIds;
      for (const qid of drop) {
        mapping[qid] = mapping[qid].filter((id) => id !== conflict.blockId);
      }
      onProgress?.("mapping:conflict", { ...conflict, keptOwner: keep });
    }
  }
  await fs.writeFile(
    path.join(runDir, "mapping.json"),
    JSON.stringify(mapping, null, 2),
  );
  onProgress?.("mapping:done", {
    mapping,
    ownershipConflicts: ownershipConflicts.length,
  });

  onProgress?.("semantic:start");
  const semantics = toSemanticAnswers(exam, normalizedBlocks, mapping);
  onProgress?.("semantic:done");

  // ── Stages 6-8: grader A → maybe B (family-diverse) → maybe validator ────
  const grading: QuestionGrading[] = [];
  for (const question of exam.questions) {
    const semantic = semantics.find((s) => s.questionId === question.id)!;
    onProgress?.("grade:start", { questionId: question.id });
    let graderA: Awaited<ReturnType<typeof runGrader>> | undefined;
    let graderB: Awaited<ReturnType<typeof runGrader>> | undefined;
    try {
      graderA = await runGrader(
        "A",
        question,
        semantic,
        blocks,
        okPages,
        registry,
        {
          rules: exam.evaluationRules,
          context: { subject: exam.subject, class: exam.class },
        },
      );

      let validator: Awaited<ReturnType<typeof runValidator>> | undefined;

      if (needsSecondGrader(question, graderA)) {
        const familyOfA = graderA.provider
          ? registry.familyOf(graderA.provider as never)
          : undefined;
        graderB = await runGrader(
          "B",
          question,
          semantic,
          blocks,
          okPages,
          registry,
          {
            avoidFamily: familyOfA,
            rules: exam.evaluationRules,
            context: { subject: exam.subject, class: exam.class },
          },
        );
        if (needsValidator(graderA, graderB)) {
          validator = await runValidator(
            question,
            semantic,
            graderA,
            graderB,
            registry,
          );
        }
      }

      const reconciled = reconcile(
        question,
        semantic,
        graderA,
        graderB,
        validator,
      );
      grading.push(reconciled);
      onProgress?.("grade:done", {
        questionId: question.id,
        providerA: graderA.provider,
        providerB: graderB?.provider,
        route: reconciled.route,
        confidence: reconciled.systemConfidence,
      });
    } catch (err) {
      console.warn(
        `[grade] ${question.id} failed (${(err as Error).message}) — flagging for teacher review`,
      );
      if (graderA) {
        const preserved = reconcile(question, semantic, graderA, graderB);
        preserved.route = "teacher_review";
        preserved.needsTeacherReview = true;
        preserved.reviewReason =
          "The independent check could not finish. The available marking is preserved as a draft; check every step before approving.";
        grading.push(preserved);
      } else
        grading.push({
          questionId: question.id,
          answerBlockIds: semantic.answerBlockIds,
          maxMarks: question.maxMarks,
          awardedMarks: 0,
          rubricEvaluation: question.rubric.map((c) => ({
            criterionId: c.id,
            concept: c.concept,
            marksAvailable: c.marks,
            marksAwarded: 0,
            status: "missing" as const,
            confidence: 0,
          })),
          graderA: {
            grader: "A",
            rubricEvaluation: [],
            awardedMarks: 0,
            gradingConfidence: 0,
          },
          systemConfidence: 0,
          route: "teacher_review",
          needsTeacherReview: true,
          reviewReason:
            "Automatic marking could not finish. These marks are placeholders; review the answer and enter marks before approving.",
          semantic,
        });
      onProgress?.("grade:failed", { questionId: question.id });
    }
  }

  applyEvaluationRouting(grading, exam.evaluationRules);

  onProgress?.("mistake-tag:start");
  inferAll(grading);
  onProgress?.("mistake-tag:done");

  onProgress?.("annotate:start");
  let annotationGrounding;
  try {
    annotationGrounding = await (
      opts.annotationGrounder ?? groundAnnotationEvidence
    )(
      grading,
      blocks,
      okPages,
      registry,
      path.join(runDir, "text-regions.json"),
    );
  } catch (error) {
    console.warn(
      `[annotations] Local positioning unavailable: ${(error as Error).message}`,
    );
    annotationGrounding = {
      version: 1 as const,
      updatedAt: new Date().toISOString(),
      placed: 0,
      unlocated: grading.flatMap((g) =>
        g.rubricEvaluation.map((e) => ({
          questionId: g.questionId,
          criterionId: e.criterionId,
        })),
      ),
    };
  }
  const unlocatedQuestions = new Set(
    annotationGrounding.unlocated.map((item) => item.questionId),
  );
  for (const question of grading)
    if (unlocatedQuestions.has(question.questionId)) {
      question.needsTeacherReview = true;
      question.route = "teacher_review";
      question.reviewReason ??=
        "Some marking evidence could not be located reliably on the scan. Check the answer before approving.";
    }
  const annotations = buildAnnotations(grading, blocks);
  onProgress?.("annotate:done", { count: annotations.length });

  onProgress?.("render:start");
  const { annotatedPagePaths, annotatedPdfPath } = await renderAnnotated(
    okPages,
    annotations,
    runDir,
  );
  onProgress?.("render:done");

  onProgress?.("analytics:start");
  const analytics = buildAnalytics(grading);
  onProgress?.("analytics:done");

  // Attach human-friendly review payload used by AnswerReview UI. Passes the
  // reconciled+normalized blocks so canonical answers get built from source.
  attachReviews(grading, exam.questions, normalizedBlocks);

  const originalPdf = path.join(runDir, "original.pdf");
  await fs.copyFile(pdfPath, originalPdf);
  const evaluationJson = path.join(runDir, "evaluation.json");
  const evaluatedPdf = path.join(runDir, "evaluated.pdf");
  await fs.copyFile(annotatedPdfPath, evaluatedPdf);

  const result: PipelineResult = {
    runId,
    createdAt: new Date().toISOString(),
    exam,
    quality,
    pages,
    blocks,
    mapping,
    grading,
    annotations,
    annotationGrounding,
    analytics,
    outputs: {
      originalPdf,
      evaluationJson,
      evaluatedPdf,
      annotatedPagePaths,
    },
  };

  await fs.writeFile(evaluationJson, JSON.stringify(result, null, 2));
  onProgress?.("finalize:done", {
    totals: `${analytics.totalAwarded}/${analytics.totalMax}`,
    automation: `${Math.round(analytics.automationRate * 100)}%`,
  });
  return result;
}

/** Teacher assistance always reviews every answer; sampling adds one in ten
 * in stable paper order while preserving every existing confidence flag. */
export function applyEvaluationRouting(
  grading: QuestionGrading[],
  rules?: EvaluationRules,
): void {
  grading.forEach((question, index) => {
    if (question.answerBlockIds.length === 0) {
      question.route = "teacher_review";
      question.needsTeacherReview = true;
      question.reviewReason =
        "No answer was matched to this question. Check the scanned paper before treating it as blank or confirming zero marks.";
    }
    if (!rules) return;
    // Independent graders can disagree 0/full; consensus must not introduce
    // forbidden partial marks by averaging their decisions.
    if (!rules.partialCredit) {
      let disagreement = false;
      for (const criterion of question.rubricEvaluation) {
        if (
          criterion.marksAwarded > 0 &&
          criterion.marksAwarded < criterion.marksAvailable
        ) {
          criterion.marksAwarded = 0;
          criterion.status = question.semantic.rawTranscript.trim()
            ? "incorrect"
            : "missing";
          disagreement = true;
        }
      }
      question.awardedMarks =
        Math.round(
          question.rubricEvaluation.reduce(
            (sum, c) => sum + c.marksAwarded,
            0,
          ) * 100,
        ) / 100;
      if (disagreement) {
        question.route = "teacher_review";
        question.needsTeacherReview = true;
      }
    }
    if (
      rules.mode === "assist" ||
      (rules.mode === "sample" && index % 10 === 0) ||
      (rules.flagUncertain && question.semantic.uncertainText.length > 0)
    ) {
      question.route = "teacher_review";
      question.needsTeacherReview = true;
    }
  });
}
