import { spawn } from "node:child_process";
import type { Tool, ToolContext } from "../types.js";
import { redactSecrets } from "../protected.js";

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
    return new Promise((resolve) => {
      const proc = spawn(input.command, { cwd: ctx.workspaceRoot, shell: true, timeout: input.timeoutMs ?? 30000 });
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
