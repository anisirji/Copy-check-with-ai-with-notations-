import type { Annotation } from "../types.js";

const INK = { correct: "#16734b", partial: "#a96308", incorrect: "#b4232c" };
type Note = Extract<Annotation, { type: "comment_box" }>;
export function wrapAnnotationText(text: string, limit = 24): string[] {
  const lines: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const chunks =
      word.length > limit
        ? word.match(new RegExp(`.{1,${limit}}`, "g"))!
        : [word];
    for (const chunk of chunks) {
      if (lines.length && `${lines.at(-1)} ${chunk}`.length <= limit)
        lines[lines.length - 1] += ` ${chunk}`;
      else lines.push(chunk);
    }
  }
  return lines;
}

/** One geometry calculation for the browser and PDF. Overflow grows the canvas;
 * it never pushes the last comment back over a previous one. */
export function annotationLayout(
  width: number,
  height: number,
  annotations: Annotation[],
) {
  const left = Math.ceil(width * 0.105);
  const right = Math.ceil(width * 0.35);
  const top = Math.ceil(width * 0.085);
  const font = Math.max(18, width * 0.023);
  const line = font * 1.32;
  let bottom = top + height;
  let next = top + width * 0.075;
  const comments = annotations
    .filter((a): a is Note => a.type === "comment_box")
    .sort((a, b) => a.y - b.y)
    .map((note) => {
      const heading = wrapAnnotationText(note.heading ?? "Feedback", 24);
      const body = wrapAnnotationText(note.text, 24);
      const y = Math.max(next, top + note.y * height);
      const h = (heading.length + body.length) * line + font * 0.5;
      next = y + h + font * 1.3;
      bottom = Math.max(bottom, next);
      return {
        note,
        heading,
        body,
        x: left + width + width * 0.035,
        y,
        height: h,
      };
    });
  return {
    width: width + left + right,
    height: Math.ceil(bottom + width * 0.035),
    left,
    right,
    top,
    font,
    line,
    comments,
  };
}

const esc = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );

