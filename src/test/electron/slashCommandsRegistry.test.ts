import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { createSessionRegistry, startSession, runTask, getLiveSessionSnapshot } from "../../electron/sessionRegistry.js";
import { MockProvider, type MockScriptEntry } from "../../providers/mockProvider.js";
import type { AgentEvent, ChatMessage } from "../../types.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

const base = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-slash-registry-"));
try {
  const commandsDir = path.join(base, "commands");
  const workspace = path.join(base, "ws");
  await fs.mkdir(commandsDir);
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(commandsDir, "greet.md"), "Say hello to $ARGUMENTS in French.");

  const setup = async (script: MockScriptEntry[], options: { commandsDir?: string; initialMessages?: ChatMessage[] } = {}) => {
    const provider = new MockProvider(script);
    const registry = createSessionRegistry(path.join(base, "sessions"), undefined, undefined, undefined, "commandsDir" in options ? options.commandsDir : commandsDir);
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot: workspace, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "DEFAULT" },
      { providerFactory: () => provider, ...(options.initialMessages ? { resume: { sessionId: crypto.randomUUID(), initialMessages: options.initialMessages, priorEvents: [], title: "t", createdAt: Date.now(), ownerEmail: null, checkpointHash: null, checkpointWorkspaceRoot: null } } : {}) }
    );
    const run = async (task: string) => {
      const events: AgentEvent[] = [];
      await runTask(registry, sessionId, task, (e) => events.push(e));
      return events;
    };
    return { provider, registry, sessionId, run };
  };
  const final = (content: string): MockScriptEntry => ({ turn: { type: "final", content } });

  console.log("Slash commands in a session:");
  {
    const s = await setup([final("Bonjour")]);
    const events = await s.run("/greet the team");
    const sent = s.provider.receivedRequests[0]?.messages.filter((m) => m.role === "user").map((m) => m.content);
    check("a custom command reaches the model as its expanded text", JSON.stringify(sent) === JSON.stringify(["Say hello to the team in French."]));
    check("the user is told that a command ran", events.some((e) => e.type === "status" && e.message.includes("/greet")));
    check("the task completes normally", events[events.length - 1]?.type === "done");
  }
  {
    const s = await setup([final("ok")]);
    const events = await s.run("/help");
    check("/help answers without calling the model", s.provider.receivedRequests.length === 0 && events.some((e) => e.type === "text" && e.text.includes("/greet") && e.text.includes("/compact")));
    check("/help ends with a done event, so the composer unlocks", events[events.length - 1]?.type === "done");
    check("/help adds nothing to the conversation the model sees", !getLiveSessionSnapshot(s.registry, s.sessionId)!.messages.some((m) => m.role === "user"));
  }
  {
    const s = await setup([final("ok")]);
    const events = await s.run("/nope do it");
    check("an unknown command is answered without calling the model", s.provider.receivedRequests.length === 0 && events.some((e) => e.type === "text" && e.text.includes("/nope")));
  }
  {
    const s = await setup([final("ok")]);
    await s.run("please look at /src/a.ts");
    check("ordinary text that contains a slash is sent unchanged", s.provider.receivedRequests[0]?.messages.some((m) => m.role === "user" && m.content === "please look at /src/a.ts") === true);
  }
  {
    const s = await setup([final("ok")], { commandsDir: undefined });
    const events = await s.run("/greet x");
    check("with no commands folder, a custom command does not exist", s.provider.receivedRequests.length === 0 && events.some((e) => e.type === "text" && e.text.includes("/greet")));
  }
  {
    const s = await setup([final("ok")]);
    const events = await s.run("/compact");
    check("/compact on a short conversation says there is nothing to compact", s.provider.receivedRequests.length === 0 && events.some((e) => e.type === "text" && /not enough/i.test(e.text)) && events[events.length - 1]?.type === "done");
  }
  {
    const history: ChatMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "first request" }];
    for (let i = 0; i < 10; i++) {
      history.push({ role: "assistant", content: "", tool_calls: [{ id: `r${i}`, name: "read_file", arguments: { path: `f${i}.ts` } }] });
      history.push({ role: "tool", tool_call_id: `r${i}`, name: "read_file", content: `CONTENT-${i}` });
    }
    const s = await setup([final("A summary of ten file reads."), final("next answer")], { initialMessages: history });
    const before = getLiveSessionSnapshot(s.registry, s.sessionId)!.messages.length;
    const events = await s.run("/compact");
    const after = getLiveSessionSnapshot(s.registry, s.sessionId)!.messages;
    check("/compact summarises a long conversation even when it is far from the context limit", after.length < before && after.some((m) => m.content.includes("A summary of ten file reads.")));
    check("the user's own request survives /compact word for word", after.some((m) => m.role === "user" && m.content === "first request"));
    const done = events[events.length - 1];
    check("/compact reports what it did and ends with done", done?.type === "done" && done.success && /Compacted/.test(done.summary));
    await s.run("carry on");
    check("the session keeps working after /compact", s.provider.receivedRequests.length === 2);
  }
} finally {
  await fs.rm(base, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
