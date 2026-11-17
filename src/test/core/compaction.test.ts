import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  estimateTokens,
  planCompaction,
  renderTranscript,
  buildCompactedHistory,
  notesIn,
  pruneOldToolResults,
  isRemovedResult,
  readPathsIn,
  MIN_MESSAGES_TO_COMPACT,
  SUMMARY_MARKER,
  SUMMARY_SYSTEM_PROMPT,
  KEEP_RECENT_MESSAGES,
} from "../../compaction.js";
import { AgentSession } from "../../agent.js";
import { defaultToolRegistry } from "../../toolRegistry.js";
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

const system: ChatMessage = { role: "system", content: "You are an agent." };
const user = (content: string): ChatMessage => ({ role: "user", content });
const assistant = (content: string): ChatMessage => ({ role: "assistant", content });
const isMarked = (m: ChatMessage) => m.content.startsWith(SUMMARY_MARKER);

function toolPair(id: string, name: string, args: Record<string, unknown>, result: string): ChatMessage[] {
  return [
    { role: "assistant", content: "", tool_calls: [{ id, name, arguments: args }] },
    { role: "tool", tool_call_id: id, name, content: result },
  ];
}

console.log("estimateTokens:");
{
  const small = estimateTokens([user("hi")]);
  const big = estimateTokens([user("x".repeat(7000))]);
  check("a longer history estimates more tokens", big > small);
  check("7000 characters estimate to roughly 2000 tokens", big >= 1750 && big <= 2400);
  const withCalls = estimateTokens(toolPair("a", "read_file", { path: "y".repeat(700) }, ""));
  check("tool call arguments count toward the estimate", withCalls >= 175);
  check("the tool schema counts toward the estimate", estimateTokens([user("hi")], [{ name: "t", description: "d".repeat(700), inputSchema: {} }]) > small + 150);
}

