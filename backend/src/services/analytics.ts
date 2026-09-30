import type { Analytics, ConfidenceRoute, QuestionGrading } from "../types.js";
import { roundMarks } from "./exam-marks.js";

/**
 * Stage 11 — Result analytics.
 *
 * For a single student, produces:
 *  - per-question totals + weakest criteria
 *  - a flat list of concepts the student missed
 *  - automation coverage (how many questions the system was confident enough
 *    to auto-accept)
 *
 * When aggregated across many students, this becomes the "class weakness"
 * report shown in the arch doc (step 19).
 */
export function buildAnalytics(grading: QuestionGrading[]): Analytics {
  const perQuestion = grading.map((g) => ({
    questionId: g.questionId,
    awarded: g.awardedMarks,
    max: g.maxMarks,
    weakestCriteria: g.rubricEvaluation
      .filter((e) => e.status === "missing" || e.status === "incorrect")
      .map((e) => ({ criterionId: e.criterionId, concept: e.concept })),
  }));

  const missedByConcept = new Map<string, number>();
  for (const g of grading) {
    for (const e of g.rubricEvaluation) {
      if (e.status === "missing" || e.status === "incorrect") {
        missedByConcept.set(
          e.concept,
          (missedByConcept.get(e.concept) ?? 0) + 1,
        );
      }
    }
  }
  const weakConcepts = Array.from(missedByConcept.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([concept, missedCount]) => ({ concept, missedCount }));

  const totalAwarded = roundMarks(
    grading.reduce((s, g) => s + g.awardedMarks, 0),
  );
  const totalMax = roundMarks(grading.reduce((s, g) => s + g.maxMarks, 0));

  const routeCounts: Record<ConfidenceRoute, number> = {
    auto_accept: 0,
    verify_ai: 0,
    teacher_review: 0,
  };
  for (const g of grading) routeCounts[g.route] += 1;

  const automationRate = grading.length
    ? routeCounts.auto_accept / grading.length
    : 0;

  return {
    perQuestion,
    weakConcepts,
    totalAwarded,
    totalMax,
    automationRate: Math.round(automationRate * 100) / 100,
    routeCounts,
  };
}
