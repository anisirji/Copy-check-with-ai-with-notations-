import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ExamSummary } from "../types";
import PageHeader from "../components/PageHeader";
export default function ExamList() {
  const [exams, setExams] = useState<ExamSummary[] | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    setError("");
    fetch("/exam")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok || !Array.isArray(d.exams))
          throw new Error(d.error ?? "Could not load assessments.");
        return d.exams;
      })
      .then((d) => {
        if (live) setExams(d);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [retry]);
  return (
    <div className="assessment-list">
      <PageHeader
        breadcrumb="Assessments"
        actions={
          <Link className="button" to="/create-exam">
            New assessment
          </Link>
        }
      />
      <div className="list-heading">
        <div>
          <h1>Your assessments</h1>
          <p>
            Prepare a paper, review student answers, and turn the results into
            the next lesson.
          </p>
        </div>
        <Link className="button primary" to="/create-exam">
          + Upload a question paper
        </Link>
      </div>
      {error && (
        <div role="alert" className="setup-panel">
          <p>{error}</p>
          <button onClick={() => setRetry((v) => v + 1)}>Try again</button>
        </div>
      )}
      {!error && !exams && <p role="status">Loading assessments…</p>}
      {exams?.length === 0 && (
        <div className="setup-panel">
          <h2>Start with your next question paper.</h2>
          <p>
            You’ll review the questions and marking scheme before evaluating any
            student sheets.
          </p>
          <Link className="button primary" to="/create-exam">
            Create an assessment
          </Link>
        </div>
      )}
      {!!exams?.length && (
        <div className="exam-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Assessment</th>
                <th>Class</th>
                <th>Subject</th>
                <th>Marking scheme</th>
                <th>Last updated</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {exams.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Link to={`/exam/${e.id}/questions`}>
                      <strong>{e.title}</strong>
                    </Link>
                  </td>
                  <td>{e.class}</td>
                  <td>{e.subject}</td>
                  <td>
                    <span className={`setup-pill ${e.approved ? "good" : ""}`}>
                      {e.approved ? "Approved" : "In preparation"}
                    </span>
                  </td>
                  <td>
                    {e.updatedAt
                      ? new Date(e.updatedAt).toLocaleDateString()
                      : "Not recorded"}
                  </td>
                  <td>
                    <div className="row-actions">
                      <Link to={`/exam/${e.id}/questions`}>Questions</Link>
                      <Link to={`/exam/${e.id}/scheme`}>Answers & rules</Link>
                      <Link to={`/exam/${e.id}/grade`}>Student sheets</Link>
                      <Link to={`/exam/${e.id}/report`}>Test analysis</Link>
                      <Link to={`/exam/${e.id}/matrix`}>Class matrix</Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
