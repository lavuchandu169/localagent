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

  console.log("\nfetchUrlTool: blocks obvious private/loopback/link-local targets (SSRF guard) before calling fetch:");
  {
    const realFetch = globalThis.fetch;
    let fetchWasCalled = false;
    globalThis.fetch = (async () => {
      fetchWasCalled = true;
      return new Response("should never get here", { status: 200 });
    }) as typeof fetch;
    try {
      const targets = [
        "http://localhost/",
        "http://127.0.0.1/",
        "http://127.0.0.2:8080/admin",
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.5/",
        "http://172.16.0.1/",
        "http://192.168.1.1/",
        "http://[::1]/",
      ];
      for (const url of targets) {
        fetchWasCalled = false;
        const result = await fetchUrlTool.execute({ url }, ctx);
        check(`${url} is rejected without calling fetch`, result.ok === false && !fetchWasCalled);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log("\nfetchUrlTool: a successful plain-text fetch:");
  {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("hello from the real internet", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })) as typeof fetch;
    try {
      const result = await fetchUrlTool.execute({ url: "https://example.com/notes.txt" }, ctx);
      check("ok is true", result.ok === true);
      check("content is returned verbatim for plain text", result.output?.content === "hello from the real internet");
      check("status is captured", result.output?.status === 200);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log("\nfetchUrlTool: an HTML page is stripped down to readable text:");
  {
    const realFetch = globalThis.fetch;
    const html = `<!doctype html><html><head><style>.x{color:red}</style><script>alert(1)</script></head>
      <body><h1>Title</h1><p>First   paragraph.</p><p>Second paragraph with a <a href="/x">link</a>.</p></body></html>`;
    globalThis.fetch = (async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })) as typeof fetch;
    try {
      const result = await fetchUrlTool.execute({ url: "https://example.com/page" }, ctx);
      check("ok is true", result.ok === true);
      check("script contents are stripped out", !result.output?.content.includes("alert(1)"));
      check("style contents are stripped out", !result.output?.content.includes("color:red"));
      check("tags are stripped but text content survives", !!result.output?.content.includes("Title") && !!result.output?.content.includes("First paragraph."));
      check("no raw tag markup leaks through", !result.output?.content.includes("<h1>") && !result.output?.content.includes("<p>"));
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log("\nfetchUrlTool: a non-OK HTTP response is a clean failure, not a throw:");
  {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("not found", { status: 404, statusText: "Not Found" })) as typeof fetch;
    try {
      const result = await fetchUrlTool.execute({ url: "https://example.com/missing" }, ctx);
      check("ok is false", result.ok === false);
      check("error mentions the status", !!result.error?.includes("404"));
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log("\nfetchUrlTool: a network-level failure (DNS/TLS/connection) is caught, not thrown:");
  {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND does-not-exist.invalid");
    }) as typeof fetch;
    try {
      const result = await fetchUrlTool.execute({ url: "https://does-not-exist.invalid/" }, ctx);
      check("ok is false", result.ok === false);
      check("the underlying error message is surfaced", !!result.error?.includes("ENOTFOUND"));
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log("\nfetchUrlTool: a very large response is truncated, not returned whole:");
  {
    const realFetch = globalThis.fetch;
    const huge = "x".repeat(200_000);
    globalThis.fetch = (async () => new Response(huge, { status: 200, headers: { "content-type": "text/plain" } })) as typeof fetch;
    try {
      const result = await fetchUrlTool.execute({ url: "https://example.com/huge.txt" }, ctx);
      check("ok is true", result.ok === true);
      check("content is capped well under the full 200,000 chars", (result.output?.content.length ?? 0) < 200_000);
      check("truncated flag is set", result.truncated === true);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
