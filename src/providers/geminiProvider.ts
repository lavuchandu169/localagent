import type { ChatMessage, ChatRequest, ChatResponse, HealthCheckResult, ModelInfo, ModelProvider, ToolCall } from "../types.js";
import { ProviderChatError } from "../types.js";
import { formatTextAttachment } from "../attachmentFormat.js";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

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
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name: m.name ?? "unknown", response: { content: m.content } } }],
      });
    }
  }

  return { systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined, contents };
}

export function toGeminiTools(tools: ChatRequest["tools"]): { functionDeclarations: object[] }[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })),
    },
  ];
}

/** A model response's parts can mix plain text with one or more functionCall parts — defensive by construction, the same posture buildChatBody/fromAnthropicResponse already take, since tool-call reliability varies by Gemini model tier the same way it does across any provider. */
export function fromGeminiResult(raw: any): ChatResponse {
  const parts: GeminiPart[] = raw?.candidates?.[0]?.content?.parts ?? [];
  const toolCalls: ToolCall[] = [];
  let text = "";

  parts.forEach((part, i) => {
    if (part.text) text += part.text;
    else if (part.functionCall) {
      toolCalls.push({ id: `call_${i}`, name: part.functionCall.name, arguments: part.functionCall.args ?? {} });
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
    this.model = opts.model || "gemini-2.5-flash";
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
