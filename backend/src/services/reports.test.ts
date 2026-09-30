import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { Server } from "node:http";
import type {
  ExamConfig,
  PipelineResult,
  QuestionGrading,
  SemanticAnswer,
  TestHistoryEntry,
} from "../types.js";
import { reportRoutes } from "../routes/reports.route.js";
import { buildAnalytics } from "./analytics.js";
import { roundMarks } from "./exam-marks.js";
import { ExamStore } from "./exam-store.js";
import { HistoryStore } from "./history-store.js";
import { StudentStore } from "./student-store.js";
import {
  buildClassMatrix,
  buildClassReport,
  buildStudentReport,
  loadExamRuns,
} from "./reports.js";

function exam(maxMarks: number): ExamConfig {
  return {
    id: "exam",
    title: "Particles",
    subject: "chemistry",
    class: "9",
    totalMarks: maxMarks,
    questions: [
      {
        id: "1",
        prompt: "Name the particle",
        maxMarks,
        rubric: [{ id: "c1", concept: "Proton", marks: maxMarks }],
        tags: {
          chapter: "Atoms",
          topics: ["Particles"],
          difficulty: "easy",
          confirmedByTeacher: true,
        },
      },
    ],
  };
}

function run(
  cfg: ExamConfig,
  suffix: string,
  studentId: string | undefined,
  awarded: number,
  releasedAt: string | undefined = "2026-09-23T10:00:00Z",
  createdAt = "2026-09-23T09:00:00Z",
): PipelineResult {
  const grading: QuestionGrading[] = cfg.questions.map((q) => {
    const semantic: SemanticAnswer = {
      questionId: q.id,
      answerBlockIds: [],
      conceptsDetected: [],
      equations: [],
      steps: [],
      diagrams: [],
      uncertainText: [],
      rawTranscript: "Proton",
    };
    const rubricEvaluation = q.rubric.map((c) => ({
      criterionId: c.id,
      concept: c.concept,
      marksAvailable: c.marks,
      marksAwarded: roundMarks((awarded * c.marks) / cfg.totalMarks),
      status:
        awarded === cfg.totalMarks
          ? ("correct" as const)
          : ("partial" as const),
      confidence: 0.99,
    }));
    const awardedMarks = roundMarks(
      rubricEvaluation.reduce((sum, e) => sum + e.marksAwarded, 0),
    );
    return {
      questionId: q.id,
      answerBlockIds: [],
      maxMarks: q.maxMarks,
      awardedMarks,
      rubricEvaluation,
      graderA: {
        grader: "A",
        rubricEvaluation,
        awardedMarks,
        gradingConfidence: 0.99,
      },
      systemConfidence: 0.99,
      route: "auto_accept",
      needsTeacherReview: false,
      semantic,
    };
  });
  return {
    runId: `${cfg.id}--${suffix}`,
    createdAt,
    examId: cfg.id,
    studentId,
    release: releasedAt ? { releasedAt } : undefined,
    exam: cfg,
    quality: [],
    pages: [],
    blocks: [],
    mapping: {},
    grading,
    annotations: [],
    analytics: buildAnalytics(grading),
    outputs: {
      originalPdf: "",
      evaluationJson: "",
      evaluatedPdf: "",
      annotatedPagePaths: [],
    },
  };
}

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "copy-check-report-test-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "output");
  await fs.mkdir(outputDir);
  const examStore = new ExamStore(path.join(root, "exams"));
  const studentStore = new StudentStore(path.join(root, "students"));
  const historyStore = new HistoryStore(path.join(root, "history"));
  const writeRun = async (doc: PipelineResult) => {
    const dir = path.join(outputDir, doc.runId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "evaluation.json"), JSON.stringify(doc));
  };
  return { outputDir, examStore, studentStore, historyStore, writeRun };
}

test("latest released regrade replaces its student once; creation time breaks release ties", async (t) => {
  const f = await fixture(t);
  const cfg = exam(20);
  const old = run(cfg, "s1-original", "s1", 4, "2026-09-23T10:00:00Z");
  const replacement = run(cfg, "s1-regrade", "s1", 15, "2026-09-23T11:00:00Z");
  const tieWinner = run(
    cfg,
    "s1-regrade-later",
    "s1",
    16,
    "2026-09-23T11:00:00Z",
    "2026-09-23T10:30:00Z",
  );
  const unreleased = run(cfg, "s1-unreleased", "s1", 20);
  unreleased.release = undefined;
  await Promise.all(
    [old, replacement, tieWinner, unreleased, run(cfg, "s2", "s2", 10)].map(
      f.writeRun,
    ),
  );
  const runs = await loadExamRuns(f.outputDir, cfg.id!, cfg);
  assert.deepEqual(runs.map((r) => r.runId).sort(), [
    "exam--s1-regrade-later",
    "exam--s2",
  ]);
  const report = await buildClassReport(
    cfg,
    f.outputDir,
    f.studentStore,
    f.historyStore,
  );
  assert.equal(report.studentsAppeared, 2);
  assert.equal(report.average, 13);
  const matrix = await buildClassMatrix(
    cfg,
    f.outputDir,
    f.studentStore,
    f.historyStore,
  );
  assert.equal(matrix.rows.length, 2);
  assert.equal(matrix.rows[0].total, 16);
});

