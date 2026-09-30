import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../app.js";
import { ExamStore } from "./exam-store.js";
import { HistoryStore } from "./history-store.js";
import { StudentStore } from "./student-store.js";
import {
  assertStorageId,
  evaluationPath,
  withFileLock,
  writeJsonAtomic,
} from "./file-store.js";
import { normalizeExamMarks } from "./exam-marks.js";
import { buildAnalytics } from "./analytics.js";
import type {
  ExamConfig,
  PipelineResult,
  QuestionGrading,
  TestHistoryEntry,
} from "../types.js";

function exam(): ExamConfig {
  return {
    id: "storage-exam",
    title: "Atoms",
    class: "8-A",
    subject: "Chemistry",
    totalMarks: 2,
    approval: { approvedAt: "2026-09-24T10:00:00Z" },
    questions: ["1(a)", "1(b)"].map((id) => ({
      id,
      prompt: "Name the particle",
      maxMarks: 1,
      rubric: [{ id: "c1", concept: "Proton", marks: 1 }],
      tags: {
        chapter: "Atoms",
        topics: ["Particles"],
        difficulty: "easy",
        confirmedByTeacher: true,
      },
    })),
  };
}
function run(runId = "storage-exam--student--run"): PipelineResult {
  const cfg = exam();
  const grading: QuestionGrading[] = cfg.questions.map((q) => {
    const rubricEvaluation = [
      {
        criterionId: "c1",
        concept: "Proton",
        marksAvailable: 1,
        marksAwarded: 0,
        status: "incorrect" as const,
        confidence: 1,
      },
    ];
    return {
      questionId: q.id,
      answerBlockIds: [],
      maxMarks: 1,
      awardedMarks: 0,
      rubricEvaluation,
      graderA: {
        grader: "A",
        rubricEvaluation,
        awardedMarks: 0,
        gradingConfidence: 1,
      },
      systemConfidence: 1,
      route: "auto_accept",
      needsTeacherReview: false,
      semantic: {
        questionId: q.id,
        answerBlockIds: [],
        conceptsDetected: [],
        equations: [],
        steps: [],
        diagrams: [],
        uncertainText: [],
        rawTranscript: "Proton",
      },
    };
  });
  return {
    runId,
    examId: cfg.id,
    studentId: "student",
    exam: cfg,
    createdAt: "2026-09-24T10:00:00Z",
    quality: [],
    pages: [],
    blocks: [],
    mapping: {},
    grading,
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
function entry(n: number): TestHistoryEntry {
  return {
    runId: `run-${n}`,
    examId: `exam-${n}`,
    examTitle: "Test",
    class: "8-A",
    subject: "Chemistry",
    awardedMarks: 1,
    maxMarks: 2,
    percentage: 50,
    releasedAt: `2026-09-24T10:00:${String(n).padStart(2, "0")}Z`,
  };
}
async function fixture(
  t: TestContext,
  renderRevision?: Parameters<typeof createApp>[0]["renderRevision"],
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "copy-review-"));
  const examStore = new ExamStore(path.join(root, "store/exams"));
  const historyStore = new HistoryStore(path.join(root, "store/history"));
  const studentStore = new StudentStore(path.join(root, "store/students"));
  let providerCalls = 0;
  const app = await createApp({
    rootDir: root,
    pipeline: async () => {
      providerCalls++;
      throw new Error("Unexpected grading call");
    },
    renderRevision:
      renderRevision ??
      (async (result, file) => {
        await writeJsonAtomic(file, result);
      }),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const writeRun = async (doc: PipelineResult) =>
    writeJsonAtomic(evaluationPath(path.join(root, "output"), doc.runId), doc);
  return {
    root,
    base,
    examStore,
    historyStore,
    studentStore,
    writeRun,
    providerCalls: () => providerCalls,
  };
}

test("storage IDs reject paths and dot segments, while paper question IDs remain unrestricted", async (t) => {
  const f = await fixture(t);
  for (const id of [
    "..",
    ".",
    "../outside",
    "/outside",
    "a/b",
    "a\\b",
    "%2e%2e",
    "a\0b",
    "",
    ".hidden",
  ]) {
    assert.throws(() => assertStorageId(id), /Invalid/);
    await assert.rejects(f.examStore.get(id), /Invalid/);
    await assert.rejects(f.examStore.save({ ...exam(), id }), /Invalid/);
    await assert.rejects(
      f.examStore.update(id, { title: "overwrite" }),
      /Invalid/,
    );
    await assert.rejects(f.historyStore.list(id), /Invalid/);
    await assert.rejects(f.historyStore.append(id, entry(1)), /Invalid/);
  }
  await f.examStore.save(exam());
  assert.equal(
    (
      await f.examStore.updateQuestion(exam().id!, "1(a)", {
        prompt: "Safe question edit",
      })
    )?.questions[0].prompt,
    "Safe question edit",
  );
  // Class labels are slugged, not interpolated as paths (already safe before this review).
  await f.studentStore.add("../../8 A", "Test student");
  assert.equal((await f.studentStore.list("../../8 A")).length, 1);
});

test("every run/exam HTTP endpoint rejects encoded traversal before reading, writing or grading", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside/evaluation.json");
  await writeJsonAtomic(outside, { secret: "unchanged" });
  const endpoints = [
    ["GET", "/run/ID"],
    ["GET", "/run/ID/student"],
    ["POST", "/run/ID/release"],
    ["PATCH", "/run/ID/grading"],
    ["PATCH", "/run/ID/metadata"],
    ["POST", "/run/ID/acknowledge"],
    ["GET", "/run/ID/report"],
    ["GET", "/run/ID/student-report"],
    ["POST", "/dev/regrade/ID"],
    ["GET", "/exam/ID"],
    ["PUT", "/exam/ID"],
    ["GET", "/exam/ID/paper"],
    ["PUT", "/exam/ID/paper"],
    ["GET", "/exam/ID/report"],
    ["GET", "/exam/ID/matrix"],
    ["GET", "/exam/ID/students"],
    ["PATCH", "/exam/ID/questions/1(a)"],
    ["PATCH", "/exam/ID/rules"],
    ["POST", "/exam/ID/approve"],
    ["POST", "/exam/ID/grade"],
    ["POST", "/exam/ID/normalize-marks"],
    ["POST", "/exam/ID/merge-questions"],
    ["POST", "/exam/ID/seed-class"],
    ["GET", "/output/ID/original.pdf"],
  ];
  for (const bad of ["..%2Foutside", "..%5Coutside", "%252e%252e"]) {
    for (const [method, endpoint] of endpoints) {
      const response = await fetch(f.base + endpoint.replace("ID", bad), {
        method,
      });
      assert.equal(response.status, 400, `${method} ${endpoint} ${bad}`);
    }
  }
  assert.deepEqual(JSON.parse(await fs.readFile(outside, "utf8")), {
    secret: "unchanged",
  });
  assert.equal(f.providerCalls(), 0);
});

test("static output exposes only supported media and never model audits, cached blocks, or linked outside files", async (t) => {
  const f = await fixture(t);
  const doc = run();
  await f.writeRun(doc);
  const dir = path.dirname(
    evaluationPath(path.join(f.root, "output"), doc.runId),
  );
  await fs.mkdir(path.join(dir, "pages"));
  await fs.writeFile(path.join(dir, "original.pdf"), "%PDF-1.7\nfixture");
  await fs.writeFile(path.join(dir, "pages/page-1.png"), "fixture image");
  for (const file of ["blocks.json", "verification.json", "secret.log"])
    await fs.writeFile(path.join(dir, file), "private");
  for (const file of [
    "evaluation.json",
    "blocks.json",
    "verification.json",
    "secret.log",
    "pages/evaluation.json",
    ".review-private/evaluation.json",
  ]) {
    assert.equal(
      (await fetch(`${f.base}/output/${doc.runId}/${file}`)).status,
      404,
      file,
    );
  }
  assert.equal(
    (await fetch(`${f.base}/output/${doc.runId}/original.pdf`)).status,
    200,
  );
  assert.equal(
    (await fetch(`${f.base}/output/${doc.runId}/pages/page-1.png`)).status,
    200,
  );
  await fs.writeFile(path.join(f.root, "outside.pdf"), "private");
  await fs.symlink(
    path.join(f.root, "outside.pdf"),
    path.join(dir, "evaluated.pdf"),
  );
  assert.equal(
    (await fetch(`${f.base}/output/${doc.runId}/evaluated.pdf`)).status,
    404,
  );
  assert.equal(
    (await fetch(`${f.base}/run/${doc.runId}/student-report`)).status,
    409,
  );
  assert.equal(
    (await fetch(`${f.base}/run/${doc.runId}`)).status,
    200,
    "teacher review remains available",
  );
});

test("concurrent writes across store instances preserve every history entry, student and question edit", async (t) => {
  const f = await fixture(t);
  const history = new HistoryStore(path.join(f.root, "store/history"));
  const students = new StudentStore(path.join(f.root, "store/students"));
  const exams = new ExamStore(path.join(f.root, "store/exams"));
  await Promise.all(
    Array.from({ length: 24 }, (_, n) =>
      (n % 2 ? history : f.historyStore).append("student", entry(n)),
    ),
  );
  assert.equal((await history.list("student")).length, 24);
  await Promise.all(
    Array.from({ length: 20 }, (_, n) =>
      (n % 2 ? students : f.studentStore).add("8-A", `Student ${n}`),
    ),
  );
  assert.equal((await students.list("8-A")).length, 20);
  await exams.save(exam());
  await Promise.all([
    exams.updateQuestion(exam().id!, "1(a)", { prompt: "A changed" }),
    f.examStore.updateQuestion(exam().id!, "1(b)", { prompt: "B changed" }),
  ]);
  const updated = await exams.get(exam().id!);
  assert.deepEqual(
    updated?.questions.map((q) => q.prompt),
    ["A changed", "B changed"],
  );
  assert.equal(updated?.approval, undefined);
});

test("locks recover from failures and readers never observe partially written JSON", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, "snapshot.json");
  await writeJsonAtomic(file, { sequence: -1, payload: "x".repeat(10000) });
  await assert.rejects(
    withFileLock(file, async () => {
      throw new Error("expected");
    }),
    /expected/,
  );
  const writer = Promise.all(
    Array.from({ length: 16 }, (_, sequence) =>
      withFileLock(file, () =>
        writeJsonAtomic(file, { sequence, payload: "x".repeat(10000) }),
      ),
    ),
  );
  for (let n = 0; n < 40; n++)
    assert.equal(
      JSON.parse(await fs.readFile(file, "utf8")).payload.length,
      10000,
    );
  await writer;
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).sequence, 15);
  assert.equal(
    (await fs.readdir(f.root)).filter((name) => name.endsWith(".tmp")).length,
    0,
  );
});

