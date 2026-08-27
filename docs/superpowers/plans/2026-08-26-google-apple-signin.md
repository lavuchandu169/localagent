# Google/Apple Sign-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add identity-only Google sign-in/sign-out to the Electron app (system browser + PKCE + loopback redirect), with Apple sign-in rendered as a visibly disabled stub.

**Architecture:** A new main-process-only module, `src/electron/googleAuth.ts`, owns PKCE generation, the OAuth authorization URL, a one-shot loopback HTTP server to catch the redirect, the token/userinfo HTTPS exchange, and explicit-path JSON storage of the resulting identity under `app.getPath('userData')/auth.json`. `main.ts` wires three new `ipcMain.handle` calls (`agent:google-sign-in`, `agent:sign-out`, `agent:auth-status`) that call into this module; `preload.cjs` bridges them; `renderer.ts` adds a small auth control in the header. Google's real network/browser/loopback path is not unit-testable — the plan isolates every pure function (PKCE math, URL building, response mapping) so those get real unit tests, and the plan says clearly which parts only get manual verification.

**Tech Stack:** Node built-ins only — `node:crypto` (PKCE), `node:http` (loopback server), global `fetch` (token + userinfo calls), `node:fs/promises` (JSON storage). Zero new npm dependencies. Electron's `shell.openExternal` to launch the system browser.

**Spec:** `docs/superpowers/specs/2026-08-26-google-apple-signin-design.md`

## Global Constraints

- Zero new npm dependencies — `node:crypto`, `node:http`, `node:fs/promises`, global `fetch` only.
- Tokens (access token, refresh token) never cross the IPC boundary to the renderer — only `{ email, name, pictureUrl }` does. This matches the existing boundary rule (renderer never gets raw `fs`, raw session state, etc.).
- Storage file: `app.getPath('userData')/auth.json`, written/read only from the main process.
- If `GOOGLE_OAUTH_CLIENT_ID` is unset, `agent:google-sign-in` must return a clear inline error (`{ error: "..." }`), not throw or silently no-op — same pattern as a missing `ANTHROPIC_API_KEY` for the Claude provider.
- Apple sign-in is a disabled UI stub only in this pass — no Apple OAuth code.
- Nothing in the app is gated by sign-in state in this pass (identity only).
- New CSS must reuse the existing design tokens in `src/electron/renderer/styles.css` (`--ink`, `--ink-dim`, `--accent-strong`, `--surface`, `--surface-2`, `--line`, `--font-sans`, `--font-mono`) — no new colors invented.

---

### Task 1: PKCE generation and Google authorization URL

**Files:**
- Create: `src/electron/googleAuth.ts`
- Test: `src/test/googleAuth.test.ts`

**Interfaces:**
- Produces:
  - `interface PkcePair { codeVerifier: string; codeChallenge: string; }`
  - `function generatePkcePair(): PkcePair`
  - `interface GoogleAuthUrlParams { clientId: string; redirectUri: string; codeChallenge: string; state: string; }`
  - `function buildGoogleAuthUrl(params: GoogleAuthUrlParams): string`
  - `function generateState(): string`

- [ ] **Step 1: Write the failing tests**

Create `src/test/googleAuth.test.ts`:

```typescript
import { generatePkcePair, buildGoogleAuthUrl, generateState } from "../electron/googleAuth.js";

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

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc -p tsconfig.json && node dist/test/googleAuth.test.js`
Expected: FAIL (module `../electron/googleAuth.js` does not exist / compile error)

- [ ] **Step 3: Write minimal implementation**

Create `src/electron/googleAuth.ts`:

```typescript
import crypto from "node:crypto";

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc -p tsconfig.json && node dist/test/googleAuth.test.js`
Expected: PASS, all `check` lines print `ok`

- [ ] **Step 5: Commit**

```bash
git add src/electron/googleAuth.ts src/test/googleAuth.test.ts
git commit -m "feat: add PKCE generation and Google auth URL builder"
```

---

### Task 2: Token and userinfo response mapping

