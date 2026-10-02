import { toAnthropicMessages, toAnthropicTools, fromAnthropicResponse, AnthropicProvider } from "../providers/anthropicProvider.js";
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

console.log("Anthropic provider conversion:");

{
  const { system, messages } = toAnthropicMessages([
    { role: "system", content: "You are careful." },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]);
  check("toAnthropicMessages pulls the system message out separately", system === "You are careful.");
  check(
    "toAnthropicMessages converts plain user/assistant turns",
    JSON.stringify(messages) === JSON.stringify([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }])
  );
}

{
  const messages: ChatMessage[] = [
    { role: "user", content: "read math.js" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "read_file", arguments: { path: "math.js" } }] },
    { role: "tool", tool_call_id: "c1", name: "read_file", content: "file contents" },
  ];
  const { messages: out } = toAnthropicMessages(messages);
  check(
    "toAnthropicMessages converts a tool_calls turn into a tool_use content block",
    JSON.stringify(out[1]) ===
      JSON.stringify({ role: "assistant", content: [{ type: "tool_use", id: "c1", name: "read_file", input: { path: "math.js" } }] })
  );
  check(
    "toAnthropicMessages converts a tool result into a user message with a tool_result block",
    JSON.stringify(out[2]) ===
      JSON.stringify({ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "file contents" }] })
  );
}

{
  const messages: ChatMessage[] = [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "c1", name: "read_file", arguments: { path: "a.js" } },
        { id: "c2", name: "read_file", arguments: { path: "b.js" } },
      ],
    },
    { role: "tool", tool_call_id: "c1", name: "read_file", content: "a" },
    { role: "tool", tool_call_id: "c2", name: "read_file", content: "b" },
  ];
  const { messages: out } = toAnthropicMessages(messages);
  check(
    "toAnthropicMessages merges consecutive tool results into a single user message",
    out.length === 2 &&
      JSON.stringify(out[1]) ===
        JSON.stringify({
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "c1", content: "a" },
            { type: "tool_result", tool_use_id: "c2", content: "b" },
          ],
        })
  );
}

{
  check("toAnthropicTools returns undefined for no tools", toAnthropicTools(undefined) === undefined);
  const tools = toAnthropicTools([{ name: "read_file", description: "reads a file", inputSchema: { type: "object" } }]);
  check(
    "toAnthropicTools maps to name/description/input_schema",
    JSON.stringify(tools) === JSON.stringify([{ name: "read_file", description: "reads a file", input_schema: { type: "object" } }])
  );
}

{
  const response: any = { content: [{ type: "text", text: "all done" }], usage: { input_tokens: 120, output_tokens: 45 } };
  const { turn, usage } = fromAnthropicResponse(response);
  check("fromAnthropicResponse returns a final turn for text-only content", JSON.stringify(turn) === JSON.stringify({ type: "final", content: "all done" }));
  check("fromAnthropicResponse maps the real response's input_tokens/output_tokens into usage.inputTokens/outputTokens", JSON.stringify(usage) === JSON.stringify({ inputTokens: 120, outputTokens: 45 }));
}

{
  const response: any = {
    content: [
      { type: "text", text: "checking now" },
      { type: "tool_use", id: "c1", name: "read_file", input: { path: "a.js" } },
    ],
    usage: { input_tokens: 300, output_tokens: 80 },
  };
  const { turn, usage } = fromAnthropicResponse(response);
  check(
    "fromAnthropicResponse returns a tool_calls turn when a tool_use block is present",
    JSON.stringify(turn) ===
      JSON.stringify({ type: "tool_calls", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.js" } }], content: "checking now" })
  );
  check("fromAnthropicResponse also reports usage on a tool_calls turn, not just a final one", JSON.stringify(usage) === JSON.stringify({ inputTokens: 300, outputTokens: 80 }));
}

console.log("\nSelectable Anthropic model id (constructor never makes a network call, so this is safe without a real key):");
{
  const provider = new AnthropicProvider();
  const models = await provider.listModels();
  check("with no model specified, defaults to claude-sonnet-5", models[0]?.id === "claude-sonnet-5");
}
{
  const provider = new AnthropicProvider({ model: "claude-opus-5" });
  const models = await provider.listModels();
  check("a chosen model id flows through to listModels", models[0]?.id === "claude-opus-5");
}
{
  const provider = new AnthropicProvider({ apiKey: "sk-test", model: "claude-haiku-4-5" });
  const models = await provider.listModels();
  check("model selection is independent of apiKey being set", models[0]?.id === "claude-haiku-4-5");
}

console.log("\nAttachments in toAnthropicMessages:");

{
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: "what's in this?",
      images: [{ name: "screenshot.png", mediaType: "image/png", dataBase64: "ZmFrZWRhdGE=" }],
    },
  ];
  const { messages: out } = toAnthropicMessages(messages);
  const userMsg = out[0];
  check("a message with an image becomes a content-block array, not a plain string", Array.isArray(userMsg?.content));
  const blocks = userMsg?.content as any[];
  check(
    "the image becomes a base64 image content block",
    JSON.stringify(blocks[0]) === JSON.stringify({ type: "image", source: { type: "base64", media_type: "image/png", data: "ZmFrZWRhdGE=" } })
  );
  check("the task text becomes a trailing text block", JSON.stringify(blocks[1]) === JSON.stringify({ type: "text", text: "what's in this?" }));
}

