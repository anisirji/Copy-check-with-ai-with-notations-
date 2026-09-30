import { roundMarks } from "./exam-marks.js";
import type {
  Annotation,
  Block,
  QuestionGrading,
  RubricEval,
} from "../types.js";

/** Ink uses answer geometry; scores and notes use added margins, never handwriting.
 * Multiple criteria on one region share a single mark. */
export function buildAnnotations(
  grading: QuestionGrading[],
  blocks: Block[],
): Annotation[] {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const annotations: Annotation[] = [];
  const pages = new Set<number>();
  const notes = new Set<string>();
  for (const g of grading) {
    const evidence = g.rubricEvaluation.map((ev) => {
      return { ev, region: ev.evidenceRegion };
    });
    const positioned = evidence.filter(
      (e): e is typeof e & { region: NonNullable<typeof e.region> } =>
        !!e.region,
    );
    const groups = new Map<string, typeof positioned>();
    for (const item of positioned) {
      const { page, bbox: b } = item.region;
      pages.add(page);
      const key = `${page}:${[b.x, b.y, b.width, b.height].map((n) => n.toFixed(3)).join(":")}`;
      const group = groups.get(key) ?? [];
      group.push(item);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      const { page, bbox: b } = group[0].region;
      const precise = group.every(({ ev }) => ev.evidenceRegion);
      const statuses = new Set(group.map(({ ev }) => ev.status));
      const kind =
        statuses.size > 1 || statuses.has("partial")
          ? "partial"
          : statuses.has("correct")
            ? "correct"
            : "incorrect";
      // Paragraphs can mix correct and incorrect statements. Avoid contradictory stamps.
      if (precise) {
        const point = group[0].ev.evidenceRegion?.mark ?? {
          x: 1.017,
          y: b.y + b.height / 2,
        };
        annotations.push({ type: "ink", page, ...point, kind });
        if (
          kind === "incorrect" &&
          b.width < 0.28 &&
          b.height < 0.04 &&
          group[0].ev.evidenceRegion
        ) {
          annotations.push({
            type: "underline",
            page,
            bbox: b,
            color: "#b4232c",
          });
        }
      }
    }
    for (const { ev, region } of positioned) {
      if (ev.status === "correct") continue;
      const text = ev.feedback?.trim() || correctionText(ev);
      const key = `${g.questionId}:${region.page}:${text}`;
      if (notes.has(key)) continue;
      notes.add(key);
      const part = /^\[([^\]]+)\]/.exec(ev.concept)?.[1];
      annotations.push({
        type: "comment_box",
        page: region.page,
        x: 1.04,
        y: region.bbox.y,
        heading: `Q${part ?? g.questionId}`,
        text,
        kind: ev.status === "partial" ? "improve" : "wrong",
      });
    }
    const onPages = new Map<number, typeof positioned>();
    for (const e of positioned) {
      const group = onPages.get(e.region.page) ?? [];
      group.push(e);
      onPages.set(e.region.page, group);
    }
    // Missing evidence remains in review rather than getting a fabricated anchor.
    if (!onPages.size) {
      const fallback = g.answerBlockIds
        .map((id) => byId.get(id))
        .find((b) => b && b.type !== "question_number");
      if (fallback) {
        pages.add(fallback.page);
        annotations.push({
          type: "comment_box",
          page: fallback.page,
          x: 1.04,
          y: 0.04,
          heading: `Q${g.questionId} · ${g.awardedMarks}/${g.maxMarks}`,
          text:
            g.teacherComment?.trim() ||
            "Answer location needs review. See the question feedback before confirming these marks.",
          kind: "improve",
        });
      }
      continue;
    } else if (positioned.length < g.rubricEvaluation.length) {
      const first = positioned
        .slice()
        .sort(
          (a, b) =>
            a.region.page - b.region.page || a.region.bbox.y - b.region.bbox.y,
        )[0];
      annotations.push({
        type: "comment_box",
        page: first.region.page,
        x: 1.04,
        y: first.region.bbox.y,
        heading: `Q${g.questionId} · Check placement`,
        text: "Some marking steps could not be located reliably. See question feedback.",
        kind: "improve",
      });
    }
    for (const [page, items] of onPages) {
      pages.add(page);
      const y = items.length
        ? Math.min(...items.map((e) => e.region.bbox.y))
        : (byId.get(g.answerBlockIds[0])?.bbox.y ?? 0.1);
      const continuation = page !== Math.min(...onPages.keys());
      const pageAwarded = roundMarks(
        items.reduce((s, { ev }) => s + ev.marksAwarded, 0),
      );
      const pageMax = roundMarks(
        items.reduce((s, { ev }) => s + ev.marksAvailable, 0),
      );
      annotations.push({
        type: "circled_score",
        page,
        x: -0.06,
        y,
        text:
          onPages.size > 1 &&
          items.length &&
          positioned.length === g.rubricEvaluation.length
            ? `${pageAwarded}/${pageMax}`
            : `${g.awardedMarks}/${g.maxMarks}`,
        label: `Q${g.questionId}${continuation ? " cont." : ""}`,
      });
      if (
        items.length > 1 &&
        items.every(({ ev }) => ev.status === "correct")
      ) {
        annotations.push({
          type: "comment_box",
          page,
          x: 1.04,
          y,
          heading: `Q${g.questionId}${continuation ? " continued" : ""}`,
          text:
            onPages.size > 1
              ? `All steps on this page credited. Question total: ${g.awardedMarks}/${g.maxMarks}.`
              : "All steps credited.",
          kind: "good",
        });
      }
    }
    if (g.teacherComment?.trim() && onPages.size) {
      const page = Math.min(...onPages.keys());
      const items = onPages.get(page)!;
      annotations.push({
        type: "comment_box",
        page,
        x: 1.04,
        y: items.length ? Math.min(...items.map((e) => e.region.bbox.y)) : 0.1,
        heading: `Q${g.questionId} · Teacher`,
        text: g.teacherComment.trim(),
        kind: "improve",
      });
    }
  }
  for (const page of pages)
    annotations.push({
      type: "badge",
      page,
      heading: grading.some((g) => g.needsTeacherReview)
        ? "DRAFT · TEACHER REVIEW"
        : "REVIEWED",
      subtext: `Page ${page} · ticks = credited · amber = partial`,
    });
  const awarded = roundMarks(grading.reduce((s, g) => s + g.awardedMarks, 0));
  const maximum = roundMarks(grading.reduce((s, g) => s + g.maxMarks, 0));
  if (maximum)
    annotations.push({
      type: "page_total",
      page: 1,
      text: `${awarded}/${maximum}`,
      subline: grading.some((g) => g.needsTeacherReview)
        ? "Draft total"
        : "Total",
    });
  return annotations;
}

function correctionText(ev: RubricEval): string {
  const concept = ev.concept.replace(/^(?:\[[^\]]+\]\s*)+/, "").trim();
  if (ev.status === "missing") return `Not shown: ${concept}.`;
  if (ev.status === "partial") return `Complete: ${concept}.`;
  return `Check: ${concept}.`;
}
