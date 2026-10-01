import crypto from "node:crypto";
import type { ChatMessage, ChatRequest, ChatResponse, HealthCheckResult, ModelInfo, ModelProvider, ToolCall } from "../types.js";
import { ProviderChatError } from "../types.js";
import { formatTextAttachment } from "../attachmentFormat.js";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  inlineData?: { mimeType: string; data: string };
  /** Sibling field to functionCall (not nested inside it), present on a
   * "thinking"-capable model like gemini-3.8-flash. Required on the first
   * functionCall part of a turn (and the first of each step in a
   * sequential-calls conversation) — a thinking model's API rejects a
   * replayed functionCall history part that omits it with a 400,
   * "Function call is missing a thought_signature in functionCall parts."
   * Verified against ai.google.dev/gemini-api/docs/generate-content/thought-signatures,
   * not guessed. */
  thoughtSignature?: string;
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
        parts.push({
          functionCall: { name: tc.name, args: tc.arguments },
          ...(tc.providerSignature ? { thoughtSignature: tc.providerSignature } : {}),
        });
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
export function fromGeminiResult(raw: any): ChatResponse {
  const parts: GeminiPart[] = raw?.candidates?.[0]?.content?.parts ?? [];
  const toolCalls: ToolCall[] = [];
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
      toolCalls.push({
        id: `call_${crypto.randomUUID()}`,
        name: part.functionCall.name,
        arguments: part.functionCall.args ?? {},
        ...(part.thoughtSignature ? { providerSignature: part.thoughtSignature } : {}),
      });
    }
  });

  if (toolCalls.length > 0) {
    return { turn: { type: "tool_calls", toolCalls, content: text || undefined }, raw };
  }
  return { turn: { type: "final", content: text }, raw };
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
        retryable: res.status === 429 || geminiStatus === "RESOURCE_EXHAUSTED",
      });
    }

    const data: any = await res.json();
    return fromGeminiResult(data);
  }
}
