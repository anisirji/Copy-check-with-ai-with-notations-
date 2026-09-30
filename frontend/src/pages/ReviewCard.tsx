import { useState } from "react";
import type {
  QuestionGrading,
  QuestionReview,
  ReviewDiffRow,
  ReviewVerdict,
  RubricEval,
  StudentAnswerPayload,
} from "../types";
import { InlineMath, BlockMath } from "react-katex";
import "katex/dist/katex.min.css";

type ExamQuestion =
  | {
      id: string;
      prompt?: string;
      modelAnswer?: string;
      rubric?: { id: string; concept: string; acceptable?: string[] }[];
    }
  | undefined;

interface Props {
  grading: QuestionGrading;
  question: ExamQuestion;
}

/**
 * Teacher-facing review card. Renders in a fixed order:
 *
 *   Header (marks + verdict)
 *   Question
 *   Student answer  ⇆  Expected answer   (KaTeX auto-rendered)
 *   AI review (bullets + optional per-criterion diff table)
 *   Developer details (expander with raw pipeline data)
 *
 * Correct answers stay compact by default; anything not-correct starts
 * expanded so the teacher lands on what actually needs attention.
 */
export default function ReviewCard({ grading, question }: Props) {
  const review = grading.review ?? deriveReviewFallback(grading, question);
  const [expanded, setExpanded] = useState(review.verdict !== "correct");
  const verdict = review.verdict;

  const failedDiff = review.diff.filter(
    (row) => row.awardedMarks < row.maxMarks,
  );
  const passedCount = review.diff.length - failedDiff.length;

  return (
    <div className={`rc-card verdict-${verdict}`}>
      <button
        type="button"
        className="rc-header"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="rc-header-left">
          <span className={`rc-verdict-icon status-${verdict}`} aria-hidden>
            {verdictIcon(verdict)}
          </span>
          <div className="rc-header-heading">
            <div className="rc-header-title">
              <strong>Q{grading.questionId.replace(/^Q\s*/i, "")}</strong>
              <span className="rc-verdict-label">{verdictLabel(verdict)}</span>
              {review.needsTeacher && (
                <span
                  className="rc-needs-teacher"
                  title={
                    review.needsTeacherReason ?? "Flagged for teacher review"
                  }
                >
                  Needs teacher
                </span>
              )}
            </div>
            {question?.prompt && (
              <div className="rc-header-prompt">
                <MathText
                  text={truncate(question.prompt, expanded ? 400 : 140)}
                />
              </div>
            )}
          </div>
        </div>
        <div className="rc-header-right">
          <div className="rc-mark">
            {fmt(review.awardedMarks)} / {fmt(review.maxMarks)}
          </div>
          <div className="rc-confidence" title="Model confidence">
            {Math.round(review.confidence * 100)}%
          </div>
          <span className="rc-caret" aria-hidden>
            {expanded ? "▾" : "▸"}
          </span>
        </div>
      </button>

      {!expanded && verdict === "correct" && (
        <div className="rc-compact">
          {passedCount} of {review.diff.length} marking criteria satisfied.
        </div>
      )}

      {expanded && (
        <div className="rc-body">
          <div className="rc-split">
            <div className="rc-col student">
              <div className="rc-col-label">Student answer</div>
              <StudentAnswerView payload={review.studentAnswer} />
            </div>
            <div className="rc-col expected">
              <div className="rc-col-label">Expected answer</div>
              {review.expectedAnswer ? (
                <MathBlock text={review.expectedAnswer} />
              ) : (
                <div className="rc-empty">
                  No expected answer stored for this question.
                </div>
              )}
            </div>
          </div>

          <div className={`rc-review verdict-${verdict}`}>
            <div className="rc-col-label">AI review</div>
            <VerdictLine verdict={verdict} />
            {failedDiff.length > 0 ? (
              <ul className="rc-diff-list">
                {failedDiff.map((row) => (
                  <DiffRow key={row.criterionId} row={row} />
                ))}
              </ul>
            ) : (
              <div className="rc-review-note">
                No important difference detected.
              </div>
            )}
            {review.studentAnswer.crossedOut.length > 0 && (
              <div className="rc-review-note dim">
                A crossed-out response was ignored:{" "}
                {review.studentAnswer.crossedOut.join("; ")}
              </div>
            )}
          </div>

          <StepMarks grading={grading} />
        </div>
      )}
    </div>
  );
}

// ─── small pieces ────────────────────────────────────────────────────────

