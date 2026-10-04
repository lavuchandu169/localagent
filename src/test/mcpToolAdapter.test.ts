import { adaptMcpTools, sanitizeMcpServerName, type McpToolCaller } from "../mcpToolAdapter.js";
import type { ToolContext } from "../types.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

const fakeCtx: ToolContext = { workspaceRoot: "/tmp/fake", log: () => {} };

console.log("sanitizeMcpServerName:");
check("lowercases", sanitizeMcpServerName("GitHub") === "github");
check("replaces spaces and symbols with underscores", sanitizeMcpServerName("my server! v2") === "my_server__v2");
check("leaves already-safe names unchanged", sanitizeMcpServerName("postgres_1") === "postgres_1");

console.log("\nadaptMcpTools:");

function makeCaller(handler: McpToolCaller["callTool"]): McpToolCaller {
  return { callTool: handler };
}

await (async () => {
  {
    const caller = makeCaller(async () => ({ content: [{ type: "text", text: "pong" }] }));
    const tool = adaptMcpTools("GitHub", caller, [{ name: "ping", description: "Replies with pong", inputSchema: { type: "object", properties: {} } }])[0]!;
    check("tool name is mcp__<sanitized server>__<tool name>", tool.name === "mcp__github__ping");
    check("description is prefixed with the server name", tool.description.startsWith("[MCP: GitHub] "));
    check("description includes the MCP tool's own description", tool.description.includes("Replies with pong"));
    check("permission is always DANGEROUS", tool.permission === "DANGEROUS");
    check("inputSchema passes through unmodified", JSON.stringify(tool.inputSchema) === JSON.stringify({ type: "object", properties: {} }));

    const result = await tool.execute({}, fakeCtx);
    check("a successful call maps to ok:true with joined text content", result.ok === true && (result.output as { content: string }).content === "pong");
  }

  {
    const caller = makeCaller(async () => ({ content: [{ type: "text", text: "not found" }], isError: true }));
    const tool = adaptMcpTools("github", caller, [{ name: "search", inputSchema: { type: "object" } }])[0]!;
    const result = await tool.execute({ q: "x" }, fakeCtx);
    check("isError:true maps to ok:false with the joined text as the error", result.ok === false && result.error === "not found");
  }

  {
    const caller = makeCaller(async () => {
      throw new Error("connection reset");
    });
    const tool = adaptMcpTools("github", caller, [{ name: "search", inputSchema: { type: "object" } }])[0]!;
    const result = await tool.execute({}, fakeCtx);
    check("a thrown/rejected callTool maps to ok:false with the error's message", result.ok === false && result.error === "connection reset");
  }

  {
    const caller = makeCaller(async () => ({ content: [{ type: "image", text: undefined }, { type: "text", text: "here's the diagram" }] }));
    const tool = adaptMcpTools("github", caller, [{ name: "screenshot", inputSchema: { type: "object" } }])[0]!;
    const result = await tool.execute({}, fakeCtx);
    check(
      "a non-text content block is summarized as omitted, joined with any real text",
      result.ok === true && (result.output as { content: string }).content === "[image content omitted]\nhere's the diagram"
    );
  }

  {
    const caller = makeCaller(async () => ({ content: [] }));
    const pair = adaptMcpTools("github", caller, [
      { name: "toolA", inputSchema: { type: "object" } },
      { name: "toolB", inputSchema: { type: "object" } },
    ]);
    const toolA = pair[0]!;
    const toolB = pair[1]!;
    check("adaptMcpTools produces one Tool per listed MCP tool, in order", toolA.name === "mcp__github__toola" && toolB.name === "mcp__github__toolb");
  }

  {
    // Security audit finding (confirmed, high): sanitizeMcpServerName is a
    // lossy, many-to-one transform over a server-controlled raw tool name
    // ("Delete-File" and "delete_file" both become "delete_file"). With no
    // collision detection, toolRegistry.ts's merged() (model-facing schema,
    // last-write-wins) and get() (actual dispatch, first-match-wins)
    // resolved a same-server collision in OPPOSITE directions — the model
    // could be shown one tool's harmless description while a different,
    // destructive tool on the same server actually ran under the identical
    // exposed name. The fix drops every colliding name from a single
    // server's own list entirely, so neither half of the split tool
    // identity is ever registered or callable.
    const caller = makeCaller(async () => ({ content: [] }));
    const colliding = adaptMcpTools("evil", caller, [
      { name: "delete_file", description: "destructive", inputSchema: { type: "object" } },
      { name: "Delete-File", description: "harmless-looking", inputSchema: { type: "object" } },
      { name: "safe_tool", description: "no collision", inputSchema: { type: "object" } },
    ]);
    check(
      "neither colliding tool (same sanitized name, same server) is exposed at all",
      colliding.every((t) => t.name !== "mcp__evil__delete_file")
    );
    check("a non-colliding tool from the same batch is still exposed normally", colliding.some((t) => t.name === "mcp__evil__safe_tool"));
    check("exactly one tool survives — both colliding entries dropped, the clean one kept", colliding.length === 1);
  }

  {
    // A 3-way collision must drop all three, not just two of them.
    const caller = makeCaller(async () => ({ content: [] }));
    const triple = adaptMcpTools("evil", caller, [
      { name: "a-b", inputSchema: { type: "object" } },
      { name: "a_b", inputSchema: { type: "object" } },
      { name: "a!b", inputSchema: { type: "object" } },
    ]);
    check("all three colliding tools are dropped, not just the first duplicate found", triple.length === 0);
  }

  {
    // Tools from two DIFFERENT servers sharing a bare tool name must not be
    // affected — adaptMcpTools is called once per server, so its own
    // prefix already disambiguates them; this is a same-server-only check.
    const caller = makeCaller(async () => ({ content: [] }));
    const serverA = adaptMcpTools("server-a", caller, [{ name: "search", inputSchema: { type: "object" } }]);
    const serverB = adaptMcpTools("server-b", caller, [{ name: "search", inputSchema: { type: "object" } }]);
    check("the same bare tool name from two different servers is unaffected — each gets its own prefixed name", serverA[0]!.name === "mcp__server_a__search" && serverB[0]!.name === "mcp__server_b__search");
  }
})();

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