**Files:**
- Modify: `src/electron/googleAuth.ts`
- Modify: `src/test/googleAuth.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1's exports directly (independent pure functions), but lives in the same file.
- Produces:
  - `interface GoogleTokenResponse { access_token: string; refresh_token?: string; expires_in: number; token_type: string; id_token?: string; }`
  - `interface StoredTokens { accessToken: string; refreshToken: string | null; expiresAt: number; }`
  - `function mapTokenResponse(raw: GoogleTokenResponse, now?: number): StoredTokens`
  - `interface GoogleUserInfoResponse { email: string; name: string; picture?: string; }`
  - `interface StoredIdentity { email: string; name: string; pictureUrl: string | null; refreshToken: string | null; }`
  - `function mapUserInfo(raw: GoogleUserInfoResponse, refreshToken: string | null): StoredIdentity`

- [ ] **Step 1: Write the failing tests**

Append to `src/test/googleAuth.test.ts` (add this import to the existing import line, then append the new `console.log`/`check` block at the end, before the final summary lines):

```typescript
import {
  generatePkcePair,
  buildGoogleAuthUrl,
  generateState,
  mapTokenResponse,
  mapUserInfo,
} from "../electron/googleAuth.js";
```

Append before the final `console.log(failures === 0 ...)` / `process.exit(...)` lines:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc -p tsconfig.json && node dist/test/googleAuth.test.js`
Expected: FAIL (`mapTokenResponse`/`mapUserInfo` not exported)

- [ ] **Step 3: Write minimal implementation**

Append to `src/electron/googleAuth.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc -p tsconfig.json && node dist/test/googleAuth.test.js`
Expected: PASS, all `check` lines print `ok`

- [ ] **Step 5: Commit**

```bash
git add src/electron/googleAuth.ts src/test/googleAuth.test.ts
git commit -m "feat: map Google token and userinfo responses to stored shapes"
```

---

### Task 3: Explicit-path identity storage

**Files:**
- Modify: `src/electron/googleAuth.ts`
- Modify: `src/test/googleAuth.test.ts`

**Interfaces:**
- Consumes: `StoredIdentity` (Task 2)
- Produces:
  - `function loadStoredIdentity(authFilePath: string): Promise<StoredIdentity | null>`
  - `function saveStoredIdentity(authFilePath: string, identity: StoredIdentity): Promise<void>`
  - `function clearStoredIdentity(authFilePath: string): Promise<void>`

These take the file path as a parameter (not `app.getPath('userData')` internally) so they're unit-testable against a real temp file without a running Electron instance — the same explicit-path pattern the rest of this codebase already uses (e.g. `checkCachedModels` in `src/electron/modelCache.ts` takes no Electron-derived path but the same principle applies: keep Electron-only APIs out of testable logic).

- [ ] **Step 1: Write the failing tests**

Add this import to the top of `src/test/googleAuth.test.ts`:

```typescript
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
```

Add `loadStoredIdentity, saveStoredIdentity, clearStoredIdentity` to the existing `from "../electron/googleAuth.js"` import.

Append before the final summary lines (note: storage tests are `async`, so wrap them and everything after in an async IIFE — see Step 1 note below):

```typescript
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
```

Since this file now has a top-level `await`, and the existing final lines are synchronous, restructure the very end of the file (the summary print + `process.exit`) to run after `runStorageTests()` resolves — the simplest way is to keep the file's existing top-level statements as-is (they already ran and populated `failures` before this new block), and make sure the final two lines:

```typescript
console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
```

are the very last lines in the file, after the `await runStorageTests();` call. Also add this minimal local type alias near the top of the test file (below the imports), since the test only needs the shape, not the exported type re-declared:

```typescript
type StoredIdentityForTest = { email: string; name: string; pictureUrl: string | null; refreshToken: string | null };
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc -p tsconfig.json && node dist/test/googleAuth.test.js`
Expected: FAIL (`loadStoredIdentity`/`saveStoredIdentity`/`clearStoredIdentity` not exported)

- [ ] **Step 3: Write minimal implementation**

