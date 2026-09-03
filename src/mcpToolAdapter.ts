import type { Tool, ToolContext, ToolResult } from "./types.js";

/** The narrow slice of the MCP SDK's Client this module actually needs — kept structural (not `import type { Client } from "@modelcontextprotocol/sdk/..."`) so a test fake can implement it trivially, same reasoning as this app's other injected-dependency interfaces (e.g. UpdateManagerDeps.openPath). */
export interface McpToolCaller {
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<{
    content: { type: string; text?: string }[];
    isError?: boolean;
  }>;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** Lowercases and replaces every character outside [a-z0-9_] with `_` — used to build each tool's mcp__<name>__<tool> prefix. Server names are already validated unique at save time (mcpSettings.ts's callers), so no collision handling is needed here. */
export function sanitizeMcpServerName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

function joinTextBlocks(content: { type: string; text?: string }[]): string {
  return content.map((block) => (block.type === "text" ? (block.text ?? "") : `[${block.type} content omitted]`)).join("\n");
}

/**
 * Wraps every tool listed by one connected MCP server into this app's Tool
 * interface. Every produced tool is permission: "DANGEROUS" — per
 * permissions.ts's evaluate(), that already means "always ASK, PLAN mode
 * denies outright" in every mode, with zero changes to the permission
 * engine — an MCP tool's real behavior isn't knowable in advance, so it
 * can't honestly claim any lighter permission tier.
 */
export function adaptMcpTools(serverName: string, caller: McpToolCaller, mcpTools: McpToolDescriptor[]): Tool[] {
  const prefix = sanitizeMcpServerName(serverName);
  return mcpTools.map((mcpTool) => ({
    name: `mcp__${prefix}__${sanitizeMcpServerName(mcpTool.name)}`,
    description: `[MCP: ${serverName}] ${mcpTool.description ?? mcpTool.name}`,
    permission: "DANGEROUS" as const,
    inputSchema: mcpTool.inputSchema,
    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      ctx.log(`[MCP] Calling ${mcpTool.name} on ${serverName}`);
      let result: { content: { type: string; text?: string }[]; isError?: boolean };
      try {
        result = await caller.callTool({ name: mcpTool.name, arguments: input });
      } catch (err) {
        return { ok: false, output: null, error: err instanceof Error ? err.message : String(err) };
      }
      const text = joinTextBlocks(result.content);
      if (result.isError) {
        return { ok: false, output: null, error: text || "MCP tool call failed with no error message." };
      }
      return { ok: true, output: { content: text } };
    },
  }));
}
