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

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