Append to `src/electron/googleAuth.ts` (add `import fs from "node:fs/promises";` to the top of the file alongside the existing `import crypto from "node:crypto";`):

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc -p tsconfig.json && node dist/test/googleAuth.test.js`
Expected: PASS, all `check` lines print `ok`

- [ ] **Step 5: Commit**

```bash
git add src/electron/googleAuth.ts src/test/googleAuth.test.ts
git commit -m "feat: add explicit-path identity storage (load/save/clear)"
```

---

### Task 4: Loopback server, sign-in/refresh/status orchestration

**Files:**
- Modify: `src/electron/googleAuth.ts`

**Interfaces:**
- Consumes: `generatePkcePair`, `generateState`, `buildGoogleAuthUrl` (Task 1); `mapTokenResponse`, `mapUserInfo`, `GoogleTokenResponse`, `GoogleUserInfoResponse`, `StoredTokens`, `StoredIdentity` (Task 2); `loadStoredIdentity`, `saveStoredIdentity`, `clearStoredIdentity` (Task 3)
- Produces:
  - `type SignInResult = { email: string; name: string; pictureUrl: string | null } | { error: string }`
  - `function signInWithGoogle(clientId: string, authFilePath: string): Promise<SignInResult>`
  - `function refreshAccessToken(clientId: string, refreshToken: string): Promise<StoredTokens | null>`
  - `type AuthStatus = { signedIn: false } | { signedIn: true; email: string; name: string; pictureUrl: string | null }`
  - `function getAuthStatus(authFilePath: string, clientId: string | undefined): Promise<AuthStatus>`
  - `function signOut(authFilePath: string): Promise<void>`

This orchestration layer (loopback HTTP server, real `shell.openExternal` call, real `fetch` calls to Google) is not unit-tested per the spec's Testing section — it's exercised manually once a real `GOOGLE_OAUTH_CLIENT_ID` exists, the same documented gap as the embedded model's real load path. No test file changes in this task.

- [ ] **Step 1: Write the implementation**

Add these imports to the top of `src/electron/googleAuth.ts` (alongside the existing `crypto` and `fs` imports):

```typescript
import http from "node:http";
import { shell } from "electron";
```

Append to `src/electron/googleAuth.ts`:

```typescript
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";

async function exchangeCodeForTokens(clientId: string, code: string, codeVerifier: string, redirectUri: string): Promise<StoredTokens> {
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) {
    throw new Error(`Google token exchange failed: ${response.status} ${await response.text()}`);
  }
  const raw = (await response.json()) as GoogleTokenResponse;
  return mapTokenResponse(raw);
}

