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
      proc.stdout.on("data", (d) => (stdout += d.toString()));
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      proc.on("close", (code) => {
        const truncated = stdout.length > MAX_OUTPUT || stderr.length > MAX_OUTPUT;
        const result: CommandResult = {
          command: input.command,
          exitCode: code,
          stdout: redactSecrets(stdout.slice(0, MAX_OUTPUT)),
          stderr: redactSecrets(stderr.slice(0, MAX_OUTPUT)),
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
