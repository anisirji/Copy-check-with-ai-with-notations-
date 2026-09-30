import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findOwnershipConflicts,
  reconcileAnswerBlocks,
} from "./reconcile-answer-blocks.js";
import { mapBlocksToQuestions } from "./mapper.js";
import { normalizeAnswerMarkers } from "./answer-marker-normalizer.js";
import { buildCanonicalAnswer } from "./canonical-answer.js";
import type { Block, ExamConfig } from "../types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const CHEM_RUN = path.join(
  REPO_ROOT,
  "copy-check-poc/output/d1c4ec6d-e40c-4610-864d-7dc5c815584f--aarav-gupta-clear-scan--1790188301349",
);
const CHEM_EXAM = path.join(
  REPO_ROOT,
  "copy-check-poc/store/exams/d1c4ec6d-e40c-4610-864d-7dc5c815584f.json",
);

describe("reconcileAnswerBlocks", () => {
  it("merges near-duplicate primary/secondary text blocks", () => {
    const blocks: Block[] = [
      {
        id: "p1_b7",
        page: 1,
        type: "text",
        text: "Neutron",
        bbox: { x: 0.2, y: 0.3, width: 0.1, height: 0.02 },
      },
      {
        id: "s1_b7",
        page: 1,
        type: "text",
        text: "Neutron",
        bbox: { x: 0.2, y: 0.4, width: 0.1, height: 0.02 },
      },
    ];
    const out = reconcileAnswerBlocks(blocks);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "p1_b7", "primary must win");
  });

  it("keeps distinct answers on different pages", () => {
    const blocks: Block[] = [
      {
        id: "p1_b1",
        page: 1,
        type: "text",
        text: "Terrestrial",
        bbox: { x: 0.2, y: 0.3, width: 0.1, height: 0.02 },
      },
      {
        id: "p2_b1",
        page: 2,
        type: "text",
        text: "Terrestrial",
        bbox: { x: 0.2, y: 0.3, width: 0.1, height: 0.02 },
      },
    ];
    const out = reconcileAnswerBlocks(blocks);
    assert.equal(out.length, 2);
  });

  it("records an audit event per merge or drop", () => {
    const blocks: Block[] = [
      {
        id: "p1_b5",
        page: 1,
        type: "text",
        text: "Atomic number",
        bbox: { x: 0.2, y: 0.2, width: 0.1, height: 0.02 },
      },
      {
        id: "s1_b5",
        page: 1,
        type: "text",
        text: "Atom Atomic number",
        bbox: { x: 0.2, y: 0.35, width: 0.1, height: 0.02 },
      },
    ];
    const events: unknown[] = [];
    const out = reconcileAnswerBlocks(blocks, (e) => events.push(e));
    assert.equal(out.length, 1);
    assert.ok(events.length >= 1);
  });
});

describe("findOwnershipConflicts", () => {
  it("returns nothing when every block is uniquely owned", () => {
    assert.deepEqual(
      findOwnershipConflicts({ "1(a)": ["p1_b1"], "1(b)": ["p1_b2"] }),
      [],
    );
  });
  it("flags a block that appears in more than one question", () => {
    const c = findOwnershipConflicts({
      "1(a)": ["p1_b1", "shared"],
      "1(b)": ["shared", "p1_b2"],
    });
    assert.equal(c.length, 1);
    assert.equal(c[0].blockId, "shared");
    assert.deepEqual(c[0].questionIds.sort(), ["1(a)", "1(b)"]);
  });
});