async function fetchUserInfo(accessToken: string): Promise<GoogleUserInfoResponse> {
  const response = await fetch(GOOGLE_USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Google userinfo request failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as GoogleUserInfoResponse;
}

export type SignInResult = { email: string; name: string; pictureUrl: string | null } | { error: string };

export async function signInWithGoogle(clientId: string, authFilePath: string): Promise<SignInResult> {
  if (!clientId) {
    return { error: "GOOGLE_OAUTH_CLIENT_ID is not set — see README for how to create one." };
  }

  try {
    const { codeVerifier, codeChallenge } = generatePkcePair();
    const state = generateState();

    // Bind first so the real assigned port is known before building the
    // auth URL and opening the browser.
    const server = http.createServer();
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

    const authUrl = buildGoogleAuthUrl({ clientId, redirectUri, codeChallenge, state });
    await shell.openExternal(authUrl);

    const { code } = await redirectPromise;
    const tokens = await exchangeCodeForTokens(clientId, code, codeVerifier, redirectUri);
    const userInfo = await fetchUserInfo(tokens.accessToken);
    const identity = mapUserInfo(userInfo, tokens.refreshToken);

    await saveStoredIdentity(authFilePath, identity);
    return { email: identity.email, name: identity.name, pictureUrl: identity.pictureUrl };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function refreshAccessToken(clientId: string, refreshToken: string): Promise<StoredTokens | null> {
  try {
    const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!response.ok) return null;
    const raw = (await response.json()) as GoogleTokenResponse;
    return mapTokenResponse(raw);
  } catch {
    return null;
  }
}

export type AuthStatus = { signedIn: false } | { signedIn: true; email: string; name: string; pictureUrl: string | null };

export async function getAuthStatus(authFilePath: string, clientId: string | undefined): Promise<AuthStatus> {
  const identity = await loadStoredIdentity(authFilePath);
  if (!identity) return { signedIn: false };

  // Opportunistic re-establishment: if we can still refresh, keep the
  // session; if the refresh token is gone or revoked, drop the stale file
  // silently and fall back to signed-out — no scheduled refresh, per spec.
  if (identity.refreshToken && clientId) {
    const refreshed = await refreshAccessToken(clientId, identity.refreshToken);
    if (!refreshed) {
      await clearStoredIdentity(authFilePath);
      return { signedIn: false };
    }
  }

  return { signedIn: true, email: identity.email, name: identity.name, pictureUrl: identity.pictureUrl };
}

export async function signOut(authFilePath: string): Promise<void> {
  await clearStoredIdentity(authFilePath);
}
```

The redirect-catching logic lives inline in `signInWithGoogle` above (not as a separate helper) so the server is already bound to its real OS-assigned port — and that port is known — before the auth URL is built and the browser opens.

- [ ] **Step 2: Compile to verify no type errors**

Run: `npx tsc -p tsconfig.json`
Expected: compiles cleanly, no errors. (No automated test for this task — see rationale above.)

- [ ] **Step 3: Commit**

```bash
git add src/electron/googleAuth.ts
git commit -m "feat: add Google sign-in orchestration (loopback server, token exchange, status)"
```

---

### Task 5: IPC wiring in main.ts and preload.cjs

**Files:**
- Modify: `src/electron/main.ts:1-9` (imports), `src/electron/main.ts` inside `app.whenReady().then(...)` (new handlers)
- Modify: `src/electron/preload.cjs`

**Interfaces:**
- Consumes: `signInWithGoogle`, `signOut`, `getAuthStatus` (Task 4), all from `./googleAuth.js`
- Produces: IPC channels `agent:google-sign-in`, `agent:sign-out`, `agent:auth-status`, and their `preload.cjs` bridge methods `googleSignIn()`, `signOut()`, `getAuthStatus()` — consumed by Task 6.

- [ ] **Step 1: Modify `src/electron/main.ts` imports**

The current top of the file reads:

```typescript
import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionRegistry, startSession, runTask, respondPermission, cancelSession } from "./sessionRegistry.js";
import type { SessionConfig } from "./sessionRegistry.js";
import { checkCachedModels } from "./modelCache.js";
import { detectHardware, recommendModelSize } from "./hardwareInfo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const registry = createSessionRegistry();
```

Change it to:

```typescript
import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionRegistry, startSession, runTask, respondPermission, cancelSession } from "./sessionRegistry.js";
import type { SessionConfig } from "./sessionRegistry.js";
import { checkCachedModels } from "./modelCache.js";
import { detectHardware, recommendModelSize } from "./hardwareInfo.js";
import { signInWithGoogle, signOut, getAuthStatus } from "./googleAuth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const registry = createSessionRegistry();
const authFilePath = path.join(app.getPath("userData"), "auth.json");
```

- [ ] **Step 2: Add the three IPC handlers**

Inside `app.whenReady().then(() => { ... })`, the current body ends with:

```typescript
  ipcMain.handle("agent:pick-workspace", async () => { const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] }); if (result.canceled) return null; return result.filePaths[0] ?? null; });
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
```

Insert the three new handlers directly before `app.on("activate", ...)`:

```typescript
  ipcMain.handle("agent:pick-workspace", async () => { const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] }); if (result.canceled) return null; return result.filePaths[0] ?? null; });
  ipcMain.handle("agent:google-sign-in", () => signInWithGoogle(process.env.GOOGLE_OAUTH_CLIENT_ID ?? "", authFilePath));
  ipcMain.handle("agent:sign-out", () => signOut(authFilePath));
  ipcMain.handle("agent:auth-status", () => getAuthStatus(authFilePath, process.env.GOOGLE_OAUTH_CLIENT_ID));
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
```

- [ ] **Step 3: Add bridge methods to `src/electron/preload.cjs`**

The current file ends with:

```javascript
  onDownloadProgress: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("agent:model-progress", listener);
    return () => ipcRenderer.removeListener("agent:model-progress", listener);
  },
});
```

Change it to:

```javascript
  onDownloadProgress: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("agent:model-progress", listener);
    return () => ipcRenderer.removeListener("agent:model-progress", listener);
  },
  googleSignIn: () => ipcRenderer.invoke("agent:google-sign-in"),
  signOut: () => ipcRenderer.invoke("agent:sign-out"),
  getAuthStatus: () => ipcRenderer.invoke("agent:auth-status"),
});
```

- [ ] **Step 4: Compile to verify no type errors**

Run: `npx tsc -p tsconfig.json`
Expected: compiles cleanly, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/electron/main.ts src/electron/preload.cjs
git commit -m "feat: wire Google sign-in/sign-out/status over IPC"
```

