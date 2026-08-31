import type { ChatHistoryItem, ChatModelFunctionCall, ChatModelFunctions } from "node-llama-cpp";
import type { ChatMessage, ChatRequest, ChatResponse, ModelInfo, ModelProvider, ToolCall } from "../types.js";
import { EMBEDDED_MODELS, type EmbeddedModelId } from "../models.js";

/**
 * Converts our provider-agnostic transcript into node-llama-cpp's
 * ChatHistoryItem[], folding each `tool` result message back onto the
 * ChatModelFunctionCall it answers (matched by tool_call_id) so the model
 * sees results the same way it saw the calls.
 */
export function toLlamaHistory(messages: ChatMessage[]): ChatHistoryItem[] {
  const history: ChatHistoryItem[] = [];
  const callsById = new Map<string, ChatModelFunctionCall>();

  for (const m of messages) {
    if (m.role === "system") {
      history.push({ type: "system", text: m.content });
    } else if (m.role === "user") {
      history.push({ type: "user", text: m.content });
    } else if (m.role === "assistant") {
      const response: Array<string | ChatModelFunctionCall> = [];
      if (m.content) response.push(m.content);
      for (const tc of m.tool_calls ?? []) {
        const call: ChatModelFunctionCall = {
          type: "functionCall",
          name: tc.name,
          params: tc.arguments,
          result: undefined,
        };
        callsById.set(tc.id, call);
        response.push(call);
      }
      history.push({ type: "model", response });
    } else if (m.role === "tool") {
      const call = m.tool_call_id ? callsById.get(m.tool_call_id) : undefined;
      if (call) call.result = m.content;
    }
  }

  return history;
}

/** Tool schemas only — node-llama-cpp grammar-constrains generation against these, no handlers attached. */
export function toLlamaFunctions(tools: ChatRequest["tools"]): ChatModelFunctions | undefined {
  if (!tools || tools.length === 0) return undefined;
  const fns: Record<string, { description?: string; params?: unknown }> = {};
  for (const t of tools) {
    fns[t.name] = { description: t.description, params: t.inputSchema };
  }
  return fns as ChatModelFunctions;
}

interface LlamaGenerateResult {
  response: string;
  functionCalls?: { functionName: string; params: unknown }[];
}

/** Scans for top-level {...} substrings, respecting string literals so braces inside strings don't throw off the depth count. */
function findJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && start !== -1) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function isToolCallShape(parsed: unknown): parsed is { name: string; arguments: Record<string, unknown> } {
  return (
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    typeof (parsed as any).name === "string" &&
    typeof (parsed as any).arguments === "object" &&
    (parsed as any).arguments !== null &&
    !Array.isArray((parsed as any).arguments)
  );
}

/**
 * Some GGUF quantizations (e.g. Qwen's own Qwen2.5-Coder-Instruct GGUFs) mis-flag
 * their <tool_call> control token as a regular token, so node-llama-cpp can't
 * grammar-constrain generation into it — the model falls back to free text that
 * still happens to be shaped like the call it wanted to make, sometimes with its
 * own explanatory prose before or after. Recover that here rather than treating
 * it as a final answer: find every top-level {...} object anywhere in the
 * response (unwrapping one optional markdown fence first) and return the last
 * one shaped like `{"name": string, "arguments": object}` — last, because a
 * trailing call is the model's actual next action, not an example it mentioned
 * in passing.
 */
function tryParseFallbackToolCall(response: string): { name: string; arguments: Record<string, unknown> } | null {
  const trimmed = response.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const searchText = fenced ? fenced[1]! : trimmed;

  const candidates = findJsonObjectCandidates(searchText);
  for (let i = candidates.length - 1; i >= 0; i--) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidates[i]!);
    } catch {
      continue;
    }
    if (isToolCallShape(parsed)) return parsed;
  }
  return null;
}

