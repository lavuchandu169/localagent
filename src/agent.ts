import fs from "node:fs/promises";
import path from "node:path";
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
import { extractFilenameCandidates } from "./filenameCandidates.js";
import { computeFileDiff } from "./diffUtil.js";

export interface AgentSessionOptions {
  workspaceRoot: string;
  model: string;
  provider: ModelProvider;
  tools: ToolRegistry;
  permissionMode: PermissionMode;
  maxTurns?: number;
  systemPrompt?: string;
  /** Seeds the conversation from a prior session's history instead of starting fresh with just the system prompt — used to resume a saved session. */
  initialMessages?: ChatMessage[];
  /** Called when a tool call needs ASK approval. Return true to allow. */
  onApprovalNeeded?: (call: ToolCall) => Promise<boolean>;
}

const DEFAULT_SYSTEM_PROMPT = `You are a careful autonomous coding agent operating on a local repository.
You have tools that read files directly from disk. If you need to see a file to
answer, call read_file (or list_directory / grep to find it first) instead of
asking the user for it. Use the exact filename mentioned in the task, not a
placeholder path — if you're not sure of the exact path, call list_directory
first rather than guessing one. If a tool call fails (e.g. file not found),
that's a signal to look again with list_directory or grep, not to give up and
ask the user to supply the path themselves.
Rules:
1. Gather evidence with read-only tools before modifying unfamiliar code, and before answering any question about what a specific file contains, does, or how it could be improved — read it first rather than describing what a typical file like that might contain.
2. Prefer targeted, minimal changes over rewrites.
3. Never claim a command ran or a test passed unless you actually invoked the tool and saw the result.
4. When you believe the task is complete and verified, respond with plain text (no further tool calls) summarizing what changed and how it was verified.
5. If you lack information required to proceed safely, say so instead of guessing.
6. For tasks that require understanding a whole project (summarizing, reviewing, documenting, or answering "what does this codebase do"), use list_directory and grep to build a complete picture and read every file that's actually relevant — don't stop after one or two files just because you have *an* answer, if the task implies covering the whole thing.`;

export class AgentSession {
  private messages: ChatMessage[] = [];
  private permissions: PermissionEngine;
  private turn = 0;
  private state: AgentState = "INITIALIZING";
  private cancelled = false;
  /** Paths read_file has been attempted on this session, success or not — evidence the model actually looked before writing. */
  private readPaths = new Set<string>();

  constructor(private opts: AgentSessionOptions) {
    this.permissions = new PermissionEngine(opts.permissionMode);
    if (opts.initialMessages && opts.initialMessages.length > 0) {
      this.messages = [...opts.initialMessages];
    } else {
      this.messages.push({ role: "system", content: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT });
    }
  }

  /** A copy of the current conversation history, safe to persist or inspect without risking mutation of the live session. */
  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  /**
   * Updates the workspace tools resolve paths against, in place — no
   * provider/model involved, so this is safe to call on a live session
   * between tasks (never call it mid-run() — the effect on a tool call
   * already in flight is undefined).
   */
  setWorkspaceRoot(workspaceRoot: string): void {
    this.opts.workspaceRoot = workspaceRoot;
  }

  /** Updates the permission policy in place — same in-place, between-tasks-only contract as setWorkspaceRoot. */
  setPermissionMode(mode: PermissionMode): void {
    this.permissions = new PermissionEngine(mode);
  }

  cancel() {
    this.cancelled = true;
  }

  /**
   * Computes a diff for an edit_file call to attach to its permission.request
   * event, so the UI can show a real diff instead of just a filename before
   * the user decides — computed here (before the tool ever runs), not inside
   * editFileTool itself, since the whole point is showing it BEFORE the write
   * happens. Reads the file fresh from disk rather than relying on an earlier
   * read_file result in the conversation, so the diff reflects the file's
   * actual current state even if it changed since the model last read it.
   * Returns undefined for anything that isn't a well-formed edit_file call
   * (including whenever the tool's own execute() would itself refuse it —
   * e.g. a path escaping the workspace root) — the permission-request event
   * just omits `diff` in that case, same as for every non-edit_file call.
   */
  private async computeEditDiffForCall(call: ToolCall) {
    if (call.name !== "edit_file") return undefined;
    const relPath = call.arguments.path;
    const newContent = call.arguments.content;
    if (typeof relPath !== "string" || typeof newContent !== "string") return undefined;
    const workspaceRoot = path.resolve(this.opts.workspaceRoot);
    const abs = path.resolve(workspaceRoot, relPath);
    if (!abs.startsWith(workspaceRoot)) return undefined;
    let oldContent: string | null;
    try {
      oldContent = await fs.readFile(abs, "utf8");
    } catch {
      oldContent = null; // doesn't exist yet — the whole new content shows as added
    }
    return computeFileDiff(oldContent, newContent);
  }

