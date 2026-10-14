// src/test/embeddedLlama.test.ts
import { EmbeddedLlamaProvider, describeGpuStatus, fromLlamaResult, maybeSamplePerf, type PerfSamplerState } from "../../providers/embeddedLlama.js";

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

console.log("\nfromLlamaResult keeps explanatory text around a recovered fallback tool call, instead of discarding it (correctness audit: provider Medium #2):");
{
  // tryParseFallbackToolCall's own doc comment explicitly says the
  // recovered call can have "its own explanatory prose before or after"
  // — but the fallback branch returned a tool_calls turn with NO content
  // field at all, silently dropping it (while the genuine-functionCalls
  // branch three lines above keeps `content: result.response`).
  const result = { response: 'I\'ll read that file now.\n{"name": "read_file", "arguments": {"path": "a.txt"}}' };
  const response = fromLlamaResult(result);
  check("still recovers the tool call correctly", response.turn.type === "tool_calls" && response.turn.toolCalls[0]?.name === "read_file");
  check(
    "the explanatory text BEFORE the recovered JSON is preserved as content, not silently dropped",
    response.turn.type === "tool_calls" && typeof response.turn.content === "string" && response.turn.content.includes("I'll read that file now.")
  );
}
{
  const result = { response: '{"name": "read_file", "arguments": {"path": "a.txt"}}\nLet me take a look.' };
  const response = fromLlamaResult(result);
  check(
    "explanatory text AFTER the recovered JSON is preserved too",
    response.turn.type === "tool_calls" && typeof response.turn.content === "string" && response.turn.content.includes("Let me take a look.")
  );
}
{
  // Pure JSON with nothing around it must not fabricate an empty-string
  // content — undefined, matching the genuine-functionCalls branch's own
  // `result.response || undefined`.
  const result = { response: '{"name": "read_file", "arguments": {"path": "a.txt"}}' };
  const response = fromLlamaResult(result);
  check("no surrounding text means content stays undefined, not an empty string", response.turn.type === "tool_calls" && response.turn.content === undefined);
}

console.log("\ntryParseFallbackToolCall's own parsing edge cases, via fromLlamaResult (test-engineer finding, full-project audit — only the simplest bare-JSON shape had coverage before this):");
{
  // A fenced ```json block — tryParseFallbackToolCall's own doc comment
  // says rawMatch is the WHOLE fence when the JSON was inside one, not
  // just the inner JSON, specifically so the fence markers themselves
  // count as "the recovered call" and don't leak into kept content.
  const result = { response: 'Sure, one sec.\n```json\n{"name": "read_file", "arguments": {"path": "a.txt"}}\n```\nDone.' };
  const response = fromLlamaResult(result);
  check("recovers a tool call fenced in a ```json code block", response.turn.type === "tool_calls" && response.turn.toolCalls[0]?.name === "read_file");
  check(
    "the fence markers themselves are excluded from kept content, not left as stray ``` text",
    response.turn.type === "tool_calls" && typeof response.turn.content === "string" && !response.turn.content.includes("```")
  );
  check(
    "text before and after the fence is still preserved",
    response.turn.type === "tool_calls" &&
      typeof response.turn.content === "string" &&
      response.turn.content.includes("Sure, one sec.") &&
      response.turn.content.includes("Done.")
  );
}
{
  // Multiple top-level JSON objects in the same response — the doc
  // comment is explicit that the LAST one wins, since a trailing call is
  // the model's actual next action, not an example it mentioned in
  // passing earlier in its own reasoning.
  const result = {
    response:
      'Earlier I would have called {"name": "read_file", "arguments": {"path": "old.txt"}} but now ' +
      '{"name": "write_file", "arguments": {"path": "new.txt", "content": "hi"}}',
  };
  const response = fromLlamaResult(result);
  check(
    "when multiple JSON objects are present, the LAST one is recovered as the real call",
    response.turn.type === "tool_calls" && response.turn.toolCalls[0]?.name === "write_file"
  );
}
{
  // repairUnescapedQuotes's specific recovery: an otherwise-well-formed
  // object with exactly one unescaped quote left inside a string value —
  // the documented live failure mode from Qwen2.5-Coder 1.5B.
  const result = { response: '{"name": "write_file", "arguments": {"path": "a.txt", "content": "say "hi" to them"}}' };
  const response = fromLlamaResult(result);
  check(
    "a single unescaped quote inside a string value is repaired and still recovered as a valid tool call",
    response.turn.type === "tool_calls" && response.turn.toolCalls[0]?.name === "write_file"
  );
  check(
    "the repaired content value still reads correctly, quote included",
    response.turn.type === "tool_calls" && (response.turn.toolCalls[0]?.arguments as any)?.content === 'say "hi" to them'
  );
}
{
  // A JSON object that parses fine but doesn't match the tool-call shape
  // (no "arguments" key at all) must NOT be recovered as a fallback call
  // — isToolCallShape's whole purpose is rejecting exactly this, falling
  // through to treating the response as genuine final text instead.
  const result = { response: 'Here is some config: {"name": "localagent", "version": "1.0.0"}' };
  const response = fromLlamaResult(result);
  check("a JSON object missing the tool-call shape is not recovered as a tool call", response.turn.type !== "tool_calls");
  check("it's treated as ordinary final text instead", response.turn.type === "final");
}
{
  // arguments present but as an array, not an object — also rejected by
  // isToolCallShape's explicit !Array.isArray(arguments) check.
  const result = { response: '{"name": "read_file", "arguments": ["a.txt"]}' };
  const response = fromLlamaResult(result);
  check("tool-call-shaped JSON with array arguments (not an object) is rejected, not recovered", response.turn.type !== "tool_calls");
}
{
  // No JSON object anywhere at all — the plain final-text path, proving
  // tryParseFallbackToolCall's null return doesn't itself break anything.
  const result = { response: "Just a normal answer with no tool call in it." };
  const response = fromLlamaResult(result);
  check("a response with no JSON at all is left as plain final text", response.turn.type === "final" && response.turn.content === result.response);
}
{
  // A real reported failure, live-tested: Qwen2.5-Coder 1.5B wrapped a
  // multi-line code "content" value in Python-style triple quotes
  // (`"""..."""`) with raw, literal newlines inside — instead of a single
  // `"` pair with the newlines properly escaped as `\n`. repairUnescapedQuotes
  // only ever repairs stray QUOTE characters; it has no way to fix a raw
  // control character sitting inside what's meant to be a JSON string, so
  // this candidate failed both the direct parse and the repair pass and
  // fell all the way through to null — meaning the entire malformed blob
  // (````json` fence, `"name"/"arguments"` structure and all) got shown to
  // the user as garbled literal text instead of either a real tool call or
  // a clean code answer.
  const result = {
    response:
      '```json\n{\n  "name": "edit_file",\n  "arguments": {\n    "path": "binary_search.py",\n    "content": """\ndef binary_search(arr, target):\n    low, high = 0, len(arr) - 1\n    while low <= high:\n        mid = (low + high) // 2\n        if arr[mid] == target:\n            return mid\n        elif arr[mid] < target:\n            low = mid + 1\n        else:\n            high = mid - 1\n    return -1\n"""\n  }\n}\n```',
  };
  const response = fromLlamaResult(result);
  check(
    "a content value wrapped in Python-style triple quotes with raw embedded newlines is still recovered as a real tool call",
    response.turn.type === "tool_calls" && response.turn.toolCalls[0]?.name === "edit_file"
  );
  check(
    "the recovered content value contains the real code with actual newlines, not escaped literal \\n text",
    response.turn.type === "tool_calls" &&
      typeof (response.turn.toolCalls[0]?.arguments as any)?.content === "string" &&
      ((response.turn.toolCalls[0]?.arguments as any).content as string).includes("\n    low, high = 0, len(arr) - 1\n") &&
      ((response.turn.toolCalls[0]?.arguments as any).content as string).includes("def binary_search(arr, target):")
  );
}

