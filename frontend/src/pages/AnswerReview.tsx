import { useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import AnnotationOverlay from "../components/AnnotationOverlay";
import { annotationLayout } from "../../../backend/src/services/annotation-svg";
import PageHeader from "../components/PageHeader";
import type {
  ClassReport,
  EvaluationDoc,
  QuestionGrading,
  RubricEval,
} from "../types";
import ReviewCard from "./ReviewCard";
import "./review-student.css";

type ReviewQuestion = QuestionGrading & { teacherComment?: string };
type StudentRow = { studentId: string; runId: string; name: string };
const marks = (n: number) =>
  n.toLocaleString(undefined, { maximumFractionDigits: 2 });
const scoreKind = (g: QuestionGrading) =>
  g.awardedMarks === g.maxMarks
    ? "good"
    : g.awardedMarks > 0
      ? "partial"
      : "wrong";
const scoreColor = (g: QuestionGrading) =>
  `var(--color-${scoreKind(g) === "good" ? "success" : scoreKind(g) === "partial" ? "warning" : "danger"})`;

async function jsonResponse<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      body.error || "The request could not be completed. Please try again.",
    );
  return body as T;
}

export default function AnswerReview() {
  const { runId } = useParams<{ runId: string }>();
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const [doc, setDoc] = useState<EvaluationDoc | null>(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [classReport, setClassReport] = useState<ClassReport | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [releasing, setReleasing] = useState(false);
  const [annotationOpen, setAnnotationOpen] = useState(false);
  const [annotationQuestion, setAnnotationQuestion] = useState("");
  const [annotationText, setAnnotationText] = useState("");
  const [annotationBusy, setAnnotationBusy] = useState(false);
  const [assetRevision, setAssetRevision] = useState(0);
  const [editingQuestions, setEditingQuestions] = useState<string[]>([]);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const selected = search.get("question");
  const examId = doc?.examId ?? doc?.exam?.id;

  useEffect(() => {
    if (!runId) return;
    let active = true;
    setDoc(null);
    setError("");
    setActionError("");
    setStudents([]);
    setClassReport(null);
    setZoom(100);
    setAnnotationOpen(false);
    setEditingQuestions([]);
    fetch(`/run/${encodeURIComponent(runId)}`)
      .then(jsonResponse<EvaluationDoc>)
      .then((result) => {
        if (!active) return;
        setDoc(result);
        setAssetRevision(
          result.annotationGrounding
            ? Date.parse(result.annotationGrounding.updatedAt)
            : result.correction
              ? Date.parse(result.correction.correctedAt)
              : 0,
        );
        setCurrentPage(result.pages[0]?.page ?? 1);
        setAnnotationQuestion(result.grading[0]?.questionId ?? "");
      })
      .catch((err) => active && setError(err.message));
    return () => {
      active = false;
    };
  }, [runId]);

  useEffect(() => {
    if (!examId) return;
    let active = true;
    fetch(`/exam/${encodeURIComponent(examId)}/students?includeUnreleased=1`)
      .then(jsonResponse<{ students: StudentRow[] }>)
      .then((r) => active && setStudents(r.students))
      .catch(() => {});
    fetch(`/exam/${encodeURIComponent(examId)}/report`)
      .then(jsonResponse<{ report: ClassReport }>)
      .then((r) => active && setClassReport(r.report))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [examId]);

  const [verdictFilter, setVerdictFilter] = useState<
    "all" | "needs_review" | "incorrect" | "partial" | "correct"
  >("all");
  const gradedAll = useMemo(
    () =>
      doc?.grading.map((grading, index) => ({
        grading,
        marker: index + 1,
        anchor: findAnchor(doc, grading),
      })) ?? [],
    [doc],
  );
  const graded = useMemo(
    () =>
      gradedAll.filter(({ grading }) => matchesVerdict(grading, verdictFilter)),
    [gradedAll, verdictFilter],
  );
  useEffect(() => {
    if (!selected || !doc) return;
    const target = graded.find(
      ({ grading }) => grading.questionId === selected,
    );
    if (target?.anchor) setCurrentPage(target.anchor.page);
    cardRefs.current[selected]?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  }, [selected, doc?.runId, graded]);

  const flagged = doc?.grading.filter((g) => g.needsTeacherReview).length ?? 0;
  const currentStudent = students.findIndex((s) => s.runId === runId);
  const studentName =
    students[currentStudent]?.name ||
    (doc?.studentId ? `Student ${doc.studentId}` : "Student answer sheet");
  const released = Boolean(doc?.release?.releasedAt);
  const total =
    Math.round(
      (doc?.grading.reduce((sum, g) => sum + g.awardedMarks, 0) ?? 0) * 100,
    ) / 100;
  const maximum =
    Math.round(
      (doc?.grading.reduce((sum, g) => sum + g.maxMarks, 0) ?? 0) * 100,
    ) / 100;
  const totalsMismatch =
    !!doc &&
    (maximum !== doc.exam?.totalMarks ||
      maximum !== doc.analytics.totalMax ||
      total !== doc.analytics.totalAwarded ||
      doc.grading.length !== doc.exam?.questions.length ||
      doc.grading.some((g) => {
        const question = doc.exam?.questions.find((q) => q.id === g.questionId);
        return (
          !question ||
          g.maxMarks !== question.maxMarks ||
          Math.round(
            g.rubricEvaluation.reduce((sum, c) => sum + c.marksAwarded, 0) *
              100,
          ) /
            100 !==
            g.awardedMarks
        );
      }));

  function selectQuestion(id: string) {
    setSearch({ question: id }, { replace: true });
  }
  function updated(result: EvaluationDoc) {
    setDoc(result);
    setAssetRevision(Date.now());
  }

  async function release() {
    if (!doc || !runId || editingQuestions.length || totalsMismatch) return;
    setActionError("");
    setReleasing(true);
    try {
      const body = await fetch(`/run/${encodeURIComponent(runId)}/release`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ releasedBy: "teacher" }),
      }).then(jsonResponse<{ release: EvaluationDoc["release"] }>);
      setDoc((current) =>
        current ? { ...current, release: body.release } : current,
      );
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setReleasing(false);
    }
  }
  async function saveAnnotation() {
    if (!runId || !annotationQuestion || !annotationText.trim()) return;
    setActionError("");
    setAnnotationBusy(true);
    try {
      const body = await fetch(`/run/${encodeURIComponent(runId)}/grading`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          questionId: annotationQuestion,
          comment: annotationText.trim(),
        }),
      }).then(jsonResponse<{ result: EvaluationDoc }>);
      updated(body.result);
      setAnnotationOpen(false);
      setAnnotationText("");
      selectQuestion(annotationQuestion);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setAnnotationBusy(false);
    }
  }

  if (error)
    return (
      <div className="review-state" role="alert">
        <h1>Unable to open this answer sheet</h1>
        <p>{error}</p>
        <Link to="/">Back to exams</Link>
      </div>
    );
  if (!doc)
    return (
      <div className="review-state" role="status">
        <div className="spinner" />
        <p>Loading answer sheet and feedback…</p>
      </div>
    );

  const page = doc.pages.find((p) => p.page === currentPage);
  const pageAnnotations = doc.annotations.filter((a) => a.page === currentPage);
  const paperLayout =
    page && showAnnotations
      ? annotationLayout(page.width, page.height, pageAnnotations)
      : null;
  const full = doc.grading.filter((g) => g.awardedMarks === g.maxMarks).length;
  const careless = doc.grading.filter((g) =>
    g.rubricEvaluation.some((c) => c.mistakeTag === "careless"),
  ).length;
  const conceptGaps = doc.grading.filter((g) =>
    g.rubricEvaluation.some((c) => c.mistakeTag === "concept_gap"),
  ).length;
  const partial = doc.grading.filter(
    (g) => g.awardedMarks > 0 && g.awardedMarks < g.maxMarks,
  ).length;

  return (
    <div className="answer-review">
      <PageHeader
        breadcrumb={
          <>
            <Link to={examId ? `/exam/${examId}/matrix` : "/"}>
              Answer review
            </Link>
            <span>/</span>
            <span>{studentName}</span>
            <span>/</span>
            <span>{doc.exam?.title}</span>
          </>
        }
        actions={
          <>
            <button
              className="ghost-btn"
              disabled={currentStudent <= 0 || editingQuestions.length > 0}
              onClick={() =>
                navigate(`/review/${students[currentStudent - 1].runId}`)
              }
            >
              ← Previous student
            </button>
            <button
              className="ghost-btn"
              disabled={
                currentStudent < 0 ||
                currentStudent === students.length - 1 ||
                editingQuestions.length > 0
              }
              onClick={() =>
                navigate(`/review/${students[currentStudent + 1].runId}`)
              }
            >
              Next student →
            </button>
            {released ? (
              <Link className="primary-btn" to={`/review/${runId}/student`}>
                View released report
              </Link>
            ) : (
              <button
                className="primary-btn"
                disabled={
                  flagged > 0 ||
                  releasing ||
                  editingQuestions.length > 0 ||
                  totalsMismatch
                }
                onClick={release}
              >
                {releasing ? "Releasing…" : "Approve and release"}
              </button>
            )}
          </>
        }
      />
      <header className="ar-intro">
        <div>
          <div className="ta-eyebrow">
            THE PAPER ON THE LEFT · THE FEEDBACK ON THE RIGHT
          </div>
          <h1>Answer review: {studentName}</h1>
          <p>
            Each marker opens its feedback. Review the marks before releasing
            the report.
          </p>
        </div>
        <div className="ar-chip-row">
          <span className="ar-chip">
            <strong>{marks(total)}</strong> / {marks(maximum)}
            {!released && " · Draft"}
          </span>
          <span className="ar-chip green">{full} fully correct</span>
          <span className="ar-chip amber">{careless} careless finishes</span>
          <span className="ar-chip red">{conceptGaps} concept gaps</span>
        </div>
      </header>
      {totalsMismatch && (
        <div className="error-msg" role="alert">
          The saved marks are inconsistent.{" "}
          {maximum !== doc.exam?.totalMarks
            ? `Question maxima add up to ${marks(maximum)}, while the exam is set to ${marks(doc.exam?.totalMarks ?? 0)}.`
            : "The saved total or step marks do not match the question marks."}{" "}
          Correct the marking scheme and recalculate this evaluation before
          releasing it.
        </div>
      )}
      {doc.correction && (
        <div className="ar-review-status" role="status">
          <strong>
            Draft corrected from {marks(doc.correction.previousTotalAwarded)}/
            {marks(doc.correction.previousTotalMax)}.
          </strong>{" "}
          {doc.correction.reason} Review the corrected marks before release.
        </div>
      )}
      {(flagged > 0 || editingQuestions.length > 0 || released) && (
        <div
          className={`ar-review-status ${released ? "released" : ""}`}
          role="status"
        >
          {editingQuestions.length
            ? "Save or cancel your changes before moving to another student or releasing."
            : released
              ? "This report has been released to the student and parent."
              : `${flagged} question${flagged === 1 ? " needs" : "s need"} your review. Edit the marks or choose Agree on each flagged question.`}
        </div>
      )}
      {actionError && (
        <div className="error-msg" role="alert">
          {actionError}
        </div>
      )}
      <div className="ar-split">
        <div className="ar-left">
          <section className="ar-paper-card" aria-label="Marked answer sheet">
            <div className="ar-paper-head">
              <div className="ar-paper-name">
                {doc.outputs.originalPdf?.split("/").pop() || "Answer sheet"}
              </div>
              <div className="ar-zoom">
                <button
                  className="ghost-btn small"
                  aria-pressed={showAnnotations}
                  onClick={() => setShowAnnotations((show) => !show)}
                >
                  {showAnnotations ? "Show original" : "Show marks"}
                </button>
                <button
                  className="ghost-btn small"
                  aria-label="Zoom out"
                  disabled={zoom <= 75}
                  onClick={() => setZoom((z) => z - 25)}
                >
                  −
                </button>
                <output aria-live="polite">{zoom}%</output>
                <button
                  className="ghost-btn small"
                  aria-label="Zoom in"
                  disabled={zoom >= 200}
                  onClick={() => setZoom((z) => z + 25)}
                >
                  +
                </button>
              </div>
              <div className="ar-page-tabs" aria-label="Answer sheet pages">
                {doc.pages.map((p) => (
                  <button
                    key={p.page}
                    className={`ar-page-tab ${p.page === currentPage ? "active" : ""}`}
                    aria-current={p.page === currentPage ? "page" : undefined}
                    onClick={() => setCurrentPage(p.page)}
                  >
                    Page {p.page}
                  </button>
                ))}
                <span className="ar-page-note">
                  {pageAnnotations.length} annotations
                </span>
              </div>
            </div>
            <div className="ar-paper-viewport">
              {page ? (
                <div className="ar-page-wrapper" style={{ width: `${zoom}%` }}>
                  <div
                    className="ar-page-sheet"
                    style={{
                      aspectRatio: paperLayout
                        ? `${paperLayout.width} / ${paperLayout.height}`
                        : `${page.width} / ${page.height}`,
                    }}
                  >
                    <img
                      src={outputUrl(page.imagePath)}
                      alt={`Handwritten answer sheet, page ${page.page}`}
                      style={
                        paperLayout
                          ? {
                              position: "absolute",
                              left: `${(paperLayout.left / paperLayout.width) * 100}%`,
                              top: `${(paperLayout.top / paperLayout.height) * 100}%`,
                              width: `${(page.width / paperLayout.width) * 100}%`,
                            }
                          : undefined
                      }
                    />
                    {showAnnotations && (
                      <AnnotationOverlay
                        annotations={pageAnnotations}
                        width={page.width}
                        height={page.height}
                      />
                    )}
                  </div>
                  {graded
                    .map((item) => ({
                      ...item,
                      anchor: findAnchor(doc, item.grading, currentPage),
                    }))
                    .filter(({ anchor }) => anchor?.page === currentPage)
                    .map(({ grading, marker, anchor }) => (
                      <button
                        key={grading.questionId}
                        className={`ar-paper-marker ${selected === grading.questionId ? "selected" : ""}`}
                        style={{
                          top: `${paperLayout ? ((paperLayout.top + (anchor?.y ?? 0) * page.height) / paperLayout.height) * 100 : Math.min(97, Math.max(3, (anchor?.y ?? 0) * 100))}%`,
                          background: scoreColor(grading),
                        }}
                        aria-label={`Question ${grading.questionId}, ${grading.awardedMarks} of ${grading.maxMarks} marks. Open feedback.`}
                        onClick={() => selectQuestion(grading.questionId)}
                      >
                        {marker}
                      </button>
                    ))}
                </div>
              ) : (
                <p className="review-empty">
                  No scanned pages are available for this answer sheet.
                </p>
              )}
            </div>
            <div className="ar-paper-actions">
              <button
                className="ghost-btn"
                onClick={() => {
                  setAnnotationOpen((v) => !v);
                  setAnnotationQuestion(
                    selected || doc.grading[0]?.questionId || "",
                  );
                }}
                disabled={released || doc.grading.length === 0}
              >
                + Add annotation
              </button>
              {doc.outputs.evaluatedPdf && (
                <a
                  className="ghost-btn"
                  href={`${outputUrl(doc.outputs.evaluatedPdf)}?v=${assetRevision}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Print with comments ↗
                </a>
              )}
            </div>
            {annotationOpen && (
              <form
                className="ar-annotation-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveAnnotation();
                }}
              >
                <h3>Add a teacher comment</h3>
                <label>
                  Question
                  <select
                    value={annotationQuestion}
                    onChange={(e) => setAnnotationQuestion(e.target.value)}
                  >
                    {doc.grading.map((g) => (
                      <option value={g.questionId} key={g.questionId}>
                        Question {g.questionId}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Comment
                  <textarea
                    required
                    maxLength={1500}
                    rows={3}
                    value={annotationText}
                    onChange={(e) => setAnnotationText(e.target.value)}
                    placeholder="Explain the correction or next step."
                  />
                </label>
                <p className="dim">
                  Saved beside this question on the marked paper. This replaces
                  any earlier teacher comment for the question.
                </p>
                <div className="ar-card-actions">
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => setAnnotationOpen(false)}
                    disabled={annotationBusy}
                  >
                    Cancel
                  </button>
                  <button
                    className="primary-btn"
                    disabled={annotationBusy || !annotationText.trim()}
                  >
                    {annotationBusy ? "Saving…" : "Save annotation"}
                  </button>
                </div>
              </form>
            )}
          </section>
          <section className="ar-summary-card">
            <h3>Where the marks went</h3>
            <table className="ar-marks-breakdown" aria-label="Marks breakdown">
              <thead>
                <tr>
                  <th scope="col">Question</th>
                  <th scope="col">Awarded</th>
                  <th scope="col">Maximum</th>
                </tr>
              </thead>
              <tbody>
                {doc.grading.map((g) => (
                  <tr key={g.questionId}>
                    <th scope="row">
                      <button
                        className="ghost-btn small"
                        onClick={() => selectQuestion(g.questionId)}
                      >
                        Q{g.questionId}
                      </button>
                    </th>
                    <td>{marks(g.awardedMarks)}</td>
                    <td>{marks(g.maxMarks)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">{released ? "Total" : "Draft total"}</th>
                  <td>{marks(total)}</td>
                  <td>{marks(maximum)}</td>
                </tr>
              </tfoot>
            </table>
            {doc.exam?.marksNormalization && (
              <p className="ar-summary-note">
                The question allocations were proportionally scaled from{" "}
                {marks(doc.exam.marksNormalization.originalTotalMarks)} to{" "}
                {marks(doc.exam.marksNormalization.targetTotalMarks)} marks.
                Compare them with the printed paper.
              </p>
            )}
            <SummaryBar
              label="Full marks"
              count={full}
              total={doc.grading.length}
              kind="success"
            />
            <SummaryBar
              label="Partial credit"
              count={partial}
              total={doc.grading.length}
              kind="warning"
            />
            <SummaryBar
              label="No marks awarded"
              count={doc.grading.length - full - partial}
              total={doc.grading.length}
              kind="danger"
            />
            <p className="ar-summary-note">
              {marks(maximum - total)} marks to recover. The step marks show
              where credit was earned and where more work is needed.
            </p>
          </section>
        </div>
        <section className="ar-right" aria-label="Question feedback">
          <div className="ar-right-head">
            <h2>Feedback</h2>
            <span>Marker on the page → card below</span>
          </div>
          <VerdictFilter
            value={verdictFilter}
            onChange={setVerdictFilter}
            counts={{
              all: gradedAll.length,
              needs_review: gradedAll.filter(({ grading }) =>
                matchesVerdict(grading, "needs_review"),
              ).length,
              incorrect: gradedAll.filter(({ grading }) =>
                matchesVerdict(grading, "incorrect"),
              ).length,
              partial: gradedAll.filter(({ grading }) =>
                matchesVerdict(grading, "partial"),
              ).length,
              correct: gradedAll.filter(({ grading }) =>
                matchesVerdict(grading, "correct"),
              ).length,
            }}
          />
          {graded.length === 0 && (
            <p className="dim" style={{ padding: "8px 12px" }}>
              No questions match this filter.
            </p>
          )}
          {graded.map(({ grading, marker, anchor }) => (
            <FeedbackCard
              key={`${runId}-${grading.questionId}`}
              grading={grading}
              marker={marker}
              doc={doc}
              selected={selected === grading.questionId}
              hasAnchor={Boolean(anchor)}
              refBind={(el) => {
                cardRefs.current[grading.questionId] = el;
              }}
              onSelect={() => {
                selectQuestion(grading.questionId);
                if (anchor) setCurrentPage(anchor.page);
              }}
              onUpdated={updated}
              onEditing={(editing) =>
                setEditingQuestions((ids) =>
                  editing
                    ? [...new Set([...ids, grading.questionId])]
                    : ids.filter((id) => id !== grading.questionId),
                )
              }
              classSize={classReport?.studentsAppeared}
              classFullCount={
                classReport?.questionSummary.find(
                  (q) => q.questionId === grading.questionId,
                )?.fullMarksCount
              }
            />
          ))}
        </section>
      </div>
    </div>
  );
}

function findAnchor(
  doc: EvaluationDoc,
  grading: QuestionGrading,
  onPage?: number,
) {
  const located = grading.rubricEvaluation
    .map((e) => e.evidenceRegion)
    .filter((r) => !!r)
    .filter((r) => onPage === undefined || r.page === onPage)
    .sort((a, b) => a.page - b.page || a.bbox.y - b.bbox.y)[0];
  if (located) return { page: located.page, y: located.bbox.y };
  if (doc.annotationGrounding) return null;
  const block = grading.answerBlockIds
    .map((id) => doc.blocks.find((b) => b.id === id))
    .find((b) => b && (onPage === undefined || b.page === onPage));
  return block
    ? { page: block.page, y: block.bbox.y + block.bbox.height / 2 }
    : null;
}
function outputUrl(path: string) {
  return path.replace(/^.*?\/output\//, "/output/");
}
function matchesVerdict(
  grading: QuestionGrading,
  filter: "all" | "needs_review" | "incorrect" | "partial" | "correct",
): boolean {
  if (filter === "all") return true;
  if (filter === "needs_review") return grading.needsTeacherReview;
  const full =
    grading.awardedMarks === grading.maxMarks && grading.maxMarks > 0;
  if (filter === "correct") return full;
  if (filter === "incorrect") return !full && grading.awardedMarks === 0;
  if (filter === "partial")
    return (
      !full &&
      grading.awardedMarks > 0 &&
      grading.awardedMarks < grading.maxMarks
    );
  return true;
}

function VerdictFilter({
  value,
  onChange,
  counts,
}: {
  value: "all" | "needs_review" | "incorrect" | "partial" | "correct";
  onChange: (
    v: "all" | "needs_review" | "incorrect" | "partial" | "correct",
  ) => void;
  counts: Record<
    "all" | "needs_review" | "incorrect" | "partial" | "correct",
    number
  >;
}) {
  const chips: {
    key: typeof value;
    label: string;
  }[] = [
    { key: "all", label: "All" },
    { key: "needs_review", label: "Needs review" },
    { key: "incorrect", label: "Incorrect" },
    { key: "partial", label: "Partial" },
    { key: "correct", label: "Correct" },
  ];
  return (
    <div className="ar-verdict-filter" role="tablist">
      {chips.map((c) => (
        <button
          key={c.key}
          role="tab"
          aria-selected={value === c.key}
          className={`ar-verdict-chip ${value === c.key ? "active" : ""}`}
          onClick={() => onChange(c.key)}
          disabled={counts[c.key] === 0 && c.key !== "all"}
        >
          {c.label}
          <span className="ar-verdict-count">{counts[c.key]}</span>
        </button>
      ))}
    </div>
  );
}

function SummaryBar({
  label,
  count,
  total,
  kind,
}: {
  label: string;
  count: number;
  total: number;
  kind: string;
}) {
  return (
    <div className="ar-summary-row">
      <span className="ar-summary-label">{label}</span>
      <span className="ar-summary-count">
        {count} of {total}
      </span>
      <div className="ar-summary-bar">
        <div
          className="ar-summary-bar-fill"
          style={{
            width: `${total ? (count / total) * 100 : 0}%`,
            background: `var(--color-${kind})`,
          }}
        />
      </div>
    </div>
  );
}

function FeedbackCard({
  grading,
  marker,
  doc,
  selected,
  hasAnchor,
  refBind,
  onSelect,
  onUpdated,
  onEditing,
  classSize,
  classFullCount,
}: {
  grading: ReviewQuestion;
  marker: number;
  doc: EvaluationDoc;
  selected: boolean;
  hasAnchor: boolean;
  refBind: (el: HTMLDivElement | null) => void;
  onSelect: () => void;
  onUpdated: (doc: EvaluationDoc) => void;
  onEditing: (editing: boolean) => void;
  classSize?: number;
  classFullCount?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const question = doc.exam?.questions.find((q) => q.id === grading.questionId);
  const full = grading.awardedMarks === grading.maxMarks;
  const passed = grading.rubricEvaluation.filter((c) => c.marksAwarded > 0);
  const failed = grading.rubricEvaluation.filter(
    (c) => c.marksAwarded < c.marksAvailable,
  );
  const released = Boolean(doc.release?.releasedAt);

  function edit() {
    setDraft(
      Object.fromEntries(
        grading.rubricEvaluation.map((c) => [
          c.criterionId,
          String(c.marksAwarded),
        ]),
      ),
    );
    setComment(grading.teacherComment || "");
    setEditing(true);
    onEditing(true);
    setError("");
  }
  async function save(approve = false) {
    setError("");
    const edits = editing
      ? grading.rubricEvaluation.map((c) => ({
          criterionId: c.criterionId,
          marksAwarded: Number(draft[c.criterionId]),
          status: (Number(draft[c.criterionId]) === c.marksAvailable
            ? "correct"
            : Number(draft[c.criterionId]) > 0
              ? "partial"
              : c.status === "missing"
                ? "missing"
                : "incorrect") as RubricEval["status"],
        }))
      : undefined;
    if (
      edits?.some(
        (c, i) =>
          !draft[c.criterionId]?.trim() ||
          !Number.isFinite(c.marksAwarded) ||
          c.marksAwarded < 0 ||
          c.marksAwarded > grading.rubricEvaluation[i].marksAvailable,
      )
    ) {
      setError("Enter marks from zero to the available marks for each step.");
      return;
    }
    setBusy(true);
    try {
      const body = await fetch(
        `/run/${encodeURIComponent(doc.runId)}/grading`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            questionId: grading.questionId,
            edits,
            approve,
            ...(editing ? { comment } : {}),
          }),
        },
      ).then(jsonResponse<{ result: EvaluationDoc }>);
      onUpdated(body.result);
      setEditing(false);
      onEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`ar-card score-${scoreKind(grading)} ${selected ? "selected" : ""}`}
      ref={refBind}
      id={`ar-card-${grading.questionId}`}
    >
      <div className="ar-card-head">
        <button
          className="ar-card-marker"
          style={{ background: scoreColor(grading) }}
          aria-label={
            hasAnchor
              ? `Show question ${grading.questionId} on the paper`
              : `No answer located for question ${grading.questionId}`
          }
          disabled={!hasAnchor}
          onClick={onSelect}
        >
          {marker}
        </button>
        <div className="ar-card-headings">
          <div className="ar-card-title">
            <strong>Question {grading.questionId.replace(/^Q\s*/i, "")}</strong>
            {question?.tags?.difficulty && (
              <span className={`chip diff-${question.tags.difficulty}`}>
                {question.tags.difficulty}
              </span>
            )}
            {grading.needsTeacherReview && (
              <span className="ar-review-flag">Review needed</span>
            )}
          </div>
          <div className="ar-card-sub">
            {[
              question?.tags?.topics.join(", "),
              question?.tags?.chapter,
              `${marks(grading.maxMarks)} marks`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        <div className="ar-card-score" style={{ color: scoreColor(grading) }}>
          {marks(grading.awardedMarks)} / {marks(grading.maxMarks)}
        </div>
      </div>
      {!hasAnchor && (
        <p className="ar-unmatched-note">
          No answer was matched to this question. Check the scanned pages before
          confirming the marks.
        </p>
      )}
      {grading.needsTeacherReview && grading.reviewReason && (
        <p className="ar-unmatched-note" role="status">
          {grading.reviewReason}
        </p>
      )}
      <ReviewCard grading={grading} question={question} />

      {editing && (
        <div className="ar-steps">
          <div className="ar-block-label">Edit step marks</div>
          <table className="ar-step-table">
            <thead>
              <tr>
                <th>Step</th>
                <th className="num">Available</th>
                <th className="num">Awarded</th>
              </tr>
            </thead>
            <tbody>
              {grading.rubricEvaluation.map((c) => (
                <tr key={c.criterionId}>
                  <td>{c.concept}</td>
                  <td className="num">{marks(c.marksAvailable)}</td>
                  <td
                    className="num"
                    style={{
                      color:
                        c.marksAwarded === c.marksAvailable
                          ? "var(--color-success)"
                          : c.marksAwarded > 0
                            ? "var(--color-warning)"
                            : "var(--color-danger)",
                    }}
                  >
                    <input
                      aria-label={`Awarded marks for ${c.concept}`}
                      type="number"
                      step="0.01"
                      min="0"
                      max={c.marksAvailable}
                      value={draft[c.criterionId] ?? ""}
                      onChange={(e) =>
                        setDraft((v) => ({
                          ...v,
                          [c.criterionId]: e.target.value,
                        }))
                      }
                      disabled={busy}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing ? (
        <label className="ar-comment-label">
          Teacher comment
          <textarea
            rows={3}
            maxLength={1500}
            value={comment}
            disabled={busy}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Add a specific correction or next step."
          />
        </label>
      ) : grading.teacherComment ? (
        <div className="ar-card-block teacher">
          <div className="ar-block-label">Teacher's note</div>
          <div className="ar-block-body">{grading.teacherComment}</div>
        </div>
      ) : null}
      {error && (
        <p className="error-msg" role="alert">
          {error}
        </p>
      )}
      <div className="ar-card-foot">
        <div className="dim">
          {classSize && classFullCount !== undefined
            ? `Class: ${classFullCount} of ${classSize} scored full marks`
            : "Class comparison appears as reports are released."}
        </div>
        <div className="ar-card-actions">
          {editing ? (
            <>
              <button
                className="ghost-btn small"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  onEditing(false);
                  setError("");
                }}
              >
                Cancel
              </button>
              <button
                className="primary-btn small"
                disabled={busy}
                onClick={() => void save(false)}
              >
                {busy ? "Saving…" : "Save changes"}
              </button>
            </>
          ) : (
            <>
              <button
                className="ghost-btn small"
                disabled={released}
                onClick={edit}
              >
                Edit
              </button>
              <button
                className={`ar-agree-btn ${!grading.needsTeacherReview ? "done" : ""}`}
                disabled={busy || !grading.needsTeacherReview || released}
                onClick={() => void save(true)}
              >
                {busy
                  ? "Saving…"
                  : grading.needsTeacherReview
                    ? "Agree"
                    : "Ready ✓"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