describe("buildCanonicalAnswer", () => {
  it("drops question_number, synthetic, and crossed_out blocks from plainText", () => {
    const canonical = buildCanonicalAnswer([
      {
        id: "p1_b1",
        page: 1,
        type: "question_number",
        text: "Q1",
        bbox: { x: 0, y: 0, width: 0.1, height: 0.02 },
      },
      {
        id: "syn_1",
        page: 1,
        type: "question_number",
        text: "1(a)",
        bbox: { x: 0, y: 0.05, width: 0.1, height: 0.02 },
        synthetic: true,
      },
      {
        id: "p1_b2",
        page: 1,
        type: "text",
        text: "Proton",
        bbox: { x: 0.1, y: 0.05, width: 0.1, height: 0.02 },
      },
      {
        id: "p1_b3",
        page: 1,
        type: "crossed_out",
        text: "Rat",
        bbox: { x: 0.1, y: 0.1, width: 0.1, height: 0.02 },
      },
    ]);
    assert.equal(canonical.plainText, "Proton");
    assert.deepEqual(canonical.crossedOut, ["Rat"]);
  });

  it("deduplicates repeated near-identical text lines", () => {
    const canonical = buildCanonicalAnswer([
      {
        id: "p1_b1",
        page: 1,
        type: "text",
        text: "Atomic number = 4",
        bbox: { x: 0.1, y: 0.05, width: 0.1, height: 0.02 },
      },
      {
        id: "p1_b2",
        page: 1,
        type: "text",
        text: "Atomic number = 4",
        bbox: { x: 0.1, y: 0.1, width: 0.1, height: 0.02 },
      },
    ]);
    assert.equal(canonical.plainText, "Atomic number = 4");
  });
});

describe("chemistry regression — cached blocks.json", () => {
  const skip =
    !fs.existsSync(path.join(CHEM_RUN, "blocks.json")) ||
    !fs.existsSync(CHEM_EXAM);

  it(
    "Q2 must not contain Q1's 'anion' or 'Not Nucleus' after reconciliation",
    { skip },
    () => {
      const raw = JSON.parse(
        fs.readFileSync(path.join(CHEM_RUN, "blocks.json"), "utf-8"),
      ) as Block[];
      const exam = JSON.parse(
        fs.readFileSync(CHEM_EXAM, "utf-8"),
      ) as ExamConfig;

      const reconciled = reconcileAnswerBlocks(raw);
      const mapping = mapBlocksToQuestions(
        normalizeAnswerMarkers(reconciled),
        exam,
      );
      const byId = new Map(reconciled.map((b) => [b.id, b]));
      const q2Blocks = (mapping["2"] ?? [])
        .map((id) => byId.get(id))
        .filter((b): b is Block => !!b);
      const q2Text = buildCanonicalAnswer(q2Blocks).plainText.toLowerCase();
      assert.ok(
        !q2Text.includes("anion"),
        `Q2 should not contain "anion": ${q2Text}`,
      );
      assert.ok(
        !q2Text.includes("not nucleus"),
        `Q2 should not contain "Not Nucleus": ${q2Text}`,
      );
    },
  );

  it(
    "Q1 canonical answer contains each expected term exactly once",
    { skip },
    () => {
      const raw = JSON.parse(
        fs.readFileSync(path.join(CHEM_RUN, "blocks.json"), "utf-8"),
      ) as Block[];
      const exam = JSON.parse(
        fs.readFileSync(CHEM_EXAM, "utf-8"),
      ) as ExamConfig;

      const reconciled = reconcileAnswerBlocks(raw);
      const mapping = mapBlocksToQuestions(
        normalizeAnswerMarkers(reconciled),
        exam,
      );
      const byId = new Map(reconciled.map((b) => [b.id, b]));
      const q1Blocks = (mapping["1"] ?? [])
        .map((id) => byId.get(id))
        .filter((b): b is Block => !!b);
      const q1Text = buildCanonicalAnswer(q1Blocks).plainText.toLowerCase();
      // Each of the five Q1 answers should appear exactly once.
      const countOccurrences = (needle: string): number => {
        let count = 0;
        let idx = q1Text.indexOf(needle);
        while (idx !== -1) {
          count += 1;
          idx = q1Text.indexOf(needle, idx + needle.length);
        }
        return count;
      };
      for (const term of [
        "proton",
        "atomic number",
        "neutron",
        "nucleus",
        "anion",
      ]) {
        assert.equal(
          countOccurrences(term),
          1,
          `"${term}" should appear once in Q1, got ${countOccurrences(term)}`,
        );
      }
    },
  );
});
