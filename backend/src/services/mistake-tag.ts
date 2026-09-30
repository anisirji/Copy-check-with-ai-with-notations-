import type { MistakeTag, RubricEval, SemanticAnswer } from "../types.js";

/**
 * Infer a mistake tag from a rubric evaluation + semantic answer context.
 *
 * Heuristics — deliberately transparent so teachers can override during review:
 *   - `correct`      → no tag (returns undefined)
 *   - `missing`      → `left_blank` if student wrote nothing on this criterion's
 *                      concept; otherwise `concept_gap`
 *   - `incorrect`    → `concept_gap` (they tried but got it wrong)
 *   - `partial`      → `careless` if they got the method right but skipped a
 *                      step / arithmetic slip; otherwise `incomplete`
 *
 * "Method right / careless finish" heuristic: partial evaluations with an
 * evidenceBlockId whose text contains an equation-like pattern are treated
 * as careless. Everything else partial = incomplete.
 */
export function inferMistakeTag(
  ev: RubricEval,
  semantic: SemanticAnswer | undefined,
): MistakeTag {
  if (ev.status === "correct") return undefined;

  if (ev.status === "missing") {
    const hasAnyWriting = !!(semantic?.rawTranscript?.trim().length ?? 0);
    return hasAnyWriting ? "concept_gap" : "left_blank";
  }

  if (ev.status === "incorrect") return "concept_gap";

  // partial
  const evidence = ev.evidence?.toLowerCase() ?? "";
  const looksLikeCalc = /[=+\-−×÷/]/.test(evidence) && /\d/.test(evidence);
  return looksLikeCalc ? "careless" : "incomplete";
}

/**
 * Tag every rubric eval in a grading document in-place (or return a copy).
 * Skip evals a teacher has already overridden.
 */
export function inferAll(
  grading: { rubricEvaluation: RubricEval[]; semantic?: SemanticAnswer }[],
): void {
  for (const q of grading) {
    for (const ev of q.rubricEvaluation) {
      if (ev.overriddenByTeacher) continue;
      if (ev.mistakeTag) continue;
      ev.mistakeTag = inferMistakeTag(ev, q.semantic);
    }
  }
}
