import type { ExamConfig, Question } from "../types.js";
import { ProviderRegistry } from "../providers/index.js";
import { extractQuestions } from "./paper-extractor.js";
import { generateModelAnswer } from "./model-answer.js";
import { generateRubric } from "./rubric-generator.js";
import { roundMarks } from "./exam-marks.js";

export interface ExamMeta {
  title: string;
  subject: string;
  class: string;
  totalMarks?: number;
}

/**
 * Phase 1 — Paper-in exam-out orchestrator.
 *
 * Chains: question paper PDF → extracted questions → model answers → rubrics
 * → ExamConfig ready for the teacher review UI.
 *
 * Runs question-level work in parallel (bounded to `concurrency` so we don't
 * hammer the provider rate limits).
 */
export async function buildExamFromPaper(
  paperPdfPath: string,
  meta: ExamMeta,
  registry: ProviderRegistry,
  workDir: string,
  opts: {
    concurrency?: number;
    onProgress?: (stage: string, detail?: unknown) => void;
  } = {},
): Promise<ExamConfig> {
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 3));
  const onProgress = opts.onProgress;

  onProgress?.("extract:start");
  const extracted = await extractQuestions(paperPdfPath, registry, workDir);
  onProgress?.("extract:done", { count: extracted.length });

  // If maxMarks missing, default to 1 (teacher will fix in review UI)
  const withMarks = extracted.map((q) => ({
    ...q,
    maxMarks:
      q.maxMarks !== null && Number.isFinite(q.maxMarks) && q.maxMarks > 0
        ? q.maxMarks
        : 1,
    rubric: [],
  }));
  if (withMarks.length === 0)
    throw new Error("No questions were extracted from the paper");
  const draft: ExamConfig = {
    title: meta.title,
    subject: meta.subject,
    class: meta.class,
    totalMarks:
      meta.totalMarks ??
      roundMarks(
        withMarks.reduce((sum, question) => sum + question.maxMarks, 0),
      ),
    questions: withMarks,
  };
  // Preserve printed allocations. A mismatch remains visible in Confirm Questions
  // and blocks approval; proportional scaling is an explicit teacher action.
  const prepared = draft.questions;

  const questions: Question[] = new Array(prepared.length);
  let pointer = 0;

  async function worker() {
    while (true) {
      const i = pointer++;
      if (i >= prepared.length) return;
      const q = prepared[i];
      try {
        onProgress?.("question:start", { id: q.id });

        const context = { subject: meta.subject, class: meta.class };
        const modelAnswer = await generateModelAnswer(
          { ...q, subject: q.subject ?? "general" },
          context,
          registry,
        );
        const rubric = await generateRubric(
          {
            id: q.id,
            prompt: q.prompt,
            maxMarks: q.maxMarks,
            subject: q.subject,
            modelAnswer,
          },
          registry,
          context,
        );

        questions[i] = {
          id: q.id,
          prompt: q.prompt,
          maxMarks: q.maxMarks,
          subject: q.subject,
          modelAnswer,
          rubric,
        };
        onProgress?.("question:done", { id: q.id });
      } catch (err) {
        console.warn(
          `[exam-builder] ${q.id} failed: ${(err as Error).message} — using empty rubric`,
        );
        questions[i] = {
          id: q.id,
          prompt: q.prompt,
          maxMarks: q.maxMarks,
          subject: q.subject,
          modelAnswer: "",
          rubric: [],
        };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, prepared.length) }, () =>
      worker(),
    ),
  );

  return {
    ...draft,
    questions: questions.filter(Boolean),
  };
}
