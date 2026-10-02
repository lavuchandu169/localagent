import { toGeminiContents, toGeminiTools, fromGeminiResult, GeminiProvider } from "../providers/geminiProvider.js";
import { ProviderChatError } from "../types.js";
import type { ChatMessage } from "../types.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("Gemini message conversion:");

{
  const { systemInstruction, contents } = toGeminiContents([
    { role: "system", content: "You are careful." },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]);
  check("system message becomes systemInstruction, not a content turn", JSON.stringify(systemInstruction) === JSON.stringify({ parts: [{ text: "You are careful." }] }));
  check(
    "user/assistant turns map to user/model roles",
    JSON.stringify(contents) ===
      JSON.stringify([
        { role: "user", parts: [{ text: "hi" }] },
        { role: "model", parts: [{ text: "hello" }] },
      ])
  );
}

{
  const messages: ChatMessage[] = [
    { role: "user", content: "read math.js" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "read_file", arguments: { path: "math.js" } }] },
    { role: "tool", tool_call_id: "c1", name: "read_file", content: "file contents" },
  ];
  const { contents } = toGeminiContents(messages);
  check(
    "a tool_calls turn becomes a functionCall part",
    JSON.stringify(contents[1]) === JSON.stringify({ role: "model", parts: [{ functionCall: { name: "read_file", args: { path: "math.js" } } }] })
  );
  check(
    "a tool result becomes a functionResponse part",
    JSON.stringify(contents[2]) ===
      JSON.stringify({ role: "user", parts: [{ functionResponse: { name: "read_file", response: { content: "file contents" } } }] })
  );
}

{
  // Two tool calls issued in the SAME assistant turn (a parallel tool-call
  // response) produce two consecutive role:"tool" messages in the history.
  // Gemini's API requires every functionResponse answering one model turn
  // to arrive in a single content entry — one content per functionCall in
  // that turn is a real 400 ("number of function response parts should be
  // equal to number of function call parts").
  const messages: ChatMessage[] = [
    { role: "user", content: "read two files" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "c1", name: "read_file", arguments: { path: "a.txt" } },
        { id: "c2", name: "read_file", arguments: { path: "b.txt" } },
      ],
    },
    { role: "tool", tool_call_id: "c1", name: "read_file", content: "contents of a" },
    { role: "tool", tool_call_id: "c2", name: "read_file", content: "contents of b" },
  ];
  const { contents } = toGeminiContents(messages);
  check("two consecutive tool results merge into a single content entry", contents.length === 3);
  check(
    "that entry carries both functionResponse parts, in order",
    JSON.stringify(contents[2]) ===
      JSON.stringify({
        role: "user",
        parts: [
          { functionResponse: { name: "read_file", response: { content: "contents of a" } } },
          { functionResponse: { name: "read_file", response: { content: "contents of b" } } },
        ],
      })
  );
}

console.log("\nGemini response conversion:");

{
  const response = fromGeminiResult({
    candidates: [{ content: { parts: [{ text: "the answer" }] } }],
  });
  check("a plain text response becomes a final turn", response.turn.type === "final" && response.turn.content === "the answer");
}

{
  const response = fromGeminiResult({
    candidates: [{ content: { parts: [{ functionCall: { name: "read_file", args: { path: "x.txt" } } }] } }],
  });
  check(
    "a functionCall part becomes a tool_calls turn",
    response.turn.type === "tool_calls" && response.turn.toolCalls[0]?.name === "read_file" && JSON.stringify(response.turn.toolCalls[0]?.arguments) === JSON.stringify({ path: "x.txt" })
  );
}

{
  const response = fromGeminiResult({ candidates: [{ content: { parts: [] } }] });
  check("an empty parts array becomes an empty final turn, not a crash", response.turn.type === "final" && response.turn.content === "");
}

{
  // Gemini's API gives function calls no id of its own — the id is
  // entirely synthetic here. Two SEPARATE turns (e.g. after a mid-task
  // fallback from Gemini to Anthropic, whose tool_use ids must be unique
  // across the whole conversation) must not reuse the same id just because
  // each response's own parts array restarts at index 0.
  const firstTurn = fromGeminiResult({
    candidates: [{ content: { parts: [{ functionCall: { name: "read_file", args: { path: "a.txt" } } }] } }],
  });
  const secondTurn = fromGeminiResult({
    candidates: [{ content: { parts: [{ functionCall: { name: "read_file", args: { path: "b.txt" } } }] } }],
  });
  check(
    "tool-call ids stay unique across separate turns, not just within one",
    firstTurn.turn.type === "tool_calls" &&
      secondTurn.turn.type === "tool_calls" &&
      firstTurn.turn.toolCalls[0]?.id !== secondTurn.turn.toolCalls[0]?.id
  );
}

