import type {
  Block,
  Question,
  QuestionGrading,
  QuestionReview,
  ReviewDiffRow,
  ReviewVerdict,
  StudentAnswerPayload,
} from "../types.js";
import { buildCanonicalAnswer } from "./canonical-answer.js";

/**
 * Build the human-friendly review payload for one graded question.
 *
 * Pure derivation from the pipeline's existing outputs — no LLM calls.
 * The frontend renders this in a fixed order:
 *
 *   Header (marks + verdict) → Question → Student answer ⇆ Expected answer
 *   → AI review (diff bullets) → Step marks → Developer details
 *
 * The frontend does not have to concatenate rubric bullets, strip block-id
 * prefixes from transcripts, or infer a verdict from the marks — those
 * are the backend's responsibility so every UI shows the same wording.
 */
export function buildQuestionReview(
  grading: QuestionGrading,
  question: Question | undefined,
  blocks?: Block[],
): QuestionReview {
  const studentAnswer = buildStudentAnswer(grading, blocks);
  const expectedAnswer = buildExpectedAnswer(question, grading);
  const verdict = deriveVerdict(grading, studentAnswer.displayText);
  const diff = buildDiff(grading, question);
  const { differences, explanation } = buildExplanation(grading, verdict);

  return {
    studentAnswer,
    expectedAnswer,
    diff,
    differences,
    verdict,
    // Only surface needsTeacher when the routing genuinely needs review AND
    // the mark isn't already a decisive full-marks (in which case we cleared
    // the flag on ingest). Confidence alone shouldn't force this on — a
    // correct answer at low confidence still displays as "Correct" with the
    // low-confidence number visible in the header.
    needsTeacher:
      grading.needsTeacherReview === true &&
      !(grading.awardedMarks === grading.maxMarks && grading.maxMarks > 0),
    needsTeacherReason: grading.reviewReason,
    explanation,
    awardedMarks: grading.awardedMarks,
    maxMarks: grading.maxMarks,
    confidence: grading.systemConfidence,
  };
}

export function attachReviews(
  gradings: QuestionGrading[],
  questions: Question[],
  blocks?: Block[],
): void {
  const byId = new Map(questions.map((q) => [q.id, q]));
  for (const g of gradings) {
    // Reset the "needs teacher" flag on questions that scored full marks so the
    // UI doesn't show green + red at the same time. The flag persists on any
    // question that either lost marks or was routed to teacher_review.
    if (
      g.needsTeacherReview &&
      g.awardedMarks === g.maxMarks &&
      g.maxMarks > 0 &&
      g.rubricEvaluation.every((c) => c.marksAwarded === c.marksAvailable)
    ) {
      g.needsTeacherReview = false;
      g.reviewReason = undefined;
      g.route = "auto_accept";
    }
    g.review = buildQuestionReview(g, byId.get(g.questionId), blocks);
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────

/**
 * Semantic layer prefixes each transcript block with e.g.
 *   `[p1_b2] (text) …`
 * Useful for debug, noisy for teachers. Strip those prefixes for display,
 * keep the raw transcript untouched for the developer expander.
 */
function stripPipelinePrefixes(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[[^\]]+\]\s*\([^)]+\)\s*/, "").trimEnd())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

function buildStudentAnswer(
  grading: QuestionGrading,
  blocks?: Block[],
): StudentAnswerPayload {
  const rawTranscript = grading.semantic?.rawTranscript ?? "";
  // If we have the source blocks available, build a canonical answer from
  // them — that gives us the clean "one line per real answer" text without
  // question markers, synthetic normalizer blocks, or duplicates. Otherwise
  // fall back to stripping pipeline prefixes from the raw transcript.
  const byId = blocks ? new Map(blocks.map((b) => [b.id, b])) : undefined;
  const mappedBlocks = byId
    ? grading.answerBlockIds
        .map((id) => byId.get(id))
        .filter((b): b is Block => !!b)
    : undefined;
  if (mappedBlocks && mappedBlocks.length > 0) {
    const canonical = buildCanonicalAnswer(mappedBlocks);
    return {
      displayText: canonical.plainText,
      rawTranscript,
      equations: canonical.equations,
      diagrams: canonical.diagrams,
      crossedOut: canonical.crossedOut,
    };
  }
  const displayText = stripPipelinePrefixes(rawTranscript);
  return {
    displayText,
    rawTranscript,
    equations: (grading.semantic?.equations ?? [])
      .map((e) => e.text?.trim() ?? "")
      .filter((t) => t.length > 0),
    diagrams: (grading.semantic?.diagrams ?? [])
      .map((d) => d.description?.trim() ?? "")
      .filter((t) => t.length > 0),
    crossedOut: rawTranscript
      .split(/\r?\n/)
      .filter((line) => /\(crossed_out\)/i.test(line))
      .map((line) => line.replace(/^\s*\[[^\]]+\]\s*\([^)]+\)\s*/, "").trim())
      .filter((t) => t.length > 0),
  };
}

