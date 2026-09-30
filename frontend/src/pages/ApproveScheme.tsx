import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import type {
  EvaluationRules,
  ExamConfig,
  Question,
  RubricCriterion,
} from "../types";
import PageHeader from "../components/PageHeader";
import WorkflowNav from "../components/WorkflowNav";
const defaults: EvaluationRules = {
  mode: "review",
  partialCredit: true,
  carryForward: true,
  unitPenalty: "half",
  flagUncertain: true,
  confirmed: false,
};
type Draft = { answer: string; rubric: RubricCriterion[]; dirty: boolean };
const draftFor = (q: Question): Draft => ({
  answer: q.modelAnswer ?? "",
  rubric: q.rubric.map((c) => ({ ...c })),
  dirty: false,
});
const total = (items: RubricCriterion[]) =>
  Math.round(
    items.reduce((s, c) => s + (Number.isFinite(c.marks) ? c.marks : 0), 0) *
      100,
  ) / 100;

export default function ApproveScheme() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const [exam, setExam] = useState<ExamConfig | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [active, setActive] = useState("");
  const [rules, setRules] = useState<EvaluationRules>(defaults);
  const [rulesDirty, setRulesDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let cancelled = false;
    fetch(`/exam/${id}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "Could not load marking scheme.");
        return d.exam as ExamConfig;
      })
      .then((e) => {
        if (cancelled) return;
        setExam(e);
        setDrafts(
          Object.fromEntries(e.questions.map((q) => [q.id, draftFor(q)])),
        );
        setRules(e.evaluationRules ?? defaults);
        setActive(
          e.questions.find((q) => !q.schemeApproved)?.id ??
            e.questions[0]?.id ??
            "",
        );
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);
  useEffect(() => {
    if (exam && location.hash === "#rules")
      document.getElementById("rules")?.scrollIntoView({ block: "start" });
  }, [exam, location.hash]);
  const q = exam?.questions.find((item) => item.id === active);
  const d = q ? drafts[q.id] : undefined;
  const anyDirty = Object.values(drafts).some((item) => item.dirty);
  function edit(patch: Partial<Draft>) {
    if (!q || busy) return;
    setDrafts((cur) => ({
      ...cur,
      [q.id]: { ...cur[q.id], ...patch, dirty: true },
    }));
  }
  function criterion(index: number, patch: Partial<RubricCriterion>) {
    if (!d) return;
    edit({
      rubric: d.rubric.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    });
  }
  function addCriterion() {
    if (!d || !q) return;
    let n = d.rubric.length + 1;
    while (d.rubric.some((c) => c.id === `${q.id}-step-${n}`)) n++;
    edit({
      rubric: [
        ...d.rubric,
        { id: `${q.id}-step-${n}`, concept: "", marks: 1, acceptable: [] },
      ],
    });
  }
  function approved(question: Question) {
    return (
      (question.schemeApproved ?? !!exam?.approval?.approvedAt) &&
      !drafts[question.id]?.dirty
    );
  }
  const approvedCount = exam?.questions.filter(approved).length ?? 0;
  const questionSum =
    Math.round(
      (exam?.questions.reduce((sum, item) => sum + item.maxMarks, 0) ?? 0) *
        100,
    ) / 100;
  const marksMatch = !!exam && Math.abs(questionSum - exam.totalMarks) < 1e-6;
  const errors =
    q && d
      ? [
          ...(!q.tags?.confirmedByTeacher
            ? ["Confirm this question's tags first."]
            : []),
          ...(!d.rubric.length ? ["Add at least one marking step."] : []),
          ...(d.rubric.some(
            (c) =>
              !c.concept.trim() ||
              !Number.isFinite(c.marks) ||
              c.marks <= 0 ||
              Math.abs(c.marks * 100 - Math.round(c.marks * 100)) > 1e-6,
          )
            ? [
                "Each step needs a description and positive marks with up to two decimals.",
              ]
            : []),
          ...(Math.abs(total(d.rubric) - q.maxMarks) > 1e-6
            ? [
                `Place exactly ${q.maxMarks} marks across the steps. Currently ${total(d.rubric)}.`,
              ]
            : []),
        ]
      : [];
  async function saveQuestion(approve: boolean) {
    if (!q || !d) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await fetch(
        `/exam/${id}/questions/${encodeURIComponent(q.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            modelAnswer: d.answer,
            rubric: d.rubric,
            schemeApproved: approve,
          }),
        },
      );
      const body = await r.json();
      if (!r.ok || !body.exam?.questions)
        throw new Error(body.error ?? "Could not save this answer.");
      const updated = body.exam as ExamConfig;
      setExam(updated);
      setDrafts((cur) => ({
        ...cur,
        [q.id]: draftFor(updated.questions.find((item) => item.id === q.id)!),
      }));
      setNotice(approve ? `${q.id} approved.` : `${q.id} saved as a draft.`);
      if (approve) {
        const index = updated.questions.findIndex((item) => item.id === q.id);
        const next =
          updated.questions
            .slice(index + 1)
            .find((item) => !item.schemeApproved) ??
          updated.questions.find((item) => !item.schemeApproved);
        if (next) setActive(next.id);
        else
          document.getElementById("rules")?.scrollIntoView({ block: "start" });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function changeRules(patch: Partial<EvaluationRules>) {
    setRules((cur) => ({ ...cur, ...patch, confirmed: false }));
    setRulesDirty(true);
  }
  async function saveRules() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await fetch(`/exam/${id}/rules`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...rules, confirmed: true }),
      });
      const body = await r.json();
      if (!r.ok || !body.exam)
        throw new Error(body.error ?? "Could not save rules.");
      setExam(body.exam);
      setRules(body.exam.evaluationRules);
      setRulesDirty(false);
      setNotice("Evaluation rules confirmed for this assessment.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function approveScheme() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/exam/${id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvedBy: "teacher" }),
      });
      const body = await r.json();
      if (!r.ok || !body.exam)
        throw new Error(body.error ?? "Could not approve scheme.");
      setExam(body.exam);
      setNotice("Scheme approved. You can now evaluate student sheets.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!exam)
    return (
      <div className="setup-page">
        <PageHeader breadcrumb="Assessment / Marking scheme" />
        <p role={error ? "alert" : "status"}>
          {error || "Loading marking scheme…"}
        </p>
      </div>
    );
  const ready =
    marksMatch &&
    approvedCount === exam.questions.length &&
    !!rules.confirmed &&
    !rulesDirty &&
    !anyDirty &&
    !busy;
  return (
    <>
      <PageHeader
        breadcrumb={
          <>
            Class {exam.class} · {exam.subject} · {exam.title}
          </>
        }
        actions={
          exam.approval?.approvedAt && ready ? (
            <Link className="button" to={`/exam/${id}/grade`}>
              Start evaluation
            </Link>
          ) : (
            <a className="button" href="#approve-scheme">
              Review approval
            </a>
          )
        }
      />
      <WorkflowNav
        examId={id}
        active={location.hash === "#rules" ? "rules" : "answers"}
      />
      <div className="setup-page">
        <div className="setup-heading">
          <div>
            <h1>Where each mark goes, and when to ask you.</h1>
            <p>
              Review each answer and its marking steps. The rules you approve
              apply to every student sheet.
            </p>
          </div>
          <span className="setup-pill">
            {approvedCount} of {exam.questions.length} approved
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
        {!marksMatch && (
          <p className="notice warning">
            Question marks total {questionSum}, but this exam is out of{" "}
            {exam.totalMarks}.{" "}
            <Link to={`/exam/${id}/questions`}>Correct the allocations</Link>{" "}
            before approval.
          </p>
        )}
        <div className="scheme-layout">
          <nav
            className="setup-panel scheme-question-nav"
            aria-label="Questions"
          >
            <h2>Questions</h2>
            {exam.questions.map((item) => (
              <button
                key={item.id}
                disabled={busy}
                className={active === item.id ? "selected" : ""}
                aria-current={active === item.id ? "true" : undefined}
                onClick={() => setActive(item.id)}
              >
                <span>
                  {item.id} · {item.tags?.topics[0] ?? "Question"}
                </span>
                {approved(item) ? (
                  <span className="approved-tick" aria-label="Approved">
                    ✓
                  </span>
                ) : drafts[item.id]?.dirty ? (
                  <span aria-label="Unsaved changes">•</span>
                ) : null}
              </button>
            ))}
          </nav>
          {q && d ? (
            <section
              className="setup-panel"
              aria-label={`Marking scheme for ${q.id}`}
            >
              <div className="scheme-active-header">
                <h2>
                  {q.id} · {q.prompt}
                </h2>
                <span
                  className={`setup-pill ${Math.abs(total(d.rubric) - q.maxMarks) < 1e-6 ? "good" : ""}`}
                >
                  {total(d.rubric)} of {q.maxMarks} marks placed
                </span>
              </div>
              <div className="field">
                <label htmlFor="model-answer">Full correct solution</label>
                <textarea
                  id="model-answer"
                  rows={Math.min(
                    9,
                    Math.max(3, d.answer.split("\n").length + 1),
                  )}
                  value={d.answer}
                  disabled={busy}
                  onChange={(e) => edit({ answer: e.target.value })}
                />
              </div>
              <div className="scheme-criteria" aria-label="Step marks">
                {d.rubric.map((c, index) => (
                  <div className="scheme-criterion" key={c.id}>
                    <div className="field">
                      <label htmlFor={`concept-${c.id}`}>
                        Step {index + 1}: what earns the mark
                      </label>
                      <textarea
                        id={`concept-${c.id}`}
                        rows={2}
                        value={c.concept}
                        disabled={busy}
                        onChange={(e) =>
                          criterion(index, { concept: e.target.value })
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`acceptable-${c.id}`}>
                        Also accept (one per line)
                      </label>
                      <textarea
                        id={`acceptable-${c.id}`}
                        rows={2}
                        value={(c.acceptable ?? []).join("\n")}
                        disabled={busy}
                        onChange={(e) =>
                          criterion(index, {
                            acceptable: e.target.value.split("\n"),
                          })
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`step-marks-${c.id}`}>Marks</label>
                      <input
                        id={`step-marks-${c.id}`}
                        type="number"
                        step="0.01"
                        min="0.01"
                        max={q.maxMarks}
                        value={Number.isFinite(c.marks) ? c.marks : ""}
                        disabled={busy}
                        onChange={(e) =>
                          criterion(index, {
                            marks:
                              e.target.value === ""
                                ? NaN
                                : Number(e.target.value),
                          })
                        }
                      />
                    </div>
                    <button
                      aria-label={`Remove step ${index + 1}`}
                      disabled={busy}
                      onClick={() =>
                        edit({ rubric: d.rubric.filter((_, i) => i !== index) })
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
              <div className="setup-actions">
                <button disabled={busy} onClick={addCriterion}>
                  + Add marking step
                </button>
              </div>
              {errors.length > 0 && (
                <div className="notice warning">
                  <ul>
                    {errors.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="setup-actions">
                <button
                  className="approve"
                  disabled={busy || errors.length > 0}
                  onClick={() => saveQuestion(true)}
                >
                  {busy ? "Saving…" : "Approve and continue"}
                </button>
                <button
                  disabled={busy || !d.dirty}
                  onClick={() => saveQuestion(false)}
                >
                  Save draft
                </button>
                <span className="hint">
                  {d.dirty
                    ? "Unsaved changes"
                    : approved(q)
                      ? "Answer approved"
                      : "Check the answer and each marking step."}
                </span>
              </div>
            </section>
          ) : (
            <p className="notice">
              No questions yet. Return to the question check.
            </p>
          )}
        </div>
        <section id="rules" className="setup-panel scheme-rules">
          <div className="scheme-active-header">
            <div>
              <h2>How it should mark</h2>
              <p className="hint">
                Choose how this assessment is evaluated. Reports always need
                your approval before release.
              </p>
            </div>
            <button disabled={busy} onClick={() => changeRules(defaults)}>
              Reset defaults
            </button>
          </div>
          <div className="rules-mode-options">
            {(
              [
                {
                  value: "assist",
                  title: "Assist",
                  text: "Every answer comes to you for review.",
                },
                {
                  value: "review",
                  title: "Review",
                  text: "Review flagged answers, then release the result.",
                },
                {
                  value: "sample",
                  title: "Sample check",
                  text: "Review a sample plus every flagged answer before release.",
                },
              ] as const
            ).map((mode) => (
              <label key={mode.value}>
                <input
                  type="radio"
                  name="evaluation-mode"
                  value={mode.value}
                  checked={rules.mode === mode.value}
                  disabled={busy}
                  onChange={() => changeRules({ mode: mode.value })}
                />
                <span>
                  <strong>{mode.title}</strong>
                  <br />
                  {mode.text}
                </span>
              </label>
            ))}
          </div>
          <label className="rule-row">
            <span>
              <strong>Give marks for correct working</strong>
              <p>
                A correct method can earn credit even when the final answer is
                incomplete.
              </p>
            </span>
            <input
              type="checkbox"
              checked={rules.partialCredit}
              disabled={busy}
              onChange={(e) => changeRules({ partialCredit: e.target.checked })}
            />
          </label>
          <label className="rule-row">
            <span>
              <strong>One slip, one penalty</strong>
              <p>
                A wrong value carried into otherwise correct later steps is not
                penalized repeatedly.
              </p>
            </span>
            <input
              type="checkbox"
              checked={rules.carryForward}
              disabled={busy}
              onChange={(e) => changeRules({ carryForward: e.target.checked })}
            />
          </label>
          <label className="rule-row">
            <span>
              <strong>Missing unit or sign</strong>
              <p>
                Apply the selected penalty once per question, within the marks
                available.
              </p>
            </span>
            <select
              aria-label="Missing unit or sign penalty"
              value={rules.unitPenalty}
              disabled={busy}
              onChange={(e) =>
                changeRules({
                  unitPenalty: e.target.value as EvaluationRules["unitPenalty"],
                })
              }
            >
              <option value="ignore">Ignore</option>
              <option value="half">Half mark</option>
              <option value="full">Full mark</option>
            </select>
          </label>
          <label className="rule-row">
            <span>
              <strong>Ask me when unsure</strong>
              <p>
                Keep unclear handwriting and uncertain marking decisions in the
                review queue.
              </p>
            </span>
            <input
              type="checkbox"
              checked={rules.flagUncertain}
              disabled={busy}
              onChange={(e) => changeRules({ flagUncertain: e.target.checked })}
            />
          </label>
          <div className="setup-actions">
            <button
              className="primary"
              disabled={busy || (!rulesDirty && rules.confirmed)}
              onClick={saveRules}
            >
              Confirm evaluation rules
            </button>
            <span className="hint">
              {rules.confirmed && !rulesDirty
                ? "Rules confirmed"
                : "Confirm these rules before approving the scheme."}
            </span>
          </div>
        </section>
        <section className="scheme-final" id="approve-scheme">
          <div>
            <h2>Try a sheet, then review the result.</h2>
            <p>
              {exam.approval?.approvedAt && ready
                ? "This scheme is approved. Start with one student sheet and check the feedback before evaluating the rest."
                : `${exam.questions.length - approvedCount} answer${exam.questions.length - approvedCount === 1 ? "" : "s"} still need approval. Confirm the rules and mark totals before evaluation.`}
            </p>
          </div>
          {exam.approval?.approvedAt && ready ? (
            <Link className="button primary" to={`/exam/${id}/grade`}>
              Upload student sheets →
            </Link>
          ) : (
            <button
              className="approve"
              disabled={!ready}
              onClick={approveScheme}
            >
              {busy ? "Approving…" : "Approve scheme"}
            </button>
          )}
        </section>
      </div>
    </>
  );
}
