import type { Block } from "../types.js";

export interface ReconcileAudit {
  keptId: string;
  droppedId: string;
  reason: "duplicate_text" | "bbox_overlap" | "orphan_secondary";
  page: number;
  keptSource: "primary" | "secondary";
}

const TEXT_SIM_THRESHOLD = 0.75;
const BBOX_IOU_THRESHOLD = 0.4;
const ORPHAN_Y_RADIUS = 0.06;

/**
 * Merge primary + secondary vision-stream duplicates before mapping.
 *
 * Two independent vision passes (primary `p*_bN` and secondary `s*_bN`)
 * often produce THE SAME piece of handwriting with slightly different
 * bounding boxes. When both survive into the mapper's y-sorted walk,
 * the secondary copy can drift across a question boundary — the same
 * content ends up assigned to two different canonical questions.
 *
 * The reconciler groups blocks by (page, type) and merges pairs that are
 * clearly the same content:
 *   - normalized text similarity > 0.85, OR
 *   - bounding boxes overlap (IoU > 0.4) on the same page with the same type
 *
 * When a pair is merged we keep the PRIMARY source (id starts with "p"),
 * fall back to whichever appears first if neither is clearly primary.
 * Nothing is deleted — dropped ids are recorded in the audit trail.
 *
 * Runs entirely on the cached blocks; no LLM/vision calls.
 */
export function reconcileAnswerBlocks(
  blocks: Block[],
  audit?: (event: ReconcileAudit) => void,
): Block[] {
  // Group by page + type so we compare like with like.
  const byGroup = new Map<string, Block[]>();
  for (const b of blocks) {
    const key = `${b.page}::${b.type}`;
    const arr = byGroup.get(key) ?? [];
    arr.push(b);
    byGroup.set(key, arr);
  }

  const dropped = new Set<string>();
  // Pass 1 — merge same-content pairs (text/bbox similarity).
  for (const group of byGroup.values()) {
    for (let i = 0; i < group.length; i++) {
      const a = group[i];
      if (dropped.has(a.id)) continue;
      for (let j = i + 1; j < group.length; j++) {
        const b = group[j];
        if (dropped.has(b.id)) continue;
        const dup = duplicateReason(a, b);
        if (!dup) continue;
        const keep = prefer(a, b);
        const drop = keep === a ? b : a;
        dropped.add(drop.id);
        audit?.({
          keptId: keep.id,
          droppedId: drop.id,
          reason: dup,
          page: a.page,
          keptSource: sourceOf(keep.id),
        });
      }
    }
  }
  // Pass 2 — drop remaining secondary blocks that:
  //   a) have no primary neighbor within ORPHAN_Y_RADIUS on the same page, OR
  //   b) trail a secondary block we already dropped in pass 1 (the label was
  //      noise, so the content following it is likely noise too — this is
  //      how "Not Nucleus" hallucinations sneak into the next question).
  //
  // Question_number secondaries pass through pass 2 unchanged so they can
  // still act as answer boundaries if their bbox happens to be trustworthy.
  const survivors = blocks.filter((b) => !dropped.has(b.id));
  const primaryByPage = new Map<number, Block[]>();
  for (const b of survivors) {
    if (sourceOf(b.id) !== "primary") continue;
    const list = primaryByPage.get(b.page) ?? [];
    list.push(b);
    primaryByPage.set(b.page, list);
  }
  // Build the secondary-block reading order per page so we can look at the
  // immediately preceding secondary block for the cascade check.
  const secondaryByPage = new Map<number, Block[]>();
  for (const b of blocks) {
    if (sourceOf(b.id) !== "secondary") continue;
    const list = secondaryByPage.get(b.page) ?? [];
    list.push(b);
    secondaryByPage.set(b.page, list);
  }
  for (const list of secondaryByPage.values()) {
    list.sort((a, b) => a.bbox.y - b.bbox.y);
  }
  for (const b of survivors) {
    if (dropped.has(b.id)) continue;
    if (sourceOf(b.id) !== "secondary") continue;
    if (b.type === "question_number") continue;
    const neighbors = primaryByPage.get(b.page) ?? [];
    const hasNeighbor = neighbors.some(
      (p) => Math.abs(p.bbox.y - b.bbox.y) <= ORPHAN_Y_RADIUS,
    );
    const pageSecondaries = secondaryByPage.get(b.page) ?? [];
    const priorSecondary = [...pageSecondaries]
      .reverse()
      .find(
        (s) =>
          s.bbox.y < b.bbox.y &&
          Math.abs(s.bbox.y - b.bbox.y) <= ORPHAN_Y_RADIUS,
      );
    const trailsDroppedLabel = priorSecondary && dropped.has(priorSecondary.id);
    if (!hasNeighbor || trailsDroppedLabel) {
      dropped.add(b.id);
      audit?.({
        keptId: "",
        droppedId: b.id,
        reason: "orphan_secondary",
        page: b.page,
        keptSource: "primary",
      });
    }
  }
  return blocks.filter((b) => !dropped.has(b.id));
}

/**
 * Was a block ever mapped to more than one canonical question? The mapper
 * itself already appends to a single bucket at a time, but this invariant
 * lets us harden that guarantee end-to-end. Returns duplicate assignments
 * as `{ blockId, questionIds[] }` — empty array means the invariant holds.
 */
export function findOwnershipConflicts(
  mapping: Record<string, string[]>,
): { blockId: string; questionIds: string[] }[] {
  const owners = new Map<string, string[]>();
  for (const [qid, ids] of Object.entries(mapping)) {
    for (const id of ids) {
      const cur = owners.get(id) ?? [];
      if (!cur.includes(qid)) cur.push(qid);
      owners.set(id, cur);
    }
  }
  const conflicts: { blockId: string; questionIds: string[] }[] = [];
  for (const [blockId, qids] of owners) {
    if (qids.length > 1) conflicts.push({ blockId, questionIds: qids });
  }
  return conflicts;
}

// ─── helpers ─────────────────────────────────────────────────────────────

function duplicateReason(a: Block, b: Block): ReconcileAudit["reason"] | null {
  if (a.page !== b.page) return null;
  if (a.type !== b.type) return null;
  if (textSimilarity(a.text, b.text) >= TEXT_SIM_THRESHOLD)
    return "duplicate_text";
  if (iou(a.bbox, b.bbox) >= BBOX_IOU_THRESHOLD) return "bbox_overlap";
  return null;
}

function sourceOf(id: string): "primary" | "secondary" {
  return id.startsWith("p") ? "primary" : "secondary";
}

/**
 * Prefer primary over secondary. When both are the same source, prefer the
 * one whose bounding box has higher vertical position (smaller y) — that's
 * usually the first-written version of the same line.
 */
function prefer(a: Block, b: Block): Block {
  const aPrim = sourceOf(a.id) === "primary";
  const bPrim = sourceOf(b.id) === "primary";
  if (aPrim && !bPrim) return a;
  if (bPrim && !aPrim) return b;
  return a.bbox.y <= b.bbox.y ? a : b;
}

function normalizeText(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textSimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  // Simple Jaccard on 3-shingle chars — good enough for OCR near-dupes.
  const shingles = (s: string): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i <= s.length - 3; i++) out.add(s.slice(i, i + 3));
    return out;
  };
  const A = shingles(na);
  const B = shingles(nb);
  if (!A.size || !B.size) return 0;
  let intersect = 0;
  for (const s of A) if (B.has(s)) intersect += 1;
  return intersect / (A.size + B.size - intersect);
}

function iou(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}
