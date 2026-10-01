import path from "node:path";
import { loadAnthropicSettings } from "./anthropicSettings.js";
import { loadOpenAISettings } from "./openaiSettings.js";
import { loadGeminiSettings } from "./geminiSettings.js";
import type { StorageCrypto } from "./googleAuth.js";

export type CloudProviderKind = "anthropic" | "openai" | "gemini";

export interface ConfiguredCloudProvider {
  kind: CloudProviderKind;
  apiKey: string;
  model: string;
}

export const DEFAULT_MODEL_BY_KIND: Record<CloudProviderKind, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.5",
  gemini: "gemini-3.8-flash",
};

// Matches main.ts's real, already-shipped file naming exactly
// (path.join(app.getPath("userData"), "anthropicSettings.json")) — these
// are NOT a new convention; getting this wrong would mean this function
// silently never finds a real user's saved settings in production, only
// ever working against test fixtures that happen to use whatever name
// this file itself expects.
const SETTINGS_FILENAME_BY_KIND: Record<CloudProviderKind, string> = {
  anthropic: "anthropicSettings.json",
  openai: "openaiSettings.json",
  gemini: "geminiSettings.json",
};

/**
 * Every official cloud provider with a saved API key, in the order each
 * key was FIRST saved (addedAt), excluding whichever kind just failed.
 * Fallback only ever draws from this list — the embedded provider and
 * custom OpenAI-compatible servers never appear here, since neither has
 * a "quota" in the sense this feature addresses.
 *
 * `excludeKind` is `undefined` when the provider that just failed isn't
 * itself a CloudProviderKind at all — e.g. the freellmapi free-tier router,
 * which has no per-provider settings file of its own and is never a valid
 * fallback TARGET (cloud providers only ever fall back to other cloud
 * providers, or freellmapi falls back to cloud — never the reverse). In
 * that case every configured cloud provider is a candidate.
 */
export async function resolveFallbackOrder(
  settingsDir: string,
  storageCrypto: StorageCrypto | undefined,
  excludeKind: CloudProviderKind | undefined
): Promise<ConfiguredCloudProvider[]> {
  const [anthropic, openai, gemini] = await Promise.all([
    loadAnthropicSettings(path.join(settingsDir, SETTINGS_FILENAME_BY_KIND.anthropic), storageCrypto),
    loadOpenAISettings(path.join(settingsDir, SETTINGS_FILENAME_BY_KIND.openai), storageCrypto),
    loadGeminiSettings(path.join(settingsDir, SETTINGS_FILENAME_BY_KIND.gemini), storageCrypto),
  ]);

  const candidates: { kind: CloudProviderKind; apiKey: string | null; addedAt: number | null }[] = [
    { kind: "anthropic", apiKey: anthropic.apiKey, addedAt: anthropic.addedAt },
    { kind: "openai", apiKey: openai.apiKey, addedAt: openai.addedAt },
    { kind: "gemini", apiKey: gemini.apiKey, addedAt: gemini.addedAt },
  ];

  return candidates
    .filter((c): c is { kind: CloudProviderKind; apiKey: string; addedAt: number | null } => c.apiKey !== null)
    .filter((c) => excludeKind === undefined || c.kind !== excludeKind)
    // A key saved before addedAt existed (or written directly, bypassing
    // save*Settings) loads back with addedAt: null. Treating that as the
    // oldest possible value (rather than dropping the candidate) means a
    // pre-existing key still participates in fallback — it just sorts
    // first, same as if it had really been added on day one.
    .sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0))
    .map((c) => ({ kind: c.kind, apiKey: c.apiKey, model: DEFAULT_MODEL_BY_KIND[c.kind] }));
}
