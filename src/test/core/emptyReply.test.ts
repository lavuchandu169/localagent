import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { AgentSession } from "../../agent.js";
import { defaultToolRegistry } from "../../toolRegistry.js";
import { MockProvider } from "../../providers/mockProvider.js";
import type { AgentEvent, ChatResponse } from "../../types.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

const final = (content: string): ChatResponse => ({ turn: { type: "final", content } });

async function run(root: string, script: ChatResponse[], task = "what is in this project?") {
  const provider = new MockProvider(script);
  const session = new AgentSession({ workspaceRoot: root, model: "mock", provider, tools: defaultToolRegistry(), permissionMode: "PLAN" });
  const events: AgentEvent[] = [];
  for await (const event of session.run(task)) events.push(event);
  const done = events.find((e) => e.type === "done") as Extract<AgentEvent, { type: "done" }> | undefined;
  return { events, done, session, texts: events.filter((e) => e.type === "text").map((e: any) => e.text as string) };
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-empty-reply-"));
try {
  await fs.writeFile(path.join(root, "a.txt"), "hello\n");

  console.log("an empty reply from the model:");
  {
    const r = await run(root, [final(""), final("Here is the answer.")]);
    check("is asked for again one time", r.events.some((e) => e.type === "status" && e.message.includes("empty reply")));
    check("the second reply is the answer", r.done?.success === true && r.done.summary === "Here is the answer." && r.texts.join("") === "Here is the answer.");
    check("the empty reply is not kept in the conversation", !r.session.getMessages().some((m) => m.role === "assistant" && m.content === "" && !m.tool_calls));
  }
  {
    const r = await run(root, [final("  \n "), final("")]);
    check("two empty replies end the task as a failure", r.done?.success === false);
    check("the message tells the user what to do", !!r.done?.summary.includes("empty reply") && !!r.done?.summary.includes("/compact"));
    check("no empty text is shown", r.texts.length === 0);
  }
  {
    const r = await run(root, [
      { turn: { type: "tool_calls", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] } },
      final(""),
      final(""),
    ]);
    check("after real tool work, two empty replies still end as a success", r.done?.success === true);
    check("with a closing line that says the model gave none", r.texts.length === 1 && r.texts[0]!.includes("no closing message"));
  }
  {
    const r = await run(root, [final(""), final("first answer"), final(""), final("second answer")]);
    const events: AgentEvent[] = [];
    for await (const event of r.session.run("and again")) events.push(event);
    const done = events.find((e) => e.type === "done") as any;
    check("the retry is counted for each task, so a later task gets its own", r.done?.summary === "first answer" && done?.success === true && done.summary === "second answer");
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
