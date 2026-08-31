import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, ChatRequest, ChatResponse, ModelInfo, ModelProvider, ToolCall } from "../types.js";

const MODEL_ID = "claude-sonnet-5";

/** Anthropic keeps the system prompt as a top-level request field, not a message with role "system". */
export function toAnthropicMessages(messages: ChatMessage[]): { system?: string; messages: Anthropic.MessageParam[] } {
  let system: string | undefined;
  const result: Anthropic.MessageParam[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      system = system ? `${system}\n${m.content}` : m.content;
    } else if (m.role === "user") {
      result.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      if (!m.tool_calls || m.tool_calls.length === 0) {
        result.push({ role: "assistant", content: m.content });
      } else {
        const content: Anthropic.ContentBlockParam[] = [];
        if (m.content) content.push({ type: "text", text: m.content });
        for (const tc of m.tool_calls) {
          content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
        }
        result.push({ role: "assistant", content });
      }
    } else if (m.role === "tool") {
      const block: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: m.tool_call_id ?? "",
        content: m.content,
      };
      // Anthropic wants all tool_results for one turn in a single user message —
      // merge into the previous one if it's still an in-progress tool_result group.
      const last = result[result.length - 1];
      const lastContent = last?.content;
      if (last?.role === "user" && Array.isArray(lastContent) && lastContent.every((b) => b.type === "tool_result")) {
        (lastContent as Anthropic.ToolResultBlockParam[]).push(block);
      } else {
        result.push({ role: "user", content: [block] });
      }
    }
  }

  return { system, messages: result };
}

export function toAnthropicTools(tools: ChatRequest["tools"]): Anthropic.Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

export function fromAnthropicResponse(response: Anthropic.Message): ChatResponse {
  const toolCalls: ToolCall[] = [];
  let text = "";

  for (const block of response.content) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_use") {
      toolCalls.push({ id: block.id, name: block.name, arguments: block.input as Record<string, unknown> });
    }
  }

  if (toolCalls.length > 0) {
    return { turn: { type: "tool_calls", toolCalls, content: text || undefined }, raw: response };
  }
  return { turn: { type: "final", content: text }, raw: response };
}

/**
 * Talks to the real Anthropic API (Claude Sonnet 5) — the one provider in this
 * app that isn't local. Opt-in only: nothing about the Embedded/External-server
 * paths changes, and this sends file contents and task context over the network
 * to Anthropic. Credentials resolve in this order: an explicit `opts.apiKey`
 * (see resolveAnthropicApiKey in main.ts — an ANTHROPIC_API_KEY env var, then
 * a key saved via the in-app Settings panel), or, if neither is set, the
 * Anthropic SDK/CLI's own fallback chain (ANTHROPIC_AUTH_TOKEN, an
 * `ant auth login` profile) — untouched, exactly as before this app had any
 * concept of its own Anthropic settings.
 */
export class AnthropicProvider implements ModelProvider {
  id = "anthropic";
  private client: Anthropic;

  constructor(opts?: { apiKey?: string }) {
    this.client = new Anthropic({ apiKey: opts?.apiKey });
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: MODEL_ID, local: false }];
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.models.retrieve(MODEL_ID);
      return true;
    } catch {
      return false;
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { system, messages } = toAnthropicMessages(request.messages);
    const response = await this.client.messages.create({
      model: MODEL_ID,
      max_tokens: request.maxTokens ?? 8192,
      system,
      messages,
      tools: toAnthropicTools(request.tools),
    });
    return fromAnthropicResponse(response);
  }
}
