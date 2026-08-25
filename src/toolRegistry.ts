import type { Tool } from "./types.js";
import { readFileTool } from "./tools/readFile.js";
import { listDirectoryTool } from "./tools/listDirectory.js";
import { grepTool } from "./tools/grep.js";
import { editFileTool } from "./tools/editFile.js";
import { runCommandTool } from "./tools/runCommand.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(tools: Tool[]) {
    for (const t of tools) this.tools.set(t.name, t);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  availableTools(): Tool[] {
    return [...this.tools.values()];
  }

  toSchema() {
    return this.availableTools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }
}

export function defaultToolRegistry(): ToolRegistry {
  return new ToolRegistry([readFileTool, listDirectoryTool, grepTool, editFileTool, runCommandTool]);
}
