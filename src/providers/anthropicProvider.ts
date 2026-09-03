import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, ChatRequest, ChatResponse, ModelInfo, ModelProvider, ToolCall } from "../types.js";
import { formatTextAttachment } from "../attachmentFormat.js";

const DEFAULT_MODEL_ID = "claude-sonnet-5";

/** The four image formats attachments.ts (Task 1) ever classifies as an image — the only ones Anthropic's base64 image source accepts. */
type AnthropicImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/**
 * Builds a user message's `content` — a plain string when there are no
 * attachments (unchanged from before this feature existed), or a
 * ContentBlockParam[] when there are: one image block per attached
 * image, then a single trailing text block combining the task text with
 * every attached text file, formatted the same way every provider folds
 * text attachments in (see openaiCompatible.ts and embeddedLlama.ts).
 * Omits the text block entirely for an attachment-only message with no
 * task text and no text attachments, rather than sending an empty one.
 */
function buildUserContent(m: ChatMessage): string | Anthropic.ContentBlockParam[] {
  if (!m.images?.length && !m.textAttachments?.length) return m.content;

  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const img of m.images ?? []) {
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType as AnthropicImageMediaType, data: img.dataBase64 },
    });
  }

  const textParts = [m.content, ...(m.textAttachments ?? []).map(formatTextAttachment)];
  const text = textParts.join("");
  if (text) blocks.push({ type: "text", text });

  return blocks;
}

/** Anthropic keeps the system prompt as a top-level request field, not a message with role "system". */
export function toAnthropicMessages(messages: ChatMessage[]): { system?: string; messages: Anthropic.MessageParam[] } {
  let system: string | undefined;
  const result: Anthropic.MessageParam[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      system = system ? `${system}\n${m.content}` : m.content;
    } else if (m.role === "user") {
      result.push({ role: "user", content: buildUserContent(m) });
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
  private model: string;

  constructor(opts?: { apiKey?: string; model?: string }) {
    this.client = new Anthropic({ apiKey: opts?.apiKey });
    this.model = opts?.model || DEFAULT_MODEL_ID;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: this.model, local: false }];
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.models.retrieve(this.model);
      return true;
    } catch {
      return false;
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { system, messages } = toAnthropicMessages(request.messages);
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens ?? 8192,
      system,
      messages,
      tools: toAnthropicTools(request.tools),
    });
    return fromAnthropicResponse(response);
  }
}
