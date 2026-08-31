import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { PermissionEngine, classifyCommand } from "../permissions.js";
import { AgentSession } from "../agent.js";
import { defaultToolRegistry, ToolRegistry } from "../toolRegistry.js";
import { MockProvider } from "../providers/mockProvider.js";
import { toLlamaHistory, toLlamaFunctions, fromLlamaResult } from "../providers/embeddedLlama.js";
import type { AgentEvent, ChatResponse, Tool, ToolCall } from "../types.js";

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
{
  // Some GGUF quantizations mis-flag their <tool_call> control token (node-llama-cpp
  // can't grammar-constrain into a token it doesn't recognize as special), so the
  // model falls back to free text that still happens to be shaped like a call.
  const { turn } = fromLlamaResult({
    response: '```json\n{\n  "name": "list_directory",\n  "arguments": {\n    "path": "."\n  }\n}\n```',
    functionCalls: undefined,
  });
  check(
    "fromLlamaResult recovers a tool call from a fenced JSON-only response",
    JSON.stringify(turn) ===
      JSON.stringify({ type: "tool_calls", toolCalls: [{ id: "call_0", name: "list_directory", arguments: { path: "." } }] })
  );
}
{
  const { turn } = fromLlamaResult({ response: '{"name": "read_file", "arguments": {"path": "a.js"}}', functionCalls: undefined });
  check(
    "fromLlamaResult recovers a tool call from a bare JSON-only response",
    JSON.stringify(turn) ===
      JSON.stringify({ type: "tool_calls", toolCalls: [{ id: "call_0", name: "read_file", arguments: { path: "a.js" } }] })
  );
}
{
  const { turn } = fromLlamaResult({ response: "I don't have information about that.", functionCalls: undefined });
  check("fromLlamaResult leaves ordinary prose as a final turn", turn.type === "final" && turn.content === "I don't have information about that.");
}
{
  const { turn } = fromLlamaResult({ response: '{"foo": "bar"}', functionCalls: undefined });
  check(
    "fromLlamaResult leaves JSON that isn't shaped like a call as a final turn",
    turn.type === "final" && turn.content === '{"foo": "bar"}'
  );
}
{
  const { turn } = fromLlamaResult({
    response: 'I\'ll check the project structure first.\n\n{"name": "list_directory", "arguments": {"path": "."}}',
    functionCalls: undefined,
  });
  check(
    "fromLlamaResult recovers a tool call preceded by explanatory prose",
    JSON.stringify(turn) ===
      JSON.stringify({ type: "tool_calls", toolCalls: [{ id: "call_0", name: "list_directory", arguments: { path: "." } }] })
  );
}
{
  const { turn } = fromLlamaResult({
    response: 'Let me look at that file.\n\n```json\n{"name": "read_file", "arguments": {"path": "a.js"}}\n```\n\nOne moment.',
    functionCalls: undefined,
  });
  check(
    "fromLlamaResult recovers a fenced tool call surrounded by prose on both sides",
    JSON.stringify(turn) ===
      JSON.stringify({ type: "tool_calls", toolCalls: [{ id: "call_0", name: "read_file", arguments: { path: "a.js" } }] })
  );
}
{
  const { turn } = fromLlamaResult({
    response: 'The schema for a call looks roughly like {"example": true} in general.',
    functionCalls: undefined,
  });
  check(
    "fromLlamaResult still leaves prose with an unrelated JSON-looking fragment as a final turn",
    turn.type === "final"
  );
}

console.log("\nAuto-read named files before the first turn:");
await (async () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const workspaceRoot = path.resolve(__dirname, "..", "..", "fixture-repo");

  {
    const script: ChatResponse[] = [{ turn: { type: "final", content: "It adds two numbers." } }];
    const session = new AgentSession({
      workspaceRoot,
      model: "mock",
      provider: new MockProvider(script),
      tools: defaultToolRegistry(),
      permissionMode: "PLAN",
    });

    const events: string[] = [];
    let readCall: ToolCall | undefined;
    for await (const event of session.run("what does math.js do")) {
      events.push(event.type);
      if (event.type === "tool.start" && event.call.name === "read_file") readCall = event.call;
    }

    check(
      "a task naming a real file auto-reads it before the model's first turn",
      readCall?.arguments.path === "math.js" && events.indexOf("tool.start") < events.indexOf("status")
    );
  }

  {
    const script: ChatResponse[] = [{ turn: { type: "final", content: "No such file here." } }];
    const session = new AgentSession({
      workspaceRoot,
      model: "mock",
      provider: new MockProvider(script),
      tools: defaultToolRegistry(),
      permissionMode: "PLAN",
    });

    let sawToolStart = false;
    for await (const event of session.run("what does nonexistent.py do")) {
      if (event.type === "tool.start") sawToolStart = true;
    }

    check("a task naming a file that doesn't exist triggers no auto-read (silently skipped)", !sawToolStart);
  }
})();

