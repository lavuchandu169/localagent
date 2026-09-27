import type { ChatRequest, ChatResponse, HealthCheckResult, ModelInfo, ModelProvider } from "../types.js";
import { ProviderChatError } from "../types.js";
import { buildChatBody } from "./openaiCompatible.js";

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
    const message = choice?.message ?? {};

    if (message.tool_calls && message.tool_calls.length > 0) {
      const toolCalls = message.tool_calls.map((tc: any, i: number) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function?.arguments ?? "{}");
        } catch {
          args = {};
        }
        return { id: tc.id ?? `call_${i}`, name: tc.function?.name ?? "unknown", arguments: args };
      });
      return { turn: { type: "tool_calls", toolCalls, content: message.content ?? undefined }, raw: data };
    }

    return { turn: { type: "final", content: message.content ?? "" }, raw: data };
  }
}