test("anonymous released runs remain distinct", async (t) => {
  const f = await fixture(t);
  const cfg = exam(20);
  await Promise.all(
    [run(cfg, "anon1", undefined, 5), run(cfg, "anon2", undefined, 6)].map(
      f.writeRun,
    ),
  );
  assert.equal((await loadExamRuns(f.outputDir, cfg.id!, cfg)).length, 2);
});

test("allocation filtering excludes prior scales, merged questions and changed rubric weights", async (t) => {
  const f = await fixture(t);
  const cfg = exam(1);
  cfg.questions[0].rubric = [
    { id: "a", concept: "A", marks: 0.67 },
    { id: "b", concept: "B", marks: 0.33 },
  ];
  const reordered = structuredClone(cfg);
  reordered.questions[0].rubric.reverse();
  const changedRubric = structuredClone(cfg);
  changedRubric.questions[0].rubric[0].marks = 0.5;
  changedRubric.questions[0].rubric[1].marks = 0.5;
  const changedQuestion = structuredClone(cfg);
  changedQuestion.questions[0].id = "1(a)";
  await Promise.all(
    [
      run(cfg, "compatible", "s1", 1),
      run(reordered, "reordered", "s2", 1),
      run(exam(2), "old-scale", "s3", 2),
      run(changedRubric, "old-rubric", "s4", 1),
      run(changedQuestion, "old-parts", "s5", 1),
    ].map(f.writeRun),
  );
  assert.deepEqual(
    (await loadExamRuns(f.outputDir, cfg.id!, cfg)).map((r) => r.runId).sort(),
    ["exam--compatible", "exam--reordered"],
  );
  assert.equal((await loadExamRuns(f.outputDir, cfg.id!)).length, 5);
});

test("historical report uses evaluated denominator and questions after saved exam normalization", async (t) => {
  const f = await fixture(t);
  const old = run(exam(25), "old", "s1", 6);
  // Reproduce the original mismatch: teacher requested 20, extracted scheme had 25.
  old.exam = { ...old.exam, totalMarks: 20 };
  const current = exam(20);
  current.questions[0].id = "merged";
  await f.writeRun(old);
  const report = await buildStudentReport(
    old,
    current,
    f.outputDir,
    f.studentStore,
    f.historyStore,
  );
  assert.equal(report.exam.maxMarks, 25);
  assert.equal(report.awardedMarks, 6);
  assert.equal(report.percentage, 24);
  assert.equal(report.topicPerformance[0].max, 25);
  assert.equal(report.lostMarks[0].questionId, "1");
  assert.equal(report.classSize, 1);
  assert.equal(
    (
      await buildClassReport(
        current,
        f.outputDir,
        f.studentStore,
        f.historyStore,
      )
    ).studentsAppeared,
    0,
  );
});

for (const marks of [0.01, 0.67]) {
  test(`full ${marks} marks retain topic denominators and accurate class percentages`, async (t) => {
    const f = await fixture(t);
    const cfg = exam(marks);
    const doc = run(cfg, "full", "s1", marks);
    await f.writeRun(doc);
    const report = await buildStudentReport(
      doc,
      cfg,
      f.outputDir,
      f.studentStore,
      f.historyStore,
    );
    assert.equal(report.classAverage, marks);
    assert.equal(report.classAveragePct, 100);
    assert.equal(report.percentage, 100);
    assert.equal(report.topicPerformance[0].max, marks);
    assert.equal(report.topicPerformance[0].awarded, marks);
    const classReport = await buildClassReport(
      cfg,
      f.outputDir,
      f.studentStore,
      f.historyStore,
    );
    assert.equal(classReport.average, marks);
    assert.equal(classReport.topicCoverage[0].marksAvailable, marks);
  });
}

test("fractional scores around ten-mark boundaries belong to exactly one band", async (t) => {
  const f = await fixture(t);
  const cfg = exam(30);
  const scores = [10, 10.01, 10.67, 20, 20.01];
  await Promise.all(
    scores.map((score, i) => f.writeRun(run(cfg, `s${i}`, `s${i}`, score))),
  );
  const report = await buildClassReport(
    cfg,
    f.outputDir,
    f.studentStore,
    f.historyStore,
  );
  assert.deepEqual(
    report.bandCounts.map((b) => b.count),
    [1, 3, 1],
  );
  assert.equal(
    report.bandCounts.reduce((sum, b) => sum + b.count, 0),
    scores.length,
  );
});

