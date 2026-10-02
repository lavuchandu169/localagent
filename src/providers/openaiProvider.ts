import type { ChatRequest, ChatResponse, HealthCheckResult, ModelInfo, ModelProvider, StreamEvent } from "../types.js";
import { ProviderChatError } from "../types.js";
import { buildChatBody, fromOpenAIChatMessage, streamOpenAIShapeResponse } from "./openaiCompatible.js";

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

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body = buildChatBody({ ...request, model: request.model || this.model });
    // buildChatBody's max_tokens is right for arbitrary self-hosted
    // OpenAI-COMPATIBLE servers (OpenAICompatibleProvider's own use of it),
    // but the real, hosted OpenAI API rejects max_tokens outright on its
    // current model line with a non-retryable 400 telling callers to use
    // max_completion_tokens instead — only this class talks to the real
    // API, so only here is the field renamed, leaving the shared
    // buildChatBody (and every custom-server caller) untouched.
    if ("max_tokens" in body) {
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
    }

    const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderChatError(`OpenAI error ${res.status}: ${text}`, { status: res.status, retryable: res.status === 429 });
    }

    const data: any = await res.json();
    const choice = data.choices?.[0];
    return fromOpenAIChatMessage(choice?.message ?? {}, data);
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const body = buildChatBody({ ...request, model: request.model || this.model });
    if ("max_tokens" in body) {
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
    }
    body.stream = true;

    const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderChatError(`OpenAI error ${res.status}: ${text}`, { status: res.status, retryable: res.status === 429 });
    }

    yield* streamOpenAIShapeResponse(res);
  }
}
