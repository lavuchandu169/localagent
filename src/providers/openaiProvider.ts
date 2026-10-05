import type { ChatRequest, ChatResponse, HealthCheckResult, ModelInfo, ModelProvider, StreamEvent } from "../types.js";
import { buildChatBody, fromOpenAIChatMessage, streamOpenAIShapeResponse, postChatCompletions } from "./openaiCompatible.js";
import { wrapNonProviderError } from "./providerErrors.js";

const OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * Talks to the real OpenAI API. OpenAI's own request/response shape is
 * exactly what OpenAICompatibleProvider's buildChatBody already targets
 * (that file's shape is modeled on OpenAI's API in the first place), so
 * this reuses it rather than duplicating the conversion — this file only
 * adds the fixed base URL, Bearer auth, and ProviderChatError
 * classification on top.
 */
export class OpenAIProvider implements ModelProvider {
  id = "openai";
  private apiKey: string;
  private model: string;

  constructor(opts: { apiKey: string; model?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model || "gpt-5.5";
  }

  private headers(): Record<string, string> {
    return { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: this.model, local: false }];
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const res = await fetch(`${OPENAI_BASE_URL}/models`, { headers: this.headers() });
      if (!res.ok) return { ok: false, error: `Server responded ${res.status} ${res.statusText}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** buildChatBody's max_tokens is right for arbitrary self-hosted
   * OpenAI-COMPATIBLE servers (OpenAICompatibleProvider's own use of it),
   * but the real, hosted OpenAI API rejects max_tokens outright on its
   * current model line with a non-retryable 400 telling callers to use
   * max_completion_tokens instead — only this class talks to the real
   * API, so only here is the field renamed, leaving the shared
   * buildChatBody (and every custom-server caller) untouched. */
  private renameMaxTokens(body: Record<string, unknown>): void {
    if ("max_tokens" in body) {
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    try {
      const body = buildChatBody({ ...request, model: request.model || this.model });
      this.renameMaxTokens(body);
      const res = await postChatCompletions(OPENAI_BASE_URL, this.headers(), body);
      const data: any = await res.json();
      const choice = data.choices?.[0];
      return fromOpenAIChatMessage(choice?.message ?? {}, data);
    } catch (err) {
      // Correctness finding (code-review-and-quality pass): a failure in
      // fetch() itself (network down, DNS, TLS), not just a non-OK HTTP
      // response, used to propagate as a bare Error — invisible to
      // agent.ts's retryable-fallback check. See providerErrors.ts.
      wrapNonProviderError(err);
    }
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    try {
      const body = buildChatBody({ ...request, model: request.model || this.model });
      this.renameMaxTokens(body);
      body.stream = true;
      // Correctness audit finding (provider High #1): OpenAI's real API
      // only includes a usage field on a streamed chunk when this is set —
      // without it, chat() reports real cost but chatStream() silently
      // never does, even though it's the exact same billed request.
      body.stream_options = { include_usage: true };
      const res = await postChatCompletions(OPENAI_BASE_URL, this.headers(), body);
      yield* streamOpenAIShapeResponse(res);
    } catch (err) {
      wrapNonProviderError(err);
    }
  }
}
