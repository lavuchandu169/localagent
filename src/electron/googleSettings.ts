import fs from "node:fs/promises";
import type { StorageCrypto } from "./googleAuth.js";
import { EMBEDDED_GOOGLE_CLIENT_ID } from "./embeddedCredentials.js";

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
 * Resolves the Google OAuth credentials actually used at runtime, in order:
 *
 * 1. An explicitly-set environment variable always wins (matches
 *    loadEnvFile's own "already-set env var wins over the file" rule) — for
 *    developers running from source with their own .env.
 * 2. Saved Settings — a user's own credentials, entered via the in-app
 *    Settings panel, for anyone who wants their own Google Cloud quota.
 * 3. The embedded default — a Client ID baked into official release builds
 *    at CI time (see scripts/generate-embedded-credentials.mjs), so a fresh
 *    install works immediately with no setup. `null` in every local/from-source
 *    build, where this tier is simply skipped.
 *
 * The embedded default never carries a secret — it's a Client-ID-only
 * Desktop-app OAuth client (PKCE), matching how this app already signs in.
 */
export async function resolveGoogleCredentials(
  settingsFilePath: string,
  storageCrypto?: StorageCrypto,
  embeddedClientId: string | null = EMBEDDED_GOOGLE_CLIENT_ID
): Promise<{ clientId: string; clientSecret: string | undefined }> {
  if (process.env.GOOGLE_OAUTH_CLIENT_ID) {
    return { clientId: process.env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET };
  }
  const settings = await loadGoogleSettings(settingsFilePath, storageCrypto);
  if (settings.clientId) {
    return { clientId: settings.clientId, clientSecret: settings.clientSecret ?? undefined };
  }
  return { clientId: embeddedClientId ?? "", clientSecret: undefined };
}
