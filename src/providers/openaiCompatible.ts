import type { ChatRequest, ChatResponse, ModelInfo, ModelProvider, ToolCall } from "../types.js";

interface Options {
  baseUrl: string; // e.g. http://localhost:11434/v1 or http://localhost:1234/v1
  apiKey?: string; // most local servers ignore this
  local: boolean;
}

/**
 * Talks to any OpenAI-compatible /v1/chat/completions endpoint.
 * This is the adapter layer described in Section 51 — provider-specific
 * request/response shapes are normalized into the internal ToolCall/ChatResponse types here,
 * so nothing above this file needs to know which server is behind it.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  id = "openai-compatible";
  constructor(private opts: Options) {}

  private headers() {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.opts.apiKey) h["Authorization"] = `Bearer ${this.opts.apiKey}`;
    return h;
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${this.opts.baseUrl}/models`, { headers: this.headers() });
      if (!res.ok) return [];
      const data: any = await res.json();
      return (data.data ?? []).map((m: any) => ({ id: m.id, local: this.opts.local }));
    } catch {
      return [];
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.opts.baseUrl}/models`, { headers: this.headers() });
      return res.ok;
    } catch {
      return false;
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.name ? { name: m.name } : {}),
        ...(m.tool_calls
          ? {
              tool_calls: m.tool_calls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
              })),
            }
          : {}),
      })),
      max_tokens: request.maxTokens ?? 2048,
    };

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }

    const res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Provider error ${res.status}: ${text}`);
    }

    const data: any = await res.json();
    const choice = data.choices?.[0];
    const message = choice?.message ?? {};

    if (message.tool_calls && message.tool_calls.length > 0) {
      const toolCalls: ToolCall[] = message.tool_calls.map((tc: any, i: number) => {
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
