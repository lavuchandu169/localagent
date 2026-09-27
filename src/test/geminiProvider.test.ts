import { toGeminiContents, fromGeminiResult, GeminiProvider } from "../providers/geminiProvider.js";
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
      await provider.chat({ model: "gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] });
      check("a RESOURCE_EXHAUSTED response throws", false);
    } catch (err) {
      check("throws a ProviderChatError", err instanceof ProviderChatError);
      check("is retryable", err instanceof ProviderChatError && err.retryable === true);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
