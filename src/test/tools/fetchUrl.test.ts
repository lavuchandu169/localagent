import { promises as dns } from "node:dns";
import { fetchUrlTool } from "../../tools/fetchUrl.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

const ctx = { workspaceRoot: "/tmp", log: () => {} };

/** Every test below resolves to a public-looking address by default, so DNS-lookup-based
 * SSRF tests that need a specific resolution opt in explicitly instead of every other test
 * needing to stub DNS just to get past the (now mandatory) resolution step. */
function withDnsLookup<T>(records: Array<{ address: string; family: 4 | 6 }>, fn: () => Promise<T>): Promise<T> {
  const real = dns.lookup;
  (dns as any).lookup = async () => records;
  return fn().finally(() => {
    (dns as any).lookup = real;
  });
}
function withPublicDns<T>(fn: () => Promise<T>): Promise<T> {
  return withDnsLookup([{ address: "93.184.216.34", family: 4 }], fn);
}
function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = real;
  });
}

async function main() {
  console.log("fetchUrlTool: declares itself correctly:");
  {
    check("name is fetch_url", fetchUrlTool.name === "fetch_url");
    check("permission is NETWORK — never silently auto-approved, see permissions.ts", fetchUrlTool.permission === "NETWORK");
  }

  console.log("\nfetchUrlTool: rejects malformed or disallowed input before ever calling fetch:");
  {
    const missing = await fetchUrlTool.execute({} as any, ctx);
    check("missing url is rejected", missing.ok === false && !!missing.error);

    const notAUrl = await fetchUrlTool.execute({ url: "not a url" }, ctx);
    check("unparsable url is rejected", notAUrl.ok === false && !!notAUrl.error);

    const fileUrl = await fetchUrlTool.execute({ url: "file:///etc/passwd" }, ctx);
    check("file:// scheme is rejected", fileUrl.ok === false && !!fileUrl.error);

    const ftpUrl = await fetchUrlTool.execute({ url: "ftp://example.com/x" }, ctx);
    check("ftp:// scheme is rejected", ftpUrl.ok === false && !!ftpUrl.error);
  }

  console.log("\nfetchUrlTool: blocks obvious private/loopback/link-local literal targets (SSRF guard) before calling fetch:");
  {
    let fetchWasCalled = false;
    const blockedFetch = (async () => {
      fetchWasCalled = true;
      return new Response("should never get here", { status: 200 });
    }) as typeof fetch;
    const targets = [
      "http://localhost/",
      "http://localhost./", // trailing dot — must not slip past a literal "localhost" === check
      "http://127.0.0.1/",
      "http://127.0.0.2:8080/admin",
      "http://169.254.169.254/latest/meta-data/", // cloud metadata endpoint
      "http://10.0.0.5/",
      "http://172.16.0.1/",
      "http://192.168.1.1/",
      "http://[::1]/",
      "http://2130706433/", // decimal-integer form of 127.0.0.1 — WHATWG URL normalizes this to 127.0.0.1 itself
      "http://[::ffff:127.0.0.1]/", // IPv4-mapped IPv6 literal
      "http://[::ffff:7f00:1]/", // same address, compressed-hex IPv6 form
      "http://0.1.2.3/", // 0.0.0.0/8 — "this network"
      "http://100.64.0.1/", // 100.64.0.0/10 — shared address space (CGNAT)
      "http://198.18.0.1/", // 198.18.0.0/15 — benchmarking
      "http://224.0.0.1/", // 224.0.0.0/4 — multicast
      "http://240.0.0.1/", // 240.0.0.0/4 — reserved
      "http://[fec0::1]/", // fec0::/10 — deprecated IPv6 site-local
      "http://[fed0::1]/", // same /10 range, NOT the literal "fec0:" prefix — a text-prefix check misses this
      "http://[feb0::1]/", // same /10 range, the other boundary a text-prefix check misses
      "http://[fe90::1]/", // fe80::/10 link-local, NOT the literal "fe80:" prefix — same bug class
      "http://[::]/", // unspecified address
      "http://[64:ff9b::7f00:1]/", // 64:ff9b::/96 NAT64, embedding 127.0.0.1
      "http://[::7f00:1]/", // ::/96 IPv4-compatible IPv6 (deprecated), embedding 127.0.0.1
    ];
    for (const url of targets) {
      fetchWasCalled = false;
      const result = await withFetch(blockedFetch, () => fetchUrlTool.execute({ url }, ctx));
      check(`${url} is rejected without calling fetch`, result.ok === false && !fetchWasCalled);
    }
  }

  console.log("\nfetchUrlTool: blocks a hostname that LOOKS public but resolves (DNS) to a private/loopback/link-local address:");
  {
    let fetchWasCalled = false;
    const blockedFetch = (async () => {
      fetchWasCalled = true;
      return new Response("should never get here", { status: 200 });
    }) as typeof fetch;
    const rebindCases: Array<{ label: string; records: Array<{ address: string; family: 4 | 6 }> }> = [
      { label: "resolves to loopback", records: [{ address: "127.0.0.1", family: 4 }] },
      { label: "resolves to the cloud metadata address", records: [{ address: "169.254.169.254", family: 4 }] },
      { label: "resolves to a private RFC1918 address", records: [{ address: "10.1.2.3", family: 4 }] },
      // all() returning several addresses: ONE bad address among several good ones must still block.
      { label: "one of several resolved addresses is blocked", records: [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }] },
    ];
    for (const { label, records } of rebindCases) {
      fetchWasCalled = false;
      const result = await withDnsLookup(records, () => withFetch(blockedFetch, () => fetchUrlTool.execute({ url: "https://sneaky-looking-domain.example/" }, ctx)));
      check(`a domain that ${label} is rejected without calling fetch`, result.ok === false && !fetchWasCalled);
    }
  }

  console.log("\nfetchUrlTool: a successful plain-text fetch:");
  {
    const okFetch = (async () =>
      new Response("hello from the real internet", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })) as typeof fetch;
    const result = await withPublicDns(() => withFetch(okFetch, () => fetchUrlTool.execute({ url: "https://example.com/notes.txt" }, ctx)));
    check("ok is true", result.ok === true);
    check("content is returned verbatim for plain text", result.output?.content === "hello from the real internet");
    check("status is captured", result.output?.status === 200);
  }

  console.log("\nfetchUrlTool: an HTML page is stripped down to readable text:");
  {
    const html = `<!doctype html><html><head><style>.x{color:red}</style><script>alert(1)</script></head>
      <body><h1>Title</h1><p>First   paragraph.</p><p>Second paragraph with a <a href="/x">link</a>.</p></body></html>`;
    const htmlFetch = (async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })) as typeof fetch;
    const result = await withPublicDns(() => withFetch(htmlFetch, () => fetchUrlTool.execute({ url: "https://example.com/page" }, ctx)));
    check("ok is true", result.ok === true);
    check("script contents are stripped out", !result.output?.content.includes("alert(1)"));
    check("style contents are stripped out", !result.output?.content.includes("color:red"));
    check("tags are stripped but text content survives", !!result.output?.content.includes("Title") && !!result.output?.content.includes("First paragraph."));
    check("no raw tag markup leaks through", !result.output?.content.includes("<h1>") && !result.output?.content.includes("<p>"));
  }

  console.log("\nfetchUrlTool: a non-OK HTTP response is a clean failure, not a throw:");
  {
    const notFoundFetch = (async () => new Response("not found", { status: 404, statusText: "Not Found" })) as typeof fetch;
    const result = await withPublicDns(() => withFetch(notFoundFetch, () => fetchUrlTool.execute({ url: "https://example.com/missing" }, ctx)));
    check("ok is false", result.ok === false);
    check("error mentions the status", !!result.error?.includes("404"));
  }

  console.log("\nfetchUrlTool: a network-level failure (connection/TLS) is caught, not thrown:");
  {
    const throwingFetch = (async () => {
      throw new Error("connect ECONNREFUSED 93.184.216.34:443");
    }) as typeof fetch;
    const result = await withPublicDns(() => withFetch(throwingFetch, () => fetchUrlTool.execute({ url: "https://example.com/" }, ctx)));
    check("ok is false", result.ok === false);
    check("the underlying error message is surfaced", !!result.error?.includes("ECONNREFUSED"));
  }

  console.log("\nfetchUrlTool: an unresolvable hostname is a clean failure, not a hang or a throw:");
  {
    const result = await withDnsLookup([], () =>
      withFetch(
        (async () => {
          throw new Error("should never reach fetch — dns.lookup resolved to nothing");
        }) as typeof fetch,
        () => fetchUrlTool.execute({ url: "https://does-not-exist.invalid/" }, ctx)
      )
    );
    check("ok is false", result.ok === false);
  }

  console.log("\nfetchUrlTool: a very large response is truncated, not returned whole:");
  {
    const huge = "x".repeat(200_000);
    const hugeFetch = (async () => new Response(huge, { status: 200, headers: { "content-type": "text/plain" } })) as typeof fetch;
    const result = await withPublicDns(() => withFetch(hugeFetch, () => fetchUrlTool.execute({ url: "https://example.com/huge.txt" }, ctx)));
    check("ok is true", result.ok === true);
    check("content is capped well under the full 200,000 chars", (result.output?.content.length ?? 0) < 200_000);
    check("truncated flag is set", result.truncated === true);
  }

  console.log("\nfetchUrlTool: a response far larger than the byte cap is handled cleanly (streaming cap, not full buffering):");
  {
    const veryHuge = "y".repeat(3_000_000); // bigger than the tool's internal byte cap
    const veryHugeFetch = (async () => new Response(veryHuge, { status: 200, headers: { "content-type": "text/plain" } })) as typeof fetch;
    const started = Date.now();
    const result = await withPublicDns(() => withFetch(veryHugeFetch, () => fetchUrlTool.execute({ url: "https://example.com/veryhuge.txt" }, ctx)));
    check("ok is true", result.ok === true);
    check("truncated flag is set", result.truncated === true);
    check("content is still capped to the normal text ceiling, not megabytes", (result.output?.content.length ?? 0) < 60_000);
    check("completes quickly rather than hanging", Date.now() - started < 5000);
  }

  console.log("\nfetchUrlTool: follows a redirect to another public host and returns the final content:");
  {
    let calls = 0;
    const redirectFetch = (async (input: any) => {
      calls++;
      const url = String(input);
      if (url === "https://example.com/start") {
        return new Response(null, { status: 302, headers: { location: "https://example.com/final" } });
      }
      return new Response("the real final page", { status: 200, headers: { "content-type": "text/plain" } });
    }) as typeof fetch;
    const result = await withPublicDns(() => withFetch(redirectFetch, () => fetchUrlTool.execute({ url: "https://example.com/start" }, ctx)));
    check("ok is true", result.ok === true);
    check("the redirect was actually followed", calls === 2);
    check("the FINAL page's content is returned", result.output?.content === "the real final page");
  }

  console.log("\nfetchUrlTool: a redirect to a blocked host is rejected — the host guard applies to every hop, not just the first:");
  {
    let secondHopCalled = false;
    const redirectToBlockedFetch = (async (input: any) => {
      const url = String(input);
      if (url === "https://example.com/start") {
        return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
      }
      secondHopCalled = true;
      return new Response("should never get here", { status: 200 });
    }) as typeof fetch;
    const result = await withPublicDns(() => withFetch(redirectToBlockedFetch, () => fetchUrlTool.execute({ url: "https://example.com/start" }, ctx)));
    check("ok is false", result.ok === false);
    check("the blocked redirect target was never actually fetched", !secondHopCalled);
  }

  console.log("\nfetchUrlTool: a redirect loop / too many hops is rejected cleanly instead of looping forever:");
  {
    let calls = 0;
    const loopingFetch = (async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: "https://example.com/loop" } });
    }) as typeof fetch;
    const result = await withPublicDns(() => withFetch(loopingFetch, () => fetchUrlTool.execute({ url: "https://example.com/loop" }, ctx)));
    check("ok is false", result.ok === false);
    check("it gives up after a small, bounded number of hops", calls <= 10);
  }

  console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
