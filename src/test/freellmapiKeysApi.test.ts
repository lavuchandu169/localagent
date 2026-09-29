import {
  listProviders,
  listKeys,
  addKey,
  updateKey,
  removeKey,
  clearCooldown,
  revealKey,
  previewImport,
  importSelected,
  exportKeys,
  updatePlatformSettings,
} from "../electron/freellmapiKeysApi.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

const conn = { port: 19700, token: "test-token" };

function fakeFetch(handler: (url: string, init?: RequestInit) => Response) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => handler(url, init)) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

console.log("listProviders:");
{
  let capturedUrl = "";
  let capturedAuth = "";
  const restore = fakeFetch((url, init) => {
    capturedUrl = url;
    capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
    return new Response(
      JSON.stringify({
        providers: [{ platform: "groq", name: "Groq", keyless: false, configured: false, keyCount: 0, enabledKeyCount: 0 }],
        summary: { total: 1, configured: 0, unconfigured: 1 },
      }),
      { status: 200 }
    );
  });
  try {
    const result = await listProviders(conn);
    check("calls GET /api/keys/providers on the given port", capturedUrl === "http://127.0.0.1:19700/api/keys/providers");
    check("sends the token as a Bearer header", capturedAuth === "Bearer test-token");
    check("returns the parsed providers list", result.providers[0]!.platform === "groq");
    check("returns the summary block", result.summary.total === 1);
  } finally {
    restore();
  }
}

console.log("\nlistKeys:");
{
  const restore = fakeFetch((url) => {
    if (!url.endsWith("/api/keys/")) return new Response("not found", { status: 404 });
    return new Response(
      JSON.stringify([{ id: 1, platform: "groq", label: "", maskedKey: "gr_****abcd", status: "healthy", enabled: true, keyless: false, exportable: true, cooldowns: [], modelScope: null, maskedProxyUrl: "", baseUrl: null, monthlyRequestCap: null, monthlyTokenCap: null, createdAt: "2026-01-01", lastCheckedAt: null, lastHealthError: null }]),
      { status: 200 }
    );
  });
  try {
    const keys = await listKeys(conn);
    check("returns the bare array the server sends (GET / is not wrapped)", Array.isArray(keys) && keys.length === 1);
    check("preserves real fields", keys[0]!.maskedKey === "gr_****abcd");
  } finally {
    restore();
  }
}

console.log("\naddKey:");
{
  let sentBody: any = null;
  const restore = fakeFetch((url, init) => {
    sentBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({ id: 5, platform: "groq", label: "my key", maskedKey: "gr_****wxyz", status: "unknown", enabled: true }),
      { status: 201 }
    );
  });
  try {
    const result = await addKey(conn, { platform: "groq", key: "gr_real_secret", label: "my key" });
    check("POSTs to /api/keys/ with the platform/key/label", sentBody.platform === "groq" && sentBody.key === "gr_real_secret" && sentBody.label === "my key");
    check("returns the created key's id", result.id === 5);
    check("never echoes the raw key back out of this function's own return value", (result as any).key === undefined);
  } finally {
    restore();
  }
}

console.log("\naddKey surfaces the real server error on failure:");
{
  const restore = fakeFetch(() => new Response(JSON.stringify({ error: { message: "key is required" } }), { status: 400 }));
  try {
    let threw = false;
    try {
      await addKey(conn, { platform: "groq" });
    } catch (err) {
      threw = true;
      check("throws with the server's real message", err instanceof Error && err.message === "key is required");
    }
    check("a 400 response throws rather than silently returning", threw);
  } finally {
    restore();
  }
}