console.log("\nResumable message history:");
await (async () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const workspaceRoot = path.resolve(__dirname, "..", "..", "fixture-repo");

  const seeded: import("../types.js").ChatMessage[] = [
    { role: "system", content: "custom system prompt from a prior session" },
    { role: "user", content: "earlier task" },
    { role: "assistant", content: "earlier response" },
  ];

  const script: ChatResponse[] = [{ turn: { type: "final", content: "new answer" } }];
  const session = new AgentSession({
    workspaceRoot,
    model: "mock",
    provider: new MockProvider(script),
    tools: defaultToolRegistry(),
    permissionMode: "PLAN",
    initialMessages: seeded,
  });

  check(
    "getMessages returns the seeded initial messages before any run",
    JSON.stringify(session.getMessages()) === JSON.stringify(seeded)
  );

  const before = session.getMessages();
  for await (const _event of session.run("new task")) {
    // drain
  }
  const after = session.getMessages();

  check("getMessages grows from the seeded history, not from scratch", after.length > seeded.length);
  check(
    "the seeded turns are preserved in order at the start of the history",
    JSON.stringify(after.slice(0, seeded.length)) === JSON.stringify(seeded)
  );
  check("getMessages returns a copy, not the live array", before !== session.getMessages());

  const freshSession = new AgentSession({
    workspaceRoot,
    model: "mock",
    provider: new MockProvider([{ turn: { type: "final", content: "x" } }]),
    tools: defaultToolRegistry(),
    permissionMode: "PLAN",
  });
  check(
    "without initialMessages, a session still starts with just the system prompt",
    freshSession.getMessages().length === 1 && freshSession.getMessages()[0]?.role === "system"
  );
})();

console.log("\nMid-turn cancellation backfill doesn't over-scope to earlier turns:");
await (async () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const workspaceRoot = path.resolve(__dirname, "..", "..", "fixture-repo");

  let session: AgentSession;
  const cancelTool: Tool = {
    name: "trigger_cancel",
    description: "test-only tool that cancels the session as a side effect of executing",
    permission: "READ",
    inputSchema: {},
    execute: async () => {
      session.cancel();
      return { ok: true, output: "cancelled" };
    },
  };
  const noopTool: Tool = {
    name: "noop",
    description: "test-only tool that should never actually run once cancelled",
    permission: "READ",
    inputSchema: {},
    execute: async () => ({ ok: true, output: "noop" }),
  };

  const script: ChatResponse[] = [
    // Task 1: a single tool call using id "call_1", answered normally.
    { turn: { type: "tool_calls", toolCalls: [{ id: "call_1", name: "noop", arguments: {} }] } },
    { turn: { type: "final", content: "task 1 done" } },
    // Task 2: two calls in one turn. The first (id "call_0") triggers
    // cancellation as a side effect and still gets a real reply, since the
    // cancelled check only runs at the top of each loop iteration. The
    // second reuses id "call_1" — the SAME id task 1 already answered — and
    // must still get its own backfilled reply for *this* turn, not be
    // skipped because a call with that id was answered in an earlier turn.
    {
      turn: {
        type: "tool_calls",
        toolCalls: [
          { id: "call_0", name: "trigger_cancel", arguments: {} },
          { id: "call_1", name: "noop", arguments: {} },
        ],
      },
    },
  ];

  session = new AgentSession({
    workspaceRoot,
    model: "mock",
    provider: new MockProvider(script),
    tools: new ToolRegistry([cancelTool, noopTool]),
    permissionMode: "DEFAULT",
  });

  for await (const _event of session.run("first task")) {
    // drain
  }
  for await (const _event of session.run("second task")) {
    // drain
  }

  const messages = session.getMessages();
  const toolReplies = messages.filter((m) => m.role === "tool");
  const call1Replies = toolReplies.filter((m) => m.tool_call_id === "call_1");

  check("id 'call_1' is answered once per turn it appears in, not deduped across turns", call1Replies.length === 2);
  check(
    "the second turn's reused call_1 gets a synthetic 'cancelled before execution' reply, not silently dropped",
    (call1Replies[1]?.content ?? "").includes("Cancelled before execution")
  );
})();

