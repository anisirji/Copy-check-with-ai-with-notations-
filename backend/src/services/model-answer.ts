import { ProviderRegistry } from "../providers/index.js";
import type { ExtractedQuestion } from "./paper-extractor.js";
import { extractJson } from "./util-json.js";

/**
 * Phase 1 — Generate a canonical model answer for a question.
 *
 * Uses the highest-quality reasoner (Claude by default). Kept short and
 * strictly on-syllabus for K-12 CBSE/ICSE. Teacher reviews before saving.
 */
export async function generateModelAnswer(
  question: ExtractedQuestion,
  context: {
    subject?: string;
    class?: string;
  },
  registry: ProviderRegistry,
): Promise<string> {
  const prompt = `Write the ideal short model answer for this ${context.subject ?? question.subject} question for ${context.class ?? "K-12"} students.

Question ${question.id} (${question.maxMarks ?? "?"} marks):
${question.prompt}

Guidelines:
- Be concise (typical length for a ${question.maxMarks ?? "small"}-mark answer).
- Use standard scientific notation and units where relevant.
- Match the stated class level and the representation requested in the question. Do not introduce advanced notation as a requirement. For school-level atomic structure, shell configurations such as 2, 8, 3 and 2, 8, 7 are complete answers unless orbital/subshell notation is explicitly requested.
- For multi-part questions, address each part in order.
- Do NOT include extra commentary, "here is the answer", or markdown.

Return ONLY this JSON:
{ "modelAnswer": "..." }`;

  const resp = await registry.call("model-answer", {
    prompt,
    temperature: 0.15,
  });
  const parsed = extractJson<{ modelAnswer: string }>(resp.text);
  return parsed?.modelAnswer?.trim() ?? "";
}
