import { defaultToolRegistry } from "../toolRegistry.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

const fakeTool: Tool = {
  name: "mcp__github__ping",
  description: "[MCP: github] Replies with pong",
  permission: "DANGEROUS",
  inputSchema: { type: "object", properties: {} },
  async execute(): Promise<ToolResult> {
    return { ok: true, output: { content: "pong" } };
  },
};

console.log("defaultToolRegistry:");

const withoutExtras = defaultToolRegistry();
check("with no extraTools, only the 5 built-in tools are registered", withoutExtras.availableTools().length === 5);
check("with no extraTools, an unregistered tool name is undefined", withoutExtras.get("mcp__github__ping") === undefined);

const withExtras = defaultToolRegistry([fakeTool]);
check("with extraTools, the built-ins are still all present", withExtras.availableTools().length === 6);
check("with extraTools, the extra tool is retrievable by name", withExtras.get("mcp__github__ping") === fakeTool);
check("with extraTools, a built-in tool is still retrievable by name", withExtras.get("read_file") !== undefined);

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
