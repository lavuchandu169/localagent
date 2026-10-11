// src/test/agentStreaming.test.ts
import { AgentSession } from "../../agent.js";
import { ToolRegistry } from "../../toolRegistry.js";
import type { ModelProvider, StreamEvent, ChatResponse, AgentEvent } from "../../types.js";
import { ProviderChatError } from "../../types.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

async function collectEvents(session: AgentSession, task: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.run(task)) events.push(event);
  return events;
}

/** A minimal streaming provider: yields exactly the StreamEvents it's given, then the fixed final response. */
function fakeStreamingProvider(events: StreamEvent[]): ModelProvider {
  return {
    id: "fake-streaming",
    async listModels() {
      return [{ id: "fake-model", local: false }];
    },
    async healthCheck() {
      return { ok: true };
    },
    async chat(): Promise<ChatResponse> {
      throw new Error("chat() should not be called when chatStream is present");
    },
    async *chatStream(): AsyncGenerator<StreamEvent> {
      for (const e of events) yield e;
    },
  };
}

console.log("agent.ts streams text.delta/tool_call.start/tool_call.delta from chatStream:");
{
  const response: ChatResponse = { turn: { type: "final", content: "hello world" } };
  const provider = fakeStreamingProvider([
    { type: "text", text: "hello " },
    { type: "text", text: "world" },
    { type: "done", response },
  ]);
  const session = new AgentSession({ workspaceRoot: "/tmp", model: "fake-model", provider, tools: new ToolRegistry([]), permissionMode: "DEFAULT" });
  const events = await collectEvents(session, "say hello");
  const deltas = events.filter((e) => e.type === "text.delta") as { type: "text.delta"; text: string }[];
  check("yields a text.delta per StreamEvent text chunk", deltas.length === 2 && deltas[0]!.text === "hello " && deltas[1]!.text === "world");
  check("still yields the existing final text event with the full content", events.some((e) => e.type === "text" && e.text === "hello world"));
}

{
  const response: ChatResponse = { turn: { type: "tool_calls", toolCalls: [{ id: "call_0", name: "read_file", arguments: { path: "a.txt" } }] } };
  const provider = fakeStreamingProvider([
    { type: "tool_call_start", index: 0, name: "read_file" },
    { type: "tool_call_delta", index: 0, argumentsDelta: '{"path"' },
    { type: "tool_call_delta", index: 0, argumentsDelta: ':"a.txt"}' },
    { type: "done", response },
  ]);
  const session = new AgentSession({ workspaceRoot: "/tmp", model: "fake-model", provider, tools: new ToolRegistry([]), permissionMode: "PLAN" });
  const allEvents = await collectEvents(session, "read a.txt");
  // The fake provider is stateless (replays the same fixed events on every
  // turn), and no "read_file" tool is registered, so the agent loop keeps
  // re-invoking chatStream turn after turn until max-turns — only the
  // FIRST turn's streaming output is what this test cares about.
  const secondStatusIndex = allEvents.findIndex(
    (e, i) => e.type === "status" && (e as any).message.startsWith("Turn") && i > 0
  );
  const events = secondStatusIndex === -1 ? allEvents : allEvents.slice(0, secondStatusIndex);
  const starts = events.filter((e) => e.type === "tool_call.start");
  const deltas = events.filter((e) => e.type === "tool_call.delta") as { type: "tool_call.delta"; index: number; argumentsDelta: string }[];
  check("yields exactly one tool_call.start", starts.length === 1 && (starts[0] as any).name === "read_file");
  check("yields a tool_call.delta per StreamEvent fragment, in order", deltas.length === 2 && deltas[0]!.argumentsDelta === '{"path"' && deltas[1]!.argumentsDelta === ':"a.txt"}');
}

