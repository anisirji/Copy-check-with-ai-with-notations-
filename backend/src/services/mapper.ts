import type { Block, ExamConfig } from "../types.js";
import { questionIdParts } from "./exam-merge.js";

/**
 * Route full and relative question labels using the paper's actual hierarchy.
 * A shared heading such as Q1 establishes context; it must never claim the
 * last of 1(a), 1(b), ... . Known paths also disambiguate the letter (i) from
 * a roman-numeral section without guessing from the character alone.
 */
export function mapBlocksToQuestions(
  blocks: Block[],
  exam: ExamConfig,
): Record<string, string[]> {
  const byQuestion: Record<string, string[]> = Object.fromEntries(
    exam.questions.map((q) => [q.id, []]),
  );
  const labels = new Map<string, Set<string>>();
  const subtrees = new Map<string, Set<string>>();
  const opaqueIds = new Map<string, Set<string>>();
  const ownPaths = new Map<string, string>();
  const mergedIds = new Set<string>();
  const headings = new Set<string>();

  for (const q of exam.questions) {
    if (q.sourceQuestionIds?.length) mergedIds.add(q.id);
    for (const label of [q.id, ...(q.sourceQuestionIds ?? [])]) {
      const parts = questionIdParts(label);
      if (!parts) {
        addOwner(opaqueIds, normalize(label), q.id);
        continue;
      }
      if (label === q.id) ownPaths.set(q.id, key(parts));
      addOwner(labels, key(parts), q.id);
      for (let length = 1; length <= parts.length; length++) {
        addOwner(subtrees, key(parts.slice(0, length)), q.id);
        if (length < parts.length) headings.add(key(parts.slice(0, length)));
      }
    }
  }

  function resolve(parts: string[]): string | null {
    // Exact aliases and whole-question ancestors take precedence. Child
    // labels of an intact/merged question all belong to that same question.
    for (let length = parts.length; length > 0; length--) {
      const owners = labels.get(key(parts.slice(0, length)));
      if (owners) return uniqueOwner(owners);
    }
    // A heading is sufficient only if every descendant has the same owner.
    return uniqueOwner(subtrees.get(key(parts)));
  }

  let currentPath: string[] | null = null;
  let currentBucket: string | null = null;
  const sorted = [...blocks].sort(
    (a, b) => a.page - b.page || a.bbox.y - b.bbox.y,
  );

  for (const block of sorted) {
    if (block.type === "question_number") {
      const raw = block.text.trim();
      const opaqueOwners = opaqueIds.get(normalize(raw));
      if (opaqueOwners) {
        currentBucket = uniqueOwner(opaqueOwners);
        currentPath = null;
        continue;
      }
      const marker = parseMarker(raw);
      if (marker) {
        let nextPath: string[] | null = null;
        if (marker.full) {
          nextPath = marker.parts;
        } else if (currentPath) {
          // Prefer the deepest existing path: after 5(i), (a) means
          // 5(i)(a); (ii) goes back up to 5(ii) when it is a sibling section.
          for (let length = currentPath.length; length > 0; length--) {
            const candidate: string[] = [
              ...currentPath.slice(0, length),
              ...marker.parts,
            ];
            if (subtrees.has(key(candidate))) {
              nextPath = candidate;
              break;
            }
          }
          if (!nextPath) {
            // Unrecognized sibling labels must not retain the previous
            // subquestion. A whole-question ancestor may still own them.
            const isHeading = headings.has(key(currentPath));
            const parent: string[] =
              currentPath.length === 1 || isHeading
                ? currentPath
                : currentPath.slice(0, -1);
            nextPath = [...parent, ...marker.parts];
          }
        }

        currentPath = nextPath;
        currentBucket = nextPath ? resolve(nextPath) : null;
        if (
          currentBucket &&
          nextPath &&
          (mergedIds.has(currentBucket) ||
            ownPaths.get(currentBucket) !== key(nextPath))
        ) {
          // Keep child labels in the semantic transcript when their answers
          // share one rubric, including full source IDs after a merge.
          byQuestion[currentBucket].push(block.id);
        }
        continue;
      }

      // Generic "Ans" markers and other unrecognized text remain content.
    }
    if (currentBucket) byQuestion[currentBucket].push(block.id);
  }
  return byQuestion;
}

function parseMarker(raw: string): { full: boolean; parts: string[] } | null {
  const text = raw
    .replace(/^(?:ans(?:wer)?)[\s.:>\-]*/i, "")
    .replace(/^(question|q)\s*\.\s*(?=\d)/i, "$1")
    .trim()
    .replace(/[.:>\-]+$/, "");
  if (!text) return null;
  const full = questionIdParts(text);
  if (full) return { full: true, parts: full };
  // A synthetic root lets full IDs and relative labels use the same syntax.
  const relativeText = text
    .replace(/[()]/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\.|\.$/g, "");
  const relative = questionIdParts(`0.${relativeText}`);
  if (!relative || relative.length < 2) return null;
  const parts = relative.slice(1);
  if (!parts.every((part) => /^(?:[a-z]|[ivxlcdm]+)$/i.test(part))) return null;
  return { full: false, parts };
}

function key(parts: string[]): string {
  return parts.join(".");
}

function addOwner(
  index: Map<string, Set<string>>,
  label: string,
  owner: string,
): void {
  const owners = index.get(label) ?? new Set<string>();
  owners.add(owner);
  index.set(label, owners);
}

function uniqueOwner(owners: Set<string> | undefined): string | null {
  return owners?.size === 1 ? owners.values().next().value! : null;
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "");
}
