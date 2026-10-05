import type { StorageCrypto } from "./googleAuth.js";
import { loadEncryptedJson, saveEncryptedJson } from "./encryptedJsonFile.js";

export interface OpenAISettings {
  apiKey: string | null;
  /** Set once, the first time a non-null key is ever saved — never updated on a later save. See anthropicSettings.ts's identical field for why. */
  addedAt: number | null;
}

function parseOpenAISettings(parsed: unknown): OpenAISettings {
  const s = (parsed ?? {}) as Partial<OpenAISettings>;
  return {
    apiKey: typeof s.apiKey === "string" ? s.apiKey : null,
    addedAt: typeof s.addedAt === "number" ? s.addedAt : null,
  };
}

export async function loadOpenAISettings(settingsFilePath: string, storageCrypto?: StorageCrypto): Promise<OpenAISettings> {
  return loadEncryptedJson(settingsFilePath, storageCrypto, parseOpenAISettings, { apiKey: null, addedAt: null });
}

export async function saveOpenAISettings(
  settingsFilePath: string,
  settings: { apiKey: string | null },
  storageCrypto?: StorageCrypto
): Promise<void> {
  const existing = await loadOpenAISettings(settingsFilePath, storageCrypto);
  const addedAt = existing.addedAt ?? (settings.apiKey ? Date.now() : null);
  const toSave: OpenAISettings = { apiKey: settings.apiKey, addedAt };
  await saveEncryptedJson(settingsFilePath, toSave, storageCrypto);
}

/** Same env-var-wins-then-saved-settings-then-undefined chain as resolveAnthropicApiKey — see that function's doc comment for the full reasoning (in particular, why this deliberately never resolves to an embedded key). */
export async function resolveOpenAIApiKey(settingsFilePath: string, storageCrypto?: StorageCrypto): Promise<string | undefined> {
  if (process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }
  const settings = await loadOpenAISettings(settingsFilePath, storageCrypto);
  return settings.apiKey ?? undefined;
}
