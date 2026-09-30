import { roundMarks } from "./exam-marks.js";
import type {
  ConfidenceRoute,
  GraderResult,
  Question,
  QuestionGrading,
  RubricEval,
  SemanticAnswer,
  ValidatorReport,
} from "../types.js";

/**
 * Stage 8 — Consensus + confidence routing.
 *
 * Combines two grader outputs (A and B) and, when needed, a validator report,
 * into a final QuestionGrading with a system confidence score and a route
 * label per the arch doc:
 *   HIGH   (≥ 0.96) → auto_accept
 *   MED    (0.85 – 0.96) → verify_ai   (validator was consulted)
 *   LOW    (< 0.85) → teacher_review
 *
 * When A and B agree on marks per criterion, confidence stays high.
 * Any disagreement drags system confidence down.
 */

const AUTO_THRESHOLD = 0.96;
const REVIEW_THRESHOLD = 0.85;

export function reconcile(
  question: Question,
  semantic: SemanticAnswer,
  graderA: GraderResult,
  graderB?: GraderResult,
  validator?: ValidatorReport,
): QuestionGrading {
  const finalEvals: RubricEval[] = question.rubric.map((c) => {
    const a = graderA.rubricEvaluation.find((e) => e.criterionId === c.id);
    const b = graderB?.rubricEvaluation.find((e) => e.criterionId === c.id);
    return mergeCriterion(c.id, c.concept, c.marks, a, b);
  });

  const awardedMarks = roundMarks(
    finalEvals.reduce((s, e) => s + e.marksAwarded, 0),
  );

  const agreementScore = graderB
    ? computeAgreement(graderA, graderB, question)
    : 1;
  const graderConfidence =
    (graderA.gradingConfidence +
      (graderB?.gradingConfidence ?? graderA.gradingConfidence)) /
    2;
  const validatorPenalty = validator ? validator.overallSuspicion : 0;

  const systemConfidence = clamp01(
    graderConfidence * agreementScore - 0.5 * validatorPenalty,
  );

  const route: ConfidenceRoute =
    systemConfidence >= AUTO_THRESHOLD
      ? "auto_accept"
      : systemConfidence >= REVIEW_THRESHOLD
        ? "verify_ai"
        : "teacher_review";

  return {
    questionId: question.id,
    answerBlockIds: semantic.answerBlockIds,
    maxMarks: question.maxMarks,
    awardedMarks,
    rubricEvaluation: finalEvals,
    graderA,
    graderB,
    validator,
    systemConfidence: round2(systemConfidence),
    route,
    needsTeacherReview: route !== "auto_accept",
    semantic,
  };
}

/**
 * Decides whether grader B is worth spending money on.
 * Rules:
 *  - If grader A confidence is already very high AND every criterion clearly
 *    correct or clearly missing, skip B.
 *  - Otherwise call B (to catch anchoring or overreach).
 */
export function needsSecondGrader(
  question: Question,
  graderA: GraderResult,
): boolean {
  if (graderA.gradingConfidence < 0.9) return true;
  const anyMiddle = graderA.rubricEvaluation.some(
    (e) =>
      e.status === "partial" ||
      (e.marksAwarded > 0 && e.marksAwarded < e.marksAvailable),
  );
  return anyMiddle;
}

/**
 * Runs validator whenever A and B disagree on total marks by more than 0.5,
 * or on any single criterion status.
 */
export function needsValidator(
  graderA: GraderResult,
  graderB: GraderResult,
): boolean {
  if (Math.abs(graderA.awardedMarks - graderB.awardedMarks) > 0.5) return true;
  for (const a of graderA.rubricEvaluation) {
    const b = graderB.rubricEvaluation.find(
      (e) => e.criterionId === a.criterionId,
    );
    if (!b) return true;
    if (a.status !== b.status) return true;
  }
  return false;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function mergeCriterion(
  id: string,
  concept: string,
  max: number,
  a?: RubricEval,
  b?: RubricEval,
): RubricEval {
  if (!a && !b) {
    return {
      criterionId: id,
      concept,
      marksAvailable: max,
      marksAwarded: 0,
      status: "missing",
      confidence: 0.3,
    };
  }
  if (!b) return a!;
  if (!a) return b;

  // Average marks; keep the stricter status (missing/incorrect > partial > correct).
  const avg = Math.min(max, roundMarks((a.marksAwarded + b.marksAwarded) / 2));
  const status = stricterStatus(a.status, b.status);
  const evidence = pickEvidence(a, b);
  return {
    criterionId: id,
    concept,
    marksAvailable: max,
    marksAwarded: avg,
    status,
    evidenceBlockId: evidence?.evidenceBlockId,
    evidence: evidence?.evidence,
    feedback: evidence?.feedback,
    evidenceRegion: evidence?.evidenceRegion,
    confidence: round2(Math.min(a.confidence, b.confidence)),
  };
}

function stricterStatus(
  x: RubricEval["status"],
  y: RubricEval["status"],
): RubricEval["status"] {
  const order = { missing: 0, incorrect: 1, partial: 2, correct: 3 } as const;
  return order[x] < order[y] ? x : y;
}

function pickEvidence(a: RubricEval, b: RubricEval) {
  if (a.evidenceBlockId && a.evidence) return a;
  if (b.evidenceBlockId && b.evidence) return b;
  return a.evidence ? a : b;
}

function computeAgreement(
  a: GraderResult,
  b: GraderResult,
  question: Question,
): number {
  const diffs = question.rubric.map((c) => {
    const ea = a.rubricEvaluation.find((e) => e.criterionId === c.id);
    const eb = b.rubricEvaluation.find((e) => e.criterionId === c.id);
    if (!ea || !eb) return 1;
    return Math.abs(ea.marksAwarded - eb.marksAwarded) / (c.marks || 1);
  });
  const avgDiff = diffs.reduce((s, d) => s + d, 0) / (diffs.length || 1);
  return clamp01(1 - avgDiff);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
