import express from "express";
import { z } from "zod";
import { outputRoutes } from "./routes/output.route.js";
import {
  assertStorageId,
  evaluationPath,
  runDirectory,
  validateIdParam,
  withFileLock,
  writeJsonAtomic,
} from "./services/file-store.js";
import cors from "cors";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { blockSchema, examConfigSchema } from "./types.js";
import { runPipeline } from "./services/pipeline.js";
import { ExamStore } from "./services/exam-store.js";
import { StudentStore } from "./services/student-store.js";
import { HistoryStore } from "./services/history-store.js";
import { examRoutes } from "./routes/exam.route.js";
import { reportRoutes } from "./routes/reports.route.js";
import type { PipelineResult, TestHistoryEntry } from "./types.js";
import { assertExamMarks } from "./services/exam-marks.js";
import { assertEvaluationMarks } from "./services/evaluation-marks.js";
import { applyGradingPatch } from "./services/grading-edit.js";
import { saveGradingRevision } from "./services/grading-artifacts.js";

export async function createApp(opts: {
  rootDir: string;
  pipeline?: typeof runPipeline;
  renderRevision?: typeof saveGradingRevision;
}) {
  const ROOT = path.resolve(opts.rootDir);
  const pipeline = opts.pipeline ?? runPipeline;
  const renderRevision = opts.renderRevision ?? saveGradingRevision;
  const UPLOAD_DIR = path.join(ROOT, "uploads");
  const OUTPUT_DIR = path.join(ROOT, "output");
  const STORE_DIR = path.join(ROOT, "store", "exams");
  const STUDENT_STORE_DIR = path.join(ROOT, "store", "students");
  const HISTORY_STORE_DIR = path.join(ROOT, "store", "history");

  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.mkdir(STORE_DIR, { recursive: true });
  await fs.mkdir(STUDENT_STORE_DIR, { recursive: true });
  await fs.mkdir(HISTORY_STORE_DIR, { recursive: true });

  const upload = multer({ dest: UPLOAD_DIR });
  const store = new ExamStore(STORE_DIR);
  const studentStore = new StudentStore(STUDENT_STORE_DIR);
  const historyStore = new HistoryStore(HISTORY_STORE_DIR);
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "20mb" }));
  app.use("/output", outputRoutes(OUTPUT_DIR));
  for (const name of ["runId", "examId"]) app.param(name, validateIdParam);

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.use(
    "/exam",
    examRoutes({
      uploadDir: UPLOAD_DIR,
      outputDir: OUTPUT_DIR,
      storeDir: STORE_DIR,
    }),
  );
  app.use(
    "/",
    reportRoutes({
      outputDir: OUTPUT_DIR,
      examStore: store,
      studentStore,
      historyStore,
    }),
  );

  /**
   * POST /exam/:id/grade
   * Grade a student sheet against a SAVED, APPROVED exam.
   *
   * HARD RULE R1: refuses if exam.approval.approvedAt is not set.
   */
  app.post("/exam/:examId/grade", upload.single("pdf"), async (req, res) => {
    try {
      if (!req.file)
        return res.status(400).json({ error: "pdf file required" });
      const exam = await store.get(req.params.examId);
      if (!exam) return res.status(404).json({ error: "exam not found" });
      if (!exam.approval?.approvedAt) {
        return res.status(409).json({
          error:
            "Hard rule R1: cannot grade against an unapproved scheme. Approve the marking scheme first.",
        });
      }

      try {
        assertExamMarks(exam);
      } catch (err) {
        return res.status(409).json({ error: (err as Error).message });
      }

      const body = z
        .object({
          studentId: z
            .string()
            .trim()
            .max(80)
            .regex(/^[a-zA-Z0-9_-]*$/)
            .optional(),
        })
        .safeParse(req.body);
      if (!body.success)
        return res.status(400).json({
          error:
            "Use up to 80 letters, numbers, hyphens or underscores for the student ID.",
        });
      const studentId =
        body.data.studentId || `student-${randomUUID().slice(0, 6)}`;
      const runId = `${exam.id}--${studentId}--${Date.now()}`;
      const result = await pipeline({
        runId,
        pdfPath: req.file.path,
        exam,
        outputRoot: OUTPUT_DIR,
        onProgress: (stage, detail) =>
          console.log(`[${runId}] ${stage}`, detail ?? ""),
      });
      // Stamp examId + studentId; leave release undefined (blocked until teacher releases).
      const stamped = { ...result, examId: exam.id, studentId };
      await writeJsonAtomic(evaluationPath(OUTPUT_DIR, runId), stamped);

      res.json({ runId, result: stamped });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * POST /grade  (legacy path for ad-hoc exam JSON — used by CreateExam flow's
   * "test this exam" button before the exam is saved to the store)
   */
  app.post("/grade", upload.single("pdf"), async (req, res) => {
    try {
      if (!req.file)
        return res.status(400).json({ error: "pdf file required" });
      const examRaw = req.body.exam;
      if (!examRaw)
        return res.status(400).json({ error: "exam field required" });

      const exam = examConfigSchema.parse(
        typeof examRaw === "string" ? JSON.parse(examRaw) : examRaw,
      );

      if (!exam.approval?.approvedAt) {
        return res.status(409).json({
          error:
            "Hard rule R1: cannot grade against an unapproved scheme. Approve the marking scheme first.",
        });
      }

      try {
        assertExamMarks(exam);
      } catch (err) {
        return res.status(409).json({ error: (err as Error).message });
      }
      const runId = `${Date.now()}-${randomUUID().slice(0, 6)}`;
      const result = await pipeline({
        runId,
        pdfPath: req.file.path,
        exam,
        outputRoot: OUTPUT_DIR,
        onProgress: (stage, detail) =>
          console.log(`[${runId}] ${stage}`, detail ?? ""),
      });

      res.json({ runId, result });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * GET /run/:runId — teacher view. Full detail regardless of release.
   * (Used by the review UI.)
   */
  app.get("/run/:runId", async (req, res) => {
    try {
      const raw = await fs.readFile(
        evaluationPath(OUTPUT_DIR, req.params.runId),
        "utf-8",
      );
      res.type("json").send(raw);
    } catch {
      res.status(404).json({ error: "not found" });
    }
  });

  /**
   * GET /run/:runId/student — student/parent view.
   *
   * HARD RULE R2: blocked with 409 until the teacher has released the run.
   * When released, returns a slimmed payload (no LLM audit fields, no
   * confidence internals, no rubric evidence pointers).
   */
  app.get("/run/:runId/student", async (req, res) => {
    try {
      const raw = await fs.readFile(
        evaluationPath(OUTPUT_DIR, req.params.runId),
        "utf-8",
      );
      const doc = JSON.parse(raw);
      if (!doc.release?.releasedAt) {
        return res.status(409).json({
          error:
            "Hard rule R2: this evaluation has not been released to students/parents yet.",
        });
      }
      res.json({
        totalAwarded: doc.analytics.totalAwarded,
        totalMax: doc.analytics.totalMax,
        perQuestion: doc.grading.map((g: any) => ({
          questionId: g.questionId,
          awardedMarks: g.awardedMarks,
          maxMarks: g.maxMarks,
        })),
        weakConcepts: doc.analytics.weakConcepts,
        releasedAt: doc.release.releasedAt,
      });
    } catch {
      res.status(404).json({ error: "not found" });
    }
  });

  /**
   * POST /run/:runId/release — teacher stamps releasedAt. Only after this can
   * /run/:runId/student return data.
   */
  app.post("/run/:runId/release", async (req, res) => {
    try {
      const p = evaluationPath(OUTPUT_DIR, req.params.runId);
      return await withFileLock(p, async () => {
        const doc = JSON.parse(await fs.readFile(p, "utf-8"));

        // Refuse to release if any question is still routed to teacher_review
        try {
          assertEvaluationMarks(doc);
        } catch (error) {
          return res.status(409).json({ error: (error as Error).message });
        }
        const unresolved = (doc.grading ?? []).filter(
          (g: any) => g.needsTeacherReview,
        );
        if (unresolved.length > 0) {
          return res.status(409).json({
            error: `${unresolved.length} question(s) still flagged for teacher review: ${unresolved.map((g: any) => g.questionId).join(", ")}. Resolve them before releasing.`,
          });
        }
        doc.release ??= {
          releasedAt: new Date().toISOString(),
          releasedBy: String(req.body?.releasedBy ?? "teacher"),
        };
        await writeJsonAtomic(p, doc);

        // Append to per-student test history so cross-test deltas can be computed
        // in future reports.
        if (doc.studentId && doc.examId) {
          const exam = await store.get(doc.examId);
          if (exam) {
            const entry: TestHistoryEntry = {
              runId: doc.runId,
              examId: doc.examId,
              examTitle: exam.title,
              subject: exam.subject,
              class: exam.class,
              awardedMarks: doc.analytics.totalAwarded,
              maxMarks: doc.analytics.totalMax,
              percentage:
                doc.analytics.totalMax > 0
                  ? Math.round(
                      (doc.analytics.totalAwarded / doc.analytics.totalMax) *
                        1000,
                    ) / 10
                  : 0,
              releasedAt: doc.release.releasedAt!,
            };
            await historyStore.append(doc.studentId, entry);
          }
        }

        res.json({ ok: true, release: doc.release });
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * POST /dev/regrade/:runId — reuse cached blocks.json + pages/ of an existing
   * run and re-execute mapping → semantic → grading → annotate → render into
   * a fresh, unreleased run. Keeps the original available for comparison.
   * Requires valid cached blocks; never falls back to vision or Mathpix.
   */
  app.post("/dev/regrade/:runId", async (req, res) => {
    try {
      const runDir = runDirectory(OUTPUT_DIR, req.params.runId);
      const doc = JSON.parse(
        await fs.readFile(
          evaluationPath(OUTPUT_DIR, req.params.runId),
          "utf-8",
        ),
      );
      const studentId = doc.studentId;
      try {
        assertStorageId(studentId, "student id");
      } catch {
        return res.status(400).json({
          error:
            "This run has no valid studentId. Assign its student before regrading; the run name is not a student record.",
        });
      }
      const examId = doc.examId ?? doc.exam?.id;
      if (!examId) return res.status(400).json({ error: "run has no examId" });
      const exam = await store.get(examId);
      if (!exam) return res.status(404).json({ error: "exam not found" });
      if (!exam.approval?.approvedAt) {
        return res
          .status(409)
          .json({ error: "Approve the marking scheme before regrading." });
      }
      try {
        assertExamMarks(exam);
      } catch (err) {
        return res.status(409).json({ error: (err as Error).message });
      }
      let blocks;
      try {
        blocks = blockSchema
          .array()
          .min(1)
          .parse(
            JSON.parse(
              await fs.readFile(path.join(runDir, "blocks.json"), "utf-8"),
            ),
          );
      } catch {
        return res.status(409).json({
          error:
            "Valid cached blocks are required for regrading. No OCR was started.",
        });
      }
      const runId = `${examId}--${studentId}--regrade-${Date.now()}-${randomUUID().slice(0, 6)}`;
      const newRunDir = runDirectory(OUTPUT_DIR, runId);
      await fs.mkdir(newRunDir, { recursive: true });
      await fs.writeFile(
        path.join(newRunDir, "blocks.json"),
        JSON.stringify(blocks, null, 2),
      );

      const result = await pipeline({
        runId,
        pdfPath: path.join(runDir, "original.pdf"),
        exam,
        outputRoot: OUTPUT_DIR,
        requireCachedBlocks: true,
        onProgress: (stage, detail) =>
          console.log(
            `[dev-regrade ${req.params.runId}] ${stage}`,
            detail ?? "",
          ),
      });
      const stamped = { ...result, examId, studentId };
      await writeJsonAtomic(evaluationPath(OUTPUT_DIR, runId), stamped);
      res.json({ runId, sourceRunId: req.params.runId, result: stamped });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * PATCH /run/:runId/grading — teacher overrides an individual criterion.
   * (Same as before, plus writes mistakeTag if teacher provides one.)
   */
  app.patch("/run/:runId/grading", async (req, res) => {
    try {
      const p = evaluationPath(OUTPUT_DIR, req.params.runId);
      return await withFileLock(p, async () => {
        const doc = JSON.parse(await fs.readFile(p, "utf-8")) as PipelineResult;
        const { result, grading } = applyGradingPatch(doc, req.body);
        await renderRevision(result, p);
        if (result.release?.releasedAt && result.studentId && result.examId) {
          await historyStore.append(result.studentId, {
            runId: result.runId,
            examId: result.examId,
            examTitle: result.exam.title,
            subject: result.exam.subject,
            class: result.exam.class,
            awardedMarks: result.analytics.totalAwarded,
            maxMarks: result.analytics.totalMax,
            percentage: result.analytics.totalMax
              ? Math.round(
                  (result.analytics.totalAwarded / result.analytics.totalMax) *
                    1000,
                ) / 10
              : 0,
            releasedAt: result.release.releasedAt,
          });
        }
        res.json({ ok: true, grading, result });
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return app;
}
