import { buildChatBody, OpenAICompatibleProvider, fromOpenAIChatMessage } from "../../providers/openaiCompatible.js";
import type { ChatMessage } from "../../types.js";
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

console.log("buildChatBody:");

{
  const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
  const body: any = buildChatBody({ model: "qwen2.5-coder:latest", messages });
  check("a plain message with no attachments keeps plain string content", body.messages[0].content === "hi");
}

{
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: "what's this",
      images: [{ name: "a.png", mediaType: "image/png", dataBase64: "ZmFrZQ==" }],
    },
  ];
  const body: any = buildChatBody({ model: "some-vision-model", messages });
  const parts = body.messages[0].content;
  check("a message with an image becomes a content-part array", Array.isArray(parts));
  check("the text part comes first", parts[0].type === "text" && parts[0].text === "what's this");
  check(
    "the image becomes an image_url part with a data URI",
    JSON.stringify(parts[1]) === JSON.stringify({ type: "image_url", image_url: { url: "data:image/png;base64,ZmFrZQ==" } })
  );
}

{
  const messages: ChatMessage[] = [
    { role: "user", content: "", images: [{ name: "a.png", mediaType: "image/png", dataBase64: "AAAA" }] },
  ];
  const body: any = buildChatBody({ model: "m", messages });
  const parts = body.messages[0].content;
  check("an attachment-only message has no leading empty text part", parts.length === 1 && parts[0].type === "image_url");
}

{
  const messages: ChatMessage[] = [
    { role: "user", content: "summarize", textAttachments: [{ name: "notes.txt", content: "key point: X" }] },
  ];
  const body: any = buildChatBody({ model: "m", messages });
  check(
    "a text attachment folds into the message's plain string content (no attachment array needed for text)",
    body.messages[0].content === "summarize\n\n--- Attached file: notes.txt ---\nkey point: X\n---"
  );
}

