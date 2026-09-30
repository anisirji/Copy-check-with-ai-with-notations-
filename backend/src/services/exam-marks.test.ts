import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import type { ExamConfig, Question } from "../types.js";
import { examConfigSchema } from "../types.js";
import {
  allocateMarks,
  assertExamMarks,
  normalizeExamMarks,
  roundMarks,
} from "./exam-marks.js";
import { mergeExamQuestions, questionIdParts } from "./exam-merge.js";
import { ExamStore } from "./exam-store.js";
import { generateRubric } from "./rubric-generator.js";
import { ProviderRegistry } from "../providers/index.js";
import { examRoutes } from "../routes/exam.route.js";

function question(id: string, maxMarks = 1): Question {
  return {
    id,
    prompt: `Prompt for ${id}`,
    maxMarks,
    modelAnswer: `Answer for ${id}`,
    subject: "chemistry",
    rubric: [
      {
        id: "criterion",
        concept: `Concept for ${id}`,
        marks: maxMarks,
        acceptable: ["alternative"],
      },
    ],
    tags: {
      chapter: "Atoms",
      topics: ["Structure"],
      difficulty: "medium",
      confirmedByTeacher: true,
    },
  };
}

function exam(
  questions = [question("1(a)"), question("1(b)"), question("2", 3)],
  totalMarks?: number,
): ExamConfig {
  return {
    title: "Chemistry test",
    subject: "chemistry",
    class: "9",
    totalMarks:
      totalMarks ??
      questions.reduce((sum, current) => sum + current.maxMarks, 0),
    questions,
    approval: { approvedAt: "2026-01-01T00:00:00Z", approvedBy: "teacher" },
  };
}

test("25-mark extraction is normalized to teacher's 20, including rubric totals and provenance", () => {
  const original = exam(
    Array.from({ length: 25 }, (_, index) => question(String(index + 1))),
    20,
  );
  const normalized = normalizeExamMarks(original, 20);
  assert.equal(normalized.totalMarks, 20);
  assert.deepEqual(
    normalized.questions.map((current) => current.maxMarks),
    Array(25).fill(0.8),
  );
  assert.equal(
    roundMarks(
      normalized.questions.reduce((sum, current) => sum + current.maxMarks, 0),
    ),
    20,
  );
  assert.equal(normalized.questions[0].rubric[0].marks, 0.8);
  assert.equal(normalized.marksNormalization?.originalTotalMarks, 25);
  assert.equal(normalized.marksNormalization?.questions[0].originalMaxMarks, 1);
  assert.equal(normalized.approval, undefined);
  assert.equal(original.questions[0].maxMarks, 1);
  assertExamMarks(normalized);
});

test("mark allocation distributes rounding deterministically and never creates a zero criterion", () => {
  assert.deepEqual(allocateMarks([1, 1, 1], 20), [6.67, 6.67, 6.66]);
  assert.deepEqual(allocateMarks([1, 1, 1], 0.8), [0.27, 0.27, 0.26]);
  const tiny = allocateMarks([1e-20, 1e-20, 100], 1);
  assert.deepEqual(tiny, [0.01, 0.01, 0.98]);
  for (const target of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.001]) {
    assert.throws(() => allocateMarks([1], target));
  }
  assert.throws(() => allocateMarks([1, 1], 0.01), /at least 0.01/);
  assert.throws(() => allocateMarks([0, 1], 10), /positive finite/);
});

test("approval/grading gate rejects total, rubric, duplicate ID, and finite-positive violations", () => {
  assert.throws(() => assertExamMarks(exam(undefined, 20)), /exam total is 20/);
  const brokenRubric = exam();
  brokenRubric.questions[0].rubric[0].marks = 0.5;
  assert.throws(() => assertExamMarks(brokenRubric), /rubric totals/);
  const duplicate = exam([question("1"), question("1")]);
  assert.throws(() => assertExamMarks(duplicate), /unique/);
  const duplicateCriterion = exam([question("1", 2)]);
  duplicateCriterion.questions[0].rubric = [
    question("1").rubric[0],
    question("1").rubric[0],
  ];
  assert.throws(() => assertExamMarks(duplicateCriterion), /criterion IDs/);
  const infinite = exam([question("1", Infinity)]);
  assert.throws(() => assertExamMarks(infinite), /positive finite/);
  assert.throws(() => assertExamMarks(exam([], 1)), /at least one question/);
  assert.throws(
    () => assertExamMarks(exam([question("1", 0.666)])),
    /two decimal places/,
  );
  const excessPrecision = exam([question("1", 1)]);
  excessPrecision.questions[0].rubric = [
    { id: "a", concept: "First", marks: 0.666 },
    { id: "b", concept: "Second", marks: 0.334 },
  ];
  assert.throws(() => assertExamMarks(excessPrecision), /two decimal places/);
  assertExamMarks(normalizeExamMarks(excessPrecision, 1));
});