---

### Task 6: Renderer UI — header auth control

**Files:**
- Modify: `src/electron/renderer/index.html`
- Modify: `src/electron/renderer/styles.css`
- Modify: `src/electron/renderer/renderer.ts`

**Interfaces:**
- Consumes: `window.agent.googleSignIn()`, `window.agent.signOut()`, `window.agent.getAuthStatus()` (Task 5); existing `byId` helper and `AgentBridge` interface pattern already in `renderer.ts`.
- Produces: no new exports (leaf UI task).

- [ ] **Step 1: Add markup to `src/electron/renderer/index.html`**

The current header reads:

```html
    <header id="app-header">
      <div id="brand">
        <svg id="brand-mark" viewBox="0 0 100 100" aria-hidden="true">
          <rect x="2" y="2" width="96" height="96" rx="22" fill="#F5F3EC" stroke="#E4E0D3" stroke-width="2" />
          <rect x="24" y="24" width="52" height="52" rx="12" fill="none" stroke="#C15F3C" stroke-width="3" opacity="0.55" />
          <circle cx="50" cy="50" r="11" fill="#C15F3C" />
        </svg>
        <span id="brand-name">localagent</span>
      </div>
      <button id="about-toggle" aria-expanded="false" title="About">?</button>
    </header>
```

Change it to:

```html
    <header id="app-header">
      <div id="brand">
        <svg id="brand-mark" viewBox="0 0 100 100" aria-hidden="true">
          <rect x="2" y="2" width="96" height="96" rx="22" fill="#F5F3EC" stroke="#E4E0D3" stroke-width="2" />
          <rect x="24" y="24" width="52" height="52" rx="12" fill="none" stroke="#C15F3C" stroke-width="3" opacity="0.55" />
          <circle cx="50" cy="50" r="11" fill="#C15F3C" />
        </svg>
        <span id="brand-name">localagent</span>
      </div>
      <div id="header-right">
        <div id="auth-control">
          <div id="auth-signed-out" class="row">
            <button id="google-sign-in">Sign in with Google</button>
            <button id="apple-sign-in" disabled title="Coming soon — needs an Apple Developer account and a registered domain">Sign in with Apple</button>
          </div>
          <div id="auth-signed-in" class="row" hidden>
            <span id="auth-avatar"></span>
            <span id="auth-name"></span>
            <button id="sign-out-btn">Sign out</button>
          </div>
          <div id="auth-error" class="error-text"></div>
        </div>
        <button id="about-toggle" aria-expanded="false" title="About">?</button>
      </div>
    </header>
```

- [ ] **Step 2: Add styling to `src/electron/renderer/styles.css`**

The current `#about-panel` rule block starts at line 153 (`#about-panel { ... }`). Insert the new rules directly before that block (i.e., right after the existing `#about-toggle:hover { color: var(--ink); border-color: var(--ink-dim); }` rule and before `#about-panel {`):

```css
#header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

#auth-control .row {
  margin-bottom: 0;
  gap: 8px;
}

#auth-control button {
  font-size: 12px;
  padding: 5px 10px;
}

#auth-signed-in {
  font-size: 12px;
  color: var(--ink);
}

#auth-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--surface-2);
  border: 1px solid var(--line);
  background-size: cover;
  background-position: center;
  color: var(--ink-dim);
  font-family: var(--font-sans);
  font-size: 10px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

#auth-name {
  font-family: var(--font-sans);
  color: var(--ink);
}

#auth-error {
  max-width: 220px;
}

#auth-error:empty {
  display: none;
}
```

Also add, next to the existing `[hidden]` override comment block (near `#external-fields[hidden]`/`#anthropic-fields[hidden]`/`#download-progress[hidden]`), a matching override — `.row`'s `display: flex` is author-origin and beats the UA `[hidden]` rule the same way it does for those existing elements:

```css
#auth-signed-in[hidden] {
  display: none;
}
```

- [ ] **Step 3: Add renderer logic to `src/electron/renderer/renderer.ts`**

