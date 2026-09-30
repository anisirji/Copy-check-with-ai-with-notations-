import { assertStorageId } from "./file-store.js";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  ClassMatrix,
  ClassReport,
  ExamConfig,
  MistakeTag,
  PipelineResult,
  Student,
  StudentReport,
  TestHistoryEntry,
} from "../types.js";
import { HistoryStore } from "./history-store.js";
import { StudentStore } from "./student-store.js";
import { roundMarks } from "./exam-marks.js";

/**
 * Use one released evaluation per student, choosing the latest release and
 * then creation time. An optional exam snapshot limits comparisons to the
 * same question/criterion allocations, including after merges or rescaling.
 */
export async function loadExamRuns(
  outputRoot: string,
  examId: string,
  exam?: ExamConfig,
  options: { includeUnreleased?: boolean } = {},
): Promise<PipelineResult[]> {
  assertStorageId(examId, "exam id");
  const dirs = await fs.readdir(outputRoot, { withFileTypes: true });
  const latest = new Map<string, PipelineResult>();
  const signature = exam ? marksSignature(exam) : null;
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    if (!d.name.startsWith(`${examId}--`)) continue;
    try {
      const raw = await fs.readFile(
        path.join(outputRoot, d.name, "evaluation.json"),
        "utf-8",
      );
      const doc = JSON.parse(raw) as PipelineResult;
      if (!options.includeUnreleased && !doc.release?.releasedAt) continue;
      if ((doc.examId ?? doc.exam?.id) !== examId) continue;
      // Old evaluations may have a stale teacher total in their snapshot;
      // the actual graded maximum is the historical denominator.
      const analyzedTotal = doc.analytics.totalMax;
      if (
        signature &&
        marksSignature({ ...doc.exam, totalMarks: analyzedTotal }) !== signature
      )
        continue;
      const studentKey = doc.studentId
        ? `student:${doc.studentId}`
        : `run:${doc.runId}`;
      const previous = latest.get(studentKey);
      const compare = options.includeUnreleased
        ? compareCreated
        : compareRelease;
      if (!previous || compare(doc, previous) > 0) latest.set(studentKey, doc);
    } catch {
      /* skip */
    }
  }
  return [...latest.values()].sort(
    options.includeUnreleased ? compareCreated : compareRelease,
  );
}

function compareCreated(a: PipelineResult, b: PipelineResult): number {
  return (
    (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0) ||
    compareRelease(a, b)
  );
}

