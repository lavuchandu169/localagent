import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

/** RFC 7636 PKCE pair: a random verifier, and its SHA-256 (S256) challenge. */
export function generatePkcePair(): PkcePair {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

/** Opaque anti-CSRF value echoed back by Google on redirect and checked against what we sent. */
export function generateState(): string {
  return crypto.randomBytes(16).toString("base64url");
}

export interface GoogleAuthUrlParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}

export function buildGoogleAuthUrl(params: GoogleAuthUrlParams): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile https://www.googleapis.com/auth/drive.appdata");
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", params.state);
  // offline + consent: without both, Google only returns a refresh token on
  // the very first consent ever granted — later sign-ins would silently stop
  // renewing this app's session across restarts.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  id_token?: string;
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

export function mapTokenResponse(raw: GoogleTokenResponse, now: number = Date.now()): StoredTokens {
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? null,
    expiresAt: now + raw.expires_in * 1000,
  };
}

export interface GoogleUserInfoResponse {
  email: string;
  name: string;
  picture?: string;
}

export interface StoredIdentity {
  email: string;
  name: string;
  pictureUrl: string | null;
  refreshToken: string | null;
}

export function mapUserInfo(raw: GoogleUserInfoResponse, refreshToken: string | null): StoredIdentity {
  return {
    email: raw.email,
    name: raw.name,
    pictureUrl: raw.picture ?? null,
    refreshToken,
  };
}

/**
 * Encrypts/decrypts the on-disk identity file's contents to an opaque
 * string safe to write as a text file. Optional throughout this module —
 * omitting it stores plain JSON (protected only by the file's 0600
 * permissions), which is what keeps this file importable and testable
 * without Electron. The real implementation (`secureStorage.ts`, backed by
 * Electron's `safeStorage` — OS Keychain/DPAPI/libsecret) is supplied by
 * main.ts. An identity written with one storageCrypto (or none) and read
 * back with a different one (or none) simply fails to parse and is
 * treated as signed-out — no migration path, just a re-sign-in.
 */
export interface StorageCrypto {
  encrypt: (plainText: string) => string;
  decrypt: (cipherText: string) => string;
}

export async function loadStoredIdentity(authFilePath: string, storageCrypto?: StorageCrypto): Promise<StoredIdentity | null> {
  try {
    const raw = await fs.readFile(authFilePath, "utf-8");
    const json = storageCrypto ? storageCrypto.decrypt(raw) : raw;
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const id = parsed as Partial<StoredIdentity>;
    if (typeof id.email !== "string" || typeof id.name !== "string") return null;
    return { email: id.email, name: id.name, pictureUrl: id.pictureUrl ?? null, refreshToken: id.refreshToken ?? null };
  } catch {
    return null;
  }
}

export async function saveStoredIdentity(authFilePath: string, identity: StoredIdentity, storageCrypto?: StorageCrypto): Promise<void> {
  const json = JSON.stringify(identity, null, 2);
  const toWrite = storageCrypto ? storageCrypto.encrypt(json) : json;
  await fs.writeFile(authFilePath, toWrite, { encoding: "utf-8", mode: 0o600 });
}

export async function clearStoredIdentity(authFilePath: string): Promise<void> {
  await fs.rm(authFilePath, { force: true });
}

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";

/**
 * Google's OAuth consent screen setup lets a "Desktop app" client be created
 * either as a legacy type that still requires client_secret on every token
 * request, or a newer type that doesn't. There's no way to tell which one a
 * given Client ID is without trying — so client_secret is sent whenever the
 * caller has one (via GOOGLE_OAUTH_CLIENT_SECRET), and omitted otherwise.
 */
export function buildTokenRequestBody(params: Record<string, string>, clientSecret?: string): URLSearchParams {
  const body = new URLSearchParams(params);
  if (clientSecret) body.set("client_secret", clientSecret);
  return body;
}

async function exchangeCodeForTokens(
  clientId: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
  clientSecret?: string
): Promise<StoredTokens> {
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: buildTokenRequestBody(
      {
        client_id: clientId,
        code,
        code_verifier: codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      },
      clientSecret
    ),
  });
  if (!response.ok) {
    throw new Error(`Google token exchange failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
  const raw = (await response.json()) as GoogleTokenResponse;
  return mapTokenResponse(raw);
}

async function fetchUserInfo(accessToken: string): Promise<GoogleUserInfoResponse> {
  const response = await fetch(GOOGLE_USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Google userinfo request failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
  return (await response.json()) as GoogleUserInfoResponse;
}

export type SignInResult = { email: string; name: string; pictureUrl: string | null } | { error: string };

export async function signInWithGoogle(
  clientId: string,
  authFilePath: string,
  clientSecret?: string,
  storageCrypto?: StorageCrypto
): Promise<SignInResult> {
  if (!clientId) {
    return { error: "GOOGLE_OAUTH_CLIENT_ID is not set — add your Google OAuth credentials in Settings." };
  }

  const { codeVerifier, codeChallenge } = generatePkcePair();
  const state = generateState();
  const server = http.createServer();

  try {
    // Bind first so the real assigned port is known before building the
    // auth URL and opening the browser.
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", resolve);
      server.on("error", reject);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Loopback server failed to bind a port");
    }
    const redirectUri = `http://127.0.0.1:${address.port}/callback`;

    const redirectPromise = new Promise<{ code: string }>((resolve, reject) => {
      server.on("request", (req, res) => {
        const url = new URL(req.url ?? "/", redirectUri);
        if (url.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body>You can close this tab and return to localagent.</body></html>");
        server.close();

        if (error) reject(new Error(`Google returned an error: ${error}`));
        else if (returnedState !== state) reject(new Error("OAuth state mismatch — possible CSRF, aborting sign-in"));
        else if (!code) reject(new Error("Google redirect had no authorization code"));
        else resolve({ code });
      });
    });
    // Prevents an unhandled rejection if this promise is abandoned (e.g.
    // shell.openExternal throws below) before anything else awaits it.
    redirectPromise.catch(() => {});

    const authUrl = buildGoogleAuthUrl({ clientId, redirectUri, codeChallenge, state });
    const { shell } = await import("electron");
    await shell.openExternal(authUrl);

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Sign-in timed out — no response from Google within 5 minutes")), 5 * 60 * 1000);
    });
    const { code } = await Promise.race([redirectPromise, timeoutPromise]);

    const tokens = await exchangeCodeForTokens(clientId, code, codeVerifier, redirectUri, clientSecret);
    const userInfo = await fetchUserInfo(tokens.accessToken);
    const identity = mapUserInfo(userInfo, tokens.refreshToken);

    await saveStoredIdentity(authFilePath, identity, storageCrypto);
    return { email: identity.email, name: identity.name, pictureUrl: identity.pictureUrl };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    server.close();
  }
}