export function fromLlamaResult(result: LlamaGenerateResult): ChatResponse {
  if (result.functionCalls && result.functionCalls.length > 0) {
    const toolCalls: ToolCall[] = result.functionCalls.map((fc, i) => ({
      id: `call_${i}`,
      name: fc.functionName,
      arguments: (fc.params ?? {}) as Record<string, unknown>,
    }));
    return { turn: { type: "tool_calls", toolCalls, content: result.response || undefined }, raw: result };
  }

  const fallback = tryParseFallbackToolCall(result.response);
  if (fallback) {
    const toolCalls: ToolCall[] = [{ id: "call_0", name: fallback.name, arguments: fallback.arguments }];
    return { turn: { type: "tool_calls", toolCalls }, raw: result };
  }

  return { turn: { type: "final", content: result.response }, raw: result };
}

/**
 * Runs a GGUF model in-process via node-llama-cpp — no server, no other app.
 * Uses the low-level LlamaChat.generateResponse() rather than
 * LlamaChatSession: LlamaChatSession's `functions` carry handlers that the
 * library calls (and executes) internally mid-generation, which would let
 * tools run before PermissionEngine ever sees them. generateResponse()
 * instead grammar-constrains against schema-only functions and returns the
 * requested calls to us, so AgentSession's permission-check → execute →
 * append-result → repeat loop (Section 68 boundary) is unchanged from the
 * OpenAICompatibleProvider path.
 */
export class EmbeddedLlamaProvider implements ModelProvider {
  id = "embedded-llama";
  private chatPromise: Promise<import("node-llama-cpp").LlamaChat> | undefined;
  private model: import("node-llama-cpp").LlamaModel | undefined;
  private context: import("node-llama-cpp").LlamaContext | undefined;

  constructor(
    private opts: {
      size: EmbeddedModelId;
      onDownloadProgress?: (status: { totalSize: number; downloadedSize: number }) => void;
      /** Aborts an in-progress download — resolveModelFile rejects with an AbortError-shaped error when it fires. */
      signal?: AbortSignal;
    }
  ) {}

  private getChat(): Promise<import("node-llama-cpp").LlamaChat> {
    if (!this.chatPromise) this.chatPromise = this.loadChat();
    return this.chatPromise;
  }

  private async loadChat(): Promise<import("node-llama-cpp").LlamaChat> {
    const { getLlama, resolveModelFile, LlamaChat } = await import("node-llama-cpp");
    const modelPath = await resolveModelFile(EMBEDDED_MODELS[this.opts.size].uri, {
      cli: false,
      onProgress: this.opts.onDownloadProgress,
      signal: this.opts.signal,
    });
    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath });
    this.model = model;
    // contextSize defaults to "auto", which on a model with a large trained
    // context (e.g. this 7B model's 128K) can allocate a KV cache sized for
    // that whole window regardless of how much is actually used — measured
    // at ~2 tokens/sec even on a trivial prompt, consistent with the
    // resulting memory pressure, not anything about prompt size. Coding-agent
    // turns don't need anywhere near that; capping it keeps the KV cache
    // proportional to what a few files plus conversation history actually need.
    const context = await model.createContext({ contextSize: { max: 8192 } });
    this.context = context;
    const sequence = context.getSequence();
    return new LlamaChat({ contextSequence: sequence });
  }

  /** Frees the loaded model weights and KV cache/context. Safe to call even if loadChat() never ran or already failed. */
  async dispose(): Promise<void> {
    if (this.context && !this.context.disposed) await this.context.dispose();
    if (this.model && !this.model.disposed) await this.model.dispose();
  }

  async listModels(): Promise<ModelInfo[]> {
    return (Object.keys(EMBEDDED_MODELS) as EmbeddedModelId[]).map((size) => ({ id: size, local: true }));
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.getChat();
      return true;
    } catch {
      return false;
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const chat = await this.getChat();
    const history = toLlamaHistory(request.messages);
    const functions = toLlamaFunctions(request.tools);
    const result = await chat.generateResponse(history, {
      functions,
      documentFunctionParams: true,
      maxTokens: request.maxTokens ?? 2048,
    });
    return fromLlamaResult(result);
  }
}
