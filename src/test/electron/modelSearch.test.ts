import { searchHuggingFaceGgufModels, type FetchLike } from "../../electron/modelSearch.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

function fakeFetch(response: { ok: boolean; status?: number; body?: unknown; jsonError?: Error }): FetchLike {
  return async () => ({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: async () => {
      if (response.jsonError) throw response.jsonError;
      return response.body;
    },
  });
}

console.log("searchHuggingFaceGgufModels:");
async function run() {
  {
    const result = await searchHuggingFaceGgufModels("");
    check("an empty query returns an empty result without calling fetch", result.ok === true && result.ok && result.results.length === 0);
  }

  {
    const body = [
      { id: "bartowski/Qwen2.5-32B-Instruct-GGUF", downloads: 12345, likes: 42 },
      { id: "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF", downloads: 999 },
    ];
    const result = await searchHuggingFaceGgufModels("qwen", fakeFetch({ ok: true, body }));
    check("a successful response parses both results", result.ok === true && result.results.length === 2);
    check(
      "each result carries id and downloads",
      result.ok && result.results[0]?.id === "bartowski/Qwen2.5-32B-Instruct-GGUF" && result.results[0]?.downloads === 12345
    );
    check("likes defaults to 0 when the API omits it", result.ok && result.results[1]?.likes === 0);
  }

  {
    const result = await searchHuggingFaceGgufModels("qwen", fakeFetch({ ok: false, status: 429 }));
    check("a non-200 response comes back as ok:false with a clear error, not a throw", result.ok === false && result.error.includes("429"));
  }

  {
    const result = await searchHuggingFaceGgufModels("qwen", fakeFetch({ ok: true, body: { not: "an array" } }));
    check("a malformed (non-array) response body comes back as ok:false, not a throw", result.ok === false);
  }

  {
    const throwingFetch: FetchLike = async () => {
      throw new Error("network down");
    };
    const result = await searchHuggingFaceGgufModels("qwen", throwingFetch);
    check("a network failure comes back as ok:false, not a throw", result.ok === false && result.error === "network down");
  }

  {
    // Performance/correctness finding (code-review-and-quality pass): this
    // used to have no timeout at all — a hanging server left the search
    // box's "Searching…" state stuck forever. hangingFetch never resolves
    // or rejects on its own; it only settles when the signal passed to it
    // actually aborts, proving the timeout plumbing (not just the SDK's
    // own eventual default) is what causes this to resolve.
    //
    // AbortSignal.timeout()'s own internal timer is unref'd — in the real
    // app there's always some other live handle (the Electron main
    // process, IPC) keeping Node's event loop alive long enough for it to
    // fire; in this bare test script there isn't, so a manual keep-alive
    // is needed or the process can exit before the 50ms timeout ever
    // actually runs, silently abandoning the pending await.
    const keepAlive = setInterval(() => {}, 1000);
    const hangingFetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
      });
    const startedAt = Date.now();
    let result: Awaited<ReturnType<typeof searchHuggingFaceGgufModels>>;
    try {
      result = await searchHuggingFaceGgufModels("qwen", hangingFetch, 50);
    } finally {
      clearInterval(keepAlive);
    }
    const elapsedMs = Date.now() - startedAt;
    check("a hanging request resolves as ok:false rather than hanging forever", result.ok === false);
    check("resolves close to the short override timeout, not indefinitely", elapsedMs < 5000);
  }
}
await run();

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
