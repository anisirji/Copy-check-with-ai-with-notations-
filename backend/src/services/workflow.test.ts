import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import type {
  EvaluationRules,
  ExamConfig,
  PipelineResult,
  QuestionGrading,
} from "../types.js";
import { ExamStore } from "./exam-store.js";
import { examRoutes } from "../routes/exam.route.js";
import { applyGradingPatch } from "./grading-edit.js";
import { buildAnalytics } from "./analytics.js";
import { applyEvaluationRouting } from "./pipeline.js";
import { buildGraderPrompt, runGrader } from "./grader.js";
import type { ProviderRegistry } from "../providers/index.js";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { saveGradingRevision } from "./grading-artifacts.js";

const rules: EvaluationRules = {
  mode: "review",
  partialCredit: true,
  carryForward: true,
  unitPenalty: "half",
  flagUncertain: true,
  confirmed: false,
};
function exam(): ExamConfig {
  return {
    id: "workflow",
    title: "Atoms",
    class: "9",
    subject: "chemistry",
    totalMarks: 2,
    evaluationRules: { ...rules },
    questions: [
      {
        id: "1",
        prompt: "Explain an atom",
        maxMarks: 2,
        tags: {
          chapter: "Matter",
          topics: ["Atoms"],
          difficulty: "medium",
          confirmedByTeacher: true,
        },
        rubric: [
          { id: "a", concept: "Nucleus", marks: 1 },
          { id: "b", concept: "Electrons", marks: 1 },
        ],
      },
    ],
  };
}
function run(): PipelineResult {
  const cfg = exam();
  const rubricEvaluation = cfg.questions[0].rubric.map((c) => ({
    criterionId: c.id,
    concept: c.concept,
    marksAvailable: c.marks,
    marksAwarded: 0,
    status: "missing" as const,
    confidence: 0.6,
    mistakeTag: "left_blank" as const,
  }));
  const grading: QuestionGrading[] = [
    {
      questionId: "1",
      answerBlockIds: ["b1"],
      maxMarks: 2,
      awardedMarks: 0,
      rubricEvaluation,
      graderA: {
        grader: "A",
        rubricEvaluation,
        awardedMarks: 0,
        gradingConfidence: 0.6,
      },
      systemConfidence: 0.6,
      route: "teacher_review",
      needsTeacherReview: true,
      semantic: {
        questionId: "1",
        answerBlockIds: ["b1"],
        conceptsDetected: [],
        equations: [],
        steps: [],
        diagrams: [],
        uncertainText: [],
        rawTranscript: "An atom has a nucleus.",
      },
    },
  ];
  return {
    runId: "workflow--student",
    createdAt: new Date().toISOString(),
    exam: cfg,
    grading,
    quality: [],
    pages: [],
    blocks: [
      {
        id: "b1",
        type: "text",
        text: "An atom has a nucleus.",
        page: 1,
        bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.06 },
      },
    ],
    mapping: { "1": ["b1"] },
    annotations: [],
    analytics: buildAnalytics(grading),
    outputs: {
      originalPdf: "",
      evaluatedPdf: "",
      evaluationJson: "",
      annotatedPagePaths: [],
    },
  };
}

test("evaluation rules and each question are approved before overall scheme; edits invalidate approval", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "copy-workflow-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ExamStore(directory);
  const saved = await store.save(exam());
  assert.equal((await store.approve(saved.id!, "teacher")).ok, false);
  await store.updateRules(saved.id!, { ...rules, confirmed: true });
  assert.equal((await store.approve(saved.id!, "teacher")).ok, false);
  await store.updateQuestion(saved.id!, "1", { schemeApproved: true });
  assert.equal((await store.approve(saved.id!, "teacher")).ok, true);
  const edited = await store.updateQuestion(saved.id!, "1", {
    modelAnswer: "The nucleus contains protons.",
  });
  assert.equal(edited?.questions[0].schemeApproved, false);
  assert.equal(edited?.approval, undefined);
  await store.updateQuestion(saved.id!, "1", {
    modelAnswer: "Protons and neutrons are in the nucleus.",
    schemeApproved: true,
  });
  assert.equal((await store.approve(saved.id!, "teacher")).ok, true);
  const changedRules = await store.updateRules(saved.id!, {
    ...rules,
    partialCredit: false,
    confirmed: true,
  });
  assert.equal(changedRules?.approval, undefined);
});