/** Pure, escaped SVG, shared by React and the PNG/PDF renderer. */
export function buildAnnotationSvg(
  width: number,
  height: number,
  annotations: Annotation[],
): string {
  const l = annotationLayout(width, height, annotations);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${l.width}" height="${l.height}" viewBox="0 0 ${l.width} ${l.height}" style="display:block;width:100%;height:100%" aria-hidden="true">`,
  ];
  const stroke = Math.max(2, width * 0.0022);
  const x = (n: number) => l.left + n * width;
  const y = (n: number) => l.top + n * height;
  const text = (
    tx: number,
    ty: number,
    value: string,
    size: number,
    color: string,
    weight = 500,
    anchor = "start",
  ) =>
    `<text x="${tx}" y="${ty}" font-family="Arial,sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${esc(value)}</text>`;
  const scoreSlots: [number, number][] = [];
  for (const a of annotations) {
    switch (a.type) {
      case "ink":
      case "check":
      case "cross": {
        const kind =
          a.type === "ink"
            ? a.kind
            : a.type === "check"
              ? "correct"
              : "incorrect";
        const cx = x(a.x),
          cy = y(a.y),
          s = width * 0.015;
        const d =
          kind === "correct"
            ? `M ${cx - s * 0.6} ${cy} Q ${cx - s * 0.25} ${cy + s * 0.15} ${cx - s * 0.12} ${cy + s * 0.55} Q ${cx + s * 0.4} ${cy - s * 0.6} ${cx + s} ${cy - s * 0.85}`
            : kind === "incorrect"
              ? `M ${cx - s * 0.5} ${cy - s * 0.6} L ${cx + s * 0.55} ${cy + s * 0.6} M ${cx + s * 0.6} ${cy - s * 0.65} L ${cx - s * 0.5} ${cy + s * 0.6}`
              : `M ${cx - s * 0.7} ${cy + s * 0.2} Q ${cx - s * 0.2} ${cy - s * 0.6} ${cx + s * 0.15} ${cy} T ${cx + s} ${cy - s * 0.15}`;
        parts.push(
          `<path d="${d}" fill="none" stroke="${INK[kind]}" stroke-width="${stroke * 1.6}" stroke-linecap="round" stroke-linejoin="round"/>`,
        );
        break;
      }
      case "underline":
      case "wavy_underline": {
        // Broad legacy paragraph marks are deliberately suppressed.
        if (a.bbox.height > 0.055) break;
        parts.push(
          `<path d="M ${x(a.bbox.x)} ${y(a.bbox.y + a.bbox.height) + 4} L ${x(a.bbox.x + a.bbox.width)} ${y(a.bbox.y + a.bbox.height) + 3}" fill="none" stroke="${a.type === "underline" ? esc(a.color ?? INK.incorrect) : INK.incorrect}" stroke-width="${stroke}" stroke-linecap="round"/>`,
        );
        break;
      }
      case "circle": {
        if (a.bbox.width > 0.3 || a.bbox.height > 0.055) break;
        parts.push(
          `<ellipse cx="${x(a.bbox.x + a.bbox.width / 2)}" cy="${y(a.bbox.y + a.bbox.height / 2)}" rx="${(a.bbox.width * width) / 2}" ry="${(a.bbox.height * height) / 2}" fill="none" stroke="${INK.incorrect}" stroke-width="${stroke}"/>`,
        );
        break;
      }
      case "circled_score":
      case "question_score": {
        const rx = width * 0.043,
          ry = width * 0.026;
        let cy = Math.max(l.top + ry * 2, y(a.y) + ry);
        for (const [start, end] of scoreSlots)
          if (cy - ry * 2 < end && cy + ry > start) cy = end + ry * 2;
        scoreSlots.push([cy - ry * 2, cy + ry]);
        const cx = l.left * 0.49;
        const label = a.type === "circled_score" ? a.label : undefined;
        if (label)
          parts.push(
            text(
              cx,
              cy - ry * 1.4,
              label,
              width * 0.014,
              "#645666",
              600,
              "middle",
            ),
          );
        parts.push(
          `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" transform="rotate(-6 ${cx} ${cy})" fill="none" stroke="${INK.incorrect}" stroke-width="${stroke}"/>`,
        );
        parts.push(
          text(
            cx,
            cy + width * 0.007,
            a.text,
            Math.min(width * 0.025, (width * 0.125) / a.text.length),
            INK.incorrect,
            700,
            "middle",
          ),
        );
        break;
      }
      case "badge": {
        parts.push(
          text(l.left, width * 0.026, a.heading, width * 0.018, "#655868", 700),
        );
        if (a.subtext)
          parts.push(
            text(l.left, width * 0.055, a.subtext, width * 0.016, "#655868"),
          );
        break;
      }
      case "page_total": {
        const tx = l.width - width * 0.025;
        parts.push(
          text(
            tx,
            width * 0.031,
            a.text,
            width * 0.038,
            INK.incorrect,
            700,
            "end",
          ),
        );
        if (a.subline)
          parts.push(
            text(
              tx,
              width * 0.06,
              a.subline,
              width * 0.017,
              "#655868",
              500,
              "end",
            ),
          );
        break;
      }
      case "comment_box":
        break;
    }
  }
  for (const c of l.comments) {
    const color =
      c.note.kind === "good"
        ? INK.correct
        : c.note.kind === "improve"
          ? INK.partial
          : INK.incorrect;
    let baseline = c.y + l.font;
    for (const line of c.heading) {
      parts.push(text(c.x, baseline, line, l.font * 0.9, color, 700));
      baseline += l.line;
    }
    for (const line of c.body) {
      parts.push(text(c.x, baseline, line, l.font, color));
      baseline += l.line;
    }
  }
  parts.push("</svg>");
  return parts.join("\n");
}
