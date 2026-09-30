import type { Block, ExamConfig, SemanticAnswer } from "../types.js";

/**
 * Stage 5 — Semantic answer representation.
 *
 * Turns raw OCR blocks for each question into a structured object that the
 * grader can reason over:
 *   { conceptsDetected, equations, steps, diagrams, uncertainText, rawTranscript }
 *
 * This is a lightweight version — a full implementation would run a
 * concept-extraction LLM pass per question. Here we derive it from block types
 * and simple heuristics so the pipeline stays cheap; the grader still receives
 * the original image crops so it can correct any misclassification.
 */
export function toSemanticAnswers(
  exam: ExamConfig,
  blocks: Block[],
  mapping: Record<string, string[]>,
): SemanticAnswer[] {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  return exam.questions.map((q) => {
    const blockIds = mapping[q.id] ?? [];
    const answerBlocks = blockIds
      .map((id) => byId.get(id))
      .filter(Boolean) as Block[];

    const equations: SemanticAnswer["equations"] = [];
    const steps: SemanticAnswer["steps"] = [];
    const diagrams: SemanticAnswer["diagrams"] = [];
    const uncertainText: string[] = [];
    const textPieces: string[] = [];

    for (const b of answerBlocks) {
      if (b.ocrAlternatives?.length)
        uncertainText.push(
          `OCR disagreement at ${b.id}: ${b.text} | ${b.ocrAlternatives.join(" | ")}`,
        );
      if (b.type === "equation") {
        equations.push({ text: b.text, blockId: b.id });
        // Split multi-line equations into steps for math grading
        b.text
          .split(/\n|;/)
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((s) => steps.push({ text: s, blockId: b.id }));
      } else if (b.type === "diagram") {
        diagrams.push({ description: b.text, blockId: b.id });
      } else if (b.type === "crossed_out") {
        // Ignored — crossed out by student
      } else if (b.type === "text" || b.type === "other") {
        textPieces.push(b.text);
        // Very short or all-uppercase blocks flagged as uncertain
        if (b.text.length < 3 || /\?{2,}|_{2,}/.test(b.text)) {
          uncertainText.push(b.text);
        }
      }
    }

    const rawTranscript = answerBlocks
      .map((b) => `[${b.id}] (${b.type}) ${b.text}`)
      .join("\n");

    const conceptsDetected = extractConcepts(textPieces.join(" "));

    return {
      questionId: q.id,
      answerBlockIds: blockIds,
      conceptsDetected,
      equations,
      steps,
      diagrams,
      uncertainText,
      rawTranscript,
    };
  });
}

/**
 * Trivial keyword-noun extractor. Kept dependency-free; a production system
 * would use an LLM concept-tag pass here.
 */
function extractConcepts(text: string): string[] {
  if (!text) return [];
  const KEYWORDS = [
    "proton",
    "neutron",
    "electron",
    "nucleus",
    "nucleon",
    "atomic number",
    "mass number",
    "isotope",
    "ion",
    "anion",
    "cation",
    "photosynthesis",
    "chlorophyll",
    "glucose",
    "oxygen",
    "carbon dioxide",
    "water",
    "sunlight",
    "energy",
    "mitochondria",
    "respiration",
    "velocity",
    "acceleration",
    "displacement",
    "distance",
  ];
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const k of KEYWORDS) if (lower.includes(k)) found.add(k);
  return Array.from(found);
}
