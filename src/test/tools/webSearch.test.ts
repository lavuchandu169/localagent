import { webSearchTool, parseSearchResults } from "../../tools/webSearch.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ok - ${name}`);
  else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

const ctx = { workspaceRoot: "/tmp", log: () => {} };

const PAGE = `
<div class="result results_links results_links_deep result--ad"><a class="result__a" href="//duckduckgo.com/y.js?ad_domain=shop.example&ad_provider=bing&u3=x">Buy now</a>
<a class="result__snippet" href="x">An ad</a></div>
<div class="result"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Ffs.html&amp;rut=abc">Node.js &amp; <b>fs</b> API</a></h2>
<a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">The <b>fs</b> module lets you work with the file system &amp; streams.</a></div>
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=javascript%3Aalert(1)">Bad scheme</a></div>
<div class="result"><a class="result__a" href="https://example.com/direct">Direct link</a></div>`;

function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = real;
  });
}

console.log("parseSearchResults:");
{
  const r = parseSearchResults(PAGE);
  check("two real results are returned (ad and non-http link skipped)", r.length === 2);
  check("the redirect link gives the real address", r[0]?.url === "https://nodejs.org/api/fs.html");
  check("the title has tags removed and entities decoded", r[0]?.title === "Node.js & fs API");
  check("the snippet is cleaned", r[0]?.snippet === "The fs module lets you work with the file system & streams.");
  check("a direct link without a snippet has an empty snippet", r[1]?.url === "https://example.com/direct" && r[1]?.snippet === "");
  check("the limit is respected", parseSearchResults(PAGE, 1).length === 1);
  check("a page with no results gives an empty list", parseSearchResults("<html>nothing</html>").length === 0);
}

console.log("\nweb_search tool:");
{
  check("it declares itself as a network tool", webSearchTool.name === "web_search" && webSearchTool.permission === "NETWORK");
  let seen = "";
  const ok = await withFetch((async (url: string) => {
    seen = String(url);
    return new Response(PAGE, { status: 200 });
  }) as unknown as typeof fetch, () => webSearchTool.execute({ query: "node fs  api" }, ctx));
  check("it succeeds and returns results", ok.ok && (ok.output as any).results.length === 2);
  check("the request goes to the fixed search host with the query", seen.startsWith("https://html.duckduckgo.com/html/?q=node%20fs%20api"));

  const empty = await withFetch((async () => new Response("<html></html>", { status: 200 })) as unknown as typeof fetch, () => webSearchTool.execute({ query: "zzz" }, ctx));
  check("no results is a success with a note", empty.ok && (empty.output as any).results.length === 0 && typeof (empty.output as any).note === "string");

  const down = await withFetch((async () => new Response("", { status: 503 })) as unknown as typeof fetch, () => webSearchTool.execute({ query: "x" }, ctx));
  check("a 503 is a clear failure", !down.ok && /503/.test(down.error ?? ""));

  const boom = await withFetch((async () => { throw new Error("offline"); }) as unknown as typeof fetch, () => webSearchTool.execute({ query: "x" }, ctx));
  check("a network error is a clear failure", !boom.ok && /offline/.test(boom.error ?? ""));

  check("an empty query is refused", !(await webSearchTool.execute({ query: "  " }, ctx)).ok);
  check("a very long query is refused", !(await webSearchTool.execute({ query: "a".repeat(400) }, ctx)).ok);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll tests passed.");
