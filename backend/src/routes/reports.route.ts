import {
  evaluationPath,
  validateIdParam,
  withFileLock,
  writeJsonAtomic,
} from "../services/file-store.js";
import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { ExamStore } from "../services/exam-store.js";
import { StudentStore } from "../services/student-store.js";
import { HistoryStore } from "../services/history-store.js";
import {
  buildClassMatrix,
  buildClassReport,
  buildStudentReport,
  loadExamRuns,
} from "../services/reports.js";
import { seedClassFromRun } from "../services/seed-class.js";
import type { PipelineResult } from "../types.js";
import { z } from "zod";

export function reportRoutes(opts: {
  outputDir: string;
  examStore: ExamStore;
  studentStore: StudentStore;
  historyStore: HistoryStore;
}) {
  const router = Router();
  for (const name of ["id", "runId"]) router.param(name, validateIdParam);

  /** GET /exam/:id/report — teacher test analysis */
  router.get("/exam/:id/report", async (req, res) => {
    try {
      const exam = await opts.examStore.get(req.params.id);
      if (!exam) return res.status(404).json({ error: "exam not found" });
      const report = await buildClassReport(
        exam,
        opts.outputDir,
        opts.studentStore,
        opts.historyStore,
      );
      res.json({ report });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** GET /exam/:id/matrix — student × question matrix + groups */
  router.get("/exam/:id/matrix", async (req, res) => {
    try {
      const exam = await opts.examStore.get(req.params.id);
      if (!exam) return res.status(404).json({ error: "exam not found" });
      const matrix = await buildClassMatrix(
        exam,
        opts.outputDir,
        opts.studentStore,
        opts.historyStore,
      );
      res.json({ matrix });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** Teacher preview stays available before release; student URL is gated. */
  router.get(
    ["/run/:runId/report", "/run/:runId/student-report"],
    async (req, res) => {
      try {
        const p = evaluationPath(opts.outputDir, req.params.runId);
        const run = JSON.parse(await fs.readFile(p, "utf-8")) as PipelineResult;
        if (req.path.endsWith("/student-report") && !run.release?.releasedAt) {
          return res.status(409).json({
            error:
              "This report will be available after your teacher releases it.",
          });
        }
        const exam = { ...run.exam, id: run.exam.id ?? run.examId };
        if (!exam.id)
          return res.status(400).json({ error: "run has no examId" });
        const report = await buildStudentReport(
          run,
          exam,
          opts.outputDir,
          opts.studentStore,
          opts.historyStore,
        );
        res.json({ report });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  router.post("/run/:runId/acknowledge", async (req, res) => {
    try {
      const p = evaluationPath(opts.outputDir, req.params.runId);
      return await withFileLock(p, async () => {
        const run = JSON.parse(await fs.readFile(p, "utf-8")) as PipelineResult;
        if (!run.release?.releasedAt)
          return res
            .status(409)
            .json({ error: "The report has not been released yet." });
        run.acknowledgment ??= { acknowledgedAt: new Date().toISOString() };
        await writeJsonAtomic(p, run);
        res.json({ ok: true, acknowledgment: run.acknowledgment });
      });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  router.patch("/run/:runId/metadata", async (req, res) => {
    try {
      const { teacherRemark } = z
        .object({ teacherRemark: z.string().trim().max(3000) })
        .strict()
        .parse(req.body);
      const p = evaluationPath(opts.outputDir, req.params.runId);
      return await withFileLock(p, async () => {
        const run = JSON.parse(await fs.readFile(p, "utf-8")) as PipelineResult;
        run.teacherRemark = teacherRemark || undefined;
        run.acknowledgment = undefined;
        await writeJsonAtomic(p, run);
        res.json({ ok: true, teacherRemark: run.teacherRemark ?? "" });
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  /** GET /exam/:id/students — list students who have released runs for this exam */
  router.get("/exam/:id/students", async (req, res) => {
    try {
      const exam = await opts.examStore.get(req.params.id);
      if (!exam) return res.status(404).json({ error: "exam not found" });
      const includeUnreleased = req.query.includeUnreleased === "1";
      const runs = await loadExamRuns(
        opts.outputDir,
        exam.id!,
        includeUnreleased ? undefined : exam,
        { includeUnreleased },
      );
      const rows = runs.map((doc) => ({
        studentId: doc.studentId ?? "",
        runId: doc.runId,
        totalAwarded: doc.analytics.totalAwarded,
        totalMax: doc.analytics.totalMax,
        releasedAt: doc.release?.releasedAt,
        needsTeacherReview: doc.grading.filter((q) => q.needsTeacherReview)
          .length,
      }));
      const students = await opts.studentStore.list(exam.class);
      const enriched = rows.map((r) => ({
        ...r,
        name:
          students.find((s) => s.id === r.studentId)?.name ??
          (r.studentId
            .replace(/[-_]+/g, " ")
            .replace(/\b\w/g, (letter) => letter.toUpperCase()) ||
            "Unknown student"),
      }));
      res.json({ students: enriched });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * POST /exam/:id/seed-class — dev-only. Clones an existing run into N mock
   * students so the reports have data without needing 10 real sheets.
   * Body: { seedRunId: string, count?: number }
   */
  router.post("/exam/:id/seed-class", async (req, res) => {
    try {
      const exam = await opts.examStore.get(req.params.id);
      if (!exam) return res.status(404).json({ error: "exam not found" });
      const { seedRunId, count } = z
        .object({
          seedRunId: z.string().min(1),
          count: z.number().int().positive().default(10),
        })
        .parse(req.body);
      const result = await seedClassFromRun({
        seedRunId,
        count,
        exam,
        outputRoot: opts.outputDir,
        studentStore: opts.studentStore,
        historyStore: opts.historyStore,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
