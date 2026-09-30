import { validateIdParam } from "../services/file-store.js";
import { Router } from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { buildExamFromPaper } from "../services/exam-builder.js";
import { ExamStore } from "../services/exam-store.js";
import { ProviderRegistry } from "../providers/index.js";
import {
  evaluationRulesSchema,
  examConfigSchema,
  questionTagsSchema,
} from "../types.js";

const upload = multer({ dest: "/tmp" });

const metaSchema = z.object({
  title: z.string().min(1),
  subject: z.string().min(1),
  class: z.string().min(1),
  totalMarks: z.coerce
    .number()
    .finite()
    .positive()
    .refine(
      (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6,
      "Total marks must have at most two decimal places",
    )
    .optional(),
});

const mergeQuestionsSchema = z
  .object({
    questionIds: z.array(z.string().min(1)).min(2),
    id: z.string().trim().min(1),
    maxMarks: z.number().finite().positive().optional(),
  })
  .strict();

const normalizeMarksSchema = z
  .object({ totalMarks: z.number().finite().positive() })
  .strict();

export function examRoutes(opts: {
  uploadDir: string;
  outputDir: string;
  storeDir: string;
}) {
  const router = Router();
  router.param("id", validateIdParam);
  const store = new ExamStore(opts.storeDir);

  router.get("/providers", (_req, res) => {
    const registry = ProviderRegistry.default();
    res.json({ configured: registry.configured() });
  });

  /**
   * POST /exam/generate — Phase 1 paper-in exam-out.
   * Multipart: paper (PDF), meta (JSON string).
   * Returns generated ExamConfig — persisted to the store so it can be edited
   * and later approved.
   */
  router.post("/generate", upload.single("paper"), async (req, res) => {
    try {
      if (!req.file)
        return res.status(400).json({ error: "paper file required" });
      const meta = metaSchema.parse(
        typeof req.body.meta === "string"
          ? JSON.parse(req.body.meta)
          : (req.body.meta ?? {}),
      );

      const registry = ProviderRegistry.default();
      if (registry.configured().length === 0) {
        return res.status(500).json({ error: "no LLM providers configured" });
      }

      const workDir = path.join(
        opts.outputDir,
        `_paper-${randomUUID().slice(0, 8)}`,
      );
      const draft = await buildExamFromPaper(
        req.file.path,
        meta,
        registry,
        workDir,
        {
          onProgress: (stage, detail) =>
            console.log(`[exam:${stage}]`, detail ?? ""),
        },
      );
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      // Persist immediately so the teacher can navigate away + come back.
      const saved = await store.save({
        ...draft,
        evaluationRules: {
          mode: "review",
          partialCredit: true,
          carryForward: true,
          unitPenalty: "half",
          flagUncertain: true,
          confirmed: false,
        },
      });
      const withPaper = await store.attachPaper(
        saved.id!,
        req.file.path,
        req.file.originalname,
      );
      res.json({ exam: withPaper });
    } catch (err) {
      console.error(err);
      res
        .status(
          err instanceof z.ZodError || err instanceof SyntaxError ? 400 : 500,
        )
        .json({ error: (err as Error).message });
    } finally {
      if (req.file) await fs.unlink(req.file.path).catch(() => {});
    }
  });

  router.get("/", async (_req, res) => {
    try {
      res.json({ exams: await store.list() });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/:id", async (req, res) => {
    try {
      const exam = await store.get(req.params.id);
      if (!exam) return res.status(404).json({ error: "exam not found" });
      res.json({ exam });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/:id/paper", async (req, res) => {
    try {
      const exam = await store.get(req.params.id);
      if (!exam?.paper)
        return res.status(404).json({
          error: "Original question paper is not attached to this exam.",
        });
      const file = store.paperPath(req.params.id);
      await fs.access(file);
      res.type("pdf").sendFile(file);
    } catch {
      res.status(404).json({ error: "Original question paper not found." });
    }
  });

  router.put("/:id/paper", upload.single("paper"), async (req, res) => {
    try {
      if (!req.file)
        return res.status(400).json({ error: "paper PDF required" });
      const handle = await fs.open(req.file.path, "r");
      const signature = Buffer.alloc(5);
      try {
        await handle.read(signature, 0, 5, 0);
      } finally {
        await handle.close();
      }
      if (signature.toString() !== "%PDF-")
        return res.status(400).json({ error: "Upload a PDF question paper." });
      const exam = await store.attachPaper(
        req.params.id,
        req.file.path,
        req.file.originalname,
      );
      if (!exam) return res.status(404).json({ error: "exam not found" });
      res.json({ exam });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    } finally {
      if (req.file) await fs.unlink(req.file.path).catch(() => {});
    }
  });

  router.patch("/:id/rules", async (req, res) => {
    try {
      const rules = evaluationRulesSchema.parse(
        req.body?.evaluationRules ?? req.body,
      );
      const exam = await store.updateRules(req.params.id, rules);
      if (!exam) return res.status(404).json({ error: "exam not found" });
      res.json({ exam });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.put("/:id", async (req, res) => {
    try {
      const parsed = examConfigSchema.parse(req.body);
      const updated = await store.update(req.params.id, parsed);
      if (!updated) return res.status(404).json({ error: "exam not found" });
      res.json({ exam: updated });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  /**
   * PATCH /exam/:id/questions/:qid  — confirm topic + difficulty tags,
   * or edit prompt / maxMarks / rubric.
   */
  router.patch("/:id/questions/:qid", async (req, res) => {
    try {
      const patch = req.body ?? {};
      if (patch.tags) {
        patch.tags = questionTagsSchema.parse(patch.tags);
      }
      const updated = await store.updateQuestion(
        req.params.id,
        req.params.qid,
        patch,
      );
      if (!updated) return res.status(404).json({ error: "not found" });
      res.json({ exam: updated });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post("/:id/merge-questions", async (req, res) => {
    try {
      const input = mergeQuestionsSchema.parse(req.body);
      const updated = await store.mergeQuestions(req.params.id, input);
      if (!updated) return res.status(404).json({ error: "exam not found" });
      res.json({ exam: updated });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post("/:id/normalize-marks", async (req, res) => {
    try {
      const { totalMarks } = normalizeMarksSchema.parse(req.body);
      const updated = await store.normalizeMarks(req.params.id, totalMarks);
      if (!updated) return res.status(404).json({ error: "exam not found" });
      res.json({ exam: updated });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  /**
   * POST /exam/:id/approve — HARD RULE R1 gate.
   * Stamps approval.approvedAt. Refuses if any question is missing confirmed
   * tags or has an empty rubric.
   */
  router.post("/:id/approve", async (req, res) => {
    try {
      const approvedBy = String(req.body?.approvedBy ?? "teacher");
      const result = await store.approve(req.params.id, approvedBy);
      if (!result.ok) return res.status(409).json({ error: result.error });
      res.json({ exam: result.exam });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  return router;
}
