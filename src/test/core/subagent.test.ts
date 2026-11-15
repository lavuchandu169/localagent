import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { AgentSession, SUBAGENT_SYSTEM_PROMPT, MAX_DELEGATIONS_PER_TASK } from "../../agent.js";
import { defaultToolRegistry, readOnlyToolRegistry } from "../../toolRegistry.js";
import { MockProvider, type MockScriptEntry } from "../../providers/mockProvider.js";
import { delegateTaskTool } from "../../tools/delegateTask.js";
import type { AgentEvent } from "../../types.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

const call = (id: string, name: string, args: Record<string, unknown>): MockScriptEntry => ({ turn: { type: "tool_calls", toolCalls: [{ id, name, arguments: args }] } });
const final = (content: string, usage?: { inputTokens: number; outputTokens: number }): MockScriptEntry => ({ turn: { type: "final", content }, ...(usage ? { usage } : {}) });

const root = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-subagent-"));
try {
  await fs.writeFile(path.join(root, "parser.ts"), "export function parse() { return 42; }\n");
  await fs.writeFile(path.join(root, "notes.txt"), "old\n");

  async function run(script: MockScriptEntry[], options: { delegate?: boolean; mode?: "DEFAULT" | "PLAN"; task?: string } = {}) {
    const provider = new MockProvider(script);
    const asked: string[] = [];
    const session = new AgentSession({
      workspaceRoot: root,
      model: "mock",
      provider,
      tools: defaultToolRegistry(() => [], { delegate: options.delegate ?? true }),
      permissionMode: options.mode ?? "DEFAULT",
      onApprovalNeeded: async (c) => {
        asked.push(c.name);
        return { approved: true };
      },
    });
    const events: AgentEvent[] = [];
    for await (const e of session.run(options.task ?? "how does the parser work?")) events.push(e);
    return { provider, session, events, asked };
  }

  console.log("Tool registries:");
  check("delegate_task is not offered by default", defaultToolRegistry().get("delegate_task") === undefined);
  check("it is offered when asked for", defaultToolRegistry(() => [], { delegate: true }).get("delegate_task") !== undefined);
  {
    const names = readOnlyToolRegistry()
      .availableTools()
      .map((t) => t.name)
      .sort();
    check("the helper's tools are the read and search tools only", JSON.stringify(names) === JSON.stringify(["find_files", "grep", "list_directory", "read_file"]));
    check("every helper tool is read-only", readOnlyToolRegistry().availableTools().every((t) => t.permission === "READ"));
  }
  {
    const r = await delegateTaskTool.execute({ task: "x" }, { workspaceRoot: root, log: () => {} });
    check("outside an agent session the tool fails cleanly", r.ok === false);
    const empty = await delegateTaskTool.execute({ task: "   " }, { workspaceRoot: root, log: () => {}, runSubagent: async () => ({ ok: true, text: "x", toolCalls: 0 }) });
    check("an empty task is refused", empty.ok === false);
  }

  console.log("\nA delegated task:");
  {
    const r = await run([
      call("d1", "delegate_task", { task: "Find what parse() in parser.ts returns." }),
      call("h1", "read_file", { path: "parser.ts" }),
      final("parse() returns 42.", { inputTokens: 500, outputTokens: 20 }),
      final("The parser returns 42."),
    ]);
    const helperRequest = r.provider.receivedRequests[1]!;
    check("the helper starts from its own system prompt and the delegated task only", helperRequest.messages[0]?.content === SUBAGENT_SYSTEM_PROMPT && helperRequest.messages.filter((m) => m.role === "user").length === 1 && helperRequest.messages.some((m) => m.role === "user" && m.content === "Find what parse() in parser.ts returns."));
    check("the helper does not see the main conversation", !helperRequest.messages.some((m) => m.content.includes("how does the parser work?")));
    const helperTools = (helperRequest.tools ?? []).map((t) => t.name);
    check("the helper is offered read tools only, and cannot delegate further", helperTools.includes("read_file") && !helperTools.includes("edit_file") && !helperTools.includes("run_command") && !helperTools.includes("delegate_task"));
    const toolReply = r.session.getMessages().find((m) => m.role === "tool" && m.tool_call_id === "d1");
    check("the helper's findings come back as the tool result", !!toolReply && toolReply.content.includes("parse() returns 42."));
    check("the helper's own steps stay out of the main conversation", !r.session.getMessages().some((m) => m.tool_call_id === "h1" || m.content.includes("export function parse")));
    check("the main agent continues with the findings", r.provider.receivedRequests[3]?.messages.some((m) => m.role === "tool" && m.content.includes("parse() returns 42.")) === true && r.events.some((e) => e.type === "text" && e.text === "The parser returns 42."));
    check("the helper's token use is reported", r.events.some((e) => e.type === "usage" && e.inputTokens === 500));
    check("delegating needs no approval", r.asked.length === 0);
    check("the user sees that a helper ran", r.events.some((e) => e.type === "status" && /helper/i.test(e.message)));
  }
  {
    const r = await run([
      call("d1", "delegate_task", { task: "Change notes.txt." }),
      call("h1", "edit_file", { path: "notes.txt", content: "hacked\n" }),
      call("h2", "run_command", { command: "echo hi" }),
      final("I could not change anything."),
      final("done"),
    ]);
    check("the helper cannot edit files or run commands", (await fs.readFile(path.join(root, "notes.txt"), "utf8")) === "old\n" && r.asked.length === 0);
  }
  {
    const r = await run([call("d1", "delegate_task", { task: "Look around." }), { throws: new Error("provider down") }, final("The helper failed, so I answer directly.")]);
    const toolReply = r.session.getMessages().find((m) => m.role === "tool" && m.tool_call_id === "d1");
    check("a helper that fails is reported to the main agent as an error, and the task goes on", !!toolReply && toolReply.content.includes('"ok":false') && r.events[r.events.length - 1]?.type === "done");
  }
  {
    const many: MockScriptEntry[] = [];
    for (let i = 0; i < MAX_DELEGATIONS_PER_TASK + 1; i++) {
      many.push(call(`d${i}`, "delegate_task", { task: `question ${i}` }));
      if (i < MAX_DELEGATIONS_PER_TASK) many.push(final(`answer ${i}`));
    }
    many.push(final("done"));
    const r = await run(many);
    const last = r.session.getMessages().find((m) => m.role === "tool" && m.tool_call_id === `d${MAX_DELEGATIONS_PER_TASK}`);
    check("the number of helpers per task is limited", !!last && last.content.includes('"ok":false') && /limit/i.test(last.content));
  }
  {
    const r = await run([call("d1", "delegate_task", { task: "Read parser.ts." }), call("h1", "read_file", { path: "parser.ts" }), final("It returns 42."), final("done")], { mode: "PLAN" });
    check("a helper works in read-only mode too", r.session.getMessages().some((m) => m.tool_call_id === "d1" && m.content.includes("It returns 42.")));
  }
  {
    const long = "x".repeat(20000);
    const r = await run([call("d1", "delegate_task", { task: "Write a lot." }), final(long), final("done")]);
    const toolReply = r.session.getMessages().find((m) => m.role === "tool" && m.tool_call_id === "d1");
    check("very long findings are shortened", !!toolReply && toolReply.content.length < 7000);
  }
  {
    const provider = new MockProvider([call("d1", "delegate_task", { task: "Look around." })]);
    let session!: AgentSession;
    // The helper's first model call never returns until it is aborted.
    const originalChat = provider.chat.bind(provider);
    let calls = 0;
    provider.chat = async (request) => {
      calls++;
      if (calls === 1) return originalChat(request);
      setTimeout(() => session.stopCurrentTask(), 50);
      return new Promise((_, reject) => request.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    };
    session = new AgentSession({ workspaceRoot: root, model: "mock", provider, tools: defaultToolRegistry(() => [], { delegate: true }), permissionMode: "DEFAULT" });
    const started = Date.now();
    const events: AgentEvent[] = [];
    for await (const e of session.run("investigate")) events.push(e);
    check("stopping the task also stops a running helper", Date.now() - started < 5000 && events[events.length - 1]?.type === "done");
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
