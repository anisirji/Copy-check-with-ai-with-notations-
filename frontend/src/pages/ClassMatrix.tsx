import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import type { ClassMatrix, ClassReport, MistakeTag } from "../types";
import "./teacher-reports.css";

type Group = "rebuild" | "consolidate" | "extend";
interface Plan {
  groups: Record<string, Group>;
  reteachDate: string;
  retestDate: string;
  practiceDays: number;
}
interface StudentRun {
  studentId: string;
  runId: string;
}
const GROUPS: Group[] = ["rebuild", "consolidate", "extend"];
const GROUP_LABELS: Record<Group, string> = {
  rebuild: "Rebuild",
  consolidate: "Consolidate",
  extend: "Extend",
};
const GROUP_COPY: Record<Group, string> = {
  rebuild: "Revisit prerequisite concepts with short, guided practice sets.",
  consolidate:
    "Use worked examples and timed drills to turn partial answers into full marks.",
  extend:
    "Try unfamiliar applications of the same concepts before moving to new syllabus.",
};
const number = (value: number) =>
  value.toLocaleString(undefined, { maximumFractionDigits: 2 });
const questionLabel = (id: string) => (/^q/i.test(id) ? id : `Q${id}`);
const kindLabel = {
  full: "Full marks",
  partial: "Partial marks",
  none: "No marks",
};
const emptyPlan = (): Plan => ({
  groups: {},
  reteachDate: "",
  retestDate: "",
  practiceDays: 10,
});

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error || "The class matrix could not be loaded. Please try again.",
    );
  return data as T;
}

function initialPlan(examId: string, matrix: ClassMatrix): Plan {
  const plan = emptyPlan();
  for (const group of GROUPS)
    for (const student of matrix.groups[group])
      plan.groups[student.studentId] = group;
  try {
    const saved = JSON.parse(
      localStorage.getItem(`scholiphi:follow-up:${examId}`) || "null",
    ) as Partial<Plan> | null;
    if (!saved) return plan;
    if (saved.groups && typeof saved.groups === "object")
      for (const student of matrix.rows) {
        const group = saved.groups[student.studentId];
        if (GROUPS.includes(group)) plan.groups[student.studentId] = group;
      }
    if (
      typeof saved.reteachDate === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(saved.reteachDate)
    )
      plan.reteachDate = saved.reteachDate;
    if (
      typeof saved.retestDate === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(saved.retestDate)
    )
      plan.retestDate = saved.retestDate;
    if (
      typeof saved.practiceDays === "number" &&
      Number.isInteger(saved.practiceDays) &&
      saved.practiceDays >= 1 &&
      saved.practiceDays <= 60
    )
      plan.practiceDays = saved.practiceDays;
  } catch {
    /* A local draft is optional; the current groups remain usable. */
  }
  return plan;
}

