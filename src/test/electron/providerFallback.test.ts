import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveFallbackOrder } from "../../electron/providerFallback.js";
import { saveAnthropicSettings } from "../../electron/anthropicSettings.js";
import { saveOpenAISettings } from "../../electron/openaiSettings.js";
import { saveGeminiSettings } from "../../electron/geminiSettings.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("resolveFallbackOrder:");

{
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-fallback-test-"));
  const order = await resolveFallbackOrder(settingsDir, undefined, "anthropic");
  check("no saved keys means no fallback candidates", order.length === 0);
}

{
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-fallback-test-"));
  // Saved out of alphabetical/kind order on purpose — Gemini first, then
  // Anthropic, then OpenAI — to prove sort-by-addedAt, not a fixed kind order.
  await saveGeminiSettings(path.join(settingsDir, "geminiSettings.json"), { apiKey: "gk-1" });
  await new Promise((r) => setTimeout(r, 5));
  await saveAnthropicSettings(path.join(settingsDir, "anthropicSettings.json"), { apiKey: "ak-1" });
  await new Promise((r) => setTimeout(r, 5));
  await saveOpenAISettings(path.join(settingsDir, "openaiSettings.json"), { apiKey: "ok-1" });

  const order = await resolveFallbackOrder(settingsDir, undefined, "anthropic");
  check("excludes the active kind (anthropic)", !order.some((p) => p.kind === "anthropic"));
  check("includes every OTHER provider with a saved key", order.length === 2);
  check(
    "orders by addedAt ascending (gemini saved first, so it comes first)",
    order[0]?.kind === "gemini" && order[1]?.kind === "openai"
  );
  check("each entry carries its real saved API key", order[0]?.apiKey === "gk-1" && order[1]?.apiKey === "ok-1");
  check("each entry carries a sensible default model", typeof order[0]?.model === "string" && (order[0]?.model.length ?? 0) > 0);
}

{
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-fallback-test-"));
  await saveAnthropicSettings(path.join(settingsDir, "anthropicSettings.json"), { apiKey: "ak-1" });
  const order = await resolveFallbackOrder(settingsDir, undefined, "anthropic");
  check("excluding the only configured provider leaves nothing to fall back to", order.length === 0);
}

{
  // A key saved by a version of the app that predates addedAt (or written
  // directly, bypassing saveAnthropicSettings) has no addedAt field at all
  // — loadAnthropicSettings reads that back as apiKey set, addedAt: null.
  // Such a key must still be usable as a fallback candidate, not silently
  // dropped just because it predates the ordering field.
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-fallback-test-"));
  await fs.writeFile(path.join(settingsDir, "geminiSettings.json"), JSON.stringify({ apiKey: "legacy-gk-1" }));
  const order = await resolveFallbackOrder(settingsDir, undefined, "anthropic");
  check("a key with no addedAt at all (pre-dates the field) still becomes a fallback candidate", order.length === 1);
  check("its real saved API key is carried through", order[0]?.apiKey === "legacy-gk-1");
}

{
  // The freellmapi free-tier router is never itself a CloudProviderKind
  // (it has no per-provider settings file, and cloud providers must never
  // be offered as a fallback FOR it — only the other direction), so when
  // IT is the one that just failed there is no kind to exclude. Every
  // configured cloud provider is a valid fallback candidate.
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-fallback-test-"));
  await saveAnthropicSettings(path.join(settingsDir, "anthropicSettings.json"), { apiKey: "ak-1" });
  await new Promise((r) => setTimeout(r, 5));
  await saveOpenAISettings(path.join(settingsDir, "openaiSettings.json"), { apiKey: "ok-1" });

  const order = await resolveFallbackOrder(settingsDir, undefined, undefined);
  check("with no excludeKind, every configured cloud provider is a candidate", order.length === 2);
  check("still ordered by addedAt ascending", order[0]?.kind === "anthropic" && order[1]?.kind === "openai");
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