Update the `AgentBridge` interface (currently lines 18-28) to add the three new methods. Change:

```typescript
interface AgentBridge {
  startSession(config: SessionConfig): Promise<{ sessionId: string; workspaceRoot: string }>;
  runTask(sessionId: string, task: string): Promise<void>;
  respondPermission(sessionId: string, callId: string, approved: boolean): Promise<void>;
  cancelSession(sessionId: string): Promise<void>;
  pickWorkspace(): Promise<string | null>;
  onEvent(callback: (sessionId: string, event: AgentEvent) => void): () => void;
  onDownloadProgress(callback: (status: DownloadProgress) => void): () => void;
  listCachedModels(): Promise<Record<string, boolean>>;
  getHardwareInfo(): Promise<HardwareInfo>;
}
```

to:

```typescript
interface AuthIdentity {
  email: string;
  name: string;
  pictureUrl: string | null;
}
type SignInResult = AuthIdentity | { error: string };
type AuthStatus = { signedIn: false } | ({ signedIn: true } & AuthIdentity);

interface AgentBridge {
  startSession(config: SessionConfig): Promise<{ sessionId: string; workspaceRoot: string }>;
  runTask(sessionId: string, task: string): Promise<void>;
  respondPermission(sessionId: string, callId: string, approved: boolean): Promise<void>;
  cancelSession(sessionId: string): Promise<void>;
  pickWorkspace(): Promise<string | null>;
  onEvent(callback: (sessionId: string, event: AgentEvent) => void): () => void;
  onDownloadProgress(callback: (status: DownloadProgress) => void): () => void;
  listCachedModels(): Promise<Record<string, boolean>>;
  getHardwareInfo(): Promise<HardwareInfo>;
  googleSignIn(): Promise<SignInResult>;
  signOut(): Promise<void>;
  getAuthStatus(): Promise<AuthStatus>;
}
```

Add new element refs alongside the existing ones (after the `aboutHardware` ref, before `downloadProgressRow`):

```typescript
const googleSignInBtn = byId<HTMLButtonElement>("google-sign-in");
const signOutBtn = byId<HTMLButtonElement>("sign-out-btn");
const authSignedOut = byId<HTMLDivElement>("auth-signed-out");
const authSignedIn = byId<HTMLDivElement>("auth-signed-in");
const authAvatar = byId<HTMLSpanElement>("auth-avatar");
const authName = byId<HTMLSpanElement>("auth-name");
const authError = byId<HTMLDivElement>("auth-error");
```

Add this rendering + wiring block at the end of the file (after the existing `taskInput.addEventListener("keydown", ...)` block):

```typescript
function renderAuthState(status: AuthStatus): void {
  authError.textContent = "";
  if (status.signedIn) {
    authSignedOut.hidden = true;
    authSignedIn.hidden = false;
    authName.textContent = `${status.name} · `;
    if (status.pictureUrl) {
      authAvatar.style.backgroundImage = `url(${JSON.stringify(status.pictureUrl)})`;
      authAvatar.textContent = "";
    } else {
      authAvatar.style.backgroundImage = "";
      authAvatar.textContent = status.name.slice(0, 1).toUpperCase();
    }
  } else {
    authSignedOut.hidden = false;
    authSignedIn.hidden = true;
  }
}

googleSignInBtn.addEventListener("click", async () => {
  authError.textContent = "";
  googleSignInBtn.disabled = true;
  try {
    const result = await window.agent.googleSignIn();
    if ("error" in result) {
      authError.textContent = result.error;
    } else {
      renderAuthState({ signedIn: true, ...result });
    }
  } finally {
    googleSignInBtn.disabled = false;
  }
});

signOutBtn.addEventListener("click", async () => {
  await window.agent.signOut();
  renderAuthState({ signedIn: false });
});

window.agent.getAuthStatus().then(renderAuthState);
```

- [ ] **Step 4: Build and manually verify the UI renders**

Run: `npm run build`
Expected: compiles and copies assets with no errors.

Run: `env -u ELECTRON_RUN_AS_NODE npm run electron` (or `npm run electron` in a normal terminal)
Expected: app window opens; header shows "Sign in with Google" and a disabled "Sign in with Apple" button with the "Coming soon…" tooltip on hover; no console errors. (Clicking "Sign in with Google" without `GOOGLE_OAUTH_CLIENT_ID` set should show the inline error from Task 5/7 — verified together with Task 7.)