test("tiny questions shared across multiple topics retain positive denominators", async (t) => {
  const f = await fixture(t);
  const cfg = exam(0.01);
  cfg.questions[0].tags!.topics = ["A", "B", "C"];
  const doc = run(cfg, "tiny-topics", "s1", 0.01);
  await f.writeRun(doc);
  const report = await buildStudentReport(
    doc,
    cfg,
    f.outputDir,
    f.studentStore,
    f.historyStore,
  );
  assert.equal(report.topicPerformance.length, 3);
  for (const topic of report.topicPerformance) {
    assert.ok(topic.max > 0);
    assert.equal(topic.awarded, topic.max);
    assert.equal(topic.read, "strong");
  }
});

test("history excludes the current exam, deduplicates earlier tests and ignores future releases", async (t) => {
  const f = await fixture(t);
  const cfg = exam(20);
  const doc = run(cfg, "current", "s1", 15);
  await f.writeRun(doc);
  const entries = [
    {
      runId: "prior-original",
      examId: "prior",
      percentage: 20,
      releasedAt: "2026-09-23T08:00:00Z",
    },
    {
      runId: "prior-regrade",
      examId: "prior",
      percentage: 60,
      releasedAt: "2026-09-23T09:00:00Z",
    },
    {
      runId: "current-original",
      examId: "exam",
      percentage: 50,
      releasedAt: "2026-09-23T09:30:00Z",
    },
    {
      runId: "prior-future-regrade",
      examId: "prior",
      percentage: 90,
      releasedAt: "2026-09-23T11:00:00Z",
    },
    {
      runId: "future-test",
      examId: "future",
      percentage: 100,
      releasedAt: "2026-09-23T12:00:00Z",
    },
  ];
  for (const entry of entries) {
    const history: TestHistoryEntry = {
      ...entry,
      examTitle: entry.examId,
      subject: "chemistry",
      class: "9",
      awardedMarks: entry.percentage / 5,
      maxMarks: 20,
    };
    await f.historyStore.append("s1", history);
  }
  const report = await buildStudentReport(
    doc,
    cfg,
    f.outputDir,
    f.studentStore,
    f.historyStore,
  );
  assert.equal(report.averageBeforePct, 60);
  assert.equal(report.sinceLastTestMarks, 3);
  assert.equal(report.sinceLastTestPct, 15);
  assert.equal(report.lastThreeTests.length, 2);
  assert.equal(report.lastThreeTests[0].pct, 60);
  const matrix = await buildClassMatrix(
    cfg,
    f.outputDir,
    f.studentStore,
    f.historyStore,
  );
  assert.equal(matrix.rows[0].vsLast, 3);
});

test("HTTP individual report keeps history and student list uses compatible latest releases", async (t) => {
  const f = await fixture(t);
  const old = run(exam(25), "s1-old", "s1", 10);
  const current = exam(20);
  const replacement = run(current, "s1-new", "s1", 15, "2026-09-23T11:00:00Z");
  await Promise.all([f.writeRun(old), f.writeRun(replacement)]);
  await f.examStore.save(current);
  const app = express();
  app.use(reportRoutes(f));
  const server: Server = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const historicalResponse = await fetch(`${base}/run/${old.runId}/report`);
  assert.equal(historicalResponse.status, 200);
  const historical = await historicalResponse.json();
  assert.equal(historical.report.exam.maxMarks, 25);
  assert.equal(historical.report.percentage, 40);
  const response = await fetch(`${base}/exam/exam/students`);
  assert.equal(response.status, 200);
  const list = await response.json();
  assert.equal(list.students.length, 1);
  assert.equal(list.students[0].runId, replacement.runId);
  assert.equal(list.students[0].totalMax, 20);
});

test("report correctness is full-credit students; syllabus and recommendations avoid invented facts", async (t) => {
  const f = await fixture(t);
  const cfg = exam(2);
  const partial = run(cfg, "partial", "s1", 1);
  await Promise.all([
    f.writeRun(partial),
    f.writeRun(run(cfg, "full", "s2", 2)),
  ]);
  const report = await buildClassReport(
    cfg,
    f.outputDir,
    f.studentStore,
    f.historyStore,
  );
  assert.equal(report.questionSummary[0].classCorrectPct, 50);
  assert.equal(report.questionSummary[0].marksEarnedPct, 75);
  assert.equal(report.questionSummary[0].fullMarksCount, 1);
  assert.equal(report.syllabusCoveredPct, null);
  const student = await buildStudentReport(
    partial,
    cfg,
    f.outputDir,
    f.studentStore,
    f.historyStore,
  );
  assert.doesNotMatch(
    JSON.stringify(student.nextActions),
    /assigned|unlocked|generated/i,
  );
});

