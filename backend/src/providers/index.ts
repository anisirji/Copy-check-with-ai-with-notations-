import { AnthropicProvider } from "./anthropic.provider.js";
import { GeminiProvider } from "./gemini.provider.js";
import { GroqProvider } from "./groq.provider.js";
import { OpenAIProvider } from "./openai.provider.js";
import {
  Capability,
  isProviderFatal,
  isTransient,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ProviderFamily,
  ProviderName,
} from "./types.js";

/**
 * The routes each pipeline stage uses. Order = priority. First configured &
 * healthy provider wins; on failure we walk the list.
 *
 * Design rules per COPY_CHECKING_ARCHITECTURE.md:
 *  - Vision extract wants bbox-native models first (Gemini > OpenAI > Claude > Groq).
 *  - Grader A wants the best rubric reasoner (Claude > Gemini > OpenAI > Groq).
 *  - Grader B wants a DIFFERENT family from A (enforced at call time).
 *  - Validator wants a critical reasoner (Claude > OpenAI > Gemini).
 *  - Rubric generation + model answer generation want the highest-quality
 *    reasoning (Claude > OpenAI > Gemini).
 */
export type Role =
  | "vision-primary"
  | "vision-second-opinion"
  | "grader-a"
  | "grader-b"
  | "validator"
  | "rubric-generation"
  | "model-answer"
  | "question-extraction";

const ROLE_PREFERENCES: Record<Role, ProviderName[]> = {
  "vision-primary": ["gemini", "openai", "anthropic", "groq"],
  "vision-second-opinion": ["anthropic", "openai", "gemini", "groq"],
  "grader-a": ["anthropic", "gemini", "openai", "groq"],
  "grader-b": ["openai", "anthropic", "gemini", "groq"], // family diversity enforced at runtime
  validator: ["anthropic", "openai", "gemini", "groq"],
  "rubric-generation": ["anthropic", "openai", "gemini", "groq"],
  "model-answer": ["anthropic", "openai", "gemini", "groq"],
  "question-extraction": ["anthropic", "gemini", "openai", "groq"],
};

const CAPABILITY_BY_ROLE: Record<Role, Capability> = {
  "vision-primary": "vision",
  "vision-second-opinion": "vision",
  "grader-a": "vision",
  "grader-b": "vision",
  validator: "text",
  "rubric-generation": "text",
  "model-answer": "text",
  "question-extraction": "vision",
};

export class ProviderRegistry {
  private byName: Map<ProviderName, LLMProvider>;

  constructor(providers: LLMProvider[]) {
    this.byName = new Map(providers.map((p) => [p.name, p]));
  }

  static default(): ProviderRegistry {
    return new ProviderRegistry([
      new GeminiProvider(),
      new AnthropicProvider(),
      new OpenAIProvider(),
      new GroqProvider(),
    ]);
  }

  configured(): { name: ProviderName; family: ProviderFamily }[] {
    return Array.from(this.byName.values())
      .filter((p) => p.isConfigured())
      .map((p) => ({ name: p.name, family: p.family }));
  }

  familyOf(name: ProviderName): ProviderFamily | undefined {
    return this.byName.get(name)?.family;
  }

  /**
   * Call the role's preferred cascade. `avoidFamily` enforces family diversity
   * (used for grader B: pass grader A's family to skip same-family providers).
   * `attemptsPerProvider` retries a specific provider on transient errors
   * before moving to the next one.
   */
  async call(
    role: Role,
    request: LLMRequest,
    opts: {
      avoidFamily?: ProviderFamily;
      attemptsPerProvider?: number;
      onAttempt?: (name: ProviderName, attempt: number) => void;
    } = {},
  ): Promise<LLMResponse> {
    const capability = CAPABILITY_BY_ROLE[role];
    const preferences = ROLE_PREFERENCES[role];
    const attemptsPerProvider = opts.attemptsPerProvider ?? 2;

    const candidates = preferences
      .map((name) => this.byName.get(name))
      .filter((p): p is LLMProvider => !!p && p.isConfigured())
      .filter((p) => p.capabilities.includes(capability))
      .filter((p) => (opts.avoidFamily ? p.family !== opts.avoidFamily : true));

    if (candidates.length === 0) {
      throw new Error(
        `No configured provider for role "${role}"${opts.avoidFamily ? ` avoiding family "${opts.avoidFamily}"` : ""}`,
      );
    }

    let lastErr: unknown;
    for (const provider of candidates) {
      for (let attempt = 1; attempt <= attemptsPerProvider; attempt++) {
        opts.onAttempt?.(provider.name, attempt);
        try {
          return await provider.generate(request);
        } catch (err) {
          lastErr = err;
          if (isProviderFatal(err)) break; // don't retry this provider — move on
          if (isTransient(err) && attempt < attemptsPerProvider) {
            await backoff(err, attempt);
            continue;
          }
          if (!isTransient(err)) break;
        }
      }
    }

    const status = (lastErr as { status?: number } | undefined)?.status;
    const msg = (lastErr as Error | undefined)?.message ?? "unknown";
    throw new Error(
      `All providers failed for role "${role}" — last error: ${status ? `[${status}] ` : ""}${msg}`,
    );
  }
}

async function backoff(err: unknown, attempt: number): Promise<void> {
  const details = (err as { errorDetails?: unknown[] }).errorDetails ?? [];
  const retryInfo = (details as { retryDelay?: string }[]).find(
    (d) => d.retryDelay,
  );
  const hintSeconds = retryInfo
    ? Number(retryInfo.retryDelay?.replace(/[^\d.]/g, ""))
    : NaN;
  const wait = Math.min(
    30_000,
    Number.isFinite(hintSeconds)
      ? hintSeconds * 1000 + 500
      : 1500 * 2 ** (attempt - 1),
  );
  await new Promise((r) => setTimeout(r, wait));
}
