import crypto from "node:crypto";
import type { ChatMessage, ChatRequest, ChatResponse, HealthCheckResult, ModelInfo, ModelProvider, StreamEvent, ToolCall } from "../types.js";
import { ProviderChatError } from "../types.js";
import { formatTextAttachment } from "../attachmentFormat.js";
import { parseSseLines } from "./sseLines.js";
import { wrapNonProviderError } from "./providerErrors.js";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Correctness finding (code-review-and-quality pass): chat()/chatStream()'s
 * own `if (!res.ok)` branches both already knew a Gemini rate-limit can
 * arrive two ways — a real HTTP 429, or a 200-adjacent error body whose
 * own `error.status` field is the string "RESOURCE_EXHAUSTED" (seen on
 * some quota-exhausted responses) — and checked both. chatStream()'s
 * in-band SSE error branch below (an error chunk arriving mid-stream,
 * after a 200 response) hardcoded `retryable: false` instead, never
 * inspecting the chunk's own error.status at all: the exact same
 * RESOURCE_EXHAUSTED condition that correctly triggered agent.ts's
 * fallback-to-another-provider path via the non-streaming branch
 * incorrectly hard-failed the task when it happened to arrive in-stream.
 * One shared check for all three sites instead of two different inline
 * ones that happened to drift apart.
 */
function isGeminiRetryable(httpStatus: number | undefined, errorStatus: unknown): boolean {
  return httpStatus === 429 || errorStatus === "RESOURCE_EXHAUSTED";
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  inlineData?: { mimeType: string; data: string };
}
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/** Gemini keeps the system prompt as a top-level `systemInstruction` field, not a content turn with role "system" — same shape AnthropicProvider's toAnthropicMessages already handles for Anthropic's own system-field convention. */
export function toGeminiContents(messages: ChatMessage[]): { systemInstruction?: { parts: GeminiPart[] }; contents: GeminiContent[] } {
  let systemText: string | undefined;
  const contents: GeminiContent[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      systemText = systemText ? `${systemText}\n${m.content}` : m.content;
    } else if (m.role === "user") {
      const parts: GeminiPart[] = [];
      const textParts = [m.content, ...(m.textAttachments ?? []).map(formatTextAttachment)];
      const text = textParts.join("");
      if (text) parts.push({ text });
      for (const img of m.images ?? []) {
        parts.push({ inlineData: { mimeType: img.mediaType, data: img.dataBase64 } });
      }
      contents.push({ role: "user", parts });
    } else if (m.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.tool_calls ?? []) {
        parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
      }
      contents.push({ role: "model", parts });
    } else if (m.role === "tool") {
      // A model turn that calls several tools in parallel produces several
      // consecutive role:"tool" messages in the history. Gemini's API
      // requires every functionResponse answering ONE model turn to arrive
      // together in a single content entry — one content per call is a
      // real 400 ("number of function response parts should be equal to
      // number of function call parts"). The previous content is reused
      // (its parts array extended) whenever it's already the matching
      // user/functionResponse entry this tool result belongs with.
      const last = contents[contents.length - 1];
      const responsePart: GeminiPart = { functionResponse: { name: m.name ?? "unknown", response: { content: m.content } } };
      if (last && last.role === "user" && last.parts.every((p) => p.functionResponse)) {
        last.parts.push(responsePart);
      } else {
        contents.push({ role: "user", parts: [responsePart] });
      }
    }
  }

  return { systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined, contents };
}

// Gemini's function-calling API accepts only a restricted OpenAPI 3.0
// subset for `parameters`, not arbitrary JSON Schema — standard JSON
// Schema keywords real MCP server tool schemas commonly include ($schema,
// additionalProperties) are unknown fields to it and cause a hard 400,
// not a warning. Stripped recursively since either keyword can appear at
// any nesting level (a nested object property with its own
// additionalProperties: false, for instance).
const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set(["$schema", "additionalProperties"]);

function stripUnsupportedSchemaKeys(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripUnsupportedSchemaKeys);
  if (schema === null || typeof schema !== "object") return schema;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    result[key] = stripUnsupportedSchemaKeys(value);
  }
  return result;
}

export function toGeminiTools(tools: ChatRequest["tools"]): { functionDeclarations: object[] }[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: stripUnsupportedSchemaKeys(t.inputSchema) })),
    },
  ];
}

/** A model response's parts can mix plain text with one or more functionCall parts — defensive by construction, the same posture buildChatBody/fromAnthropicResponse already take, since tool-call reliability varies by Gemini model tier the same way it does across any provider. */
/** Correctness audit finding (provider High #1): previously only ever
 * populated for AnthropicProvider — Gemini's real usageMetadata is
 * sitting right in the response already in hand, free to extract. */
function usageFromGeminiResult(raw: any): ChatResponse["usage"] {
  const usageMetadata = raw?.usageMetadata;
  if (!usageMetadata || typeof usageMetadata.promptTokenCount !== "number" || typeof usageMetadata.candidatesTokenCount !== "number") {
    return undefined;
  }
  return { inputTokens: usageMetadata.promptTokenCount, outputTokens: usageMetadata.candidatesTokenCount };
}

