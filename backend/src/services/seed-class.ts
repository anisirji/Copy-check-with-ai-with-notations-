import {
  assertStorageId,
  evaluationPath,
  writeJsonAtomic,
} from "./file-store.js";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ExamConfig,
  PipelineResult,
  Student,
  TestHistoryEntry,
} from "../types.js";
import { StudentStore } from "./student-store.js";
import { HistoryStore } from "./history-store.js";
import { inferAll } from "./mistake-tag.js";
import { roundMarks } from "./exam-marks.js";

/**
 * Dev-only: take one graded run and clone it into `count` mock students with
 * varied per-question marks so the reports/matrix screens have realistic data
 * without needing 10 real handwritten sheets.
 *
 * Each cloned run:
 *  - gets a fresh runId + new studentId
 *  - has its per-question awardedMarks nudged by a deterministic PRNG seeded
 *    from the student index (so the same seed → the same class every time)
 *  - gets released automatically
 *  - appends to that student's TestHistory + also a fake "prior test" entry
 *    at a lower percentage so "vs last test" deltas render on the report
 */
const MOCK_NAMES = [
  "Ananya Rao",
  "Diya Sharma",
  "Aarav Gupta",
  "Kabir Singh",
  "Ishita Verma",
  "Myra Kapoor",
  "Rohan Mehta",
  "Arjun Nair",
  "Vivaan Jain",
  "Saanvi Yadav",
  "Neha Bansal",
  "Kavya Reddy",
  "Ishaan Malhotra",
  "Aditi Sinha",
  "Rahul Iyer",
];

export interface SeedOptions {
  count: number;
  seedRunId: string; // an existing runId to clone from
  exam: ExamConfig;
  outputRoot: string;
  studentStore: StudentStore;
  historyStore: HistoryStore;
}

export async function seedClassFromRun(opts: SeedOptions): Promise<{
  students: Student[];
  runIds: string[];
  requestedCount: number;
  count: number;
}> {
  assertStorageId(opts.exam.id, "exam id");
  if (!Number.isSafeInteger(opts.count) || opts.count < 1)
    throw new Error("count must be a positive integer");
  const seedPath = evaluationPath(opts.outputRoot, opts.seedRunId);
  const seed = JSON.parse(
    await fs.readFile(seedPath, "utf-8"),
  ) as PipelineResult;

  const count = Math.min(Math.max(1, opts.count), MOCK_NAMES.length);
  const students: Student[] = [];
  const runIds: string[] = [];
  const releasedAt = new Date().toISOString();

  for (let i = 0; i < count; i++) {
    const name = MOCK_NAMES[i];
    const student = await opts.studentStore.add(opts.exam.class, name, i + 1);
    students.push(student);

    // Deterministic variation: seeded PRNG based on student index
    const rng = mulberry32(i * 7919 + 13);

    const clonedGrading = seed.grading.map((g) => {
      // Vary per-criterion marks slightly. Correct ones may drop to partial;
      // missing ones may become correct or partial. Bias by student index to
      // create a realistic spread.
      const bias = biasForIndex(i); // -1..+1, top students positive, bottom negative
      const clonedEval = g.rubricEvaluation.map((ev) => {
        let awarded = ev.marksAwarded;
        let status = ev.status;
        const roll = rng() + bias;
        if (status === "correct" && roll < -0.3) {
          awarded = ev.marksAvailable / 2;
          status = "partial";
        } else if (status === "correct" && roll < -0.6) {
          awarded = 0;
          status = "missing";
        } else if (status === "missing" && roll > 0.5) {
          awarded = ev.marksAvailable / 2;
          status = "partial";
        } else if (status === "missing" && roll > 0.8) {
          awarded = ev.marksAvailable;
          status = "correct";
        } else if (status === "partial" && roll > 0.4) {
          awarded = ev.marksAvailable;
          status = "correct";
        }
        return {
          ...ev,
          marksAwarded: Math.max(0, Math.min(ev.marksAvailable, awarded)),
          status,
          confidence: 1,
        };
      });
      const awardedMarks = roundMarks(
        clonedEval.reduce((s, e) => s + e.marksAwarded, 0),
      );
      return {
        ...g,
        rubricEvaluation: clonedEval,
        awardedMarks,
        systemConfidence: 1,
        route: "auto_accept" as const,
        needsTeacherReview: false,
      };
    });

    // Recompute analytics + inject mistake tags
    const totalAwarded = roundMarks(
      clonedGrading.reduce((s, g) => s + g.awardedMarks, 0),
    );
    const totalMax = opts.exam.totalMarks;
    inferAll(clonedGrading);

    const runId = `${opts.exam.id}--${student.id}--seed-${randomUUID().slice(0, 6)}`;
    const runDir = path.join(opts.outputRoot, runId);
    await fs.mkdir(runDir, { recursive: true });

    const clonedResult: PipelineResult = {
      ...seed,
      runId,
      createdAt: releasedAt,
      examId: opts.exam.id,
      studentId: student.id,
      exam: opts.exam,
      grading: clonedGrading,
      analytics: {
        ...seed.analytics,
        totalAwarded,
        totalMax,
      },
      release: { releasedAt, releasedBy: "seed-script" },
    };
    await fs.writeFile(
      path.join(runDir, "evaluation.json"),
      JSON.stringify(clonedResult, null, 2),
    );
    runIds.push(runId);

    // Fake a prior test entry so "vs last test" renders
    const priorPct = clamp01Pct(
      (totalAwarded / totalMax) * 100 - 5 - rng() * 10,
    );
    const priorEntry: TestHistoryEntry = {
      runId: `mock-prev-${student.id}`,
      examId: `mock-prev-${opts.exam.id}`,
      examTitle: "Unit Test 1",
      subject: opts.exam.subject,
      class: opts.exam.class,
      awardedMarks: round1((priorPct * totalMax) / 100),
      maxMarks: totalMax,
      percentage: round1(priorPct),
      releasedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
    };
    await opts.historyStore.append(student.id, priorEntry);

    // Append THIS test to history too (so future runs can compute deltas)
    const thisEntry: TestHistoryEntry = {
      runId,
      examId: opts.exam.id!,
      examTitle: opts.exam.title,
      subject: opts.exam.subject,
      class: opts.exam.class,
      awardedMarks: totalAwarded,
      maxMarks: totalMax,
      percentage: round1((totalAwarded / totalMax) * 100),
      releasedAt,
    };
    await opts.historyStore.append(student.id, thisEntry);
  }

  return {
    students,
    runIds,
    requestedCount: opts.count,
    count: students.length,
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function biasForIndex(i: number): number {
  // Index 0 → +0.35 (top), index n → −0.35 (bottom), roughly linear
  return 0.35 - (i / MOCK_NAMES.length) * 0.7;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function clamp01Pct(v: number): number {
  return Math.max(5, Math.min(95, v));
}
