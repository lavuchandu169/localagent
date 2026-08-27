import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  generatePkcePair,
  buildGoogleAuthUrl,
  generateState,
  mapTokenResponse,
  mapUserInfo,
  loadStoredIdentity,
  saveStoredIdentity,
  clearStoredIdentity,
} from "../electron/googleAuth.js";

type StoredIdentityForTest = { email: string; name: string; pictureUrl: string | null; refreshToken: string | null };

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("PKCE generation:");

const pair1 = generatePkcePair();
check("codeVerifier is a non-empty string", typeof pair1.codeVerifier === "string" && pair1.codeVerifier.length > 0);
check("codeChallenge is a non-empty string", typeof pair1.codeChallenge === "string" && pair1.codeChallenge.length > 0);
check("codeVerifier and codeChallenge differ", pair1.codeVerifier !== pair1.codeChallenge);
check("codeVerifier has no base64url padding or unsafe chars", /^[A-Za-z0-9_-]+$/.test(pair1.codeVerifier));
check("codeChallenge has no base64url padding or unsafe chars", /^[A-Za-z0-9_-]+$/.test(pair1.codeChallenge));

const pair2 = generatePkcePair();
check("two calls produce different verifiers", pair1.codeVerifier !== pair2.codeVerifier);

console.log("\nstate generation:");
const state1 = generateState();
const state2 = generateState();
check("state is a non-empty string", typeof state1 === "string" && state1.length > 0);
check("two calls produce different state values", state1 !== state2);

console.log("\nGoogle authorization URL:");

const url = buildGoogleAuthUrl({
  clientId: "test-client-id.apps.googleusercontent.com",
  redirectUri: "http://127.0.0.1:54321/callback",
  codeChallenge: "abc123challenge",
  state: "xyz789state",
});
const parsed = new URL(url);

check("uses Google's OAuth 2.0 authorization endpoint", parsed.origin + parsed.pathname === "https://accounts.google.com/o/oauth2/v2/auth");
check("client_id is passed through", parsed.searchParams.get("client_id") === "test-client-id.apps.googleusercontent.com");
check("redirect_uri is passed through", parsed.searchParams.get("redirect_uri") === "http://127.0.0.1:54321/callback");
check("code_challenge is passed through", parsed.searchParams.get("code_challenge") === "abc123challenge");
check("code_challenge_method is S256", parsed.searchParams.get("code_challenge_method") === "S256");
check("state is passed through", parsed.searchParams.get("state") === "xyz789state");
check("response_type is code", parsed.searchParams.get("response_type") === "code");
check("scope requests openid, email, and profile", parsed.searchParams.get("scope") === "openid email profile");
check("access_type is offline (needed to get a refresh token)", parsed.searchParams.get("access_type") === "offline");
check("prompt is consent (forces refresh token on repeat sign-ins)", parsed.searchParams.get("prompt") === "consent");

console.log("\nToken response mapping:");

const tokenMapped = mapTokenResponse(
  { access_token: "at-123", refresh_token: "rt-456", expires_in: 3600, token_type: "Bearer" },
  1000000
);
check("accessToken is carried through", tokenMapped.accessToken === "at-123");
check("refreshToken is carried through", tokenMapped.refreshToken === "rt-456");
check("expiresAt is now + expires_in (ms)", tokenMapped.expiresAt === 1000000 + 3600 * 1000);

const tokenMappedNoRefresh = mapTokenResponse({ access_token: "at-789", expires_in: 60, token_type: "Bearer" }, 0);
check("missing refresh_token maps to null, not undefined", tokenMappedNoRefresh.refreshToken === null);

console.log("\nUserinfo mapping:");

const identity = mapUserInfo({ email: "a@example.com", name: "Ada", picture: "https://example.com/a.png" }, "rt-456");
check("email is carried through", identity.email === "a@example.com");
check("name is carried through", identity.name === "Ada");
check("pictureUrl is carried through", identity.pictureUrl === "https://example.com/a.png");
check("refreshToken param is carried through", identity.refreshToken === "rt-456");

const identityNoPicture = mapUserInfo({ email: "b@example.com", name: "Bea" }, null);
check("missing picture maps to null, not undefined", identityNoPicture.pictureUrl === null);
check("null refreshToken is carried through as null", identityNoPicture.refreshToken === null);

console.log("\nIdentity storage (explicit path):");

async function runStorageTests() {
  const tmpFile = path.join(os.tmpdir(), `localagent-auth-test-${process.pid}-${Date.now()}.json`);

  const loadedMissing = await loadStoredIdentity(tmpFile);
  check("loading a nonexistent file returns null", loadedMissing === null);

  const identity: StoredIdentityForTest = { email: "c@example.com", name: "Cy", pictureUrl: null, refreshToken: "rt-1" };
  await saveStoredIdentity(tmpFile, identity);
  const loaded = await loadStoredIdentity(tmpFile);
  check("saved identity round-trips through load", JSON.stringify(loaded) === JSON.stringify(identity));

  await clearStoredIdentity(tmpFile);
  const loadedAfterClear = await loadStoredIdentity(tmpFile);
  check("loading after clear returns null", loadedAfterClear === null);

  await clearStoredIdentity(tmpFile);
  check("clearing a nonexistent file does not throw", true);

  await fs.rm(tmpFile, { force: true });
}

await runStorageTests();

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
