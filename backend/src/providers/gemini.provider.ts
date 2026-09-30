import { GoogleGenerativeAI } from "@google/generative-ai";
import type {
  Capability,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ProviderFamily,
} from "./types.js";

const DEFAULT_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.6-flash-lite";
const VISION_MODEL_OVERRIDE = process.env.GEMINI_VISION_MODEL;
const GRADER_MODEL_OVERRIDE = process.env.GEMINI_GRADER_MODEL;

/**
 * Gemini provider. Native bounding-box output (best-in-class for vision
 * extraction) plus text generation for grading fallback.
 */
export class GeminiProvider implements LLMProvider {
  readonly name = "gemini" as const;
  readonly family: ProviderFamily = "google";
  readonly capabilities: Capability[] = ["vision", "text", "long-context"];
  private client: GoogleGenerativeAI | null;

  constructor() {
    const key = process.env.GEMINI_API_KEY;
    this.client = key ? new GoogleGenerativeAI(key) : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    if (!this.client) throw new Error("Gemini not configured");
    const modelName = pickModel(request);
    const model = this.client.getGenerativeModel({ model: modelName });

    const parts: (
      | string
      | { inlineData: { mimeType: string; data: string } }
    )[] = [];
    if (request.system) parts.push(request.system + "\n\n");
    parts.push(request.prompt);
    for (const img of request.images ?? []) {
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
    }

    const result = await model.generateContent(parts);
    const usage = result.response.usageMetadata;
    return {
      text: result.response.text(),
      provider: this.name,
      model: modelName,
      usage: {
        inputTokens: usage?.promptTokenCount,
        outputTokens: usage?.candidatesTokenCount,
      },
    };
  }
}

function pickModel(request: LLMRequest): string {
  if ((request.images?.length ?? 0) > 0 && VISION_MODEL_OVERRIDE) {
    return VISION_MODEL_OVERRIDE;
  }
  if (GRADER_MODEL_OVERRIDE) return GRADER_MODEL_OVERRIDE;
  return DEFAULT_MODEL;
}
