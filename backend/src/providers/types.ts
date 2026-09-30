/**
 * LLM provider abstraction.
 *
 * Every LLM call in the system goes through this interface so we can:
 *  - Cascade across providers on failure (5xx / 429 / network)
 *  - Enforce family diversity (grader B must be a different family from A)
 *  - Swap providers per role without touching business logic
 *
 * Each provider is capability-tagged so the registry can pick a healthy
 * provider that supports the capability the call needs.
 */

export type ProviderFamily =
  | "google" // Gemini
  | "openai" // GPT-*
  | "anthropic" // Claude
  | "meta" // Llama via Groq
  | "deepseek";

export type ProviderName = "gemini" | "openai" | "anthropic" | "groq";

export type Capability = "vision" | "text" | "long-context";

export interface ImagePart {
  mimeType: string; // e.g. "image/png"
  base64: string;
}

export interface LLMRequest {
  /** free-form system-style instructions */
  system?: string;
  /** the main prompt text */
  prompt: string;
  /** optional page/crop images for VLM calls */
  images?: ImagePart[];
  /** temperature, 0..1, defaults to 0.2 for grading */
  temperature?: number;
  /** max output tokens */
  maxTokens?: number;
}

export interface LLMResponse {
  /** raw text response */
  text: string;
  /** which provider produced this response (for logging + audit) */
  provider: ProviderName;
  /** which model */
  model: string;
  /** input/output token usage if reported */
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface LLMProvider {
  name: ProviderName;
  family: ProviderFamily;
  capabilities: Capability[];
  /** true when API key / config is present */
  isConfigured(): boolean;
  /** single generation call */
  generate(request: LLMRequest): Promise<LLMResponse>;
}

/**
 * Signals to the cascade whether an error is worth retrying or moving on to
 * the next provider. Anything transient (429/500/503, timeouts) → retry.
 * 4xx like 400/401/403 → skip this provider, try next.
 */
export function isTransient(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

export function isProviderFatal(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 400 || status === 401 || status === 403 || status === 404;
}
