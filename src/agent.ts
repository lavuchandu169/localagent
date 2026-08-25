import type {
  AgentEvent,
  AgentState,
  ChatMessage,
  ModelProvider,
  PermissionMode,
  ToolCall,
} from "./types.js";
import { ToolRegistry } from "./toolRegistry.js";
import { PermissionEngine } from "./permissions.js";

export interface AgentSessionOptions {
  workspaceRoot: string;
  model: string;
  provider: ModelProvider;
  tools: ToolRegistry;
  permissionMode: PermissionMode;
  maxTurns?: number;
  systemPrompt?: string;
  /** Called when a tool call needs ASK approval. Return true to allow. */
  onApprovalNeeded?: (call: ToolCall) => Promise<boolean>;
}

const DEFAULT_SYSTEM_PROMPT = `You are a careful autonomous coding agent operating on a local repository.
Rules:
1. Gather evidence with read-only tools before modifying unfamiliar code.
2. Prefer targeted, minimal changes over rewrites.
3. Never claim a command ran or a test passed unless you actually invoked the tool and saw the result.
4. When you believe the task is complete and verified, respond with plain text (no further tool calls) summarizing what changed and how it was verified.
5. If you lack information required to proceed safely, say so instead of guessing.`;

export class AgentSession {
  private messages: ChatMessage[] = [];
  private permissions: PermissionEngine;
  private turn = 0;
  private state: AgentState = "INITIALIZING";
  private cancelled = false;

  constructor(private opts: AgentSessionOptions) {
    this.permissions = new PermissionEngine(opts.permissionMode);
    this.messages.push({ role: "system", content: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT });
  }

  cancel() {
    this.cancelled = true;
  }

  getState(): AgentState {
    return this.state;
  }

  async *run(task: string): AsyncGenerator<AgentEvent> {
    this.messages.push({ role: "user", content: task });
    this.state = "THINKING";
    const maxTurns = this.opts.maxTurns ?? 12;

    while (!this.cancelled) {
      if (this.turn >= maxTurns) {
        this.state = "FAILED";
        yield { type: "error", message: `Stopped: exceeded max turns (${maxTurns}).` };
        yield { type: "done", success: false, summary: "Turn budget exceeded." };
        return;
      }

      yield { type: "status", message: `Turn ${this.turn + 1}: thinking...` };

      let response;
      try {
        response = await this.opts.provider.chat({
          model: this.opts.model,
          messages: this.messages,
          tools: this.opts.tools.toSchema(),
        });
      } catch (err: any) {
        this.state = "FAILED";
        yield { type: "error", message: `Model provider error: ${err.message}` };
        yield { type: "done", success: false, summary: "Provider error." };
        return;
      }

      if (response.turn.type === "final") {
        this.messages.push({ role: "assistant", content: response.turn.content });
        yield { type: "text", text: response.turn.content };
        this.state = "COMPLETED";
        yield { type: "done", success: true, summary: response.turn.content };
        return;
      }

      // tool_calls branch
      this.messages.push({
        role: "assistant",
        content: response.turn.content ?? "",
        tool_calls: response.turn.toolCalls,
      });

      for (const call of response.turn.toolCalls) {
        if (this.cancelled) break;
        const tool = this.opts.tools.get(call.name);
        if (!tool) {
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.name,
            content: JSON.stringify({ ok: false, error: `Unknown tool: ${call.name}` }),
          });
          continue;
        }

        const decision = this.permissions.evaluate(call, tool.permission);
        yield { type: "permission.request", call, decision };

        if (decision === "DENY") {
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.name,
            content: JSON.stringify({ ok: false, error: "Permission denied by policy." }),
          });
          continue;
        }

        if (decision === "ASK") {
          const approved = this.opts.onApprovalNeeded ? await this.opts.onApprovalNeeded(call) : false;
          if (!approved) {
            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: call.name,
              content: JSON.stringify({ ok: false, error: "User rejected this action." }),
            });
            continue;
          }
        }

        this.state = "EXECUTING_TOOL";
        yield { type: "tool.start", call };
        const result = await tool.execute(call.arguments, {
          workspaceRoot: this.opts.workspaceRoot,
          log: (msg) => {
            /* forwarded via tool.result event below */
            void msg;
          },
        });
        yield { type: "tool.result", call, result };

        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: JSON.stringify(result).slice(0, 6000),
        });
      }

      this.turn++;
      this.state = "THINKING";
    }

    this.state = "CANCELLED";
    yield { type: "done", success: false, summary: "Cancelled by user." };
  }
}
