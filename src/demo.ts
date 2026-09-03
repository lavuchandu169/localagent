import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSession } from "./agent.js";
import { defaultToolRegistry } from "./toolRegistry.js";
import { MockProvider } from "./providers/mockProvider.js";
import type { ChatResponse } from "./types.js";

// This demo scripts a fake model so the harness (loop + tools + permissions)
// can be verified with zero network dependency and zero live LLM, mirroring
// the Phase 3-5 acceptance criteria: read -> run failing test -> edit -> rerun -> pass.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, "..", "fixture-repo");

const script: ChatResponse[] = [
  // Turn 1: read the source file
  { turn: { type: "tool_calls", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "math.js" } }] } },
  // Turn 2: run the (failing) test first, to observe the failure directly rather than assuming
  { turn: { type: "tool_calls", toolCalls: [{ id: "c2", name: "run_command", arguments: { command: "node math.test.js" } }] } },
  // Turn 3: fix the bug
  {
    turn: {
      type: "tool_calls",
      toolCalls: [
        {
          id: "c3",
          name: "edit_file",
          arguments: { path: "math.js", content: "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n" },
        },
      ],
    },
  },
  // Turn 4: rerun the test to verify
  { turn: { type: "tool_calls", toolCalls: [{ id: "c4", name: "run_command", arguments: { command: "node math.test.js" } }] } },
  // Turn 5: report completion
  {
    turn: {
      type: "final",
      content:
        "Fixed: add(a, b) was computing a - b instead of a + b in math.js. Verified by rerunning math.test.js, which now exits 0 and prints 'All tests passed'.",
    },
  },
];

async function main() {
  const provider = new MockProvider(script);
  const session = new AgentSession({
    workspaceRoot,
    model: "mock-model",
    provider,
    tools: defaultToolRegistry(),
    permissionMode: "ACCEPT_EDITS", // auto-allow safe edits so the scripted demo runs unattended
    onApprovalNeeded: async () => ({ approved: true }),
  });

  console.log(`\n[demo] workspace=${workspaceRoot} mode=ACCEPT_EDITS provider=mock\n`);
  console.log("Task: \"Fix the failing test in math.test.js\"\n");

  for await (const event of session.run("Fix the failing test in math.test.js")) {
    switch (event.type) {
      case "status":
        console.log(`… ${event.message}`);
        break;
      case "tool.start":
        console.log(`▶ ${event.call.name}(${JSON.stringify(event.call.arguments).slice(0, 120)})`);
        break;
      case "tool.result": {
        const out = event.result.output as any;
        const brief =
          event.call.name === "run_command"
            ? `exitCode=${out?.exitCode} stdout=${JSON.stringify(out?.stdout ?? "").slice(0, 80)}`
            : JSON.stringify(out).slice(0, 120);
        console.log(`  → ${event.result.ok ? "ok" : "FAIL"} ${brief}`);
        break;
      }
      case "permission.request":
        console.log(`  [permission] ${event.call.name} -> ${event.decision}`);
        break;
      case "text":
        console.log(`\n${event.text}\n`);
        break;
      case "error":
        console.error(`✗ ${event.message}`);
        break;
      case "done":
        console.log(`\n[demo done] success=${event.success}`);
        break;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
