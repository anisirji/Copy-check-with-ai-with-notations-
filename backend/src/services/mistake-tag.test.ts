import assert from "node:assert/strict";
import test from "node:test";
import { inferMistakeTag } from "./mistake-tag.js";
import type { RubricEval } from "../types.js";
const partial: RubricEval = {
  criterionId: "a",
  concept: "Explain",
  status: "partial",
  marksAvailable: 2,
  marksAwarded: 1,
  confidence: 1,
};
test("a date or question number alone does not label a partial answer careless", () => {
  for (const evidence of [
    "The uprising began in 1857",
    "Question 12: the source was incomplete",
    "The symbol was +",
  ]) {
    assert.equal(
      inferMistakeTag({ ...partial, evidence }, undefined),
      "incomplete",
    );
  }
  assert.equal(
    inferMistakeTag({ ...partial, evidence: "27 - 13 = 12" }, undefined),
    "careless",
  );
  assert.equal(
    inferMistakeTag(
      { ...partial, status: "correct", evidence: "2 + 2 = 4" },
      undefined,
    ),
    undefined,
  );
});
