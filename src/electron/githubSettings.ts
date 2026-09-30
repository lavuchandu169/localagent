// src/electron/githubSettings.ts
import fs from "node:fs/promises";
import type { StorageCrypto } from "./googleAuth.js";
import { EMBEDDED_GITHUB_CLIENT_ID } from "./embeddedCredentials.js";

export interface GithubSettings {
  clientId: string | null;
}

export async function loadGithubSettings(settingsFilePath: string, storageCrypto?: StorageCrypto): Promise<GithubSettings> {
  try {
    const raw = await fs.readFile(settingsFilePath, "utf-8");
    const json = storageCrypto ? storageCrypto.decrypt(raw) : raw;
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object") return { clientId: null };
    const s = parsed as Partial<GithubSettings>;
    return { clientId: typeof s.clientId === "string" ? s.clientId : null };
  } catch {
    return { clientId: null };
  }
}

export async function saveGithubSettings(settingsFilePath: string, settings: GithubSettings, storageCrypto?: StorageCrypto): Promise<void> {
  const json = JSON.stringify(settings, null, 2);
  const toWrite = storageCrypto ? storageCrypto.encrypt(json) : json;
  await fs.writeFile(settingsFilePath, toWrite, { encoding: "utf-8", mode: 0o600 });
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
