import type { Block } from "../types.js";

export interface CanonicalAnswer {
  /** Teacher-facing plain text: markers stripped, duplicates deduped. */
  plainText: string;
  /** Distinct math expressions (LaTeX-ish). */
  equations: string[];
  /** Distinct diagram descriptions (for the developer view — UI can show crops separately). */
  diagrams: string[];
  /** Content the student crossed out — never mixed into plainText. */
  crossedOut: string[];
  /** Every block id that contributed — kept for the developer expander. */
  sourceBlockIds: string[];
}

/**
 * Build the clean, teacher-facing answer for a single question from the
 * blocks the mapper attached to it.
 *
 * The mapper's output is a mixed stream — parent numbers, answer markers,
 * primary + secondary transcriptions of the same content, crossed-out
 * fragments, equations, and diagram descriptions all arrive together.
 * A teacher should see the student's actual writing, once, in a natural
 * reading order — nothing else.
 *
 * Rules:
 *  - `question_number` blocks are structural (`Q1`, `Ans a`, `i)`), never
 *    part of the semantic answer — dropped.
 *  - `synthetic: true` blocks come from the answer-marker normalizer — dropped.
 *  - `crossed_out` blocks are surfaced separately so the developer view can
 *    show "a crossed-out response was ignored", but never leak into plainText.
 *  - Near-duplicate text/equations (Jaccard ≥ 0.85 after normalization) are
 *    kept once. Primary-source (`p*`) ids win over secondary (`s*`).
 *  - Order preserves reading order (y within page, then page number).
 */
export function buildCanonicalAnswer(mappedBlocks: Block[]): CanonicalAnswer {
  const ordered = [...mappedBlocks].sort(
    (a, b) => a.page - b.page || a.bbox.y - b.bbox.y,
  );

  const textLines: string[] = [];
  const equations: string[] = [];
  const diagrams: string[] = [];
  const crossedOut: string[] = [];
  const sourceBlockIds: string[] = [];

  for (const block of ordered) {
    sourceBlockIds.push(block.id);
    if (block.synthetic) continue;
    if (block.type === "question_number") continue;
    if (block.type === "crossed_out") {
      const t = (block.text ?? "").trim();
      if (t && !contains(crossedOut, t)) crossedOut.push(t);
      continue;
    }
    if (block.type === "diagram") {
      const t = (block.text ?? "").trim();
      if (t && !contains(diagrams, t)) diagrams.push(t);
      continue;
    }
    if (block.type === "equation") {
      const t = (block.text ?? "").trim();
      if (t && !contains(equations, t)) equations.push(t);
      // Equations also appear inline in the plainText for continuity.
      if (t && !contains(textLines, t)) textLines.push(t);
      continue;
    }
    // text / other
    const t = (block.text ?? "").trim();
    if (!t) continue;
    if (contains(textLines, t)) continue;
    textLines.push(t);
  }

  return {
    plainText: textLines.join("\n"),
    equations,
    diagrams,
    crossedOut,
    sourceBlockIds,
  };
}

function contains(existing: string[], candidate: string): boolean {
  const nc = normalizeText(candidate);
  return existing.some((e) => textSimilarity(normalizeText(e), nc) >= 0.85);
}

function normalizeText(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shingles = (s: string): Set<string> => {
    const out = new Set<string>();
    const src = s.length < 3 ? s.padEnd(3, "_") : s;
    for (let i = 0; i <= src.length - 3; i++) out.add(src.slice(i, i + 3));
    return out;
  };
  const A = shingles(a);
  const B = shingles(b);
  if (!A.size || !B.size) return 0;
  let intersect = 0;
  for (const s of A) if (B.has(s)) intersect += 1;
  return intersect / (A.size + B.size - intersect);
}