test("mark loss reasons weight marks instead of counting rubric criteria", async (t) => {
  const f = await fixture(t);
  const cfg = exam(5);
  cfg.questions[0].rubric = [
    { id: "a", concept: "Method", marks: 4 },
    { id: "b", concept: "Units", marks: 1 },
  ];
  const doc = run(cfg, "losses", "s1", 0);
  doc.grading[0].rubricEvaluation[0].mistakeTag = "concept_gap";
  doc.grading[0].rubricEvaluation[1].mistakeTag = "careless";
  await f.writeRun(doc);
  const report = await buildClassReport(
    cfg,
    f.outputDir,
    f.studentStore,
    f.historyStore,
  );
  assert.deepEqual(report.markLossReasons, [
    { reason: "concept_gap", percentage: 80 },
    { reason: "careless", percentage: 20 },
  ]);
});

test("student report and acknowledgment are release-gated; teacher navigation includes latest pending runs", async (t) => {
  const f = await fixture(t);
  const cfg = exam(20);
  await f.examStore.save(cfg);
  const released = run(cfg, "s1-released", "s1", 15);
  const pending = run(
    cfg,
    "s1-pending",
    "s1",
    18,
    undefined,
    "2026-09-23T12:00:00Z",
  );
  pending.release = undefined;
  await Promise.all([f.writeRun(released), f.writeRun(pending)]);
  const app = express();
  app.use(express.json());
  app.use(reportRoutes(f));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal(
    (await fetch(`${base}/run/${pending.runId}/report`)).status,
    200,
  );
  assert.equal(
    (await fetch(`${base}/run/${pending.runId}/student-report`)).status,
    409,
  );
  assert.equal(
    (
      await fetch(`${base}/run/${pending.runId}/acknowledge`, {
        method: "POST",
      })
    ).status,
    409,
  );
  const list = await (
    await fetch(`${base}/exam/exam/students?includeUnreleased=1`)
  ).json();
  assert.equal(list.students.length, 1);
  assert.equal(list.students[0].runId, pending.runId);
  const ack = await fetch(`${base}/run/${released.runId}/acknowledge`, {
    method: "POST",
  });
  assert.equal(ack.status, 200);
  const acknowledged = await ack.json();
  assert.ok(acknowledged.acknowledgment.acknowledgedAt);
  const secondAck = await (
    await fetch(`${base}/run/${released.runId}/acknowledge`, { method: "POST" })
  ).json();
  assert.equal(
    secondAck.acknowledgment.acknowledgedAt,
    acknowledged.acknowledgment.acknowledgedAt,
  );
  const studentReport = await (
    await fetch(`${base}/run/${released.runId}/student-report`)
  ).json();
  assert.deepEqual(
    studentReport.report.acknowledgment,
    acknowledged.acknowledgment,
  );
  const saved = await fetch(`${base}/run/${released.runId}/metadata`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ teacherRemark: "Show your working." }),
  });
  assert.equal(saved.status, 200);
  const updated = await (
    await fetch(`${base}/run/${released.runId}/report`)
  ).json();
  assert.equal(updated.report.teacherRemark, "Show your working.");
  assert.equal(updated.report.acknowledgment, undefined);
});

test("students without history sort after known drops, then by lowest score", async (t) => {
  const f = await fixture(t);
  const cfg = exam(20);
  await Promise.all(
    [
      run(cfg, "drop", "drop", 3),
      run(cfg, "new-high", "new-high", 4),
      run(cfg, "new-low", "new-low", 1),
      run(cfg, "top", "top", 20),
    ].map(f.writeRun),
  );
  await f.historyStore.append("drop", {
    runId: "previous--drop",
    examId: "previous",
    examTitle: "Previous test",
    subject: cfg.subject,
    class: cfg.class,
    awardedMarks: 10,
    maxMarks: 20,
    percentage: 50,
    releasedAt: "2026-09-22T10:00:00Z",
  });
  const report = await buildClassReport(
    cfg,
    f.outputDir,
    f.studentStore,
    f.historyStore,
  );
  assert.deepEqual(
    report.studentsToLookAtFirst.map((s) => s.studentId),
    ["drop", "new-low", "new-high"],
  );
  assert.deepEqual(
    report.studentsToLookAtFirst.map((s) => s.deltaVsLast),
    [-7, null, null],
  );
});
