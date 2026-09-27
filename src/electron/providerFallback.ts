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
  gemini: "gemini-2.5-flash",
};

const SETTINGS_FILENAME_BY_KIND: Record<CloudProviderKind, string> = {
  anthropic: "anthropic-settings.json",
  openai: "openai-settings.json",
  gemini: "gemini-settings.json",
};

/**
 * Every official cloud provider with a saved API key, in the order each
 * key was FIRST saved (addedAt), excluding whichever kind just failed.
 * Fallback only ever draws from this list — the embedded provider and
 * custom OpenAI-compatible servers never appear here, since neither has
 * a "quota" in the sense this feature addresses.
 */
export async function resolveFallbackOrder(
  settingsDir: string,
  storageCrypto: StorageCrypto | undefined,
  excludeKind: CloudProviderKind
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
    .filter((c): c is { kind: CloudProviderKind; apiKey: string; addedAt: number } => c.apiKey !== null && c.addedAt !== null)
    .filter((c) => c.kind !== excludeKind)
    .sort((a, b) => a.addedAt - b.addedAt)
    .map((c) => ({ kind: c.kind, apiKey: c.apiKey, model: DEFAULT_MODEL_BY_KIND[c.kind] }));
}
