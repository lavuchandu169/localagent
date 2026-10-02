import { FreellmapiProxyProvider } from "../providers/freellmapiProxy.js";
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

console.log("FreellmapiProxyProvider:");

{
  const provider = new FreellmapiProxyProvider({ userDataDir: "/tmp/does-not-matter" });
  check("id is 'freellmapi'", provider.id === "freellmapi");
}

console.log("\nFreellmapiProxyProvider.healthCheck starts the server on first call:");
{
  let startCalls = 0;
  const fakeDeps = {
    startFreellmapiServer: async (_deps: any) => {
      startCalls++;
      return { port: 18888 };
    },
    getFreellmapiUnifiedApiKey: () => "test-key",
  };

  const realFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = (async (url: string) => {
    capturedUrl = url as string;
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;

  try {
    const provider = new FreellmapiProxyProvider({ userDataDir: "/tmp/does-not-matter" }, fakeDeps as any);
    const health = await provider.healthCheck();
    check("healthCheck triggers startFreellmapiServer", startCalls === 1);
    check("healthCheck succeeds once the server 'starts'", health.ok === true);

    await provider.listModels();
    check("subsequent calls talk to the port startFreellmapiServer returned", capturedUrl.startsWith("http://127.0.0.1:18888/v1"));
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\nFreellmapiProxyProvider.chat before healthCheck:");
{
  const provider = new FreellmapiProxyProvider({ userDataDir: "/tmp/does-not-matter" });
  let threw = false;
  try {
    await provider.chat({ model: "auto", messages: [{ role: "user", content: "hi" }] });
  } catch (err) {
    threw = true;
    check("the error names what went wrong", err instanceof Error && err.message.includes("healthCheck"));
  }
  check("chat() called before healthCheck() throws instead of silently failing", threw);
}

console.log("\nFreellmapiProxyProvider.chat surfaces FreeLLMAPI's own needsKey error as-is:");
{
  const fakeDeps = {
    startFreellmapiServer: async (_deps: any) => ({ port: 18887 }),
    getFreellmapiUnifiedApiKey: () => "test-key",
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: "no provider key configured for any model", code: "needsKey" } }), {
      status: 400,
    })) as typeof fetch;

  try {
    const provider = new FreellmapiProxyProvider({ userDataDir: "/tmp/does-not-matter" }, fakeDeps as any);
    await provider.healthCheck();
    let threw = false;
    try {
      await provider.chat({ model: "auto", messages: [{ role: "user", content: "hi" }] });
    } catch (err) {
      threw = true;
      check(
        "the real needsKey message reaches the caller untranslated",
        err instanceof Error && err.message.includes("no provider key configured for any model")
      );
    }
    check("a task run with zero configured keys fails clearly instead of hanging", threw);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\nFreellmapiProxyProvider.chat surfaces a 429 as a retryable ProviderChatError (router exhausted):");
{
  // Spec requirement: when the whole free-tier router comes back
  // rate-limit-exhausted, the app must be able to fall back to a
  // configured cloud provider — agent.ts's fallback loop only acts on
  // ProviderChatError with retryable === true (see agent.ts's run() catch
  // block), so this is the exact signal that path depends on.
  const fakeDeps = {
    startFreellmapiServer: async (_deps: any) => ({ port: 18886 }),
    getFreellmapiUnifiedApiKey: () => "test-key",
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("rate limit exceeded", { status: 429, statusText: "Too Many Requests" })) as typeof fetch;

  try {
    const provider = new FreellmapiProxyProvider({ userDataDir: "/tmp/does-not-matter" }, fakeDeps as any);
    await provider.healthCheck();
    try {
      await provider.chat({ model: "auto", messages: [{ role: "user", content: "hi" }] });
      check("a 429 response throws", false);
    } catch (err) {
      check("a 429 response throws a ProviderChatError", err instanceof ProviderChatError);
      check("that error is retryable, triggering agent.ts's fallback-to-cloud-provider path", err instanceof ProviderChatError && err.retryable === true);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\nFreellmapiProxyProvider.chat treats other 'free tier unusable' status codes as retryable too (correctness audit: FreeLLMAPI Medium #3):");
for (const status of [502, 413, 404, 503]) {
  const fakeDeps = {
    startFreellmapiServer: async (_deps: any) => ({ port: 18885 }),
    getFreellmapiUnifiedApiKey: () => "test-key",
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("free tier temporarily unusable", { status })) as typeof fetch;

  try {
    const provider = new FreellmapiProxyProvider({ userDataDir: "/tmp/does-not-matter" }, fakeDeps as any);
    await provider.healthCheck();
    try {
      await provider.chat({ model: "auto", messages: [{ role: "user", content: "hi" }] });
      check(`a ${status} response throws`, false);
    } catch (err) {
      check(`a ${status} response throws a ProviderChatError`, err instanceof ProviderChatError);
      check(`a ${status} response is retryable, triggering agent.ts's fallback-to-cloud-provider path`, err instanceof ProviderChatError && err.retryable === true);
      check(`a ${status} response still carries its real status`, err instanceof ProviderChatError && err.status === status);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}
{
  // A genuinely unrelated server error (never one of FreeLLMAPI's documented
  // "free tier unusable" codes) must NOT be swept into retryable — that
  // would silently mask a real bug behind a provider switch.
  const fakeDeps = {
    startFreellmapiServer: async (_deps: any) => ({ port: 18884 }),
    getFreellmapiUnifiedApiKey: () => "test-key",
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("internal error", { status: 500 })) as typeof fetch;

  try {
    const provider = new FreellmapiProxyProvider({ userDataDir: "/tmp/does-not-matter" }, fakeDeps as any);
    await provider.healthCheck();
    try {
      await provider.chat({ model: "auto", messages: [{ role: "user", content: "hi" }] });
      check("a 500 response throws", false);
    } catch (err) {
      check("a 500 response is NOT retryable", err instanceof ProviderChatError && err.retryable === false);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}
{
  // Final-review pushback: 400 is ALSO the generic "malformed request"
  // status (not just FreeLLMAPI's own needsKey error, which happens to
  // use it too) — this wrapper can only see the status code, not the
  // specific error `code` field that would distinguish the two, so it
  // must NOT be swept into retryable. Doing so would silently retry a
  // genuinely malformed request against a paid fallback provider instead
  // of surfacing the real error.
  const fakeDeps = {
    startFreellmapiServer: async (_deps: any) => ({ port: 18883 }),
    getFreellmapiUnifiedApiKey: () => "test-key",
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "malformed request" } }), { status: 400 })) as typeof fetch;

  try {
    const provider = new FreellmapiProxyProvider({ userDataDir: "/tmp/does-not-matter" }, fakeDeps as any);
    await provider.healthCheck();
    try {
      await provider.chat({ model: "auto", messages: [{ role: "user", content: "hi" }] });
      check("a 400 response throws", false);
    } catch (err) {
      check("a 400 response is NOT retryable", err instanceof ProviderChatError && err.retryable === false);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