test("schemas reject invalid persisted mark values while allowing draft mismatches", () => {
  assert.equal(examConfigSchema.safeParse(exam(undefined, 20)).success, true);
  assert.equal(examConfigSchema.safeParse(exam(undefined, -1)).success, false);
  assert.equal(
    examConfigSchema.safeParse(exam([question("1", 0)])).success,
    false,
  );
  const invalidCriterion = exam();
  invalidCriterion.questions[0].rubric[0].marks = Infinity;
  assert.equal(examConfigSchema.safeParse(invalidCriterion).success, false);
});

test("rubric generation preserves a normalized 0.8 maximum and fixes duplicate criterion IDs without API calls", async () => {
  const registry = {
    call: async () => ({
      text: JSON.stringify({
        criteria: [
          { id: "duplicate", concept: "First", marks: 1 },
          { id: "duplicate", concept: "Second", marks: 1 },
          { id: "duplicate::2", concept: "Third", marks: 1 },
        ],
      }),
    }),
  } as unknown as ProviderRegistry;
  const rubric = await generateRubric(
    { id: "1", prompt: "Explain", maxMarks: 0.8 },
    registry,
  );
  assert.equal(new Set(rubric.map((criterion) => criterion.id)).size, 3);
  assert.deepEqual(
    rubric.map((criterion) => criterion.marks),
    [0.27, 0.27, 0.26],
  );
});

test("merge keeps paper order, labels, identities and marks, and invalidates teacher confirmation", () => {
  const original = exam();
  const merged = mergeExamQuestions(original, {
    questionIds: ["1(b)", "1(a)"],
    id: "Q1",
  });
  const first = merged.questions[0];
  assert.deepEqual(
    merged.questions.map((current) => current.id),
    ["Q1", "2"],
  );
  assert.equal(first.maxMarks, 2);
  assert.deepEqual(first.sourceQuestionIds, ["1(a)", "1(b)"]);
  assert.match(first.prompt, /^\[1\(a\)\]\nPrompt for 1\(a\)/);
  assert.match(first.modelAnswer!, /\[1\(b\)\]\nAnswer for 1\(b\)/);
  assert.equal(new Set(first.rubric.map((criterion) => criterion.id)).size, 2);
  assert.deepEqual(
    first.rubric.map((criterion) => criterion.sourceQuestionId),
    ["1(a)", "1(b)"],
  );
  assert.equal(first.rubric[0].sourceCriterionId, "criterion");
  assert.deepEqual(first.rubric[0].acceptable, ["alternative"]);
  assert.equal(first.tags?.confirmedByTeacher, false);
  assert.equal(merged.approval, undefined);
  assert.equal(merged.totalMarks, original.totalMarks);
  assert.equal(original.questions.length, 3);
  assertExamMarks(merged);
});

test("merge with explicit maximum scales all criteria but preserves teacher total for draft repair", () => {
  const merged = mergeExamQuestions(exam(), {
    questionIds: ["1(a)", "1(b)"],
    id: "1",
    maxMarks: 1.5,
  });
  assert.deepEqual(
    merged.questions[0].rubric.map((criterion) => criterion.marks),
    [0.75, 0.75],
  );
  assert.equal(merged.totalMarks, 5);
  assert.throws(() => assertExamMarks(merged), /Question marks total/);
  assertExamMarks(normalizeExamMarks(merged, 5));
});

test("nested merging retains all old paper aliases and original criterion provenance", () => {
  const original = exam([
    question("5(i)(a)"),
    question("5(i)(b)"),
    question("5(ii)"),
  ]);
  const first = mergeExamQuestions(original, {
    questionIds: ["5(i)(a)", "5(i)(b)"],
    id: "5(i)",
  });
  const final = mergeExamQuestions(first, {
    questionIds: ["5(i)", "5(ii)"],
    id: "5",
  });
  assert.deepEqual(final.questions[0].sourceQuestionIds, [
    "5(i)",
    "5(i)(a)",
    "5(i)(b)",
    "5(ii)",
  ]);
  assert.equal(final.questions[0].rubric[0].sourceQuestionId, "5(i)(a)");
  assert.equal(final.questions[0].rubric[0].sourceCriterionId, "criterion");
  assertExamMarks(final);
});