export type RefreshOutcome = "ok" | "revoked" | "transient";

/** Google's documented signal for a revoked/expired/invalid refresh token is 400/401; anything else failing is a transient problem (network, 5xx, etc.), not proof the token is dead. */
export function classifyRefreshResponse(status: number): RefreshOutcome {
  if (status >= 200 && status < 300) return "ok";
  if (status === 400 || status === 401) return "revoked";
  return "transient";
}

/** Resolves to fresh tokens on success, null only on confirmed revocation (caller should sign out), or throws on a transient failure (caller should keep the cached identity). */
export async function refreshAccessToken(clientId: string, refreshToken: string, clientSecret?: string): Promise<StoredTokens | null> {
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: buildTokenRequestBody(
      {
        client_id: clientId,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      },
      clientSecret
    ),
    signal: AbortSignal.timeout(10_000),
  });
  const outcome = classifyRefreshResponse(response.status);
  if (outcome === "ok") {
    const raw = (await response.json()) as GoogleTokenResponse;
    return mapTokenResponse(raw);
  }
  if (outcome === "revoked") {
    return null;
  }
  throw new Error(`Google token refresh failed transiently: ${response.status} ${(await response.text()).slice(0, 200)}`);
}

export type AuthStatus = { signedIn: false } | { signedIn: true; email: string; name: string; pictureUrl: string | null };

export async function getAuthStatus(
  authFilePath: string,
  clientId: string | undefined,
  clientSecret?: string,
  storageCrypto?: StorageCrypto
): Promise<AuthStatus> {
  const identity = await loadStoredIdentity(authFilePath, storageCrypto);
  if (!identity) return { signedIn: false };

  // Opportunistic re-establishment: if we can still refresh, keep the
  // session; if the refresh token is gone or revoked, drop the stale file
  // silently and fall back to signed-out — no scheduled refresh, per spec.
  if (identity.refreshToken && clientId) {
    try {
      const refreshed = await refreshAccessToken(clientId, identity.refreshToken, clientSecret);
      if (!refreshed) {
        await clearStoredIdentity(authFilePath);
        return { signedIn: false };
      }
    } catch {
      // Transient failure (offline, DNS, Google outage) — keep the cached
      // identity rather than signing the user out; don't touch the file.
    }
  }

  return { signedIn: true, email: identity.email, name: identity.name, pictureUrl: identity.pictureUrl };
}

/**
 * Cheap, no-network read of the currently stored account's email (or null
 * if signed out) — for local session-ownership stamping/filtering, where
 * a full refreshed AuthStatus would be unnecessary network overhead on
 * every save/list/search call.
 */
export async function getStoredEmail(authFilePath: string, storageCrypto?: StorageCrypto): Promise<string | null> {
  const identity = await loadStoredIdentity(authFilePath, storageCrypto);
  return identity?.email ?? null;
}

/**
 * Returns a fresh access token for API calls beyond identity (e.g. Drive
 * cloud sync), refreshing via the stored refresh token. Returns null if
 * there's no stored identity, no refresh token, or the refresh token has
 * been revoked — callers should treat any of these as "sync unavailable
 * right now" without forcing a sign-out themselves. Throws on a transient
 * failure (network, Google outage), exactly like refreshAccessToken does,
 * so callers can tell "give up for now" apart from "definitely signed out."
 */
export async function getFreshAccessToken(
  authFilePath: string,
  clientId: string,
  clientSecret?: string,
  storageCrypto?: StorageCrypto
): Promise<string | null> {
  const identity = await loadStoredIdentity(authFilePath, storageCrypto);
  if (!identity || !identity.refreshToken) return null;
  const refreshed = await refreshAccessToken(clientId, identity.refreshToken, clientSecret);
  if (!refreshed) return null;
  return refreshed.accessToken;
}

export async function signOut(authFilePath: string): Promise<void> {
  await clearStoredIdentity(authFilePath);
}
