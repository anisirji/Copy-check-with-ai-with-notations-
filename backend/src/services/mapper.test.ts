import assert from "node:assert/strict";
import test from "node:test";
import type { Block, ExamConfig, Question } from "../types.js";
import { mapBlocksToQuestions } from "./mapper.js";
import { toSemanticAnswers } from "./semantic.js";

function question(id: string, sourceQuestionIds?: string[]): Question {
  return { id, prompt: id, maxMarks: 1, rubric: [], sourceQuestionIds };
}

function exam(...questions: (string | Question)[]): ExamConfig {
  return {
    title: "Mapper regression",
    subject: "chemistry",
    class: "9",
    totalMarks: questions.length,
    questions: questions.map((q) => (typeof q === "string" ? question(q) : q)),
  };
}

function blocks(...entries: (string | [Block["type"], string])[]): Block[] {
  return entries.map((entry, i) => ({
    id: `b${i}`,
    page: 1,
    type: typeof entry === "string" ? "question_number" : entry[0],
    text: typeof entry === "string" ? entry : entry[1],
    bbox: { x: 0.1, y: i / entries.length, width: 0.5, height: 0.02 },
  }));
}

function text(content: string): [Block["type"], string] {
  return ["text", content];
}

test("Q1 heading and Ans a-e labels distribute five blanks without alias collisions", () => {
  const input = blocks(
    "Q1",
    "Ans a",
    text("Proton"),
    "Ans b",
    text("Atomic number"),
    "Ans c",
    text("Neutron"),
    "Ans d",
    text("Nucleus"),
    "Ans e",
    text("Anion"),
  );
  assert.deepEqual(
    mapBlocksToQuestions(input, exam("1(a)", "1(b)", "1(c)", "1(d)", "1(e)")),
    {
      "1(a)": ["b2"],
      "1(b)": ["b4"],
      "1(c)": ["b6"],
      "1(d)": ["b8"],
      "1(e)": ["b10"],
    },
  );
});

// Q. is normalized to Q first; the canonical parser then removes the prefix.
test("prefixed scheme IDs and full OCR IDs share canonical labels", () => {
  const input = blocks(
    "Question 1",
    "Ans a",
    text("first"),
    "Q1(b).",
    text("second"),
    "Q. 2:",
    text("third"),
  );
  assert.deepEqual(mapBlocksToQuestions(input, exam("Q1(a)", "Q1(b)", "Q2")), {
    "Q1(a)": ["b2"],
    "Q1(b)": ["b4"],
    Q2: ["b6"],
  });
});

test("(i) and (v) route as alphabetic subparts when those are the known leaves", () => {
  const input = blocks(
    "Q1",
    "h)",
    text("h"),
    "i)",
    text("i"),
    "j)",
    text("j"),
    "v)",
    text("v"),
  );
  assert.deepEqual(
    mapBlocksToQuestions(input, exam("1(h)", "1(i)", "1(j)", "1(v)")),
    {
      "1(h)": ["b2"],
      "1(i)": ["b4"],
      "1(j)": ["b6"],
      "1(v)": ["b8"],
    },
  );
});

test("roman sections route all six nested letter parts and switch section context", () => {
  const labels = ["a", "b", "c", "d", "e", "f"];
  const input = blocks(
    "Q5",
    "i)",
    ...labels.flatMap((letter) => [`Ans ${letter}`, text(`i-${letter}`)]),
    "ii)",
    ...labels.flatMap((letter) => [`(${letter})`, text(`ii-${letter}`)]),
  );
  const cfg = exam(
    ...["i", "ii"].flatMap((section) =>
      labels.map((letter) => `5(${section})(${letter})`),
    ),
  );
  const actual = mapBlocksToQuestions(input, cfg);
  for (const [sectionIndex, section] of ["i", "ii"].entries()) {
    for (const [i, letter] of labels.entries()) {
      assert.deepEqual(actual[`5(${section})(${letter})`], [
        `b${3 + sectionIndex * 13 + i * 2}`,
      ]);
    }
  }
});

test("full nested IDs establish context for following short labels", () => {
  const input = blocks(
    "Q5(i)(a)",
    text("first"),
    "b)",
    text("second"),
    "5ii",
    "(a)",
    text("third"),
  );
  assert.deepEqual(
    mapBlocksToQuestions(input, exam("5(i)(a)", "5(i)(b)", "5(ii)(a)")),
    {
      "5(i)(a)": ["b1"],
      "5(i)(b)": ["b3"],
      "5(ii)(a)": ["b4", "b6"],
    },
  );
});

test("a new shared heading clears the preceding question and roman context", () => {
  const input = blocks(
    "Q4",
    text("isotopes"),
    "Q5",
    text("unlabelled aluminium answer"),
    "i)",
    "a)",
    text("aluminium"),
    "Q1",
    "a)",
    text("proton"),
  );
  assert.deepEqual(
    mapBlocksToQuestions(
      input,
      exam("4", "5(i)(a)", "5(i)(b)", "1(a)", "1(b)"),
    ),
    {
      "4": ["b1"],
      "5(i)(a)": ["b6"],
      "5(i)(b)": [],
      "1(a)": ["b9"],
      "1(b)": [],
    },
  );
});