{
  // Existing behavior this task must not disturb: tool_calls / tool_call_id
  // / name still map through exactly as before.
  const messages: ChatMessage[] = [
    { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "read_file", arguments: { path: "a.js" } }] },
    { role: "tool", tool_call_id: "c1", name: "read_file", content: "file contents" },
  ];
  const body: any = buildChatBody({ model: "m", messages });
  check(
    "assistant tool_calls still map to the OpenAI function-call shape",
    JSON.stringify(body.messages[0].tool_calls) === JSON.stringify([{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.js"}' } }])
  );
  check("tool_call_id and name still pass through on a tool message", body.messages[1].tool_call_id === "c1" && body.messages[1].name === "read_file");
}

console.log("\nOpenAICompatibleProvider classifies a 429 as retryable:");
{
  // The freellmapi free-tier router (which delegates all real HTTP work to
  // THIS class — see providers/freellmapiProxy.ts) needs a real,
  // classified 429 to trigger the spec's required fallback-to-cloud-provider
  // behavior when the whole router comes back exhausted. Matches the exact
  // convention already used in openaiProvider.ts/anthropicProvider.ts/
  // geminiProvider.ts: retryable iff status === 429.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("rate limit exceeded", { status: 429, statusText: "Too Many Requests" })) as typeof fetch;
  try {
    const provider = new OpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:8687/v1", local: false });
    try {
      await provider.chat({ model: "auto", messages: [{ role: "user", content: "hi" }] });
      check("a 429 response throws", false);
    } catch (err) {
      check("a 429 response throws a ProviderChatError", err instanceof ProviderChatError);
      check("that error is retryable", err instanceof ProviderChatError && err.retryable === true);
      check("that error carries status 429", err instanceof ProviderChatError && err.status === 429);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\nOpenAICompatibleProvider surfaces a parsed error message instead of a raw JSON blob (correctness audit: FreeLLMAPI Medium #4):");
{
  // FreeLLMAPI's error responses (like most OpenAI-shape servers) carry a
  // real human-readable message inside {error:{message}} — before this
  // fix, the thrown ProviderChatError's .message was the ENTIRE raw JSON
  // body dumped verbatim, which is what a user actually saw on screen for
  // a task failure.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: "no provider key configured for any model", code: "needsKey" } }), {
      status: 400,
      statusText: "Bad Request",
    })) as typeof fetch;
  try {
    const provider = new OpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:8687/v1", local: false });
    try {
      await provider.chat({ model: "auto", messages: [{ role: "user", content: "hi" }] });
      check("a 400 response throws", false);
    } catch (err) {
      check("the thrown message contains the real, human-readable error", err instanceof Error && err.message.includes("no provider key configured for any model"));
      check("the thrown message does NOT dump the raw JSON blob verbatim", err instanceof Error && !err.message.includes('{"error":'));
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}
{
  // A non-JSON (or JSON with no message field) error body still falls back
  // to the raw text — never a crash on malformed/unexpected error shapes.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("<html>502 Bad Gateway</html>", { status: 502, statusText: "Bad Gateway" })) as typeof fetch;
  try {
    const provider = new OpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:8687/v1", local: false });
    try {
      await provider.chat({ model: "auto", messages: [{ role: "user", content: "hi" }] });
      check("a 502 response throws", false);
    } catch (err) {
      check("a non-JSON error body still surfaces the raw text, not a crash", err instanceof Error && err.message.includes("502 Bad Gateway"));
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\nOpenAICompatibleProvider does NOT mark a 500 as retryable:");
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("internal error", { status: 500, statusText: "Internal Server Error" })) as typeof fetch;
  try {
    const provider = new OpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:8687/v1", local: false });
    try {
      await provider.chat({ model: "auto", messages: [{ role: "user", content: "hi" }] });
      check("a 500 response throws", false);
    } catch (err) {
      check("a 500 response throws a ProviderChatError", err instanceof ProviderChatError);
      check("that error is NOT retryable", err instanceof ProviderChatError && err.retryable === false);
      check("that error carries status 500", err instanceof ProviderChatError && err.status === 500);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\nOpenAICompatibleProvider.chatStream:");
{
  const sseBody = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(sseBody, { status: 200 })) as typeof fetch;
  try {
    const provider = new OpenAICompatibleProvider({ baseUrl: "http://localhost:11434/v1", local: true });
    const seen: any[] = [];
    for await (const e of provider.chatStream!({ model: "qwen2.5-coder", messages: [{ role: "user", content: "hi" }] })) seen.push(e);
    check("streams text the same way OpenAIProvider does", seen.some((e) => e.type === "text" && e.text === "Hi"));
    const done = seen.find((e) => e.type === "done");
    check("terminal done event assembles correctly", done?.response.turn.type === "final" && done.response.turn.content === "Hi");
  } finally {
    globalThis.fetch = realFetch;
  }
}

{
  // The confirmed real-world degenerate case: Ollama's own /v1 endpoint
  // sends a tool call's name AND complete arguments together in a single
  // chunk, never split into a separate "name" delta and later "arguments"
  // fragments. Must produce the exact same final result as the
  // many-fragments case — only the EVENT SHAPE differs (one
  // tool_call_start immediately followed by exactly one tool_call_delta
  // carrying the whole string), not the outcome.
  const sseBody =
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_xyz","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
    "data: [DONE]\n\n";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(sseBody, { status: 200 })) as typeof fetch;
  try {
    const provider = new OpenAICompatibleProvider({ baseUrl: "http://localhost:11434/v1", local: true });
    const seen: any[] = [];
    for await (const e of provider.chatStream!({ model: "qwen2.5-coder", messages: [{ role: "user", content: "read a.txt" }], tools: [] })) seen.push(e);
    const start = seen.find((e) => e.type === "tool_call_start");
    check("tool_call_start fires even for a whole-chunk tool call", start?.index === 0 && start?.name === "read_file");
    const deltas = seen.filter((e) => e.type === "tool_call_delta");
    check("exactly one tool_call_delta carries the whole arguments string at once — no artificial fragmentation", deltas.length === 1 && deltas[0].argumentsDelta === '{"path":"a.txt"}');
    const done = seen.find((e) => e.type === "done");
    check("the final result is identical to the many-fragments case", done?.response.turn.type === "tool_calls" && done.response.turn.toolCalls[0]?.arguments.path === "a.txt");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\nOpenAICompatibleProvider.chatStream surfaces an in-band error frame (final review I1):");
{
  // The bundled FreeLLMAPI proxy (and some upstream providers like Groq)
  // can write a 200 SSE response, stream some real content, then emit
  // `{"error":{...}}` mid-stream (headers already sent, so it can't
  // retroactively send a different status code) before [DONE]. Silently
  // treating this as a successful "final" response with truncated content
  // would report a task as done when it actually failed partway through.
  const sseBody =
    'data: {"choices":[{"delta":{"content":"Half an ans"}}]}\n\n' +
    'data: {"error":{"message":"upstream provider failed","type":"stream_error"}}\n\n' +
    "data: [DONE]\n\n";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(sseBody, { status: 200 })) as typeof fetch;
  try {
    const provider = new OpenAICompatibleProvider({ baseUrl: "http://localhost:11434/v1", local: true });
    let threw: any = null;
    const seen: any[] = [];
    try {
      for await (const e of provider.chatStream!({ model: "qwen2.5-coder", messages: [{ role: "user", content: "hi" }] })) seen.push(e);
    } catch (err) {
      threw = err;
    }
    check("an in-band error frame throws instead of yielding a truncated 'done' as success", threw instanceof ProviderChatError);
    check("the already-streamed partial text was still visible to the consumer before the throw", seen.some((e) => e.type === "text" && e.text === "Half an ans"));
    check("no 'done' event is yielded after the error frame", !seen.some((e) => e.type === "done"));
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\nfromOpenAIChatMessage reports real usage from the response, not just Anthropic (correctness audit: provider High #1):");
{
  const raw = {
    choices: [{ message: { content: "hello" } }],
    usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
  };
  const response = fromOpenAIChatMessage(raw.choices[0]!.message, raw);
  check("inputTokens comes from the real prompt_tokens", response.usage?.inputTokens === 12);
  check("outputTokens comes from the real completion_tokens", response.usage?.outputTokens === 7);
}
{
  // A response with no usage field at all (some OpenAI-compatible local
  // servers omit it) must not crash or fabricate numbers.
  const raw = { choices: [{ message: { content: "hello" } }] };
  const response = fromOpenAIChatMessage(raw.choices[0]!.message, raw);
  check("no usage field in the response means no usage on the ChatResponse either, not a crash or a fabricated 0", response.usage === undefined);
}

console.log("\nOpenAICompatibleProvider.chat wraps a non-HTTP failure (fetch itself throwing) in a ProviderChatError (correctness finding — code-review-and-quality pass):");
{
  // Only AnthropicProvider used to wrap its ENTIRE call in a try/catch —
  // every other provider only ever threw a ProviderChatError from its own
  // `if (!res.ok)` branch, so a failure in fetch() ITSELF (network down,
  // DNS, TLS — simulated here by making fetch reject outright) propagated
  // as a bare Error, invisible to agent.ts's
  // `err instanceof ProviderChatError && err.retryable` fallback check.
  // This matters doubly for this class specifically: FreeLLMAPI's proxy
  // (freellmapiProxy.ts) delegates all its real HTTP work to it.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  try {
    const provider = new OpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:8687/v1", local: false });
    try {
      await provider.chat({ model: "whatever", messages: [{ role: "user", content: "hi" }] });
      check("a network failure throws", false);
    } catch (err) {
      check("a network failure is wrapped in a ProviderChatError, not left as a bare Error", err instanceof ProviderChatError);
      check("it's classified non-retryable (it's not a real 429)", err instanceof ProviderChatError && err.retryable === false);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\nOpenAICompatibleProvider.chatStream wraps a non-HTTP failure the same way (correctness finding — code-review-and-quality pass):");
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  try {
    const provider = new OpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:8687/v1", local: false });
    try {
      for await (const _e of provider.chatStream!({ model: "whatever", messages: [{ role: "user", content: "hi" }] })) {
        /* draining */
      }
      check("a network failure throws", false);
    } catch (err) {
      check("a network failure is wrapped in a ProviderChatError, not left as a bare Error", err instanceof ProviderChatError);
      check("it's classified non-retryable (it's not a real 429)", err instanceof ProviderChatError && err.retryable === false);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
