import type { ChatMessage, ChatRequest, ChatResponse, HealthCheckResult, ModelInfo, ModelProvider, StreamEvent, ToolCall } from "../types.js";
import { ProviderChatError } from "../types.js";
import { formatTextAttachment } from "../attachmentFormat.js";
import { parseSseLines } from "./sseLines.js";
import { wrapNonProviderError } from "./providerErrors.js";

/** Correctness audit finding (FreeLLMAPI Medium #4): an OpenAI-shape error
 * body is almost always JSON with a real, human-readable message buried
 * inside ({error:{message}} or, less commonly, a bare {message}) — before
 * this, the thrown ProviderChatError's message was the ENTIRE raw body
 * dumped verbatim, which is what actually reached the user on a task
 * failure. Falls back to the raw text untouched for a body that isn't
 * JSON, or JSON with no message field, so a malformed/unexpected error
 * shape is never a crash — the whole call is already behind .catch(() =>
 * "") at its one call site. */
export function formatErrorMessage(status: number, text: string): string {
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === "string" && message.length > 0) {
      return `Provider error ${status}: ${message}`;
    }
  } catch {
    // Not JSON — fall through to the raw text below.
  }
  return `Provider error ${status}: ${text}`;
}

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

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const res = await fetch(`${this.opts.baseUrl}/models`, { headers: this.headers() });
      if (!res.ok) return { ok: false, error: `Server responded ${res.status} ${res.statusText}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    try {
      const body = buildChatBody(request);

      const res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        // A typed ProviderChatError (not a bare Error) so callers like the
        // freellmapi free-tier router — which delegates all its real HTTP
        // work to this class, see providers/freellmapiProxy.ts — can trigger
        // agent.ts's fallback-to-cloud-provider path when the whole router
        // comes back rate-limit-exhausted. Matches the same retryable-iff-429
        // convention used by every other provider (openaiProvider.ts,
        // anthropicProvider.ts, geminiProvider.ts). A local server
        // (openai-compatible kind) never has fallbackProviders configured, so
        // this is a no-op behavior change for that existing caller.
        throw new ProviderChatError(formatErrorMessage(res.status, text), { status: res.status, retryable: res.status === 429 });
      }

      const data: any = await res.json();
      const choice = data.choices?.[0];
      return fromOpenAIChatMessage(choice?.message ?? {}, data);
    } catch (err) {
      // Performance/correctness finding (code-review-and-quality pass): the
      // `!res.ok` branch above is the only HTTP-shaped failure — a failure
      // in fetch() itself (network down, DNS, TLS) or in res.json() never
      // reached it and used to propagate as a bare Error, invisible to
      // agent.ts's retryable-fallback check. See providerErrors.ts.
      wrapNonProviderError(err);
    }
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    try {
      const body = buildChatBody(request);
      body.stream = true;

      const res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new ProviderChatError(formatErrorMessage(res.status, text), { status: res.status, retryable: res.status === 429 });
      }

      yield* streamOpenAIShapeResponse(res);
    } catch (err) {
      wrapNonProviderError(err);
    }
  }
}

/** Extracts real token usage from an OpenAI-shape response body, when it
 * carries one — correctness audit finding (provider High #1): this was
 * previously only ever populated for AnthropicProvider, so the renderer's
 * cost badge silently never appeared for OpenAI/OpenAI-compatible/
 * FreeLLMAPI sessions even though the real counts are sitting right in
 * the response already in hand, free to extract. Some OpenAI-compatible
 * local servers omit `usage` entirely — undefined in that case, not a
 * fabricated 0. */
function usageFromOpenAIResponse(raw: any): ChatResponse["usage"] {
  const usage = raw?.usage;
  if (!usage || typeof usage.prompt_tokens !== "number" || typeof usage.completion_tokens !== "number") return undefined;
  return { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens };
}

/** Converts one OpenAI/OpenAI-compatible chat-completion response message
 * into this app's ChatResponse — the exact parsing both OpenAIProvider and
 * OpenAICompatibleProvider's non-streaming chat() already did inline,
 * pulled out once so the new streaming accumulation path (Task 5) can
 * reuse it instead of a third copy. */
export function fromOpenAIChatMessage(message: any, raw: unknown): ChatResponse {
  const usage = usageFromOpenAIResponse(raw);
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
    return { turn: { type: "tool_calls", toolCalls, content: message.content ?? undefined }, raw, usage };
  }
  return { turn: { type: "final", content: message.content ?? "" }, raw, usage };
}

/** Drives an OpenAI-shape SSE chat-completions stream (shared by
 * OpenAIProvider and OpenAICompatibleProvider — both target the exact same
 * wire format) into StreamEvents, then the final ChatResponse via
 * fromOpenAIChatMessage. A tool call whose entire arguments string arrives
 * in a single chunk (confirmed for Ollama's own /v1 endpoint) is handled
 * by the exact same accumulation logic as one that arrives over many
 * fragments — "the whole string in one piece" is just that loop's
 * degenerate case, not a special branch. */
export async function* streamOpenAIShapeResponse(response: Response): AsyncGenerator<StreamEvent> {
  const toolCallIndexSeen = new Set<number>();
  const argumentsByIndex = new Map<number, string>();
  const nameByIndex = new Map<number, string>();
  const idByIndex = new Map<number, string>();
  let content = "";
  // Correctness audit finding (provider High #1): OpenAI only includes a
  // `usage` field on a chunk when the request set
  // `stream_options.include_usage: true` (see chatStream's own body
  // below), delivered on the LAST chunk alongside an empty delta — opts
  // in for the real OpenAI API, but read opportunistically here
  // regardless, so OpenAICompatibleProvider/FreeLLMAPI get it for free
  // too if their own upstream happens to forward it, with zero risk for
  // a server that doesn't (the field is just absent).
  let usage: ChatResponse["usage"];

  for await (const payload of parseSseLines(response)) {
    const chunk = JSON.parse(payload);

    // An in-band upstream error frame (observed live from the bundled
    // FreeLLMAPI proxy and from providers like Groq): a 200 SSE response
    // that streamed some real content, then emits {"error": {...}} mid-
    // stream because headers were already sent before the upstream
    // failed. Treating this as a successful "done" would report a task
    // as complete with silently truncated content.
    if (chunk.error && !chunk.choices) {
      const message = chunk.error?.message ?? "Provider returned an in-band stream error.";
      throw new ProviderChatError(message, { retryable: false });
    }

    const chunkUsage = usageFromOpenAIResponse(chunk);
    if (chunkUsage) usage = chunkUsage;

    const delta = chunk.choices?.[0]?.delta ?? {};

    if (typeof delta.content === "string" && delta.content.length > 0) {
      content += delta.content;
      yield { type: "text", text: delta.content };
    }

    for (const tc of delta.tool_calls ?? []) {
      const index = tc.index ?? 0;
      if (!toolCallIndexSeen.has(index)) {
        toolCallIndexSeen.add(index);
        const name = tc.function?.name ?? "unknown";
        nameByIndex.set(index, name);
        idByIndex.set(index, tc.id ?? `call_${index}`);
        argumentsByIndex.set(index, "");
        yield { type: "tool_call_start", index, name };
      }
      const argsFragment: string = tc.function?.arguments ?? "";
      if (argsFragment.length > 0) {
        argumentsByIndex.set(index, (argumentsByIndex.get(index) ?? "") + argsFragment);
        yield { type: "tool_call_delta", index, argumentsDelta: argsFragment };
      }
    }
  }

  if (toolCallIndexSeen.size > 0) {
    const toolCalls: ToolCall[] = [...toolCallIndexSeen]
      .sort((a, b) => a - b)
      .map((index) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(argumentsByIndex.get(index) || "{}");
        } catch {
          args = {};
        }
        return { id: idByIndex.get(index)!, name: nameByIndex.get(index)!, arguments: args };
      });
    yield { type: "done", response: { turn: { type: "tool_calls", toolCalls, content: content || undefined }, usage } };
  } else {
    yield { type: "done", response: { turn: { type: "final", content }, usage } };
  }
}