export default function ClassMatrixPage() {
  const { id } = useParams<{ id: string }>();
  const [matrix, setMatrix] = useState<ClassMatrix | null>(null);
  const [report, setReport] = useState<ClassReport | null>(null);
  const [studentRuns, setStudentRuns] = useState<StudentRun[]>([]);
  const [plan, setPlan] = useState<Plan>(emptyPlan);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState("");
  const [saveError, setSaveError] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("highest");

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setError(null);
    setMatrix(null);
    Promise.all([
      getJson<{ matrix: ClassMatrix }>(`/exam/${id}/matrix`),
      getJson<{ report: ClassReport }>(`/exam/${id}/report`),
      getJson<{ students: StudentRun[] }>(`/exam/${id}/students`),
    ])
      .then(([m, r, s]) => {
        if (cancelled) return;
        setMatrix(m.matrix);
        setReport(r.report);
        setStudentRuns(s.students);
        setPlan(initialPlan(id, m.matrix));
        setDirty(false);
        setNotice("");
        setSaveError("");
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(
            err instanceof Error
              ? err.message
              : "Unable to load the class matrix.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [id, reload]);

  useEffect(() => {
    if (!matrix || window.location.hash !== "#follow-up") return;
    document.getElementById("follow-up")?.scrollIntoView({ block: "start" });
  }, [matrix]);

  function updatePlan(next: Plan) {
    setPlan(next);
    setDirty(true);
    setNotice("");
    setSaveError("");
  }
  function savePlan() {
    if (
      plan.reteachDate &&
      plan.retestDate &&
      plan.retestDate < plan.reteachDate
    ) {
      setSaveError("Choose a re-test date on or after the re-teach date.");
      return;
    }
    try {
      localStorage.setItem(`scholiphi:follow-up:${id}`, JSON.stringify(plan));
      setDirty(false);
      setNotice(
        "Saved in this browser. This plan has not been assigned or sent.",
      );
      setSaveError("");
    } catch {
      setSaveError(
        "This browser could not save the plan. You can still print it for your records.",
      );
    }
  }

  if (error)
    return (
      <div className="class-matrix">
        <PageHeader breadcrumb={<Link to="/">Assessments</Link>} />
        <div className="tr-empty" role="alert">
          <h1>We couldn’t load the class matrix</h1>
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
  if (!matrix || !report)
    return (
      <div className="class-matrix" aria-busy="true">
        <div className="tr-loading" role="status">
          Loading class matrix…
        </div>
      </div>
    );

  const maxBandCount = Math.max(1, ...report.bandCounts.map((b) => b.count));
  const largestBand = [...report.bandCounts].sort(
    (a, b) => b.count - a.count,
  )[0];
  const weakestTopic = [...report.topicCoverage].sort(
    (a, b) => a.marksEarnedPct - b.marksEarnedPct,
  )[0];
  const reasons = report.markLossReasons.filter((r) => r.reason !== "correct");
  const rows = matrix.rows
    .filter((row) =>
      row.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : sort === "lowest"
          ? a.total - b.total
          : b.total - a.total,
    );

  return (
    <div className="class-matrix">
      <PageHeader
        breadcrumb={
          <>
            <Link to="/">Assessments</Link>
            <span>/</span>
            <span>{report.exam.class}</span>
            <span>/</span>
            <Link to={`/exam/${id}/report`}>{report.exam.title}</Link>
            <span>/</span>
            <span>Class matrix</span>
          </>
        }
        actions={
          <>
            <Link className="ghost-btn" to={`/exam/${id}/report`}>
              Test analysis
            </Link>
            <button className="primary-btn" onClick={() => window.print()}>
              Export for staff meeting
            </button>
          </>
        }
      />
      <div className="cm-header">
        <div>
          <div className="ta-eyebrow">
            Teacher view · Who got what, and what happens next
          </div>
          <h1 className="ta-title">Class matrix and follow-up</h1>
          <p className="ta-subtitle">
            Every student against every question, then the groups and the
            re-teach plan that come out of it.
          </p>
        </div>
        <div className="cm-legend">
          {(["full", "partial", "none"] as const).map((kind) => (
            <span className="cm-legend-item" key={kind}>
              <span className={`cm-swatch tr-kind-${kind}`} />
              {kindLabel[kind]}
            </span>
          ))}
        </div>
      </div>
      {!matrix.rows.length ? (
        <section className="tr-empty">
          <h2>No released results yet</h2>
          <p>
            Release reviewed answer sheets to compare student responses and plan
            follow-up for the class.
          </p>
          <Link className="primary-btn" to={`/exam/${id}/grade`}>
            Grade an answer sheet
          </Link>
          <Link className="ghost-btn" to={`/exam/${id}/report`}>
            Back to test analysis
          </Link>
        </section>
      ) : (
        <>
          <div className="ta-two-col">
            <section className="ta-card">
              <h2>How the class is spread</h2>
              <p className="ta-card-hint">
                {largestBand
                  ? `${largestBand.count} of ${matrix.rows.length} students are in the ${largestBand.band} mark band.`
                  : "Scores grouped by marks earned."}
              </p>
              <div
                className="cm-bandchart"
                role="img"
                aria-label={report.bandCounts
                  .map((b) => `${b.band} marks: ${b.count} students`)
                  .join("; ")}
              >
                {report.bandCounts.map((band, index) => (
                  <div className="cm-band-col" key={band.band}>
                    <div className="cm-band-count">
                      {band.count}
                      {band.count > 0 &&
                        ` student${band.count === 1 ? "" : "s"}`}
                    </div>
                    <div
                      className={`cm-band-bar tr-band-${Math.min(index, 3)}`}
                      style={{
                        height: band.count
                          ? (120 * band.count) / maxBandCount
                          : 3,
                      }}
                    />
                    <div className="cm-band-label">{band.band}</div>
                  </div>
                ))}
              </div>
            </section>
            <section className="ta-card">
              <h2>Why marks were lost</h2>
              <p className="ta-card-hint">
                A careless slip and a missing concept need different responses.
              </p>
              {reasons.length ? (
                <>
                  <div className="cm-reason-list">
                    {reasons.map((reason) => (
                      <div className="tr-reason" key={String(reason.reason)}>
                        <div>
                          <span>{reasonLabel(reason.reason)}</span>
                          <strong>{number(reason.percentage)}%</strong>
                        </div>
                        <div className="cm-reason-bar">
                          <div
                            className={`cm-reason-bar-fill tr-reason-${reason.reason || "other"}`}
                            style={{
                              width: `${Math.max(0, Math.min(100, reason.percentage))}%`,
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="cm-reason-note">{reasonNote(reasons)}</p>
                </>
              ) : (
                <p className="cm-reason-note">
                  {matrix.rows.every(
                    (row) => row.total === report.exam.totalMarks,
                  )
                    ? "The class earned full marks. No lost marks to analyse."
                    : "Mark-loss reasons have not been recorded for these answers."}
                </p>
              )}
            </section>
          </div>
          <section className="ta-card">
            <div className="ta-card-head">
              <div>
                <h2>Every student, every question</h2>
                <p className="ta-card-hint">
                  Marks earned per question. Select a cell to open that answer.
                  Previous results are compared on this test’s scale.
                </p>
              </div>
            </div>
            <div className="tr-matrix-tools">
              <label>
                Find a student
                <input
                  type="search"
                  placeholder="Search names"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <label>
                Sort by
                <select
                  value={sort}
                  onChange={(event) => setSort(event.target.value)}
                >
                  <option value="highest">Total, highest first</option>
                  <option value="lowest">Total, lowest first</option>
                  <option value="name">Student name</option>
                </select>
              </label>
            </div>
            <div
              className="cm-matrix-scroll"
              tabIndex={0}
              role="region"
              aria-label="Student question matrix"
            >
              <table className="cm-matrix">
                <thead>
                  <tr>
                    <th scope="col" className="cm-name-col">
                      Student
                    </th>
                    {matrix.questions.map((question) => (
                      <th
                        scope="col"
                        className="cm-qcol"
                        key={question.id}
                        title={question.concept}
                      >
                        <div>{questionLabel(question.id)}</div>
                        <div className="cm-qmax">
                          /{number(question.maxMarks)}
                        </div>
                      </th>
                    ))}
                    <th scope="col" className="cm-total-col">
                      Total
                    </th>
                    <th scope="col" className="cm-vs-col">
                      Vs last
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const run = studentRuns.find(
                      (s) => s.studentId === row.studentId,
                    );
                    return (
                      <tr key={row.studentId}>
                        <th scope="row" className="cm-name-col">
                          {row.studentId ? (
                            <Link
                              className="ta-inline-link"
                              to={`/exam/${id}/students/${encodeURIComponent(row.studentId)}/report`}
                            >
                              {row.name}
                            </Link>
                          ) : (
                            row.name
                          )}
                        </th>
                        {row.perQuestion.map((cell) => (
                          <td
                            key={cell.questionId}
                            className={`cm-cell tr-kind-${cell.kind}`}
                          >
                            {run ? (
                              <Link
                                className="tr-answer-cell"
                                to={`/review/${run.runId}?question=${encodeURIComponent(cell.questionId)}`}
                                aria-label={`${row.name}, ${questionLabel(cell.questionId)}: ${number(cell.awarded)} of ${number(cell.max)} marks, ${kindLabel[cell.kind]}. Open answer.`}
                              >
                                {number(cell.awarded)}
                              </Link>
                            ) : (
                              <span
                                title={`${number(cell.awarded)} of ${number(cell.max)} marks, ${kindLabel[cell.kind]}`}
                              >
                                {number(cell.awarded)}
                              </span>
                            )}
                          </td>
                        ))}
                        <td className="cm-total-col">{number(row.total)}</td>
                        <td
                          className="cm-vs-col"
                          style={{
                            color:
                              row.vsLast === null || row.vsLast === 0
                                ? "var(--color-muted)"
                                : row.vsLast > 0
                                  ? "var(--color-success)"
                                  : "var(--color-danger)",
                          }}
                          title={
                            row.vsLast === null
                              ? "No earlier test"
                              : "Change in marks, adjusted to this test’s scale"
                          }
                        >
                          {row.vsLast === null ? (
                            <span aria-label="No earlier test">—</span>
                          ) : (
                            `${row.vsLast > 0 ? "+" : ""}${number(row.vsLast)}`
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {!rows.length && (
                    <tr>
                      <td
                        colSpan={matrix.questions.length + 3}
                        className="tr-no-matches"
                      >
                        No students match “{search}”.{" "}
                        <button
                          className="ta-inline-link"
                          onClick={() => setSearch("")}
                        >
                          Clear search
                        </button>
                      </td>
                    </tr>
                  )}
                  <tr className="cm-summary-row">
                    <th scope="row" className="cm-name-col">
                      Whole class % of marks
                    </th>
                    {matrix.classPctByQuestion.map((cell) => (
                      <td
                        key={cell.questionId}
                        className="cm-cell"
                        style={{
                          color:
                            cell.pct >= 70
                              ? "var(--color-success)"
                              : cell.pct >= 45
                                ? "var(--color-warning)"
                                : "var(--color-danger)",
                        }}
                      >
                        {number(cell.pct)}%
                      </td>
                    ))}
                    <td className="cm-total-col cm-avg" title="Class average">
                      {number(report.average)}
                    </td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
          <form
            id="follow-up"
            className="ta-two-col ta-final-row"
            onSubmit={(event) => {
              event.preventDefault();
              savePlan();
            }}
          >
            <section>
              <h2 className="ta-section-title">
                Three groups, formed from the matrix
              </h2>
              <p className="cm-groups-hint">
                Move any student before saving your follow-up plan. Groups start
                from the current test scores.
              </p>
              <div className="cm-groups">
                {GROUPS.map((group) => {
                  const members = matrix.rows.filter(
                    (row) => plan.groups[row.studentId] === group,
                  );
                  return (
                    <section className="cm-group-card" key={group}>
                      <h3 className={`cm-group-badge tr-group-${group}`}>
                        {GROUP_LABELS[group]} <span>{members.length}</span>
                      </h3>
                      <ul className="tr-group-members">
                        {members.map((student) => (
                          <li key={student.studentId}>
                            <span>{student.name}</span>
                            <label className="tr-group-move">
                              <span className="tr-sr-only">
                                Move {student.name} to group
                              </span>
                              <select
                                value={group}
                                onChange={(event) =>
                                  updatePlan({
                                    ...plan,
                                    groups: {
                                      ...plan.groups,
                                      [student.studentId]: event.target
                                        .value as Group,
                                    },
                                  })
                                }
                              >
                                {GROUPS.map((value) => (
                                  <option key={value} value={value}>
                                    {GROUP_LABELS[value]}
                                  </option>
                                ))}
                              </select>
                            </label>
                          </li>
                        ))}
                      </ul>
                      {!members.length && (
                        <p className="cm-group-names">
                          No students in this group.
                        </p>
                      )}
                      <p className="cm-group-body">{GROUP_COPY[group]}</p>
                    </section>
                  );
                })}
              </div>
            </section>
            <section className="ta-dark-card">
              <h2>Closing the loop</h2>
              <p className="ta-card-hint">
                A gap is only closed when it is re-tested.
              </p>
              <div className="ta-na-item">
                <h3 className="ta-na-eyebrow">
                  Re-teach:{" "}
                  {weakestTopic?.topic || "review the weakest concepts"}
                </h3>
                <p className="ta-na-body">
                  Review the answer patterns and prepare worked examples for the
                  class.
                </p>
                <label className="tr-plan-label">
                  Re-teach date
                  <input
                    type="date"
                    value={plan.reteachDate}
                    onChange={(event) =>
                      updatePlan({ ...plan, reteachDate: event.target.value })
                    }
                  />
                </label>
              </div>
              <div className="ta-na-item">
                <h3 className="ta-na-eyebrow">Practice window</h3>
                <p className="ta-na-body">
                  Choose practice for each group, then allow time to work
                  through it.
                </p>
                <label className="tr-plan-label">
                  Practice days
                  <input
                    type="number"
                    min="1"
                    max="60"
                    required
                    value={plan.practiceDays}
                    onChange={(event) =>
                      updatePlan({
                        ...plan,
                        practiceDays: Number(event.target.value),
                      })
                    }
                  />
                </label>
              </div>
              <div className="ta-na-item">
                <h3 className="ta-na-eyebrow">Re-test, same concepts</h3>
                <p className="ta-na-body">
                  Use fresh questions to check whether the gaps have closed.
                </p>
                <label className="tr-plan-label">
                  Re-test date
                  <input
                    type="date"
                    min={plan.reteachDate || undefined}
                    value={plan.retestDate}
                    onChange={(event) =>
                      updatePlan({ ...plan, retestDate: event.target.value })
                    }
                  />
                </label>
              </div>
              <p className="tr-draft-note">
                Local draft. No assignments or messages are sent from this plan.
              </p>
              {saveError && (
                <p className="tr-plan-error" role="alert">
                  {saveError}
                </p>
              )}
              <button type="submit" className="approve-all-btn">
                {dirty ? "Save changes to plan" : "Save follow-up plan"}
              </button>
              <p className="tr-save-status" role="status">
                {notice ||
                  (dirty
                    ? "You have unsaved changes."
                    : "Groups and dates are saved only in this browser.")}
              </p>
            </section>
          </form>
        </>
      )}
    </div>
  );
}

function reasonLabel(reason: MistakeTag | "correct"): string {
  if (reason === "concept_gap") return "Concept not understood";
  if (reason === "careless") return "Method right, careless finish";
  if (reason === "incomplete") return "Started, did not complete";
  if (reason === "left_blank") return "Left blank";
  return "Other";
}
function reasonNote(reasons: ClassReport["markLossReasons"]): string {
  const careless =
    reasons.find((r) => r.reason === "careless")?.percentage ?? 0;
  const concept =
    reasons.find((r) => r.reason === "concept_gap")?.percentage ?? 0;
  if (careless >= 20)
    return `${number(careless)}% of lost marks came from careless finishes. Short timed drills and a checking routine may help.`;
  if (concept >= 40)
    return `${number(concept)}% of lost marks came from concept gaps. Revisit the weakest topics before adding practice.`;
  return "Use the answer-level feedback to separate gaps in understanding from incomplete work and slips.";
}
