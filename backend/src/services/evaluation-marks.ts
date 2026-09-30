import type { PipelineResult } from "../types.js";
import { assertExamMarks, roundMarks } from "./exam-marks.js";

/** Validate the saved snapshot, every criterion, and all totals before release.
 * Checking only analytics.totalMax would allow legacy 20/25 schemes through. */
export function assertEvaluationMarks(doc: PipelineResult): void {
  assertExamMarks(doc.exam);
  const seen = new Set<string>();
  for (const grading of doc.grading) {
    const question = doc.exam.questions.find(
      (q) => q.id === grading.questionId,
    );
    if (!question || seen.has(grading.questionId))
      throw new Error(
        "Graded questions do not match the marking scheme. Correct the evaluation before releasing.",
      );
    seen.add(grading.questionId);
    if (grading.maxMarks !== question.maxMarks)
      throw new Error(
        `Q${question.id}: the graded maximum does not match the scheme.`,
      );
    const criteria = new Set<string>();
    for (const evaluated of grading.rubricEvaluation) {
      const criterion = question.rubric.find(
        (c) => c.id === evaluated.criterionId,
      );
      if (
        !criterion ||
        criteria.has(evaluated.criterionId) ||
        evaluated.marksAvailable !== criterion.marks ||
        !Number.isFinite(evaluated.marksAwarded) ||
        evaluated.marksAwarded < 0 ||
        evaluated.marksAwarded > criterion.marks ||
        Math.abs(roundMarks(evaluated.marksAwarded) - evaluated.marksAwarded) >
          1e-8
      ) {
        throw new Error(
          `Q${question.id}: criterion marks do not match the scheme.`,
        );
      }
      criteria.add(evaluated.criterionId);
    }
    const awarded = roundMarks(
      grading.rubricEvaluation.reduce((sum, c) => sum + c.marksAwarded, 0),
    );
    if (
      criteria.size !== question.rubric.length ||
      awarded !== grading.awardedMarks
    )
      throw new Error(
        `Q${question.id}: the question total does not match its criterion marks.`,
      );
  }
  if (seen.size !== doc.exam.questions.length)
    throw new Error(
      "Some questions have no grading result. Correct the evaluation before releasing.",
    );
  const awarded = roundMarks(
    doc.grading.reduce((sum, g) => sum + g.awardedMarks, 0),
  );
  const maximum = roundMarks(
    doc.grading.reduce((sum, g) => sum + g.maxMarks, 0),
  );
  if (
    maximum !== doc.exam.totalMarks ||
    doc.analytics.totalMax !== maximum ||
    doc.analytics.totalAwarded !== awarded
  ) {
    throw new Error(
      "Saved totals do not match the question marks. Correct the evaluation before releasing.",
    );
  }
}
