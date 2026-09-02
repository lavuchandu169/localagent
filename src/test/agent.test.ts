import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PermissionEngine, classifyCommand } from "../permissions.js";
import { AgentSession, DEFAULT_SYSTEM_PROMPT } from "../agent.js";
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

console.log("Default system prompt:");
check(
  "instructs materializing created/written files via edit_file rather than describing them only in the reply — the exact gap that let a small model answer a \"design a website\" task in prose with no files ever written",
  DEFAULT_SYSTEM_PROMPT.includes("materialize it for real via edit_file")
);
check(
  "gives a concrete WRONG/RIGHT example of the failure mode, not just an abstract rule",
  DEFAULT_SYSTEM_PROMPT.includes("WRONG:") && DEFAULT_SYSTEM_PROMPT.includes("RIGHT:")
);

console.log("\nCommand risk classification:");
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
{
  // The exact failure observed live from Qwen2.5-Coder 1.5B: correctly
  // escapes quotes almost everywhere in a large HTML content value, but
  // leaves ONE pair raw (`href="/"` instead of `href=\"/\"`) — otherwise
  // well-formed JSON that a strict JSON.parse rejects outright.
  const response =
    '{"name": "edit_file", "arguments": {"path": "public/index.html", ' +
    '"content": "<a href=\\"/cart\\">Cart</a> and <a href="/">Home</a> and <a href=\\"/checkout\\">Checkout</a>"}}';
  const { turn } = fromLlamaResult({ response, functionCalls: undefined });
  check(
    "fromLlamaResult recovers a tool call despite one unescaped quote pair amid otherwise-correct escaping",
    turn.type === "tool_calls" && turn.toolCalls[0]?.name === "edit_file" && turn.toolCalls[0]?.arguments.path === "public/index.html"
  );
  check(
    "the recovered content preserves the correctly-escaped parts exactly, and keeps the unescaped quotes as literal quote characters",
    turn.type === "tool_calls" &&
      turn.toolCalls[0]?.arguments.content === '<a href="/cart">Cart</a> and <a href="/">Home</a> and <a href="/checkout">Checkout</a>'
  );
}
{
  // A genuinely broken candidate (an actually-unbalanced/nonsense object,
  // not just a missed escape) must still fail cleanly rather than recover
  // something wrong — the repair pass is best-effort, not a guarantee.
  const { turn } = fromLlamaResult({
    response: '{"name": "edit_file", "arguments": {"path": "a.js", "content": "unterminated',
    functionCalls: undefined,
  });
  check("a truly malformed candidate still falls back to a final (prose) turn, not a wrong recovery", turn.type === "final");
}
{
  const history = toLlamaHistory([
    { role: "user", content: "what's this", images: [{ name: "photo.png", mediaType: "image/png", dataBase64: "AAAA" }] },
  ]);
  check(
    "an attached image folds into the user turn's text as an honest can't-see-images note, not silently dropped",
    history[0]?.type === "user" && (history[0] as any).text === "what's this\n\n[Attached image: photo.png — this local model can't see images.]"
  );
}
{
  const history = toLlamaHistory([
    { role: "user", content: "summarize", textAttachments: [{ name: "notes.txt", content: "key point: X" }] },
  ]);
  check(
    "a text attachment folds in exactly like the other two providers",
    history[0]?.type === "user" && (history[0] as any).text === "summarize\n\n--- Attached file: notes.txt ---\nkey point: X\n---"
  );
}
{
  const history = toLlamaHistory([{ role: "user", content: "plain question" }]);
  check("a message with no attachments is unaffected", history[0]?.type === "user" && (history[0] as any).text === "plain question");
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

console.log("\nA permission.request for edit_file carries a real diff:");
await (async () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const workspaceRoot = path.resolve(__dirname, "..", "..", "fixture-repo");

  {
    // math.js's real content: "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n"
    const script: ChatResponse[] = [
      { turn: { type: "tool_calls", toolCalls: [{ id: "r1", name: "read_file", arguments: { path: "math.js" } }] } },
      {
        turn: {
          type: "tool_calls",
          toolCalls: [{ id: "e1", name: "edit_file", arguments: { path: "math.js", content: "function add(a, b) {\n  return a + b + 1;\n}\nmodule.exports = { add };\n" } }],
        },
      },
      { turn: { type: "final", content: "done" } },
    ];
    const session = new AgentSession({
      workspaceRoot,
      model: "mock",
      provider: new MockProvider(script),
      tools: defaultToolRegistry(),
      permissionMode: "PLAN", // PLAN denies WRITE outright — the diff must still be computed and attached even when the decision ends up DENY, not just on ALLOW/ASK
    });

    let editEvent: AgentEvent | undefined;
    for await (const event of session.run("look at math.js")) {
      if (event.type === "permission.request" && event.call.id === "e1") editEvent = event;
    }

    check("the edit_file permission.request event has a diff attached", editEvent?.type === "permission.request" && Array.isArray(editEvent.diff));
    if (editEvent?.type === "permission.request" && editEvent.diff) {
      const removed = editEvent.diff.filter((c) => c.removed);
      const added = editEvent.diff.filter((c) => c.added);
      check("the diff shows the real old line as removed", removed.some((c) => c.value.includes("return a + b;")));
      check("the diff shows the real new line as added", added.some((c) => c.value.includes("return a + b + 1;")));
      check("unrelated unchanged lines aren't marked as changed", editEvent.diff.some((c) => !c.added && !c.removed && c.value.includes("module.exports")));
    }
    check("this is attached even though PLAN denies the edit outright", editEvent?.type === "permission.request" && editEvent.decision === "DENY");
  }

  {
    // A brand-new file (never read, doesn't exist on disk) — diffed against
    // nothing, so it should show as entirely added, not throw or omit the diff.
    const newFileContent = "export const x = 1;\n";
    const script: ChatResponse[] = [
      { turn: { type: "tool_calls", toolCalls: [{ id: "e2", name: "edit_file", arguments: { path: "brand-new-file.ts", content: newFileContent } }] } },
      { turn: { type: "final", content: "done" } },
    ];
    const session = new AgentSession({
      workspaceRoot,
      model: "mock",
      provider: new MockProvider(script),
      tools: defaultToolRegistry(),
      permissionMode: "PLAN",
    });

    let editEvent: AgentEvent | undefined;
    for await (const event of session.run("create a new file")) {
      if (event.type === "permission.request" && event.call.id === "e2") editEvent = event;
    }

    check(
      "a brand-new file's diff shows the whole content as added, not an error",
      editEvent?.type === "permission.request" && editEvent.diff?.length === 1 && editEvent.diff[0]?.added === true && editEvent.diff[0]?.value === newFileContent
    );
  }
})();

