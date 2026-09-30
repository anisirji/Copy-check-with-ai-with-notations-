import fs from "node:fs/promises";
import { roundMarks } from "./exam-marks.js";
import type {
  Block,
  EvaluationRules,
  GraderResult,
  PageMeta,
  Question,
  RubricEval,
  SemanticAnswer,
  ValidatorReport,
} from "../types.js";
import { ProviderRegistry } from "../providers/index.js";
import type { LLMRequest } from "../providers/types.js";
import { extractJson } from "./util-json.js";

/**
 * Stage 6/8 — Rubric-based grader.
 *
 * Grader A and grader B run through the provider cascade, and grader B is
 * enforced to come from a DIFFERENT family than grader A (arch doc: "Don't
 * tell Model B what Model A said. Otherwise you'll introduce anchoring.").
 *
 * Both graders see the raw page image(s) as evidence so they can correct OCR
 * errors from the vision stage.
 */

export function buildGraderPrompt(
  role: "A" | "B",
  question: Question,
  semantic: SemanticAnswer,
  rules?: EvaluationRules,
  context?: { subject?: string; class?: string },
): string {
  const flavor =
    role === "A"
      ? "You are a fair examiner. Award marks whenever the concept is clearly demonstrated."
      : "You are a strict examiner. Only award marks when the criterion is explicitly and correctly satisfied.";

  return `${flavor}
Class: ${context?.class ?? "K-12"}. Subject: ${context?.subject ?? question.subject ?? "general"}.

Grade the student's MEANING against the question and the marking criteria. Do NOT require wording to match the model answer.

Follow these rules of semantic equivalence:
  • Accept synonyms, equivalent terminology, and shorter answers that still convey the required concept. Example: "Terrestrial" is a full-credit answer to "Name the type of ecosystem found on land." Do NOT demand a definition unless the question explicitly asks the student to define.
  • If the question asks for a term or label and the student writes a valid term, that is correct even if the model answer is a definition.
  • If the question asks for "any two"/"any three" items and the student supplies more correct items than asked, that is NOT a reason to reduce marks. Give full credit as long as the requested count of valid items is present.
  • Accept scientifically equivalent wording and notation appropriate to this class. Do not deduct for shell notation (e.g. 2, 8, 3) instead of orbital notation unless the question explicitly requests orbitals.
  • Accept common school abbreviations, singular/plural swaps ("Proton" vs "Protons"), casing, and minor spelling that does not change meaning.
  • The model answer and acceptable examples are illustrative, not exhaustive.
  • Only insist on format, steps, a specific number of points, or specific units when the question or the rubric explicitly requires them.
  • Read the supplied page image to resolve OCR conflicts. Restrict credit to the requested question and its subparts; nearby answers are context, not interchangeable evidence.

Question ${question.id} (max ${question.maxMarks} marks):
${question.prompt}

${question.modelAnswer ? `Model answer:\n${question.modelAnswer}\n` : ""}
Rubric — evaluate each criterion INDEPENDENTLY (do NOT anchor to a total first):
${question.rubric
  .map(
    (c) =>
      `- ${c.id}: "${c.concept}" (worth ${c.marks} marks)${
        c.acceptable?.length
          ? ` acceptable phrasings: ${c.acceptable.join(", ")}`
          : ""
      }`,
  )
  .join("\n")}

Student's semantic answer:
  Raw transcript:
${semantic.rawTranscript || "(no answer detected)"}

  Concepts detected: ${semantic.conceptsDetected.join(", ") || "(none)"}
  Equations: ${semantic.equations.map((e) => e.text).join(" | ") || "(none)"}
  Diagrams: ${semantic.diagrams.map((d) => d.description).join(" | ") || "(none)"}
  Uncertain OCR pieces: ${semantic.uncertainText.join(" | ") || "(none)"}

Available block ids for evidence: ${semantic.answerBlockIds.join(", ") || "(none)"}

${
  rules
    ? `Teacher-approved evaluation rules (apply these consistently):
- Partial credit: ${rules.partialCredit ? "award proportional credit for demonstrated parts of each criterion" : "each criterion is all-or-nothing: award zero or its exact maximum"}.
- Carry-forward errors: ${rules.carryForward ? "credit a correct method after an earlier arithmetic mistake; do not repeatedly penalize the same originating error" : "evaluate each criterion against its required correct result, including errors carried from earlier work"}.
- Missing or incorrect units or required signs: ${rules.unitPenalty === "ignore" ? "do not deduct marks solely for a missing unit or sign" : `deduct at most ${rules.unitPenalty === "half" ? "0.5" : "1"} mark in total per question solely for units or signs; apply this deduction once to the relevant criterion, capped at that criterion's earned marks`}; never penalize unrelated criteria or deduct twice for an error already accounted for in the rubric.
- Uncertain handwriting: explain uncertainty in evidence and lower confidence; never invent missing writing.
`
    : ""
}

For each rubric criterion return:
  status: "correct" | "partial" | "missing" | "incorrect"
  marksAwarded: 0 to criterion.marks, with up to two decimal places. Award the exact criterion maximum for full credit, including normalized maxima such as 0.67. Partial marks must never exceed that maximum.
  evidenceBlockId: block id that supports the decision (omit if none)
  evidence: short quote from the student's answer (≤ 80 chars)
  feedback: for lost marks, a short actionable correction (≤ 100 chars). State the correct idea or next step, not a rubric heading such as "Definition of isotopes". Omit for full credit.
  confidence: 0..1

Return ONLY this JSON (no prose, no fences):
{
  "rubricEvaluation": [
    { "criterionId": "...", "status": "...", "marksAwarded": ..., "evidenceBlockId": "...", "evidence": "...", "confidence": ... }
  ],
  "gradingConfidence": 0.0-1.0
}`;
}

