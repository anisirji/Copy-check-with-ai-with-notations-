/**
 * Drive one test case pair (question paper + cleaned answer sheet) through
 * the full flow against a running backend:
 *
 *   1) POST /exam/generate           — build exam from question paper
 *   2) POST /exam/:id/normalize-marks — scale sum(question) to header total
 *   3) POST /exam/:id/approve        — clear R1 gate
 *   4) POST /exam/:id/grade          — run the pipeline on the answer sheet
 *   5) POST /run/:runId/release      — clear R2 gate (optional)
 *
 * Usage:
 *   pnpm tsx scripts/run-test-cases.ts <case-dir> [--label=x] [--subject=biology] [--class=8] [--total=20] [--release]
 *   pnpm tsx scripts/run-test-cases.ts --all
 *
 * `--all` iterates every subdirectory under test-cases/.
 */
import fs from "node:fs/promises";
import path from "node:path";

const BASE = process.env.BACKEND_URL ?? "http://localhost:8090";

interface CaseDefaults {
  label: string;
  subject: string;
  total: number;
  className: string;
  title: string;
  release: boolean;
  chapter: string;
}

const CASE_PROFILES: Record<string, Omit<CaseDefaults, "label">> = {
  biology: {
    subject: "biology",
    total: 20,
    className: "8",
    title: "Biology Unit Test",
    release: true,
    chapter: "Ecosystems",
  },
  mathematics: {
    subject: "math",
    total: 20,
    className: "8",
    title: "Mathematics Unit Test",
    release: true,
    chapter: "Mensuration",
  },
  gk: {
    subject: "general",
    total: 30,
    className: "7",
    title: "GK First Term",
    release: true,
    chapter: "General Knowledge",
  },
  "moral-science": {
    subject: "general",
    total: 20,
    className: "7",
    title: "Moral Science First Term",
    release: true,
    chapter: "Values & Choices",
  },
  sanskrit: {
    subject: "general",
    total: 20,
    className: "7",
    title: "Sanskrit First Term",
    release: true,
    chapter: "Shabda Roopa",
  },
};

async function postForm(url: string, form: FormData): Promise<any> {
  const res = await fetch(url, { method: "POST", body: form });
  const body = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${url}: ${body}`);
  return JSON.parse(body);
}
async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${url}: ${text}`);
  return text ? JSON.parse(text) : {};
}
async function patchJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${url}: ${text}`);
  return text ? JSON.parse(text) : {};
}
async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${url}: ${text}`);
  return JSON.parse(text);
}

async function fileFromDisk(file: string, filename: string): Promise<File> {
  const bytes = await fs.readFile(file);
  return new File([bytes], filename, { type: "application/pdf" });
}
async function pollForRunId(
  outputRoot: string,
  prefix: string,
  timeoutMs = 60_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const dirs = (await fs.readdir(outputRoot, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && d.name.startsWith(prefix))
        .map((d) => d.name)
        .sort();
      if (dirs.length > 0) return dirs[dirs.length - 1];
    } catch {
      // outputRoot may not exist yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no run directory appeared with prefix ${prefix}`);
}
async function pollForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stat = await fs.stat(file);
      if (stat.size > 0) return;
    } catch {
      // not there yet
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error(`file did not appear within ${timeoutMs}ms: ${file}`);
}

