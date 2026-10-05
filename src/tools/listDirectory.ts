import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool, ToolContext } from "../types.js";
import { resolveWithinWorkspace } from "../workspacePath.js";

const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "venv", ".venv", "target", "vendor"]);

interface Input {
  path?: string;
}

const MAX_ENTRIES = 500;

/**
 * Performance finding (code-review-and-quality pass): the final result was
 * always capped at MAX_ENTRIES (out.slice(0, 500) below), but the walk
 * itself had no cap at all — every subdirectory at every depth got its
 * own fs.readdir call regardless of how many entries were already
 * collected, wasting syscalls on results that only got thrown away by
 * the slice. Returns whether the cap was actually hit (checked BEFORE
 * each push, so out can never overshoot MAX_ENTRIES and the return value
 * distinguishes "ran out of budget" from "genuinely finished with fewer
 * than MAX_ENTRIES entries" — the latter must report truncated: false).
 */
async function walk(dir: string, root: string, depth: number, maxDepth: number, out: string[]): Promise<boolean> {
  if (depth > maxDepth) return false;
  if (out.length >= MAX_ENTRIES) return true;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    if (out.length >= MAX_ENTRIES) return true;
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs);
    out.push(e.isDirectory() ? `${rel}/` : rel);
    if (e.isDirectory()) {
      const childHitCap = await walk(abs, root, depth + 1, maxDepth, out);
      if (childHitCap) return true;
    }
  }
  return false;
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
    const resolvedRoot = await resolveWithinWorkspace(ctx.workspaceRoot, ".");
    if (!resolvedRoot.ok) {
      return { ok: false, output: null, error: resolvedRoot.error };
    }
    const resolved = await resolveWithinWorkspace(ctx.workspaceRoot, rel);
    if (!resolved.ok) {
      return { ok: false, output: null, error: resolved.error };
    }
    const out: string[] = [];
    try {
      // Entries stay relative to the WHOLE workspace root (not the listed
      // subdirectory) — matches this tool's existing behavior; only the
      // starting point and containment check change.
      const truncated = await walk(resolved.abs, resolvedRoot.abs, 0, 3, out);
      return { ok: true, output: { entries: out.slice(0, MAX_ENTRIES) }, truncated };
    } catch (err: any) {
      return { ok: false, output: null, error: err.message };
    }
  },
};
