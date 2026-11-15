import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { loadHooks, runAfterHooks, runBeforeHooks, MAX_HOOKS, type Hook } from "../../hooks.js";
import { AgentSession } from "../../agent.js";
import { defaultToolRegistry } from "../../toolRegistry.js";
import { MockProvider, type MockScriptEntry } from "../../providers/mockProvider.js";
import type { AgentEvent, ToolCall } from "../../types.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-hooks-"));
/** Writes a small Node script and returns a shell command that runs it, so the tests work on every platform. */
async function script(name: string, body: string): Promise<string> {
  const file = path.join(dir, `${name}.cjs`);
  await fs.writeFile(file, body);
  return `"${process.execPath}" "${file}"`;
}

try {
  console.log("loadHooks:");
  {
    const file = path.join(dir, "hooks.json");
    check("a missing file means no hooks", (await loadHooks(file)).length === 0 && (await loadHooks(undefined)).length === 0);
    await fs.writeFile(
      file,
      JSON.stringify({
        hooks: [
          { event: "before_tool", tool: "edit_file", command: "echo one" },
          { event: "after_tool", tool: "*", command: "  echo two  " },
        ],
      })
    );
    const hooks = await loadHooks(file);
    check("valid hooks load in order, with the command trimmed", hooks.length === 2 && hooks[0]!.tool === "edit_file" && hooks[1]!.command === "echo two" && hooks[1]!.event === "after_tool");
    await fs.writeFile(file, JSON.stringify({ hooks: [] }));
    check("an empty list is fine", (await loadHooks(file)).length === 0);

    // A hook can be a safety guard. A file that cannot be fully understood must stop the task, not quietly drop the guard.
    const throwsFor = async (content: string) => {
      await fs.writeFile(file, content);
      return loadHooks(file).then(
        () => false,
        (err) => err instanceof Error && err.message.includes("hooks.json")
      );
    };
    check("a damaged file is an error", await throwsFor("{ not json"));
    check("a file with the wrong shape is an error", (await throwsFor(JSON.stringify({ hooks: "nope" }))) && (await throwsFor(JSON.stringify([]))) && (await throwsFor("null")));
    check("an unknown event is an error", await throwsFor(JSON.stringify({ hooks: [{ event: "before-tool", tool: "*", command: "echo x" }] })));
    check("a missing tool or command is an error", (await throwsFor(JSON.stringify({ hooks: [{ event: "before_tool", tool: "", command: "echo x" }] }))) && (await throwsFor(JSON.stringify({ hooks: [{ event: "before_tool", tool: "x", command: "  " }] }))) && (await throwsFor(JSON.stringify({ hooks: [{ event: "before_tool", tool: "x", command: 5 }] }))));
    check("an entry that is not an object is an error", (await throwsFor(JSON.stringify({ hooks: ["text"] }))) && (await throwsFor(JSON.stringify({ hooks: [null] }))));
    check("too many hooks is an error", await throwsFor(JSON.stringify({ hooks: Array.from({ length: MAX_HOOKS + 1 }, (_, i) => ({ event: "after_tool", tool: "*", command: `echo ${i}` })) })));
  }

  const call: ToolCall = { id: "c1", name: "edit_file", arguments: { path: "a.txt", content: "new" } };

  console.log("\nrunBeforeHooks:");
  {
    const allow = await script("allow", "process.exit(0)");
    const deny = await script("deny", 'console.error("no edits to a.txt today"); process.exit(2)');
    const record = await script("record", `let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{require("fs").writeFileSync(${JSON.stringify(path.join(dir, "seen.json"))}, JSON.stringify({payload: JSON.parse(d), env: {tool: process.env.LOCALAGENT_TOOL, event: process.env.LOCALAGENT_EVENT, ws: process.env.LOCALAGENT_WORKSPACE}, cwd: process.cwd()}));})`);
    const slow = await script("slow", "setTimeout(() => {}, 60000)");

    check("no hooks means not blocked", (await runBeforeHooks([], call, dir)).blocked === false);
    check("a hook that exits 0 lets the call through", (await runBeforeHooks([{ event: "before_tool", tool: "edit_file", command: allow }], call, dir)).blocked === false);
    const blocked = await runBeforeHooks([{ event: "before_tool", tool: "edit_file", command: deny }], call, dir);
    check("a hook that exits non-zero blocks the call, with its message", blocked.blocked === true && blocked.message.includes("no edits to a.txt today"));
    check("a hook for another tool does not run", (await runBeforeHooks([{ event: "before_tool", tool: "run_command", command: deny }], call, dir)).blocked === false);
    check("a * hook runs for every tool", (await runBeforeHooks([{ event: "before_tool", tool: "*", command: deny }], call, dir)).blocked === true);
    check("an after_tool hook is ignored before the call", (await runBeforeHooks([{ event: "after_tool", tool: "*", command: deny }], call, dir)).blocked === false);
    const order = await runBeforeHooks(
      [
        { event: "before_tool", tool: "*", command: allow },
        { event: "before_tool", tool: "*", command: deny },
      ],
      call,
      dir
    );
    check("hooks run in order, and any one of them can block", order.blocked === true);

    await runBeforeHooks([{ event: "before_tool", tool: "*", command: record }], call, dir);
    const seen = JSON.parse(await fs.readFile(path.join(dir, "seen.json"), "utf8"));
    check("the hook gets the call as JSON on stdin", seen.payload.event === "before_tool" && seen.payload.tool === "edit_file" && seen.payload.arguments.path === "a.txt" && seen.payload.workspace === dir);
    check("the hook gets the tool, event and workspace in its environment", seen.env.tool === "edit_file" && seen.env.event === "before_tool" && seen.env.ws === dir);
    check("the hook runs in the workspace folder", (await fs.realpath(seen.cwd)) === (await fs.realpath(dir)));

    const started = Date.now();
    const timedOut = await runBeforeHooks([{ event: "before_tool", tool: "*", command: slow }], call, dir, { timeoutMs: 400 });
    check("a hook that does not finish in time blocks the call", timedOut.blocked === true && /time/i.test(timedOut.message) && Date.now() - started < 5000);

    const missing = await runBeforeHooks([{ event: "before_tool", tool: "*", command: '"/definitely/not/a/real/program-xyz"' }], call, dir);
    check("a hook that cannot start blocks the call", missing.blocked === true);

    const noisy = await script("noisy", 'process.stderr.write("x".repeat(100000)); process.exit(1)');
    const big = await runBeforeHooks([{ event: "before_tool", tool: "*", command: noisy }], call, dir);
    check("a very long hook message is shortened", big.blocked === true && big.message.length < 3000);

    const controller = new AbortController();
    const abortStarted = Date.now();
    setTimeout(() => controller.abort(), 200);
    const aborted = await runBeforeHooks([{ event: "before_tool", tool: "*", command: slow }], call, dir, { signal: controller.signal });
    check("stopping the task stops a running hook, and the call stays blocked", aborted.blocked === true && Date.now() - abortStarted < 5000);
  }

  console.log("\nrunAfterHooks:");
  {
    const report = await script("report", 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const p=JSON.parse(d);console.log("checked " + p.tool + " ok=" + p.result.ok);})');
    const fail = await script("afterfail", 'console.error("lint failed: unused variable"); process.exit(1)');
    const quiet = await script("quiet", "process.exit(0)");
    const notes = await runAfterHooks(
      [
        { event: "after_tool", tool: "edit_file", command: report },
        { event: "after_tool", tool: "*", command: fail },
        { event: "after_tool", tool: "*", command: quiet },
        { event: "before_tool", tool: "*", command: fail },
        { event: "after_tool", tool: "grep", command: fail },
      ],
      call,
      { ok: true, output: null },
      dir
    );
    check("each matching after hook's output is returned, in order", notes.length === 2 && notes[0]!.includes("checked edit_file ok=true") && notes[1]!.includes("lint failed: unused variable"));
    check("a hook with no output adds nothing", !notes.some((n) => n.trim() === ""));
  }

  function editTurn(id: string, file: string): MockScriptEntry {
    return { turn: { type: "tool_calls", toolCalls: [{ id, name: "edit_file", arguments: { path: file, content: "changed\n" } }] } };
  }
  const final: MockScriptEntry = { turn: { type: "final", content: "done" } };

  async function runSession(hooks: Hook[] | (() => Promise<Hook[]>), entries: MockScriptEntry[], mode: "DEFAULT" | "PLAN" = "DEFAULT") {
    const ws = await fs.mkdtemp(path.join(dir, "ws-"));
    await fs.writeFile(path.join(ws, "a.txt"), "old\n");
    const provider = new MockProvider(entries);
    const session = new AgentSession({
      workspaceRoot: ws,
      model: "mock",
      provider,
      tools: defaultToolRegistry(),
      permissionMode: mode,
      onApprovalNeeded: async () => ({ approved: true }),
      getHooks: typeof hooks === "function" ? hooks : async () => hooks,
    });
    const events: AgentEvent[] = [];
    for await (const e of session.run("change a.txt")) events.push(e);
    return { ws, events, session, provider, content: await fs.readFile(path.join(ws, "a.txt"), "utf8") };
  }

  console.log("\nAgentSession runs hooks around tool calls:");
  {
    const deny = await script("deny2", 'console.error("policy: a.txt is frozen"); process.exit(1)');
    const r = await runSession([{ event: "before_tool", tool: "edit_file", command: deny }], [editTurn("e1", "a.txt"), final]);
    check("a blocking hook stops the edit: the file is unchanged", r.content === "old\n");
    check("the model is told the call was blocked, with the hook's message", r.session.getMessages().some((m) => m.role === "tool" && m.tool_call_id === "e1" && m.content.includes("policy: a.txt is frozen") && m.content.includes('"ok":false')));
    check("the user sees that a hook blocked it", r.events.some((e) => e.type === "status" && /hook/i.test(e.message) && e.message.includes("edit_file")));
    check("the blocked call never starts", !r.events.some((e) => e.type === "tool.start" && e.call.id === "e1"));
    check("the task still finishes", r.events[r.events.length - 1]?.type === "done");
  }
  {
    const marker = path.join(dir, "after-ran.txt");
    const after = await script("after2", `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran"); console.log("formatted 1 file")`);
    const r = await runSession([{ event: "after_tool", tool: "edit_file", command: after }], [editTurn("e1", "a.txt"), final]);
    check("an after hook runs once the edit is applied", r.content === "changed\n" && (await fs.readFile(marker, "utf8")) === "ran");
    check("its output is shown to the user", r.events.some((e) => e.type === "status" && e.message.includes("formatted 1 file")));
    check("and given to the model with the tool result", r.session.getMessages().some((m) => m.role === "tool" && m.tool_call_id === "e1" && m.content.includes("formatted 1 file")));
  }
  {
    const marker = path.join(dir, "plan-ran.txt");
    const touch = await script("touch", `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`);
    await runSession([{ event: "before_tool", tool: "edit_file", command: touch }], [editTurn("e1", "a.txt"), final], "PLAN");
    const ran = await fs
      .access(marker)
      .then(() => true)
      .catch(() => false);
    check("a call that the permission mode refuses never reaches the hooks", ran === false);
  }
  {
    let loads = 0;
    const r = await runSession(
      async () => {
        loads++;
        throw new Error("cannot read hooks");
      },
      [editTurn("e1", "a.txt"), final]
    );
    check("if the hooks cannot be loaded, the task fails closed: no tool runs", loads === 1 && r.content === "old\n" && r.events.some((e) => e.type === "error" && /hook/i.test(e.message)) && r.provider.receivedRequests.length === 0);
  }
  {
    const r = await runSession([], [editTurn("e1", "a.txt"), final]);
    check("with no hooks, everything works as before", r.content === "changed\n");
  }
  {
    const deny = await script("denyread", 'console.error("reads are off"); process.exit(1)');
    const r = await runSession([{ event: "before_tool", tool: "read_file", command: deny }], [final]);
    check("the agent's automatic read of a file named in the task also goes through the hooks", !r.events.some((e) => e.type === "tool.start" && e.call.name === "read_file") && r.events.some((e) => e.type === "status" && e.message.includes("reads are off")));
    const control = await runSession([], [final]);
    check("without the hook, that automatic read happens", control.events.some((e) => e.type === "tool.start" && e.call.name === "read_file"));
  }
  {
    const ws = await fs.mkdtemp(path.join(dir, "verify-"));
    const ran = path.join(ws, "tests-ran.txt");
    await fs.writeFile(path.join(ws, "a.txt"), "old\n");
    await fs.writeFile(path.join(ws, "package.json"), JSON.stringify({ scripts: { test: `node -e "require('fs').writeFileSync('tests-ran.txt','x')"` } }));
    const deny = await script("denycmd", 'console.error("no commands"); process.exit(1)');
    const runVerify = async (hooks: Hook[]) => {
      await fs.rm(ran, { force: true });
      const session = new AgentSession({
        workspaceRoot: ws,
        model: "mock",
        provider: new MockProvider([{ turn: { type: "tool_calls", toolCalls: [{ id: "r1", name: "read_file", arguments: { path: "a.txt" } }] } }, editTurn("e1", "a.txt"), final, final, final]),
        tools: defaultToolRegistry(),
        permissionMode: "DEFAULT",
        onApprovalNeeded: async () => ({ approved: true }),
        getHooks: async () => hooks,
      });
      const events: AgentEvent[] = [];
      for await (const e of session.run("change the file")) events.push(e);
      const testsRan = await fs.access(ran).then(() => true, () => false);
      return { events, testsRan };
    };
    const control = await runVerify([]);
    const guarded = await runVerify([{ event: "before_tool", tool: "run_command", command: deny }]);
    check("without a hook, the automatic test run happens after an edit", control.testsRan === true);
    check("a hook on run_command also blocks the automatic test run", guarded.testsRan === false && guarded.events.some((e) => e.type === "status" && e.message.includes("no commands")));
  }
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