test("merge rejects unrelated parts, duplicate selection, missing IDs, parent collision and incomplete rubrics", () => {
  const original = exam([
    question("1(a)"),
    question("1(b)"),
    question("2(a)"),
    question("1"),
  ]);
  for (const input of [
    { questionIds: ["1(a)", "2(a)"], id: "1" },
    { questionIds: ["1(a)", "1(a)"], id: "1" },
    { questionIds: ["1(a)", "missing"], id: "1" },
    { questionIds: ["1(a)", "1(b)"], id: "2" },
    { questionIds: ["1(a)", "1(b)"], id: "Q1" },
  ])
    assert.throws(() => mergeExamQuestions(original, input));
  const missing = exam();
  missing.questions[0].rubric = [];
  assert.throws(
    () =>
      mergeExamQuestions(missing, { questionIds: ["1(a)", "1(b)"], id: "1" }),
    /Complete the rubric/,
  );
});

test("canonical question labels support prefixes and nested paper separators", () => {
  for (const label of ["Q5(i)(a)", "5.i.a", "5-i-a", "Question 5 (i) (a)"]) {
    assert.deepEqual(questionIdParts(label), ["5", "i", "a"]);
  }
  assert.deepEqual(questionIdParts("5i)"), ["5", "i"]);
  assert.deepEqual(questionIdParts("1."), ["1"]);
  assert.equal(questionIdParts("Ans a"), null);
});

test("store permits draft corrections, scales edited marks, and blocks reapproval until totals match", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "exam-marks-test-"),
  );
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ExamStore(directory);
  const saved = await store.save(exam());
  const edited = await store.updateQuestion(saved.id!, "1(a)", { maxMarks: 2 });
  assert.equal(edited?.approval, undefined);
  assert.equal(edited?.questions[0].rubric[0].marks, 2);
  assert.equal(edited?.totalMarks, 5);
  const rejected = await store.approve(saved.id!, "teacher");
  assert.equal(rejected.ok, false);
  assert.match(!rejected.ok ? rejected.error : "", /Question marks total/);
  const repaired = await store.normalizeMarks(saved.id!, 5);
  assertExamMarks(repaired!);
  assert.equal((await store.approve(saved.id!, "teacher")).ok, true);
  const changedPrompt = await store.updateQuestion(saved.id!, "1(a)", {
    prompt: "A new question",
  });
  assert.equal(changedPrompt?.approval, undefined);
  await assert.rejects(
    store.updateQuestion(saved.id!, "1(a)", { maxMarks: -1 }),
  );
});

test("whole-exam writes cannot inject approval or preserve it across content edits", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "exam-approval-test-"),
  );
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ExamStore(directory);
  const saved = await store.save(exam());
  assert.ok(
    (await store.update(saved.id!, { title: saved.title }))?.approval
      ?.approvedAt,
  );
  const changed = await store.update(saved.id!, {
    title: "Revised",
    approval: saved.approval,
  });
  assert.equal(changed?.approval, undefined);
  assert.equal(
    (await store.update(saved.id!, { approval: saved.approval }))?.approval,
    undefined,
  );
});

test("HTTP merge and normalization endpoints return persisted exams and enforce mark gates", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "exam-routes-test-"),
  );
  const store = new ExamStore(directory);
  const saved = await store.save(exam());
  const app = express();
  app.use(express.json());
  app.use(
    "/exam",
    examRoutes({
      uploadDir: directory,
      outputDir: directory,
      storeDir: directory,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  context.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await fs.rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/exam/${saved.id}`;
  const post = (suffix: string, body: unknown) =>
    fetch(base + suffix, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const mergedResponse = await post("/merge-questions", {
    questionIds: ["1(a)", "1(b)"],
    id: "1",
    maxMarks: 1,
  });
  assert.equal(mergedResponse.status, 200);
  const merged = ((await mergedResponse.json()) as { exam: ExamConfig }).exam;
  assert.equal(merged.questions[0].maxMarks, 1);
  assert.equal(merged.approval, undefined);
  assert.equal((await post("/approve", {})).status, 409);
  assert.equal(
    (await post("/normalize-marks", { totalMarks: -1 })).status,
    400,
  );
  const normalizedResponse = await post("/normalize-marks", { totalMarks: 5 });
  assert.equal(normalizedResponse.status, 200);
  const normalized = ((await normalizedResponse.json()) as { exam: ExamConfig })
    .exam;
  assertExamMarks(normalized);
  assert.equal((await store.get(saved.id!))?.totalMarks, 5);
  const patchResponse = await fetch(`${base}/questions/1`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tags: { ...normalized.questions[0].tags, confirmedByTeacher: true },
    }),
  });
  assert.equal(patchResponse.status, 200);
  assert.equal((await post("/approve", {})).status, 200);
});
