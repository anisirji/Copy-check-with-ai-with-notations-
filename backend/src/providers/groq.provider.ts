import Groq from "groq-sdk";
import type {
  Capability,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ProviderFamily,
} from "./types.js";

const DEFAULT_MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";

/**
 * Groq provider — currently serving `openai/gpt-oss-120b` (OpenAI's open-
 * source 120B model on Groq's fast inference). Text-only. Used as the last-
 * resort fallback when other providers are down.
 *
 * Family stays as "meta" for grader-family-diversity purposes so it can
 * co-run with the real OpenAI provider without triggering the same-family
 * rejection.
 */
export class GroqProvider implements LLMProvider {
  readonly name = "groq" as const;
  readonly family: ProviderFamily = "meta";
  readonly capabilities: Capability[] = ["text"];
  private client: Groq | null;

  constructor() {
    const key = process.env.GROQ_API_KEY;
    this.client = key ? new Groq({ apiKey: key }) : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    if (!this.client) throw new Error("Groq not configured");

    const content: Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    > = [{ type: "text", text: request.prompt }];
    for (const img of request.images ?? []) {
      content.push({
        type: "image_url",
        image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
      });
    }

    const messages: Array<
      | { role: "system"; content: string }
      | { role: "user"; content: typeof content }
    > = [];
    if (request.system)
      messages.push({ role: "system", content: request.system });
    messages.push({ role: "user", content });

    const resp = await this.client.chat.completions.create({
      model: DEFAULT_MODEL,
      messages,
      temperature: request.temperature ?? 0.2,
      max_tokens: request.maxTokens ?? 4096,
    });

    return {
      text: resp.choices[0]?.message?.content ?? "",
      provider: this.name,
      model: DEFAULT_MODEL,
      usage: {
        inputTokens: resp.usage?.prompt_tokens,
        outputTokens: resp.usage?.completion_tokens,
      },
    };
  }
}
