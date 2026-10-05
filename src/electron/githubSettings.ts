// src/electron/githubSettings.ts
import type { StorageCrypto } from "./googleAuth.js";
import { EMBEDDED_GITHUB_CLIENT_ID } from "./embeddedCredentials.js";
import { loadEncryptedJson, saveEncryptedJson } from "./encryptedJsonFile.js";

export interface GithubSettings {
  clientId: string | null;
}

function parseGithubSettings(parsed: unknown): GithubSettings {
  const s = (parsed ?? {}) as Partial<GithubSettings>;
  return { clientId: typeof s.clientId === "string" ? s.clientId : null };
}

export async function loadGithubSettings(settingsFilePath: string, storageCrypto?: StorageCrypto): Promise<GithubSettings> {
  return loadEncryptedJson(settingsFilePath, storageCrypto, parseGithubSettings, { clientId: null });
}

export async function saveGithubSettings(settingsFilePath: string, settings: GithubSettings, storageCrypto?: StorageCrypto): Promise<void> {
  await saveEncryptedJson(settingsFilePath, settings, storageCrypto);
}

/**
 * Resolves the GitHub OAuth Client ID actually used at runtime, in the same
 * order googleSettings.ts's resolveGoogleCredentials() already uses:
 * env var > saved Settings > the embedded build-time default. No client
 * secret tier exists here — Device Flow doesn't use one.
 */
export async function resolveGithubClientId(
  settingsFilePath: string,
  storageCrypto?: StorageCrypto,
  embeddedClientId: string | null = EMBEDDED_GITHUB_CLIENT_ID
): Promise<string> {
  if (process.env.GITHUB_OAUTH_CLIENT_ID) {
    return process.env.GITHUB_OAUTH_CLIENT_ID;
  }
  const settings = await loadGithubSettings(settingsFilePath, storageCrypto);
  if (settings.clientId) {
    return settings.clientId;
  }
  return embeddedClientId ?? "";
}
