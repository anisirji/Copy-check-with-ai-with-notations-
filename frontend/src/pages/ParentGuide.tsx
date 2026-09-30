import { Link, useParams } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import {
  ParentAcknowledgment,
  ReportState,
  number,
  useStudentReport,
} from "./StudentReport";

export default function ParentGuide() {
  const { runId } = useParams<{ runId: string }>();
  const state = useStudentReport(runId, undefined, undefined, true);
  if (!state.report) return <ReportState {...state} />;
  const report = state.report;
  const first = report.student.name.trim().split(/\s+/)[0];
  const biggestLoss = report.lostMarks[0];
  const improving =
    report.lastThreeTests.length > 1 &&
    report.lastThreeTests.every(
      (test, index, tests) => index === 0 || test.pct > tests[index - 1].pct,
    );
  const steady = report.sinceLastTestPct === 0;
  const focus = biggestLoss?.concept;
  const steps = [
    {
      days: "DAYS 1–4",
      title: "Explain, then try",
      detail: focus
        ? `Ask ${first} to explain an example of ${focus.toLowerCase()}. Use the textbook or a teacher-approved worked example, then try a similar question.`
        : `Ask ${first} to explain a question they solved well, then try a similar one independently.`,
    },
    {
      days: "DAYS 5–9",
      title: "Finish each answer",
      detail:
        "Choose a short set of questions that fits into fifteen minutes. Include the final step, units and an answer check where they apply.",
    },
    {
      days: "DAYS 10–12",
      title: "Mix the practice",
      detail:
        "Mix the focus topic with one stronger topic. Ask which method applies before starting the working.",
    },
    {
      days: "DAYS 13–14",
      title: "Review together",
      detail:
        "Try a few fresh questions and compare the steps with this report. Note what is easier now and what still needs the teacher's help.",
    },
  ];
  return (
    <div className="parent-guide student-report">
      <PageHeader
        breadcrumb={
          <>
            <Link to={`/review/${runId}/student`}>Parent page</Link>
            <span>/</span>
            <span>{report.student.name}</span>
            <span>/</span>
            <span>{report.exam.class}</span>
          </>
        }
        actions={
          <button className="ghost-btn" onClick={() => window.print()}>
            Print / save PDF
          </button>
        }
      />
      <header className="pg-intro">
        <div className="ta-eyebrow">
          FOR THE PARENT · WHAT THIS MEANS AND WHAT TO DO
        </div>
        <h1>
          {improving
            ? `${first} is improving steadily.`
            : steady
              ? `${first}'s result is steady.`
              : `${first}'s next step starts here.`}
          {focus
            ? ` Focus first on ${focus.toLowerCase()}.`
            : " Keep building on what is working."}
        </h1>
        <p>
          {first} scored {number(report.awardedMarks)} out of{" "}
          {number(report.exam.maxMarks)}
          {report.classSize
            ? `, against a class average of ${number(report.classAverage)}`
            : ""}
          .
          {improving
            ? ` Scores have increased across the last ${report.lastThreeTests.length} tests.`
            : report.lastThreeTests.length === 1
              ? " This is the first released test available for comparison."
              : " Read the result alongside the recent test history below."}
          {biggestLoss
            ? ` Question ${biggestLoss.questionId} accounts for ${number(biggestLoss.maxMarks - biggestLoss.studentMarks)} of the marks lost.`
            : " All available marks were earned."}
        </p>
      </header>
      <nav className="sr-view-tabs" aria-label="Report views">
        <Link to={`/review/${runId}/student`}>Individual report</Link>
        <Link aria-current="page" to={`/review/${runId}/parent`}>
          Parent guide
        </Link>
      </nav>
      <div className="sr-two-col">
        <section className="ta-card">
          <h2>Is the effort showing?</h2>
          <p className="ta-card-hint">
            Effort and marks tell different parts of the story.
          </p>
          <div className="pg-context-empty">
            <h3>Talk about the process, too</h3>
            <p>
              Homework completion, attendance and practice activity are not
              included in this report. A test score alone cannot tell us how
              much effort went into preparing.
            </p>
          </div>
          <p className="sr-topic-note">
            Ask what preparation felt useful, where time ran short, and what
            support would help with the next test.
          </p>
        </section>
        <section className="ta-card">
          <h2>This result in context</h2>
          <p className="ta-card-hint">
            Recent released tests in {report.exam.subject}, {report.exam.class}.
          </p>
          <div className="pg-test-history">
            {report.lastThreeTests.map((test, index) => (
              <div className="pg-history-row" key={`${test.label}-${index}`}>
                <span>{test.label}</span>
                <strong>
                  {number(test.pct)}%{" "}
                  <span className="dim">
                    · {number(test.awarded)} / {number(test.max)}
                  </span>
                </strong>
                <div className="sr-topic-bar">
                  <div
                    className="sr-topic-bar-fill"
                    style={{
                      width: `${Math.min(100, Math.max(0, test.pct))}%`,
                      background: "var(--color-success)",
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
          <p className="sr-topic-note">
            Other subjects are not part of this test report. Use the school's
            subject reports for a wider view.
          </p>
        </section>
      </div>
      <section className="ta-card pg-practice">
        <h2>Fifteen minutes a day, for the next two weeks</h2>
        <p className="ta-card-hint">
          A suggested routine to discuss with {first} and the teacher. Use
          practice material your teacher recommends.
        </p>
        <div className="pg-timeline">
          {steps.map((step) => (
            <article key={step.days}>
              <div className="ta-eyebrow">{step.days}</div>
              <h3>{step.title}</h3>
              <p>{step.detail}</p>
            </article>
          ))}
        </div>
      </section>
      <div className="sr-two-col">
        <section className="ta-card">
          <h2>Three questions worth asking</h2>
          <ol className="pg-questions">
            <li>
              <strong>
                “Can you show me how you approached this question?”
              </strong>
              <p>
                {focus
                  ? `Start with ${focus.toLowerCase()}. Let ${first} explain the steps before offering help.`
                  : "Choose a question from the paper and ask them to explain their reasoning."}
              </p>
            </li>
            <li>
              <strong>“Which answer would you try again?”</strong>
              <p>
                Compare the working with the feedback and choose one specific
                step to improve.
              </p>
            </li>
            <li>
              <strong>“What will you do differently next time?”</strong>
              <p>
                Agree on one small habit, such as finishing the last line or
                checking an answer.
              </p>
            </li>
          </ol>
        </section>
        <section className="ta-card">
          <h2>Keep the conversation useful</h2>
          <div className="pg-advice">
            <h3>Use their own progress as context</h3>
            <p>
              Class averages provide context. The useful discussion is what{" "}
              {first} understands now and what to work on next.
            </p>
            <h3>Start with the specific gap</h3>
            <p>
              {focus
                ? `Focus on ${focus.toLowerCase()} first, then ask the teacher if wider support is needed.`
                : "Ask the teacher which skills are ready for a new challenge."}
            </p>
            <h3>Make practice manageable</h3>
            <p>
              Choose a short routine that fits your family and adjust it with
              the teacher's advice.
            </p>
          </div>
        </section>
      </div>
      <section className="ta-card pg-school">
        <div>
          <h2>School follow-up</h2>
          {report.teacherRemark ? (
            <blockquote>{report.teacherRemark}</blockquote>
          ) : (
            <p>The teacher has not added a follow-up note yet.</p>
          )}
          <p className="dim">
            Re-teaching dates, assignments and a re-test have not been recorded
            here. Contact the school through your usual channel to confirm
            plans.
          </p>
        </div>
        <div>
          <ParentAcknowledgment report={report} />
          <Link className="ghost-btn" to={`/review/${runId}/student`}>
            Back to individual report
          </Link>
        </div>
      </section>
    </div>
  );
}
