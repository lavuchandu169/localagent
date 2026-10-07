// src/test/freellmapiFallbackApi.test.ts
import {
  getRouting,
  updateRouting,
  getModelList,
  updateModelList,
  sortModelList,
} from "../../electron/freellmapiFallbackApi.js";

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

console.log("getRouting:");
{
  let capturedUrl = "";
  let capturedAuth = "";
  const restore = fakeFetch((url, init) => {
    capturedUrl = url;
    capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
    return new Response(
      JSON.stringify({
        strategy: "balanced",
        keySelectionStrategy: "auto",
        weights: { reliability: 0.5, speed: 0.25, intelligence: 0.25 },
        customWeights: { reliability: 0.34, speed: 0.33, intelligence: 0.33 },
        exploreEnabled: true,
        peakAdjusted: false,
        scores: [],
        peakHoursAdjust: false,
        peakStartHour: 18,
        peakEndHour: 6,
        peakTimezone: "UTC",
        cooldownCeilingMs: 3600000,
      }),
      { status: 200 }
    );
  });
  try {
    const result = await getRouting(conn);
    check("calls GET /api/fallback/routing on the given port", capturedUrl === "http://127.0.0.1:19700/api/fallback/routing");
    check("sends the token as a Bearer header", capturedAuth === "Bearer test-token");
    check("returns the real strategy", result.strategy === "balanced");
    check("returns the real peak-hours fields", result.peakStartHour === 18 && result.peakTimezone === "UTC");
    check("returns the real cooldown ceiling", result.cooldownCeilingMs === 3600000);
  } finally {
    restore();
  }
}

console.log("\nupdateRouting:");
{
  let sentMethod = "";
  let sentBody: any = null;
  const restore = fakeFetch((url, init) => {
    sentMethod = init?.method ?? "";
    sentBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        strategy: "custom",
        exploreEnabled: true,
        keySelectionStrategy: "auto",
        presets: { balanced: { reliability: 0.5, speed: 0.25, intelligence: 0.25 } },
        weights: { reliability: 0.6, speed: 0.2, intelligence: 0.2 },
        peakAdjusted: false,
        peakHoursAdjust: false,
        peakStartHour: 18,
        peakEndHour: 6,
        peakTimezone: "UTC",
        cooldownCeilingMs: null,
      }),
      { status: 200 }
    );
  });
  try {
    const result = await updateRouting(conn, { strategy: "custom", weights: { reliability: 0.6, speed: 0.2, intelligence: 0.2 } });
    check("PUTs /api/fallback/routing", sentMethod === "PUT" && sentBody.strategy === "custom");
    check("sends the weights", sentBody.weights.reliability === 0.6);
    check("returns the real echoed-back weights (may differ from what was sent, e.g. under peak-hours adjustment)", result.weights!.reliability === 0.6);
    check("cooldownCeilingMs:null round-trips as null, not omitted", result.cooldownCeilingMs === null);
  } finally {
    restore();
  }
}

console.log("\nupdateRouting surfaces a real validation error (e.g. an invalid timezone):");
{
  const restore = fakeFetch(() => new Response(JSON.stringify({ error: { message: "peakTimezone must be a valid IANA timezone name" } }), { status: 400 }));
  try {
    let threw = false;
    try {
      await updateRouting(conn, { strategy: "balanced", peakHoursAdjust: true, peakTimezone: "Not/AZone" });
    } catch (err) {
      threw = true;
      check("throws with the real server message", err instanceof Error && err.message === "peakTimezone must be a valid IANA timezone name");
    }
    check("a 400 response throws rather than silently returning", threw);
  } finally {
    restore();
  }
}

console.log("\ngetModelList:");
{
  const restore = fakeFetch((url) => {
    check("GETs /api/fallback/", url === "http://127.0.0.1:19700/api/fallback/");
    return new Response(
      JSON.stringify([
        {
          modelDbId: 1, groupKey: null, canonicalId: null, groupLabel: null, priority: 1, effectivePriority: 1,
          penalty: 0, rateLimitHits: 0, enabled: true, platform: "groq", modelId: "llama-3.3-70b", displayName: "Llama 3.3 70B",
          intelligenceRank: 2, speedRank: 1, sizeLabel: "Large", rpmLimit: 30, rpdLimit: 1000, tpmLimit: 6000, tpdLimit: null,
          contextWindow: 128000, monthlyTokenBudget: "unlimited", monthlyTokenBudgetTokens: 0, supportsVision: false, supportsTools: true,
          source: "catalog", keyId: null, keyLabel: null, endpointScope: null, qualifiedModelId: "groq:llama-3.3-70b",
          hasOverrides: false, overrideFields: [], retiredUpstream: false, retiredReason: null, keyCount: 1,
        },
      ]),
      { status: 200 }
    );
  });
  try {
    const rows = await getModelList(conn);
    check("returns the bare array the server sends (GET / is not wrapped)", Array.isArray(rows) && rows.length === 1);
    check("preserves real fields", rows[0]!.displayName === "Llama 3.3 70B" && rows[0]!.platform === "groq");
  } finally {
    restore();
  }
}

console.log("\nupdateModelList:");
{
  let sentBody: any = null;
  const restore = fakeFetch((url, init) => {
    sentBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
  try {
    const result = await updateModelList(conn, [{ modelDbId: 1, priority: 2, enabled: true }]);
    check("PUTs /api/fallback/ with the full replace array", Array.isArray(sentBody) && sentBody[0].modelDbId === 1 && sentBody[0].priority === 2);
    check("returns success:true", result.success === true);
  } finally {
    restore();
  }
}

console.log("\nsortModelList:");
{
  let sentMethod = "";
  const restore = fakeFetch((url, init) => {
    check("POSTs /api/fallback/sort/:preset with the preset in the URL", url === "http://127.0.0.1:19700/api/fallback/sort/speed");
    sentMethod = init?.method ?? "";
    return new Response(JSON.stringify({ success: true, preset: "speed" }), { status: 200 });
  });
  try {
    const result = await sortModelList(conn, "speed");
    check("POSTs (not GET)", sentMethod === "POST");
    check("returns the real preset name echoed back", result.preset === "speed");
  } finally {
    restore();
  }
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
