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
import { createCheckpoint } from "./checkpoints.js";

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

export const DEFAULT_SYSTEM_PROMPT = `You are a careful autonomous coding agent operating on a local repository.
You have tools that read files directly from disk and write real changes to
them. If you need to see a file to answer, call read_file (or list_directory
/ grep to find it first) instead of asking the user for it. Use the exact
filename mentioned in the task, not a placeholder path — if you're not sure
of the exact path, call list_directory first rather than guessing one. If a
tool call fails (e.g. file not found), that's a signal to look again with
list_directory or grep, not to give up and ask the user to supply the path
themselves.

IMPORTANT — creating or changing a file means calling edit_file. It is never
done by describing the change in your reply:
Whenever the task asks you to create, write, build, design, fix, add,
implement, or scaffold anything — a file, a function, a component, a whole
project — the ONLY way to actually do that is to call edit_file, once per
file. Putting the code in your chat reply as a markdown code block instead
does NOT create or change anything; it is invisible to the user's real
files. A reply that describes files instead of writing them has not
completed the task, no matter how complete or correct the code in it looks.
  WRONG: replying with "Here's index.html:" followed by a \`\`\`html code
  block, then stopping — nothing was written, this is not done.
  RIGHT: calling edit_file with path="index.html" and the real file content
  (repeated for every other file the task needs), THEN, once every file is
  actually written, replying in plain text to summarize what you did.
Only put code directly in your plain-text reply when the user is asking a
question about code (e.g. "how would I..." or "explain this function") —
never when they've asked you to create or change something in this
workspace.

Rules:
1. Gather evidence with read-only tools before modifying unfamiliar code, and before answering any question about what a specific file contains, does, or how it could be improved — read it first rather than describing what a typical file like that might contain.
2. Prefer targeted, minimal changes over rewrites.
3. Never claim a command ran or a test passed unless you actually invoked the tool and saw the result.
4. When you believe the task is complete and verified, respond with plain text (no further tool calls) summarizing what changed and how it was verified.
5. If you lack information required to proceed safely, say so instead of guessing.
6. For tasks that require understanding a whole project (summarizing, reviewing, documenting, or answering "what does this codebase do"), use list_directory and grep to build a complete picture and read every file that's actually relevant — don't stop after one or two files just because you have *an* answer, if the task implies covering the whole thing.
7. When asked to create, write, build, design, or scaffold something, materialize it for real via edit_file — one call per file, never all of it crammed into a single call, and never left as code in your reply instead of a real tool call. See the IMPORTANT section above.`;

/** A rough "this task is asking for something to be built" signal — deliberately generous (false positives just cost one harmless extra nudge turn; false negatives bring back the exact bug this exists to catch), used only to gate the corrective nudge below. */
function taskImpliesCreation(task: string): boolean {
  return /\b(create|write|build|design|scaffold|make|generate|implement|add)\b/i.test(task);
}

