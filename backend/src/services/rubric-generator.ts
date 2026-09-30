import type { RubricCriterion, Question } from "../types.js";
import { ProviderRegistry } from "../providers/index.js";
import { extractJson } from "./util-json.js";
import { normalizeRubricMarks } from "./exam-marks.js";

type CurriculumContext = { subject?: string; class?: string };
const equivalenceGuidance =
  "Accept scientifically equivalent answers and notation appropriate to the stated class. A model answer is an example, not an exclusive wording requirement. Do not require advanced notation unless the question explicitly asks for it; for school-level electronic configurations, include shell notation (e.g. 2, 8, 3) as fully acceptable. For questions asking for any two features, allow any two distinct valid features without requiring the specific pair in the model answer.";

/**
 * Phase 1 — Generate a rubric for a question.
 *
 * Two-pass:
 *   1. Generate draft criteria (Claude, best rubric reasoner)
 *   2. Critique pass (same provider, different prompt): "what's ambiguous?
 *      what's missing? does marks sum to maxMarks?" → refined rubric
 *
 * Post-validation:
 *   - sum(criterion.marks) === maxMarks (hard). If not, renormalize
 *     proportionally allocated to hundredths without rounding drift.
 *   - Every criterion has an id, concept, marks > 0.
 */
export async function generateRubric(
  question: Omit<Question, "rubric"> & { rubric?: never },
  registry: ProviderRegistry,
  context: CurriculumContext = {},
): Promise<RubricCriterion[]> {
  const draft = await draftRubric(question, registry, context);
  const refined = await critiqueAndRefine(question, draft, registry, context);
  return normalizeMarks(refined, question.maxMarks, question.id);
}

async function draftRubric(
  question: Omit<Question, "rubric">,
  registry: ProviderRegistry,
  context: CurriculumContext,
): Promise<RubricCriterion[]> {
  const prompt = `You are writing a marking rubric for a ${question.subject ?? "K-12"} exam question.
Class: ${context.class ?? "K-12"}. Subject: ${context.subject ?? question.subject ?? "general"}.
${equivalenceGuidance}

Question ${question.id} (max ${question.maxMarks} marks):
${question.prompt}

${question.modelAnswer ? `Model answer:\n${question.modelAnswer}\n` : ""}
Rubric requirements:
- Break the answer into ${suggestCriterionCount(question.maxMarks)} independent concept criteria.
- Every criterion is checkable by a strict examiner ("did the student clearly satisfy this?").
- Marks per criterion must be a positive number; the SUM of marks must equal ${question.maxMarks}.
- Fractional marks are allowed; preserve the stated maximum exactly (up to two decimal places).
- For each criterion include \`acceptable\` — 2–5 alternative phrasings a student might use.
  (E.g. concept "chlorophyll" → acceptable ["chlorophyll", "green pigment", "chloroplast pigment"])

Return ONLY this JSON, no prose, no fences:
{
  "criteria": [
    { "id": "${question.id}a", "concept": "...", "marks": ..., "acceptable": ["...", "..."] },
    ...
  ]
}`;

  const resp = await registry.call("rubric-generation", {
    prompt,
    temperature: 0.15,
    maxTokens: 2048,
  });
  const parsed = extractJson<{ criteria: RubricCriterion[] }>(resp.text);
  return parsed?.criteria ?? [];
}

async function critiqueAndRefine(
  question: Omit<Question, "rubric">,
  draft: RubricCriterion[],
  registry: ProviderRegistry,
  context: CurriculumContext,
): Promise<RubricCriterion[]> {
  if (draft.length === 0) return draft;
  const prompt = `You are auditing an AI-generated marking rubric before it is used to grade students.
Class: ${context.class ?? "K-12"}. Subject: ${context.subject ?? question.subject ?? "general"}.
${equivalenceGuidance}

Question ${question.id} (max ${question.maxMarks} marks):
${question.prompt}

${question.modelAnswer ? `Model answer:\n${question.modelAnswer}\n` : ""}
Draft rubric:
${JSON.stringify(draft, null, 2)}

Fix any of these issues:
1. Sum of marks ≠ ${question.maxMarks} → redistribute
2. Two criteria testing the same concept → merge
3. A criterion so subjective it cannot be reliably scored → rewrite or delete
4. Missing concept the model answer clearly requires → add
5. Weak acceptable-phrasings list → expand

Return ONLY the refined rubric as JSON, no prose, no fences:
{ "criteria": [ ... ] }`;

  const resp = await registry.call("rubric-generation", {
    prompt,
    temperature: 0.1,
    maxTokens: 2048,
  });
  const parsed = extractJson<{ criteria: RubricCriterion[] }>(resp.text);
  return (parsed?.criteria?.length ?? 0) > 0 ? parsed!.criteria : draft;
}

function suggestCriterionCount(maxMarks: number): string {
  if (maxMarks <= 1) return "1";
  if (maxMarks <= 2) return "1 to 2";
  if (maxMarks <= 3) return "2 to 3";
  if (maxMarks <= 5) return "3 to 5";
  return "4 to 7";
}

/**
 * Enforce sum(marks) === maxMarks without rounding away fractional marks.
 * Generated criterion IDs must also be unique within the question.
 */
function normalizeMarks(
  criteria: RubricCriterion[],
  maxMarks: number,
  questionId: string,
): RubricCriterion[] {
  if (criteria.length === 0) return criteria;

  const used = new Set<string>();
  const positive = criteria.map((criterion, index) => {
    const base = criterion.id?.trim() || `${questionId}::${index + 1}`;
    let id = base;
    let suffix = 2;
    while (used.has(id)) id = `${base}::${suffix++}`;
    used.add(id);
    const value = Number(criterion.marks);
    return {
      ...criterion,
      id,
      marks: Number.isFinite(value) && value > 0 ? value : 1,
    };
  });
  return normalizeRubricMarks(positive, maxMarks);
}
