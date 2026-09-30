import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  evaluationRulesSchema,
  examConfigSchema,
  questionSchema,
  type EvaluationRules,
  type ExamConfig,
  type Question,
} from "../types.js";
import {
  assertExamMarks,
  normalizeExamMarks,
  normalizeRubricMarks,
} from "./exam-marks.js";
import { mergeExamQuestions, type MergeQuestionsInput } from "./exam-merge.js";
import {
  assertStorageId,
  withFileLock,
  writeFileAtomic,
  writeJsonAtomic,
} from "./file-store.js";

const questionPatchSchema = questionSchema
  .omit({ id: true, sourceQuestionIds: true })
  .partial()
  .strict();
const questionContent = (q: Question) =>
  JSON.stringify({ ...q, schemeApproved: undefined });
function schemeContent(exam: ExamConfig): string {
  return JSON.stringify({
    title: exam.title,
    subject: exam.subject,
    class: exam.class,
    totalMarks: exam.totalMarks,
    questions: exam.questions,
    evaluationRules: exam.evaluationRules,
  });
}

function applyUpdate(
  current: ExamConfig,
  patch: Partial<ExamConfig>,
): ExamConfig {
  // Omitted/undefined optional metadata means preserve. Approval is the explicit
  // exception: callers may clear it, but only approve() may grant it.
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  const clearApproval =
    Object.hasOwn(patch, "approval") && patch.approval === undefined;
  const updated: ExamConfig = {
    ...current,
    ...defined,
    id: current.id,
    createdAt: current.createdAt,
    approval: clearApproval ? undefined : current.approval,
  };
  updated.questions = updated.questions.map((question) => {
    const previous = current.questions.find((q) => q.id === question.id);
    return !previous || questionContent(question) !== questionContent(previous)
      ? { ...question, schemeApproved: false }
      : question;
  });
  if (schemeContent(updated) !== schemeContent(current))
    updated.approval = undefined;
  return updated;
}

/** File-backed POC store. Mutations serialize per exam across store instances.
 * Use a transactional database before running multiple backend processes. */
export class ExamStore {
  constructor(private storeDir: string) {}
  async init(): Promise<void> {
    await fs.mkdir(this.storeDir, { recursive: true });
  }

  async list(): Promise<
    {
      id: string;
      title: string;
      class: string;
      subject: string;
      approved: boolean;
      updatedAt?: string;
    }[]
  > {
    await this.init();
    const files = (await fs.readdir(this.storeDir)).filter((f) =>
      /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(f),
    );
    const items = await Promise.all(
      files.map(async (file) => {
        try {
          const id = file.slice(0, -5);
          assertStorageId(id, "exam id");
          const e = examConfigSchema.parse(
            JSON.parse(await fs.readFile(this.path(id), "utf8")),
          );
          if (e.id && e.id !== id) return null;
          return {
            id,
            title: e.title,
            class: e.class,
            subject: e.subject,
            approved: !!e.approval?.approvedAt,
            updatedAt: e.updatedAt,
          };
        } catch {
          return null;
        }
      }),
    );
    return items.filter((e): e is NonNullable<typeof e> => e !== null);
  }

