import { useState } from "react";
import { useNavigate } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import WorkflowNav from "../components/WorkflowNav";
export default function CreateExam() {
  const navigate = useNavigate();
  const [paper, setPaper] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("");
  const [klass, setKlass] = useState("");
  const [marks, setMarks] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function generate(e: React.FormEvent) {
    e.preventDefault();
    if (!paper) return;
    const total = Number(marks);
    if (
      marks.trim() &&
      (!Number.isFinite(total) ||
        total <= 0 ||
        Math.abs(total * 100 - Math.round(total * 100)) > 1e-6)
    ) {
      setError("Enter positive total marks with up to two decimals.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("paper", paper);
      form.append(
        "meta",
        JSON.stringify({
          title: title.trim(),
          subject: subject.trim(),
          class: klass.trim(),
          ...(marks.trim() ? { totalMarks: total } : {}),
        }),
      );
      const r = await fetch("/exam/generate", { method: "POST", body: form });
      const body = await r.json();
      if (!r.ok || !body.exam?.id)
        throw new Error(
          body.error ?? "Could not prepare this paper. Please try again.",
        );
      navigate(`/exam/${body.exam.id}/questions`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader breadcrumb="Assessments / New assessment" />
      <WorkflowNav active="upload" />
      <div className="setup-page">
        <div className="setup-heading">
          <div>
            <h1>Upload the paper. You approve the rest.</h1>
            <p>
              Start with the question paper. Check the extracted questions,
              approve the marking scheme, then evaluate student answers.
            </p>
          </div>
        </div>
        <div className="upload-layout">
          <form className="setup-panel" onSubmit={generate}>
            <h2>A new assessment</h2>
            <p className="hint">
              Use a clear PDF with all question numbers, diagrams and marks
              visible.
            </p>
            <div className="upload-fields">
              <div className="field full">
                <label htmlFor="question-paper">Question paper PDF</label>
                <input
                  id="question-paper"
                  type="file"
                  accept="application/pdf"
                  required
                  disabled={busy}
                  onChange={(e) => setPaper(e.target.files?.[0] ?? null)}
                />
                {paper && (
                  <span className="hint">
                    {paper.name} · {(paper.size / 1024 / 1024).toFixed(1)} MB
                  </span>
                )}
              </div>
              <div className="field full">
                <label htmlFor="assessment-title">Assessment name</label>
                <input
                  id="assessment-title"
                  required
                  value={title}
                  disabled={busy}
                  placeholder="e.g. Unit Test 2: Atoms and Nucleons"
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="assessment-class">Class and section</label>
                <input
                  id="assessment-class"
                  required
                  value={klass}
                  disabled={busy}
                  placeholder="e.g. 8-A"
                  onChange={(e) => setKlass(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="assessment-subject">Subject</label>
                <input
                  id="assessment-subject"
                  required
                  value={subject}
                  disabled={busy}
                  placeholder="e.g. Chemistry"
                  onChange={(e) => setSubject(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="assessment-marks">Total marks (optional)</label>
                <input
                  id="assessment-marks"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={marks}
                  disabled={busy}
                  placeholder="e.g. 20"
                  onChange={(e) => setMarks(e.target.value)}
                />
              </div>
            </div>
            <p className="hint">
              If you enter a total, question marks will be scaled to it and
              shown for your review.
            </p>
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
            {busy && (
              <p className="notice" role="status">
                Reading the paper and preparing answers and marking steps. This
                can take a few minutes. Keep this page open.
              </p>
            )}
            <div className="setup-actions">
              <button
                className="primary"
                type="submit"
                disabled={
                  busy ||
                  !paper ||
                  !title.trim() ||
                  !subject.trim() ||
                  !klass.trim()
                }
              >
                {busy
                  ? "Preparing assessment…"
                  : "Read paper and check questions →"}
              </button>
            </div>
          </form>
          <aside className="setup-panel upload-explanation">
            <h2>Three decisions stay with you.</h2>
            <ol>
              <li>
                <strong>Check the questions</strong>
                <p>
                  Compare the extracted text with the original. Confirm chapter,
                  topic, difficulty and marks.
                </p>
              </li>
              <li>
                <strong>Approve answers and rules</strong>
                <p>
                  Decide what earns each mark and when uncertain answers should
                  come back to you.
                </p>
              </li>
              <li>
                <strong>Review and release</strong>
                <p>
                  Inspect flagged answers and adjust marks before students or
                  parents see a report.
                </p>
              </li>
            </ol>
            <p className="notice">
              Your original question paper is kept beside the extracted
              questions for comparison.
            </p>
          </aside>
        </div>
      </div>
    </>
  );
}
