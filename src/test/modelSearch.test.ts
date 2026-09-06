import { searchHuggingFaceGgufModels, type FetchLike } from "../electron/modelSearch.js";

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
}
await run();

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
