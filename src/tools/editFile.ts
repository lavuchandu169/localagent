import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool, ToolContext } from "../types.js";
import { isProtectedPath } from "../protected.js";
import { resolveWithinWorkspace } from "../workspacePath.js";

interface Input {
  path: string;
  content: string;
}

export const editFileTool: Tool<Input, { path: string; bytesWritten: number; created: boolean }> = {
  name: "edit_file",
  description:
    "Create or change a text file, in one of two ways. (1) content: the full new file — use for a new file, or when most of the file is changing. (2) old_string + new_string: replace one exact, unique block of an EXISTING file without rewriting the rest — old_string must match the file's current text exactly (including whitespace) and occur only once, unless replace_all is set. Always read the file first.",
  permission: "WRITE",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string", description: "Full file content. Omit this when using old_string/new_string instead." },
      old_string: { type: "string", description: "Exact text to find in the existing file, for a targeted edit. Must be unique unless replace_all is set." },
      new_string: { type: "string", description: "Text to replace old_string with." },
      replace_all: { type: "boolean", description: "Replace every occurrence of old_string instead of requiring exactly one match." },
    },
    required: ["path"],
  },
  async execute(input, ctx: ToolContext) {
    if (isProtectedPath(input.path)) {
      return { ok: false, output: null, error: `Refusing to write protected path: ${input.path}` };
    }
    const resolved = await resolveWithinWorkspace(ctx.workspaceRoot, input.path);
    if (!resolved.ok) {
      return { ok: false, output: null, error: resolved.error };
    }
    const abs = resolved.abs;
    // Final review Important #4, confirmed live: a symlink named "cfg"
    // pointing at .git/config bypassed the isProtectedPath check above
    // entirely (it only ever looked at the requested string "cfg", never
    // the resolved target) — the write then landed inside .git/config,
    // a planted core.pager/core.fsmonitor hook running on the next
    // auto-allowed "git status"/"git diff". Re-check against the
    // resolved, workspace-relative target too.
    const resolvedRoot = await resolveWithinWorkspace(ctx.workspaceRoot, ".");
    if (resolvedRoot.ok) {
      const resolvedRel = path.relative(resolvedRoot.abs, abs).split(path.sep).join("/");
      if (isProtectedPath(resolvedRel)) {
        return { ok: false, output: null, error: `Refusing to write protected path: ${input.path}` };
      }
    }
    let created = false;
    try {
      await fs.access(abs);
    } catch {
      created = true;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, input.content, "utf8");
    ctx.log(`${created ? "Created" : "Edited"} ${input.path}`);
    return { ok: true, output: { path: input.path, bytesWritten: Buffer.byteLength(input.content), created } };
  },
};
