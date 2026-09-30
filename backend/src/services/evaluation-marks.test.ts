import assert from "node:assert/strict";
import test from "node:test";
import type { PipelineResult } from "../types.js";
import { assertEvaluationMarks } from "./evaluation-marks.js";
import { buildAnalytics } from "./analytics.js";
import { applyEvaluationRouting } from "./pipeline.js";

function evaluation(): PipelineResult {
  const grading: PipelineResult["grading"] = [
    {
      questionId: "1",
      answerBlockIds: ["b1"],
      maxMarks: 1,
      awardedMarks: 1,
      rubricEvaluation: [
        {
          criterionId: "a",
          concept: "proton",
          marksAvailable: 1,
          marksAwarded: 1,
          status: "correct",
          confidence: 1,
        },
      ],
      graderA: {
        grader: "A",
        rubricEvaluation: [],
        awardedMarks: 1,
        gradingConfidence: 1,
      },
      systemConfidence: 1,
      route: "auto_accept",
      needsTeacherReview: false,
      semantic: {
        questionId: "1",
        answerBlockIds: ["b1"],
        conceptsDetected: [],
        equations: [],
        steps: [],
        diagrams: [],
        uncertainText: [],
        rawTranscript: "proton",
      },
    },
  ];
  return {
    runId: "test",
    createdAt: "2026-09-24",
    exam: {
      title: "Atoms",
      class: "8",
      subject: "Chemistry",
      totalMarks: 1,
      questions: [
        {
          id: "1",
          prompt: "Name the particle",
          maxMarks: 1,
          rubric: [{ id: "a", concept: "proton", marks: 1 }],
        },
      ],
    },
    grading,
    analytics: buildAnalytics(grading),
    quality: [],
    pages: [],
    blocks: [],
    mapping: {},
    annotations: [],
    outputs: {
      originalPdf: "",
      evaluationJson: "",
      evaluatedPdf: "",
      annotatedPagePaths: [],
    },
  };
}

test("release invariant rejects legacy denominators, stale totals, missing questions and invalid criteria", () => {
  assert.doesNotThrow(() => assertEvaluationMarks(evaluation()));
  for (const corrupt of [
    (d: PipelineResult) => {
      d.exam.totalMarks = 20;
    },
    (d: PipelineResult) => {
      d.analytics.totalMax = 25;
    },
    (d: PipelineResult) => {
      d.analytics.totalAwarded = 0;
    },
    (d: PipelineResult) => {
      d.grading[0].awardedMarks = 0;
    },
    (d: PipelineResult) => {
      d.grading[0].rubricEvaluation[0].marksAwarded = 1.1;
    },
    (d: PipelineResult) => {
      d.grading[0].rubricEvaluation[0].marksAvailable = 2;
    },
    (d: PipelineResult) => {
      d.grading[0].rubricEvaluation.push(d.grading[0].rubricEvaluation[0]);
    },
    (d: PipelineResult) => {
      d.grading.push(d.grading[0]);
    },
    (d: PipelineResult) => {
      d.grading = [];
    },
  ]) {
    const doc = evaluation();
    corrupt(doc);
    assert.throws(() => assertEvaluationMarks(doc));
  }
});

test("an unmapped answer is reviewed even when the model confidently calls it blank and no rules were configured", () => {
  const doc = evaluation();
  const question = doc.grading[0];
  question.answerBlockIds = [];
  question.semantic.answerBlockIds = [];
  question.semantic.rawTranscript = "";
  applyEvaluationRouting(doc.grading);
  assert.equal(question.needsTeacherReview, true);
  assert.equal(question.route, "teacher_review");
  assert.match(question.reviewReason!, /No answer was matched/);
  const mapped = evaluation();
  applyEvaluationRouting(mapped.grading);
  assert.equal(mapped.grading[0].needsTeacherReview, false);
});
