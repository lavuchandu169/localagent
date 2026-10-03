import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool, ToolContext } from "../types.js";
import { isProtectedPath, redactSecrets } from "../protected.js";
import { resolveWithinWorkspace } from "../workspacePath.js";

interface Input {
  path: string;
}

export const readFileTool: Tool<Input, { path: string; content: string }> = {
  name: "read_file",
  description: "Read the full contents of a text file relative to the workspace root.",
  permission: "READ",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "Path relative to workspace root" } },
    required: ["path"],
  },
  async execute(input, ctx: ToolContext) {
    const rel = input.path;
    if (isProtectedPath(rel)) {
      return { ok: false, output: null, error: `Refusing to read protected path: ${rel}` };
    }
    const resolved = await resolveWithinWorkspace(ctx.workspaceRoot, rel);
    if (!resolved.ok) {
      return { ok: false, output: null, error: resolved.error };
    }
    const abs = resolved.abs;
    // Final review Important #4, confirmed live: a symlink whose own NAME
    // ("cfg") looks innocent but RESOLVES inside .git (or any other
    // protected pattern) bypassed the check above entirely, since it only
    // ever looked at the requested string, never where the path actually
    // points. Re-check isProtectedPath against the resolved, workspace-
    // relative target too, normalized to forward slashes so the `.git/`
    // pattern still matches on Windows (path.relative there uses `\`).
    const resolvedRoot = await resolveWithinWorkspace(ctx.workspaceRoot, ".");
    if (resolvedRoot.ok) {
      const resolvedRel = path.relative(resolvedRoot.abs, abs).split(path.sep).join("/");
      if (isProtectedPath(resolvedRel)) {
        return { ok: false, output: null, error: `Refusing to read protected path: ${rel}` };
      }
    }
    try {
      const content = await fs.readFile(abs, "utf8");
      const MAX = 20000;
      const truncated = content.length > MAX;
      return {
        ok: true,
        output: { path: rel, content: redactSecrets(truncated ? content.slice(0, MAX) : content) },
        truncated,
      };
    } catch (err: any) {
      return { ok: false, output: null, error: `Could not read file: ${err.message}` };
    }
  },
};
