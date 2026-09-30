import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEvidencePlacements,
  chooseInkPosition,
  largestInkComponent,
  type TextRegion,
} from "./annotation-grounding.js";
import { annotationLayout, buildAnnotationSvg } from "./annotation-svg.js";
import { mergeBlocks } from "./vision.js";
import type { Annotation, Block, QuestionGrading } from "../types.js";

const bbox = { x: 0.2, y: 0.3, width: 0.3, height: 0.03 };
const region: TextRegion = {
  id: "p1-line1",
  page: 1,
  kind: "text",
  text: "Atomic number",
  bbox,
  words: [
    { text: "Atomic", bbox: { ...bbox, width: 0.1 } },
    { text: "number", bbox: { ...bbox, x: 0.32, width: 0.18 } },
  ],
};
function grading() {
  return [
    {
      questionId: "1",
      rubricEvaluation: [
        {
          criterionId: "c1",
          concept: "atomic number",
          marksAwarded: 1,
          marksAvailable: 1,
          status: "correct",
          confidence: 1,
        },
      ],
    },
  ] as QuestionGrading[];
}
test("model selects real word geometry and cannot supply invented coordinates", () => {
  const g = grading();
  applyEvidencePlacements(
    g,
    [region],
    [
      {
        questionId: "1",
        criterionId: "c1",
        regionId: region.id,
        firstWord: 1,
        lastWord: 1,
      },
    ],
  );
  for (const key of ["x", "y", "width", "height"] as const)
    assert.ok(
      Math.abs(
        g[0].rubricEvaluation[0].evidenceRegion!.bbox[key] -
          region.words[1].bbox[key],
      ) < 1e-10,
    );
  assert.equal(g[0].rubricEvaluation[0].marksAwarded, 1);
});
test("invalid IDs, ambiguous placements, foreign criteria and invalid word ranges stay unlocated", () => {
  const valid = {
    questionId: "1",
    criterionId: "c1",
    regionId: region.id,
    firstWord: 0,
    lastWord: 1,
  };
  for (const placements of [
    [{ ...valid, regionId: "invented" }],
    [{ ...valid, firstWord: -1 }],
    [{ ...valid, lastWord: 8 }],
    [{ ...valid, firstWord: 1, lastWord: 0 }],
    [valid, valid],
  ]) {
    const g = grading();
    applyEvidencePlacements(g, [region], placements);
    assert.equal(g[0].rubricEvaluation[0].evidenceRegion, undefined);
  }
  const g = grading();
  applyEvidencePlacements(g, [region], [valid], new Set(["2:c1"]));
  assert.equal(g[0].rubricEvaluation[0].evidenceRegion, undefined);
});
test("a diagram criterion cannot be grounded to its heading text", () => {
  const g = grading();
  g[0].rubricEvaluation[0].concept = "Bohr diagram";
  applyEvidencePlacements(
    g,
    [region],
    [
      {
        questionId: "1",
        criterionId: "c1",
        regionId: region.id,
        firstWord: 0,
        lastWord: 1,
      },
    ],
  );
  assert.equal(g[0].rubricEvaluation[0].evidenceRegion, undefined);
});
test("mark placement avoids adjacent words, with a safe external-margin fallback for full lines", () => {
  const adjacent = { ...bbox, x: 0.51, width: 0.35 };
  const point = chooseInkPosition(bbox, [bbox, adjacent]);
  assert.ok(point.x < bbox.x || point.y > bbox.y + bbox.height || point.x > 1);
  const full = { x: 0, y: 0, width: 1, height: 1 };
  assert.ok(chooseInkPosition(bbox, [full]).x > 1);
});
test("diagram extent ignores disconnected bleed-through specks", () => {
  const mask = new Uint8Array(100 * 100);
  for (let y = 20; y <= 60; y++)
    for (let x = 20; x <= 60; x++)
      if (x === 20 || x === 60 || y === 20 || y === 60) mask[y * 100 + x] = 1;
  mask[90 * 100 + 95] = 1;
  assert.deepEqual(largestInkComponent(mask, 100, 100), {
    x: 20,
    y: 20,
    width: 41,
    height: 41,
  });
});
test("crowded margin comments never overlap or cover the original image, even at the bottom", () => {
  const annotations: Annotation[] = Array.from({ length: 20 }, (_, i) => ({
    type: "comment_box",
    page: 1,
    x: 0.6,
    y: 0.9,
    heading: `Question ${i}`,
    text: "A long correction requiring several readable lines, with its complete text preserved.",
    kind: "wrong",
  }));
  const layout = annotationLayout(1000, 1400, annotations);
  assert.ok(layout.height > 1400);
  for (let i = 0; i < layout.comments.length; i++) {
    const c = layout.comments[i];
    assert.ok(c.x > layout.left + 1000);
    assert.ok(c.y + c.height < layout.height);
    if (i)
      assert.ok(c.y > layout.comments[i - 1].y + layout.comments[i - 1].height);
  }
  const svg = buildAnnotationSvg(1000, 1400, annotations);
  assert.ok(svg.includes(`viewBox="0 0 ${layout.width} ${layout.height}"`));
});
test("shared SVG uses paths for ink and escapes all student/teacher text", () => {
  const svg = buildAnnotationSvg(1000, 1400, [
    { type: "ink", page: 1, x: 0.3, y: 0.4, kind: "incorrect" },
    {
      type: "comment_box",
      page: 1,
      x: 1.04,
      y: 0.4,
      heading: "<script>",
      text: '<img src=x onerror="alert(1)">',
      kind: "wrong",
    },
  ]);
  assert.ok(svg.includes("<path"));
  assert.ok(svg.includes("&lt;script&gt;"));
  assert.ok(!svg.includes("<img") && !svg.includes("<script>"));
});
test("vision consensus cannot transplant unrelated longer text into another line's box", () => {
  const primary: Block = {
    id: "p1_b1",
    page: 1,
    type: "equation",
    text: "4 + 5 = 9",
    bbox,
  };
  const wrong: Block = {
    ...primary,
    id: "s1_b1",
    text: "A few of them bounced back",
  };
  const [merged] = mergeBlocks([primary], [wrong]);
  assert.equal(merged.text, primary.text);
  assert.deepEqual(merged.bbox, primary.bbox);
  assert.deepEqual(merged.ocrAlternatives, [wrong.text]);
  assert.equal(
    mergeBlocks(
      [primary],
      [{ ...primary, id: "s1_b2", bbox: { ...bbox, y: 0.8 } }],
    ).length,
    1,
  );
});
