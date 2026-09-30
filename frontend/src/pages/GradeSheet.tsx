import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ExamConfig } from "../types";
import PageHeader from "../components/PageHeader";
import WorkflowNav from "../components/WorkflowNav";
type Sheet = {
  file: File;
  studentId: string;
  state: "ready" | "grading" | "done" | "error";
  runId?: string;
  error?: string;
};
type Run = {
  runId: string;
  studentId: string;
  name: string;
  totalAwarded: number;
  totalMax: number;
  releasedAt?: string;
  needsTeacherReview?: number;
};
export default function GradeSheet() {
  const { id } = useParams<{ id: string }>();
  const [exam, setExam] = useState<ExamConfig | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    Promise.all([
      fetch(`/exam/${id}`).then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "Could not load assessment.");
        return d.exam as ExamConfig;
      }),
      fetch(`/exam/${id}/students?includeUnreleased=1`).then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "Could not load student sheets.");
        return d.students as Run[];
      }),
    ])
      .then(([e, r]) => {
        if (live) {
          setExam(e);
          setRuns(r);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [id, reload]);
  const sum = exam?.questions.reduce((s, q) => s + q.maxMarks, 0) ?? 0;
  const valid =
    !!exam &&
    Math.abs(sum - exam.totalMarks) < 1e-6 &&
    exam.questions.every(
      (q) =>
        q.tags?.confirmedByTeacher &&
        q.rubric.length &&
        Math.abs(q.rubric.reduce((s, c) => s + c.marks, 0) - q.maxMarks) < 1e-6,
    );
  const approved = !!exam?.approval?.approvedAt && valid;
  async function grade(limit?: number) {
    if (
      sheets.some(
        (s) =>
          (s.state === "ready" || s.state === "error") &&
          s.studentId.trim() &&
          !/^[a-zA-Z0-9_-]{1,80}$/.test(s.studentId.trim()),
      )
    ) {
      setError(
        "Use up to 80 letters, numbers, hyphens or underscores for each student ID.",
      );
      return;
    }
    setBusy(true);
    setError("");
    const pending = sheets
      .map((sheet, index) => ({ sheet, index }))
      .filter(({ sheet }) => sheet.state === "ready" || sheet.state === "error")
      .slice(0, limit);
    try {
      for (const { sheet, index } of pending) {
        setSheets((cur) =>
          cur.map((s, i) =>
            i === index ? { ...s, state: "grading", error: undefined } : s,
          ),
        );
        try {
          const form = new FormData();
          form.append("pdf", sheet.file);
          if (sheet.studentId.trim())
            form.append("studentId", sheet.studentId.trim());
          const response = await fetch(`/exam/${id}/grade`, {
            method: "POST",
            body: form,
          });
          const d = await response.json();
          if (!response.ok || !d.runId)
            throw new Error(d.error ?? "This sheet could not be evaluated.");
          setSheets((cur) =>
            cur.map((s, i) =>
              i === index ? { ...s, state: "done", runId: d.runId } : s,
            ),
          );
        } catch (e) {
          setSheets((cur) =>
            cur.map((s, i) =>
              i === index
                ? { ...s, state: "error", error: (e as Error).message }
                : s,
            ),
          );
        }
      }
    } finally {
      setBusy(false);
      setReload((v) => v + 1);
    }
  }
  if (!exam)
    return (
      <div className="setup-page">
        <PageHeader breadcrumb="Assessment / Student sheets" />
        <p role={error ? "alert" : "status"}>
          {error || "Loading assessment…"}
        </p>
      </div>
    );
  const readyCount = sheets.filter(
    (s) => s.state === "ready" || s.state === "error",
  ).length;
  return (
    <>
      <PageHeader
        breadcrumb={
          <>
            Class {exam.class} · {exam.subject} · {exam.title}
          </>
        }
        actions={
          <Link className="button" to={`/exam/${id}/report`}>
            Test analysis
          </Link>
        }
      />
      <WorkflowNav examId={id} active="publish" />
      <div className="setup-page">
        <div className="setup-heading">
          <div>
            <h1>Evaluate the sheets. Review before release.</h1>
            <p>
              {exam.title} · {exam.questions.length} questions ·{" "}
              {exam.totalMarks} marks
            </p>
          </div>
          <span className={`setup-pill ${approved ? "good" : ""}`}>
            {approved ? "Scheme approved" : "Scheme needs review"}
          </span>
        </div>
        {!approved && (
          <p className="notice warning">
            {valid
              ? "Approve the marking scheme before uploading student answers."
              : "Check question marks, tags and rubric totals before evaluating sheets."}{" "}
            <Link to={`/exam/${id}/${valid ? "scheme" : "questions"}`}>
              Review the {valid ? "scheme" : "questions"} →
            </Link>
          </p>
        )}
        {error && (
          <p role="alert" className="notice error">
            {error}
          </p>
        )}
        <div className="upload-layout">
          <section className="setup-panel">
            <h2>Student answer sheets</h2>
            <p className="hint">
              Choose one PDF per student. Start with a trial, inspect its
              answers in a new tab, then return here to evaluate the rest.
            </p>
            <div className="field">
              <label htmlFor="student-pdfs">Add answer sheet PDFs</label>
              <input
                id="student-pdfs"
                type="file"
                accept="application/pdf"
                multiple
                disabled={!approved || busy}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  setSheets((cur) => [
                    ...cur,
                    ...files
                      .filter(
                        (file) =>
                          !cur.some(
                            (s) =>
                              s.file.name === file.name &&
                              s.file.size === file.size &&
                              s.file.lastModified === file.lastModified,
                          ),
                      )
                      .map((file) => ({
                        file,
                        studentId: "",
                        state: "ready" as const,
                      })),
                  ]);
                  e.target.value = "";
                }}
              />
            </div>
            <div className="grade-run-list">
              {sheets.map((sheet, index) => (
                <div
                  className="setup-panel"
                  key={`${sheet.file.name}-${index}`}
                >
                  <strong>{sheet.file.name}</strong>
                  <div className="field" style={{ marginTop: 12 }}>
                    <label htmlFor={`student-${index}`}>
                      Student ID or roll number (optional)
                    </label>
                    <input
                      id={`student-${index}`}
                      value={sheet.studentId}
                      maxLength={80}
                      pattern="[a-zA-Z0-9_-]+"
                      disabled={busy || sheet.state === "done"}
                      placeholder="Use the same ID to track progress across tests"
                      onChange={(e) =>
                        setSheets((cur) =>
                          cur.map((s, i) =>
                            i === index
                              ? { ...s, studentId: e.target.value }
                              : s,
                          ),
                        )
                      }
                    />
                  </div>
                  {sheet.state === "grading" && (
                    <p role="status">
                      Reading and marking this sheet. Keep the page open.
                    </p>
                  )}
                  {sheet.runId && (
                    <div className="setup-actions">
                      <Link
                        className="button primary"
                        to={`/review/${sheet.runId}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Review answers ↗ (new tab)
                      </Link>
                      <span className="hint">Not released yet</span>
                    </div>
                  )}
                  {sheet.state !== "grading" && !busy && (
                    <button
                      style={{ marginTop: 12 }}
                      onClick={() =>
                        setSheets((cur) => cur.filter((_, i) => i !== index))
                      }
                    >
                      {sheet.state === "done"
                        ? "Clear from queue"
                        : "Remove sheet"}
                    </button>
                  )}
                  {sheet.error && (
                    <p className="notice error" role="alert">
                      {sheet.error}
                    </p>
                  )}
                </div>
              ))}
            </div>
            <div className="setup-actions">
              <button
                className="primary"
                disabled={!approved || busy || !readyCount}
                onClick={() => grade(1)}
              >
                {busy ? "Evaluating…" : "Trial on one sheet"}
              </button>
              {readyCount > 1 && (
                <button
                  disabled={!approved || busy || !readyCount}
                  onClick={() => grade()}
                >
                  Evaluate all {readyCount} sheets
                </button>
              )}
            </div>
          </section>
          <aside className="setup-panel upload-explanation">
            <h2>What happens next</h2>
            <ol>
              <li>
                <strong>Compare paper and feedback</strong>
                <p>
                  Numbered markers take you to the matching answer. Review
                  flagged decisions and change marks where needed.
                </p>
              </li>
              <li>
                <strong>Approve and release</strong>
                <p>
                  Students and parents cannot open a report until you release
                  it.
                </p>
              </li>
              <li>
                <strong>Plan the next lesson</strong>
                <p>
                  Use the class matrix to see patterns and prepare follow-up
                  groups.
                </p>
              </li>
            </ol>
          </aside>
        </div>
        <section className="setup-panel" style={{ marginTop: 24 }}>
          <h2>Sheets ready to review</h2>
          {runs.length ? (
            <div className="grade-run-list">
              {runs.map((run) => (
                <div className="grade-run-item" key={run.runId}>
                  <div>
                    <strong>{run.name || run.studentId}</strong>
                    <p className="hint">
                      {run.totalAwarded} / {run.totalMax} ·{" "}
                      {run.releasedAt
                        ? "Released"
                        : `${run.needsTeacherReview ?? 0} answers need review`}
                    </p>
                  </div>
                  <Link className="button" to={`/review/${run.runId}`}>
                    Open answers →
                  </Link>
                </div>
              ))}
            </div>
          ) : (
            <p className="hint">
              Evaluated sheets will appear here, including those waiting for
              your approval.
            </p>
          )}
        </section>
      </div>
    </>
  );
}
