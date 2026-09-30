import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRegistry } from "../providers/index.js";
import type { LLMProvider } from "../providers/types.js";
import type { Question, SemanticAnswer } from "../types.js";
import { buildAnalytics } from "./analytics.js";
import { reconcile } from "./consensus.js";
import { runGrader } from "./grader.js";

const question: Question = {
  id: "1",
  prompt: "Name the two particles",
  maxMarks: 1.33,
  rubric: [
    { id: "c1", concept: "Proton", marks: 0.67 },
    { id: "c2", concept: "Neutron", marks: 0.66 },
  ],
};
const semantic: SemanticAnswer = {
  questionId: "1",
  answerBlockIds: [],
  conceptsDetected: ["proton", "neutron"],
  equations: [],
  steps: [],
  diagrams: [],
  uncertainText: [],
  rawTranscript: "Proton, neutron",
};

/** A real registry with one deterministic provider; no network is reachable. */
function registry(marks: unknown[]): ProviderRegistry {
  const provider: LLMProvider = {
    name: "anthropic",
    family: "anthropic",
    capabilities: ["text", "vision"],
    isConfigured: () => true,
    async generate() {
      return {
        provider: "anthropic",
        model: "local-test-provider",
        text: JSON.stringify({
          rubricEvaluation: marks.map((marksAwarded, i) => ({
            criterionId: `c${i + 1}`,
            marksAwarded,
            confidence: 0.99,
          })),
          gradingConfidence: 0.99,
        }),
      };
    },
  };
  return new ProviderRegistry([provider]);
}

test("full normalized marks survive grader, single/dual consensus and analytics exactly", async () => {
  const a = await runGrader(
    "A",
    question,
    semantic,
    [],
    [],
    registry([0.67, 0.66]),
  );
  const b = await runGrader(
    "B",
    question,
    semantic,
    [],
    [],
    registry([0.67, 0.66]),
  );
  assert.equal(a.awardedMarks, 1.33);
  assert.equal(b.awardedMarks, 1.33);
  assert.deepEqual(
    a.rubricEvaluation.map((e) => [e.marksAwarded, e.status]),
    [
      [0.67, "correct"],
      [0.66, "correct"],
    ],
  );
  const single = reconcile(question, semantic, a);
  const dual = reconcile(question, semantic, a, b);
  assert.equal(single.awardedMarks, 1.33);
  assert.equal(dual.awardedMarks, 1.33);
  assert.equal(dual.route, "auto_accept");
  const analytics = buildAnalytics([dual]);
  assert.equal(analytics.totalAwarded, 1.33);
  assert.equal(analytics.totalMax, 1.33);
});

test("grader clamps negative/excessive marks and preserves zero and decimal partial marks", async () => {
  const clamped = await runGrader(
    "A",
    question,
    semantic,
    [],
    [],
    registry([-0.4, 5]),
  );
  assert.deepEqual(
    clamped.rubricEvaluation.map((e) => [e.marksAwarded, e.status]),
    [
      [0, "missing"],
      [0.66, "correct"],
    ],
  );
  assert.equal(clamped.awardedMarks, 0.66);
  const partial = await runGrader(
    "A",
    question,
    semantic,
    [],
    [],
    registry([0, 0.335]),
  );
  assert.deepEqual(
    partial.rubricEvaluation.map((e) => [e.marksAwarded, e.status]),
    [
      [0, "missing"],
      [0.34, "partial"],
    ],
  );
  assert.equal(reconcile(question, semantic, partial).awardedMarks, 0.34);
  const invalid = await runGrader(
    "A",
    question,
    semantic,
    [],
    [],
    registry(["unreadable"]),
  );
  assert.equal(invalid.awardedMarks, 0);
  assert.deepEqual(
    invalid.rubricEvaluation.map((e) => e.marksAwarded),
    [0, 0],
  );
});

test("consensus averages fractional partial marks to hundredths", async () => {
  const a = await runGrader(
    "A",
    question,
    semantic,
    [],
    [],
    registry([0.33, 0]),
  );
  const b = await runGrader(
    "B",
    question,
    semantic,
    [],
    [],
    registry([0.34, 0]),
  );
  const result = reconcile(question, semantic, a, b);
  assert.equal(result.awardedMarks, 0.34);
  assert.deepEqual(
    result.rubricEvaluation.map((e) => e.marksAwarded),
    [0.34, 0],
  );
});

test("analytics totals fractional questions without binary floating point noise or tenth rounding", async () => {
  const makeQuestion = (id: string, marks: number): Question => ({
    id,
    prompt: id,
    maxMarks: marks,
    rubric: [{ id: "c1", concept: id, marks }],
  });
  const q1 = makeQuestion("1", 0.1);
  const q2 = makeQuestion("2", 0.23);
  const a1 = await runGrader("A", q1, semantic, [], [], registry([0.1]));
  const a2 = await runGrader("A", q2, semantic, [], [], registry([0.23]));
  const analytics = buildAnalytics([
    reconcile(q1, semantic, a1),
    reconcile(q2, semantic, a2),
  ]);
  assert.equal(analytics.totalAwarded, 0.33);
  assert.equal(analytics.totalMax, 0.33);
});
