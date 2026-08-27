import crypto from "node:crypto";
import fs from "node:fs/promises";

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
  url.searchParams.set("scope", "openid email profile");
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

export async function loadStoredIdentity(authFilePath: string): Promise<StoredIdentity | null> {
  try {
    const raw = await fs.readFile(authFilePath, "utf-8");
    return JSON.parse(raw) as StoredIdentity;
  } catch {
    return null;
  }
}

export async function saveStoredIdentity(authFilePath: string, identity: StoredIdentity): Promise<void> {
  await fs.writeFile(authFilePath, JSON.stringify(identity, null, 2), "utf-8");
}

export async function clearStoredIdentity(authFilePath: string): Promise<void> {
  await fs.rm(authFilePath, { force: true });
}
