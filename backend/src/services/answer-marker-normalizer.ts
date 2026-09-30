import type { Block } from "../types.js";

export interface NormalizerAudit {
  page: number;
  sourceBlockId: string;
  parent: string;
  canonicalId: string;
  markerLiteral: string;
  answerPreview: string;
}

/**
 * Defensive layer between vision extraction and mapping.
 *
 * Vision extracts what it *sees*; sometimes a student writes a sub-part
 * marker like "Ans a>" on the same visual line as the answer, so the vision
 * model returns one `text` block: `"Ans a> Plant → Small bird"`. The mapper
 * would then have no `question_number` block to switch buckets on, and the
 * answer gets orphaned.
 *
 * This normalizer walks blocks in reading order (page → y), tracks the
 * current parent question number, and — when a `text` block starts with an
 * answer-marker (`Ans a>`, `Ans (b)`, `a)`, `(ii)`, `Answer: c`, …) — emits
 *
 *   1) a synthetic `question_number` block carrying the CANONICAL id
 *      (`"1(a)"`) so the mapper resolves it unambiguously
 *   2) the same text block with its leading marker stripped
 *
 * Guardrails:
 *   - Bare markers (`a)`, `(ii)`) are only accepted when a parent has already
 *     been seen this run, so a bulleted list at the top of a page isn't
 *     misread as `?(a)`.
 *   - Roman numerals are recognized in their own namespace so `i)` under
 *     parent `5` becomes `5(i)` not `5(a)`.
 *   - The synthetic block's bbox matches the source; it is stamped
 *     `synthetic: true` for audit and downstream filtering.
 *
 * Vision (raw) → normalizeAnswerMarkers → mapBlocksToQuestions.
 */
export function normalizeAnswerMarkers(
  blocks: Block[],
  audit?: (event: NormalizerAudit) => void,
): Block[] {
  const sorted = [...blocks].sort(
    (a, b) => a.page - b.page || a.bbox.y - b.bbox.y,
  );

  const out: Block[] = [];
  let currentParent: string | null = null;
  let syntheticCount = 0;

  for (const block of sorted) {
    // Update parent from parent-only question_number blocks.
    if (block.type === "question_number") {
      const parent = extractParentNumber(block.text);
      if (parent) currentParent = parent;
      out.push(block);
      continue;
    }

    if (block.type !== "text") {
      out.push(block);
      continue;
    }

    const parsed = extractLeadingAnswerMarker(block.text);
    if (!parsed || !currentParent) {
      out.push(block);
      continue;
    }

    // Build canonical id: parent + sub-part.
    const canonicalId = `${currentParent}(${parsed.marker})`;

    // Synthetic question_number block, positioned at the block's start.
    syntheticCount += 1;
    out.push({
      id: `${block.id}_ans_${syntheticCount}`,
      page: block.page,
      type: "question_number",
      text: canonicalId,
      bbox: {
        x: block.bbox.x,
        y: block.bbox.y,
        // Narrow — the marker itself, not the whole line — so the mapper's
        // y-sort still orders the answer text right after it.
        width: Math.min(block.bbox.width, 0.06),
        height: block.bbox.height,
      },
      synthetic: true,
    });

    // The trimmed text block (unchanged type + bbox).
    out.push({
      ...block,
      text: parsed.remainder,
    });

    audit?.({
      page: block.page,
      sourceBlockId: block.id,
      parent: currentParent,
      canonicalId,
      markerLiteral: block.text
        .slice(0, block.text.length - parsed.remainder.length)
        .trim(),
      answerPreview: parsed.remainder.slice(0, 60),
    });
  }

  return out;
}

/**
 * Parse "1)", "1.", "Q1", "Question 2" → the parent number as a string.
 * Returns null for anything that already looks like a sub-part.
 */
function extractParentNumber(raw: string): string | null {
  const cleaned = raw
    .trim()
    .replace(/^(?:question|q)[\s.:>-]*/i, "")
    .replace(/[)>.:\-]+$/, "");
  return /^\d+$/.test(cleaned) ? cleaned : null;
}

const ANSWER_PREFIX = /^\s*(?:answer|ans)\s*[.:>\-]*\s*/i;

// Two shapes:
//   PAREN — "(a)", "(ii)": stronger, works with or without an "Ans" preamble.
//   BARE  — "a)", "ii)", "iv.": stronger when it has a delimiter; a lone
//          letter followed by a space is only accepted after an "Ans" prefix
//          (to avoid grabbing normal prose like "I saw ..." or "A note ...").
const PAREN_MARKER = /^\s*\(\s*([a-z]|[ivxlcdm]+)\s*\)\s*/i;
const BARE_DELIMITED = /^\s*([a-z]|[ivxlcdm]+)\s*[)>.:\-]+\s*/i;
const BARE_SPACED = /^\s*([a-z]|[ivxlcdm]+)\s+/i;

/**
 * Detect and consume a leading answer marker. Returns:
 *   - marker: canonical sub-part string ("a", "ii", …)
 *   - remainder: text with the marker (and any "Ans" prefix) stripped
 * or null when the text does not start with a recognizable marker.
 */
export function extractLeadingAnswerMarker(
  text: string,
): { marker: string; remainder: string } | null {
  let working = text;
  const hadAnsPrefix = ANSWER_PREFIX.test(working);
  if (hadAnsPrefix) working = working.replace(ANSWER_PREFIX, "");

  // Try shapes in order of confidence.
  const paren = PAREN_MARKER.exec(working);
  const delim = paren ? null : BARE_DELIMITED.exec(working);
  // Bare-spaced marker (no delimiter) is only trusted after an "Ans" preamble.
  const spaced =
    paren || delim || !hadAnsPrefix ? null : BARE_SPACED.exec(working);
  const match = paren ?? delim ?? spaced;
  if (!match) return null;

  const rawMarker = (match[1] ?? "").toLowerCase();
  if (!rawMarker) return null;
  if (!/^[a-z]$/.test(rawMarker) && !/^[ivxlcdm]+$/.test(rawMarker)) {
    return null;
  }

  const remainder = working.slice(match[0].length).trim();
  // Reject empty remainders in bare-marker mode — could be a stray label,
  // not an answer. When it followed an "Ans" prefix we still emit (student
  // may have started writing on next block).
  if (!hadAnsPrefix && remainder.length === 0) return null;

  return { marker: rawMarker, remainder };
}
