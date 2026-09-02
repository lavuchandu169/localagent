import { toAnthropicMessages, toAnthropicTools, fromAnthropicResponse, AnthropicProvider } from "../providers/anthropicProvider.js";
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
  const response: any = { content: [{ type: "text", text: "all done" }] };
  const { turn } = fromAnthropicResponse(response);
  check("fromAnthropicResponse returns a final turn for text-only content", JSON.stringify(turn) === JSON.stringify({ type: "final", content: "all done" }));
}

{
  const response: any = {
    content: [
      { type: "text", text: "checking now" },
      { type: "tool_use", id: "c1", name: "read_file", input: { path: "a.js" } },
    ],
  };
  const { turn } = fromAnthropicResponse(response);
  check(
    "fromAnthropicResponse returns a tool_calls turn when a tool_use block is present",
    JSON.stringify(turn) ===
      JSON.stringify({ type: "tool_calls", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.js" } }], content: "checking now" })
  );
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

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
