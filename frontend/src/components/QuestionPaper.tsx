import { useState } from "react";
import type { ExamConfig } from "../types";
export default function QuestionPaper({
  exam,
  onUpdate,
}: {
  exam: ExamConfig;
  onUpdate: (exam: ExamConfig) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [paperVersion, setPaperVersion] = useState(0);
  async function attach(file?: File) {
    if (!file || !exam.id) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("paper", file);
      const r = await fetch(`/exam/${encodeURIComponent(exam.id)}/paper`, {
        method: "PUT",
        body: form,
      });
      const d = await r.json();
      if (!r.ok || !d.exam?.id)
        throw new Error(d.error ?? "Could not attach paper.");
      onUpdate(d.exam);
      setPaperVersion((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const url = `/exam/${encodeURIComponent(exam.id ?? "")}/paper`;
  return (
    <aside
      className="setup-panel paper-reference"
      aria-label="Original question paper"
    >
      <div className="paper-title">
        <strong>{exam.paper?.fileName ?? "Original question paper"}</strong>
        {exam.paper && (
          <a href={url} target="_blank" rel="noreferrer">
            Open
          </a>
        )}
      </div>
      {exam.paper ? (
        <iframe
          title="Original question paper"
          src={`${url}?v=${paperVersion}#toolbar=0`}
        />
      ) : (
        <div className="paper-empty">
          <svg
            viewBox="0 0 32 40"
            fill="none"
            stroke="currentColor"
            aria-hidden="true"
          >
            <rect x="3" y="2" width="26" height="36" rx="2" />
            <path d="M9 12h14M9 20h14M9 28h8" />
          </svg>
          <strong>Compare questions with the paper</strong>
          <p className="hint">
            Attach the original PDF to check extracted text and marks beside it.
          </p>
        </div>
      )}
      <div className="field" style={{ marginTop: 16 }}>
        <label htmlFor="reference-paper">
          {exam.paper ? "Replace reference PDF" : "Attach reference PDF"}
        </label>
        <input
          id="reference-paper"
          type="file"
          accept="application/pdf"
          disabled={busy}
          onChange={(e) => attach(e.target.files?.[0])}
        />
      </div>
      <p className="hint">
        Attaching a reference keeps the questions and marks you have already
        reviewed.
      </p>
      {busy && <p role="status">Saving paper…</p>}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </aside>
  );
}
