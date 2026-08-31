import fs from "node:fs/promises";
import type { StorageCrypto } from "./googleAuth.js";

export interface AnthropicSettings {
  apiKey: string | null;
}

export async function loadAnthropicSettings(settingsFilePath: string, storageCrypto?: StorageCrypto): Promise<AnthropicSettings> {
  try {
    const raw = await fs.readFile(settingsFilePath, "utf-8");
    const json = storageCrypto ? storageCrypto.decrypt(raw) : raw;
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object") return { apiKey: null };
    const s = parsed as Partial<AnthropicSettings>;
    return { apiKey: typeof s.apiKey === "string" ? s.apiKey : null };
  } catch {
    return { apiKey: null };
  }
}

export async function saveAnthropicSettings(settingsFilePath: string, settings: AnthropicSettings, storageCrypto?: StorageCrypto): Promise<void> {
  const json = JSON.stringify(settings, null, 2);
  const toWrite = storageCrypto ? storageCrypto.encrypt(json) : json;
  await fs.writeFile(settingsFilePath, toWrite, { encoding: "utf-8", mode: 0o600 });
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