{
  // Attachment-only message (empty task text) — no text block at all,
  // not an empty one.
  const messages: ChatMessage[] = [
    { role: "user", content: "", images: [{ name: "a.png", mediaType: "image/png", dataBase64: "AAAA" }] },
  ];
  const { messages: out } = toAnthropicMessages(messages);
  const blocks = out[0]?.content as any[];
  check("an attachment-only message has exactly one block (the image, no empty text block)", blocks.length === 1 && blocks[0].type === "image");
}

{
  // A mediaType that isn't one of the four Anthropic accepts (e.g. from a
  // corrupted or hand-edited session record) must be skipped, not sent
  // through to the API as an invalid media_type.
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: "look at these",
      images: [
        { name: "bad.bmp", mediaType: "image/bmp", dataBase64: "AAAA" },
        { name: "good.png", mediaType: "image/png", dataBase64: "BBBB" },
      ],
    },
  ];
  const { messages: out } = toAnthropicMessages(messages);
  const blocks = out[0]?.content as any[];
  check("an unsupported mediaType image is skipped, not sent", blocks.length === 2);
  check("the valid image is still included", blocks[0].source.media_type === "image/png");
  check("the trailing text block is still present", blocks[1].type === "text");
}

{
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: "summarize this",
      textAttachments: [{ name: "notes.txt", content: "the key point is X" }],
    },
  ];
  const { messages: out } = toAnthropicMessages(messages);
  const blocks = out[0]?.content as any[];
  check("a text attachment folds into the trailing text block, not a separate document block", blocks.length === 1 && blocks[0].type === "text");
  check(
    "the folded text contains both the task text and the attachment's labeled content",
    blocks[0].text === "summarize this\n\n--- Attached file: notes.txt ---\nthe key point is X\n---"
  );
}

{
  // No attachments at all — content must stay a plain string exactly as
  // it always has, not become a single-element array (a behavior change
  // for the overwhelmingly common case would be a real regression).
  const messages: ChatMessage[] = [{ role: "user", content: "plain question" }];
  const { messages: out } = toAnthropicMessages(messages);
  check("a message with no attachments still has plain string content", out[0]?.content === "plain question");
}

console.log("\nAnthropic rate-limit errors become a retryable ProviderChatError:");
{
  const provider = new AnthropicProvider({ apiKey: "test-key" });
  // @ts-expect-error -- reaching into the private client to force a 429 without a real network call
  provider["client"].messages.create = async () => {
    const err: any = new Error("rate limited");
    err.status = 429;
    err.name = "RateLimitError";
    throw err;
  };
  try {
    await provider.chat({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] });
    check("a 429 from the Anthropic client throws", false);
  } catch (err) {
    check("a 429 from the Anthropic client throws a ProviderChatError", err instanceof ProviderChatError);
    check("that error is marked retryable", err instanceof ProviderChatError && err.retryable === true);
    check("that error carries the 429 status", err instanceof ProviderChatError && err.status === 429);
  }
}

console.log("\nA non-rate-limit Anthropic error is NOT retryable:");
{
  const provider = new AnthropicProvider({ apiKey: "test-key" });
  // @ts-expect-error -- same reach-in, this time simulating a bad API key
  provider["client"].messages.create = async () => {
    const err: any = new Error("invalid x-api-key");
    err.status = 401;
    throw err;
  };
  try {
    await provider.chat({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] });
    check("a 401 from the Anthropic client throws", false);
  } catch (err) {
    check("a 401 from the Anthropic client throws a ProviderChatError", err instanceof ProviderChatError);
    check("that error is NOT marked retryable", err instanceof ProviderChatError && err.retryable === false);
  }
}

