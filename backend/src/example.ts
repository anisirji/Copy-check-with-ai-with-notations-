import fs from "node:fs/promises";
import path from "node:path";
import { runPipeline } from "./services/pipeline.js";
import { examConfigSchema } from "./types.js";

const ROOT = path.resolve(process.cwd(), "..");
const EXAMPLES = path.join(ROOT, "examples");
const OUTPUT = path.join(ROOT, "output");

async function main() {
  const pdfPath = path.join(EXAMPLES, "student-sheet.pdf");
  const examJsonPath = path.join(EXAMPLES, "exam.json");

  const examRaw = JSON.parse(await fs.readFile(examJsonPath, "utf-8"));
  const exam = examConfigSchema.parse(examRaw);

  const runId = "latest";
  const runDir = path.join(OUTPUT, runId);
  // Wipe old output UNLESS RESUME=1 — resume lets you re-run grading against
  // cached vision blocks (avoids burning daily OCR quota).
  if (process.env.RESUME !== "1") {
    await fs.rm(runDir, { recursive: true, force: true });
  }

  const result = await runPipeline({
    runId,
    pdfPath,
    exam,
    outputRoot: OUTPUT,
    onProgress: (stage, detail) => console.log(`• ${stage}`, detail ?? ""),
  });

  console.log("\n─── SUMMARY ─────────────────────────────────────");
  console.log(
    `Total: ${result.analytics.totalAwarded}/${result.analytics.totalMax}`,
  );
  console.log(
    `Automation rate: ${Math.round(result.analytics.automationRate * 100)}%`,
  );
  console.log(`Route counts:`, result.analytics.routeCounts);
  console.log(`Weakest concepts:`, result.analytics.weakConcepts.slice(0, 5));
  console.log(`\nOutputs in ${runDir}/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
