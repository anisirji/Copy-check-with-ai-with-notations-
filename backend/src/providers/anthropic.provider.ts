import Anthropic from "@anthropic-ai/sdk";
import type {
  Capability,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ProviderFamily,
} from "./types.js";

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

/**
 * Anthropic provider. Used for the highest-quality reasoning roles:
 * rubric generation, model-answer generation, grader A, validator.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  readonly family: ProviderFamily = "anthropic";
  readonly capabilities: Capability[] = ["vision", "text", "long-context"];
  private client: Anthropic | null;

  constructor() {
    const key = process.env.ANTHROPIC_API_KEY;
    this.client = key ? new Anthropic({ apiKey: key }) : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    if (!this.client) throw new Error("Anthropic not configured");

    const content: Array<
      | {
          type: "image";
          source: {
            type: "base64";
            media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
            data: string;
          };
        }
      | { type: "text"; text: string }
    > = [];
    for (const img of request.images ?? []) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mimeType as
            | "image/png"
            | "image/jpeg"
            | "image/gif"
            | "image/webp",
          data: img.base64,
        },
      });
    }
    content.push({ type: "text", text: request.prompt });

    try {
      const resp = await this.client.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 0.2,
        system: request.system,
        messages: [{ role: "user", content }],
      });

      const text = resp.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      return {
        text,
        provider: this.name,
        model: DEFAULT_MODEL,
        usage: {
          inputTokens: resp.usage.input_tokens,
          outputTokens: resp.usage.output_tokens,
        },
      };
    } catch (err: unknown) {
      // Normalize SDK errors to have a `.status` field so cascade logic works.
      const e = err as { status?: number; message?: string };
      if (e.status === undefined && e.message?.includes("401")) e.status = 401;
      throw err;
    }
  }
}