console.log("\nGemini tool declarations strip JSON-Schema keywords Gemini's OpenAPI-subset rejects:");
{
  // Real MCP server tool schemas commonly include $schema and
  // additionalProperties (standard JSON Schema keywords) — Gemini's
  // function-calling API only accepts a restricted OpenAPI 3.0 subset and
  // rejects unknown fields outright (a 400), so every one of those tools
  // would break Gemini specifically, never the other providers.
  const result = toGeminiTools([
    {
      name: "read_file",
      description: "Reads a file",
      permission: "SAFE",
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ] as any);
  const params: any = (result?.[0]?.functionDeclarations?.[0] as any)?.parameters;
  check("$schema is stripped", params !== undefined && !("$schema" in params));
  check("additionalProperties is stripped", params !== undefined && !("additionalProperties" in params));
  check("the actual schema shape survives", params?.type === "object" && JSON.stringify(params?.required) === JSON.stringify(["path"]));
}

console.log("\nGemini provider:");

{
  const provider = new GeminiProvider({ apiKey: "test-key" });
  check("id is 'gemini'", provider.id === "gemini");
}

console.log("\nGemini provider classifies RESOURCE_EXHAUSTED as retryable:");
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "quota exceeded" } }), { status: 429 })) as typeof fetch;
  try {
    const provider = new GeminiProvider({ apiKey: "test-key" });
    try {
      await provider.chat({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "hi" }] });
      check("a RESOURCE_EXHAUSTED response throws", false);
    } catch (err) {
      check("throws a ProviderChatError", err instanceof ProviderChatError);
      check("is retryable", err instanceof ProviderChatError && err.retryable === true);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\nGeminiProvider.chatStream:");
{
  const sseBody =
    'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n' + 'data: {"candidates":[{"content":{"parts":[{"text":" world"}]}}]}\n\n';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    check("requests :streamGenerateContent with alt=sse, not :generateContent", url.includes(":streamGenerateContent") && url.includes("alt=sse"));
    return new Response(sseBody, { status: 200 });
  }) as typeof fetch;
  try {
    const provider = new GeminiProvider({ apiKey: "test-key" });
    const seen: any[] = [];
    for await (const e of provider.chatStream!({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "hi" }] })) seen.push(e);
    const textEvents = seen.filter((e) => e.type === "text");
    check("yields a text StreamEvent per streamed text part", textEvents.length === 2 && textEvents[0].text === "Hello" && textEvents[1].text === " world");
    const done = seen.find((e) => e.type === "done");
    check("the terminal done event assembles the full text", done?.response.turn.type === "final" && done.response.turn.content === "Hello world");
  } finally {
    globalThis.fetch = realFetch;
  }
}

{
  // Gemini's own real limitation (Developer API, not Vertex): a
  // functionCall part always arrives fully formed in a single chunk —
  // never split into a separate "name known" moment and later argument
  // fragments. Per spec, this means NO tool_call_start/tool_call_delta at
  // all for this call — it surfaces only through the terminal done event,
  // exactly like a non-streaming response would.
  const sseBody = 'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"a.txt"}}}]}}]}\n\n';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(sseBody, { status: 200 })) as typeof fetch;
  try {
    const provider = new GeminiProvider({ apiKey: "test-key" });
    const seen: any[] = [];
    for await (const e of provider.chatStream!({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "read a.txt" }], tools: [] })) seen.push(e);
    check("never emits tool_call_start for Gemini (no genuine 'name known early' moment exists)", !seen.some((e) => e.type === "tool_call_start"));
    check("never emits tool_call_delta for Gemini", !seen.some((e) => e.type === "tool_call_delta"));
    const done = seen.find((e) => e.type === "done");
    check("the tool call still surfaces correctly through the terminal done event", done?.response.turn.type === "tool_calls" && done.response.turn.toolCalls[0]?.name === "read_file");
  } finally {
    globalThis.fetch = realFetch;
  }
}

{
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "quota exceeded", status: "RESOURCE_EXHAUSTED" } }), { status: 429 })) as typeof fetch;
  try {
    const provider = new GeminiProvider({ apiKey: "test-key" });
    let threw: any = null;
    try {
      for await (const _e of provider.chatStream!({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "hi" }] })) {
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

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
