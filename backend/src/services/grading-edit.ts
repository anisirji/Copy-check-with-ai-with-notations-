import { z } from "zod";
import type {
  MistakeTag,
  PipelineResult,
  QuestionGrading,
  RubricEval,
  SemanticAnswer,
} from "../types.js";
import { buildAnalytics } from "./analytics.js";
import { buildAnnotations } from "./annotator.js";
import { roundMarks } from "./exam-marks.js";
import { inferMistakeTag } from "./mistake-tag.js";
import { attachReviews } from "./review.js";

const editSchema = z
  .object({
    criterionId: z.string().min(1),
    marksAwarded: z.number().finite().min(0),
    status: z.enum(["correct", "partial", "missing", "incorrect"]).optional(),
    mistakeTag: z
      .enum(["concept_gap", "careless", "incomplete", "left_blank"])
      .optional(),
  })
  .strict();

export const gradingPatchSchema = z
  .object({
    questionId: z.string().min(1),
    criterionId: z.string().optional(),
    marksAwarded: z.number().finite().min(0).optional(),
    status: editSchema.shape.status,
    mistakeTag: editSchema.shape.mistakeTag,
    edits: z.array(editSchema).optional(),
    approve: z.boolean().optional(),
    comment: z.string().trim().max(1000).optional(),
  })
  .strict();

function resolveMistakeTag(
  criterion: RubricEval,
  semantic: SemanticAnswer,
  requested: MistakeTag,
): MistakeTag {
  if (criterion.status === "correct") return undefined;
  const nonBlank =
    criterion.marksAwarded > 0 || !!semantic.rawTranscript.trim();
  if (requested === "left_blank" && nonBlank)
    return inferMistakeTag(criterion, semantic);
  return requested ?? inferMistakeTag(criterion, semantic);
}

/** Validate every edit before mutating a cloned document. All derived values
 * are regenerated from the authoritative rubric, including stale blank tags. */
export function applyGradingPatch(
  doc: PipelineResult,
  input: unknown,
): { result: PipelineResult; grading: QuestionGrading } {
  const patch = gradingPatchSchema.parse(input);
  const result = structuredClone(doc);
  const grading = result.grading.find((q) => q.questionId === patch.questionId);
  if (!grading) throw new Error("Question not found");
  const previous = structuredClone(grading);
  grading.rubricEvaluation = structuredClone(grading.rubricEvaluation);
  const edits = [...(patch.edits ?? [])];
  if (patch.criterionId) {
    const criterion = grading.rubricEvaluation.find(
      (c) => c.criterionId === patch.criterionId,
    );
    if (!criterion) throw new Error("Criterion not found");
    edits.push({
      criterionId: patch.criterionId,
      marksAwarded: patch.marksAwarded ?? criterion.marksAwarded,
      status: patch.status,
      mistakeTag: patch.mistakeTag,
    });
  } else if (
    patch.marksAwarded !== undefined ||
    patch.status ||
    patch.mistakeTag
  ) {
    throw new Error("criterionId is required for criterion edits");
  }
  if (!edits.length && patch.comment === undefined && patch.approve !== true)
    throw new Error("No grading change supplied");
  const seen = new Set<string>();
  for (const edit of edits) {
    if (seen.has(edit.criterionId)) throw new Error("Duplicate criterion edit");
    seen.add(edit.criterionId);
    const criterion = grading.rubricEvaluation.find(
      (c) => c.criterionId === edit.criterionId,
    );
    if (!criterion) throw new Error(`Criterion ${edit.criterionId} not found`);
    if (edit.marksAwarded > criterion.marksAvailable)
      throw new Error(
        `Marks for ${edit.criterionId} must be between 0 and ${criterion.marksAvailable}`,
      );
    if (Math.abs(roundMarks(edit.marksAwarded) - edit.marksAwarded) > 1e-8)
      throw new Error("Marks must have at most two decimal places");
    criterion.marksAwarded = roundMarks(edit.marksAwarded);
    criterion.status =
      criterion.marksAwarded === criterion.marksAvailable
        ? "correct"
        : criterion.marksAwarded > 0
          ? "partial"
          : edit.status === "missing" || !grading.semantic.rawTranscript.trim()
            ? "missing"
            : "incorrect";
    criterion.mistakeTag = resolveMistakeTag(
      criterion,
      grading.semantic,
      edit.mistakeTag,
    );
    criterion.confidence = 1;
    criterion.overriddenByTeacher = true;
  }
  if (patch.comment !== undefined)
    grading.teacherComment = patch.comment || undefined;
  if (patch.approve) {
    grading.route = "auto_accept";
    grading.needsTeacherReview = false;
    grading.teacherReviewedAt = new Date().toISOString();
  }
  grading.awardedMarks = roundMarks(
    grading.rubricEvaluation.reduce(
      (sum, criterion) => sum + criterion.marksAwarded,
      0,
    ),
  );
  if (grading.awardedMarks > grading.maxMarks)
    throw new Error("Question total exceeds its maximum");
  result.analytics = buildAnalytics(result.grading);
  result.annotations = buildAnnotations(result.grading, result.blocks);
  attachReviews(result.grading, result.exam.questions, result.blocks);
  result.overrideHistory = [
    ...(result.overrideHistory ?? []),
    {
      updatedAt: new Date().toISOString(),
      questionId: grading.questionId,
      previous,
      updated: structuredClone(grading),
    },
  ];
  if (edits.length || patch.comment !== undefined)
    result.acknowledgment = undefined;
  return { result, grading };
}
