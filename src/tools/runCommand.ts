import { spawn } from "node:child_process";
import type { Tool, ToolContext } from "../types.js";
import { redactSecrets } from "../protected.js";
import { prepareGitPushCommand } from "../electron/githubPushAuth.js";

interface Input {
  command: string;
  timeoutMs?: number;
}

interface CommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}

const MAX_OUTPUT = 8000;
// Security audit finding: unbounded-stdout-stderr-accumulation. A
// fast-producing runaway command (cat /dev/zero, a recursive find/cat, an
// accidental infinite build loop) previously grew stdout/stderr without
// any limit until close() fired — the spawn `timeout` option bounds
// wall-clock duration only, not memory. A V8 string-length-ceiling
// RangeError thrown mid-accumulation is an uncaught exception that
// crashes the WHOLE app (main.ts's handler calls app.exit(1)
// unconditionally on any uncaught exception), not just this one call.
// Set far above MAX_OUTPUT (not equal to it) so the truncate-before-
// redact-order fix below still has enough real content to find a
// complete secret match — PEM keys, the longest pattern redactSecrets
// looks for, are realistically at most a few KB — this caps the worst
// case (a runaway producer), not the common one.
const ACCUMULATION_CAP = 1_000_000;

/** Appends `chunk` to `current`, never growing past ACCUMULATION_CAP — the
 * remainder of an over-cap chunk is dropped, not just future chunks, so a
 * single huge write can't bypass the cap in one shot. */
function appendCapped(current: string, chunk: string): string {
  if (current.length >= ACCUMULATION_CAP) return current;
  const remaining = ACCUMULATION_CAP - current.length;
  return current + (chunk.length > remaining ? chunk.slice(0, remaining) : chunk);
}

export const runCommandTool: Tool<Input, CommandResult> = {
  name: "run_command",
  description: "Run a shell command in the workspace root. Subject to permission approval.",
  permission: "EXECUTE",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeoutMs: { type: "number", description: "Optional timeout, default 30000ms" },
    },
    required: ["command"],
  },
  async execute(input, ctx: ToolContext) {
    const start = Date.now();
    const prepared = await prepareGitPushCommand(input.command, ctx.workspaceRoot, ctx.getGithubToken ?? (async () => null));
    if (prepared.kind === "blocked") {
      return { ok: false, output: null, error: prepared.reason };
    }
    return new Promise((resolve) => {
      // The authenticated case spawns git directly via its own argv, with
      // no shell at all — never a shell string built from this feature's
      // own quoting, which is what makes it work identically on Windows
      // (Node's shell:true would otherwise invoke cmd.exe, which doesn't
      // understand the POSIX single-quoting a shell-string version of this
      // rewrite would need) and closes off every other process in a
      // compound command ever seeing the injected token (there is no
      // shell metacharacter interpretation to exploit when there's no
      // shell in the first place — see isSimpleGitPushCommand's own gate).
      const proc =
        prepared.kind === "authenticated"
          ? spawn(prepared.argv[0]!, prepared.argv.slice(1), { cwd: ctx.workspaceRoot, timeout: input.timeoutMs ?? 30000, env: { ...process.env, ...prepared.env } })
          : spawn(input.command, { cwd: ctx.workspaceRoot, shell: true, timeout: input.timeoutMs ?? 30000 });
      let stdout = "";
      let stderr = "";
      // Once either stream hits ACCUMULATION_CAP, further data is dropped
      // and the process is killed — there is no point letting a runaway
      // producer keep running when its output beyond the cap can never be
      // shown anyway, and killing it early avoids wasting the user's CPU
      // for the rest of the timeout window.
      let killedForOutputCap = false;
      const killIfOverCap = () => {
        if ((stdout.length >= ACCUMULATION_CAP || stderr.length >= ACCUMULATION_CAP) && !killedForOutputCap) {
          killedForOutputCap = true;
          proc.kill();
        }
      };
      proc.stdout.on("data", (d) => {
        stdout = appendCapped(stdout, d.toString());
        killIfOverCap();
      });
      proc.stderr.on("data", (d) => {
        stderr = appendCapped(stderr, d.toString());
        killIfOverCap();
      });
      proc.on("close", (code) => {
        // Security audit finding: truncate-before-redact-order. Several
        // redactSecrets patterns require content beyond a minimum length
        // or a closing delimiter to match (the bare sk-/gho_/AIza
        // patterns need 20-30+ trailing characters; the PEM pattern needs
        // the full closing "-----END...PRIVATE KEY-----" marker) — if a
        // real secret straddled the MAX_OUTPUT boundary, slicing BEFORE
        // redacting left only an unmatchable partial fragment, which then
        // passed through completely unredacted. Redacting the full
        // accumulated output first, then slicing the (usually shorter,
        // since "[REDACTED]" replaces the matched secret) result for
        // display, means a secret is either fully redacted or fully
        // excluded by truncation — never partially exposed by it.
        const redactedStdout = redactSecrets(stdout);
        const redactedStderr = redactSecrets(stderr);
        const truncated = redactedStdout.length > MAX_OUTPUT || redactedStderr.length > MAX_OUTPUT;
        const result: CommandResult = {
          command: input.command,
          exitCode: code,
          stdout: redactedStdout.slice(0, MAX_OUTPUT),
          stderr: redactedStderr.slice(0, MAX_OUTPUT),
          durationMs: Date.now() - start,
          truncated,
        };
        resolve({ ok: code === 0, output: result, truncated });
      });
      proc.on("error", (err) => {
        resolve({ ok: false, output: null, error: err.message });
      });
    });
  },
};
