import type { ExamConfig, RubricCriterion } from "../types.js";

const MARK_UNITS = 100;
const TOLERANCE = 1e-6;

export function roundMarks(value: number): number {
  return Math.round((value + Number.EPSILON) * MARK_UNITS) / MARK_UNITS;
}

function requirePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
}

function requireMarkPrecision(value: number, label: string): void {
  requirePositive(value, label);
  if (
    !Number.isSafeInteger(Math.round(value * MARK_UNITS)) ||
    Math.abs(roundMarks(value) - value) > TOLERANCE
  ) {
    throw new Error(
      `${label} must have at most two decimal places; normalize marks before approval/grading`,
    );
  }
}

/** Allocate marks to hundredths without losing marks to independent rounding. */
export function allocateMarks(
  weights: readonly number[],
  totalMarks: number,
): number[] {
  requirePositive(totalMarks, "Total marks");
  const totalUnits = Math.round(totalMarks * MARK_UNITS);
  if (
    !Number.isSafeInteger(totalUnits) ||
    Math.abs(totalUnits / MARK_UNITS - totalMarks) > TOLERANCE
  ) {
    throw new Error("Total marks must have at most two decimal places");
  }
  if (weights.length === 0)
    throw new Error("At least one mark allocation is required");
  weights.forEach((weight) => requirePositive(weight, "Mark allocation"));
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  requirePositive(sum, "Sum of mark allocations");
  if (totalUnits < weights.length) {
    throw new Error(
      `Cannot allocate ${totalMarks} marks across ${weights.length} items while keeping every item worth at least 0.01 marks`,
    );
  }

  const ideal = weights.map((weight) => (weight / sum) * totalUnits);
  const units = ideal.map((value) => Math.max(1, Math.floor(value)));
  let remainder = totalUnits - units.reduce((acc, value) => acc + value, 0);
  const descending = ideal
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let i = 0; remainder > 0; i++, remainder--) {
    units[descending[i % descending.length].index]++;
  }
  // Extremely small weights may have been raised to the minimum unit.
  while (remainder < 0) {
    let largest = 0;
    for (let i = 1; i < units.length; i++)
      if (units[i] > units[largest]) largest = i;
    units[largest]--;
    remainder++;
  }
  return units.map((value) => value / MARK_UNITS);
}

export function normalizeRubricMarks(
  criteria: readonly RubricCriterion[],
  maxMarks: number,
): RubricCriterion[] {
  if (criteria.length === 0) return [];
  const marks = allocateMarks(
    criteria.map((criterion) => criterion.marks),
    maxMarks,
  );
  return criteria.map((criterion, index) => ({
    ...criterion,
    marks: marks[index],
  }));
}

/** Draft repair: keep the requested total and reweight every existing question/rubric. */
export function normalizeExamMarks(
  exam: ExamConfig,
  totalMarks: number,
): ExamConfig {
  const originalTotalMarks = exam.questions.reduce(
    (sum, question) => sum + question.maxMarks,
    0,
  );
  const maxMarks = allocateMarks(
    exam.questions.map((question) => question.maxMarks),
    totalMarks,
  );
  return {
    ...exam,
    totalMarks,
    approval: undefined,
    marksNormalization: {
      originalTotalMarks: roundMarks(originalTotalMarks),
      targetTotalMarks: totalMarks,
      questions: exam.questions.map((question, index) => ({
        id: question.id,
        originalMaxMarks: question.maxMarks,
        maxMarks: maxMarks[index],
      })),
    },
    questions: exam.questions.map((question, index) => ({
      ...question,
      maxMarks: maxMarks[index],
      rubric: normalizeRubricMarks(question.rubric, maxMarks[index]),
    })),
  };
}

/** Shared approval/grading gate; drafts may temporarily have mismatched totals. */
export function assertExamMarks(exam: ExamConfig): void {
  requireMarkPrecision(exam.totalMarks, "Exam total marks");
  if (exam.questions.length === 0)
    throw new Error("Exam must contain at least one question");
  const questionIds = new Set<string>();
  for (const question of exam.questions) {
    const key = question.id.trim().toLowerCase();
    if (!key || questionIds.has(key))
      throw new Error(`Question IDs must be unique: ${question.id}`);
    questionIds.add(key);
    requireMarkPrecision(
      question.maxMarks,
      `Question ${question.id} max marks`,
    );
    if (question.rubric.length === 0)
      throw new Error(`Question ${question.id} has an empty rubric`);
    const criterionIds = new Set<string>();
    for (const criterion of question.rubric) {
      if (!criterion.id.trim() || criterionIds.has(criterion.id)) {
        throw new Error(
          `Question ${question.id} has duplicate or empty rubric criterion IDs`,
        );
      }
      criterionIds.add(criterion.id);
      requireMarkPrecision(
        criterion.marks,
        `Question ${question.id} criterion ${criterion.id} marks`,
      );
    }
    const rubricTotal = question.rubric.reduce(
      (sum, criterion) => sum + criterion.marks,
      0,
    );
    if (Math.abs(rubricTotal - question.maxMarks) > TOLERANCE) {
      throw new Error(
        `Question ${question.id} rubric totals ${roundMarks(rubricTotal)} marks, but its maximum is ${question.maxMarks}. Correct the rubric or normalize marks before approval/grading.`,
      );
    }
  }
  const total = exam.questions.reduce(
    (sum, question) => sum + question.maxMarks,
    0,
  );
  if (Math.abs(total - exam.totalMarks) > TOLERANCE) {
    throw new Error(
      `Question marks total ${roundMarks(total)}, but the exam total is ${exam.totalMarks}. Correct question marks or normalize marks before approval/grading.`,
    );
  }
}