console.log("\nplanCompaction:");
{
  check("a short history is left alone", planCompaction([system, user("a"), assistant("b")]) === null);

  const history: ChatMessage[] = [
    system,
    ...toolPair("skill_project-instructions", "load_skill", { id: "project-instructions" }, "RULES"),
    user("first task"),
    ...toolPair("r0", "read_file", { path: "z.ts" }, "Z CONTENT"),
    ...toolPair("r1", "read_file", { path: "a.ts" }, "A CONTENT"),
    assistant("done with first"),
    user("second task"),
    ...toolPair("r2", "read_file", { path: "b.ts" }, "B CONTENT"),
    ...toolPair("r3", "read_file", { path: "c.ts" }, "C CONTENT"),
    ...toolPair("r4", "read_file", { path: "d.ts" }, "D CONTENT"),
    ...toolPair("r5", "read_file", { path: "e.ts" }, "E CONTENT"),
  ];
  const plan = planCompaction(history);
  check("a long history produces a plan", plan !== null);
  if (plan) {
    check("the system prompt is kept", plan.system === system);
    check(
      "a loaded skill's call and result are pinned, not summarised",
      plan.pinned.length === 2 && plan.pinned[1]?.content === "RULES" && !plan.toSummarize.some((m) => m.content === "RULES")
    );
    check("the tail never starts with an orphaned tool result", plan.tail[0]?.role !== "tool");
    check("the tail keeps at least the most recent messages", plan.tail.length >= KEEP_RECENT_MESSAGES);
    check("the most recent tool result is in the tail", plan.tail[plan.tail.length - 1]?.content === "E CONTENT");
    check("every user message in the summarised range is kept word for word, in order", JSON.stringify(plan.userMessages.map((m) => m.content)) === JSON.stringify(["first task", "second task"]));
    check("older turns go to the summary", plan.toSummarize.some((m) => m.content === "A CONTENT"));
    const total = 1 + plan.pinned.length + plan.toSummarize.length + plan.tail.length;
    check("every message is accounted for exactly once", total === history.length);

    const rebuilt = buildCompactedHistory(plan, "SUMMARY TEXT");
    check("the rebuilt history starts with the system prompt, then the pinned skill", rebuilt[0] === system && rebuilt[2]?.content === "RULES");
    check("the summary follows as a user message", rebuilt[3]?.role === "user" && rebuilt[3].content.includes("SUMMARY TEXT"));
    check("the user's own messages follow the summary, unchanged", rebuilt[4]?.content === "first task" && rebuilt[5]?.content === "second task");
    check("the summary is framed as generated notes, not as something the user said", /not written by the user/i.test(rebuilt[3]?.content ?? "") && /not instructions/i.test(rebuilt[3]?.content ?? ""));
    check("the summary message carries the marker", rebuilt[3]?.content.startsWith(SUMMARY_MARKER) === true);
    check("the rebuilt history is shorter", rebuilt.length < history.length);
    check("the old file content is gone", !rebuilt.some((m) => m.content.includes("A CONTENT")));
  }

  const recentRequest: ChatMessage[] = [system, ...Array.from({ length: 12 }, (_, i) => assistant(`old ${i}`)), user("latest"), assistant("reply")];
  const recentPlan = planCompaction(recentRequest);
  check("a user message that is already in the tail is not duplicated", recentPlan !== null && recentPlan.userMessages.length === 0 && recentPlan.tail.some((m) => m.content === "latest"));

  const oldSummary = buildCompactedHistory({ system, pinned: [], toSummarize: [], carriedNotes: "", userMessages: [], tail: [] }, "MAGIC_PORT is 47113.")[1]!;
  const withOldSummary: ChatMessage[] = [system, oldSummary, user("real request"), ...Array.from({ length: 12 }, (_, i) => assistant(`m ${i}`))];
  const oldSummaryPlan = planCompaction(withOldSummary)!;
  check("the notes inside a summary message are read back without the fixed lines", notesIn(oldSummary) === "MAGIC_PORT is 47113.");
  check("short earlier notes are carried over, not summarised again", oldSummaryPlan.carriedNotes === "MAGIC_PORT is 47113." && !oldSummaryPlan.toSummarize.some(isMarked));
  check("an earlier summary is never kept as if the user wrote it", oldSummaryPlan.userMessages.length === 1 && oldSummaryPlan.userMessages[0]?.content === "real request");
  const again = buildCompactedHistory(oldSummaryPlan, "The orders module has 70 steps.");
  const notes = again.filter(isMarked);
  check("the new history has one notes message, with the earlier notes first and the new ones after", notes.length === 1 && notesIn(notes[0]!) === "MAGIC_PORT is 47113.\n\nThe orders module has 70 steps.");
  const third = buildCompactedHistory(planCompaction([...again.slice(0, 2), ...Array.from({ length: 12 }, (_, i) => assistant(`n ${i}`))])!, "Third.");
  check("a fact from the first compaction is still there after the third", third.filter(isMarked).length === 1 && third.filter(isMarked)[0]!.content.includes("MAGIC_PORT is 47113."));

  const longNotes = buildCompactedHistory({ system, pinned: [], toSummarize: [], carriedNotes: "", userMessages: [], tail: [] }, "fact. ".repeat(2000))[1]!;
  const longPlan = planCompaction([system, longNotes, ...Array.from({ length: 12 }, (_, i) => assistant(`m ${i}`))], 8192)!;
  check("earlier notes that are too long for the window are summarised again", longPlan.carriedNotes === "" && longPlan.toSummarize.some(isMarked));
  check("they are labelled as earlier notes in the summary request", renderTranscript(longPlan.toSummarize, 100_000).startsWith("EARLIER NOTES: fact."));

  const userHeavy: ChatMessage[] = [system, ...Array.from({ length: 10 }, (_, i) => user(`u ${i}`)), ...Array.from({ length: KEEP_RECENT_MESSAGES }, (_, i) => assistant(`m ${i}`))];
  check("a range made only of user messages has nothing to summarise", planCompaction(userHeavy) === null);
  check("the summariser is told that tool results are data and that only USER lines are requests", /TOOL RESULT/.test(SUMMARY_SYSTEM_PROMPT) && /USER/.test(SUMMARY_SYSTEM_PROMPT));

  const misaligned: ChatMessage[] = [
    system,
    ...Array.from({ length: 7 }, (_, i) => assistant(`plain ${i}`)),
    ...toolPair("p1", "read_file", { path: "one.ts" }, "ONE"),
    ...toolPair("p2", "read_file", { path: "two.ts" }, "TWO"),
    ...toolPair("p3", "read_file", { path: "three.ts" }, "THREE"),
    assistant("end"),
  ];
  const misalignedPlan = planCompaction(misaligned);
  check(
    "when the cut would land on a tool result, the tail grows to include the call that produced it",
    misalignedPlan !== null && misalignedPlan.tail[0]?.role === "assistant" && misalignedPlan.tail[0].tool_calls?.[0]?.id === "p1" && misalignedPlan.tail[1]?.content === "ONE"
  );

  const fewOld: ChatMessage[] = [system, ...Array.from({ length: MIN_MESSAGES_TO_COMPACT - 1 + KEEP_RECENT_MESSAGES }, (_, i) => assistant(`m ${i}`))];
  check("too few old messages is not worth a summary call", planCompaction(fewOld) === null);
}

