import type { ChatMessage, ChatRequest, ChatResponse, ModelInfo, ModelProvider, ToolCall } from "../types.js";
import { formatTextAttachment } from "../attachmentFormat.js";

/**
 * Builds one message's `content` for the wire request — a plain string
 * when there are no attachments (unchanged from before this feature
 * existed), or a content-part array when there are: a leading text part
 * (task text plus every attached text file folded in, the same format
 * every provider uses), then one image_url part per attached image, sent
 * optimistically in the standard OpenAI vision format. Whether the
 * server/loaded model actually supports it is between it and the
 * request — an unsupported image surfaces as this provider's existing
 * `Provider error ${status}` path, nothing new needed for that.
 */
function buildMessageContent(m: ChatMessage): string | Array<Record<string, unknown>> {
  if (!m.images?.length && !m.textAttachments?.length) return m.content;

  const textParts = [m.content, ...(m.textAttachments ?? []).map(formatTextAttachment)];
  const text = textParts.join("");

  if (!m.images?.length) return text;

  const parts: Array<Record<string, unknown>> = [];
  if (text) parts.push({ type: "text", text });
  for (const img of m.images) {
    parts.push({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.dataBase64}` } });
  }
  return parts;
}

/** The request-body-building half of `chat()`, pulled out as its own pure, exported function so it's unit-testable without a real HTTP server — mirrors toAnthropicMessages/toLlamaHistory in the other two providers. */
export function buildChatBody(request: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map((m) => ({
      role: m.role,
      content: buildMessageContent(m),
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

  return body;
}

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
    const body = buildChatBody(request);

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