async function driveCase(
  caseDir: string,
  defaults: CaseDefaults,
): Promise<{
  examId: string;
  runId: string;
}> {
  const questionsPdf = path.join(caseDir, `${defaults.label}-questions.pdf`);
  const answersPdf = path.join(caseDir, `${defaults.label}-clean.pdf`);
  for (const f of [questionsPdf, answersPdf]) {
    await fs.access(f);
  }

  // 1. Generate exam from the reconstructed question paper
  console.log(`[${defaults.label}] uploading question paper…`);
  const gen = new FormData();
  gen.append(
    "paper",
    await fileFromDisk(questionsPdf, path.basename(questionsPdf)),
  );
  gen.append(
    "meta",
    JSON.stringify({
      title: defaults.title,
      subject: defaults.subject,
      class: defaults.className,
      totalMarks: defaults.total,
    }),
  );
  const genRes = await postForm(`${BASE}/exam/generate`, gen);
  const examId = genRes.exam.id;
  const questions: { id: string; maxMarks: number; subject?: string }[] =
    genRes.exam.questions ?? [];
  console.log(
    `[${defaults.label}] exam id = ${examId} (${questions.length} questions, sum=${questions.reduce((s, q) => s + q.maxMarks, 0)})`,
  );

  // 2. Normalize marks so sum(question.maxMarks) == defaults.total
  const sum = questions.reduce((s, q) => s + q.maxMarks, 0);
  if (sum !== defaults.total) {
    await postJson(`${BASE}/exam/${examId}/normalize-marks`, {
      totalMarks: defaults.total,
    });
    console.log(
      `[${defaults.label}] marks normalized ${sum} → ${defaults.total}.`,
    );
  }

  // 3. Confirm tags + scheme-approve each question (single PATCH per question).
  //    Simple defaults per profile — good enough for the demo, teacher can edit in UI.
  for (const q of questions) {
    const topic =
      q.subject && q.subject !== "general"
        ? [defaults.chapter, q.subject].filter(Boolean).join(" · ")
        : defaults.chapter;
    await patchJson(
      `${BASE}/exam/${examId}/questions/${encodeURIComponent(q.id)}`,
      {
        tags: {
          chapter: defaults.chapter,
          topics: [topic],
          difficulty: "medium",
          confirmedByTeacher: true,
        },
        schemeApproved: true,
      },
    );
  }
  console.log(`[${defaults.label}] tags + scheme approvals set.`);

  // 4. Confirm evaluation rules
  const examNow = (await getJson(`${BASE}/exam/${examId}`)).exam;
  await patchJson(`${BASE}/exam/${examId}/rules`, {
    evaluationRules: { ...examNow.evaluationRules, confirmed: true },
  });

  // 5. Approve marking scheme (clears R1)
  await postJson(`${BASE}/exam/${examId}/approve`, {
    approvedBy: "test-runner",
  });
  console.log(`[${defaults.label}] scheme approved.`);

  // 6. Grade the cleaned answer sheet.
  //    The pipeline can take several minutes; the request often exceeds the
  //    default undici socket timeout. We fire the POST and, once the run
  //    directory exists, poll for evaluation.json instead of blocking the
  //    fetch. The pipeline continues server-side regardless.
  console.log(`[${defaults.label}] grading student sheet…`);
  const studentId = `${defaults.label}-demo`;
  const outputRoot = path.resolve("../output");
  const runIdPrefix = `${examId}--${studentId}--`;

  const grade = new FormData();
  grade.append(
    "pdf",
    await fileFromDisk(answersPdf, path.basename(answersPdf)),
  );
  grade.append("studentId", studentId);

  const gradePromise = fetch(`${BASE}/exam/${examId}/grade`, {
    method: "POST",
    body: grade,
    signal: AbortSignal.timeout(20 * 60 * 1000),
  })
    .then(async (res) => {
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status} grade: ${text}`);
      return JSON.parse(text) as { runId: string };
    })
    .catch((err) => ({ error: err as Error }));

  const runId = await pollForRunId(outputRoot, runIdPrefix);
  console.log(
    `[${defaults.label}] runId = ${runId}, waiting for evaluation.json…`,
  );
  await pollForFile(
    path.join(outputRoot, runId, "evaluation.json"),
    25 * 60_000,
  );
  const finished = await gradePromise;
  if ("error" in finished) {
    console.log(
      `[${defaults.label}] (grade POST returned "${finished.error.message}" — pipeline completed on disk anyway)`,
    );
  }
  console.log(`[${defaults.label}] evaluation.json written.`);

  // 7. Auto-accept every question (clears needsTeacherReview) so release passes.
  //    In a real classroom the teacher does this manually per question in the
  //    review UI — for the demo we simulate it. Preserves the AI-awarded marks.
  const evalDoc = await getJson(`${BASE}/run/${runId}`);
  for (const g of evalDoc.grading ?? []) {
    if (!g.needsTeacherReview) continue;
    await patchJson(`${BASE}/run/${runId}/grading`, {
      questionId: g.questionId,
      approve: true,
    });
  }
  console.log(`[${defaults.label}] auto-accepted teacher-review flags.`);

  // 8. Release so the /student view + reports can be opened
  if (defaults.release) {
    try {
      await postJson(`${BASE}/run/${runId}/release`, {
        releasedBy: "test-runner",
      });
      console.log(`[${defaults.label}] released.`);
    } catch (err) {
      console.warn(
        `[${defaults.label}] release skipped: ${(err as Error).message}`,
      );
    }
  }

  return { examId, runId };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const wantAll = args.includes("--all");
  const positional = args.filter((a) => !a.startsWith("--"));
  const label = args.find((a) => a.startsWith("--label="))?.split("=")[1];
  const subject = args.find((a) => a.startsWith("--subject="))?.split("=")[1];
  const totalRaw = args.find((a) => a.startsWith("--total="))?.split("=")[1];
  const className = args.find((a) => a.startsWith("--class="))?.split("=")[1];
  const release = !args.includes("--no-release");

  const results: { label: string; examId: string; runId: string }[] = [];

  const cases: { dir: string; defaults: CaseDefaults }[] = [];
  if (wantAll) {
    const root = path.resolve("../test-cases");
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const profile = CASE_PROFILES[entry.name];
      if (!profile) continue;
      cases.push({
        dir: path.join(root, entry.name),
        defaults: { ...profile, label: entry.name },
      });
    }
  } else {
    if (positional.length < 1) {
      console.error("usage: run-test-cases <case-dir> | --all");
      process.exit(1);
    }
    const dir = path.resolve(positional[0]);
    const derivedLabel = label ?? path.basename(dir);
    const profile = CASE_PROFILES[derivedLabel] ?? {
      subject: subject ?? "general",
      total: totalRaw ? Number(totalRaw) : 20,
      className: className ?? "8",
      title: `${derivedLabel} test`,
      release,
      chapter: derivedLabel,
    };
    cases.push({
      dir,
      defaults: {
        ...profile,
        label: derivedLabel,
        subject: subject ?? profile.subject,
        total: totalRaw ? Number(totalRaw) : profile.total,
        className: className ?? profile.className,
        release,
      },
    });
  }

  for (const c of cases) {
    try {
      const out = await driveCase(c.dir, c.defaults);
      results.push({ label: c.defaults.label, ...out });
    } catch (err) {
      console.error(`[${c.defaults.label}] FAILED:`, (err as Error).message);
    }
  }

  console.log("\n=== summary ===");
  for (const r of results) {
    console.log(
      `  ${r.label}: exam=${r.examId}\n    review → http://localhost:5190/review/${r.runId}\n    analysis → http://localhost:5190/exam/${r.examId}/report`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