console.log("\nupdateKey:");
{
  let sentMethod = "";
  let sentUrl = "";
  const restore = fakeFetch((url, init) => {
    sentMethod = init?.method ?? "";
    sentUrl = url;
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
  try {
    const result = await updateKey(conn, 5, { enabled: false });
    check("PATCHes /api/keys/:id", sentMethod === "PATCH" && sentUrl === "http://127.0.0.1:19700/api/keys/5");
    check("returns success:true", result.success === true);
  } finally {
    restore();
  }
}

console.log("\nremoveKey:");
{
  let sentMethod = "";
  const restore = fakeFetch((url, init) => {
    sentMethod = init?.method ?? "";
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
  try {
    await removeKey(conn, 5);
    check("DELETEs /api/keys/:id", sentMethod === "DELETE");
  } finally {
    restore();
  }
}

console.log("\nclearCooldown:");
{
  const restore = fakeFetch((url) => {
    check("DELETEs /api/keys/:id/cooldowns", url === "http://127.0.0.1:19700/api/keys/5/cooldowns");
    return new Response(JSON.stringify({ cleared: 2 }), { status: 200 });
  });
  try {
    const result = await clearCooldown(conn, 5);
    check("returns how many cooldowns were cleared", result.cleared === 2);
  } finally {
    restore();
  }
}

console.log("\nrevealKey:");
{
  const restore = fakeFetch((url) => {
    check("POSTs /api/keys/:id/reveal", url === "http://127.0.0.1:19700/api/keys/5/reveal");
    return new Response(JSON.stringify({ key: "gr_real_secret" }), { status: 200 });
  });
  try {
    const result = await revealKey(conn, 5);
    check("returns the real plaintext key", result.key === "gr_real_secret");
  } finally {
    restore();
  }
}

console.log("\npreviewImport:");
{
  let capturedInit: RequestInit | undefined;
  const restore = fakeFetch((url, init) => {
    capturedInit = init;
    check("POSTs multipart to /api/keys/preview", url === "http://127.0.0.1:19700/api/keys/preview");
    return new Response(
      JSON.stringify({ keys: [{ keyName: "GROQ_KEY", keyValue: "gr_abc", detectedPlatform: "groq", prefix: "gr_", isDuplicate: false }], total: 1, skipped: [], duplicates: 0 }),
      { status: 200 }
    );
  });
  try {
    const result = await previewImport(conn, [{ filename: "keys.env", content: Buffer.from("GROQ_KEY=gr_abc") }]);
    check("sends the file as multipart form data, not JSON", !(capturedInit?.headers as any)?.["Content-Type"]?.includes("application/json"));
    check("returns the parsed preview entries", result.keys[0]!.detectedPlatform === "groq");
    check("returns the total count", result.total === 1);
  } finally {
    restore();
  }
}

console.log("\nimportSelected:");
{
  let sentBody: any = null;
  const restore = fakeFetch((url, init) => {
    sentBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ imported: 1, skipped: [], errors: [], total: 1, modelsRegistered: 0 }), { status: 200 });
  });
  try {
    const result = await importSelected(conn, [{ keyName: "GROQ_KEY", keyValue: "gr_abc", platform: "groq" }]);
    check("POSTs {keys: [...]} as JSON", Array.isArray(sentBody.keys) && sentBody.keys[0].platform === "groq");
    check("returns the import summary", result.imported === 1);
  } finally {
    restore();
  }
}

console.log("\nexportKeys:");
{
  const restore = fakeFetch((url) => {
    check("GETs /api/keys/export", url === "http://127.0.0.1:19700/api/keys/export?format=json");
    return new Response(JSON.stringify([{ platform: "groq", key: "gr_abc", label: "" }]), { status: 200 });
  });
  try {
    const result = await exportKeys(conn, "json");
    check("returns the real exported keys", result[0]!.key === "gr_abc");
  } finally {
    restore();
  }
}

console.log("\nexportKeys surfaces the real 'nothing to export' error:");
{
  const restore = fakeFetch(() => new Response(JSON.stringify({ error: { message: "No keys to export" } }), { status: 404 }));
  try {
    let threw = false;
    try {
      await exportKeys(conn, "json");
    } catch (err) {
      threw = true;
      check("surfaces the real message, not a generic one", err instanceof Error && err.message === "No keys to export");
    }
    check("a 404 with no keys throws", threw);
  } finally {
    restore();
  }
}

console.log("\nupdatePlatformSettings:");
{
  let sentMethod = "";
  const restore = fakeFetch((url, init) => {
    sentMethod = init?.method ?? "";
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
  try {
    await updatePlatformSettings(conn, "groq", { enabled: false });
    check("PATCHes /api/keys/platform/:platform", sentMethod === "PATCH");
  } finally {
    restore();
  }
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
