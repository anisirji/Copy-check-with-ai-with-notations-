import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import type { ClassReport, ExamConfig } from "../types";
import "./teacher-reports.css";

interface StudentLink {
  studentId: string;
  runId: string;
  name: string;
}
const number = (value: number) =>
  value.toLocaleString(undefined, { maximumFractionDigits: 2 });
const percent = (value: number) => Math.max(0, Math.min(100, value));
const colorFor = (read: string) =>
  read === "secure"
    ? "var(--color-success)"
    : read === "shaky"
      ? "var(--color-warning)"
      : "var(--color-danger)";
const readLabel = (read: string) =>
  read === "secure" ? "Secure" : read === "shaky" ? "Shaky" : "Re-teach";
const questionLabel = (id: string) => (/^q/i.test(id) ? id : `Q${id}`);

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error || "The report could not be loaded. Please try again.",
    );
  return data as T;
}

export default function TestAnalysis() {
  const { id } = useParams<{ id: string }>();
  const [report, setReport] = useState<ClassReport | null>(null);
  const [exam, setExam] = useState<ExamConfig | null>(null);
  const [students, setStudents] = useState<StudentLink[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [showReports, setShowReports] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setError(null);
    setReport(null);
    Promise.all([
      getJson<{ report: ClassReport }>(`/exam/${id}/report`),
      getJson<{ exam: ExamConfig }>(`/exam/${id}`),
      getJson<{ students: StudentLink[] }>(`/exam/${id}/students`),
    ])
      .then(([r, e, s]) => {
        if (cancelled) return;
        setReport(r.report);
        setExam(e.exam);
        setStudents(s.students);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : "Unable to load the report.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [id, reload]);

  if (error)
    return (
      <div className="test-analysis">
        <PageHeader breadcrumb={<Link to="/">Assessments</Link>} />
        <div className="tr-empty" role="alert">
          <h1>We couldn’t load this report</h1>
          <p>{error}</p>
          <button
            className="primary-btn"
            onClick={() => setReload((v) => v + 1)}
          >
            Try again
          </button>
        </div>
      </div>
    );
  if (!report || !exam)
    return (
      <div className="test-analysis" aria-busy="true">
        <div className="tr-loading" role="status">
          Loading test analysis…
        </div>
      </div>
    );

  const hasResults = report.studentsAppeared > 0;
  const revisionTopics = report.topicCoverage.filter(
    (topic) => topic.read === "re-teach",
  );
  const chapters = [
    ...new Set(exam.questions.map((q) => q.tags?.chapter).filter(Boolean)),
  ];
  const weakestQuestion = [...report.questionSummary].sort(
    (a, b) => a.classCorrectPct - b.classCorrectPct,
  )[0];
  const firstStudent = report.studentsToLookAtFirst[0];
  const createdAt = report.exam.conductedAt
    ? new Date(report.exam.conductedAt)
    : null;

  return (
    <div className="test-analysis">
      <PageHeader
        breadcrumb={
          <>
            <Link to="/">Assessments</Link>
            <span>/</span>
            <span>{report.exam.class}</span>
            <span>/</span>
            <span>{report.exam.subject}</span>
            <span>/</span>
            <span>{report.exam.title}</span>
          </>
        }
        actions={
          <>
            <button className="ghost-btn" onClick={() => window.print()}>
              Download PDF
            </button>
            <button
              className="primary-btn"
              aria-expanded={showReports}
              aria-controls="student-report-picker"
              onClick={() => setShowReports(!showReports)}
            >
              Student reports
            </button>
          </>
        }
      />
      <div className="ta-header">
        <div>
          <div className="ta-eyebrow">Teacher view · Test analysis</div>
          <h1 className="ta-title">{report.exam.title}</h1>
          <p className="ta-subtitle">
            {report.exam.class} · {report.exam.subject}
            {chapters.length > 0 && ` · ${chapters.join(", ")}`}
            {createdAt &&
              !Number.isNaN(createdAt.getTime()) &&
              ` · Created ${createdAt.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`}{" "}
            · Max {number(report.exam.totalMarks)} marks
          </p>
        </div>
        <div className="ta-header-chips">
          <span className="chip-soft green">
            {report.studentsAppeared} of {report.studentsTotal} reports released
          </span>
          {hasResults && (
            <span
              className={`chip-soft ${revisionTopics.length ? "amber" : "green"}`}
            >
              {revisionTopics.length
                ? `${revisionTopics.length} topic${revisionTopics.length === 1 ? " needs" : "s need"} revision`
                : "All topics on track"}
            </span>
          )}
        </div>
      </div>

      {showReports && (
        <section
          id="student-report-picker"
          className="ta-card tr-report-picker"
        >
          <div className="ta-card-head">
            <div>
              <h2>Student reports</h2>
              <p className="ta-card-hint">
                Open a report to download it or copy its link. Parent delivery
                is not connected.
              </p>
            </div>
            <button className="ghost-btn" onClick={() => setShowReports(false)}>
              Close
            </button>
          </div>
          {students.length ? (
            <ul>
              {students.map((s) => (
                <li key={s.runId}>
                  <span>{s.name || "Student"}</span>
                  {s.studentId ? (
                    <Link
                      className="ta-inline-link"
                      to={`/exam/${id}/students/${encodeURIComponent(s.studentId)}/report`}
                    >
                      Open report <span aria-hidden="true">→</span>
                    </Link>
                  ) : (
                    <Link className="ta-inline-link" to={`/review/${s.runId}`}>
                      Open answer sheet
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p>No released student reports yet.</p>
          )}
        </section>
      )}

      {!hasResults ? (
        <section className="tr-empty">
          <h2>Your class analysis starts with released reports</h2>
          <p>
            Grade an answer sheet, review the marks, and release the result.
            Class averages and learning gaps will appear here.
          </p>
          <Link className="primary-btn" to={`/exam/${id}/grade`}>
            Grade an answer sheet
          </Link>
          <Link className="ghost-btn" to={`/exam/${id}/questions`}>
            Review test questions
          </Link>
        </section>
      ) : (
        <>
          <div className="ta-kpis">
            <div className="ta-kpi">
              <div className="ta-kpi-label">Class average</div>
              <div className="ta-kpi-value">
                {number(report.average)}
                <span className="ta-kpi-of">
                  {" "}
                  / {number(report.exam.totalMarks)}
                </span>
              </div>
              <div
                className={`ta-kpi-sub ${report.averagePct < 60 ? "warn" : "good"}`}
              >
                {number(report.averagePct)}% ·{" "}
                {report.averagePct < 60 ? "below" : "at or above"} the 60%
                target
              </div>
            </div>
            <div className="ta-kpi">
              <div className="ta-kpi-label">Highest / Lowest</div>
              <div className="ta-kpi-value">
                {number(report.highest)}
                <span className="ta-kpi-of"> / {number(report.lowest)}</span>
              </div>
              <div className="ta-kpi-sub">
                Spread of {number(report.spread)} marks
              </div>
            </div>
            <div className="ta-kpi">
              <div className="ta-kpi-label">Above class average</div>
              <div className="ta-kpi-value">
                {report.aboveAverageCount}
                <span className="ta-kpi-of"> of {report.studentsAppeared}</span>
              </div>
              <div className="ta-kpi-sub">
                {report.studentsAppeared - report.aboveAverageCount} at or below{" "}
                {number(report.average)}
              </div>
            </div>
            <div className="ta-kpi">
              <div className="ta-kpi-label">Test composition</div>
              <div className="ta-kpi-value">
                {report.exam.questionCount}
                <span className="ta-kpi-of"> questions</span>
              </div>
              <div className="ta-kpi-sub">
                {report.topicCoverage.length} topics ·{" "}
                {report.difficultyBreakdown.length} difficulty levels
              </div>
            </div>
            <div className="ta-kpi">
              <div className="ta-kpi-label">Syllabus covered</div>
              <div className="ta-kpi-value tr-kpi-unknown">Not mapped</div>
              <div className="ta-kpi-sub">
                A syllabus blueprint has not been added
              </div>
            </div>
          </div>
          <div className="ta-two-col tr-coverage-row">
            <section className="ta-card">
              <h2>What this test covered</h2>
              <p className="ta-card-hint">
                Chapter, topic and difficulty tags from the confirmed questions.
              </p>
              <div
                className="tr-table-scroll"
                tabIndex={0}
                role="region"
                aria-label="Test coverage"
              >
                <table className="ta-table">
                  <thead>
                    <tr>
                      <th scope="col">Topic</th>
                      <th scope="col">Chapter</th>
                      <th scope="col" className="num">
                        Questions
                      </th>
                      <th scope="col" className="num">
                        Marks
                      </th>
                      <th scope="col">Difficulty mix</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.topicCoverage.map((topic) => {
                      const questions = exam.questions.filter(
                        (q) =>
                          q.tags?.topics?.includes(topic.topic) ||
                          (topic.topic === "Unclassified" &&
                            !q.tags?.topics?.length),
                      );
                      const mix = ["easy", "medium", "hard"]
                        .map((difficulty) => ({
                          difficulty,
                          count: questions.filter(
                            (q) => q.tags?.difficulty === difficulty,
                          ).length,
                        }))
                        .filter((d) => d.count > 0);
                      return (
                        <tr key={topic.topic}>
                          <td>{topic.topic}</td>
                          <td className="dim">{topic.chapter}</td>
                          <td className="num">{questions.length}</td>
                          <td className="num">
                            {number(topic.marksAvailable)}
                          </td>
                          <td className="tr-difficulty-mix">
                            {mix.length
                              ? mix
                                  .map(
                                    (d) =>
                                      `${d.count} ${d.difficulty[0].toUpperCase()}${d.difficulty.slice(1)}`,
                                  )
                                  .join(" · ")
                              : "Not tagged"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="ta-card">
              <h2>Class score by difficulty</h2>
              <p className="ta-card-hint">
                Marks earned as a share of marks available.
              </p>
              <div className="ta-diff-list">
                {report.difficultyBreakdown.map((d) => (
                  <div className="tr-difficulty" key={d.difficulty}>
                    <div>
                      <span>
                        {d.difficulty[0].toUpperCase() + d.difficulty.slice(1)}{" "}
                        · {number(d.marksAvailable)} marks
                      </span>
                      <strong>{number(d.marksEarnedPct)}%</strong>
                    </div>
                    <div className="ta-diff-bar">
                      <div
                        className="ta-diff-bar-fill"
                        style={{
                          width: `${percent(d.marksEarnedPct)}%`,
                          background: colorFor(
                            d.marksEarnedPct >= 70
                              ? "secure"
                              : d.marksEarnedPct >= 45
                                ? "shaky"
                                : "re-teach",
                          ),
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <p className="ta-diff-note">
                {difficultyNote(report.difficultyBreakdown)}
              </p>
            </section>
          </div>
          <section className="ta-card">
            <div className="ta-card-head">
              <div>
                <h2>Question by question, across the class</h2>
                <p className="ta-card-hint">
                  Share of the {report.studentsAppeared} students who earned
                  full marks on each question.
                </p>
              </div>
              <Link className="ta-inline-link" to={`/exam/${id}/matrix`}>
                Open answer sheets
              </Link>
            </div>
            <div
              className="tr-table-scroll"
              tabIndex={0}
              role="region"
              aria-label="Question results"
            >
              <table className="ta-table tight">
                <thead>
                  <tr>
                    <th scope="col">Q</th>
                    <th scope="col">Concept tested</th>
                    <th scope="col">Difficulty</th>
                    <th scope="col" className="num">
                      Marks
                    </th>
                    <th scope="col">Class correct</th>
                    <th scope="col">Read</th>
                  </tr>
                </thead>
                <tbody>
                  {report.questionSummary.map((q) => {
                    const pct =
                      report.studentsAppeared > 0
                        ? (100 * q.fullMarksCount) / report.studentsAppeared
                        : 0;
                    const read = q.read;
                    return (
                      <tr key={q.questionId}>
                        <td className="tr-question-label">
                          {questionLabel(q.questionId)}
                        </td>
                        <td>{q.concept}</td>
                        <td>
                          <span className={`chip diff-${q.difficulty}`}>
                            {q.difficulty}
                          </span>
                        </td>
                        <td className="num">{number(q.maxMarks)}</td>
                        <td>
                          <div className="ta-inline-bar-row">
                            <div className="ta-inline-bar">
                              <div
                                className="ta-inline-bar-fill"
                                style={{
                                  width: `${percent(pct)}%`,
                                  background: colorFor(read),
                                }}
                              />
                            </div>
                            <span className="ta-inline-bar-label">
                              {q.fullMarksCount}/{report.studentsAppeared}
                            </span>
                          </div>
                        </td>
                        <td>
                          <span
                            className="ta-read-label"
                            style={{ color: colorFor(read) }}
                          >
                            {readLabel(read)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
          <section>
            <h2 className="ta-section-title">
              Topic coverage and class mastery
            </h2>
            <div className="ta-topic-grid">
              {report.topicCoverage.map((topic) => (
                <div className="ta-topic-card" key={topic.topic}>
                  <h3 className="ta-topic-name">{topic.topic}</h3>
                  <div
                    className="ta-topic-pct"
                    style={{ color: colorFor(topic.read) }}
                  >
                    {number(topic.marksEarnedPct)}%
                  </div>
                  <div className="ta-topic-bar">
                    <div
                      className="ta-topic-bar-fill"
                      style={{
                        width: `${percent(topic.marksEarnedPct)}%`,
                        background: colorFor(topic.read),
                      }}
                    />
                  </div>
                  <p className="ta-topic-read">
                    {topic.read === "re-teach"
                      ? `Needs revision. ${number(topic.marksAvailable)} of ${number(report.exam.totalMarks)} marks sit here.`
                      : topic.read === "shaky"
                        ? "Partial understanding. Consolidate the method."
                        : "Covered well. Build on this understanding."}
                  </p>
                </div>
              ))}
            </div>
          </section>
          <div className="ta-two-col ta-final-row">
            <section className="ta-card">
              <h2>Students to look at first</h2>
              <p className="ta-card-hint">
                Largest drops first, followed by students below the class
                average. Previous scores are compared on this test’s scale.
              </p>
              <div
                className="tr-table-scroll"
                tabIndex={0}
                role="region"
                aria-label="Students needing attention"
              >
                <table className="ta-table tight">
                  <thead>
                    <tr>
                      <th scope="col">Student</th>
                      <th scope="col" className="num">
                        Score
                      </th>
                      <th scope="col">Vs last test</th>
                      <th scope="col">Weakest concept</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.studentsToLookAtFirst.map((s) => (
                      <tr key={s.studentId}>
                        <td>
                          {s.studentId ? (
                            <Link
                              className="ta-inline-link"
                              to={`/exam/${id}/students/${encodeURIComponent(s.studentId)}/report`}
                            >
                              {s.name}
                            </Link>
                          ) : (
                            s.name
                          )}
                        </td>
                        <td className="num">
                          {number(s.score)} / {number(s.maxMarks)}
                        </td>
                        <td
                          style={{
                            color:
                              s.deltaVsLast === null || s.deltaVsLast === 0
                                ? "var(--color-muted)"
                                : s.deltaVsLast > 0
                                  ? "var(--color-success)"
                                  : "var(--color-danger)",
                          }}
                        >
                          {s.deltaVsLast === null
                            ? "No earlier test"
                            : s.deltaVsLast === 0
                              ? "No change"
                              : `${s.deltaVsLast > 0 ? "+" : ""}${number(s.deltaVsLast)} marks`}
                        </td>
                        <td className="dim">{s.weakestConcept}</td>
                      </tr>
                    ))}
                    {!report.studentsToLookAtFirst.length && (
                      <tr>
                        <td colSpan={4}>
                          No students are below the class average or declining
                          against their earlier result.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
            <aside className="ta-dark-card">
              <h2>Suggested next actions</h2>
              <div className="ta-na-item">
                <h3 className="ta-na-eyebrow">
                  {revisionTopics.length
                    ? "Re-teach the weakest concepts"
                    : "Build on secure concepts"}
                </h3>
                <p className="ta-na-body">
                  {weakestQuestion &&
                  weakestQuestion.fullMarksCount < report.studentsAppeared
                    ? `${weakestQuestion.concept}: ${report.studentsAppeared - weakestQuestion.fullMarksCount} of ${report.studentsAppeared} students did not earn full marks. Review their answers before planning the lesson.`
                    : "Students earned full marks across the questions. Consider a fresh application of these concepts."}
                </p>
              </div>
              <div className="ta-na-item">
                <h3 className="ta-na-eyebrow">Plan differentiated practice</h3>
                <p className="ta-na-body">
                  Review the Rebuild, Consolidate and Extend groups. Move
                  students before deciding their next practice set.
                </p>
              </div>
              <div className="ta-na-item">
                <h3 className="ta-na-eyebrow">Five-minute check</h3>
                <p className="ta-na-body">
                  {firstStudent
                    ? `Start with ${firstStudent.name}: check their understanding of ${firstStudent.weakestConcept}.`
                    : "Use a short follow-up question to check whether students can apply the method independently."}
                </p>
              </div>
              <Link
                className="approve-all-btn"
                to={`/exam/${id}/matrix#follow-up`}
              >
                Review groups and plan follow-up
              </Link>
            </aside>
          </div>
          <div className="ta-footer-nav">
            <Link className="ta-back-link" to={`/exam/${id}/matrix`}>
              View class matrix and follow-up →
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

function difficultyNote(rows: ClassReport["difficultyBreakdown"]): string {
  if (!rows.length)
    return "Add difficulty tags to the questions to compare performance.";
  if (rows.length === 1)
    return "This paper has one tagged difficulty level. A comparison needs questions from another level.";
  const easy = rows.find((d) => d.difficulty === "easy");
  const medium = rows.find((d) => d.difficulty === "medium");
  const hard = rows.find((d) => d.difficulty === "hard");
  if (easy && medium && easy.marksEarnedPct - medium.marksEarnedPct > 25)
    return "The biggest challenge starts with application. Review how students move from recall to a complete method.";
  if (medium && hard && medium.marksEarnedPct - hard.marksEarnedPct > 25)
    return "Higher-difficulty questions show a clear drop. Review the multi-step methods before adding more practice.";
  const weakest = [...rows].sort(
    (a, b) => a.marksEarnedPct - b.marksEarnedPct,
  )[0];
  if (weakest.marksEarnedPct < 45)
    return `The class earned ${number(weakest.marksEarnedPct)}% of the ${weakest.difficulty} marks. Use the question results to choose the first concepts to revisit.`;
  return "Performance is fairly consistent across the tested difficulty levels.";
}