test("unknown top-level questions and unknown siblings do not leak into preceding answers", () => {
  const input = blocks(
    "Q1",
    "a)",
    text("known"),
    "z)",
    text("unknown part"),
    "Q99",
    text("unknown question"),
    "Q2",
    text("known second"),
  );
  assert.deepEqual(mapBlocksToQuestions(input, exam("1(a)", "1(b)", "2")), {
    "1(a)": ["b2"],
    "1(b)": [],
    "2": ["b8"],
  });
});

test("roman answer steps remain with an intact question and retain their labels", () => {
  const input = blocks(
    "Q2",
    "Ans",
    "i)",
    text("first feature"),
    "ii)",
    text("second feature"),
  );
  assert.deepEqual(mapBlocksToQuestions(input, exam("2")), {
    "2": ["b1", "b2", "b3", "b4", "b5"],
  });
});

test("merged questions keep full and relative source labels in their semantic transcript", () => {
  const cfg = exam(question("1", ["1(a)", "1(b)"]), "2");
  const input = blocks(
    "Q1",
    "Ans a",
    text("Proton"),
    "Q1(b)",
    text("Atomic number"),
    "Q2",
    text("next"),
  );
  const mapping = mapBlocksToQuestions(input, cfg);
  assert.deepEqual(mapping, {
    "1": ["b0", "b1", "b2", "b3", "b4"],
    "2": ["b6"],
  });
  const semantic = toSemanticAnswers(cfg, input, mapping)[0];
  assert.match(
    semantic.rawTranscript,
    /Ans a\n.*Proton\n.*Q1\(b\)\n.*Atomic number/,
  );
});

test("nested merges preserve roman section switches and their child aliases", () => {
  const cfg = exam(
    question("5(i)", ["5(i)(a)", "5(i)(b)"]),
    question("5(ii)", ["5(ii)(a)", "5(ii)(b)"]),
  );
  const input = blocks(
    "Q5",
    "i)",
    "a)",
    text("aluminium"),
    "b)",
    text("13"),
    "ii)",
    "a)",
    text("chlorine"),
    "5(ii)(b)",
    text("17"),
  );
  assert.deepEqual(mapBlocksToQuestions(input, cfg), {
    "5(i)": ["b1", "b2", "b3", "b4", "b5"],
    "5(ii)": ["b6", "b7", "b8", "b9", "b10"],
  });
});

test("merging the whole question recovers unlabelled content across pages", () => {
  const cfg = exam(
    "4",
    question("5", ["5(i)(a)", "5(i)(b)", "5(ii)(a)", "5(ii)(b)"]),
  );
  const input = blocks("Q4", text("isotopes"), "Q5", text("aluminium"), [
    "diagram",
    "chlorine diagram",
  ]);
  input[4].page = 2;
  input[4].bbox.y = 0;
  assert.deepEqual(mapBlocksToQuestions(input, cfg), {
    "4": ["b1"],
    "5": ["b2", "b3", "b4"],
  });
});

test("dot and hyphen source aliases are interchangeable with bracket notation", () => {
  const cfg = exam(question("Q5(i)", ["5.i.a", "5-i-b"]));
  const input = blocks("5(i)(a)", text("first"), "5.i.b", text("second"));
  assert.deepEqual(mapBlocksToQuestions(input, cfg), {
    "Q5(i)": ["b0", "b1", "b2", "b3"],
  });
});

test("sorts by page and vertical position without changing the supplied blocks", () => {
  const ordered = blocks(
    "Q1",
    text("first"),
    text("continuation"),
    "Q2",
    text("second"),
  );
  ordered[2].page = ordered[3].page = ordered[4].page = 2;
  const shuffled = [ordered[4], ordered[2], ordered[0], ordered[3], ordered[1]];
  const originalOrder = shuffled.map((b) => b.id);
  assert.deepEqual(mapBlocksToQuestions(shuffled, exam("1", "2")), {
    "1": ["b1", "b2"],
    "2": ["b4"],
  });
  assert.deepEqual(
    shuffled.map((b) => b.id),
    originalOrder,
  );
});

test("ambiguous aliases fail closed instead of assigning the last question", () => {
  const cfg = exam(question("1", ["2(a)"]), question("2", ["2(a)"]));
  assert.deepEqual(
    mapBlocksToQuestions(blocks("Q2(a)", text("ambiguous")), cfg),
    { "1": [], "2": [] },
  );
});

test("an unsupported numeric short marker never creates a synthetic zero-root question", () => {
  const input = blocks(
    "(9)",
    text("unassigned"),
    "Q1(a)",
    text("known answer"),
  );
  assert.deepEqual(mapBlocksToQuestions(input, exam("1(a)", "1(b)")), {
    "1(a)": ["b3"],
    "1(b)": [],
  });
});
