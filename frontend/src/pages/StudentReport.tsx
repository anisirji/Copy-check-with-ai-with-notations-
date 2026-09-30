import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import type { StudentReport } from "../types";
import "./review-student.css";

export type ReportData = StudentReport & {
  acknowledgment?: { acknowledgedAt: string };
};
export const number = (value: number) =>
  value.toLocaleString(undefined, { maximumFractionDigits: 2 });
export function formatDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
}
export function useStudentReport(
  runId?: string,
  examId?: string,
  studentId?: string,
  parent = false,
) {
  const [report, setReport] = useState<ReportData | null>(null);
  const [error, setError] = useState("");
  const [locked, setLocked] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setReport(null);
    setError("");
    setLocked(false);
    async function load() {
      try {
        let id = runId;
        if (!id && examId && studentId) {
          const response = await fetch(
            `/exam/${encodeURIComponent(examId)}/students`,
          );
          const body = await response.json();
          if (!response.ok)
            throw new Error(body.error || "Could not load the student list.");
          id = body.students?.find(
            (s: { studentId: string; runId: string }) =>
              s.studentId === studentId,
          )?.runId;
          if (!id)
            throw new Error(
              "There is no released report for this student yet. Review and release their answer sheet first.",
            );
        }
        if (!id) throw new Error("This report link is incomplete.");
        const response = await fetch(
          `/run/${encodeURIComponent(id)}/${parent ? "student-report" : "report"}`,
        );
        const body = await response.json();
        if (response.status === 409) {
          if (active) {
            setLocked(true);
            setError(
              "Your teacher is still reviewing this answer sheet. Your report will appear here after it is released.",
            );
          }
          return;
        }
        if (!response.ok)
          throw new Error(body.error || "Could not load the report.");
        if (!body.report?.student || !body.report?.exam)
          throw new Error("The report is incomplete. Please try again.");
        if (active) setReport(body.report);
      } catch (err) {
        if (active) setError((err as Error).message);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [runId, examId, studentId, parent, retry]);
  return {
    report,
    setReport,
    error,
    locked,
    retry: () => setRetry((v) => v + 1),
  };
}

export function ReportState({
  error,
  locked,
  retry,
}: {
  error: string;
  locked?: boolean;
  retry?: () => void;
}) {
  return (
    <div className="review-state" role={error ? "alert" : "status"}>
      {error ? (
        <>
          <div className="ta-eyebrow">STUDENT &amp; PARENT REPORT</div>
          <h1>
            {locked
              ? "Your report is being reviewed"
              : "Unable to open this report"}
          </h1>
          <p>{error}</p>
          {retry && (
            <button className="primary-btn" onClick={retry}>
              {locked ? "Check again" : "Try again"}
            </button>
          )}
        </>
      ) : (
        <>
          <div className="spinner" />
          <p>Loading your report…</p>
        </>
      )}
    </div>
  );
}

export default function StudentReportPage() {
  const { examId, studentId } = useParams<{
    examId: string;
    studentId: string;
  }>();
  const state = useStudentReport(undefined, examId, studentId);
  if (!state.report) return <ReportState {...state} />;
  return (
    <StudentReportContent
      report={state.report}
      onReportChanged={state.setReport}
      audience="teacher"
    />
  );
}

export function StudentReportContent({
  report,
  audience,
  onReportChanged,
}: {
  report: ReportData;
  audience: "teacher" | "family";
  onReportChanged?: (report: ReportData) => void;
}) {
  const [shareStatus, setShareStatus] = useState("");
  const [shareLink, setShareLink] = useState("");
  const [remarkEditing, setRemarkEditing] = useState(false);
  const [remark, setRemark] = useState(report.teacherRemark || "");
  const [remarkError, setRemarkError] = useState("");
  const [remarkBusy, setRemarkBusy] = useState(false);
  const student = report.student;
  const first = student.name.trim().split(/\s+/)[0] || "The student";
  const initials = student.name
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const averageNow = report.averageNowPct ?? report.percentage;
  const delta =
    report.averageBeforePct === null
      ? null
      : averageNow - report.averageBeforePct;
  const trend =
    delta === null || delta === 0 ? "neutral" : delta > 0 ? "good" : "bad";
  const improving =
    report.lastThreeTests.length >= 2 &&
    report.lastThreeTests.every(
      (t, index, all) => index === 0 || t.pct > all[index - 1].pct,
    );
  const hasClass = report.classSize > 0;

  async function copyShareLink() {
    const link = `${window.location.origin}/review/${encodeURIComponent(report.runId)}/student`;
    setShareLink(link);
    try {
      await navigator.clipboard.writeText(link);
      setShareStatus("Report link copied. You can share it with the parent.");
    } catch {
      setShareStatus("Copy the report link below to share it with the parent.");
    }
  }
  async function saveRemark() {
    setRemarkBusy(true);
    setRemarkError("");
    try {
      const response = await fetch(
        `/run/${encodeURIComponent(report.runId)}/metadata`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teacherRemark: remark.trim() }),
        },
      );
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error || "The remark could not be saved.");
      onReportChanged?.({ ...report, teacherRemark: body.teacherRemark });
      setRemarkEditing(false);
    } catch (err) {
      setRemarkError((err as Error).message);
    } finally {
      setRemarkBusy(false);
    }
  }

  return (
    <div className="student-report">
      <PageHeader
        breadcrumb={
          <>
            <Link
              to={
                audience === "teacher"
                  ? `/exam/${report.exam.id}/matrix`
                  : `/review/${report.runId}/student`
              }
            >
              Student report
            </Link>
            <span>/</span>
            <span>{student.name}</span>
            <span>/</span>
            <span>{report.exam.title}</span>
          </>
        }
        actions={
          <>
            <button className="ghost-btn" onClick={() => window.print()}>
              Print / save PDF
            </button>
            <button
              className="primary-btn"
              onClick={() => void copyShareLink()}
            >
              Share with parent
            </button>
          </>
        }
      />
      {shareStatus && (
        <div className="sr-share-message" role="status">
          <span>{shareStatus}</span>
          <input
            readOnly
            aria-label="Report link"
            value={shareLink}
            onFocus={(e) => e.target.select()}
          />
          <button
            className="ghost-btn small"
            onClick={() => setShareStatus("")}
          >
            Close
          </button>
        </div>
      )}
      <header className="sr-header">
        <div className="sr-avatar" aria-hidden="true">
          {initials || "S"}
        </div>
        <div className="sr-header-body">
          <div className="ta-eyebrow">STUDENT &amp; PARENT REPORT</div>
          <h1 className="ta-title">{student.name}</h1>
          <p className="ta-subtitle">
            {report.exam.class}
            {student.rollNumber !== undefined
              ? ` · Roll ${student.rollNumber}`
              : ""}{" "}
            · {report.exam.subject} · {report.exam.title}
            {report.exam.conductedAt
              ? ` · ${formatDate(report.exam.conductedAt)}`
              : ""}
          </p>
        </div>
        {improving && (
          <span className="chip-soft green">
            Improving across {report.lastThreeTests.length} tests
          </span>
        )}
      </header>
      <nav className="sr-view-tabs" aria-label="Report views">
        <Link
          aria-current="page"
          to={
            audience === "teacher"
              ? `/exam/${report.exam.id}/students/${student.id}/report`
              : `/review/${report.runId}/student`
          }
        >
          Individual report
        </Link>
        <Link to={`/review/${report.runId}/parent`}>Parent guide</Link>
        {audience === "teacher" && (
          <Link to={`/review/${report.runId}`}>Marked answer sheet ↗</Link>
        )}
      </nav>
      <div className="sr-two-col sr-score-row">
        <section className="sr-dark-card">
          <div className="sr-dc-label">Marks in this test</div>
          <div className="sr-dc-score">
            <span className="sr-dc-num">{number(report.awardedMarks)}</span>
            <span className="sr-dc-of">/ {number(report.exam.maxMarks)}</span>
            <span className="sr-dc-pct-chip">{number(report.percentage)}%</span>
          </div>
          <div className="sr-dc-stats">
            <Stat
              label="Class average"
              value={
                hasClass
                  ? `${number(report.classAverage)} / ${number(report.exam.maxMarks)}`
                  : "Not available"
              }
            />
            <Stat
              label="Position in class"
              value={
                hasClass && report.positionInClass > 0
                  ? `${ordinal(report.positionInClass)} of ${report.classSize}`
                  : "Not available"
              }
            />
            <Stat
              label="Highest in class"
              value={
                hasClass
                  ? `${number(report.highestInClass)} / ${number(report.exam.maxMarks)}`
                  : "Not available"
              }
            />
            <Stat
              label={
                report.aboveAverageBy < 0
                  ? "Below average by"
                  : "Above average by"
              }
              value={
                hasClass
                  ? `${number(Math.abs(report.aboveAverageBy))} marks`
                  : "Not available"
              }
            />
          </div>
          <p className="sr-class-note">
            Based on {report.classSize} released{" "}
            {report.classSize === 1 ? "report" : "reports"}.
          </p>
        </section>
        <section className={`sr-value-card ${trend}`}>
          <div className="sr-vc-label">Effect on the overall average</div>
          <h2 className="sr-vc-headline">
            {delta === null
              ? `This test sets ${first}'s starting point.`
              : delta === 0
                ? `This test kept ${first}'s running average steady.`
                : `This test pulled ${first}'s running average ${delta > 0 ? "up" : "down"} by ${number(Math.abs(delta))} points.`}
          </h2>
          <div className="sr-vc-avgrow">
            <div>
              <div className="sr-vc-avg-label">Average before</div>
              <div className="sr-vc-avg-value">
                {report.averageBeforePct === null
                  ? "First test"
                  : `${number(report.averageBeforePct)}%`}
              </div>
            </div>
            <span className="sr-vc-arrow" aria-hidden="true">
              →
            </span>
            <div>
              <div className="sr-vc-avg-label">Average now</div>
              <div className="sr-vc-avg-value">{number(averageNow)}%</div>
            </div>
            <span className={`sr-vc-badge ${trend}`}>
              {delta === null
                ? "Starting point"
                : delta > 0
                  ? "Value added"
                  : delta < 0
                    ? "Below prior average"
                    : "Holding steady"}
            </span>
          </div>
          <p className="sr-vc-footnote">
            {delta === null
              ? "There are no earlier released tests in this subject and class to compare yet. Future reports will show progress from here."
              : `This score of ${number(report.percentage)}% is ${report.percentage > (report.averageBeforePct ?? 0) ? "above" : report.percentage < (report.averageBeforePct ?? 0) ? "below" : "the same as"} the previous average of ${number(report.averageBeforePct ?? 0)}%. The running average includes earlier released tests in the same subject and class.`}
          </p>
        </section>
      </div>
      <div className="sr-two-col sr-learning-row">
        <section className="ta-card">
          <h2>Progress over the last three tests</h2>
          <p className="ta-card-hint">
            Same subject and class, shown as a percentage.
          </p>
          <div className="sr-progress-row">
            <div className="sr-bars">
              {report.lastThreeTests.map((test, index) => (
                <div className="sr-bar-col" key={`${test.label}-${index}`}>
                  <div className="sr-bar-pct">{number(test.pct)}%</div>
                  <div
                    className={`sr-bar ${index === report.lastThreeTests.length - 1 ? "current" : ""}`}
                    style={{
                      height: `${Math.max(3, Math.min(test.pct, 100) * 1.4)}px`,
                    }}
                  />
                  <div className="sr-bar-label">{test.label}</div>
                  <div className="sr-bar-sublabel">
                    {number(test.awarded)} / {number(test.max)}
                  </div>
                </div>
              ))}
            </div>
            <div className="sr-deltas">
              <Delta
                label="Since the last test"
                marks={report.sinceLastTestMarks}
                percentage={report.sinceLastTestPct}
              />
              <Delta
                label="Since two tests ago"
                marks={report.sinceTwoTestsAgoMarks}
                percentage={report.sinceTwoTestsAgoPct}
              />
              {report.classPositionMovedFrom !== null &&
                report.positionInClass > 0 && (
                  <div className="sr-delta-chip">
                    <div className="sr-delta-label">Class position moved</div>
                    <div className="sr-delta-value">
                      {ordinal(report.classPositionMovedFrom)} →{" "}
                      {ordinal(report.positionInClass)}
                    </div>
                  </div>
                )}
            </div>
          </div>
          {report.lastThreeTests.length === 1 && (
            <p className="sr-topic-note">
              The next released test will make a comparison possible.
            </p>
          )}
        </section>
        <section className="ta-card">
          <h2>How {first} did on each topic</h2>
          <p className="ta-card-hint">
            Marks earned against the marks available in each topic.
          </p>
          <div className="sr-topics">
            {report.topicPerformance.map((topic) => (
              <div className="sr-topic-row" key={topic.topic}>
                <div className="sr-topic-row-head">
                  <span>{topic.topic}</span>
                  <strong style={{ color: topicColor(topic.read) }}>
                    {number(topic.awarded)} / {number(topic.max)} ·{" "}
                    {topic.read === "strong"
                      ? "Strong"
                      : topic.read === "on-track"
                        ? "On track"
                        : "Needs focus"}
                  </strong>
                </div>
                <div className="sr-topic-bar">
                  <div
                    className="sr-topic-bar-fill"
                    style={{
                      width: `${topic.max ? Math.min(100, (topic.awarded / topic.max) * 100) : 0}%`,
                      background: topicColor(topic.read),
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
          <p className="sr-topic-note">{topicNote(report)}</p>
        </section>
      </div>
      <section className="ta-card sr-lost-marks">
        <h2>Where the marks were lost, and why</h2>
        <p className="ta-card-hint">
          Start with the questions that offer the most room to improve.
        </p>
        <div
          className="sr-table-scroll"
          tabIndex={0}
          aria-label="Lost marks by question"
        >
          <table className="ta-table tight">
            <thead>
              <tr>
                <th>Q</th>
                <th>Concept</th>
                <th className="num">{first}</th>
                <th className="num">Class average</th>
                <th>What needs attention</th>
              </tr>
            </thead>
            <tbody>
              {report.lostMarks.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    All available marks were earned in this test.
                  </td>
                </tr>
              ) : (
                report.lostMarks.map((loss) => (
                  <tr key={loss.questionId}>
                    <td>
                      {audience === "teacher" ? (
                        <Link
                          to={`/review/${report.runId}?question=${encodeURIComponent(loss.questionId)}`}
                        >
                          {loss.questionId}
                        </Link>
                      ) : (
                        loss.questionId
                      )}
                    </td>
                    <td>{loss.concept}</td>
                    <td
                      className="num"
                      style={{
                        color:
                          loss.studentMarks > 0
                            ? "var(--color-warning)"
                            : "var(--color-danger)",
                      }}
                    >
                      {number(loss.studentMarks)} / {number(loss.maxMarks)}
                    </td>
                    <td className="num">
                      {hasClass
                        ? `${number(loss.classAverageMarks)} / ${number(loss.maxMarks)}`
                        : "Not available"}
                    </td>
                    <td>{loss.whatWentWrong}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
      <div className="sr-two-col sr-followup-row">
        <section>
          <h2>What {first} should work on next</h2>
          <div className="sr-actions">
            {report.nextActions.map((action) => (
              <article
                className="sr-action-card"
                key={`${action.priority}-${action.title}`}
              >
                <span
                  className={`sr-action-badge sr-action-${action.priority}`}
                >
                  {action.priority === "first"
                    ? "First priority"
                    : action.priority === "then"
                      ? "Then"
                      : "Keep going"}
                </span>
                <h3 className="sr-action-title">{action.title}</h3>
                <p className="sr-action-detail">{action.detail}</p>
                {action.assignment && (
                  <p className="sr-action-assign">
                    {honestPractice(action.assignment)}
                  </p>
                )}
              </article>
            ))}
          </div>
          {report.nextActions.length === 0 && (
            <p className="sr-topic-note">
              Keep practising the skills covered in this test. Your teacher can
              suggest the next level.
            </p>
          )}
        </section>
        <section className="ta-card sr-remark-card">
          <div className="sr-remark-head">
            <h2>Teacher's remark</h2>
            {audience === "teacher" && !remarkEditing && (
              <button
                className="ghost-btn small"
                onClick={() => {
                  setRemark(report.teacherRemark || "");
                  setRemarkEditing(true);
                }}
              >
                Edit remark
              </button>
            )}
          </div>
          {remarkEditing ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void saveRemark();
              }}
            >
              <label className="ar-comment-label">
                Remark for student and parent
                <textarea
                  value={remark}
                  onChange={(event) => setRemark(event.target.value)}
                  maxLength={3000}
                  rows={5}
                  disabled={remarkBusy}
                />
              </label>
              {remarkError && (
                <p className="error-msg" role="alert">
                  {remarkError}
                </p>
              )}
              <div className="ar-card-actions">
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={remarkBusy}
                  onClick={() => setRemarkEditing(false)}
                >
                  Cancel
                </button>
                <button className="primary-btn" disabled={remarkBusy}>
                  {remarkBusy ? "Saving…" : "Save remark"}
                </button>
              </div>
            </form>
          ) : (
            <div className="sr-remark">
              {report.teacherRemark ? (
                <blockquote>{report.teacherRemark}</blockquote>
              ) : (
                <p className="dim">Your teacher has not added a remark yet.</p>
              )}
            </div>
          )}
          {audience === "family" ? (
            <ParentAcknowledgment report={report} />
          ) : (
            <p className="sr-ack-state">
              {report.acknowledgment
                ? `Parent acknowledged on ${formatDate(report.acknowledgment.acknowledgedAt)}.`
                : "Parent acknowledgment will appear after they read the shared report."}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

export function ParentAcknowledgment({ report }: { report: ReportData }) {
  const [acknowledgedAt, setAcknowledgedAt] = useState(
    report.acknowledgment?.acknowledgedAt,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(
    () => setAcknowledgedAt(report.acknowledgment?.acknowledgedAt),
    [report.runId, report.acknowledgment?.acknowledgedAt],
  );
  async function acknowledge() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/run/${encodeURIComponent(report.runId)}/acknowledge`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ acknowledgedBy: "parent" }),
        },
      );
      const body = await response.json();
      if (!response.ok)
        throw new Error(
          body.error || "Your acknowledgment could not be saved.",
        );
      setAcknowledgedAt(body.acknowledgment.acknowledgedAt);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="sr-acknowledgment">
      {acknowledgedAt ? (
        <p className="sr-ack-state" role="status">
          ✓ Acknowledged by parent on {formatDate(acknowledgedAt)}
        </p>
      ) : (
        <button
          className="sr-ack-btn"
          disabled={busy}
          onClick={() => void acknowledge()}
        >
          {busy ? "Saving…" : "Acknowledge as parent"}
        </button>
      )}
      {error && (
        <p className="error-msg" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="sr-dc-stat">
      <div className="sr-dc-stat-label">{label}</div>
      <div className="sr-dc-stat-value">{value}</div>
    </div>
  );
}
function Delta({
  label,
  marks,
  percentage,
}: {
  label: string;
  marks: number | null;
  percentage: number | null;
}) {
  const color =
    percentage === null || percentage === 0
      ? "var(--color-muted)"
      : percentage > 0
        ? "var(--color-success)"
        : "var(--color-danger)";
  return (
    <div className="sr-delta-chip">
      <div className="sr-delta-label">{label}</div>
      <div className="sr-delta-value" style={{ color }}>
        {percentage === null
          ? "No earlier result"
          : `${percentage > 0 ? "+" : ""}${number(percentage)} percentage points`}
      </div>
      {marks !== null && (
        <div className="sr-delta-caption">
          {marks > 0 ? "+" : ""}
          {number(marks)} marks at this test's maximum
        </div>
      )}
    </div>
  );
}
function ordinal(n: number) {
  const last = n % 100;
  return `${n}${last >= 11 && last <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"}`;
}
function topicColor(read: string) {
  return `var(--color-${read === "strong" ? "success" : read === "on-track" ? "warning" : "danger"})`;
}
function topicNote(report: ReportData) {
  const weak = report.topicPerformance.filter((t) => t.read === "needs-focus");
  const strong = report.topicPerformance.filter((t) => t.read === "strong");
  return weak.length
    ? `${weak.length} topic${weak.length > 1 ? "s need" : " needs"} focused practice. Start with ${weak[0].topic}.`
    : strong.length
      ? `${strong.length} topic${strong.length > 1 ? "s show" : " shows"} strong understanding. Keep practising to make that progress consistent.`
      : report.topicPerformance.length
        ? "The topics shown are on track. Keep practising the skills covered in this test."
        : "The topic breakdown will become available when questions have topic tags.";
}
function honestPractice(value: string) {
  return value
    .replace(/practice questions assigned/i, "practice questions suggested")
    .replace(/timed questions assigned/i, "timed questions suggested")
    .replace(
      /advanced set unlocked/i,
      "Ask your teacher for a more advanced practice set",
    );
}
