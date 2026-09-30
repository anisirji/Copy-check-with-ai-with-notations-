import type { Annotation } from "../types";
import { buildAnnotationSvg } from "../../../backend/src/services/annotation-svg";

/** The same escaped SVG used by the downloadable marked PDF. */
export default function AnnotationOverlay({
  annotations,
  width,
  height,
}: {
  annotations: Annotation[];
  width: number;
  height: number;
}) {
  return (
    <div
      aria-hidden="true"
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      dangerouslySetInnerHTML={{
        __html: buildAnnotationSvg(width, height, annotations),
      }}
    />
  );
}