function buildExpectedAnswer(
  question: Question | undefined,
  grading: QuestionGrading,
): string {
  if (question?.modelAnswer && question.modelAnswer.trim().length > 0) {
    return question.modelAnswer.trim();
  }
  const perCriterion = grading.rubricEvaluation
    .map((c) => `• ${c.concept}`)
    .join("\n");
  return perCriterion || "";
}

function deriveVerdict(
  grading: QuestionGrading,
  displayText: string,
): ReviewVerdict {
  // Verdict is ALWAYS derived from marks. The "needs teacher" state is a
  // separate flag on the review payload so the UI can show both.
  const hasWriting = displayText.length > 0;
  if (grading.awardedMarks >= grading.maxMarks && grading.maxMarks > 0) {
    return "correct";
  }
  if (grading.awardedMarks > 0) return "partially_correct";
  return hasWriting ? "incorrect" : "missing";
}

function buildDiff(
  grading: QuestionGrading,
  question: Question | undefined,
): ReviewDiffRow[] {
  const rubric = question?.rubric ?? [];
  const byId = new Map(rubric.map((r) => [r.id, r]));
  return grading.rubricEvaluation.map((c) => {
    const source = byId.get(c.criterionId);
    // Use the first "acceptable" example as the expected phrasing, if any.
    // Some legacy rubrics stored nested arrays / objects — coerce defensively.
    const acceptable = source?.acceptable;
    const firstAcceptable = Array.isArray(acceptable)
      ? typeof acceptable[0] === "string"
        ? (acceptable[0] as string)
        : JSON.stringify(acceptable[0] ?? "")
      : "";
    const expectedRaw = firstAcceptable || source?.concept || c.concept || "";
    return {
      criterionId: c.criterionId,
      concept: c.concept,
      status: c.status,
      studentSaid: (c.evidence ?? "").toString().trim(),
      expected: String(expectedRaw).trim(),
      awardedMarks: c.marksAwarded,
      maxMarks: c.marksAvailable,
    };
  });
}

function buildExplanation(
  grading: QuestionGrading,
  verdict: ReviewVerdict,
): { differences: string[]; explanation: string } {
  const differences: string[] = [];
  const bullets: string[] = [];

  for (const c of grading.rubricEvaluation) {
    const passed = c.marksAwarded === c.marksAvailable;
    if (passed) {
      bullets.push(`✓ ${c.concept}`);
      continue;
    }
    if (c.status === "missing") {
      const line = c.feedback
        ? `Missing "${c.concept}": ${c.feedback}`
        : `Missing "${c.concept}".`;
      differences.push(line);
      bullets.push(`○ ${line}`);
      continue;
    }
    const line = c.feedback
      ? `${c.concept} — ${c.feedback}`
      : `${c.concept} — does not fully match the expected answer.`;
    differences.push(line);
    bullets.push(`✗ ${line}`);
  }

  const header = (
    {
      correct: "Answer meets every marking criterion.",
      partially_correct:
        "Some criteria met, some not — see the difference below.",
      incorrect: "Answer does not match the expected concept.",
      missing: "No valid student answer was detected for this question.",
      needs_review: "Flagged for teacher review before marks are released.",
    } as const
  )[verdict];

  const explanation = [header, ...bullets].filter(Boolean).join("\n");
  return { differences, explanation };
}
