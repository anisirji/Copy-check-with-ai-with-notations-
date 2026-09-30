import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runPipeline } from "./pipeline.js";
import { ProviderRegistry } from "../providers/index.js";
import type { ExamConfig } from "../types.js";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { copySourcePages } from "./preprocess.js";

const exam: ExamConfig = {
  title: "Cache guard",
  subject: "Chemistry",
  class: "8",
  totalMarks: 1,
  questions: [
    {
      id: "1",
      prompt: "Name the particle",
      maxMarks: 1,
      rubric: [{ id: "c1", concept: "proton", marks: 1 }],
    },
  ],
};

function offlineRegistry() {
  return new ProviderRegistry([
    {
      name: "anthropic",
      family: "anthropic",
      capabilities: ["text", "vision"],
      isConfigured: () => true,
      generate: async () => {
        throw new Error("Unexpected provider call");
      },
    },
  ]);
}

test("cached pipeline grades exact source PNGs without OCR or PDF rerasterization", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "copy-check-source-test-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "source.png");
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="900"><defs><pattern id="p" width="32" height="32" patternUnits="userSpaceOnUse"><rect width="16" height="16" fill="black"/><rect x="16" y="16" width="16" height="16" fill="black"/></pattern></defs><rect width="640" height="900" fill="white"/><rect width="640" height="900" fill="url(#p)"/></svg>';
  await sharp(Buffer.from(svg)).png().toFile(sourcePath);
  const before = await fs.readFile(sourcePath);
  const pdf = await PDFDocument.create();
  const image = await pdf.embedPng(before);
  pdf
    .addPage([640, 900])
    .drawImage(image, { x: 0, y: 0, width: 640, height: 900 });
  const pdfPath = path.join(root, "source.pdf");
  await fs.writeFile(pdfPath, await pdf.save());
  await fs.mkdir(path.join(root, "cached"));
  await fs.writeFile(
    path.join(root, "cached", "blocks.json"),
    JSON.stringify([
      {
        id: "b1",
        page: 1,
        type: "question_number",
        text: "1",
        bbox: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
      },
      {
        id: "b2",
        page: 1,
        type: "text",
        text: "Proton",
        bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      },
    ]),
  );
  let calls = 0;
  let confidence = 1;
  const registry = new ProviderRegistry([
    {
      name: "anthropic",
      family: "anthropic",
      capabilities: ["text", "vision"],
      isConfigured: () => true,
      generate: async (request) => {
        calls++;
        assert.match(request.prompt, /You are a fair examiner/);
        assert.equal(request.images?.length, 1);
        assert.equal(request.images?.[0].base64, before.toString("base64"));
        return {
          text: JSON.stringify({
            rubricEvaluation: [
              {
                criterionId: "c1",
                marksAwarded: 1,
                status: "correct",
                evidenceBlockId: "b2",
                confidence,
              },
            ],
            gradingConfidence: confidence,
          }),
          provider: "anthropic",
          model: "offline-test",
        };
      },
    },
  ]);
  const stages: string[] = [];
  const annotationGrounder = async () => ({
    version: 1 as const,
    updatedAt: "2026-09-24",
    placed: 0,
    unlocated: [],
  });
  const result = await runPipeline({
    runId: "cached",
    pdfPath,
    outputRoot: root,
    exam,
    registry,
    annotationGrounder,
    requireCachedBlocks: true,
    sourcePages: [{ page: 1, imagePath: sourcePath, width: 640, height: 900 }],
    onProgress: (stage) => stages.push(stage),
  });
  assert.equal(calls, 1);
  assert.equal(result.pages[0].width, 640);
  assert.equal(result.pages[0].height, 900);
  assert.equal(result.analytics.totalAwarded, 1);
  assert.ok(stages.includes("vision:cached"));
  assert.deepEqual(await fs.readFile(result.pages[0].imagePath), before);
  assert.deepEqual(await fs.readFile(sourcePath), before);
  await assert.rejects(
    copySourcePages(
      [{ ...result.pages[0], width: 1 }],
      path.join(root, "invalid"),
    ),
    /dimensions do not match/,
  );
  confidence = 0.8;
  await fs.mkdir(path.join(root, "second-check-fails"));
  await fs.copyFile(
    path.join(root, "cached", "blocks.json"),
    path.join(root, "second-check-fails", "blocks.json"),
  );
  const pending = await runPipeline({
    runId: "second-check-fails",
    pdfPath,
    outputRoot: root,
    exam,
    registry,
    annotationGrounder,
    requireCachedBlocks: true,
    sourcePages: [{ page: 1, imagePath: sourcePath, width: 640, height: 900 }],
  });
  assert.equal(
    pending.analytics.totalAwarded,
    1,
    "an unavailable second provider must not erase the first score",
  );
  assert.equal(pending.grading[0].graderA.provider, "anthropic");
  assert.equal(pending.grading[0].rubricEvaluation[0].evidenceBlockId, "b2");
  assert.equal(pending.grading[0].needsTeacherReview, true);
  assert.match(
    pending.grading[0].reviewReason!,
    /independent check could not finish/,
  );
});

test("inconsistent marks fail before providers or file processing", async () => {
  await assert.rejects(
    runPipeline({
      runId: "invalid",
      pdfPath: "/does-not-exist.pdf",
      outputRoot: "/does-not-exist",
      exam: { ...exam, totalMarks: 20 },
      registry: new ProviderRegistry([]),
    }),
    /Question marks total 1, but the exam total is 20/,
  );
});

for (const cache of [undefined, "not json", "[]", '[{"id":"bad"}]']) {
  test(`required cache ${cache ?? "missing"} fails before PDF conversion or OCR`, async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "copy-check-cache-test-"),
    );
    try {
      await fs.mkdir(path.join(root, "cached"));
      if (cache !== undefined)
        await fs.writeFile(path.join(root, "cached", "blocks.json"), cache);
      const stages: string[] = [];
      await assert.rejects(
        runPipeline({
          runId: "cached",
          pdfPath: "/does-not-exist.pdf",
          outputRoot: root,
          exam,
          registry: offlineRegistry(),
          requireCachedBlocks: true,
          onProgress: (stage) => stages.push(stage),
        }),
        /Cached blocks are missing or invalid; regrade stopped before OCR/,
      );
      assert.ok(!stages.includes("preprocess:start"));
      assert.ok(!stages.includes("vision:start"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
