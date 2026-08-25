import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Tool, ToolContext } from "../types.js";

interface Input {
  pattern: string;
  path?: string;
}

const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "venv", ".venv", "target", "vendor"]);

function tryRipgrep(pattern: string, cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("rg", ["--line-number", "--no-heading", "-m", "200", pattern, "."], { cwd });
    let out = "";
    let failed = false;
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("error", () => {
      failed = true;
      resolve(null);
    });
    proc.on("close", (code) => {
      if (failed) return;
      if (code === null || code > 1) resolve(null);
      else resolve(out);
    });
  });
}

async function jsFallbackGrep(pattern: string, root: string): Promise<string> {
  const re = new RegExp(pattern);
  const lines: string[] = [];
  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else {
        try {
          const content = await fs.readFile(abs, "utf8");
          content.split("\n").forEach((line, i) => {
            if (lines.length < 200 && re.test(line)) {
              lines.push(`${path.relative(root, abs)}:${i + 1}:${line}`);
            }
          });
        } catch {
          /* binary or unreadable, skip */
        }
      }
    }
  }
  await walk(root);
  return lines.join("\n");
}

export const grepTool: Tool<Input, { matches: string }> = {
  name: "grep",
  description: "Search file contents for a regex pattern within the workspace.",
  permission: "READ",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: { type: "string", description: "Subdirectory to restrict search to, default '.'" },
    },
    required: ["pattern"],
  },
  async execute(input, ctx: ToolContext) {
    const root = path.resolve(ctx.workspaceRoot, input.path ?? ".");
    let result = await tryRipgrep(input.pattern, root);
    if (result === null) {
      result = await jsFallbackGrep(input.pattern, root);
    }
    return { ok: true, output: { matches: result || "(no matches)" } };
  },
};