- [ ] **Step 5: Commit**

```bash
git add src/electron/renderer/index.html src/electron/renderer/styles.css src/electron/renderer/renderer.ts
git commit -m "feat: add Google/Apple sign-in header control to renderer UI"
```

---

### Task 7: Missing-client-ID guard, test script, and README docs

**Files:**
- Modify: `package.json:14` (`test` script)
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing new — this task wires Task 1-3's test file into the existing test chain and documents the already-implemented `GOOGLE_OAUTH_CLIENT_ID` guard from Task 5 Step 2.
- Produces: nothing consumed by later tasks (this is the last task).

- [ ] **Step 1: Add the new test to `package.json`**

Current `test` script:

```json
    "test": "node dist/test/agent.test.js && node dist/test/sessionRegistry.test.js && node dist/test/modeLabels.test.js && node dist/test/hardwareInfo.test.js && node dist/test/filenameCandidates.test.js && node dist/test/anthropicProvider.test.js",
```

Change to:

```json
    "test": "node dist/test/agent.test.js && node dist/test/sessionRegistry.test.js && node dist/test/modeLabels.test.js && node dist/test/hardwareInfo.test.js && node dist/test/filenameCandidates.test.js && node dist/test/anthropicProvider.test.js && node dist/test/googleAuth.test.js",
```

- [ ] **Step 2: Run the full test suite to verify it passes end-to-end**

Run: `npm run build && npm test`
Expected: all test files print `All tests passed.`, process exits 0.

- [ ] **Step 3: Document the Google OAuth Client ID prerequisite in `README.md`**

In the "Desktop app" section, the current content reads:

```markdown
### Desktop app

```bash
npm run build      # also copies src/electron's static assets into dist/electron/
npm run electron
```

Pick a workspace (e.g. `fixture-repo`), choose embedded or external
provider, pick a mode, type a task, hit Run — the event log renders tool
calls/results live, with inline Approve/Deny buttons for anything the
permission engine asks about.
```

Insert a new subsection directly after that paragraph (before the `> **If you're running this from inside a sandboxed agent CLI**` note):

```markdown
Optionally, sign in with a Google account from the header control — this is
identity only right now (nothing in the app is gated by it). It needs a
Google Cloud OAuth Client ID, which you create yourself:

1. https://console.cloud.google.com/ → create/select a project.
2. APIs & Services → OAuth consent screen → configure (External or
   Internal) with an app name and support email.
3. APIs & Services → Credentials → Create Credentials → OAuth client ID →
   Application type: **Desktop app**.
4. Copy the generated Client ID.
5. Set it as `GOOGLE_OAUTH_CLIENT_ID` in the environment the Electron app
   launches from — same pattern as `ANTHROPIC_API_KEY`, no UI field,
   nothing committed to the repo:
   ```bash
   GOOGLE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com npm run electron
   ```

Without `GOOGLE_OAUTH_CLIENT_ID` set, "Sign in with Google" shows an inline
error instead of opening a browser. "Sign in with Apple" is a disabled stub
for now — it needs a paid Apple Developer account and a registered web
domain, neither of which exists for this project yet (see
`docs/superpowers/specs/2026-08-26-google-apple-signin-design.md`).
```

- [ ] **Step 4: Add the new module to the "What's actually implemented" list in `README.md`**

The current Electron bullet point ends with:

```markdown
  One session at a time — multi-session, a diff viewer, and settings
  persistence are follow-on sub-projects, not built here.
```

Change that sentence to:

```markdown
  One session at a time — multi-session, a diff viewer, and settings
  persistence are follow-on sub-projects, not built here. `googleAuth.ts`
  adds optional Google sign-in (system browser + PKCE + a loopback
  redirect server, see
  `docs/superpowers/specs/2026-08-26-google-apple-signin-design.md`) —
  identity only, nothing is gated by it; Apple sign-in is a disabled UI
  stub pending an Apple Developer account and a registered domain.
```

- [ ] **Step 5: Commit**

```bash
git add package.json README.md
git commit -m "docs: document Google OAuth Client ID setup, wire googleAuth into test suite"
```