  private async persist(exam: ExamConfig): Promise<ExamConfig> {
    const id = exam.id ?? randomUUID();
    const now = new Date().toISOString();
    const doc = {
      ...exam,
      id,
      createdAt: exam.createdAt ?? now,
      updatedAt: now,
    };
    await writeJsonAtomic(this.path(id), doc);
    return doc;
  }
  async save(exam: ExamConfig): Promise<ExamConfig> {
    const id = exam.id ?? randomUUID();
    return withFileLock(this.path(id), () => this.persist({ ...exam, id }));
  }
  async get(id: string): Promise<ExamConfig | null> {
    const file = this.path(id); // Validate before the missing-file catch.
    try {
      return JSON.parse(await fs.readFile(file, "utf8")) as ExamConfig;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  private async mutate(
    id: string,
    change: (
      current: ExamConfig,
    ) => ExamConfig | null | Promise<ExamConfig | null>,
  ): Promise<ExamConfig | null> {
    return withFileLock(this.path(id), async () => {
      const current = await this.get(id);
      if (!current) return null;
      const updated = await change(current);
      return updated ? this.persist(updated) : null;
    });
  }
  async update(
    id: string,
    patch: Partial<ExamConfig>,
  ): Promise<ExamConfig | null> {
    return this.mutate(id, (current) => applyUpdate(current, patch));
  }
  async updateQuestion(
    id: string,
    questionId: string,
    patch: Partial<Question>,
  ): Promise<ExamConfig | null> {
    const parsed = questionPatchSchema.parse(patch);
    return this.mutate(id, (current) => {
      const idx = current.questions.findIndex((q) => q.id === questionId);
      if (idx === -1) return null;
      const question = current.questions[idx];
      const updated = { ...question, ...parsed };
      if (
        parsed.maxMarks !== undefined &&
        parsed.maxMarks !== question.maxMarks &&
        parsed.rubric === undefined
      ) {
        updated.rubric = normalizeRubricMarks(question.rubric, parsed.maxMarks);
      }
      if (parsed.schemeApproved === true) {
        if (!updated.tags?.confirmedByTeacher)
          throw new Error(
            "Confirm this question's topic and difficulty before approving its scheme.",
          );
        assertExamMarks({
          ...current,
          totalMarks: updated.maxMarks,
          questions: [updated],
        });
      }
      const questions = [...current.questions];
      questions[idx] = updated;
      const result = applyUpdate(current, { questions });
      if (parsed.schemeApproved === true)
        result.questions[idx].schemeApproved = true;
      return result;
    });
  }
  async updateRules(
    id: string,
    rules: EvaluationRules,
  ): Promise<ExamConfig | null> {
    return this.update(id, {
      evaluationRules: evaluationRulesSchema.parse(rules),
    });
  }
  async attachPaper(
    id: string,
    sourcePath: string,
    fileName: string,
  ): Promise<ExamConfig | null> {
    return this.mutate(id, async (current) => {
      await writeFileAtomic(this.paperPath(id), await fs.readFile(sourcePath));
      return { ...current, paper: { fileName: path.basename(fileName) } };
    });
  }
  paperPath(id: string): string {
    assertStorageId(id, "exam id");
    return path.resolve(this.storeDir, "papers", id, "original.pdf");
  }
  async mergeQuestions(
    id: string,
    input: MergeQuestionsInput,
  ): Promise<ExamConfig | null> {
    return this.mutate(id, (current) =>
      applyUpdate(current, {
        ...mergeExamQuestions(current, input),
        approval: undefined,
      }),
    );
  }
  async normalizeMarks(
    id: string,
    totalMarks: number,
  ): Promise<ExamConfig | null> {
    return this.mutate(id, (current) =>
      applyUpdate(current, {
        ...normalizeExamMarks(current, totalMarks),
        approval: undefined,
      }),
    );
  }
  async approve(
    id: string,
    approvedBy: string,
  ): Promise<{ ok: true; exam: ExamConfig } | { ok: false; error: string }> {
    return withFileLock(this.path(id), async () => {
      const current = await this.get(id);
      if (!current) return { ok: false, error: "exam not found" };
      try {
        assertExamMarks(current);
      } catch (error) {
        return {
          ok: false,
          error: `Cannot approve scheme — ${(error as Error).message}`,
        };
      }
      const unconfirmed = current.questions.filter(
        (q) => !q.tags?.confirmedByTeacher,
      );
      if (unconfirmed.length)
        return {
          ok: false,
          error: `Cannot approve scheme — ${unconfirmed.length} question(s) still need topic/difficulty tags confirmed: ${unconfirmed.map((q) => q.id).join(", ")}`,
        };
      if (current.evaluationRules) {
        if (!current.evaluationRules.confirmed)
          return {
            ok: false,
            error: "Confirm evaluation rules before approving the scheme.",
          };
        const pending = current.questions.filter((q) => !q.schemeApproved);
        if (pending.length)
          return {
            ok: false,
            error: `Approve each question's scheme first: ${pending.map((q) => q.id).join(", ")}`,
          };
      }
      return {
        ok: true,
        exam: await this.persist({
          ...current,
          approval: { approvedAt: new Date().toISOString(), approvedBy },
        }),
      };
    });
  }
  private path(id: string): string {
    assertStorageId(id, "exam id");
    return path.resolve(this.storeDir, `${id}.json`);
  }
}