test("invalid combined question edit and approval is atomic", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "copy-workflow-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ExamStore(directory);
  await store.save(exam());
  await assert.rejects(
    store.updateQuestion("workflow", "1", { rubric: [], schemeApproved: true }),
  );
  assert.equal((await store.get("workflow"))?.questions[0].rubric.length, 2);
});

test("source PDF attachment survives temporary upload removal and leaves approval intact", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "copy-paper-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ExamStore(directory);
  await store.save({ ...exam(), approval: { approvedAt: "2026-09-23" } });
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
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/exam/workflow`;
  const form = new FormData();
  const pdf = "%PDF-1.7\nreference paper";
  form.append(
    "paper",
    new Blob([pdf], { type: "application/pdf" }),
    "Question paper.pdf",
  );
  const uploaded = await fetch(`${base}/paper`, { method: "PUT", body: form });
  assert.equal(uploaded.status, 200);
  const payload = await uploaded.json();
  assert.equal(payload.exam.paper.fileName, "Question paper.pdf");
  assert.equal(payload.exam.approval.approvedAt, "2026-09-23");
  const response = await fetch(`${base}/paper`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), pdf);
  assert.throws(() => store.paperPath("../../outside"), /Invalid/);
});

test("atomic grading edits refresh analytics, clear stale blank tags and preserve model audit", () => {
  const original = run();
  const { result, grading } = applyGradingPatch(original, {
    questionId: "1",
    edits: [
      { criterionId: "a", marksAwarded: 1, status: "missing" },
      { criterionId: "b", marksAwarded: 0.5, status: "missing" },
    ],
    approve: true,
    comment: "Explain the role of electrons.",
  });
  assert.equal(grading.awardedMarks, 1.5);
  assert.deepEqual(
    grading.rubricEvaluation.map((c) => [c.status, c.mistakeTag]),
    [
      ["correct", undefined],
      ["partial", "incomplete"],
    ],
  );
  assert.equal(result.analytics.totalAwarded, 1.5);
  assert.equal(result.analytics.perQuestion[0].awarded, 1.5);
  assert.equal(result.analytics.routeCounts.teacher_review, 0);
  assert.equal(result.analytics.weakConcepts.length, 0);
  assert.equal(grading.graderA.rubricEvaluation[0].marksAwarded, 0);
  assert.equal(original.grading[0].awardedMarks, 0);
  assert.equal(result.overrideHistory?.[0].previous.awardedMarks, 0);
  assert.ok(
    result.annotations.some(
      (a) => a.type === "comment_box" && a.text === grading.teacherComment,
    ),
  );
  assert.ok(
    result.annotations.some(
      (a) => a.type === "page_total" && a.text === "1.5/2",
    ),
  );
});

test("invalid grading batch leaves all criteria untouched", () => {
  const original = run();
  for (const marksAwarded of [-1, 2, Infinity, 0.123]) {
    assert.throws(() =>
      applyGradingPatch(original, {
        questionId: "1",
        edits: [
          { criterionId: "a", marksAwarded: 1 },
          { criterionId: "b", marksAwarded },
        ],
      }),
    );
    assert.equal(original.grading[0].rubricEvaluation[0].marksAwarded, 0);
  }
  assert.throws(() =>
    applyGradingPatch(original, {
      questionId: "1",
      edits: [{ criterionId: "missing", marksAwarded: 1 }],
    }),
  );
});

test("grading revisions refresh rendered PDFs and JSON while preserving original scans", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "copy-render-review-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const imagePath = path.join(directory, "source.png");
  await sharp({
    create: { width: 640, height: 900, channels: 3, background: "white" },
  })
    .png()
    .toFile(imagePath);
  const source = await fs.readFile(imagePath);
  const original = run();
  original.pages = [{ page: 1, width: 640, height: 900, imagePath }];
  const { result } = applyGradingPatch(original, {
    questionId: "1",
    edits: [{ criterionId: "a", marksAwarded: 1 }],
    comment: "Correct nucleus; explain electrons.",
  });
  const evaluationPath = path.join(directory, "evaluation.json");
  await saveGradingRevision(result, evaluationPath);
  const saved = JSON.parse(
    await fs.readFile(evaluationPath, "utf8"),
  ) as PipelineResult;
  assert.equal(saved.analytics.totalAwarded, 1);
  assert.equal(
    saved.grading[0].teacherComment,
    "Correct nucleus; explain electrons.",
  );
  const pdf = await PDFDocument.load(
    await fs.readFile(saved.outputs.evaluatedPdf),
  );
  assert.equal(pdf.getPageCount(), 1);
  assert.ok((await fs.stat(saved.outputs.annotatedPagePaths[0])).size > 0);
  assert.deepEqual(await fs.readFile(imagePath), source);
  assert.equal(
    (await fs.readdir(directory)).some((entry) => entry.startsWith(".review-")),
    false,
  );
});

test("assist and sample modes retain confidence flags and deterministically select reviews", () => {
  const grading = Array.from({ length: 20 }, (_, index) => ({
    ...structuredClone(run().grading[0]),
    questionId: String(index),
    route: "auto_accept" as const,
    needsTeacherReview: false,
  })) as QuestionGrading[];
  grading[4].semantic.uncertainText = ["unclear number"];
  grading[8].route = "teacher_review";
  grading[8].needsTeacherReview = true;
  applyEvaluationRouting(grading, { ...rules, mode: "sample" });
  assert.deepEqual(
    grading.flatMap((q, i) => (q.needsTeacherReview ? [i] : [])),
    [0, 4, 8, 10],
  );
  applyEvaluationRouting(grading, { ...rules, mode: "assist" });
  assert.ok(
    grading.every((q) => q.needsTeacherReview && q.route === "teacher_review"),
  );
});

test("teacher rules reach grader prompts and all-or-nothing criteria are enforced without provider calls", async () => {
  const cfg = exam();
  const semantic = run().grading[0].semantic;
  const prompt = buildGraderPrompt("A", cfg.questions[0], semantic, {
    ...rules,
    partialCredit: false,
  });
  assert.match(prompt, /each criterion is all-or-nothing/);
  assert.match(prompt, /do not repeatedly penalize/);
  assert.match(prompt, /0\.5 mark in total per question/);
  assert.match(prompt, /deduction once/);
  const registry = {
    call: async () => ({
      text: JSON.stringify({
        rubricEvaluation: [
          { criterionId: "a", marksAwarded: 0.5, status: "partial" },
          { criterionId: "b", marksAwarded: 1, status: "correct" },
        ],
      }),
      provider: "stub",
      model: "stub",
    }),
  } as unknown as ProviderRegistry;
  const result = await runGrader(
    "A",
    cfg.questions[0],
    semantic,
    [],
    [],
    registry,
    { rules: { ...rules, partialCredit: false } },
  );
  assert.equal(result.awardedMarks, 1);
  assert.deepEqual(
    result.rubricEvaluation.map((c) => c.status),
    ["incorrect", "correct"],
  );
  const consensus = run().grading;
  consensus[0].rubricEvaluation[0].marksAwarded = 0.5;
  consensus[0].rubricEvaluation[0].status = "partial";
  applyEvaluationRouting(consensus, { ...rules, partialCredit: false });
  assert.equal(consensus[0].awardedMarks, 0);
  assert.equal(consensus[0].needsTeacherReview, true);
});

test("blank-tag requests cannot override evidence of a written or partially credited answer", () => {
  const doc = run();
  const { grading } = applyGradingPatch(doc, {
    questionId: "1",
    edits: [
      { criterionId: "a", marksAwarded: 0, mistakeTag: "left_blank" },
      { criterionId: "b", marksAwarded: 0.5, mistakeTag: "left_blank" },
    ],
  });
  assert.deepEqual(
    grading.rubricEvaluation.map((c) => c.mistakeTag),
    ["concept_gap", "incomplete"],
  );
  doc.grading[0].semantic.rawTranscript = "";
  const blank = applyGradingPatch(doc, {
    questionId: "1",
    criterionId: "a",
    marksAwarded: 0,
    mistakeTag: "left_blank",
  });
  assert.equal(blank.grading.rubricEvaluation[0].mistakeTag, "left_blank");
});