function marksSignature(exam: ExamConfig): string {
  return JSON.stringify({
    totalMarks: roundMarks(exam.totalMarks),
    questions: exam.questions
      .map((q) => ({
        id: q.id,
        maxMarks: roundMarks(q.maxMarks),
        rubric: q.rubric
          .map((c) => ({ id: c.id, marks: roundMarks(c.marks) }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}

function compareRelease(a: PipelineResult, b: PipelineResult): number {
  const timestamp = (value?: string) => Date.parse(value ?? "") || 0;
  return (
    timestamp(a.release?.releasedAt) - timestamp(b.release?.releasedAt) ||
    timestamp(a.createdAt) - timestamp(b.createdAt) ||
    a.runId.localeCompare(b.runId)
  );
}

/** An exam ID represents one sitting: every regrade/release with that ID is
 * a revision, even on a later date. A separate sitting needs a new exam ID.
 * This keeps corrections out of the "previous test" comparison. */
function priorTests(
  history: TestHistoryEntry[],
  run: PipelineResult,
): TestHistoryEntry[] {
  const examId = run.examId ?? run.exam.id;
  const cutoff = Date.parse(run.release?.releasedAt ?? run.createdAt);
  const latest = new Map<string, TestHistoryEntry>();
  for (const entry of history) {
    if (entry.runId === run.runId || entry.examId === examId) continue;
    const releasedAt = Date.parse(entry.releasedAt);
    if (!Number.isFinite(releasedAt) || releasedAt > cutoff) continue;
    const key = entry.examId || entry.runId;
    const previous = latest.get(key);
    if (!previous || releasedAt >= Date.parse(previous.releasedAt))
      latest.set(key, entry);
  }
  return [...latest.values()].sort(
    (a, b) => Date.parse(a.releasedAt) - Date.parse(b.releasedAt),
  );
}

// Topic allocations are proportional shares, which can be smaller than one
// mark unit when a .01-mark question has several topic tags. For example,
// .01 shared by three topics retains .0033 per topic rather than rounding to 0.
function roundTopicMarks(value: number): number {
  return value > 0 && value < 0.01
    ? Number(value.toPrecision(2))
    : roundMarks(value);
}

// ─── ClassReport ─────────────────────────────────────────────────────────────

export async function buildClassReport(
  exam: ExamConfig,
  outputRoot: string,
  studentStore: StudentStore,
  historyStore: HistoryStore,
): Promise<ClassReport> {
  const runs = await loadExamRuns(outputRoot, exam.id!, exam);
  const students = await studentStore.list(exam.class);

  const totalMax = exam.totalMarks;
  const scores = runs.map((r) => r.analytics.totalAwarded);
  const average = mean(scores);
  const highest = scores.length ? Math.max(...scores) : 0;
  const lowest = scores.length ? Math.min(...scores) : 0;
  const aboveAverageCount = scores.filter((s) => s > average).length;

  // Band histogram in tens
  const bands = [
    { band: "0–10", lo: 0, hi: 10 },
    { band: "10.01–20", lo: 10.01, hi: 20 },
    { band: "20.01–30", lo: 20.01, hi: 30 },
    { band: "30.01–40", lo: 30.01, hi: 40 },
    { band: "40.01+", lo: 40.01, hi: Infinity },
  ];
  const bandCounts = bands
    .filter((b) => totalMax >= b.lo)
    .map((b) => ({
      band: b.band,
      count: scores.filter((s) => s >= b.lo && s <= b.hi).length,
    }));

  // Weight reasons by marks actually lost, rather than counting criteria.
  const reasonCounts = new Map<MistakeTag | "correct", number>();
  let totalLostMarks = 0;
  for (const r of runs) {
    for (const g of r.grading) {
      for (const ev of g.rubricEvaluation) {
        const lost = Math.max(0, ev.marksAvailable - ev.marksAwarded);
        if (!lost) continue;
        totalLostMarks += lost;
        const tag = ev.mistakeTag ?? "concept_gap";
        reasonCounts.set(tag, (reasonCounts.get(tag) ?? 0) + lost);
      }
    }
  }
  const markLossReasons = Array.from(reasonCounts.entries())
    .map(([reason, count]) => ({
      reason: reason as MistakeTag,
      percentage:
        totalLostMarks > 0 ? round0((count / totalLostMarks) * 100) : 0,
    }))
    .sort((a, b) => b.percentage - a.percentage);

  // Difficulty breakdown: for each difficulty, marks earned / marks available across the class
  const difficulties: Array<"easy" | "medium" | "hard"> = [
    "easy",
    "medium",
    "hard",
  ];
  const difficultyBreakdown = difficulties
    .map((d) => {
      const qs = exam.questions.filter((q) => q.tags?.difficulty === d);
      const marksAvail = qs.reduce((s, q) => s + q.maxMarks, 0) * runs.length;
      const marksEarned = runs.reduce(
        (sum, r) =>
          sum +
          r.grading
            .filter((g) => qs.some((q) => q.id === g.questionId))
            .reduce((s2, g) => s2 + g.awardedMarks, 0),
        0,
      );
      return {
        difficulty: d,
        marksAvailable: roundMarks(qs.reduce((s, q) => s + q.maxMarks, 0)),
        marksEarnedPct:
          marksAvail > 0 ? round0((marksEarned / marksAvail) * 100) : 0,
      };
    })
    .filter((d) => d.marksAvailable > 0);

  // Topic coverage: for each topic (from question tags), aggregate marks
  const topicMap = new Map<
    string,
    { chapter: string; marksAvailable: number; marksEarned: number }
  >();
  for (const q of exam.questions) {
    const topics = q.tags?.topics ?? ["Unclassified"];
    for (const topic of topics) {
      const key = topic;
      const existing = topicMap.get(key) ?? {
        chapter: q.tags?.chapter ?? "—",
        marksAvailable: 0,
        marksEarned: 0,
      };
      const share = 1 / topics.length; // split marks equally across topics
      existing.marksAvailable += q.maxMarks * share;
      const questionEarnings = runs.reduce(
        (sum, r) =>
          sum +
          (r.grading.find((g) => g.questionId === q.id)?.awardedMarks ?? 0),
        0,
      );
      existing.marksEarned += questionEarnings * share;
      topicMap.set(key, existing);
    }
  }
  const topicCoverage = Array.from(topicMap.entries())
    .map(([topic, v]) => {
      const availTotal = v.marksAvailable * runs.length;
      const pct =
        availTotal > 0 ? round0((v.marksEarned / availTotal) * 100) : 0;
      return {
        topic,
        chapter: v.chapter,
        marksAvailable: roundTopicMarks(v.marksAvailable),
        marksEarnedPct: pct,
        read: readFromPct(pct),
      };
    })
    .sort((a, b) => a.marksEarnedPct - b.marksEarnedPct);

  // Full-correct students and marks earned are separate measures.
  const questionSummary = exam.questions.map((q) => {
    const evals = runs.map((r) => r.grading.find((g) => g.questionId === q.id));
    const fullCount = evals.filter(
      (g) => g && g.awardedMarks === q.maxMarks,
    ).length;
    const totalPossible = q.maxMarks * runs.length;
    const totalEarned = evals.reduce((s, g) => s + (g?.awardedMarks ?? 0), 0);
    const pct =
      totalPossible > 0 ? round0((totalEarned / totalPossible) * 100) : 0;
    return {
      questionId: q.id,
      concept: q.rubric[0]?.concept ?? q.prompt.slice(0, 60),
      difficulty: (q.tags?.difficulty ?? "medium") as
        | "easy"
        | "medium"
        | "hard",
      maxMarks: q.maxMarks,
      fullMarksCount: fullCount,
      classCorrectPct: runs.length
        ? round0((fullCount / runs.length) * 100)
        : 0,
      marksEarnedPct: pct,
      read: readFromPct(runs.length ? (fullCount / runs.length) * 100 : 0),
    };
  });

  // Known drops first; students without history follow, lowest score first.
  // Missing history is not evidence of a zero change.
  const withHistory = await Promise.all(
    runs.map(async (r) => {
      const student = students.find((s) => s.id === r.studentId);
      const name = student?.name ?? r.studentId ?? "—";
      const history = r.studentId ? await historyStore.list(r.studentId) : [];
      const prev = priorTests(history, r).at(-1);
      const deltaVsLast = prev
        ? r.analytics.totalAwarded - (prev.percentage * totalMax) / 100
        : null;
      const weakest = r.grading
        .flatMap((g) =>
          g.rubricEvaluation.filter((e) => e.status !== "correct"),
        )
        .sort((a, b) => b.marksAvailable - a.marksAvailable)[0];
      return {
        studentId: r.studentId ?? "",
        name,
        score: r.analytics.totalAwarded,
        maxMarks: totalMax,
        deltaVsLast: deltaVsLast === null ? null : roundMarks(deltaVsLast),
        weakestConcept: weakest?.concept ?? "—",
      };
    }),
  );
  const studentsToLookAtFirst = withHistory
    .filter((s) => s.score < average || (s.deltaVsLast ?? 0) < 0)
    .sort(
      (a, b) =>
        Number(a.deltaVsLast === null) - Number(b.deltaVsLast === null) ||
        (a.deltaVsLast ?? 0) - (b.deltaVsLast ?? 0) ||
        a.score - b.score ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 5);

  return {
    examId: exam.id!,
    exam: {
      title: exam.title,
      subject: exam.subject,
      class: exam.class,
      totalMarks: exam.totalMarks,
      questionCount: exam.questions.length,
      conductedAt: exam.createdAt,
    },
    studentsAppeared: runs.length,
    studentsTotal: Math.max(students.length, runs.length),
    average: roundMarks(average),
    averagePct: totalMax > 0 ? round1((average / totalMax) * 100) : 0,
    highest,
    lowest,
    spread: roundMarks(highest - lowest),
    aboveAverageCount,
    syllabusCoveredPct: null, // No syllabus-wide topic denominator is stored.
    bandCounts,
    markLossReasons,
    difficultyBreakdown,
    topicCoverage,
    questionSummary,
    studentsToLookAtFirst,
  };
}

// ─── ClassMatrix ─────────────────────────────────────────────────────────────

export async function buildClassMatrix(
  exam: ExamConfig,
  outputRoot: string,
  studentStore: StudentStore,
  historyStore: HistoryStore,
): Promise<ClassMatrix> {
  const runs = await loadExamRuns(outputRoot, exam.id!, exam);
  const students = await studentStore.list(exam.class);

  const questions = exam.questions.map((q) => ({
    id: q.id,
    maxMarks: q.maxMarks,
    concept: q.rubric[0]?.concept ?? q.prompt.slice(0, 40),
  }));

  const rows = await Promise.all(
    runs.map(async (r) => {
      const s = students.find((x) => x.id === r.studentId);
      const name = s?.name ?? r.studentId ?? "—";
      const perQuestion = exam.questions.map((q) => {
        const g = r.grading.find((x) => x.questionId === q.id);
        const awarded = g?.awardedMarks ?? 0;
        const kind: "full" | "partial" | "none" =
          awarded === q.maxMarks ? "full" : awarded > 0 ? "partial" : "none";
        return { questionId: q.id, awarded, max: q.maxMarks, kind };
      });
      const history = r.studentId ? await historyStore.list(r.studentId) : [];
      const prev = priorTests(history, r).at(-1);
      const vsLast = prev
        ? roundMarks(
            r.analytics.totalAwarded -
              (prev.percentage * exam.totalMarks) / 100,
          )
        : null;
      return {
        studentId: r.studentId ?? "",
        name,
        perQuestion,
        total: r.analytics.totalAwarded,
        vsLast,
      };
    }),
  );

  rows.sort((a, b) => b.total - a.total);

  const classPctByQuestion = exam.questions.map((q) => {
    const totalEarned = runs.reduce(
      (s, r) =>
        s + (r.grading.find((g) => g.questionId === q.id)?.awardedMarks ?? 0),
      0,
    );
    const totalPossible = q.maxMarks * runs.length;
    return {
      questionId: q.id,
      pct: totalPossible > 0 ? round0((totalEarned / totalPossible) * 100) : 0,
    };
  });

  // Grouping rule (from PDF):
  //   Rebuild: bottom third (total < 40% of max, or biggest drops)
  //   Consolidate: middle band (40-75%)
  //   Extend: top (>=75%)
  const groups: ClassMatrix["groups"] = {
    rebuild: [],
    consolidate: [],
    extend: [],
  };
  for (const r of rows) {
    const pct = exam.totalMarks > 0 ? (r.total / exam.totalMarks) * 100 : 0;
    const bucket = pct >= 75 ? "extend" : pct >= 40 ? "consolidate" : "rebuild";
    groups[bucket].push({ studentId: r.studentId, name: r.name });
  }

  return {
    examId: exam.id!,
    questions,
    rows,
    classPctByQuestion,
    groups,
  };
}

// ─── StudentReport ───────────────────────────────────────────────────────────

export async function buildStudentReport(
  run: PipelineResult,
  exam: ExamConfig,
  outputRoot: string,
  studentStore: StudentStore,
  historyStore: HistoryStore,
): Promise<StudentReport> {
  // An individual report always describes the evaluated snapshot, even if
  // its saved exam has since been normalized, merged, or edited.
  exam = {
    ...run.exam,
    id: run.exam.id ?? run.examId ?? exam.id,
    totalMarks: run.analytics.totalMax,
  };
  const runs = await loadExamRuns(outputRoot, exam.id!, exam);
  const students = await studentStore.list(exam.class);
  const student: Student = (run.studentId
    ? students.find((s) => s.id === run.studentId)
    : undefined) ?? {
    id: run.studentId ?? "unknown",
    name: run.studentId ?? "Unknown",
    class: exam.class,
  };

  const awarded = run.analytics.totalAwarded;
  const max = exam.totalMarks;
  const percentage = max > 0 ? round1((awarded / max) * 100) : 0;

  // Class stats from released runs
  const scores = runs
    .map((r) => r.analytics.totalAwarded)
    .sort((a, b) => b - a);
  const average = mean(scores);
  const classAverage = roundMarks(average);
  const classAveragePct = max > 0 ? round1((average / max) * 100) : 0;
  const position = scores.findIndex((s) => s === awarded) + 1;
  const highest = scores[0] ?? 0;

  // History deltas
  const history = run.studentId ? await historyStore.list(run.studentId) : [];
  const historyWithout = priorTests(history, run);
  const prev = historyWithout.at(-1);
  const prevPrev = historyWithout.at(-2);

  const sinceLastTestMarks = prev
    ? roundMarks(awarded - (prev.percentage * max) / 100)
    : null;
  const sinceLastTestPct = prev ? round1(percentage - prev.percentage) : null;
  const sinceTwoTestsAgoMarks = prevPrev
    ? roundMarks(awarded - (prevPrev.percentage * max) / 100)
    : null;
  const sinceTwoTestsAgoPct = prevPrev
    ? round1(percentage - prevPrev.percentage)
    : null;

  const averageBeforePct = historyWithout.length
    ? round1(mean(historyWithout.map((h) => h.percentage)))
    : null;
  const averageNowPct =
    averageBeforePct !== null
      ? round1(
          (historyWithout.reduce((s, h) => s + h.percentage, 0) + percentage) /
            (historyWithout.length + 1),
        )
      : null;
  const valueAdded =
    averageBeforePct !== null ? percentage >= averageBeforePct : null;

  const lastThreeTests = [
    ...historyWithout.slice(-2),
    {
      runId: run.runId,
      examId: exam.id!,
      examTitle: exam.title,
      subject: exam.subject,
      class: exam.class,
      awardedMarks: awarded,
      maxMarks: max,
      percentage,
      releasedAt: run.release?.releasedAt ?? new Date().toISOString(),
    },
  ].map((h) => ({
    label: h.examTitle,
    awarded: h.awardedMarks,
    max: h.maxMarks,
    pct: round1(h.percentage),
  }));

  // Topic performance
  const topicMap = new Map<string, { awarded: number; max: number }>();
  for (const q of exam.questions) {
    const topics = q.tags?.topics ?? ["Unclassified"];
    const g = run.grading.find((x) => x.questionId === q.id);
    const share = 1 / topics.length;
    for (const t of topics) {
      const cur = topicMap.get(t) ?? { awarded: 0, max: 0 };
      cur.max += q.maxMarks * share;
      cur.awarded += (g?.awardedMarks ?? 0) * share;
      topicMap.set(t, cur);
    }
  }
  const topicPerformance = Array.from(topicMap.entries())
    .map(([topic, v]) => {
      const pct = v.max > 0 ? (v.awarded / v.max) * 100 : 0;
      return {
        topic,
        awarded: roundTopicMarks(v.awarded),
        max: roundTopicMarks(v.max),
        read: (pct >= 75
          ? "strong"
          : pct >= 50
            ? "on-track"
            : "needs-focus") as "strong" | "on-track" | "needs-focus",
      };
    })
    .sort((a, b) => b.awarded / b.max - a.awarded / a.max);

  // Lost-marks table
  const lostMarks = run.grading
    .filter((g) => g.awardedMarks < g.maxMarks)
    .map((g) => {
      const q = exam.questions.find((x) => x.id === g.questionId);
      const failed = g.rubricEvaluation.find((e) => e.status !== "correct");
      const classAvg = mean(
        runs.map(
          (r) =>
            r.grading.find((x) => x.questionId === g.questionId)
              ?.awardedMarks ?? 0,
        ),
      );
      return {
        questionId: g.questionId,
        concept: failed?.concept ?? q?.rubric[0]?.concept ?? "—",
        studentMarks: g.awardedMarks,
        classAverageMarks: roundMarks(classAvg),
        maxMarks: g.maxMarks,
        whatWentWrong: g.teacherComment || whatWentWrong(g.rubricEvaluation),
      };
    })
    .sort((a, b) => b.maxMarks - b.studentMarks - (a.maxMarks - a.studentMarks))
    .slice(0, 5);

  // Next actions — derived from biggest losses
  const nextActions: StudentReport["nextActions"] = [];
  const primary = lostMarks[0];
  if (primary) {
    nextActions.push({
      priority: "first",
      title: primary.concept,
      detail: `Worth ${roundMarks(primary.maxMarks - primary.studentMarks)} marks in this test. Focus practice here first.`,
      assignment: `Suggested: ${Math.max(6, Math.ceil(primary.maxMarks * 2))} practice questions`,
    });
  }
  const secondary = lostMarks[1];
  if (secondary) {
    nextActions.push({
      priority: "then",
      title: secondary.concept,
      detail: secondary.whatWentWrong,
      assignment: `Suggested: ${Math.max(4, Math.ceil(secondary.maxMarks))} timed questions`,
    });
  }
  const strong = topicPerformance[0];
  if (strong && strong.read === "strong") {
    nextActions.push({
      priority: "keep-going",
      title: `Move ahead on ${strong.topic}`,
      detail:
        "Strong enough to start the next level: board-pattern application.",
      assignment: "Suggested: advanced application practice",
    });
  }

  return {
    runId: run.runId,
    acknowledgment: run.acknowledgment,
    teacherRemark: run.teacherRemark,
    student,
    exam: {
      id: exam.id!,
      title: exam.title,
      subject: exam.subject,
      class: exam.class,
      conductedAt: exam.createdAt,
      maxMarks: max,
    },
    awardedMarks: awarded,
    percentage,
    classAverage,
    classAveragePct,
    positionInClass: position,
    classSize: scores.length,
    highestInClass: highest,
    aboveAverageBy: roundMarks(awarded - average),
    averageBeforePct,
    averageNowPct,
    valueAdded,
    lastThreeTests,
    sinceLastTestMarks,
    sinceLastTestPct,
    sinceTwoTestsAgoMarks,
    sinceTwoTestsAgoPct,
    classPositionMovedFrom: null, // POC: would need per-run rank history to compute
    topicPerformance,
    lostMarks,
    nextActions,
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}
function round0(v: number): number {
  return Math.round(v);
}
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function readFromPct(pct: number): "secure" | "shaky" | "re-teach" {
  if (pct >= 70) return "secure";
  if (pct >= 50) return "shaky";
  return "re-teach";
}
function whatWentWrong(
  evals: { status: string; concept: string; evidence?: string }[],
): string {
  const first = evals.find((e) => e.status !== "correct");
  if (!first) return "";
  return first.evidence
    ? `${first.concept} — evidence: "${first.evidence}"`
    : first.concept;
}
