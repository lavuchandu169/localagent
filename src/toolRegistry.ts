import type { Tool } from "./types.js";
import { readFileTool } from "./tools/readFile.js";
import { listDirectoryTool } from "./tools/listDirectory.js";
import { grepTool } from "./tools/grep.js";
import { editFileTool } from "./tools/editFile.js";
import { runCommandTool } from "./tools/runCommand.js";

export class ToolRegistry {
  private fixedTools = new Map<string, Tool>();

  /** Correctness audit finding (MCP Medium): extraTools used to be a plain
   * array, snapshotted into this registry once at construction time — an
   * MCP server disconnected or removed AFTER a session started stayed
   * fully callable (and one added later stayed invisible) for the rest of
   * that session's life, since nothing ever told an already-built registry
   * its tool list had changed. A live getter, re-called on every lookup
   * instead of read once, fixes that at the source: whatever owns the
   * closure (main.ts's mcpConnections list, in production) can add or
   * remove tools out from under an already-built registry, and the very
   * next call sees it — agent.ts already re-reads `tools.toSchema()` fresh
   * on every turn (never caches it), so this is the only piece that needed
   * to stop caching too. */
  constructor(
    fixedTools: Tool[],
    private getExtraTools: () => Tool[] = () => []
  ) {
    for (const t of fixedTools) this.fixedTools.set(t.name, t);
  }

  private merged(): Map<string, Tool> {
    const merged = new Map(this.fixedTools);
    for (const t of this.getExtraTools()) merged.set(t.name, t);
    return merged;
  }

  get(name: string): Tool | undefined {
    return this.fixedTools.get(name) ?? this.getExtraTools().find((t) => t.name === name);
  }

  availableTools(): Tool[] {
    return [...this.merged().values()];
  }

  toSchema() {
    return this.availableTools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }
}

export function defaultToolRegistry(getExtraTools: () => Tool[] = () => []): ToolRegistry {
  return new ToolRegistry([readFileTool, listDirectoryTool, grepTool, editFileTool, runCommandTool], getExtraTools);
}