console.log("\nmaybeSamplePerf (local-model live tokens/sec + context-usage throttling):");
{
  const state: PerfSamplerState = { lastEmitAtMs: 1000, lastOutputTokens: 10 };
  const result = maybeSamplePerf(state, 1100, 12, 500, 8192, 300);
  check("within the throttle interval, no sample is emitted", result.sample === null);
  check("state is left unchanged when nothing is emitted", result.nextState === state);
}
{
  const state: PerfSamplerState = { lastEmitAtMs: 1000, lastOutputTokens: 10 };
  // 300ms elapsed, 30 new output tokens -> 100 tokens/sec.
  const result = maybeSamplePerf(state, 1300, 40, 500, 8192, 300);
  check("once the interval elapses, a sample is emitted", result.sample !== null);
  check("tokens/sec is computed from the REAL elapsed time and token delta, not a fixed assumption", result.sample?.tokensPerSecond === 100);
  check("context usage is passed through unchanged", result.sample?.contextUsedTokens === 500 && result.sample?.contextSizeTokens === 8192);
  check("the returned state advances to the new emission point, not left stale", result.nextState.lastEmitAtMs === 1300 && result.nextState.lastOutputTokens === 40);
}
{
  // A slower stretch of generation must report a LOWER rate than an
  // earlier faster stretch — proving this is an instantaneous rate
  // since the last sample, not a cumulative average pulled toward the
  // session's historical speed.
  let state: PerfSamplerState = { lastEmitAtMs: 0, lastOutputTokens: 0 };
  const fast = maybeSamplePerf(state, 300, 60, 100, 8192, 300); // 200 tok/s
  state = fast.nextState;
  const slow = maybeSamplePerf(state, 600, 63, 103, 8192, 300); // 10 tok/s
  check("a fast stretch reports a high rate", fast.sample?.tokensPerSecond === 200);
  check("a subsequent slow stretch reports its OWN lower rate, not an average pulled toward the fast one", slow.sample?.tokensPerSecond === 10);
}
{
  const state: PerfSamplerState = { lastEmitAtMs: 1000, lastOutputTokens: 10 };
  const result = maybeSamplePerf(state, 1300, 10, 500, 8192, 300);
  check("zero new tokens since the last sample reports a zero rate, not a division artifact", result.sample?.tokensPerSecond === 0);
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