/** Whether a response's text contains a real fenced code block (as opposed to a stray inline single backtick) — the tell-tale sign the model wrote out file content instead of calling edit_file. */
function containsFencedCode(content: string): boolean {
  return (content.match(/```/g)?.length ?? 0) >= 2;
}

export class AgentSession {
  private messages: ChatMessage[] = [];
  private permissions: PermissionEngine;
  private turn = 0;
  private state: AgentState = "INITIALIZING";
  private cancelled = false;
  /** Paths read_file has been attempted on this session, success or not — evidence the model actually looked before writing. */
  private readPaths = new Set<string>();
  /** The most recent task's checkpoint (see createCheckpoint) — one per task, not a deep undo stack. Overwritten the next time a task actually makes its first non-read tool call; a task that never writes anything leaves the previous task's checkpoint as the current "revert" target. */
  private checkpointHash: string | null = null;
  /** Whether THIS task has already attempted its one checkpoint — reset at the start of every run() call. Attempted, not "succeeded": a non-git workspace or any other createCheckpoint failure still marks this true so every subsequent write this task doesn't retry it. */
  private checkpointAttemptedThisTask = false;
  /** Whether THIS task has attempted (called, regardless of approval outcome) any WRITE-permission tool yet — reset at the start of every run() call. Feeds the corrective-nudge check below: if the model already tried to write and was denied, that's a real policy decision, not the "described code instead of writing it" failure the nudge exists to catch. */
  private wroteThisTask = false;
  /** Whether the one-shot corrective nudge (see the "final" branch in run()) has already fired this task — reset at the start of every run() call. At most one nudge per task, so a model that ignores it too doesn't loop forever. */
  private correctiveNudgeSentThisTask = false;

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

  /** The workspace a checkpoint hash (see getCheckpointHash) needs to be reverted against — reads the same live opts.workspaceRoot setWorkspaceRoot mutates, so this is never stale even after a mid-session workspace edit. */
  getWorkspaceRoot(): string {
    return this.opts.workspaceRoot;
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

  /** The current revert target, if any — the most recent task that actually wrote/executed something in a git workspace. Read by the caller (sessionRegistry) after each run(), not pushed as its own event stream, since it needs to survive independently of whatever events a specific run() happened to yield. */
  getCheckpointHash(): string | null {
    return this.checkpointHash;
  }

  async *run(task: string): AsyncGenerator<AgentEvent> {
    this.messages.push({ role: "user", content: task });
    this.state = "THINKING";
    this.checkpointAttemptedThisTask = false;
    this.wroteThisTask = false;
    this.correctiveNudgeSentThisTask = false;
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
        // Runtime-enforced correction, same principle as autoReadNamedFiles
        // above: prompt wording alone proved unreliable at stopping a small
        // local model from answering a "create/build/design X" task with
        // the code written out in prose instead of real edit_file calls
        // (verified live — the model repeated this exact failure even with
        // an explicit system-prompt rule against it). Fires at most once
        // per task, and only when the model never even tried to write —
        // if it tried and got denied, that's a real policy decision to
        // respect, not this failure mode.
        if (
          !this.correctiveNudgeSentThisTask &&
          !this.wroteThisTask &&
          taskImpliesCreation(task) &&
          containsFencedCode(response.turn.content)
        ) {
          this.correctiveNudgeSentThisTask = true;
          this.messages.push({ role: "assistant", content: response.turn.content });
          this.messages.push({
            role: "user",
            content:
              "You wrote file content in your reply but never called edit_file, so nothing was actually created or changed. " +
              "If you meant to create or modify files, call edit_file now for each one — one call per file, using the real content you just described. " +
              "If you were only explaining and didn't mean to produce real files, say that explicitly instead of including full file contents.",
          });
          yield { type: "status", message: "Turn produced code without writing it — nudging the model to call edit_file instead." };
          this.turn++;
          this.state = "THINKING";
          continue;
        }

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
        // Attempted, not "succeeded" — even a call that goes on to get
        // denied proves the model knows how to reach for edit_file, which
        // is exactly what the corrective nudge below needs to know it
        // doesn't need to fire.
        if (tool.permission === "WRITE") {
          this.wroteThisTask = true;
        }

        // One checkpoint per task, taken before the FIRST tool call this
        // task that isn't pure READ — regardless of what decision that call
        // ends up getting (ALLOW/ASK/DENY), same principle as the diff
        // above: capture proactively, before the outcome is known, so it's
        // already in place if the call (or a later one this same task)
        // does end up allowed. A task that only ever reads never takes one.
        if (!this.checkpointAttemptedThisTask && tool.permission !== "READ") {
          this.checkpointAttemptedThisTask = true;
          const hash = await createCheckpoint(this.opts.workspaceRoot);
          if (hash) {
            this.checkpointHash = hash;
            yield { type: "checkpoint.created", checkpointHash: hash };
          }
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
