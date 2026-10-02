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
  description: "Create or overwrite a text file with the given full content. Always read the file first if it exists.",
  permission: "WRITE",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
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