console.log("\nCheckpoints — one per task, only in a real git workspace:");
await (async () => {
  const execFileAsync = promisify(execFile);
  const git = async (cwd: string, args: string[]) => (await execFileAsync("git", args, { cwd })).stdout.trim();

  // fixture-repo (used everywhere else in this file) is NOT its own git
  // repo — it's a plain subdirectory of this project's own repo, so running
  // checkpoint logic against it would create commits inside localagent's
  // REAL .git. A dedicated temp repo avoids that entirely.
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-agent-checkpoint-test-"));
  await git(repo, ["init", "-q"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(repo, "app.js"), "console.log('v1');\n", "utf-8");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "initial"]);

  {
    // Two tool calls this task: a read (no checkpoint) then a write (checkpoint).
    const script: ChatResponse[] = [
      { turn: { type: "tool_calls", toolCalls: [{ id: "r1", name: "read_file", arguments: { path: "app.js" } }] } },
      { turn: { type: "tool_calls", toolCalls: [{ id: "e1", name: "edit_file", arguments: { path: "app.js", content: "console.log('v2');\n" } }] } },
      { turn: { type: "final", content: "done" } },
    ];
    const session = new AgentSession({
      workspaceRoot: repo,
      model: "mock",
      provider: new MockProvider(script),
      tools: defaultToolRegistry(),
      permissionMode: "ACCEPT_EDITS",
    });

    const events: AgentEvent[] = [];
    for await (const event of session.run("bump the version string")) events.push(event);

    const checkpointEvents = events.filter((e) => e.type === "checkpoint.created");
    check("exactly one checkpoint.created event fires (not one per write, one per task)", checkpointEvents.length === 1);
    check("no checkpoint fires for the read_file call itself", events.findIndex((e) => e.type === "checkpoint.created") > events.findIndex((e) => e.type === "tool.start" && e.call.id === "r1"));
    check("session.getCheckpointHash() reflects the same hash the event carried", checkpointEvents[0]?.type === "checkpoint.created" && session.getCheckpointHash() === checkpointEvents[0].checkpointHash);

    // Full round trip: the edit actually applied, then reverting via the
    // real checkpoints module (not re-testing its internals, just proving
    // the hash captured here is a genuinely usable revert target) restores
    // the pre-task content.
    const afterEdit = await fs.readFile(path.join(repo, "app.js"), "utf-8");
    check("the edit actually applied to disk before revert", afterEdit === "console.log('v2');\n");

    const { revertToCheckpoint } = await import("../checkpoints.js");
    const hash = session.getCheckpointHash();
    if (hash) await revertToCheckpoint(repo, hash);
    const afterRevert = await fs.readFile(path.join(repo, "app.js"), "utf-8");
    check("reverting to the session's captured checkpoint restores the pre-task content", afterRevert === "console.log('v1');\n");
  }

  {
    // A read-only task must never take a checkpoint at all.
    const script: ChatResponse[] = [
      { turn: { type: "tool_calls", toolCalls: [{ id: "r2", name: "read_file", arguments: { path: "app.js" } }] } },
      { turn: { type: "final", content: "it says v1" } },
    ];
    const session = new AgentSession({
      workspaceRoot: repo,
      model: "mock",
      provider: new MockProvider(script),
      tools: defaultToolRegistry(),
      permissionMode: "PLAN",
    });

    const events: AgentEvent[] = [];
    for await (const event of session.run("what does app.js say")) events.push(event);
    check("a read-only task takes no checkpoint at all", !events.some((e) => e.type === "checkpoint.created"));
    check("a fresh session that only ever did a read-only task has no checkpoint (never set)", session.getCheckpointHash() === null);
  }

  {
    // A non-git workspace must silently get no checkpoint — not an error,
    // not a crash, the task just proceeds without one.
    const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-agent-nongit-test-"));
    await fs.writeFile(path.join(nonGitDir, "file.txt"), "hello\n", "utf-8");
    const script: ChatResponse[] = [
      { turn: { type: "tool_calls", toolCalls: [{ id: "e3", name: "edit_file", arguments: { path: "file.txt", content: "hello v2\n" } }] } },
      { turn: { type: "final", content: "done" } },
    ];
    const session = new AgentSession({
      workspaceRoot: nonGitDir,
      model: "mock",
      provider: new MockProvider(script),
      tools: defaultToolRegistry(),
      permissionMode: "ACCEPT_EDITS",
      // edit_file on a path never read this session still gets ASKed even
      // in ACCEPT_EDITS (the read-before-write override tested earlier in
      // this file) — approve it so this block can focus purely on the
      // checkpoint behavior, not re-test that override.
      onApprovalNeeded: async () => true,
    });

    const events: AgentEvent[] = [];
    for await (const event of session.run("edit the file")) events.push(event);
    check("a non-git workspace takes no checkpoint, and the write still succeeds normally", !events.some((e) => e.type === "checkpoint.created"));
    check("session.getCheckpointHash() stays null for a non-git workspace", session.getCheckpointHash() === null);
    const written = await fs.readFile(path.join(nonGitDir, "file.txt"), "utf-8");
    check("the edit itself still worked fine despite no checkpoint being possible", written === "hello v2\n");
    await fs.rm(nonGitDir, { recursive: true, force: true });
  }

  await fs.rm(repo, { recursive: true, force: true });
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

console.log("\nCorrective nudge — a 'create X' task answered with code-in-prose instead of a real edit_file call:");
await (async () => {
  // A throwaway temp dir, not fixture-repo — this scenario actually writes
  // a file, and fixture-repo is a real subdirectory of this project itself.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-nudge-test-"));

  {
    // The exact reported failure: a creation task, first answered with
    // fenced code and zero tool calls. Should get nudged once, then
    // (script's second entry) actually call edit_file and complete.
    const script: ChatResponse[] = [
      { turn: { type: "final", content: "Here's widget.js:\n```js\nconsole.log('hi');\n```" } },
      {
        turn: {
          type: "tool_calls",
          toolCalls: [
            { id: "r1", name: "read_file", arguments: { path: "widget.js" } },
            { id: "e1", name: "edit_file", arguments: { path: "widget.js", content: "console.log('hi');\n" } },
          ],
        },
      },
      { turn: { type: "final", content: "Created widget.js." } },
    ];
    const session = new AgentSession({
      workspaceRoot: tmpDir,
      model: "mock",
      provider: new MockProvider(script),
      tools: defaultToolRegistry(),
      permissionMode: "ACCEPT_EDITS",
    });

    const events: AgentEvent[] = [];
    for await (const event of session.run("create a new file called widget.js that logs hi")) {
      events.push(event);
    }

    const nudgeStatus = events.find((e) => e.type === "status" && e.message.includes("nudging the model"));
    check("a nudge status event fires exactly once", events.filter((e) => e.type === "status" && e.message.includes("nudging")).length === 1);
    check("the nudge event exists at all", !!nudgeStatus);
    const doneEvents = events.filter((e) => e.type === "done");
    check("the task still completes successfully after the nudge", doneEvents.length === 1 && doneEvents[0]?.type === "done" && doneEvents[0].success === true);
    const writtenContent = await fs.readFile(path.join(tmpDir, "widget.js"), "utf-8").catch(() => null);
    check("the file was actually written to disk on the second attempt", writtenContent === "console.log('hi');\n");
  }

  {
    // Not a creation task — a fenced code block in the final answer is a
    // completely normal way to answer "how does X work", so no nudge.
    const script: ChatResponse[] = [{ turn: { type: "final", content: "It works like this:\n```js\nfoo();\n```" } }];
    const session = new AgentSession({
      workspaceRoot: tmpDir,
      model: "mock",
      provider: new MockProvider(script),
      tools: defaultToolRegistry(),
      permissionMode: "PLAN",
    });

    const events: AgentEvent[] = [];
    for await (const event of session.run("what does the foo function do")) {
      events.push(event);
    }
    check("a non-creation question with example code in the answer is never nudged", !events.some((e) => e.type === "status" && e.message.includes("nudging")));
    check("it completes normally on the first turn", events.filter((e) => e.type === "done").length === 1);
  }

  {
    // The model DID try to write and was refused (PLAN mode denies WRITE
    // outright) — that's a real policy decision already surfaced to the
    // model, not the "never even tried" failure the nudge exists to catch.
    // Its next final answer (even with fenced code) must not be nudged again.
    const script: ChatResponse[] = [
      { turn: { type: "tool_calls", toolCalls: [{ id: "e1", name: "edit_file", arguments: { path: "widget2.js", content: "x\n" } }] } },
      { turn: { type: "final", content: "Can't write in PLAN mode, so here's what it would contain:\n```js\nx\n```" } },
    ];
    const session = new AgentSession({
      workspaceRoot: tmpDir,
      model: "mock",
      provider: new MockProvider(script),
      tools: defaultToolRegistry(),
      permissionMode: "PLAN",
    });

    const events: AgentEvent[] = [];
    for await (const event of session.run("create widget2.js")) {
      events.push(event);
    }
    check("a task where the model already attempted a write (denied) is not nudged again", !events.some((e) => e.type === "status" && e.message.includes("nudging")));
    check("it still completes", events.filter((e) => e.type === "done").length === 1);
  }

  await fs.rm(tmpDir, { recursive: true, force: true });
})();

console.log("\nPlan first — a task's first turn held for approval before anything runs:");
await (async () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const workspaceRoot = path.resolve(__dirname, "..", "..", "fixture-repo");

  {
    // Approved: the exact same tool_calls response the model already
    // produced gets executed — no re-fetch from the provider.
    const script: ChatResponse[] = [
      { turn: { type: "tool_calls", toolCalls: [{ id: "r1", name: "read_file", arguments: { path: "math.js" } }] } },
      { turn: { type: "final", content: "It adds two numbers." } },
    ];
    const session = new AgentSession({
      workspaceRoot,
      model: "mock",
      provider: new MockProvider(script),
      tools: defaultToolRegistry(),
      permissionMode: "PLAN",
      planFirst: true,
      onPlanApprovalNeeded: async () => true,
    });

    const events: AgentEvent[] = [];
    // Deliberately doesn't name a real file — this is testing planFirst's
    // gate on the model's OWN first turn, not autoReadNamedFiles' separate
    // pre-loop grounding step (which runs before the turn loop and isn't
    // gated by planFirst at all — a task that names a real file would
    // trigger its own tool.start before the model's turn even happens,
    // which is correct but would make this specific ordering assertion
    // meaningless).
    for await (const event of session.run("look at a file and tell me what it does")) events.push(event);

    const planIndex = events.findIndex((e) => e.type === "plan.proposed");
    const toolStartIndex = events.findIndex((e) => e.type === "tool.start");
    check("a plan.proposed event fires", planIndex !== -1);
    check(
      "the proposed plan carries the exact tool call the model produced",
      events[planIndex]?.type === "plan.proposed" &&
        events[planIndex].plan.kind === "tool_calls" &&
        events[planIndex].plan.toolCalls[0]?.name === "read_file"
    );
    check("the plan is shown BEFORE any tool actually starts", planIndex < toolStartIndex);
    check("approving still executes the proposed call (real read, no re-fetch)", toolStartIndex !== -1);
    check("the task completes normally after an approved plan", events.some((e) => e.type === "done" && e.success === true));
  }

  {
    // Rejected: nothing from that turn ever executes.
    const script: ChatResponse[] = [
      { turn: { type: "tool_calls", toolCalls: [{ id: "e1", name: "edit_file", arguments: { path: "should-not-exist.txt", content: "x" } }] } },
    ];
    const session = new AgentSession({
      workspaceRoot,
      model: "mock",
      provider: new MockProvider(script),
      tools: defaultToolRegistry(),
      permissionMode: "ACCEPT_EDITS",
      planFirst: true,
      onPlanApprovalNeeded: async () => false,
    });

    const events: AgentEvent[] = [];
    for await (const event of session.run("create should-not-exist.txt")) events.push(event);

    check("a rejected plan never starts any tool", !events.some((e) => e.type === "tool.start"));
    check(
      "the task ends with success:false and a clear summary",
      events.some((e) => e.type === "done" && e.success === false && e.summary === "Plan rejected — nothing was changed.")
    );
    const fileExists = await fs
      .access(path.join(workspaceRoot, "should-not-exist.txt"))
      .then(() => true)
      .catch(() => false);
    check("the file the rejected plan would have created was never written", !fileExists);
  }

  {
    // A plain text answer as the "plan", also approvable.
    const script: ChatResponse[] = [{ turn: { type: "final", content: "It's just a sum function." } }];
    const session = new AgentSession({
      workspaceRoot,
      model: "mock",
      provider: new MockProvider(script),
      tools: defaultToolRegistry(),
      permissionMode: "PLAN",
      planFirst: true,
      onPlanApprovalNeeded: async () => true,
    });

    const events: AgentEvent[] = [];
    for await (const event of session.run("what does math.js do, briefly")) events.push(event);

    const plan = events.find((e) => e.type === "plan.proposed");
    check(
      "a text-only first turn is proposed as a text-kind plan",
      plan?.type === "plan.proposed" && plan.plan.kind === "text" && plan.plan.content === "It's just a sum function."
    );
    check("approving a text plan still completes the task normally", events.some((e) => e.type === "done" && e.success === true));
  }

  {
    // planFirst off (the default) — completely unaffected, exactly as
    // every other test in this file already assumes.
    const script: ChatResponse[] = [{ turn: { type: "final", content: "done" } }];
    const session = new AgentSession({
      workspaceRoot,
      model: "mock",
      provider: new MockProvider(script),
      tools: defaultToolRegistry(),
      permissionMode: "PLAN",
    });

    const events: AgentEvent[] = [];
    for await (const event of session.run("anything")) events.push(event);
    check("planFirst defaults to off — no plan.proposed event without opting in", !events.some((e) => e.type === "plan.proposed"));
  }

  {
    // Only turn 1 is gated — a second turn in the same task runs normally.
    const script: ChatResponse[] = [
      { turn: { type: "tool_calls", toolCalls: [{ id: "r1", name: "read_file", arguments: { path: "math.js" } }] } },
      { turn: { type: "tool_calls", toolCalls: [{ id: "r2", name: "read_file", arguments: { path: "math.js" } }] } },
      { turn: { type: "final", content: "done" } },
    ];
    const session = new AgentSession({
      workspaceRoot,
      model: "mock",
      provider: new MockProvider(script),
      tools: defaultToolRegistry(),
      permissionMode: "PLAN",
      planFirst: true,
      onPlanApprovalNeeded: async () => true,
    });

    const events: AgentEvent[] = [];
    for await (const event of session.run("read math.js twice")) events.push(event);
    check("only one plan.proposed fires for a multi-turn task — turn 2 is never re-gated", events.filter((e) => e.type === "plan.proposed").length === 1);
  }

  {
    // Per-task, not per-session: a second run() call on the same session
    // gates its own first turn too.
    const script: ChatResponse[] = [
      { turn: { type: "final", content: "first answer" } },
      { turn: { type: "final", content: "second answer" } },
    ];
    const session = new AgentSession({
      workspaceRoot,
      model: "mock",
      provider: new MockProvider(script),
      tools: defaultToolRegistry(),
      permissionMode: "PLAN",
      planFirst: true,
      onPlanApprovalNeeded: async () => true,
    });

    const firstEvents: AgentEvent[] = [];
    for await (const event of session.run("first task")) firstEvents.push(event);
    const secondEvents: AgentEvent[] = [];
    for await (const event of session.run("second task")) secondEvents.push(event);

    check("the first task's first turn is gated", firstEvents.some((e) => e.type === "plan.proposed"));
    check("a second, separate task is gated again too — planProposedThisTask resets per task", secondEvents.some((e) => e.type === "plan.proposed"));
  }
})();