console.log("\nagent.ts resets streaming UI state before a mid-stream fallback retry:");
{
  let callCount = 0;
  const flakyThenFallback: ModelProvider = {
    id: "flaky",
    async listModels() {
      return [{ id: "flaky-model", local: false }];
    },
    async healthCheck() {
      return { ok: true };
    },
    async chat(): Promise<ChatResponse> {
      throw new Error("chat() should not be called");
    },
    async *chatStream(): AsyncGenerator<StreamEvent> {
      callCount++;
      yield { type: "text", text: "partial answer before the drop" };
      throw new ProviderChatError("rate limited", { status: 429, retryable: true });
    },
  };
  const fallbackResponse: ChatResponse = { turn: { type: "final", content: "fresh answer from the fallback" } };
  const fallbackProvider = fakeStreamingProvider([{ type: "text", text: "fresh answer from the fallback" }, { type: "done", response: fallbackResponse }]);

  const session = new AgentSession({
    workspaceRoot: "/tmp",
    model: "flaky-model",
    provider: flakyThenFallback,
    tools: new ToolRegistry([]),
    permissionMode: "DEFAULT",
    fallbackProviders: [{ provider: fallbackProvider, model: "fallback-model", label: "Fallback" }],
  });
  const events = await collectEvents(session, "answer this");

  const partialIndex = events.findIndex((e) => e.type === "text.delta" && (e as any).text === "partial answer before the drop");
  const resetIndex = events.findIndex((e) => e.type === "stream.reset");
  const statusIndex = events.findIndex((e) => e.type === "status" && (e as any).message.includes("retrying"));
  const fallbackDeltaIndex = events.findIndex((e) => e.type === "text.delta" && (e as any).text === "fresh answer from the fallback");
  check("the partial text from the failed provider was actually yielded, not silently swallowed by the throw", partialIndex !== -1);
  check("emits stream.reset AFTER that partial text, before the retry status message", partialIndex < resetIndex && resetIndex !== -1 && statusIndex !== -1 && resetIndex < statusIndex);
  check("the fallback provider's own stream still renders afterward", fallbackDeltaIndex !== -1 && fallbackDeltaIndex > statusIndex);
  check("the flaky provider's own chatStream only ran once (no silent double-retry)", callCount === 1);
}

console.log("\nagent.ts falls back WITHOUT a reset when the stream never yielded anything:");
{
  const neverYields: ModelProvider = {
    id: "silent-fail",
    async listModels() {
      return [{ id: "m", local: false }];
    },
    async healthCheck() {
      return { ok: true };
    },
    async chat(): Promise<ChatResponse> {
      throw new Error("chat() should not be called");
    },
    async *chatStream(): AsyncGenerator<StreamEvent> {
      throw new ProviderChatError("rate limited", { status: 429, retryable: true });
      // eslint-disable-next-line no-unreachable
      yield { type: "text", text: "unreachable" };
    },
  };
  const fallbackResponse: ChatResponse = { turn: { type: "final", content: "ok" } };
  const fallbackProvider = fakeStreamingProvider([{ type: "done", response: fallbackResponse }]);
  const session = new AgentSession({
    workspaceRoot: "/tmp",
    model: "m",
    provider: neverYields,
    tools: new ToolRegistry([]),
    permissionMode: "DEFAULT",
    fallbackProviders: [{ provider: fallbackProvider, model: "fallback-model", label: "Fallback" }],
  });
  const events = await collectEvents(session, "go");
  check("no stream.reset fires when nothing was ever shown", !events.some((e) => e.type === "stream.reset"));
}

