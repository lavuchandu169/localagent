import { defaultToolRegistry } from "../../toolRegistry.js";
import type { Tool, ToolContext, ToolResult } from "../../types.js";

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
// 7 built-ins: read_file, list_directory, grep, edit_file, delete_file, run_command, fetch_url.
check("with no extraTools, only the 7 built-in tools are registered", withoutExtras.availableTools().length === 7);
check("with no extraTools, an unregistered tool name is undefined", withoutExtras.get("mcp__github__ping") === undefined);
check(
  "load_skill is deliberately never registered as a real callable tool (live-tested regression: a 3B model offered it as an always-available option called it proactively on an ordinary task and got derailed, parroting its fallback message as the whole answer instead of addressing the task) — it only exists as a narrow dispatch-level fallback for a model imitating the auto-injected pattern it just saw, never something to discover and choose",
  withoutExtras.get("load_skill") === undefined
);

const withExtras = defaultToolRegistry(() => [fakeTool]);
check("with extraTools, the built-ins are still all present", withExtras.availableTools().length === 8);
check("with extraTools, the extra tool is retrievable by name", withExtras.get("mcp__github__ping") === fakeTool);
check("with extraTools, a built-in tool is still retrievable by name", withExtras.get("read_file") !== undefined);

console.log("\ndefaultToolRegistry re-resolves its extra tools on every call (correctness audit: MCP Medium):");
{
  // Before this fix, extraTools was a plain array snapshotted once at
  // construction time — an MCP server disconnected or removed AFTER a
  // session started stayed fully callable for the rest of that session's
  // life, since nothing ever told the registry the underlying list had
  // changed. A live getter closure fixes that at the source: the registry
  // calls it fresh every time, so whatever owns the closure (main.ts's
  // mcpConnections list, in production) can add or remove tools out from
  // under an already-built registry.
  let liveTools: Tool[] = [fakeTool];
  const live = defaultToolRegistry(() => liveTools);
  check("starts with the extra tool visible", live.get("mcp__github__ping") === fakeTool);
  liveTools = [];
  check("removing it from the live source removes it from the registry too, with no reconstruction", live.get("mcp__github__ping") === undefined);
  check("availableTools() reflects the removal too", live.availableTools().length === 7);
  const secondTool: Tool = { ...fakeTool, name: "mcp__other__ping" };
  liveTools = [secondTool];
  check("a tool added later to the live source becomes visible without reconstructing the registry", live.get("mcp__other__ping") === secondTool);
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
