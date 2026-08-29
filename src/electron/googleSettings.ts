import fs from "node:fs/promises";
import type { StorageCrypto } from "./googleAuth.js";

export interface GoogleSettings {
  clientId: string | null;
  clientSecret: string | null;
}

export async function loadGoogleSettings(settingsFilePath: string, storageCrypto?: StorageCrypto): Promise<GoogleSettings> {
  try {
    const raw = await fs.readFile(settingsFilePath, "utf-8");
    const json = storageCrypto ? storageCrypto.decrypt(raw) : raw;
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object") return { clientId: null, clientSecret: null };
    const s = parsed as Partial<GoogleSettings>;
    return {
      clientId: typeof s.clientId === "string" ? s.clientId : null,
      clientSecret: typeof s.clientSecret === "string" ? s.clientSecret : null,
    };
  } catch {
    return { clientId: null, clientSecret: null };
  }
}

export async function saveGoogleSettings(settingsFilePath: string, settings: GoogleSettings, storageCrypto?: StorageCrypto): Promise<void> {
  const json = JSON.stringify(settings, null, 2);
  const toWrite = storageCrypto ? storageCrypto.encrypt(json) : json;
  await fs.writeFile(settingsFilePath, toWrite, { encoding: "utf-8", mode: 0o600 });
}

/**
 * Resolves the Google OAuth credentials actually used at runtime. An
 * explicitly-set environment variable always wins (matches loadEnvFile's
 * own "already-set env var wins over the file" rule) — saved Settings are
 * the fallback, exactly for the case that's broken in a packaged install
 * (no .env, no project root to find one in).
 */
export async function resolveGoogleCredentials(
  settingsFilePath: string,
  storageCrypto?: StorageCrypto
): Promise<{ clientId: string; clientSecret: string | undefined }> {
  if (process.env.GOOGLE_OAUTH_CLIENT_ID) {
    return { clientId: process.env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET };
  }
  const settings = await loadGoogleSettings(settingsFilePath, storageCrypto);
  return { clientId: settings.clientId ?? "", clientSecret: settings.clientSecret ?? undefined };
}
