import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractLeadingAnswerMarker,
  normalizeAnswerMarkers,
} from "./answer-marker-normalizer.js";
import { mapBlocksToQuestions } from "./mapper.js";
import { toSemanticAnswers } from "./semantic.js";
import type { Block, ExamConfig } from "../types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const BIO_RUN = path.join(
  REPO_ROOT,
  "copy-check-poc/output/a98fd1a9-1564-4eaf-86b7-789899c9c34f--biology-demo--1790193447943",
);
const BIO_EXAM = path.join(
  REPO_ROOT,
  "copy-check-poc/store/exams/a98fd1a9-1564-4eaf-86b7-789899c9c34f.json",
);

describe("extractLeadingAnswerMarker", () => {
  const cases: [string, { marker: string; remainder: string } | null][] = [
    [
      "Ans a> Plant → Small bird",
      { marker: "a", remainder: "Plant → Small bird" },
    ],
    ["Ans a) Terrestrial", { marker: "a", remainder: "Terrestrial" }],
    ["Ans (b) Trophic level", { marker: "b", remainder: "Trophic level" }],
    ["Ans. c Nucleus", { marker: "c", remainder: "Nucleus" }],
    ["Ans: d Rat", { marker: "d", remainder: "Rat" }],
    ["Answer a Some content", { marker: "a", remainder: "Some content" }],
    ["Ans i) Ecosystems", { marker: "i", remainder: "Ecosystems" }],
    ["Ans (ii) More detail", { marker: "ii", remainder: "More detail" }],
    ["(a) An ecosystem is …", { marker: "a", remainder: "An ecosystem is …" }],
    ["a) An ecosystem is …", { marker: "a", remainder: "An ecosystem is …" }],
    // Negative: prose starts with a lone word — no delimiter, no Ans prefix.
    ["A common problem in ecosystems", null],
    ["I saw a rabbit", null],
    // Negative: bare marker with no remainder is not enough on its own.
    ["a)", null],
  ];
  for (const [input, want] of cases) {
    it(`parses ${JSON.stringify(input)}`, () => {
      assert.deepEqual(extractLeadingAnswerMarker(input), want);
    });
  }
});

describe("normalizeAnswerMarkers", () => {
  it("splits an Ans-prefixed text block into synthetic marker + trimmed text", () => {
    const blocks: Block[] = [
      {
        id: "p1_b0",
        page: 1,
        type: "question_number",
        text: "1)",
        bbox: { x: 0.05, y: 0.1, width: 0.03, height: 0.02 },
      },
      {
        id: "p1_b1",
        page: 1,
        type: "text",
        text: "Ans a> Plant → Small bird → Caterpillar",
        bbox: { x: 0.1, y: 0.12, width: 0.7, height: 0.04 },
      },
      {
        id: "p1_b2",
        page: 1,
        type: "text",
        text: "Ans b> Trophic level",
        bbox: { x: 0.1, y: 0.18, width: 0.7, height: 0.04 },
      },
    ];
    const out = normalizeAnswerMarkers(blocks);
    // 1 parent + 2 × (synthetic + trimmed) = 5 blocks
    assert.equal(out.length, 5);
    assert.equal(out[1].type, "question_number");
    assert.equal(out[1].text, "1(a)");
    assert.equal(out[1].synthetic, true);
    assert.equal(out[2].text, "Plant → Small bird → Caterpillar");
    assert.equal(out[3].type, "question_number");
    assert.equal(out[3].text, "1(b)");
    assert.equal(out[4].text, "Trophic level");
  });

  it("does not create a marker when no parent has been seen", () => {
    const blocks: Block[] = [
      {
        id: "p1_b0",
        page: 1,
        type: "text",
        text: "a) A note before any question header",
        bbox: { x: 0.1, y: 0.05, width: 0.5, height: 0.03 },
      },
    ];
    const out = normalizeAnswerMarkers(blocks);
    assert.equal(out.length, 1);
    assert.equal(out[0].type, "text");
  });
});

describe("biology regression — cached blocks.json", () => {
  const skip =
    !fs.existsSync(path.join(BIO_RUN, "blocks.json")) ||
    !fs.existsSync(BIO_EXAM);

  it("mapping populates 1(a)…4(b) after normalization", { skip }, () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(BIO_RUN, "blocks.json"), "utf-8"),
    ) as Block[];
    const exam = JSON.parse(fs.readFileSync(BIO_EXAM, "utf-8")) as ExamConfig;

    const before = mapBlocksToQuestions(raw, exam);
    const after = mapBlocksToQuestions(normalizeAnswerMarkers(raw), exam);

    for (const id of [
      "1(a)",
      "1(b)",
      "2(a)",
      "2(b)",
      "3(a)",
      "3(b)",
      "4(a)",
      "4(b)",
    ]) {
      assert.equal(
        before[id]?.length ?? 0,
        0,
        `expected ${id} empty before normalization`,
      );
      assert.ok(
        (after[id]?.length ?? 0) > 0,
        `expected ${id} to be populated after normalization`,
      );
    }

    // Spot-check that semantic transcripts pick up the real student text.
    const semantics = toSemanticAnswers(
      exam,
      normalizeAnswerMarkers(raw),
      after,
    );
    const oneA = semantics.find((s) => s.questionId === "1(a)");
    assert.ok(
      /plant/i.test(oneA?.rawTranscript ?? ""),
      `1(a) transcript should contain 'plant', got: ${oneA?.rawTranscript}`,
    );
    const oneB = semantics.find((s) => s.questionId === "1(b)");
    assert.ok(
      /trophic/i.test(oneB?.rawTranscript ?? ""),
      `1(b) transcript should contain 'trophic', got: ${oneB?.rawTranscript}`,
    );
  });
});