function DiffRow({ row }: { row: ReviewDiffRow }) {
  return (
    <li className={`rc-diff-row status-${row.status}`}>
      <div className="rc-diff-head">
        <span className={`rc-diff-icon status-${row.status}`} aria-hidden>
          {statusIcon(row.status)}
        </span>
        <span className="rc-diff-concept">{row.concept}</span>
        <span className="rc-diff-marks">
          {fmt(row.awardedMarks)} / {fmt(row.maxMarks)}
        </span>
      </div>
      <div className="rc-diff-grid">
        <div>
          <div className="rc-diff-label">Student</div>
          <div className="rc-diff-value">
            {row.studentSaid ? <MathText text={row.studentSaid} /> : "—"}
          </div>
        </div>
        <div>
          <div className="rc-diff-label">Expected</div>
          <div className="rc-diff-value">
            <MathText text={row.expected} />
          </div>
        </div>
      </div>
    </li>
  );
}

function StudentAnswerView({ payload }: { payload: StudentAnswerPayload }) {
  const hasContent =
    payload.displayText || payload.equations.length || payload.diagrams.length;
  if (!hasContent) {
    return <div className="rc-empty">— No answer detected —</div>;
  }
  return (
    <div className="rc-student-body">
      {payload.displayText && <MathBlock text={payload.displayText} />}
      {payload.equations.length > 0 && (
        <div className="rc-side">
          {payload.equations.map((eq, i) => (
            <div key={i} className="rc-eq">
              <MathText text={eq} forceMath />
            </div>
          ))}
        </div>
      )}
      {payload.diagrams.length > 0 && (
        <div className="rc-side dim">
          <div className="rc-side-label">Diagram</div>
          {payload.diagrams.map((d, i) => (
            <div key={i}>{d}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function StepMarks({ grading }: { grading: QuestionGrading }) {
  return (
    <details className="rc-steps">
      <summary>Step marking ({grading.rubricEvaluation.length})</summary>
      <table className="rc-step-table">
        <tbody>
          {grading.rubricEvaluation.map((c) => (
            <tr key={c.criterionId} className={`status-${c.status}`}>
              <td>{c.concept}</td>
              <td className="num">
                {fmt(c.marksAwarded)} / {fmt(c.marksAvailable)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function VerdictLine({ verdict }: { verdict: ReviewVerdict }) {
  return (
    <div className={`rc-verdict-line status-${verdict}`}>
      {
        (
          {
            correct: "✓ Answer meets every marking criterion.",
            partially_correct: "△ Some criteria matched, some did not.",
            incorrect: "✗ Answer does not match the expected concept.",
            missing: "○ No valid student answer was detected.",
            needs_review: "! Flagged for teacher review before release.",
          } as const
        )[verdict]
      }
    </div>
  );
}

// ─── math renderer ───────────────────────────────────────────────────────

const MATH_HINT = /\\[a-zA-Z]+|[_^]\{|\^\d|_\d|\\frac|\\sqrt|\\mathrm/;

/**
 * Render a text string with inline `$...$`, `\\(...\\)`, and heuristic
 * math detection (superscripts, LaTeX commands). Anything not recognized
 * falls back to a plain text run.
 */
function MathText({ text, forceMath }: { text: string; forceMath?: boolean }) {
  if (!text) return null;
  if (forceMath) return <SafeMath expr={text} inline />;
  const parts = splitMath(text);
  return (
    <>
      {parts.map((part, i) =>
        part.kind === "math" ? (
          <SafeMath key={i} expr={part.value} inline />
        ) : (
          <span key={i}>{part.value}</span>
        ),
      )}
    </>
  );
}

function MathBlock({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  return (
    <div className="rc-math-block">
      {lines.map((line, i) => {
        if (!line.trim()) return <br key={i} />;
        const stripped = line.replace(/^\$\$|\$\$$/g, "").trim();
        if (
          /^\$\$.*\$\$$/.test(line.trim()) ||
          (MATH_HINT.test(stripped) && stripped.length < 120)
        ) {
          return <SafeMath key={i} expr={stripped} />;
        }
        return (
          <div key={i} className="rc-math-line">
            <MathText text={line} />
          </div>
        );
      })}
    </div>
  );
}

function SafeMath({ expr, inline }: { expr: string; inline?: boolean }) {
  const normalized = normalizeExpr(expr);
  try {
    return inline ? (
      <InlineMath math={normalized} />
    ) : (
      <BlockMath math={normalized} />
    );
  } catch {
    return <code>{expr}</code>;
  }
}

function normalizeExpr(expr: string): string {
  // Common tweaks — students / OCR write "H^1_1", "^9_4Be", "35 - 17 = 18".
  let s = expr.trim();
  // ^9_4Be  →  {}^{9}_{4}\mathrm{Be}
  s = s.replace(
    /(?<![A-Za-z0-9])\^\{?(\d+)\}?\s*_\{?(\d+)\}?\s*([A-Za-z]{1,3})/g,
    "{}^{$1}_{$2}\\mathrm{$3}",
  );
  // "X^1_1" (Element first)  →  \mathrm{X}^{1}_{1}
  s = s.replace(
    /([A-Za-z]{1,3})\^\{?(\d+)\}?\s*_\{?(\d+)\}?/g,
    "\\mathrm{$1}^{$2}_{$3}",
  );
  return s;
}

function splitMath(text: string): { kind: "text" | "math"; value: string }[] {
  const out: { kind: "text" | "math"; value: string }[] = [];
  const re = /\$\$([^$]+)\$\$|\$([^$]+)\$|\\\(([^)]+)\\\)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) {
      out.push({ kind: "text", value: text.slice(last, m.index) });
    }
    out.push({ kind: "math", value: m[1] ?? m[2] ?? m[3] ?? "" });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", value: text.slice(last) });
  return out;
}

// ─── verdict + status helpers ────────────────────────────────────────────

function verdictIcon(v: ReviewVerdict): string {
  return {
    correct: "✓",
    partially_correct: "△",
    incorrect: "✗",
    missing: "○",
    needs_review: "!",
  }[v];
}
function verdictLabel(v: ReviewVerdict): string {
  return {
    correct: "Correct",
    partially_correct: "Partial",
    incorrect: "Incorrect",
    missing: "Missing",
    needs_review: "Needs teacher",
  }[v];
}
function statusIcon(s: RubricEval["status"]): string {
  return s === "correct"
    ? "✓"
    : s === "partial"
      ? "~"
      : s === "missing"
        ? "○"
        : "✗";
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ─── fallback derivation for old runs missing backend `review` ──────────

function deriveReviewFallback(
  grading: QuestionGrading,
  question: ExamQuestion,
): QuestionReview {
  const rawTranscript = grading.semantic?.rawTranscript ?? "";
  const displayText = rawTranscript
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[[^\]]+\]\s*\([^)]+\)\s*/, "").trimEnd())
    .filter((l) => l.length > 0)
    .join("\n")
    .trim();
  const verdict: ReviewVerdict =
    grading.awardedMarks === grading.maxMarks && grading.maxMarks > 0
      ? "correct"
      : grading.awardedMarks > 0
        ? "partially_correct"
        : displayText
          ? "incorrect"
          : "missing";
  const byId = new Map((question?.rubric ?? []).map((r) => [r.id, r]));
  const diff: ReviewDiffRow[] = grading.rubricEvaluation.map((c) => {
    const src = byId.get(c.criterionId);
    return {
      criterionId: c.criterionId,
      concept: c.concept,
      status: c.status,
      studentSaid: c.evidence ?? "",
      expected: src?.acceptable?.[0] ?? src?.concept ?? c.concept ?? "",
      awardedMarks: c.marksAwarded,
      maxMarks: c.marksAvailable,
    };
  });
  return {
    studentAnswer: {
      displayText,
      rawTranscript,
      equations: (grading.semantic?.equations ?? [])
        .map((e) => e.text?.trim() ?? "")
        .filter((t) => t.length > 0),
      diagrams: (grading.semantic?.diagrams ?? [])
        .map((d) => d.description?.trim() ?? "")
        .filter((t) => t.length > 0),
      crossedOut: rawTranscript
        .split(/\r?\n/)
        .filter((line) => /\(crossed_out\)/i.test(line))
        .map((line) => line.replace(/^\s*\[[^\]]+\]\s*\([^)]+\)\s*/, "").trim())
        .filter((t) => t.length > 0),
    },
    expectedAnswer: question?.modelAnswer ?? "",
    diff,
    differences: [],
    verdict,
    needsTeacher:
      grading.needsTeacherReview === true &&
      !(grading.awardedMarks === grading.maxMarks && grading.maxMarks > 0),
    needsTeacherReason: grading.reviewReason,
    explanation: "",
    awardedMarks: grading.awardedMarks,
    maxMarks: grading.maxMarks,
    confidence: grading.systemConfidence,
  };
}
