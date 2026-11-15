import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import type { ToolCall, ToolResult } from "./types.js";

/**
 * Hooks: the user's own shell commands, run before or after the agent's
 * tool calls. A before_tool hook that exits non-zero blocks the call. An
 * after_tool hook's output goes back to the user and the model.
 *
 * The hook file is read from the user's home folder
 * (~/.localagent/hooks.json), never from the workspace: a hook is a
 * command that runs with no prompt, so a cloned repository must not be
 * able to supply one.
 */
export const MAX_HOOKS = 20;
const MAX_COMMAND_LENGTH = 2000;
const MAX_OUTPUT_CHARS = 2000;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface Hook {
  event: "before_tool" | "after_tool";
  /** A tool name, or "*" for every tool. */
  tool: string;
  command: string;
}

/**
 * Reads the hook file. A missing file means no hooks. Anything else that
 * cannot be fully understood throws: a hook can be a safety guard, and
 * dropping a guard because of a typo would be worse than stopping.
 */
export async function loadHooks(filePath: string | undefined): Promise<Hook[]> {
  if (!filePath) return [];
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw new Error(`Could not read hooks.json at ${filePath}: ${err?.message ?? err}`);
  }
  const problem = (detail: string) => new Error(`hooks.json at ${filePath} is not valid: ${detail}. Fix or delete the file.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (err: any) {
    throw problem(err?.message ?? "not JSON");
  }
  const list = (parsed as { hooks?: unknown } | null)?.hooks;
  if (!Array.isArray(list)) throw problem('it must be an object with a "hooks" list');
  if (list.length > MAX_HOOKS) throw problem(`it has more than ${MAX_HOOKS} hooks`);
  return list.map((item, i): Hook => {
    const where = `hook ${i + 1}`;
    if (!item || typeof item !== "object") throw problem(`${where} is not an object`);
    const { event, tool, command } = item as Record<string, unknown>;
    if (event !== "before_tool" && event !== "after_tool") throw problem(`${where} needs "event" to be "before_tool" or "after_tool"`);
    if (typeof tool !== "string" || !tool.trim()) throw problem(`${where} needs a "tool" name, or "*"`);
    if (typeof command !== "string" || !command.trim()) throw problem(`${where} needs a "command"`);
    if (command.length > MAX_COMMAND_LENGTH) throw problem(`${where} has a command longer than ${MAX_COMMAND_LENGTH} characters`);
    return { event, tool: tool.trim(), command: command.trim() };
  });
}

interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface HookOutcome {
  /** Zero exit, in time, not stopped. */
  ok: boolean;
  output: string;
  reason: "exit" | "timeout" | "stopped" | "spawn";
}

function shorten(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_OUTPUT_CHARS ? trimmed : `${trimmed.slice(0, MAX_OUTPUT_CHARS)} [... shortened]`;
}

function runHook(hook: Hook, payload: Record<string, unknown>, workspaceRoot: string, options: RunOptions): Promise<HookOutcome> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (outcome: HookOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const child = spawn(hook.command, {
      cwd: workspaceRoot,
      shell: true,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        LOCALAGENT_EVENT: hook.event,
        LOCALAGENT_TOOL: String(payload.tool),
        LOCALAGENT_WORKSPACE: workspaceRoot,
        // On Windows, cmd.exe looks in the current folder before PATH. The current
        // folder is the workspace, so a program planted there could run in place
        // of the one the hook names. This tells cmd.exe to skip the current folder.
        ...(process.platform === "win32" ? { NoDefaultCurrentDirectoryInExePath: "1" } : {}),
      },
    });
    const kill = () => {
      try {
        // The shell is its own process group on POSIX, so this reaches what it started too.
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
    const onAbort = () => {
      kill();
      finish({ ok: false, output: "The task was stopped while the hook was running.", reason: "stopped" });
    };
    const timer = setTimeout(() => {
      kill();
      finish({ ok: false, output: `The hook did not finish in time (${Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} s).`, reason: "timeout" });
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (options.signal?.aborted) return onAbort();
    options.signal?.addEventListener("abort", onAbort);

    const collect = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT_CHARS * 2) output += chunk.toString();
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (err) => finish({ ok: false, output: `The hook could not start: ${err.message}`, reason: "spawn" }));
    child.on("close", (code) => finish({ ok: code === 0, output: shorten(output) || (code === 0 ? "" : `The hook exited with code ${code}.`), reason: "exit" }));
    // A hook that does not read stdin must not break the run.
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(payload));
  });
}

function matching(hooks: Hook[], event: Hook["event"], toolName: string): Hook[] {
  return hooks.filter((h) => h.event === event && (h.tool === "*" || h.tool === toolName));
}

/** Runs the before_tool hooks for a call, in order. The first one that fails in any way blocks the call. */
export async function runBeforeHooks(hooks: Hook[], call: ToolCall, workspaceRoot: string, options: RunOptions = {}): Promise<{ blocked: false } | { blocked: true; message: string }> {
  for (const hook of matching(hooks, "before_tool", call.name)) {
    const outcome = await runHook(hook, { event: "before_tool", tool: call.name, arguments: call.arguments, workspace: workspaceRoot }, workspaceRoot, options);
    if (!outcome.ok) return { blocked: true, message: outcome.output };
  }
  return { blocked: false };
}

/** Runs the after_tool hooks for a finished call and returns what they printed. An after hook cannot undo the call. */
export async function runAfterHooks(hooks: Hook[], call: ToolCall, result: ToolResult, workspaceRoot: string, options: RunOptions = {}): Promise<string[]> {
  const notes: string[] = [];
  for (const hook of matching(hooks, "after_tool", call.name)) {
    const payload = { event: "after_tool", tool: call.name, arguments: call.arguments, workspace: workspaceRoot, result: { ok: result.ok, error: result.error ?? null } };
    const outcome = await runHook(hook, payload, workspaceRoot, options);
    if (outcome.output) notes.push(outcome.output);
  }
  return notes;
}
