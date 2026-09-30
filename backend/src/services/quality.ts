import sharp from "sharp";
import type { PageMeta, QualityReport } from "../types.js";

/**
 * Stage 1 — Image Quality Gate.
 *
 * Uses sharp's stats + a 3×3 Laplacian convolution to estimate:
 *   - brightness (mean intensity of grayscale)
 *   - contrast   (stddev of grayscale)
 *   - blur       (inverse of Laplacian variance — well-focused pages have
 *                 high edge energy; blurry scans have low variance)
 *
 * The threshold is deliberately loose (0.35) for the POC — a real deployment
 * would tune this against a labelled dataset of good/bad scans and add
 * perspective + shadow detection.
 */
export async function gatePages(pages: PageMeta[]): Promise<QualityReport[]> {
  const reports: QualityReport[] = [];
  for (const p of pages) {
    const stats = await sharp(p.imagePath).greyscale().stats();
    const gray = stats.channels[0];
    const brightness = clamp01(gray.mean / 255);
    const contrast = clamp01(gray.stdev / 80);

    const lapStats = await sharp(p.imagePath)
      .greyscale()
      .convolve({
        width: 3,
        height: 3,
        kernel: [0, -1, 0, -1, 4, -1, 0, -1, 0],
      })
      .stats();
    const lapVariance = lapStats.channels[0].stdev ** 2;
    const sharpness = clamp01(lapVariance / 500);
    const blur = 1 - sharpness;

    const quality =
      0.5 * (1 - blur) +
      0.25 * contrast +
      0.25 * (1 - Math.min(1, Math.abs(0.6 - brightness) / 0.4));

    const acceptable = quality >= 0.35;
    reports.push({
      page: p.page,
      quality: round2(quality),
      blur: round2(blur),
      brightness: round2(brightness),
      contrast: round2(contrast),
      acceptable,
      reason: acceptable ? undefined : "quality below threshold (0.35)",
    });
  }
  return reports;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
