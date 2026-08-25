import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool, ToolContext } from "../types.js";
import { isProtectedPath } from "../protected.js";

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
    const abs = path.resolve(ctx.workspaceRoot, input.path);
    if (!abs.startsWith(path.resolve(ctx.workspaceRoot))) {
      return { ok: false, output: null, error: "Path escapes workspace root." };
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
