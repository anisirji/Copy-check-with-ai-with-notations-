import fs from "node:fs/promises";
import { GoogleAuth } from "google-auth-library";

const ENDPOINT = "https://vision.googleapis.com/v1/images:annotate";
const SCOPES = ["https://www.googleapis.com/auth/cloud-vision"];

interface GVisionWord {
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
  confidence: number;
}

/**
 * Google Cloud Vision Document AI adapter.
 *
 * Auth (Application Default Credentials priority order — `google-auth-library`
 * handles this transparently):
 *   1. GOOGLE_CLOUD_VISION_CREDENTIALS  — inline service-account JSON string
 *   2. GOOGLE_APPLICATION_CREDENTIALS  — path to service-account JSON file
 *   3. `gcloud auth application-default login`  — user creds from ~/.config/gcloud
 *   4. GCE / Cloud Run metadata service (production)
 *
 * Skipped silently if none of the above is available.
 *
 * Fires only as a *coordinate-precise* fallback: when the vision cascade
 * disagrees on a specific crop, we send just that crop to Google Vision and
 * take its per-word bboxes + confidences. Not used as primary OCR because
 * VLMs read handwriting better; Google Vision's win is precise geometry.
 */
export async function extractWordBoxes(
  imagePath: string,
  crop?: { x: number; y: number; width: number; height: number },
): Promise<GVisionWord[]> {
  const token = await getAccessToken();
  if (!token) return [];

  const bytes = await fs.readFile(imagePath);
  const body = {
    requests: [
      {
        image: { content: bytes.toString("base64") },
        features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
      },
    ],
  };

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`GVision ${res.status}`), {
      status: res.status,
    });
  }
  const data = (await res.json()) as {
    responses?: Array<{
      fullTextAnnotation?: {
        pages?: Array<{
          width: number;
          height: number;
          blocks?: Array<{
            paragraphs?: Array<{
              words?: Array<{
                symbols?: Array<{ text: string; confidence?: number }>;
                boundingBox?: { vertices: Array<{ x?: number; y?: number }> };
              }>;
            }>;
          }>;
        }>;
      };
    }>;
  };

  const page = data.responses?.[0]?.fullTextAnnotation?.pages?.[0];
  if (!page) return [];
  const pageW = page.width;
  const pageH = page.height;

  const out: GVisionWord[] = [];
  for (const block of page.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const word of para.words ?? []) {
        const text = (word.symbols ?? []).map((s) => s.text).join("");
        const verts = word.boundingBox?.vertices ?? [];
        if (verts.length < 4 || !text.trim()) continue;
        const xs = verts.map((v) => v.x ?? 0);
        const ys = verts.map((v) => v.y ?? 0);
        const x = Math.min(...xs) / pageW;
        const y = Math.min(...ys) / pageH;
        const width = (Math.max(...xs) - Math.min(...xs)) / pageW;
        const height = (Math.max(...ys) - Math.min(...ys)) / pageH;
        const confidences =
          word.symbols?.map((s) => s.confidence ?? 1).filter(Boolean) ?? [];
        const confidence =
          confidences.length > 0
            ? confidences.reduce((s, v) => s + v, 0) / confidences.length
            : 1;
        if (
          crop &&
          (x < crop.x - 0.02 ||
            y < crop.y - 0.02 ||
            x + width > crop.x + crop.width + 0.02 ||
            y + height > crop.y + crop.height + 0.02)
        ) {
          continue;
        }
        out.push({ text, bbox: { x, y, width, height }, confidence });
      }
    }
  }
  return out;
}

// ─── Auth via google-auth-library (handles ADC + service account) ────────────

let authClient: GoogleAuth | null | undefined;

function getAuth(): GoogleAuth | null {
  if (authClient !== undefined) return authClient;

  const inline = process.env.GOOGLE_CLOUD_VISION_CREDENTIALS;
  if (inline) {
    try {
      const credentials = JSON.parse(inline);
      authClient = new GoogleAuth({ credentials, scopes: SCOPES });
      return authClient;
    } catch {
      console.warn(
        "[gvision] GOOGLE_CLOUD_VISION_CREDENTIALS is not valid JSON — trying ADC",
      );
    }
  }

  // Falls through to GOOGLE_APPLICATION_CREDENTIALS file path, then to
  // `gcloud auth application-default login` creds, then GCE metadata.
  try {
    authClient = new GoogleAuth({ scopes: SCOPES });
    return authClient;
  } catch {
    authClient = null;
    return null;
  }
}

async function getAccessToken(): Promise<string | null> {
  const auth = getAuth();
  if (!auth) return null;
  try {
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    return token.token ?? null;
  } catch (err) {
    console.warn(
      `[gvision] no valid ADC / service-account credentials — skipping (${(err as Error).message})`,
    );
    return null;
  }
}