console.log("\nagent.ts surfaces a status line when a tool call was recovered from the embedded model's mis-flagged text (user-reported UX finding):");
{
  // Streamed "text" that later turns out to be a recovered fallback call
  // still vanishes via its own stream.reset (embeddedLlama.ts's own
  // behavior, unrelated to this test) — what this proves is that the
  // NEW status line actually appears once recoveredFromTextFallback is
  // set on the final response, regardless of how it got there.
  const response: ChatResponse = {
    turn: { type: "tool_calls", toolCalls: [{ id: "call_0", name: "read_file", arguments: { path: "a.txt" } }], recoveredFromTextFallback: true },
  };
  const provider = fakeStreamingProvider([{ type: "reset" }, { type: "done", response }]);
  const session = new AgentSession({ workspaceRoot: "/tmp", model: "fake-model", provider, tools: new ToolRegistry([]), permissionMode: "PLAN" });
  const events = await collectEvents(session, "read a.txt");
  check(
    "a status line explaining the recovery is emitted",
    events.some((e) => e.type === "status" && e.message.includes("Recovered a tool call"))
  );
}
{
  // The common case — a NORMAL tool call, correctly flagged by the model
  // from the start — must never show this notice. Nothing was recovered.
  const response: ChatResponse = {
    turn: { type: "tool_calls", toolCalls: [{ id: "call_0", name: "read_file", arguments: { path: "a.txt" } }] },
  };
  const provider = fakeStreamingProvider([{ type: "done", response }]);
  const session = new AgentSession({ workspaceRoot: "/tmp", model: "fake-model", provider, tools: new ToolRegistry([]), permissionMode: "PLAN" });
  const events = await collectEvents(session, "read a.txt");
  check(
    "no recovery status line appears for an ordinary, correctly-flagged tool call",
    !events.some((e) => e.type === "status" && e.message.includes("Recovered a tool call"))
  );
}
{
  // A plain final-text answer (the overwhelmingly common case for a
  // non-tool-calling turn) must never show this notice either — the
  // check is specifically gated on turn.type === "tool_calls".
  const response: ChatResponse = { turn: { type: "final", content: "Sure, here's the answer." } };
  const provider = fakeStreamingProvider([{ type: "done", response }]);
  const session = new AgentSession({ workspaceRoot: "/tmp", model: "fake-model", provider, tools: new ToolRegistry([]), permissionMode: "DEFAULT" });
  const events = await collectEvents(session, "answer this");
  check(
    "no recovery status line appears for a plain final-text turn",
    !events.some((e) => e.type === "status" && e.message.includes("Recovered a tool call"))
  );
}

console.log("\nagent.ts passes through a provider's \"perf\" stream events (local-model tokens/sec + context usage):");
{
  const response: ChatResponse = { turn: { type: "final", content: "hi" } };
  const provider = fakeStreamingProvider([
    { type: "text", text: "hi" },
    { type: "perf", tokensPerSecond: 42, contextUsedTokens: 500, contextSizeTokens: 8192 },
    { type: "done", response },
  ]);
  const session = new AgentSession({ workspaceRoot: "/tmp", model: "fake-model", provider, tools: new ToolRegistry([]), permissionMode: "DEFAULT" });
  const events = await collectEvents(session, "hi");
  const perf = events.find((e) => e.type === "perf") as { type: "perf"; tokensPerSecond: number; contextUsedTokens: number; contextSizeTokens: number } | undefined;
  check("a perf StreamEvent becomes a matching perf AgentEvent", perf !== undefined && perf.tokensPerSecond === 42 && perf.contextUsedTokens === 500 && perf.contextSizeTokens === 8192);
}

console.log("\nagent.ts does NOT fire a stream.reset for a provider-fallback retry when the only thing streamed before the failure was a \"perf\" event:");
{
  // perf has no visible partial text/tool-card state of its own (see its
  // own doc comment in types.ts) — a fallback retry's stream.reset exists
  // to clear exactly that kind of state, so a perf-only stream failing
  // over to a fallback provider must behave like the "never yielded
  // anything" case above, not like the "yielded real text" case.
  let callCount = 0;
  const perfOnlyThenFails: ModelProvider = {
    id: "perf-only-then-fails",
    async listModels() {
      return [{ id: "m", local: false }];
    },
    async healthCheck() {
      return { ok: true };
    },
    async chat(): Promise<ChatResponse> {
      throw new Error("chat() should not be called");
    },
    async *chatStream(): AsyncGenerator<StreamEvent> {
      callCount++;
      yield { type: "perf", tokensPerSecond: 15, contextUsedTokens: 100, contextSizeTokens: 8192 };
      throw new ProviderChatError("rate limited", { status: 429, retryable: true });
    },
  };
  const fallbackResponse: ChatResponse = { turn: { type: "final", content: "ok" } };
  const fallbackProvider = fakeStreamingProvider([{ type: "done", response: fallbackResponse }]);
  const session = new AgentSession({
    workspaceRoot: "/tmp",
    model: "m",
    provider: perfOnlyThenFails,
    tools: new ToolRegistry([]),
    permissionMode: "DEFAULT",
    fallbackProviders: [{ provider: fallbackProvider, model: "fallback-model", label: "Fallback" }],
  });
  const events = await collectEvents(session, "go");
  check("the perf event still came through before the failure", events.some((e) => e.type === "perf"));
  check("no stream.reset fires — a perf-only stream has no partial UI state to clear", !events.some((e) => e.type === "stream.reset"));
  check("the fallback still ran exactly once", callCount === 1);
}