test("normalization metadata survives omitted and undefined updates, and approval clears explicitly", async (t) => {
  const f = await fixture(t);
  const normalized = normalizeExamMarks(exam(), 20);
  await f.examStore.save({ ...normalized, approval: exam().approval });
  const id = exam().id!;
  const put = await fetch(`${f.base}/exam/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...normalized,
      marksNormalization: undefined,
      approval: undefined,
    }),
  });
  assert.equal(put.status, 200);
  assert.deepEqual(
    (await put.json()).exam.marksNormalization,
    normalized.marksNormalization,
  );
  await f.examStore.update(id, { marksNormalization: undefined });
  assert.deepEqual(
    (await f.examStore.get(id))?.marksNormalization,
    normalized.marksNormalization,
  );
  await f.examStore.update(id, { approval: undefined });
  assert.equal((await f.examStore.get(id))?.approval, undefined);
  await f.examStore.save({ ...normalized, approval: exam().approval });
  assert.equal(
    (await f.examStore.normalizeMarks(id, 20))?.approval,
    undefined,
    "even same-total normalization explicitly clears approval",
  );
  await f.examStore.save({ ...normalized, approval: exam().approval });
  const merged = await f.examStore.mergeQuestions(id, {
    questionIds: ["1(a)", "1(b)"],
    id: "1",
  });
  assert.equal(merged?.approval, undefined);
  assert.equal(merged?.questions.length, 1);
});

test("exam listing skips unrelated JSON and atomic-write temporary files", async (t) => {
  const f = await fixture(t);
  await f.examStore.save(exam());
  await writeJsonAtomic(path.join(f.root, "store/exams/lock.json"), {
    pid: 42,
  });
  await fs.writeFile(
    path.join(f.root, "store/exams/.storage-exam.json.writing.tmp"),
    "half-json",
  );
  assert.deepEqual(
    (await f.examStore.list()).map((e) => e.id),
    [exam().id],
  );
});

test("regrade refuses runs without an explicit student identity before making directories or API calls", async (t) => {
  const f = await fixture(t);
  await f.examStore.save(exam());
  for (const studentId of [undefined, "", "../outside"]) {
    const doc = { ...run("storage-exam--misleading-name--old"), studentId };
    await f.writeRun(doc);
    const response = await fetch(`${f.base}/dev/regrade/${doc.runId}`, {
      method: "POST",
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /studentId/);
  }
  assert.equal((await fs.readdir(path.join(f.root, "output"))).length, 1);
  assert.equal(f.providerCalls(), 0);
});

test("release rejects a legacy exam-total mismatch even when every answer was accepted", async (t) => {
  const f = await fixture(t);
  const doc = run();
  doc.exam.totalMarks = 20;
  await f.writeRun(doc);
  const response = await fetch(`${f.base}/run/${doc.runId}/release`, {
    method: "POST",
  });
  assert.equal(response.status, 409);
  assert.match(
    (await response.json()).error,
    /Question marks total 2, but the exam total is 20/,
  );
  const saved = JSON.parse(
    await fs.readFile(
      evaluationPath(path.join(f.root, "output"), doc.runId),
      "utf8",
    ),
  );
  assert.equal(saved.release, undefined);
});

test("concurrent releases retain both history entries and repeated release preserves the original timestamp", async (t) => {
  const f = await fixture(t);
  await f.examStore.save(exam());
  const docs = [run("storage-exam--s--one"), run("storage-exam--s--two")];
  await Promise.all(docs.map(f.writeRun));
  const responses = await Promise.all(
    docs.map((doc) =>
      fetch(`${f.base}/run/${doc.runId}/release`, { method: "POST" }),
    ),
  );
  for (const response of responses) assert.equal(response.status, 200);
  const first = await responses[0].json();
  const repeated = await fetch(`${f.base}/run/${docs[0].runId}/release`, {
    method: "POST",
  });
  assert.deepEqual((await repeated.json()).release, first.release);
  assert.equal((await f.historyStore.list("student")).length, 2);
});

test("grading, metadata and acknowledgment share one lock without dropping marks, history or comments", async (t) => {
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  let releaseRender!: () => void;
  const renderGate = new Promise<void>((resolve) => {
    releaseRender = resolve;
  });
  let calls = 0;
  const f = await fixture(t, async (result, file) => {
    if (calls++ === 0) {
      signalEntered();
      await renderGate;
    }
    await writeJsonAtomic(file, result);
  });
  const doc = run();
  doc.release = { releasedAt: "2026-09-24T10:01:00Z" };
  await f.examStore.save(exam());
  await f.writeRun(doc);
  const send = (suffix: string, method: string, body?: unknown) =>
    fetch(`${f.base}/run/${doc.runId}/${suffix}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  const first = send("grading", "PATCH", {
    questionId: "1(a)",
    criterionId: "c1",
    marksAwarded: 1,
  });
  await entered;
  const second = send("grading", "PATCH", {
    questionId: "1(b)",
    criterionId: "c1",
    marksAwarded: 0.5,
  });
  const metadata = send("metadata", "PATCH", {
    teacherRemark: "Review the second explanation.",
  });
  releaseRender();
  for (const response of await Promise.all([first, second, metadata]))
    assert.equal(response.status, 200);
  const acknowledgments = await Promise.all(
    Array.from({ length: 5 }, () => send("acknowledge", "POST")),
  );
  const stamps = await Promise.all(
    acknowledgments.map(async (response) => {
      assert.equal(response.status, 200);
      return (await response.json()).acknowledgment.acknowledgedAt;
    }),
  );
  assert.equal(new Set(stamps).size, 1);
  const saved = await (await fetch(`${f.base}/run/${doc.runId}`)).json();
  assert.equal(saved.analytics.totalAwarded, 1.5);
  assert.equal(saved.overrideHistory.length, 2);
  assert.equal(saved.teacherRemark, "Review the second explanation.");
  assert.ok(saved.acknowledgment?.acknowledgedAt);
  assert.equal((await f.historyStore.list("student"))[0].awardedMarks, 1.5);
});

test("seed responses report their actual capped count and reject unsafe seed paths", async (t) => {
  const f = await fixture(t);
  await f.examStore.save(exam());
  const doc = run();
  await f.writeRun(doc);
  const request = (body: unknown) =>
    fetch(`${f.base}/exam/${exam().id}/seed-class`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await request({ seedRunId: "../outside", count: 2 })).status,
    400,
  );
  for (const count of [0, -1, 1.5, "bad"])
    assert.equal((await request({ seedRunId: doc.runId, count })).status, 400);
  const response = await request({ seedRunId: doc.runId, count: 20 });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.requestedCount, 20);
  assert.equal(body.count, 15);
  assert.equal(body.count, body.students.length);
  assert.equal(body.count, body.runIds.length);
  assert.equal(f.providerCalls(), 0);
});

test("corrupt persisted records fail without being overwritten or crashing HTTP handlers", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, "store/exams/broken.json");
  await fs.writeFile(file, "{unfinished");
  for (const [method, route] of [
    ["GET", "/exam/broken"],
    ["POST", "/exam/broken/approve"],
  ]) {
    assert.equal((await fetch(f.base + route, { method })).status, 500);
  }
  await assert.rejects(f.examStore.update("broken", { title: "new" }));
  assert.equal(await fs.readFile(file, "utf8"), "{unfinished");
  assert.equal((await fetch(f.base + "/health")).status, 200);
});
