// src/electron/githubAuth.ts
import fs from "node:fs/promises";
import type { StorageCrypto } from "./googleAuth.js";

export interface StoredGithubIdentity {
  login: string;
  accessToken: string;
}

export async function loadStoredGithubIdentity(authFilePath: string, storageCrypto?: StorageCrypto): Promise<StoredGithubIdentity | null> {
  try {
    const raw = await fs.readFile(authFilePath, "utf-8");
    const json = storageCrypto ? storageCrypto.decrypt(raw) : raw;
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const id = parsed as Partial<StoredGithubIdentity>;
    if (typeof id.login !== "string" || typeof id.accessToken !== "string") return null;
    return { login: id.login, accessToken: id.accessToken };
  } catch {
    return null;
  }
}

export async function saveStoredGithubIdentity(authFilePath: string, identity: StoredGithubIdentity, storageCrypto?: StorageCrypto): Promise<void> {
  const json = JSON.stringify(identity, null, 2);
  const toWrite = storageCrypto ? storageCrypto.encrypt(json) : json;
  await fs.writeFile(authFilePath, toWrite, { encoding: "utf-8", mode: 0o600 });
}

/**
 * Security audit finding (confirmed, medium): oauth-signout-no-remote-
 * token-revocation. Unlike Google's signOut (googleAuth.ts), this is
 * local-only, deliberately: GitHub's token-revocation API
 * (DELETE /applications/{client_id}/{grant|token}) requires Basic Auth
 * with client_id:client_secret, and this app's GitHub connection is a
 * public Device Flow client with no client_secret anywhere in its auth
 * model (see connectGithub/requestDeviceCode below) — there is no
 * credential this app could send to that endpoint. "Disconnect" removes
 * this app's own ability to use the stored token; the token itself stays
 * valid at GitHub until the user revokes it from
 * github.com/settings/applications or it naturally expires.
 */
export async function clearStoredGithubIdentity(authFilePath: string): Promise<void> {
  await fs.rm(authFilePath, { force: true });
}

/** Re-reads the identity file on every call rather than caching — the only
 * way a disconnect mid-session is guaranteed to be seen by the very next
 * tool call that needs a token, with no stale-token window. */
export async function getGithubAccessToken(authFilePath: string, storageCrypto?: StorageCrypto): Promise<string | null> {
  const identity = await loadStoredGithubIdentity(authFilePath, storageCrypto);
  return identity?.accessToken ?? null;
}

const DEVICE_CODE_ENDPOINT = "https://github.com/login/device/code";
const ACCESS_TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const USER_ENDPOINT = "https://api.github.com/user";

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

interface RawDeviceCodeResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

export async function requestDeviceCode(clientId: string): Promise<DeviceCodeResponse> {
  const response = await fetch(DEVICE_CODE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: clientId, scope: "repo" }),
  });
  const raw = (await response.json().catch(() => ({}))) as RawDeviceCodeResponse;
  // GitHub can respond with an error at HTTP 200 as well as a non-2xx
  // status — validate the fields this module actually needs are present
  // either way, rather than silently producing undefined userCode/
  // verificationUri (which would render as "Enter code undefined at
  // undefined" in the Settings panel) and a NaN maxAttempts downstream.
  if (
    !response.ok ||
    typeof raw.device_code !== "string" ||
    typeof raw.user_code !== "string" ||
    typeof raw.verification_uri !== "string" ||
    typeof raw.expires_in !== "number" ||
    typeof raw.interval !== "number"
  ) {
    const detail = raw.error_description ?? raw.error ?? `HTTP ${response.status} ${response.statusText}`;
    throw new Error(`GitHub device-code request failed: ${detail}`);
  }
  return {
    deviceCode: raw.device_code,
    userCode: raw.user_code,
    verificationUri: raw.verification_uri,
    expiresInSeconds: raw.expires_in,
    intervalSeconds: raw.interval,
  };
}

export type PollResult = { kind: "ok"; accessToken: string } | { kind: "expired" } | { kind: "denied" } | { kind: "error"; message: string };

interface RawTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

/** Polls GitHub's token endpoint until it returns a token, a terminal
 * failure, or maxAttempts is reached — the maxAttempts ceiling exists so a
 * caller can never poll forever even if GitHub's response never actually
 * reaches a terminal state (Review Focus: the loop must actually stop).
 * `sleep` is injectable so tests can record the exact delay requested
 * without a real wait — defaults to a real setTimeout-based wait. */
export async function pollForAccessToken(
  clientId: string,
  deviceCode: string,
  intervalSeconds: number,
  maxAttempts: number = 180,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<PollResult> {
  let interval = intervalSeconds;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(ACCESS_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const raw = (await response.json().catch(() => ({}))) as RawTokenResponse;
    if (raw.access_token) return { kind: "ok", accessToken: raw.access_token };
    if (raw.error === "expired_token") return { kind: "expired" };
    if (raw.error === "access_denied") return { kind: "denied" };
    if (raw.error === "slow_down") {
      // GitHub's docs: "5 extra seconds are added to the minimum interval...
      // The error response includes the new interval that you must use."
      interval = typeof raw.interval === "number" ? raw.interval : interval + 5;
    } else if (raw.error && raw.error !== "authorization_pending") {
      // Any other error (device_flow_disabled, incorrect_client_credentials,
      // incorrect_device_code, unsupported_grant_type, ...) is terminal —
      // treating it as "still pending" would make the user wait out the
      // full expiry and then see a misleading "device code expired"
      // message that has nothing to do with the real problem.
      return { kind: "error", message: raw.error_description ?? raw.error };
    }
    if (interval > 0) await sleep(interval * 1000);
  }
  return { kind: "expired" };
}

interface RawUserResponse {
  login: string;
}

async function fetchGithubUser(accessToken: string): Promise<RawUserResponse> {
  const response = await fetch(USER_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`GitHub user request failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
  return (await response.json()) as RawUserResponse;
}

export type ConnectResult = { login: string } | { error: string };

/** Runs the full Device Flow: request a code, hand it to onDeviceCode (so
 * the caller can show it before this function resolves), poll until a
 * terminal outcome, then persist the resulting identity. */
export async function connectGithub(
  clientId: string,
  authFilePath: string,
  storageCrypto?: StorageCrypto,
  onDeviceCode?: (code: DeviceCodeResponse) => void
): Promise<ConnectResult> {
  if (!clientId) {
    return { error: "GITHUB_OAUTH_CLIENT_ID is not set — add it in Settings, or wait for an official release build." };
  }
  try {
    const deviceCode = await requestDeviceCode(clientId);
    onDeviceCode?.(deviceCode);
    const maxAttempts = Math.ceil(deviceCode.expiresInSeconds / Math.max(deviceCode.intervalSeconds, 1));
    const poll = await pollForAccessToken(clientId, deviceCode.deviceCode, deviceCode.intervalSeconds, maxAttempts);
    if (poll.kind === "expired") return { error: "The device code expired before authorization completed. Try connecting again." };
    if (poll.kind === "denied") return { error: "GitHub authorization was denied." };
    if (poll.kind === "error") return { error: poll.message };
    const user = await fetchGithubUser(poll.accessToken);
    await saveStoredGithubIdentity(authFilePath, { login: user.login, accessToken: poll.accessToken }, storageCrypto);
    return { login: user.login };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
