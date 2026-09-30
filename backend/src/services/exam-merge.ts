import type { ExamConfig, Question, RubricCriterion } from "../types.js";
import { normalizeRubricMarks, roundMarks } from "./exam-marks.js";

/** Full paper labels only; short answer markers need the mapper's context. */
export function questionIdParts(id: string): string[] | null {
  const text = id
    .toLowerCase()
    .trim()
    .replace(/^(?:question|q)\s*/, "")
    .replace(/\s+/g, "");
  const full = text.match(
    /^(\d+)((?:\([a-z0-9]+\)|[.\-][a-z0-9]+|[a-z]+)*)[.):]?$/,
  );
  if (!full) return null;
  const parts = [String(Number(full[1]))];
  for (const match of full[2].matchAll(
    /\(([a-z0-9]+)\)|[.\-]([a-z0-9]+)|([a-z]+)/g,
  )) {
    parts.push(match[1] ?? match[2] ?? match[3]);
  }
  return parts;
}

export interface MergeQuestionsInput {
  questionIds: string[];
  id: string;
  maxMarks?: number;
}

export function mergeExamQuestions(
  exam: ExamConfig,
  input: MergeQuestionsInput,
): ExamConfig {
  if (
    input.questionIds.length < 2 ||
    new Set(input.questionIds).size !== input.questionIds.length
  ) {
    throw new Error("Select at least two distinct subparts to merge");
  }
  const selectedIds = new Set(input.questionIds);
  const selected = exam.questions.filter((question) =>
    selectedIds.has(question.id),
  );
  if (selected.length !== selectedIds.size)
    throw new Error("One or more selected questions were not found");
  const sourceParts = selected.map((question) => questionIdParts(question.id));
  if (sourceParts.some((parts) => !parts || parts.length < 2)) {
    throw new Error(
      "Only subparts with the same immediate parent can be merged",
    );
  }
  const parent = sourceParts[0]!.slice(0, -1).join("/");
  if (sourceParts.some((parts) => parts!.slice(0, -1).join("/") !== parent)) {
    throw new Error(
      "Only subparts with the same immediate parent can be merged",
    );
  }
  if (
    new Set(sourceParts.map((parts) => parts!.join("/"))).size !==
    selected.length
  ) {
    throw new Error("Selected subparts must have distinct paper labels");
  }
  const targetId = input.id.trim();
  const targetParts = questionIdParts(targetId);
  if (!targetParts || targetParts.join("/") !== parent) {
    throw new Error(
      "The merged question ID must be the shared parent of the selected subparts",
    );
  }
  if (
    exam.questions.some(
      (question) =>
        !selectedIds.has(question.id) &&
        questionIdParts(question.id)?.join("/") === parent,
    )
  ) {
    throw new Error(`Question ${targetId} already exists`);
  }
  const sum = selected.reduce(
    (total, question) => total + question.maxMarks,
    0,
  );
  const maxMarks = input.maxMarks ?? roundMarks(sum);
  if (!Number.isFinite(maxMarks) || maxMarks <= 0)
    throw new Error("Merged max marks must be a positive finite number");
  if (
    selected.some(
      (question) =>
        !Number.isFinite(question.maxMarks) || question.maxMarks <= 0,
    )
  ) {
    throw new Error("Selected subparts must have positive finite max marks");
  }

  if (selected.some((question) => question.rubric.length === 0)) {
    throw new Error(
      "Complete the rubric for every selected subpart before merging",
    );
  }
  const criteria: RubricCriterion[] = selected.flatMap(
    (question, questionIndex) =>
      question.rubric.map((criterion, criterionIndex) => ({
        ...criterion,
        id: `${targetId}::${questionIndex + 1}::${criterionIndex + 1}`,
        concept: `[${question.id}] ${criterion.concept}`,
        sourceQuestionId: criterion.sourceQuestionId ?? question.id,
        sourceCriterionId: criterion.sourceCriterionId ?? criterion.id,
      })),
  );
  const rubric =
    input.maxMarks === undefined
      ? criteria
      : normalizeRubricMarks(criteria, maxMarks);
  const tags = selected[0].tags;
  const merged: Question = {
    id: targetId,
    sourceQuestionIds: [
      ...new Set(
        selected.flatMap((question) => [
          question.id,
          ...(question.sourceQuestionIds ?? []),
        ]),
      ),
    ],
    prompt: selected
      .map((question) => `[${question.id}]\n${question.prompt}`)
      .join("\n\n"),
    maxMarks,
    subject: selected.every(
      (question) => question.subject === selected[0].subject,
    )
      ? selected[0].subject
      : "general",
    modelAnswer: selected
      .map(
        (question) =>
          `[${question.id}]\n${question.modelAnswer || "Model answer not supplied."}`,
      )
      .join("\n\n"),
    rubric,
    tags: tags
      ? {
          ...tags,
          topics: [
            ...new Set(
              selected.flatMap((question) => question.tags?.topics ?? []),
            ),
          ],
          confirmedByTeacher: false,
        }
      : undefined,
    flags: [
      ...new Set([
        ...selected.flatMap((question) => question.flags ?? []),
        `Merged subparts ${selected.map((question) => question.id).join(", ")}; review the combined rubric and topic/difficulty tags.`,
      ]),
    ],
  };
  const firstIndex = exam.questions.findIndex((question) =>
    selectedIds.has(question.id),
  );
  return {
    ...exam,
    approval: undefined,
    questions: exam.questions.flatMap((question, index) =>
      index === firstIndex
        ? [merged]
        : selectedIds.has(question.id)
          ? []
          : [question],
    ),
  };
}
