import type { ChatHistoryItem, ChatModelFunctionCall, ChatModelFunctions } from "node-llama-cpp";
import type { ChatMessage, ChatRequest, ChatResponse, ModelInfo, ModelProvider, ToolCall } from "../types.js";
import { EMBEDDED_MODELS, type EmbeddedModelSize } from "../models.js";

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

export function fromLlamaResult(result: LlamaGenerateResult): ChatResponse {
  if (result.functionCalls && result.functionCalls.length > 0) {
    const toolCalls: ToolCall[] = result.functionCalls.map((fc, i) => ({
      id: `call_${i}`,
      name: fc.functionName,
      arguments: (fc.params ?? {}) as Record<string, unknown>,
    }));
    return { turn: { type: "tool_calls", toolCalls, content: result.response || undefined }, raw: result };
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

  constructor(private opts: { size: EmbeddedModelSize }) {}

  private getChat(): Promise<import("node-llama-cpp").LlamaChat> {
    if (!this.chatPromise) this.chatPromise = this.loadChat();
    return this.chatPromise;
  }

  private async loadChat(): Promise<import("node-llama-cpp").LlamaChat> {
    const { getLlama, resolveModelFile, LlamaChat } = await import("node-llama-cpp");
    const modelPath = await resolveModelFile(EMBEDDED_MODELS[this.opts.size].uri);
    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath });
    const context = await model.createContext();
    const sequence = context.getSequence();
    return new LlamaChat({ contextSequence: sequence });
  }

  async listModels(): Promise<ModelInfo[]> {
    return (Object.keys(EMBEDDED_MODELS) as EmbeddedModelSize[]).map((size) => ({ id: size, local: true }));
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
    const result = await chat.generateResponse(history, { functions, maxTokens: request.maxTokens ?? 2048 });
    return fromLlamaResult(result);
  }
}