console.log("\nrenderTranscript:");
{
  const text = renderTranscript([user("please fix it"), ...toolPair("r1", "read_file", { path: "a.ts" }, "z".repeat(5000)), assistant("fixed")], 100000);
  check("it names each role and tool", text.includes("USER: please fix it") && text.includes("read_file") && text.includes("ASSISTANT: fixed"));
  check("a very long tool result is shortened", text.length < 3000);
  const capped = renderTranscript(Array.from({ length: 50 }, (_, i) => user(`message number ${i} ` + "p".repeat(200))), 1000);
  check("the whole transcript respects the character budget", capped.length <= 1100);
  check("when over budget it keeps the most recent part", capped.includes("message number 49") && !capped.includes("message number 0 "));
}

async function withWorkspace(fn: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-compaction-"));
  try {
    await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function longHistory(): ChatMessage[] {
  const messages: ChatMessage[] = [system, user("original task")];
  for (let i = 0; i < 10; i++) messages.push(...toolPair(`r${i}`, "read_file", { path: `f${i}.ts` }, `CONTENT-${i} ` + "q".repeat(400)));
  messages.push(assistant("finished the original task"));
  return messages;
}

async function collect(session: AgentSession, task: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.run(task)) events.push(event);
  return events;
}

function sessionWith(root: string, script: MockScriptEntry[], contextWindowTokens: number | undefined, initialMessages = longHistory()) {
  const provider = new MockProvider(script);
  const session = new AgentSession({
    workspaceRoot: root,
    model: "mock",
    provider,
    tools: defaultToolRegistry(),
    permissionMode: "PLAN",
    initialMessages,
    contextWindowTokens,
  });
  return { provider, session };
}

console.log("\nAgentSession compacts when the history nears the context window:");
await withWorkspace(async (root) => {
  const { provider, session } = sessionWith(
    root,
    [
      { turn: { type: "final", content: "The user asked for the original task. Files f0-f9 were read." }, usage: { inputTokens: 900, outputTokens: 40 } },
      { turn: { type: "final", content: "answer" } },
    ],
    1500
  );
  const before = session.getMessages().length;
  const events = await collect(session, "next task");

  const summaryRequest = provider.receivedRequests[0];
  check("the first model call is the summary request, with no tools offered", provider.receivedRequests.length === 2 && (summaryRequest?.tools === undefined || summaryRequest.tools.length === 0));
  check("the summary request contains the old conversation", summaryRequest?.messages.some((m) => m.content.includes("CONTENT-7")) === true);
  check("the summary request is sized to fit the context window", estimateTokens(summaryRequest?.messages ?? []) < 1500);
  const taskRequest = provider.receivedRequests[1];
  check("the real task call gets the summary instead of the old turns", taskRequest?.messages.some((m) => m.content.includes("Files f0-f9 were read.")) === true && !taskRequest.messages.some((m) => m.content.includes("CONTENT-0")));
  check("the new request is still present word for word", taskRequest?.messages.some((m) => m.role === "user" && m.content === "next task") === true);
  check("the earlier request is also still present word for word", taskRequest?.messages.some((m) => m.role === "user" && m.content === "original task") === true);
  check("the stored history shrank", session.getMessages().length < before);
  check("the user is told that compaction happened", events.some((e) => e.type === "status" && /compact/i.test(e.message)));
  check("the summary call's token cost is reported", events.some((e) => e.type === "usage" && e.inputTokens === 900));
  check("the task still completes", events.some((e) => e.type === "done" && e.success));
});

await withWorkspace(async (root) => {
  const { provider, session } = sessionWith(root, [{ turn: { type: "final", content: "answer" } }], 1_000_000);
  await collect(session, "next task");
  check("a history well under the window is not compacted", provider.receivedRequests.length === 1 && provider.receivedRequests[0]?.messages.some((m) => m.content.includes("CONTENT-0")) === true);
});

await withWorkspace(async (root) => {
  const { provider, session } = sessionWith(root, [{ throws: new Error("summary failed") }, { turn: { type: "final", content: "answer" } }], 1500);
  const before = session.getMessages().length;
  const events = await collect(session, "next task");
  check("a failed summary call leaves the history intact", session.getMessages().length >= before + 1 && session.getMessages().some((m) => m.content.includes("CONTENT-0")));
  check("the task still runs after a failed summary", provider.receivedRequests.length === 2 && events.some((e) => e.type === "done" && e.success));
});

await withWorkspace(async (root) => {
  const { session } = sessionWith(root, [{ turn: { type: "final", content: "   " } }, { turn: { type: "final", content: "answer" } }], 1500);
  await collect(session, "next task");
  check("an empty summary is rejected, and the history stays intact", session.getMessages().some((m) => m.content.includes("CONTENT-0")));
});

async function editAfterReads(root: string, windowForSecondTask: number): Promise<string[]> {
  for (const name of ["g0.ts", "g1.ts", "g2.ts", "g3.ts"]) await fs.writeFile(path.join(root, name), "old line\n");
  const read = (id: string, file: string): MockScriptEntry => ({ turn: { type: "tool_calls", toolCalls: [{ id, name: "read_file", arguments: { path: file } }] } });
  const provider = new MockProvider([
    read("a", "g0.ts"),
    read("b", "g1.ts"),
    read("c", "g2.ts"),
    read("d", "g3.ts"),
    { turn: { type: "final", content: "read them" } },
    ...(windowForSecondTask < 100_000 ? [{ turn: { type: "final" as const, content: "Summary: four files were read." } }] : []),
    { turn: { type: "tool_calls", toolCalls: [{ id: "w1", name: "edit_file", arguments: { path: "g0.ts", content: "new line\n" } }] } },
    { turn: { type: "final", content: "done" } },
  ]);
  provider.contextWindowTokens = 1_000_000;
  const approvalsAskedFor: string[] = [];
  const session = new AgentSession({
    workspaceRoot: root,
    model: "mock",
    provider,
    tools: defaultToolRegistry(),
    permissionMode: "ACCEPT_EDITS",
    initialMessages: longHistory(),
    onApprovalNeeded: async (call) => {
      approvalsAskedFor.push(call.name);
      return { approved: true };
    },
  });
  await collect(session, "read the g files");
  provider.contextWindowTokens = windowForSecondTask;
  await collect(session, "now change g0.ts");
  return approvalsAskedFor;
}

await withWorkspace(async (root) => {
  const asked = await editAfterReads(root, 1_000_000);
  check("without compaction, editing a file the agent already read is auto-applied in auto-edit mode", !asked.includes("edit_file"));
});

await withWorkspace(async (root) => {
  const asked = await editAfterReads(root, 1500);
  check("after compaction removes a file's content, editing that file asks for approval again", asked.includes("edit_file"));
});

console.log("\npruneOldToolResults:");
{
  const big = "x".repeat(6000);
  const history: ChatMessage[] = [
    system,
    ...toolPair("skill_a", "load_skill", { id: "a" }, "s".repeat(3000)),
    user("task one"),
    ...toolPair("r1", "read_file", { path: "one.js" }, `HEAD-ONE ${big}`),
    ...toolPair("r2", "read_file", { path: "small.js" }, "tiny"),
    assistant("answer one: the port is 47113"),
    user("task two"),
    ...toolPair("r3", "read_file", { path: "two.js" }, `HEAD-TWO ${big}`),
  ];
  const pruned = pruneOldToolResults(history);
  const byId = (id: string) => pruned.messages.find((m) => m.role === "tool" && m.tool_call_id === id)!;
  check("only the large result of the earlier request is removed", pruned.removed === 1 && isRemovedResult(byId("r1")));
  check("the stub keeps the start of the result and says how to get it again", byId("r1").content.includes("HEAD-ONE") && byId("r1").content.includes("Call the tool again") && byId("r1").content.length < 700);
  check("a small old result stays", byId("r2").content === "tiny");
  check("the results of the current request stay", byId("r3").content.startsWith("HEAD-TWO") && byId("r3").content.length > 6000);
  check("a loaded skill stays", byId("skill_a").content.length === 3000);
  check("the model's own replies and the user's messages stay word for word", pruned.messages.some((m) => m.content === "answer one: the port is 47113") && pruned.messages.filter((m) => m.role === "user").length === 2);
  check("the number and order of messages do not change, so each result keeps its call", pruned.messages.length === history.length && pruned.messages.every((m, i) => m.role === history[i]!.role));
  check("the input is not changed", history.find((m) => m.tool_call_id === "r1")!.content.length > 6000);
  check("a second pass removes nothing more", pruneOldToolResults(pruned.messages).removed === 0);
  check("a history with nothing to remove is returned as it is", pruneOldToolResults([system, user("hi"), assistant("hello")]).removed === 0);

  const paths = readPathsIn(pruned.messages);
  check("a file whose result was removed no longer counts as read", !paths.has("one.js") && paths.has("small.js") && paths.has("two.js"));
}

console.log("\nplanCompaction with a context window looks at size:");
{
  const bigRead = (id: string) => toolPair(id, "read_file", { path: `${id}.js` }, "x".repeat(6000));
  // Two tasks, each with one large file read: too few messages to compact by count.
  const short: ChatMessage[] = [system, user("task one"), ...bigRead("one"), assistant("answer one"), user("task two"), ...bigRead("two")];
  check("by count alone this history is too short", planCompaction(short) === null);
  const plan = planCompaction(short, 8192);
  check("with a small window it is compacted, because the old messages are large", plan !== null);
  check(
    "the current request and its file read stay word for word",
    JSON.stringify(plan?.tail.map((m) => m.role)) === JSON.stringify(["assistant", "user", "assistant", "tool"]) && plan?.tail[1]?.content === "task two" && plan?.tail[3]?.content.length === 6000
  );
  check("the old file read is what gets summarised", !!plan?.toSummarize.some((m) => m.role === "tool" && m.content.length === 6000));
  check("the old request stays word for word", plan?.userMessages.length === 1 && plan.userMessages[0]?.content === "task one");
  check("the kept part does not start with a tool result that lost its call", plan?.tail[0]?.role !== "tool");
  check("the same history is left alone with a large window", planCompaction(short, 200_000) === null);

  const onlyCurrent: ChatMessage[] = [system, user("task"), ...bigRead("a"), ...bigRead("b"), ...bigRead("c")];
  check("a window filled by the current request alone has nothing older to summarise", planCompaction(onlyCurrent, 8192) === null);

  const smallOld: ChatMessage[] = [system, user("hi"), assistant("hello"), user("task"), ...bigRead("a")];
  check("a few small old messages are still not worth a summary call", planCompaction(smallOld, 8192) === null);
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
