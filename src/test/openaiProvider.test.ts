import { OpenAIProvider } from "../providers/openaiProvider.js";
import { ProviderChatError } from "../types.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("OpenAI provider:");

{
  const provider = new OpenAIProvider({ apiKey: "test-key" });
  check("id is 'openai'", provider.id === "openai");
}

console.log("\nOpenAI provider classifies a 429 as retryable:");
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("rate limit exceeded", { status: 429, statusText: "Too Many Requests" })) as typeof fetch;
  try {
    const provider = new OpenAIProvider({ apiKey: "test-key" });
    try {
      await provider.chat({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] });
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

console.log("\nOpenAI provider does NOT mark a 401 as retryable:");
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("invalid api key", { status: 401, statusText: "Unauthorized" })) as typeof fetch;
  try {
    const provider = new OpenAIProvider({ apiKey: "bad-key" });
    try {
      await provider.chat({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] });
      check("a 401 response throws", false);
    } catch (err) {
      check("a 401 response throws a ProviderChatError", err instanceof ProviderChatError);
      check("that error is NOT retryable", err instanceof ProviderChatError && err.retryable === false);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\nOpenAI provider parses a successful tool-call response:");
{
  const realFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedAuth = "";
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    capturedUrl = url as string;
    capturedAuth = (init?.headers as Record<string, string>)?.["Authorization"] ?? "";
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [{ id: "call_1", function: { name: "read_file", arguments: '{"path":"x.txt"}' } }],
            },
          },
        ],
      }),
      { status: 200 }
    );
  }) as typeof fetch;
  try {
    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    const response = await provider.chat({ model: "gpt-5.5", messages: [{ role: "user", content: "read x.txt" }] });
    check("hits the real OpenAI API base URL", capturedUrl === "https://api.openai.com/v1/chat/completions");
    check("sends the API key as a Bearer token", capturedAuth === "Bearer sk-test");
    check(
      "parses the tool call correctly",
      response.turn.type === "tool_calls" &&
        response.turn.toolCalls[0]?.name === "read_file" &&
        JSON.stringify(response.turn.toolCalls[0]?.arguments) === JSON.stringify({ path: "x.txt" })
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\nOpenAI provider sends max_completion_tokens, not max_tokens:");
{
  // OpenAI's real Chat Completions API rejects the classic max_tokens
  // field outright (a non-retryable 400, "Unsupported parameter: 'max_tokens'
  // ... use 'max_completion_tokens' instead") on its current reasoning-
  // capable model line, unlike the generic OpenAI-COMPATIBLE path (custom
  // self-hosted servers) which this provider's buildChatBody reuse would
  // otherwise inherit unmodified. A real OpenAIProvider request must use
  // the field the real, hosted API actually accepts.
  const realFetch = globalThis.fetch;
  let capturedBody: any = null;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    capturedBody = JSON.parse(init?.body as string);
    return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    await provider.chat({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] });
    check("the sent body does NOT include max_tokens", !("max_tokens" in capturedBody));
    check("the sent body includes max_completion_tokens instead", typeof capturedBody.max_completion_tokens === "number");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\nOpenAIProvider.chatStream:");
{
  const sseBody =
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":" there"}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(sseBody, { status: 200 })) as typeof fetch;
  try {
    const provider = new OpenAIProvider({ apiKey: "test-key" });
    const seen: any[] = [];
    for await (const e of provider.chatStream!({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] })) seen.push(e);
    const textEvents = seen.filter((e) => e.type === "text");
    check("yields a text StreamEvent per delta.content fragment", textEvents.length === 2 && textEvents[0].text === "Hello" && textEvents[1].text === " there");
    const done = seen.find((e) => e.type === "done");
    check("the terminal done event assembles the full text", done?.response.turn.type === "final" && done.response.turn.content === "Hello there");
  } finally {
    globalThis.fetch = realFetch;
  }
}

{
  // OpenAI's own documented accumulator pattern: name arrives on the first
  // delta for a given tool_calls[].index, arguments arrive as fragments to
  // concatenate across later chunks sharing that same index.
  const sseBody =
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"read_file","arguments":""}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\""}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"a.txt\\"}"}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
    "data: [DONE]\n\n";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(sseBody, { status: 200 })) as typeof fetch;
  try {
    const provider = new OpenAIProvider({ apiKey: "test-key" });
    const seen: any[] = [];
    for await (const e of provider.chatStream!({ model: "gpt-5.5", messages: [{ role: "user", content: "read a.txt" }], tools: [] })) seen.push(e);
    const start = seen.find((e) => e.type === "tool_call_start");
    check("tool_call_start fires with the name from the FIRST chunk for that index", start?.index === 0 && start?.name === "read_file");
    const deltas = seen.filter((e) => e.type === "tool_call_delta");
    check(
      "tool_call_delta fires once per argument fragment, concatenating correctly when parsed",
      deltas.length === 2 && JSON.parse(deltas.map((d: any) => d.argumentsDelta).join("")).path === "a.txt"
    );
    const done = seen.find((e) => e.type === "done");
    check("the terminal done event's tool call has the fully-assembled arguments", done?.response.turn.type === "tool_calls" && done.response.turn.toolCalls[0]?.arguments.path === "a.txt");
  } finally {
    globalThis.fetch = realFetch;
  }
}

{
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 429 })) as typeof fetch;
  try {
    const provider = new OpenAIProvider({ apiKey: "test-key" });
    let threw: any = null;
    try {
      for await (const _e of provider.chatStream!({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] })) {
        // no-op
      }
    } catch (err) {
      threw = err;
    }
    check("a non-200 response throws a ProviderChatError, same as chat()", threw instanceof ProviderChatError && threw.retryable === true);
  } finally {
    globalThis.fetch = realFetch;
  }
}

{
  // Review Focus: two parallel tool calls streaming in the SAME turn, with
  // their argument fragments genuinely INTERLEAVED on the wire (index 1's
  // first fragment arrives between index 0's two fragments) — proves
  // accumulation is keyed strictly by `index`, never by arrival order.
  const sseBody =
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"read_file","arguments":""}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"read_file","arguments":""}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"path\\":"}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\\"b.txt\\"}"}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
    "data: [DONE]\n\n";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(sseBody, { status: 200 })) as typeof fetch;
  try {
    const provider = new OpenAIProvider({ apiKey: "test-key" });
    const seen: any[] = [];
    for await (const e of provider.chatStream!({ model: "gpt-5.5", messages: [{ role: "user", content: "read both files" }], tools: [] })) seen.push(e);
    const deltasForIndex0 = seen.filter((e) => e.type === "tool_call_delta" && e.index === 0).map((e) => e.argumentsDelta);
    const deltasForIndex1 = seen.filter((e) => e.type === "tool_call_delta" && e.index === 1).map((e) => e.argumentsDelta);
    check(
      "index 0's fragments never leak into index 1's accumulation, despite interleaved arrival",
      JSON.parse(deltasForIndex0.join("")).path === "a.txt" && JSON.parse(deltasForIndex1.join("")).path === "b.txt"
    );
    const done = seen.find((e) => e.type === "done");
    check(
      "the terminal done event has both tool calls, each with its own correct arguments",
      done?.response.turn.toolCalls.length === 2 && done.response.turn.toolCalls[0]?.arguments.path === "a.txt" && done.response.turn.toolCalls[1]?.arguments.path === "b.txt"
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
