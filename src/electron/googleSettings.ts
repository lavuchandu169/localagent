import type { StorageCrypto } from "./googleAuth.js";
import { EMBEDDED_GOOGLE_CLIENT_ID, EMBEDDED_GOOGLE_CLIENT_SECRET } from "./embeddedCredentials.js";
import { loadEncryptedJson, saveEncryptedJson } from "./encryptedJsonFile.js";

export interface GoogleSettings {
  clientId: string | null;
  clientSecret: string | null;
}

function parseGoogleSettings(parsed: unknown): GoogleSettings {
  const s = (parsed ?? {}) as Partial<GoogleSettings>;
  return {
    clientId: typeof s.clientId === "string" ? s.clientId : null,
    clientSecret: typeof s.clientSecret === "string" ? s.clientSecret : null,
  };
}

export async function loadGoogleSettings(settingsFilePath: string, storageCrypto?: StorageCrypto): Promise<GoogleSettings> {
  return loadEncryptedJson(settingsFilePath, storageCrypto, parseGoogleSettings, { clientId: null, clientSecret: null });
}

export async function saveGoogleSettings(settingsFilePath: string, settings: GoogleSettings, storageCrypto?: StorageCrypto): Promise<void> {
  await saveEncryptedJson(settingsFilePath, settings, storageCrypto);
}

/**
 * Resolves the Google OAuth credentials actually used at runtime, in order:
 *
 * 1. An explicitly-set environment variable always wins (matches
 *    loadEnvFile's own "already-set env var wins over the file" rule) — for
 *    developers running from source with their own .env.
 * 2. Saved Settings — a user's own credentials, entered via the in-app
 *    Settings panel, for anyone who wants their own Google Cloud quota.
 * 3. The embedded default — a Client ID (and Client Secret, if this app's
 *    OAuth client needs one) baked into official release builds at CI time
 *    (see scripts/generate-embedded-credentials.mjs), so a fresh install
 *    works immediately with no setup. `null` in every local/from-source
 *    build, where this tier is simply skipped.
 *
 * Embedding a secret here is safe per Google/RFC 8252's own guidance for
 * installed apps: a native app's client secret ships in every copy and
 * can't be kept confidential, which is exactly why this app's flow already
 * uses PKCE regardless of whether a secret is present.
 */
export async function resolveGoogleCredentials(
  settingsFilePath: string,
  storageCrypto?: StorageCrypto,
  embeddedClientId: string | null = EMBEDDED_GOOGLE_CLIENT_ID,
  embeddedClientSecret: string | null = EMBEDDED_GOOGLE_CLIENT_SECRET
): Promise<{ clientId: string; clientSecret: string | undefined }> {
  if (process.env.GOOGLE_OAUTH_CLIENT_ID) {
    return { clientId: process.env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET };
  }
  const settings = await loadGoogleSettings(settingsFilePath, storageCrypto);
  if (settings.clientId) {
    return { clientId: settings.clientId, clientSecret: settings.clientSecret ?? undefined };
  }
  return { clientId: embeddedClientId ?? "", clientSecret: embeddedClientSecret ?? undefined };
}