export function fromGeminiResult(raw: any): ChatResponse {
  const parts: GeminiPart[] = raw?.candidates?.[0]?.content?.parts ?? [];
  const toolCalls: ToolCall[] = [];
  const usage = usageFromGeminiResult(raw);
  let text = "";

  parts.forEach((part) => {
    if (part.text) text += part.text;
    else if (part.functionCall) {
      // Gemini's API gives function calls no id of its own — this is
      // entirely synthetic. A plain per-response index (call_0, call_1, ...)
      // would repeat across separate turns, and after a mid-task fallback
      // from Gemini to another provider (e.g. Anthropic, whose tool_use ids
      // must be unique across the WHOLE conversation), a repeated id in the
      // carried-over history is a real 400 on the fallback provider, not
      // just a cosmetic collision. crypto.randomUUID() keeps every id
      // globally unique regardless of which turn or provider produced it.
      toolCalls.push({ id: `call_${crypto.randomUUID()}`, name: part.functionCall.name, arguments: part.functionCall.args ?? {} });
    }
  });

  if (toolCalls.length > 0) {
    return { turn: { type: "tool_calls", toolCalls, content: text || undefined }, raw, usage };
  }
  return { turn: { type: "final", content: text }, raw, usage };
}

/**
 * Talks to the real Gemini API. Opt-in, official-API BYOK only — same
 * posture as AnthropicProvider: the user supplies their own key, nothing
 * is embedded in the shipped app. Gemini's genuinely-free official tier
 * (2.5 Pro/Flash/Flash-Lite, no payment required, real daily quotas) is
 * what motivated adding this provider in the first place.
 */
export class GeminiProvider implements ModelProvider {
  id = "gemini";
  private apiKey: string;
  private model: string;

  constructor(opts: { apiKey: string; model?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model || "gemini-3.8-flash";
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: this.model, local: false }];
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const res = await fetch(`${GEMINI_BASE_URL}/models/${this.model}?key=${this.apiKey}`);
      if (!res.ok) return { ok: false, error: `Server responded ${res.status} ${res.statusText}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    try {
      const { systemInstruction, contents } = toGeminiContents(request.messages);
      const tools = toGeminiTools(request.tools);
      const body = {
        contents,
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(tools ? { tools } : {}),
      };

      const res = await fetch(`${GEMINI_BASE_URL}/models/${this.model}:generateContent?key=${this.apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data: any = await res.json().catch(() => ({}));
        const geminiStatus = data?.error?.status;
        throw new ProviderChatError(data?.error?.message ?? `Gemini error ${res.status}`, {
          status: res.status,
          retryable: isGeminiRetryable(res.status, geminiStatus),
        });
      }

      const data: any = await res.json();
      return fromGeminiResult(data);
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
      const { systemInstruction, contents } = toGeminiContents(request.messages);
      const tools = toGeminiTools(request.tools);
      const body = {
        contents,
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(tools ? { tools } : {}),
      };

      const res = await fetch(`${GEMINI_BASE_URL}/models/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data: any = await res.json().catch(() => ({}));
        const geminiStatus = data?.error?.status;
        throw new ProviderChatError(data?.error?.message ?? `Gemini error ${res.status}`, {
          status: res.status,
          retryable: isGeminiRetryable(res.status, geminiStatus),
        });
      }

      // Accumulated verbatim and handed to fromGeminiResult at the end,
      // rather than re-deriving ChatResponse here — the exact same converter
      // chat() uses, so any future change to it (e.g. preserving a
      // functionCall's thoughtSignature) automatically covers streaming too,
      // with no second copy of the parsing logic to keep in sync.
      const allParts: GeminiPart[] = [];
      // Correctness audit finding (provider High #1): Gemini sends
      // usageMetadata on (typically) the final chunk — captured here and
      // threaded into the synthetic raw object below, so fromGeminiResult's
      // own usage extraction (shared with chat()) picks it up automatically.
      let usageMetadata: unknown;
      for await (const payload of parseSseLines(res)) {
        const chunk = JSON.parse(payload);

        // An in-band error chunk (Gemini's SSE stream can emit one mid-stream
        // after a 200 response and real content already sent) — treating it
        // as a successful "done" would report a task as complete with
        // silently truncated content.
        if (chunk.error) {
          // Same error body shape as the non-streaming `!res.ok` branches
          // above ({error: {code, message, status}}) — code is Gemini's
          // own would-be-HTTP-status field for an in-band error, distinct
          // from this response's real (200) HTTP status.
          throw new ProviderChatError(chunk.error?.message ?? "Gemini returned an in-band stream error.", {
            retryable: isGeminiRetryable(chunk.error?.code, chunk.error?.status),
          });
        }

        if (chunk.usageMetadata) usageMetadata = chunk.usageMetadata;

        const parts: GeminiPart[] = chunk?.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          if (part.text) yield { type: "text", text: part.text };
          // functionCall parts arrive fully formed — see Global Constraints.
          // Not streamed as tool_call_start/tool_call_delta; folded straight
          // into the terminal done event below via fromGeminiResult, exactly
          // like a non-streaming response.
          allParts.push(part);
        }
      }

      yield { type: "done", response: fromGeminiResult({ candidates: [{ content: { parts: allParts } }], usageMetadata }) };
    } catch (err) {
      wrapNonProviderError(err);
    }
  }
}
