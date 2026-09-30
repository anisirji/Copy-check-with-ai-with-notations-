import OpenAI from "openai";
import type {
  Capability,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ProviderFamily,
} from "./types.js";

const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o";

/**
 * OpenAI provider. Family-diverse from Google + Anthropic so it's the
 * default choice for grader B (independent grading) and vision fallback.
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = "openai" as const;
  readonly family: ProviderFamily = "openai";
  readonly capabilities: Capability[] = ["vision", "text", "long-context"];
  private client: OpenAI | null;

  constructor() {
    const key = process.env.OPENAI_API_KEY;
    this.client = key ? new OpenAI({ apiKey: key }) : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    if (!this.client) throw new Error("OpenAI not configured");

    const content: OpenAI.Chat.ChatCompletionContentPart[] = [
      { type: "text", text: request.prompt },
    ];
    for (const img of request.images ?? []) {
      content.push({
        type: "image_url",
        image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
      });
    }

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
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
