import assert from "node:assert/strict";
import test from "node:test";
import { buildAnnotations } from "./annotator.js";
import type { Block, QuestionGrading, RubricEval } from "../types.js";

const answer: Block = {
  id: "answer",
  page: 1,
  type: "text",
  text: "Student's answer",
  bbox: { x: 0.15, y: 0.3, width: 0.35, height: 0.04 },
};

function evaluation(criterionId = "c1"): RubricEval {
  return {
    criterionId,
    concept: "A missing detail",
    marksAvailable: 1,
    marksAwarded: 0,
    status: "incorrect",
    evidenceBlockId: answer.id,
    confidence: 0.95,
  };
}

function grading(rubricEvaluation = [evaluation()]): QuestionGrading[] {
  return [
    {
      questionId: "4",
      answerBlockIds: [answer.id],
      maxMarks: rubricEvaluation.length,
      awardedMarks: 0,
      rubricEvaluation,
      graderA: {
        grader: "A",
        rubricEvaluation,
        awardedMarks: 0,
        gradingConfidence: 0.95,
      },
      systemConfidence: 0.95,
      route: "auto_accept",
      needsTeacherReview: false,
      semantic: {
        questionId: "4",
        answerBlockIds: [answer.id],
        conceptsDetected: [],
        equations: [],
        steps: [],
        diagrams: [],
        uncertainText: [],
        rawTranscript: answer.text,
      },
    },
  ];
}

function comments(blocks: Block[], evaluations?: RubricEval[]) {
  return buildAnnotations(grading(evaluations), blocks).filter(
    (a) => a.type === "comment_box",
  );
}

test("unlocated OCR boxes never receive precise-looking ink marks", () => {
  const annotations = buildAnnotations(grading(), [answer]);
  assert.equal(
    annotations.some((a) => a.type === "ink" || a.type === "underline"),
    false,
  );
  assert.match(
    annotations.find((a) => a.type === "comment_box")!.text,
    /location needs review/,
  );
});

test("multiple criteria on one region share one mark, including conflicting statuses", () => {
  const region = {
    page: 1,
    bbox: answer.bbox,
    source: "local_ocr" as const,
    mark: { x: 0.53, y: 0.32 },
  };
  const first = {
    ...evaluation(),
    status: "correct" as const,
    marksAwarded: 1,
    evidenceRegion: region,
  };
  const second = { ...first, criterionId: "c2" };
  let annotations = buildAnnotations(grading([first, second]), [answer]);
  assert.equal(annotations.filter((a) => a.type === "ink").length, 1);
  assert.equal(annotations.find((a) => a.type === "ink")!.kind, "correct");
  second.status = "incorrect" as typeof second.status;
  annotations = buildAnnotations(grading([first, second]), [answer]);
  assert.equal(annotations.filter((a) => a.type === "ink").length, 1);
  assert.equal(annotations.find((a) => a.type === "ink")!.kind, "partial");
});

test("comments use the external margin with specific corrections, without connectors over writing", () => {
  const ev = {
    ...evaluation(),
    feedback: "Same proton number, different neutron numbers.",
    evidenceRegion: {
      page: 1,
      bbox: answer.bbox,
      source: "local_ocr" as const,
    },
  };
  const [comment] = comments([answer], [ev]);
  assert.ok(comment.x > 1);
  assert.equal(comment.anchorX, undefined);
  assert.equal(comment.text, ev.feedback);
  assert.equal(comment.heading, "Q4");
});

test("separate correct and incorrect statements within an old paragraph get separate grounded marks", () => {
  const wrong = {
    ...evaluation(),
    evidenceRegion: {
      page: 1,
      bbox: { x: 0.1, y: 0.3, width: 0.6, height: 0.025 },
      source: "local_ocr" as const,
    },
  };
  const right = {
    ...evaluation("c2"),
    status: "correct" as const,
    marksAwarded: 1,
    evidenceRegion: {
      page: 1,
      bbox: { x: 0.4, y: 0.4, width: 0.25, height: 0.025 },
      source: "local_ocr" as const,
    },
  };
  const ink = buildAnnotations(grading([wrong, right]), [answer]).filter(
    (a) => a.type === "ink",
  );
  assert.deepEqual(
    ink.map((a) => a.kind),
    ["incorrect", "correct"],
  );
  assert.notEqual(ink[0].y, ink[1].y);
});

test("page totals preserve fractional marks and explicitly identify draft results", () => {
  const result = grading([
    {
      ...evaluation(),
      marksAvailable: 0.67,
      marksAwarded: 0.67,
      status: "correct",
    },
  ]);
  result[0].maxMarks = result[0].awardedMarks = 0.67;
  result[0].needsTeacherReview = true;
  const annotations = buildAnnotations(result, [answer]);
  const total = annotations.find((a) => a.type === "page_total")!;
  assert.equal(total.text, "0.67/0.67");
  assert.equal(total.subline, "Draft total");
  assert.match(annotations.find((a) => a.type === "badge")!.heading, /DRAFT/);
});

test("continuation pages show their earned fraction without counting the entire question twice", () => {
  const es = [1, 2].map((page) => ({
    ...evaluation(String(page)),
    status: "correct" as const,
    marksAvailable: 3.5,
    marksAwarded: 3.5,
    evidenceRegion: { page, bbox: answer.bbox, source: "local_ocr" as const },
  }));
  const g = grading(es);
  g[0].maxMarks = g[0].awardedMarks = 7;
  const annotations = buildAnnotations(g, [answer]);
  assert.deepEqual(
    annotations
      .filter((a) => a.type === "circled_score")
      .map((a) => [a.page, a.text]),
    [
      [1, "3.5/3.5"],
      [2, "3.5/3.5"],
    ],
  );
  assert.equal(annotations.find((a) => a.type === "page_total")!.text, "7/7");
});

test("unmatched teacher feedback stays in review instead of an arbitrary page", () => {
  const result = grading();
  result[0].answerBlockIds = [];
  result[0].teacherComment = "Please explain.";
  assert.ok(
    !buildAnnotations(result, []).some((a) => a.type === "comment_box"),
  );
});
