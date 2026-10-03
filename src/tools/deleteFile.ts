import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool, ToolContext } from "../types.js";
import { isProtectedPath } from "../protected.js";
import { resolveWithinWorkspace } from "../workspacePath.js";

interface Input {
  path: string;
  /** Required (and must be explicitly true) to delete a directory and everything inside it — mirrors `rm` vs `rm -rf`: deleting a whole tree is a much bigger, harder-to-undo action than deleting one file, so it's never implied by omission. */
  recursive?: boolean;
}

export const deleteFileTool: Tool<Input, { path: string; deletedDirectory: boolean }> = {
  name: "delete_file",
  description:
    "Delete a file (or, with recursive: true, a whole directory) relative to the workspace root. Refuses to delete a directory unless recursive is explicitly true.",
  permission: "WRITE",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      recursive: { type: "boolean", description: "Required to delete a directory and its contents; ignored for a plain file." },
    },
    required: ["path"],
  },
  async execute(input, ctx: ToolContext) {
    if (isProtectedPath(input.path)) {
      return { ok: false, output: null, error: `Refusing to delete protected path: ${input.path}` };
    }
    const resolved = await resolveWithinWorkspace(ctx.workspaceRoot, input.path);
    if (!resolved.ok) {
      return { ok: false, output: null, error: resolved.error };
    }
    const abs = resolved.abs;
    // Same symlink-escape defense as edit_file/read_file (final review
    // Important #4): isProtectedPath above only ever saw the REQUESTED
    // string, never where a symlink actually resolves to — re-check
    // against the resolved, workspace-relative target too.
    const resolvedRoot = await resolveWithinWorkspace(ctx.workspaceRoot, ".");
    if (resolvedRoot.ok) {
      const resolvedRel = path.relative(resolvedRoot.abs, abs).split(path.sep).join("/");
      if (isProtectedPath(resolvedRel)) {
        return { ok: false, output: null, error: `Refusing to delete protected path: ${input.path}` };
      }
    }

    let stat;
    try {
      stat = await fs.lstat(abs);
    } catch (err: any) {
      return { ok: false, output: null, error: `Could not delete ${input.path}: ${err.message}` };
    }

    const isDirectory = stat.isDirectory();
    if (isDirectory && !input.recursive) {
      return {
        ok: false,
        output: null,
        error: `${input.path} is a directory — pass recursive: true to delete it and everything inside it, or name a specific file instead.`,
      };
    }

    try {
      await fs.rm(abs, { recursive: isDirectory, force: false });
    } catch (err: any) {
      return { ok: false, output: null, error: `Could not delete ${input.path}: ${err.message}` };
    }
    ctx.log(`Deleted ${input.path}`);
    return { ok: true, output: { path: input.path, deletedDirectory: isDirectory } };
  },
};
