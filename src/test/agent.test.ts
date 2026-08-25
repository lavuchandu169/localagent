import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PermissionEngine, classifyCommand } from "../permissions.js";
import { AgentSession } from "../agent.js";
import { defaultToolRegistry } from "../toolRegistry.js";
import { MockProvider } from "../providers/mockProvider.js";
import { toLlamaHistory, toLlamaFunctions, fromLlamaResult } from "../providers/embeddedLlama.js";
import type { ChatResponse, ToolCall } from "../types.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("Command risk classification:");
check("rm is DESTRUCTIVE", classifyCommand("rm -rf foo") === "DESTRUCTIVE");
check("git status is SAFE_READ", classifyCommand("git status") === "SAFE_READ");
check("npm install is NETWORK", classifyCommand("npm install left-pad") === "NETWORK");
check("unrecognized command is UNKNOWN", classifyCommand("some-custom-tool --flag") === "UNKNOWN");

console.log("\nPermission engine:");
{
  const engine = new PermissionEngine("PLAN");
  const call: ToolCall = { id: "1", name: "edit_file", arguments: {} };
  check("PLAN mode denies WRITE", engine.evaluate(call, "WRITE") === "DENY");
  check("PLAN mode allows READ", engine.evaluate({ ...call, name: "read_file" }, "READ") === "ALLOW");
}
{
  const engine = new PermissionEngine("DEFAULT");
  check("DEFAULT mode asks before WRITE", engine.evaluate({ id: "1", name: "edit_file", arguments: {} }, "WRITE") === "ASK");
  check(
    "DEFAULT mode asks before destructive command",
    engine.evaluate({ id: "2", name: "run_command", arguments: { command: "rm -rf /" } }, "EXECUTE") === "ASK"
  );
  check(
    "DEFAULT mode allows safe read command",
    engine.evaluate({ id: "3", name: "run_command", arguments: { command: "git status" } }, "EXECUTE") === "ALLOW"
  );
}
{
  const engine = new PermissionEngine("ACCEPT_EDITS");
  check("ACCEPT_EDITS allows WRITE", engine.evaluate({ id: "1", name: "edit_file", arguments: {} }, "WRITE") === "ALLOW");
  check(
    "ACCEPT_EDITS still asks before destructive command",
    engine.evaluate({ id: "2", name: "run_command", arguments: { command: "git reset --hard" } }, "EXECUTE") === "ASK"
  );
}

console.log("\nEmbedded llama provider conversion:");
{
  const history = toLlamaHistory([
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]);
  check(
    "toLlamaHistory converts plain system/user/assistant turns",
    JSON.stringify(history) ===
      JSON.stringify([
        { type: "system", text: "sys" },
        { type: "user", text: "hi" },
        { type: "model", response: ["hello"] },
      ])
  );
}
{
  const history = toLlamaHistory([
    { role: "user", content: "do it" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", name: "read_file", arguments: { path: "a.js" } }],
    },
    { role: "tool", tool_call_id: "c1", name: "read_file", content: "file contents" },
  ]);
  check(
    "toLlamaHistory folds a tool result into its function call's result field",
    JSON.stringify(history[1]) ===
      JSON.stringify({
        type: "model",
        response: [{ type: "functionCall", name: "read_file", params: { path: "a.js" }, result: "file contents" }],
      })
  );
}
{
  check("toLlamaFunctions returns undefined for no tools", toLlamaFunctions(undefined) === undefined);
  const fns = toLlamaFunctions([{ name: "read_file", description: "reads a file", inputSchema: { type: "object" } }]);
  check(
    "toLlamaFunctions maps tool schemas by name",
    JSON.stringify(fns) === JSON.stringify({ read_file: { description: "reads a file", params: { type: "object" } } })
  );
}
{
  const { turn } = fromLlamaResult({ response: "done", functionCalls: undefined });
  check("fromLlamaResult returns a final turn when there are no function calls", JSON.stringify(turn) === JSON.stringify({ type: "final", content: "done" }));
}
{
  const { turn } = fromLlamaResult({
    response: "",
    functionCalls: [{ functionName: "read_file", params: { path: "a.js" } }],
  });
  check(
    "fromLlamaResult returns a tool_calls turn with synthesized ids",
    JSON.stringify(turn) ===
      JSON.stringify({ type: "tool_calls", toolCalls: [{ id: "call_0", name: "read_file", arguments: { path: "a.js" } }] })
  );
}

console.log("\nAgent loop (scripted debug-fix scenario):");
{
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const workspaceRoot = path.resolve(__dirname, "..", "..", "fixture-repo");

  const script: ChatResponse[] = [
    { turn: { type: "tool_calls", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "math.js" } }] } },
    { turn: { type: "final", content: "Looks fine, no changes needed." } },
  ];

  const provider = new MockProvider(script);
  const session = new AgentSession({
    workspaceRoot,
    model: "mock",
    provider,
    tools: defaultToolRegistry(),
    permissionMode: "PLAN",
    onApprovalNeeded: async () => false,
  });

  let sawReadOk = false;
  let finished = false;
  let success = false;

  (async () => {
    for await (const event of session.run("Look at math.js")) {
      if (event.type === "tool.result" && event.call.name === "read_file") sawReadOk = event.result.ok;
      if (event.type === "done") {
        finished = true;
        success = event.success;
      }
    }
  })().then(() => {
    check("PLAN-mode session read the file successfully", sawReadOk);
    check("PLAN-mode session completed", finished && success);

    console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
  });
}
