import fs from "node:fs/promises";
import type { StorageCrypto } from "./googleAuth.js";

export interface GeminiSettings {
  apiKey: string | null;
  /** Set once, the first time a non-null key is ever saved — never updated on a later save. See anthropicSettings.ts's identical field for why. */
  addedAt: number | null;
}

export async function loadGeminiSettings(settingsFilePath: string, storageCrypto?: StorageCrypto): Promise<GeminiSettings> {
  try {
    const raw = await fs.readFile(settingsFilePath, "utf-8");
    const json = storageCrypto ? storageCrypto.decrypt(raw) : raw;
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object") return { apiKey: null, addedAt: null };
    const s = parsed as Partial<GeminiSettings>;
    return {
      apiKey: typeof s.apiKey === "string" ? s.apiKey : null,
      addedAt: typeof s.addedAt === "number" ? s.addedAt : null,
    };
  } catch {
    return { apiKey: null, addedAt: null };
  }
}

export async function saveGeminiSettings(
  settingsFilePath: string,
  settings: { apiKey: string | null },
  storageCrypto?: StorageCrypto
): Promise<void> {
  const existing = await loadGeminiSettings(settingsFilePath, storageCrypto);
  const addedAt = existing.addedAt ?? (settings.apiKey ? Date.now() : null);
  const toSave: GeminiSettings = { apiKey: settings.apiKey, addedAt };
  const json = JSON.stringify(toSave, null, 2);
  const toWrite = storageCrypto ? storageCrypto.encrypt(json) : json;
  await fs.writeFile(settingsFilePath, toWrite, { encoding: "utf-8", mode: 0o600 });
}

/** Same env-var-wins-then-saved-settings-then-undefined chain as resolveAnthropicApiKey — see that function's doc comment for the full reasoning (in particular, why this deliberately never resolves to an embedded key). */
export async function resolveGeminiApiKey(settingsFilePath: string, storageCrypto?: StorageCrypto): Promise<string | undefined> {
  if (process.env.GEMINI_API_KEY) {
    return process.env.GEMINI_API_KEY;
  }
  const settings = await loadGeminiSettings(settingsFilePath, storageCrypto);
  return settings.apiKey ?? undefined;
}