console.log("\nRead-before-write safety override:");
await (async () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const workspaceRoot = path.resolve(__dirname, "..", "..", "fixture-repo");

  {
    const script: ChatResponse[] = [
      { turn: { type: "tool_calls", toolCalls: [{ id: "c1", name: "edit_file", arguments: { path: "math.js", content: "bogus" } }] } },
      { turn: { type: "final", content: "done" } },
    ];
    const session = new AgentSession({
      workspaceRoot,
      model: "mock",
      provider: new MockProvider(script),
      tools: defaultToolRegistry(),
      permissionMode: "ACCEPT_EDITS",
      onApprovalNeeded: async () => false,
    });

    let decision: string | undefined;
    let executed = false;
    // Deliberately doesn't name the file in the task text — this scenario is
    // about a model editing a path it never looked at, which the auto-read
    // feature (tested separately above) would otherwise short-circuit by
    // reading it before the first turn.
    for await (const event of session.run("apply the fix we discussed")) {
      if (event.type === "permission.request" && event.call.id === "c1") decision = event.decision;
      if (event.type === "tool.result" && event.call.id === "c1" && event.result.ok) executed = true;
    }

    check(
      "ACCEPT_EDITS still asks before editing a path never read this session",
      decision === "ASK" && !executed
    );
  }

  {
    const scratchPath = "safety-check-scratch.txt";
    const script: ChatResponse[] = [
      { turn: { type: "tool_calls", toolCalls: [{ id: "r1", name: "read_file", arguments: { path: scratchPath } }] } },
      { turn: { type: "tool_calls", toolCalls: [{ id: "e1", name: "edit_file", arguments: { path: scratchPath, content: "hello" } }] } },
      { turn: { type: "final", content: "done" } },
    ];
    const session = new AgentSession({
      workspaceRoot,
      model: "mock",
      provider: new MockProvider(script),
      tools: defaultToolRegistry(),
      permissionMode: "ACCEPT_EDITS",
    });

    let decision: string | undefined;
    for await (const event of session.run("create scratch file")) {
      if (event.type === "permission.request" && event.call.id === "e1") decision = event.decision;
    }

    check("ACCEPT_EDITS allows editing a path that was read (even unsuccessfully) earlier this session", decision === "ALLOW");
    await fs.rm(path.join(workspaceRoot, scratchPath), { force: true });
  }
})();

console.log("\nsetWorkspaceRoot/setPermissionMode update a live session in place:");
await (async () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const fixtureRoot = path.resolve(__dirname, "..", "..", "fixture-repo");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-agent-test-"));
  const distinctFile = "only-in-tmp-dir.txt";
  await fs.writeFile(path.join(tmpDir, distinctFile), "hello from the new workspace", "utf-8");

  // First run(): read a file in the ORIGINAL workspace (fixture-repo/math.js).
  // setWorkspaceRoot/setPermissionMode fire between the two run() calls
  // (mirroring how the renderer only ever calls them between tasks, never
  // mid-run). Second run(): read, then edit, the NEW workspace's file —
  // ACCEPT_EDITS still requires a path be read this session before it'll
  // auto-approve editing it (see the ACCEPT_EDITS test above), so this reads
  // it first, same as a real model would.
  const script: ChatResponse[] = [
    { turn: { type: "tool_calls", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "math.js" } }] } },
    { turn: { type: "final", content: "read the original workspace's file" } },
    { turn: { type: "tool_calls", toolCalls: [{ id: "c2", name: "read_file", arguments: { path: distinctFile } }] } },
    { turn: { type: "tool_calls", toolCalls: [{ id: "c3", name: "edit_file", arguments: { path: distinctFile, content: "edited" } }] } },
    { turn: { type: "final", content: "edited the new workspace's file" } },
  ];
  const session = new AgentSession({
    workspaceRoot: fixtureRoot,
    model: "mock",
    provider: new MockProvider(script),
    tools: defaultToolRegistry(),
    permissionMode: "PLAN", // PLAN denies WRITE outright — the edit must not be reachable under the original mode
  });

  const firstEvents: AgentEvent[] = [];
  for await (const event of session.run("read math.js")) firstEvents.push(event);
  const readOk = firstEvents.find((e) => e.type === "tool.result" && e.call.name === "read_file");
  check("before any update, read_file resolves against the original workspace (fixture-repo)", readOk?.type === "tool.result" && readOk.result.ok === true);

  session.setWorkspaceRoot(tmpDir);
  session.setPermissionMode("ACCEPT_EDITS");

  const secondEvents: AgentEvent[] = [];
  for await (const event of session.run("edit the tmp-dir-only file")) secondEvents.push(event);
  const readNewOk = secondEvents.find((e) => e.type === "tool.result" && e.call.name === "read_file");
  const editResult = secondEvents.find((e) => e.type === "tool.result" && e.call.name === "edit_file");
  // permission.request fires for every tool call unconditionally (it carries
  // the decision, not just an "asking the user" signal) — the actual thing
  // to check is that this specific decision was ALLOW, not ASK/DENY.
  const editPermissionEvent = secondEvents.find((e) => e.type === "permission.request" && e.call.name === "edit_file");
  check(
    "after setWorkspaceRoot, read_file resolves the NEW workspace's path — proving the workspace actually changed, not just that a stale reference happened to work",
    readNewOk?.type === "tool.result" && readNewOk.result.ok === true
  );
  check(
    "after setPermissionMode(ACCEPT_EDITS), editing a just-read path is auto-approved (decision ALLOW, not ASK)",
    editPermissionEvent?.type === "permission.request" &&
      editPermissionEvent.decision === "ALLOW" &&
      editResult?.type === "tool.result" &&
      editResult.result.ok === true
  );
  const writtenContent = await fs.readFile(path.join(tmpDir, distinctFile), "utf-8");
  check("the file on disk in the NEW workspace actually got edited", writtenContent === "edited");

  await fs.rm(tmpDir, { recursive: true, force: true });
})();

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
