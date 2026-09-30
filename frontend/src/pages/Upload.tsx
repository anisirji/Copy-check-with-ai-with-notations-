import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

const DEFAULT_EXAM_HINT = `{
  "title": "...",
  "subject": "...",
  "class": "...",
  "totalMarks": 20,
  "questions": [ ... ]
}`;

const PENDING_EXAM_KEY = "pending-exam";

export default function Upload() {
  const navigate = useNavigate();
  const [pdf, setPdf] = useState<File | null>(null);
  const [examJson, setExamJson] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prefilled, setPrefilled] = useState(false);

  useEffect(() => {
    try {
      const pending = sessionStorage.getItem(PENDING_EXAM_KEY);
      if (pending) {
        // Pretty-print if it parses.
        try {
          const parsed: unknown = JSON.parse(pending);
          setExamJson(JSON.stringify(parsed, null, 2));
        } catch {
          setExamJson(pending);
        }
        sessionStorage.removeItem(PENDING_EXAM_KEY);
        setPrefilled(true);
      }
    } catch {
      // sessionStorage unavailable — ignore.
    }
  }, []);

  async function loadExample() {
    setBusy(true);
    setError(null);
    try {
      // Trigger the backend example script by hitting a placeholder /run/latest
      // to see if a previous run exists; otherwise instruct the user.
      const r = await fetch("/run/latest");
      if (r.ok) {
        navigate(`/review/latest`);
      } else {
        setError(
          "No example run yet. Run `pnpm example` in copy-check-poc first.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!pdf || !examJson.trim()) {
      setError("Provide both the PDF and the exam JSON.");
      return;
    }
    try {
      JSON.parse(examJson);
    } catch {
      setError("exam JSON is not valid JSON.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("pdf", pdf);
      form.append("exam", examJson);
      const r = await fetch("/grade", { method: "POST", body: form });
      if (!r.ok) throw new Error((await r.json()).error || r.statusText);
      const body = await r.json();
      navigate(`/review/${body.runId}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="upload-page">
      <div className="upload-page-header">
        <Link className="create-exam-link" to="/create-exam">
          ← Create an exam from a question paper
        </Link>
      </div>

      <h2>Grade a handwritten answer sheet</h2>
      <p className="hint">
        Upload the student PDF and the exam config (questions + rubric). The
        pipeline runs 12 stages and produces an annotated PDF + a rubric-level
        teacher review view.
      </p>

      {prefilled && (
        <div className="prefilled-banner">
          Exam JSON pre-filled from your generated exam. Edit as needed.
        </div>
      )}

      <label>Student answer sheet (PDF)</label>
      <input
        type="file"
        accept="application/pdf"
        onChange={(e) => setPdf(e.target.files?.[0] ?? null)}
      />

      <label>Exam config (JSON)</label>
      <textarea
        value={examJson}
        placeholder={DEFAULT_EXAM_HINT}
        onChange={(e) => setExamJson(e.target.value)}
      />
      <div className="hint">
        Schema: <code>examples/exam.json</code>
      </div>

      {error && (
        <div style={{ color: "#dc2626", marginTop: 12, fontSize: 13 }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={submit} disabled={busy}>
          {busy ? "Grading…" : "Grade sheet"}
        </button>
        <button
          onClick={loadExample}
          disabled={busy}
          style={{ background: "#4b5563" }}
        >
          View example run
        </button>
      </div>
    </div>
  );
}
