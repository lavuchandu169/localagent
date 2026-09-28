import { buildChatBody, OpenAICompatibleProvider } from "../providers/openaiCompatible.js";
import type { ChatMessage } from "../types.js";
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

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
