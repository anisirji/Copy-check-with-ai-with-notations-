import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ExamConfig, Question, QuestionDifficulty } from "../types";
import PageHeader from "../components/PageHeader";
import WorkflowNav from "../components/WorkflowNav";
import QuestionPaper from "../components/QuestionPaper";

type Draft = {
  prompt: string;
  chapter: string;
  topics: string;
  difficulty: QuestionDifficulty;
  maxMarks: string;
  dirty: boolean;
  error?: string;
};
const draftFor = (q: Question): Draft => ({
  prompt: q.prompt,
  chapter: q.tags?.chapter ?? "",
  topics: q.tags?.topics.join(", ") ?? "",
  difficulty: q.tags?.difficulty ?? "medium",
  maxMarks: String(q.maxMarks),
  dirty: false,
});
const rounded = (n: number) => Math.round(n * 100) / 100;
const validMarks = (n: number) =>
  Number.isFinite(n) && n > 0 && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
const parentId = (id: string) =>
  id
    .trim()
    .replace(/^(?:question|q)\s*/i, "")
    .replace(/\s+/g, "")
    .toLowerCase()
    .replace(/\([^)]+\)$/, "");

export default function ConfirmQuestions() {
  const { id } = useParams<{ id: string }>();
  const [exam, setExam] = useState<ExamConfig | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string[]>([]);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [targetTotal, setTargetTotal] = useState("");
  const [mergedMarks, setMergedMarks] = useState("");
  useEffect(() => {
    let cancelled = false;
    setExam(null);
    setError("");
    fetch(`/exam/${encodeURIComponent(id ?? "")}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok)
          throw new Error(d.error ?? "Could not load this assessment.");
        return d.exam as ExamConfig;
      })
      .then((e) => {
        if (cancelled) return;
        setExam(e);
        setDrafts(
          Object.fromEntries(e.questions.map((q) => [q.id, draftFor(q)])),
        );
        setTargetTotal(String(e.totalMarks));
        const first = e.questions.find(
          (q) => q.flags?.length || !q.tags?.confirmedByTeacher,
        );
        setOpen(first ? [first.id] : []);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);
  function edit(qid: string, patch: Partial<Draft>) {
    setDrafts((cur) => ({
      ...cur,
      [qid]: { ...cur[qid], ...patch, dirty: true, error: undefined },
    }));
  }
  const confirmed = (q: Question) =>
    !!q.tags?.confirmedByTeacher && !drafts[q.id]?.dirty;
  const pending =
    exam?.questions.filter((q) => !confirmed(q) || q.flags?.length) ?? [];
  const confirmedCount = exam?.questions.filter(confirmed).length ?? 0;
  const sum = rounded(exam?.questions.reduce((s, q) => s + q.maxMarks, 0) ?? 0);
  const marksMatch = !!exam && Math.abs(sum - exam.totalMarks) < 1e-6;
  const dirty = Object.values(drafts).some((d) => d.dirty);
  const selection =
    exam?.questions.filter((q) => selected.includes(q.id)) ?? [];
  const mergeId = parentId(selection[0]?.id ?? "");
  const canMerge =
    selection.length >= 2 &&
    selection.every(
      (q) =>
        /\([^)]+\)$/.test(q.id) &&
        parentId(q.id) === mergeId &&
        !drafts[q.id]?.dirty,
    ) &&
    !exam?.questions.some(
      (q) => q.id.toLowerCase().replace(/^q\s*/, "") === mergeId,
    );
  const selectedSum = rounded(selection.reduce((s, q) => s + q.maxMarks, 0));
  const canContinue =
    !!exam &&
    confirmedCount === exam.questions.length &&
    marksMatch &&
    pending.length === 0 &&
    !busy;

  async function save(q: Question) {
    const d = drafts[q.id];
    const topics = d.topics
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const maxMarks = Number(d.maxMarks);
    const issue = !d.prompt.trim()
      ? "Enter the question text."
      : !d.chapter.trim()
        ? "Add the chapter."
        : !topics.length
          ? "Add at least one topic."
          : !validMarks(maxMarks)
            ? "Marks must be positive, with up to two decimals."
            : "";
    if (issue) {
      setDrafts((cur) => ({ ...cur, [q.id]: { ...cur[q.id], error: issue } }));
      setOpen((cur) => [...new Set([...cur, q.id])]);
      return false;
    }
    const r = await fetch(
      `/exam/${encodeURIComponent(id ?? "")}/questions/${encodeURIComponent(q.id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: d.prompt.trim(),
          maxMarks,
          flags: [],
          tags: {
            chapter: d.chapter.trim(),
            topics,
            difficulty: d.difficulty,
            confirmedByTeacher: true,
          },
        }),
      },
    );
    const body = await r.json();
    if (!r.ok || !body.exam?.questions)
      throw new Error(
        body.error ?? "Could not save the question. Please retry.",
      );
    setExam(body.exam);
    setDrafts((cur) => ({
      ...cur,
      [q.id]: draftFor(
        body.exam.questions.find((item: Question) => item.id === q.id),
      ),
    }));
    setOpen((cur) => cur.filter((qid) => qid !== q.id));
    return true;
  }
  async function saveQuestions(questions: Question[]) {
    setBusy(true);
    setError("");
    setNotice("");
    let saved = 0;
    try {
      for (const q of questions) if (await save(q)) saved++;
      if (saved)
        setNotice(
          `${saved} question${saved === 1 ? "" : "s"} checked and saved.`,
        );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function structure(action: "normalize-marks" | "merge-questions") {
    const marks = Number(
      action === "normalize-marks" ? targetTotal : mergedMarks || selectedSum,
    );
    if (!validMarks(marks)) {
      setError("Enter positive marks with up to two decimal places.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await fetch(`/exam/${encodeURIComponent(id ?? "")}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          action === "normalize-marks"
            ? { totalMarks: marks }
            : { questionIds: selected, id: mergeId, maxMarks: marks },
        ),
      });
      const d = await r.json();
      if (!r.ok || !d.exam?.questions)
        throw new Error(d.error ?? "The questions could not be updated.");
      const updated = d.exam as ExamConfig;
      setExam(updated);
      setTargetTotal(String(updated.totalMarks));
      setDrafts((cur) =>
        Object.fromEntries(
          updated.questions.map((q) => [
            q.id,
            action === "merge-questions" && cur[q.id] ? cur[q.id] : draftFor(q),
          ]),
        ),
      );
      setSelected([]);
      setMergedMarks("");
      if (action === "merge-questions")
        setOpen((cur) => [
          ...cur.filter((q) => !selected.includes(q)),
          mergeId,
        ]);
      setNotice(
        action === "merge-questions"
          ? `Merged into ${mergeId}. Check its text and tags, then review the combined marking scheme.`
          : `Marks now total ${updated.totalMarks}. Review each allocation before approving the scheme.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!exam)
    return (
      <div className="setup-page">
        <PageHeader breadcrumb="Assessment / Check questions" />
        <p role={error ? "alert" : "status"}>{error || "Loading questions…"}</p>
        {error && <Link to="/">Back to assessments</Link>}
      </div>
    );
  const visible = (attentionOnly ? pending : exam.questions)
    .slice()
    .sort((a, b) => Number(!!b.flags?.length) - Number(!!a.flags?.length));
  return (
    <>
      <PageHeader
        breadcrumb={
          <>
            Class {exam.class} · {exam.subject} · {exam.title}
          </>
        }
        actions={
          <Link className="button" to={`/exam/${id}/scheme`}>
            View answers
          </Link>
        }
      />
      <WorkflowNav examId={id} active="questions" />
      <div className="setup-page">
        <div className="setup-heading">
          <div>
            <h1>
              {exam.questions.length} questions found.
              {pending.length
                ? ` ${pending.length} need a look.`
                : " All checked."}
            </h1>
            <p>
              Compare with the paper, fix anything read incorrectly, and confirm
              the topic and difficulty.
            </p>
          </div>
          <span className={`setup-pill ${marksMatch ? "good" : ""}`}>
            {sum} / {exam.totalMarks} marks accounted for
          </span>
        </div>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        <div className="questions-layout">
          <QuestionPaper exam={exam} onUpdate={setExam} />
          <div className="question-workspace">
            {!marksMatch && (
              <p className="notice warning">
                The questions add up to {sum}, but the exam is out of{" "}
                {exam.totalMarks}. Adjust individual marks or normalize the
                allocations below.
              </p>
            )}
            <details
              className="question-tools-panel"
              open={selected.length > 0 || undefined}
            >
              <summary>
                Adjust marks and merge subparts
                {selected.length ? ` · ${selected.length} selected` : ""}
              </summary>
              <div className="tools-body">
                <div className="tools-fields">
                  <div className="field">
                    <label htmlFor="exam-total">Exam total</label>
                    <input
                      id="exam-total"
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={targetTotal}
                      disabled={busy}
                      onChange={(e) => setTargetTotal(e.target.value)}
                    />
                  </div>
                  <button
                    disabled={busy || dirty}
                    onClick={() => structure("normalize-marks")}
                  >
                    Normalize marks
                  </button>
                </div>
                <p className="hint">
                  Proportionally scales every question and its rubric. Save any
                  question edits first.
                </p>
                {exam.marksNormalization && (
                  <p className="hint">
                    Previous normalization:{" "}
                    {exam.marksNormalization.originalTotalMarks} to{" "}
                    {exam.marksNormalization.targetTotalMarks} marks.
                  </p>
                )}
                <p className="hint">
                  Select sibling parts such as 1(a) and 1(b) to combine their
                  questions, answers and criteria.
                </p>
                {selected.length > 0 && (
                  <>
                    <div className="tools-fields">
                      <div className="field">
                        <label htmlFor="merged-marks">
                          Merged marks{canMerge ? ` · ${mergeId}` : ""}
                        </label>
                        <input
                          id="merged-marks"
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={mergedMarks || selectedSum}
                          disabled={busy}
                          onChange={(e) => setMergedMarks(e.target.value)}
                        />
                      </div>
                      <button
                        disabled={busy || !canMerge}
                        onClick={() => structure("merge-questions")}
                      >
                        Merge selected
                      </button>
                      <button disabled={busy} onClick={() => setSelected([])}>
                        Clear
                      </button>
                    </div>
                    {!canMerge && (
                      <p className="hint">
                        Select at least two saved subparts with the same parent.
                        The parent must not already exist.
                      </p>
                    )}
                  </>
                )}
              </div>
            </details>
            <div className="question-toolbar">
              <span className="hint">
                {confirmedCount} of {exam.questions.length} confirmed
              </span>
              <button
                aria-pressed={attentionOnly}
                onClick={() => setAttentionOnly((v) => !v)}
              >
                {attentionOnly
                  ? `Show all ${exam.questions.length}`
                  : `Needs attention (${pending.length})`}
              </button>
            </div>
            {visible.length === 0 && (
              <p className="notice">
                Every question has been checked. Continue to the answers and
                marking scheme.
              </p>
            )}
            {visible.map((q) => {
              const d = drafts[q.id];
              const expanded = open.includes(q.id);
              return (
                <article
                  key={q.id}
                  className={`question-review-row ${q.flags?.length ? "flagged" : ""}`}
                >
                  <div className="question-review-summary">
                    <input
                      type="checkbox"
                      aria-label={`Select ${q.id} for merging`}
                      checked={selected.includes(q.id)}
                      disabled={busy || !/\([^)]+\)$/.test(q.id)}
                      onChange={(e) => {
                        setSelected((cur) =>
                          e.target.checked
                            ? [...cur, q.id]
                            : cur.filter((x) => x !== q.id),
                        );
                        setMergedMarks("");
                      }}
                    />
                    <span className="question-id">{q.id}</span>
                    <div className="question-text">
                      <p>{q.prompt}</p>
                      <div className="question-tags">
                        {q.tags?.topics.join(", ") || "Topic to confirm"} ·{" "}
                        {q.tags?.difficulty ?? "Difficulty to confirm"} ·{" "}
                        {q.maxMarks} marks{confirmed(q) ? " · Checked" : ""}
                      </div>
                    </div>
                    <button
                      disabled={busy}
                      aria-expanded={expanded}
                      aria-controls={`editor-${q.id}`}
                      onClick={() =>
                        setOpen((cur) =>
                          expanded
                            ? cur.filter((x) => x !== q.id)
                            : [...cur, q.id],
                        )
                      }
                    >
                      {expanded ? "Close" : "Edit"}
                    </button>
                  </div>
                  {q.flags?.length ? (
                    <p className="notice warning">{q.flags.join(" · ")}</p>
                  ) : null}
                  {expanded && d && (
                    <div className="question-editor" id={`editor-${q.id}`}>
                      <div className="field">
                        <label htmlFor={`prompt-${q.id}`}>Question text</label>
                        <textarea
                          id={`prompt-${q.id}`}
                          rows={3}
                          value={d.prompt}
                          disabled={busy}
                          onChange={(e) =>
                            edit(q.id, { prompt: e.target.value })
                          }
                        />
                      </div>
                      <div className="question-editor-grid">
                        <div className="field">
                          <label htmlFor={`chapter-${q.id}`}>Chapter</label>
                          <input
                            id={`chapter-${q.id}`}
                            value={d.chapter}
                            disabled={busy}
                            onChange={(e) =>
                              edit(q.id, { chapter: e.target.value })
                            }
                          />
                        </div>
                        <div className="field">
                          <label htmlFor={`topics-${q.id}`}>
                            Topics, separated by commas
                          </label>
                          <input
                            id={`topics-${q.id}`}
                            value={d.topics}
                            disabled={busy}
                            onChange={(e) =>
                              edit(q.id, { topics: e.target.value })
                            }
                          />
                        </div>
                        <div className="field">
                          <label htmlFor={`difficulty-${q.id}`}>
                            Difficulty
                          </label>
                          <select
                            id={`difficulty-${q.id}`}
                            value={d.difficulty}
                            disabled={busy}
                            onChange={(e) =>
                              edit(q.id, {
                                difficulty: e.target
                                  .value as QuestionDifficulty,
                              })
                            }
                          >
                            {["easy", "medium", "hard"].map((value) => (
                              <option key={value}>{value}</option>
                            ))}
                          </select>
                        </div>
                        <div className="field">
                          <label htmlFor={`marks-${q.id}`}>Marks</label>
                          <input
                            id={`marks-${q.id}`}
                            type="number"
                            min="0.01"
                            step="0.01"
                            value={d.maxMarks}
                            disabled={busy}
                            onChange={(e) =>
                              edit(q.id, { maxMarks: e.target.value })
                            }
                          />
                        </div>
                      </div>
                      {d.error && (
                        <p className="notice error" role="alert">
                          {d.error}
                        </p>
                      )}
                      <div className="setup-actions">
                        <button
                          className="approve"
                          disabled={busy}
                          onClick={() => saveQuestions([q])}
                        >
                          {busy ? "Saving…" : "Save and confirm"}
                        </button>
                        <span className="hint">
                          {d.dirty
                            ? "Unsaved changes"
                            : "Confirm the text, marks and tags above."}
                        </span>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
            <div className="question-review-footer">
              <button
                disabled={busy || pending.length === 0}
                onClick={() => saveQuestions(pending)}
              >
                Confirm all ready questions
              </button>
              {canContinue ? (
                <Link className="button primary" to={`/exam/${id}/scheme`}>
                  Next: answers →
                </Link>
              ) : (
                <span className="hint">
                  {!marksMatch
                    ? "Match the total marks to continue."
                    : "Check every question to continue."}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