  getState(): AgentState {
    return this.state;
  }

  /**
   * Runtime-enforced grounding: a task naming a real file gets that file read
   * before the model's first turn, regardless of whether the model would have
   * chosen to call read_file itself. Prompt wording alone proved unreliable at
   * getting small/mid local models to read a named file before answering —
   * this makes it happen rather than asking nicely. A candidate that isn't a
   * real file at that path just fails read_file silently and is skipped.
   */
  private async *autoReadNamedFiles(task: string): AsyncGenerator<AgentEvent> {
    const tool = this.opts.tools.get("read_file");
    if (!tool) return;

    for (const relPath of extractFilenameCandidates(task)) {
      if (this.readPaths.has(relPath)) continue;

      const call: ToolCall = { id: `auto_${relPath}`, name: "read_file", arguments: { path: relPath } };
      const result = await tool.execute(call.arguments, {
        workspaceRoot: this.opts.workspaceRoot,
        log: () => {},
      });
      if (!result.ok) continue;

      this.readPaths.add(relPath);
      yield { type: "permission.request", call, decision: "ALLOW" };
      yield { type: "tool.start", call };
      yield { type: "tool.result", call, result };

      this.messages.push({ role: "assistant", content: "", tool_calls: [call] });
      this.messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: "read_file",
        content: JSON.stringify(result).slice(0, 6000),
      });
    }
  }

  async *run(task: string): AsyncGenerator<AgentEvent> {
    this.messages.push({ role: "user", content: task });
    this.state = "THINKING";
    yield* this.autoReadNamedFiles(task);
    const maxTurns = this.opts.maxTurns ?? 25;

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
      // Tool-call ids aren't guaranteed unique across turns (the embedded
      // provider mints them as call_0, call_1, ... reset per turn), so the
      // backfill below must only look at replies pushed for *this* turn —
      // scanning the whole history would treat a same-numbered id answered
      // in an earlier turn as already answering this turn's call too.
      const turnRepliesStart = this.messages.length;

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

        if (call.name === "read_file" && typeof call.arguments.path === "string") {
          this.readPaths.add(call.arguments.path);
        }

        let decision = this.permissions.evaluate(call, tool.permission);
        if (
          decision === "ALLOW" &&
          call.name === "edit_file" &&
          typeof call.arguments.path === "string" &&
          !this.readPaths.has(call.arguments.path)
        ) {
          // A model can fabricate a whole-file rewrite instead of grounding in the
          // real content — never let that auto-apply unreviewed, even in modes that
          // otherwise auto-allow writes.
          decision = "ASK";
        }
        const diff = await this.computeEditDiffForCall(call);
        yield diff ? { type: "permission.request", call, decision, diff } : { type: "permission.request", call, decision };

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

      // If cancellation broke the loop above before every tool call got a
      // reply, the assistant message already pushed for this turn still
      // references all of response.turn.toolCalls — an unanswered
      // tool_calls entry makes the persisted history invalid for a strict
      // provider (Anthropic rejects tool_use with no matching tool_result)
      // if this session is ever resumed. Backfill a synthetic reply for
      // anything left unanswered, looking only at this turn's own replies.
      const answeredCallIds = new Set(
        this.messages
          .slice(turnRepliesStart)
          .filter((m) => m.role === "tool" && m.tool_call_id)
          .map((m) => m.tool_call_id)
      );
      for (const call of response.turn.toolCalls) {
        if (answeredCallIds.has(call.id)) continue;
        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: JSON.stringify({ ok: false, error: "Cancelled before execution." }),
        });
      }

      this.turn++;
      this.state = "THINKING";
    }

    this.state = "CANCELLED";
    yield { type: "done", success: false, summary: "Cancelled by user." };
  }
}