async function loadPageImages(
  pageIds: number[],
  pages: PageMeta[],
): Promise<LLMRequest["images"]> {
  const pageImageByPage = new Map(pages.map((p) => [p.page, p.imagePath]));
  const images: NonNullable<LLMRequest["images"]> = [];
  for (const p of pageIds) {
    const imgPath = pageImageByPage.get(p);
    if (!imgPath) continue;
    const bytes = await fs.readFile(imgPath);
    images.push({ mimeType: "image/png", base64: bytes.toString("base64") });
  }
  return images;
}

export async function runGrader(
  role: "A" | "B",
  question: Question,
  semantic: SemanticAnswer,
  blocks: Block[],
  pages: PageMeta[],
  registry: ProviderRegistry,
  opts: {
    avoidFamily?: ReturnType<ProviderRegistry["familyOf"]>;
    rules?: EvaluationRules;
    context?: { subject?: string; class?: string };
  } = {},
): Promise<GraderResult> {
  const blocksById = new Map(blocks.map((b) => [b.id, b]));
  const pagesForQuestion = Array.from(
    new Set(
      semantic.answerBlockIds
        .map((id) => blocksById.get(id)?.page)
        .filter((p): p is number => typeof p === "number"),
    ),
  );
  const images = await loadPageImages(pagesForQuestion, pages);

  const resp = await registry.call(
    role === "A" ? "grader-a" : "grader-b",
    {
      prompt: buildGraderPrompt(
        role,
        question,
        semantic,
        opts.rules,
        opts.context,
      ),
      images,
      temperature: role === "A" ? 0.2 : 0.15,
    },
    { avoidFamily: opts.avoidFamily },
  );

  const parsed = extractJson<{
    rubricEvaluation: Partial<RubricEval>[];
    gradingConfidence?: number;
  }>(resp.text);

  const evals: RubricEval[] = question.rubric.map((c) => {
    const found = parsed?.rubricEvaluation?.find((e) => e.criterionId === c.id);
    const proposed = clampMarks(found?.marksAwarded ?? 0, c.marks);
    const marks =
      opts.rules?.partialCredit === false && proposed < c.marks ? 0 : proposed;
    return {
      criterionId: c.id,
      concept: c.concept,
      marksAvailable: c.marks,
      marksAwarded: marks,
      status:
        marks === c.marks
          ? "correct"
          : marks > 0
            ? "partial"
            : !found?.status || found.status === "missing"
              ? "missing"
              : semantic.rawTranscript.trim()
                ? "incorrect"
                : "missing",
      evidenceBlockId: found?.evidenceBlockId,
      evidence: found?.evidence,
      feedback:
        typeof found?.feedback === "string"
          ? found.feedback.slice(0, 160)
          : undefined,
      confidence: clamp01(found?.confidence ?? 0.5),
    };
  });

  return {
    grader: role,
    provider: resp.provider,
    model: resp.model,
    rubricEvaluation: evals,
    awardedMarks: roundMarks(evals.reduce((s, e) => s + e.marksAwarded, 0)),
    gradingConfidence: clamp01(parsed?.gradingConfidence ?? 0.7),
  };
}

export async function runValidator(
  question: Question,
  semantic: SemanticAnswer,
  graderA: GraderResult,
  graderB: GraderResult,
  registry: ProviderRegistry,
): Promise<ValidatorReport> {
  const prompt = `You are a validator, not a grader. Two independent graders have scored the same handwritten answer.
Your job is to find reasons either grading decision could be wrong. Do NOT re-grade.

Question ${question.id} (max ${question.maxMarks}):
${question.prompt}

Rubric:
${question.rubric.map((c) => `- ${c.id}: ${c.concept} (${c.marks})`).join("\n")}

Student transcript:
${semantic.rawTranscript}

Grader A (${graderA.provider}/${graderA.model}):
${JSON.stringify(graderA.rubricEvaluation, null, 2)}

Grader B (${graderB.provider}/${graderB.model}):
${JSON.stringify(graderB.rubricEvaluation, null, 2)}

Return ONLY this JSON:
{
  "issues": [
    { "criterionId": "...", "reason": "...", "severity": "low" | "medium" | "high" }
  ],
  "overallSuspicion": 0.0-1.0
}`;

  const resp = await registry.call("validator", { prompt, temperature: 0.2 });
  const parsed = extractJson<ValidatorReport>(resp.text);
  return {
    issues: parsed?.issues ?? [],
    overallSuspicion: clamp01(parsed?.overallSuspicion ?? 0),
  };
}

function clampMarks(v: unknown, max: number): number {
  return roundMarks(Math.min(max, Math.max(0, Number(v) || 0)));
}
function clamp01(v: unknown): number {
  return Math.min(1, Math.max(0, Number(v) || 0));
}