console.log("\nAttachments thread through to the first pushed message:");
await (async () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const workspaceRoot = path.resolve(__dirname, "..", "..", "fixture-repo");

  {
    const script: ChatResponse[] = [{ turn: { type: "final", content: "got it" } }];
    const session = new AgentSession({
      workspaceRoot,
      model: "mock",
      provider: new MockProvider(script),
      tools: defaultToolRegistry(),
      permissionMode: "PLAN",
    });

    for await (const _event of session.run("look at this", {
      images: [{ name: "a.png", mediaType: "image/png", dataBase64: "abc123" }],
      textAttachments: [{ name: "b.txt", content: "hello" }],
    })) {
      // draining the generator is enough — the assertion below reads the session's own history
    }

    const messages = session.getMessages();
    const firstUserMessage = messages.find((m) => m.role === "user");
    check("the first user message carries the images unchanged", firstUserMessage?.images?.[0]?.name === "a.png" && firstUserMessage?.images?.[0]?.dataBase64 === "abc123");
    check("the first user message carries the textAttachments unchanged", firstUserMessage?.textAttachments?.[0]?.content === "hello");
  }

  {
    // No attachments passed at all — the existing zero-argument call
    // shape from every other test in this file must still work exactly
    // as before (images/textAttachments simply absent, not undefined
    // fields sitting on the message).
    const script: ChatResponse[] = [{ turn: { type: "final", content: "ok" } }];
    const session = new AgentSession({
      workspaceRoot,
      model: "mock",
      provider: new MockProvider(script),
      tools: defaultToolRegistry(),
      permissionMode: "PLAN",
    });
    for await (const _event of session.run("no attachments here")) {
      // drain
    }
    const firstUserMessage = session.getMessages().find((m) => m.role === "user");
    check("run() with no second argument still works, with no images field", firstUserMessage?.images === undefined);
    check("run() with no second argument still works, with no textAttachments field", firstUserMessage?.textAttachments === undefined);
  }
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
