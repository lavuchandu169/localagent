import type { StorageCrypto } from "./googleAuth.js";
import { loadEncryptedJson, saveEncryptedJson } from "./encryptedJsonFile.js";

export interface AnthropicSettings {
  apiKey: string | null;
  /** Set once, the first time saveAnthropicSettings is ever called with a
   * non-null key — never updated on a later save. Rotating an existing key
   * doesn't reshuffle fallback priority (see providerFallback.ts). */
  addedAt: number | null;
}

function parseAnthropicSettings(parsed: unknown): AnthropicSettings {
  const s = (parsed ?? {}) as Partial<AnthropicSettings>;
  return {
    apiKey: typeof s.apiKey === "string" ? s.apiKey : null,
    addedAt: typeof s.addedAt === "number" ? s.addedAt : null,
  };
}

export async function loadAnthropicSettings(settingsFilePath: string, storageCrypto?: StorageCrypto): Promise<AnthropicSettings> {
  return loadEncryptedJson(settingsFilePath, storageCrypto, parseAnthropicSettings, { apiKey: null, addedAt: null });
}

export async function saveAnthropicSettings(
  settingsFilePath: string,
  settings: { apiKey: string | null },
  storageCrypto?: StorageCrypto
): Promise<void> {
  const existing = await loadAnthropicSettings(settingsFilePath, storageCrypto);
  const addedAt = existing.addedAt ?? (settings.apiKey ? Date.now() : null);
  const toSave: AnthropicSettings = { apiKey: settings.apiKey, addedAt };
  await saveEncryptedJson(settingsFilePath, toSave, storageCrypto);
}

/**
 * Resolves the Anthropic API key actually used at runtime, in order:
 *
 * 1. An explicitly-set ANTHROPIC_API_KEY environment variable always wins
 *    (matches loadEnvFile's own "already-set env var wins over the file"
 *    rule) — for developers running from source with their own .env.
 * 2. Saved Settings — a user's own key, entered via the in-app Settings
 *    panel, for anyone who wants to use Claude in the packaged app.
 * 3. `undefined` — deliberately NOT resolved to anything embedded. Unlike
 *    the Google OAuth Client ID, an Anthropic API key is billed to
 *    whoever owns it: baking one into official builds would mean every
 *    user's usage bills to this project's own account, uncapped, the
 *    moment the key ships in a public binary — a real production
 *    incident waiting to happen, not a viable "just embed it" tier. An
 *    undefined return here is intentional: AnthropicProvider passes it
 *    straight to `new Anthropic({apiKey: undefined})`, which the SDK
 *    treats exactly like not passing the option at all — its own
 *    fallback chain (ANTHROPIC_AUTH_TOKEN, an `ant auth login` profile)
 *    keeps working completely untouched.
 */
export async function resolveAnthropicApiKey(settingsFilePath: string, storageCrypto?: StorageCrypto): Promise<string | undefined> {
  if (process.env.ANTHROPIC_API_KEY) {
    return process.env.ANTHROPIC_API_KEY;
  }
  const settings = await loadAnthropicSettings(settingsFilePath, storageCrypto);
  return settings.apiKey ?? undefined;
}