console.log("\nagent.ts reports a provider's gpuStatus (if any) once, right after the first successful turn:");
{
  // EmbeddedLlamaProvider sets a plain `gpuStatus` string field once its
  // model finishes loading (Task 7) — this is agent.ts's generic side of
  // reporting it, which doesn't know or care that it's specifically the
  // embedded provider; any ModelProvider exposing this field gets the
  // same treatment.
  const response: ChatResponse = { turn: { type: "final", content: "hi" } };
  const providerWithGpuStatus: ModelProvider & { gpuStatus?: string } = {
    id: "fake-embedded",
    gpuStatus: "Embedded model ready — Metal GPU (32 layers offloaded)",
    async listModels() {
      return [{ id: "m", local: true }];
    },
    async healthCheck() {
      return { ok: true };
    },
    async chat() {
      return response;
    },
  };
  const session = new AgentSession({ workspaceRoot: "/tmp", model: "m", provider: providerWithGpuStatus, tools: new ToolRegistry([]), permissionMode: "DEFAULT" });
  const events = await collectEvents(session, "hi");
  check(
    "yields the provider's gpuStatus as a status event",
    events.some((e) => e.type === "status" && (e as any).message === "Embedded model ready — Metal GPU (32 layers offloaded)")
  );
}
{
  const response: ChatResponse = { turn: { type: "final", content: "hi" } };
  const providerWithoutGpuStatus: ModelProvider = {
    id: "fake-cloud",
    async listModels() {
      return [{ id: "m", local: false }];
    },
    async healthCheck() {
      return { ok: true };
    },
    async chat() {
      return response;
    },
  };
  const session = new AgentSession({ workspaceRoot: "/tmp", model: "m", provider: providerWithoutGpuStatus, tools: new ToolRegistry([]), permissionMode: "DEFAULT" });
  const events = await collectEvents(session, "hi");
  check("a provider with no gpuStatus field never gets a spurious status event for it", !events.some((e) => e.type === "status" && (e as any).message?.startsWith("Embedded model ready")));
}

console.log("\nagent.ts forwards a provider's own StreamEvent 'reset' as AgentEvent stream.reset (final review I5):");
{
  // Distinct from the fallback-retry's own stream.reset (emitted by
  // agent.ts's catch block): this is a provider signaling, on a
  // successful completion, that streamed text it already showed turned
  // out not to be real prose (the embedded provider's text-recovered-
  // tool-call case) and must be discarded before the terminal done.
  const response: ChatResponse = { turn: { type: "tool_calls", toolCalls: [{ id: "call_0", name: "read_file", arguments: { path: "a.txt" } }] } };
  const provider = fakeStreamingProvider([
    { type: "text", text: '{"name": "read_file"' },
    { type: "reset" },
    { type: "done", response },
  ]);
  const session = new AgentSession({ workspaceRoot: "/tmp", model: "fake-model", provider, tools: new ToolRegistry([]), permissionMode: "DEFAULT" });
  const events = await collectEvents(session, "read a.txt");
  const deltaIndex = events.findIndex((e) => e.type === "text.delta");
  const resetIndex = events.findIndex((e) => e.type === "stream.reset");
  check("the streamed (misidentified) text delta was yielded", deltaIndex !== -1);
  check("stream.reset is yielded right after it, discarding it before done", resetIndex !== -1 && resetIndex > deltaIndex);
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