console.log("\nAnthropicProvider.chatStream:");
{
  // Minimal fake of the SDK's MessageStream: async-iterable over the given
  // raw events, with finalMessage() resolving to the given final message —
  // mirrors exactly what @anthropic-ai/sdk's real stream() return value
  // offers (verified against its own type definitions).
  function fakeMessageStream(events: any[], finalMessage: any) {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const e of events) yield e;
      },
      finalMessage: async () => finalMessage,
    };
  }

  const provider = new AnthropicProvider({ apiKey: "test-key" });
  const fakeStream = fakeMessageStream(
    [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " there" } },
      { type: "content_block_stop", index: 0 },
    ],
    {
      content: [{ type: "text", text: "Hello there" }],
      usage: { input_tokens: 10, output_tokens: 2 },
    }
  );
  (provider as any).client = { messages: { stream: () => fakeStream } };

  const seen: any[] = [];
  for await (const e of provider.chatStream!({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] })) seen.push(e);

  check(
    "yields a text StreamEvent per text_delta",
    seen.filter((e) => e.type === "text").length === 2 && seen[0].text === "Hello" && seen[1].text === " there"
  );
  const done = seen.find((e) => e.type === "done");
  check("the terminal done event's response matches what fromAnthropicResponse would produce from finalMessage()", done?.response.turn.type === "final" && done.response.turn.content === "Hello there");
}

{
  // A tool_use block: content_block_start carries the name immediately;
  // input_json_delta fragments carry the arguments.
  function fakeMessageStream(events: any[], finalMessage: any) {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const e of events) yield e;
      },
      finalMessage: async () => finalMessage,
    };
  }

  const provider = new AnthropicProvider({ apiKey: "test-key" });
  const fakeStream = fakeMessageStream(
    [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path"' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ':"a.txt"}' } },
      { type: "content_block_stop", index: 0 },
    ],
    {
      content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.txt" } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }
  );
  (provider as any).client = { messages: { stream: () => fakeStream } };

  const seen: any[] = [];
  for await (const e of provider.chatStream!({ model: "claude-sonnet-5", messages: [{ role: "user", content: "read a.txt" }] })) seen.push(e);

  const start = seen.find((e) => e.type === "tool_call_start");
  check("tool_call_start fires with index 0 and the real tool name, from content_block_start alone", start?.index === 0 && start?.name === "read_file");
  const deltas = seen.filter((e) => e.type === "tool_call_delta");
  check(
    "tool_call_delta fires once per input_json_delta fragment, same index, in order",
    deltas.length === 2 && deltas[0].index === 0 && deltas[0].argumentsDelta === '{"path"' && deltas[1].argumentsDelta === ':"a.txt"}'
  );
  const done = seen.find((e) => e.type === "done");
  check("the terminal done event's tool call matches fromAnthropicResponse's own parsing", done?.response.turn.type === "tool_calls" && done.response.turn.toolCalls[0]?.name === "read_file");
}

{
  // Anthropic's own content_block index counts EVERY block (text and
  // tool_use alike) — our StreamEvent.index must count only tool_use
  // blocks, starting fresh at 0, matching the position those calls will
  // have in response.turn.toolCalls.
  function fakeMessageStream(events: any[], finalMessage: any) {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const e of events) yield e;
      },
      finalMessage: async () => finalMessage,
    };
  }

  const provider = new AnthropicProvider({ apiKey: "test-key" });
  const fakeStream = fakeMessageStream(
    [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Sure, reading it now." } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_2", name: "read_file", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"b.txt"}' } },
      { type: "content_block_stop", index: 1 },
    ],
    {
      content: [
        { type: "text", text: "Sure, reading it now." },
        { type: "tool_use", id: "toolu_2", name: "read_file", input: { path: "b.txt" } },
      ],
      usage: { input_tokens: 10, output_tokens: 8 },
    }
  );
  (provider as any).client = { messages: { stream: () => fakeStream } };

  const seen: any[] = [];
  for await (const e of provider.chatStream!({ model: "claude-sonnet-5", messages: [{ role: "user", content: "read b.txt" }] })) seen.push(e);

  const start = seen.find((e) => e.type === "tool_call_start");
  check("the tool call's StreamEvent index is 0 even though it's Anthropic's SECOND content block (text was first)", start?.index === 0);
}

console.log("\nAnthropicProvider.chatStream surfaces a ProviderChatError the same way chat() does:");
{
  const provider = new AnthropicProvider({ apiKey: "test-key" });
  (provider as any).client = {
    messages: {
      stream: () => {
        const err: any = new Error("rate limited");
        err.status = 429;
        throw err;
      },
    },
  };
  let threw: any = null;
  try {
    for await (const _e of provider.chatStream!({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] })) {
      // no-op
    }
  } catch (err) {
    threw = err;
  }
  check("throws a ProviderChatError", threw instanceof ProviderChatError);
  check("marks a 429 as retryable, same as chat()", threw instanceof ProviderChatError && threw.retryable === true);
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
