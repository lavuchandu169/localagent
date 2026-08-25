import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool, ToolContext } from "../types.js";

const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "venv", ".venv", "target", "vendor"]);

interface Input {
  path?: string;
}

async function walk(dir: string, root: string, depth: number, maxDepth: number, out: string[]) {
  if (depth > maxDepth) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs);
    out.push(e.isDirectory() ? `${rel}/` : rel);
    if (e.isDirectory()) await walk(abs, root, depth + 1, maxDepth, out);
  }
}

export const listDirectoryTool: Tool<Input, { entries: string[] }> = {
  name: "list_directory",
  description: "List files and directories under a path (default: workspace root), skipping build/dependency dirs.",
  permission: "READ",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "Path relative to workspace root, default '.'" } },
  },
  async execute(input, ctx: ToolContext) {
    const rel = input.path ?? ".";
    const abs = path.resolve(ctx.workspaceRoot, rel);
    const out: string[] = [];
    try {
      await walk(abs, ctx.workspaceRoot, 0, 3, out);
      return { ok: true, output: { entries: out.slice(0, 500) }, truncated: out.length > 500 };
    } catch (err: any) {
      return { ok: false, output: null, error: err.message };
    }
  },
};
