import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { ProviderRegistry } from "../providers/index.js";
import { buildExamFromPaper } from "./exam-builder.js";
import { assertExamMarks } from "./exam-marks.js";
import { buildGraderPrompt } from "./grader.js";

test("paper generation preserves printed allocations and supplies the class and completed model answer to the rubric", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "copy-builder-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]);
  const file = path.join(root, "paper.pdf");
  await fs.writeFile(file, await pdf.save());
  let modelReady = false;
  const registry = new ProviderRegistry([
    {
      name: "anthropic",
      family: "anthropic",
      capabilities: ["text", "vision"],
      isConfigured: () => true,
      async generate(request) {
        let data: unknown;
        if (request.prompt.includes("extracting questions")) {
          data = [
            {
              id: "5",
              prompt: "Write electronic configuration of chlorine",
              maxMarks: 7,
              subject: "chemistry",
            },
          ];
        } else if (request.prompt.includes("ideal short model answer")) {
          assert.match(request.prompt, /8 A/);
          modelReady = true;
          data = { modelAnswer: "2, 8, 7" };
        } else {
          assert.equal(
            modelReady,
            true,
            "rubric must wait for the completed model answer",
          );
          assert.match(request.prompt, /Class: 8 A/);
          assert.match(request.prompt, /Model answer:\n2, 8, 7/);
          assert.match(request.prompt, /shell notation/);
          data = {
            criteria: [
              {
                id: "5a",
                concept: "Correct configuration",
                marks: 7,
                acceptable: ["2, 8, 7"],
              },
            ],
          };
        }
        return {
          provider: "anthropic",
          model: "offline-test",
          text: JSON.stringify(data),
        };
      },
    },
  ]);
  const draft = await buildExamFromPaper(
    file,
    { title: "Atoms", subject: "Chemistry", class: "8 A", totalMarks: 20 },
    registry,
    path.join(root, "pages"),
  );
  assert.equal(draft.totalMarks, 20);
  assert.equal(
    draft.questions[0].maxMarks,
    7,
    "do not silently scale a printed allocation to hide extraction errors",
  );
  assert.equal(draft.marksNormalization, undefined);
  assert.throws(
    () => assertExamMarks(draft),
    /Question marks total 7, but the exam total is 20/,
  );
  for (const role of ["A", "B"] as const) {
    const prompt = buildGraderPrompt(
      role,
      draft.questions[0],
      {
        questionId: "5",
        answerBlockIds: ["b1"],
        rawTranscript: "2, 8, 7",
        conceptsDetected: [],
        equations: [],
        steps: [],
        diagrams: [],
        uncertainText: [],
      },
      undefined,
      { class: "8 A", subject: "Chemistry" },
    );
    assert.match(prompt, /Class: 8 A/);
    assert.match(prompt, /Do not deduct for using shell notation/);
  }
});
