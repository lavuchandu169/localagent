import { ProviderChatError } from "../types.js";

/**
 * Correctness finding (code-review-and-quality pass): only AnthropicProvider
 * wrapped its ENTIRE chat()/chatStream() body in a try/catch that converts
 * any non-ProviderChatError failure into one. Every other provider
 * (OpenAI, Gemini, and the shared OpenAICompatibleProvider that
 * FreeLLMAPI delegates to) only ever threw a ProviderChatError from their
 * own `if (!res.ok)` branch — a failure in fetch() ITSELF (network down,
 * DNS failure, TLS error, a client-side abort) or in `res.json()` never
 * reaches that branch at all, and propagated as a bare Error instead.
 * agent.ts's fallback-to-another-provider path checks
 * `err instanceof ProviderChatError && err.retryable` — a bare Error
 * never satisfies that, so a plain transient network blip against (say)
 * OpenAI hard-failed the whole task instead of falling back to a
 * configured second provider, exactly the case Anthropic already
 * handled correctly.
 *
 * Call this from each provider's own catch block, at the outermost
 * try/catch wrapping its real chat()/chatStream() work. Always
 * `retryable: false`: a real 429 is already classified `retryable: true`
 * by its own throw site before this ever runs, so anything reaching here
 * by definition wasn't one.
 */
export function wrapNonProviderError(err: unknown): never {
  if (err instanceof ProviderChatError) throw err;
  throw new ProviderChatError(err instanceof Error ? err.message : String(err), { retryable: false });
}
