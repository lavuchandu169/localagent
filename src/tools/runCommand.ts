import { spawn, execFile, type ChildProcess } from "node:child_process";
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

/**
 * Confirmed live (CI hang, ~20 minutes, during the unbounded-accumulation
 * test's own real-world first run): a bare `proc.kill()` only signals the
 * DIRECT child. With `shell: true`, that direct child is the shell, not
 * the real command — on a shell that doesn't exec-optimize a single
 * trailing command away (dash on Ubuntu CI doesn't; some shells do, which
 * is why this looked fine testing locally on macOS first), the real
 * command keeps running as an orphaned grandchild that still holds the
 * stdout pipe open. Node's 'close' event — and this function's whole
 * returned Promise — then never fires at all, since it waits for that
 * pipe to actually close, not just for the direct child to exit. This is
 * also a LATENT problem for the pre-existing spawn `timeout` option's own
 * kill, not only the accumulation-cap kill added above — both go through
 * this same tree-aware kill now instead of a bare `.kill()`.
 *
 * `detached: true` (POSIX only — see the spawn call) puts the shell in
 * its own process group with itself as leader; every further descendant
 * it forks inherits that same group unless it explicitly changes it, so
 * signaling the negative pid reaches the whole tree. Windows has no such
 * concept — `taskkill /t` (kill the tree) is Node's own documented
 * recommendation there.
 */
function killProcessTree(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform === "win32") {
    // taskkill has no concept of signals — /f (force) is the only
    // escalation available, used identically whichever signal was asked
    // for; there is no softer "/t" without it.
    if (proc.pid !== undefined) execFile("taskkill", ["/pid", String(proc.pid), "/t", "/f"]);
    return;
  }
  try {
    if (proc.pid !== undefined) process.kill(-proc.pid, signal);
  } catch {
    // ESRCH (already gone) or some other edge case — fall back to the
    // direct child alone rather than leaving nothing signaled at all.
    proc.kill(signal);
  }
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
      // detached (POSIX only — see killProcessTree's doc comment) puts the
      // shell in its own process group so a tree-kill can reach every
      // descendant it forks, not just the shell itself.
      const proc =
        prepared.kind === "authenticated"
          ? spawn(prepared.argv[0]!, prepared.argv.slice(1), { cwd: ctx.workspaceRoot, env: { ...process.env, ...prepared.env }, detached: process.platform !== "win32" })
          : spawn(input.command, { cwd: ctx.workspaceRoot, shell: true, detached: process.platform !== "win32" });
      let stdout = "";
      let stderr = "";
      let settled = false;

      // Replaces spawn's own `timeout` option — confirmed live (see
      // killProcessTree's doc comment) that option's bare `.kill()` has
      // the identical tree-escape problem this whole function exists to
      // close, just on a different trigger (wall-clock instead of output
      // volume). escalateToKill below is shared between both triggers.
      const timeoutMs = input.timeoutMs ?? 30000;
      const wallClockTimer = setTimeout(() => escalateToKill(), timeoutMs);

      // SIGTERM first, SIGKILL only if the tree is still alive 2s later —
      // a command trapping/ignoring SIGTERM must not hang this forever.
      function escalateToKill() {
        if (settled) return;
        killProcessTree(proc);
        setTimeout(() => {
          if (!settled) killProcessTree(proc, "SIGKILL");
        }, 2000);
      }

      // Once either stream hits ACCUMULATION_CAP, further data is dropped
      // and the process is killed — there is no point letting a runaway
      // producer keep running when its output beyond the cap can never be
      // shown anyway, and killing it early avoids wasting the user's CPU
      // for the rest of the timeout window.
      let killedForOutputCap = false;
      const killIfOverCap = () => {
        if ((stdout.length >= ACCUMULATION_CAP || stderr.length >= ACCUMULATION_CAP) && !killedForOutputCap) {
          killedForOutputCap = true;
          escalateToKill();
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
        settled = true;
        clearTimeout(wallClockTimer);
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
        settled = true;
        clearTimeout(wallClockTimer);
        resolve({ ok: false, output: null, error: err.message });
      });
    });
  },
};
