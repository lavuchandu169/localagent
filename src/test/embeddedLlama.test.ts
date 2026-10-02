// src/test/embeddedLlama.test.ts
import { EmbeddedLlamaProvider, describeGpuStatus } from "../providers/embeddedLlama.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("\nEmbeddedLlamaProvider.chatStream:");
{
  // Fakes getChat()'s resolved LlamaChat: generateResponse fires the
  // streaming callbacks synchronously (as the real library does) before
  // its returned promise resolves, then resolves with the final result —
  // exactly the shape chatStream must bridge through AsyncEventQueue.
  const fakeChat = {
    generateResponse: async (_history: unknown, options: any) => {
      options.onTextChunk?.("Sure, ");
      options.onTextChunk?.("reading it now.");
      return { response: "Sure, reading it now." };
    },
  };
  const provider = new EmbeddedLlamaProvider({ size: "fake-model" });
  (provider as any).chatPromise = Promise.resolve(fakeChat);

  const seen: any[] = [];
  for await (const e of provider.chatStream!({ model: "fake-model", messages: [{ role: "user", content: "read a.txt" }] })) seen.push(e);

  const textEvents = seen.filter((e) => e.type === "text");
  check("yields a text StreamEvent per onTextChunk call", textEvents.length === 2 && textEvents[0].text === "Sure, " && textEvents[1].text === "reading it now.");
  const done = seen.find((e) => e.type === "done");
  check("the terminal done event matches what fromLlamaResult would produce", done?.response.turn.type === "final" && done.response.turn.content === "Sure, reading it now.");
}

{
  const fakeChat = {
    generateResponse: async (_history: unknown, options: any) => {
      options.onFunctionCallParamsChunk?.({ callIndex: 0, functionName: "read_file", paramsChunk: '{"path"', done: false });
      options.onFunctionCallParamsChunk?.({ callIndex: 0, functionName: "read_file", paramsChunk: ':"a.txt"}', done: true });
      return { response: "", functionCalls: [{ functionName: "read_file", params: { path: "a.txt" } }] };
    },
  };
  const provider = new EmbeddedLlamaProvider({ size: "fake-model" });
  (provider as any).chatPromise = Promise.resolve(fakeChat);

  const seen: any[] = [];
  for await (const e of provider.chatStream!({ model: "fake-model", messages: [{ role: "user", content: "read a.txt" }], tools: [{ name: "read_file", description: "", inputSchema: {} }] })) seen.push(e);

  const start = seen.find((e) => e.type === "tool_call_start");
  check("tool_call_start fires once, on the FIRST paramsChunk for a callIndex", start?.index === 0 && start?.name === "read_file");
  const deltas = seen.filter((e) => e.type === "tool_call_delta");
  check("tool_call_delta fires once per paramsChunk, in order", deltas.length === 2 && deltas[0].argumentsDelta === '{"path"' && deltas[1].argumentsDelta === ':"a.txt"}');
  const done = seen.find((e) => e.type === "done");
  check("the terminal done event's tool call matches fromLlamaResult's own parsing", done?.response.turn.type === "tool_calls" && done.response.turn.toolCalls[0]?.name === "read_file");
}

{
  // A rejected generateResponse() must propagate to the consumer of
  // chatStream, not hang or silently swallow the failure.
  const fakeChat = {
    generateResponse: async () => {
      throw new Error("model crashed mid-generation");
    },
  };
  const provider = new EmbeddedLlamaProvider({ size: "fake-model" });
  (provider as any).chatPromise = Promise.resolve(fakeChat);

  let threw: any = null;
  try {
    for await (const _e of provider.chatStream!({ model: "fake-model", messages: [{ role: "user", content: "hi" }] })) {
      // no-op
    }
  } catch (err) {
    threw = err;
  }
  check("a generateResponse() rejection propagates to the chatStream consumer", threw instanceof Error && threw.message === "model crashed mid-generation");
}

console.log("\nEmbeddedLlamaProvider GPU-status diagnostic:");
{
  // loadChat() itself touches the real node-llama-cpp module (getLlama,
  // resolveModelFile) which this test can't invoke directly without a
  // real model file — so this pins the DECISION LOGIC in isolation by
  // calling the provider with a getChat() already short-circuited (same
  // technique as the chatStream tests above), then manually exercising
  // the same condition loadChat() uses, via a tiny exported pure helper
  // rather than re-deriving the string inline here and risking the two
  // copies drifting apart.
  check("GPU backend + offloaded layers produces a GPU-acceleration message", describeGpuStatus("metal", 32) === "Embedded model ready — Metal GPU (32 layers offloaded)");
  check("no GPU backend produces a CPU-only message", describeGpuStatus(false, 0) === "Embedded model ready — CPU only (no GPU backend detected)");
  check("a GPU backend present but zero layers offloaded still reports CPU only (nothing is actually accelerated)", describeGpuStatus("cuda", 0) === "Embedded model ready — CPU only (no GPU backend detected)");
}

console.log("\nEmbeddedLlamaProvider.chatStream discards text recovered as a fallback tool call (final review I5):");
{
  // Some GGUF quantizations mis-flag their <tool_call> control token, so
  // the model's intended tool call streams through onTextChunk looking
  // like prose, but is actually serialized JSON — fromLlamaResult's own
  // tryParseFallbackToolCall recovers the real call from it afterward.
  // The streamed "text" was never real prose, so it must be discarded
  // (via a StreamEvent "reset") before the terminal done, not left
  // visible above the tool card that recovery produces.
  const fallbackJson = '{"name": "read_file", "arguments": {"path": "a.txt"}}';
  const fakeChat = {
    generateResponse: async (_history: unknown, options: any) => {
      options.onTextChunk?.(fallbackJson);
      return { response: fallbackJson };
    },
  };
  const provider = new EmbeddedLlamaProvider({ size: "fake-model" });
  (provider as any).chatPromise = Promise.resolve(fakeChat);

  const seen: any[] = [];
  for await (const e of provider.chatStream!({ model: "fake-model", messages: [{ role: "user", content: "read a.txt" }] })) seen.push(e);

  const textIndex = seen.findIndex((e) => e.type === "text");
  const resetIndex = seen.findIndex((e) => e.type === "reset");
  const done = seen.find((e) => e.type === "done");
  check("the misidentified text was streamed", textIndex !== -1);
  check("a reset event discards it before the terminal done", resetIndex !== -1 && resetIndex > textIndex);
  check("the terminal done event still correctly surfaces the recovered tool call", done?.response.turn.type === "tool_calls" && done.response.turn.toolCalls[0]?.name === "read_file");
}

{
  // A genuine final-text response (never matching the fallback shape)
  // must NOT get a spurious reset — only the fallback-recovery case does.
  const fakeChat = {
    generateResponse: async (_history: unknown, options: any) => {
      options.onTextChunk?.("Just a normal answer.");
      return { response: "Just a normal answer." };
    },
  };
  const provider = new EmbeddedLlamaProvider({ size: "fake-model" });
  (provider as any).chatPromise = Promise.resolve(fakeChat);

  const seen: any[] = [];
  for await (const e of provider.chatStream!({ model: "fake-model", messages: [{ role: "user", content: "hi" }] })) seen.push(e);
  check("a genuine text response never gets a spurious reset", !seen.some((e) => e.type === "reset"));
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
