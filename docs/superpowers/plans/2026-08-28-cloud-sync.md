# Google Drive session sync — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically back up session history to the signed-in user's Google Drive (hidden `appDataFolder`) and automatically restore/reconcile it on every successful sign-in, so sessions survive a reinstall or move to a new device.

**Architecture:** A new Electron-free `src/cloudSync.ts` talks to the Drive REST API with plain `fetch`, using the `appDataFolder` scope and `appProperties.sessionId` to map local session ids to Drive files without any new local mapping table. `sessionRegistry.ts`'s existing save/delete paths call into it (best-effort, via an injectable `CloudSyncConfig`); `main.ts` runs a full reconcile pass on every successful sign-in and wires a one-time scope-warning notification to the renderer.

**Tech Stack:** TypeScript, Node's built-in `fetch`/`Response`, Electron IPC (`ipcMain`/`contextBridge`). No new npm dependencies.

**Spec:** [docs/superpowers/specs/2026-08-28-cloud-sync-design.md](../specs/2026-08-28-cloud-sync-design.md)

## Global Constraints

- No new npm dependencies — Drive calls use the global `fetch`, same as `googleAuth.ts` and `openaiCompatible.ts` already do.
- `src/cloudSync.ts` has zero imports from `"electron"` — same explicit-path/explicit-token pattern as `src/sessionStore.ts`.
- Cloud sync must never fail, block, or delay a local operation. Every call site wraps sync in a try/catch (or `.catch(() => {})`) exactly like the existing `persistSession(...).catch(() => {})` at `src/electron/sessionRegistry.ts:161`.
- OAuth scope string becomes exactly `"openid email profile https://www.googleapis.com/auth/drive.appdata"`.
- Conflict resolution is last-writer-wins by `updatedAt` — no merge UI.
- The reconcile pass runs on every successful sign-in, not only on a first-ever/empty install.
- Every new test file gets appended to the chained `"test"` script in `package.json` (this repo has no test framework — tests are plain Node scripts run in sequence, using the hand-rolled `check(name, cond)` pattern already used throughout `src/test/*.test.ts`).

---

### Task 1: `getFreshAccessToken` + Drive scope in `googleAuth.ts`

**Files:**
- Modify: `src/electron/googleAuth.ts`
- Modify: `src/test/googleAuth.test.ts`

**Interfaces:**
- Produces: `getFreshAccessToken(authFilePath: string, clientId: string, clientSecret?: string): Promise<string | null>` — resolves to a fresh access token, or `null` if there's no stored identity or no refresh token (or the refresh token is revoked). Throws on a transient failure, same as the existing `refreshAccessToken` it wraps. Task 4 and Task 5 both call this.
- Consumes: existing `loadStoredIdentity`, `refreshAccessToken` from the same file (no signature changes to either).

- [ ] **Step 1: Update the scope assertion in the existing test (RED)**

In `src/test/googleAuth.test.ts`, find this line (inside the `Google authorization URL:` section):

```typescript
check("scope requests openid, email, and profile", parsed.searchParams.get("scope") === "openid email profile");
```

Replace it with:

```typescript
check(
  "scope requests openid, email, profile, and Drive appdata",
  parsed.searchParams.get("scope") === "openid email profile https://www.googleapis.com/auth/drive.appdata"
);
```

- [ ] **Step 2: Add failing tests for `getFreshAccessToken`**

Add this new section at the end of `src/test/googleAuth.test.ts`, before the final failure-count summary (`console.log(failures === 0 ? ...`):

```typescript
console.log("\ngetFreshAccessToken:");
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-auth-test-"));
  const authFilePath = path.join(dir, "auth.json");
  const token = await getFreshAccessToken(authFilePath, "client-id");
  check("returns null when there is no stored identity", token === null);
}
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-auth-test-"));
  const authFilePath = path.join(dir, "auth.json");
  await saveStoredIdentity(authFilePath, { email: "a@b.com", name: "A", pictureUrl: null, refreshToken: null });
  const token = await getFreshAccessToken(authFilePath, "client-id");
  check("returns null when the stored identity has no refresh token", token === null);
}
```

Add `getFreshAccessToken` to the existing import list at the top of the file (it doesn't exist yet, so this import will fail to compile/run — that's the expected RED state).

- [ ] **Step 3: Run to verify RED**

Run: `npm run build && node dist/test/googleAuth.test.js`
Expected: fails to build/run — `getFreshAccessToken` is not exported yet, and the scope assertion fails against the old scope string.

- [ ] **Step 4: Implement the scope change and `getFreshAccessToken`**

In `src/electron/googleAuth.ts`, change the scope line inside `buildGoogleAuthUrl`:

```typescript
url.searchParams.set("scope", "openid email profile");
```

to:

```typescript
url.searchParams.set("scope", "openid email profile https://www.googleapis.com/auth/drive.appdata");
```

Add this new exported function after `getAuthStatus` (near the end of the file, before `signOut` or after it — either is fine, keep it near the other identity/token functions):

```typescript
/**
 * Returns a fresh access token for API calls beyond identity (e.g. Drive
 * cloud sync), refreshing via the stored refresh token. Returns null if
 * there's no stored identity, no refresh token, or the refresh token has
 * been revoked — callers should treat any of these as "sync unavailable
 * right now" without forcing a sign-out themselves. Throws on a transient
 * failure (network, Google outage), exactly like refreshAccessToken does,
 * so callers can tell "give up for now" apart from "definitely signed out."
 */
export async function getFreshAccessToken(authFilePath: string, clientId: string, clientSecret?: string): Promise<string | null> {
  const identity = await loadStoredIdentity(authFilePath);
  if (!identity || !identity.refreshToken) return null;
  const refreshed = await refreshAccessToken(clientId, identity.refreshToken, clientSecret);
  if (!refreshed) return null;
  return refreshed.accessToken;
}
```

- [ ] **Step 5: Run to verify GREEN**

Run: `npm run build && node dist/test/googleAuth.test.js`
Expected: all checks pass, `0 test(s) FAILED`.

- [ ] **Step 6: Commit**

```bash
git add src/electron/googleAuth.ts src/test/googleAuth.test.ts
git commit -m "feat: add drive.appdata scope and getFreshAccessToken for cloud sync"
```

---

### Task 2: `src/cloudSync.ts` — Drive CRUD operations

**Files:**
- Create: `src/cloudSync.ts`
- Create: `src/test/cloudSync.test.ts`
- Modify: `package.json` (append the new test file to the chained `"test"` script)

**Interfaces:**
- Consumes: `SessionRecord` type from `src/sessionStore.ts` (`{ id, title, messages, events, createdAt, updatedAt }`, unchanged).
- Produces: `listRemoteSessions(accessToken, fetchImpl?)`, `downloadSession(accessToken, driveFileId, fetchImpl?)`, `uploadSession(accessToken, record, fetchImpl?)`, `deleteRemoteSession(accessToken, sessionId, fetchImpl?)`, and the `DriveScopeError` class — all consumed by Task 3 (reconcile) and Task 4 (`sessionRegistry.ts`).

- [ ] **Step 1: Write the failing tests**

Create `src/test/cloudSync.test.ts`:

```typescript
import { listRemoteSessions, downloadSession, uploadSession, deleteRemoteSession, DriveScopeError } from "../cloudSync.js";
import type { SessionRecord } from "../sessionStore.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

function makeRecord(id: string, updatedAt: number): SessionRecord {
  return { id, title: `title-${id}`, messages: [], events: [], createdAt: updatedAt, updatedAt };
}

console.log("cloudSync (fake fetch):");

console.log("\nlistRemoteSessions:");
{
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (url) => {
    calls.push(url.toString());
    return new Response(
      JSON.stringify({ files: [{ id: "f1", appProperties: { sessionId: "s1" } }, { id: "f2", appProperties: {} }] }),
      { status: 200 }
    );
  };
  const result = await listRemoteSessions("tok", fakeFetch);
  check(
    "maps only files that carry a sessionId property",
    result.length === 1 && result[0].sessionId === "s1" && result[0].driveFileId === "f1"
  );
  check("requests the appDataFolder space", calls[0].includes("spaces=appDataFolder"));
}

console.log("\ndownloadSession:");
{
  const record = makeRecord("s1", 123);
  const fakeFetch: typeof fetch = async (url) => {
    const u = url.toString();
    check("downloads by file id with alt=media", u.includes("/files/file-id") && u.includes("alt=media"));
    return new Response(JSON.stringify(record), { status: 200 });
  };
  const result = await downloadSession("tok", "file-id", fakeFetch);
  check("returns the parsed record", JSON.stringify(result) === JSON.stringify(record));
}

console.log("\nuploadSession — create path (no existing file):");
{
  const calls: { url: string; method?: string }[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push({ url: url.toString(), method: init?.method });
    if (!init?.method) {
      // findRemoteFile lookup: nothing exists yet
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };
  await uploadSession("tok", makeRecord("new-session", 100), fakeFetch);
  const createCall = calls.find((c) => c.method === "POST");
  check("issues a multipart create when no existing file is found", !!createCall && createCall.url.includes("uploadType=multipart"));
}

console.log("\nuploadSession — update path (existing file):");
{
  const calls: { url: string; method?: string }[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push({ url: url.toString(), method: init?.method });
    if (!init?.method) {
      return new Response(JSON.stringify({ files: [{ id: "existing-file" }] }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };
  await uploadSession("tok", makeRecord("s1", 100), fakeFetch);
  const patchCall = calls.find((c) => c.method === "PATCH");
  check(
    "issues a media PATCH to the found file id when one exists",
    !!patchCall && patchCall.url.includes("existing-file") && patchCall.url.includes("uploadType=media")
  );
}

console.log("\ndeleteRemoteSession:");
{
  const calls: { url: string; method?: string }[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push({ url: url.toString(), method: init?.method });
    if (!init?.method) return new Response(JSON.stringify({ files: [{ id: "to-delete" }] }), { status: 200 });
    return new Response(null, { status: 204 });
  };
  await deleteRemoteSession("tok", "s1", fakeFetch);
  const deleteCall = calls.find((c) => c.method === "DELETE");
  check("deletes the found file id", !!deleteCall && deleteCall.url.includes("to-delete"));
}
{
  const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({ files: [] }), { status: 200 });
  let threw = false;
  try {
    await deleteRemoteSession("tok", "missing", fakeFetch);
  } catch {
    threw = true;
  }
  check("no-ops without throwing when no remote file exists for this session", !threw);
}

console.log("\nDriveScopeError classification:");
{
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ error: { errors: [{ reason: "insufficientPermissions" }] } }), { status: 403 });
  let caught: unknown;
  try {
    await listRemoteSessions("tok", fakeFetch);
  } catch (err) {
    caught = err;
  }
  check("a 403 insufficientPermissions response throws DriveScopeError", caught instanceof DriveScopeError);
}
{
  const fakeFetch: typeof fetch = async () => new Response("server error", { status: 500 });
  let caught: unknown;
  try {
    await listRemoteSessions("tok", fakeFetch);
  } catch (err) {
    caught = err;
  }
  check("a plain 500 throws a regular Error, not DriveScopeError", caught instanceof Error && !(caught instanceof DriveScopeError));
}

console.log(failures === 0 ? "\nAll cloudSync tests passed." : `\n${failures} cloudSync test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
```

Append the compiled test to `package.json`'s `"test"` script (after `sessionStore.test.js`):

```json
"test": "node dist/test/agent.test.js && node dist/test/sessionRegistry.test.js && node dist/test/modeLabels.test.js && node dist/test/hardwareInfo.test.js && node dist/test/filenameCandidates.test.js && node dist/test/anthropicProvider.test.js && node dist/test/googleAuth.test.js && node dist/test/sessionStore.test.js && node dist/test/cloudSync.test.js",
```

- [ ] **Step 2: Run to verify RED**

Run: `npm run build && node dist/test/cloudSync.test.js`
Expected: build fails — `../cloudSync.js` doesn't exist yet.

- [ ] **Step 3: Implement `src/cloudSync.ts`**

Create `src/cloudSync.ts` with exactly this content (the `reconcileSessions` function and its supporting types are added in Task 3 — this step covers everything up through `deleteRemoteSession`):

```typescript
import crypto from "node:crypto";
import type { SessionRecord } from "./sessionStore.js";

export interface RemoteSessionMeta {
  sessionId: string;
  driveFileId: string;
}

type FetchImpl = typeof fetch;

const DRIVE_FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/drive/v3/files";

/**
 * Thrown when a Drive call fails because the stored access token doesn't
 * carry the drive.appdata scope — distinct from other failures because it
 * needs the user to sign in again, not just a retry.
 */
export class DriveScopeError extends Error {
  constructor(action: string) {
    super(`Drive ${action} failed: missing drive.appdata scope — sign in again to re-enable backup.`);
    this.name = "DriveScopeError";
  }
}

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

/** Throws DriveScopeError for an insufficient-scope 403, a plain Error for any other non-OK response, and returns normally for a 2xx. */
async function checkDriveResponse(response: Response, action: string): Promise<void> {
  if (response.ok) return;
  const bodyText = await response.text();
  if (response.status === 403 && /insufficient/i.test(bodyText)) {
    throw new DriveScopeError(action);
  }
  throw new Error(`Drive ${action} failed: ${response.status} ${bodyText.slice(0, 200)}`);
}

/** Lists every session file in this app's Drive appDataFolder, mapping each to its sessionId via appProperties. A file with no sessionId property (shouldn't happen — defensive only) is skipped. */
export async function listRemoteSessions(accessToken: string, fetchImpl: FetchImpl = fetch): Promise<RemoteSessionMeta[]> {
  const url = new URL(DRIVE_FILES_ENDPOINT);
  url.searchParams.set("spaces", "appDataFolder");
  url.searchParams.set("fields", "files(id,appProperties)");
  url.searchParams.set("pageSize", "1000");

  const response = await fetchImpl(url.toString(), { headers: authHeaders(accessToken) });
  await checkDriveResponse(response, "list");
  const body = (await response.json()) as { files?: { id: string; appProperties?: { sessionId?: string } }[] };

  const result: RemoteSessionMeta[] = [];
  for (const file of body.files ?? []) {
    const sessionId = file.appProperties?.sessionId;
    if (sessionId) result.push({ sessionId, driveFileId: file.id });
  }
  return result;
}

/** Finds the Drive file id for one session by its sessionId, or null if it hasn't been uploaded yet. */
async function findRemoteFile(accessToken: string, sessionId: string, fetchImpl: FetchImpl): Promise<string | null> {
  const url = new URL(DRIVE_FILES_ENDPOINT);
  url.searchParams.set("spaces", "appDataFolder");
  url.searchParams.set("q", `appProperties has { key='sessionId' and value='${sessionId}' }`);
  url.searchParams.set("fields", "files(id)");

  const response = await fetchImpl(url.toString(), { headers: authHeaders(accessToken) });
  await checkDriveResponse(response, "lookup");
  const body = (await response.json()) as { files?: { id: string }[] };
  return body.files?.[0]?.id ?? null;
}

/** Downloads and parses one session's full record by its Drive file id. */
export async function downloadSession(accessToken: string, driveFileId: string, fetchImpl: FetchImpl = fetch): Promise<SessionRecord> {
  const url = `${DRIVE_FILES_ENDPOINT}/${driveFileId}?alt=media`;
  const response = await fetchImpl(url, { headers: authHeaders(accessToken) });
  await checkDriveResponse(response, "download");
  return (await response.json()) as SessionRecord;
}

/** Creates or updates (by sessionId lookup) the Drive file for this session record. */
export async function uploadSession(accessToken: string, record: SessionRecord, fetchImpl: FetchImpl = fetch): Promise<void> {
  const existingFileId = await findRemoteFile(accessToken, record.id, fetchImpl);
  const content = JSON.stringify(record);

  if (existingFileId) {
    const response = await fetchImpl(`${DRIVE_UPLOAD_ENDPOINT}/${existingFileId}?uploadType=media`, {
      method: "PATCH",
      headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
      body: content,
    });
    await checkDriveResponse(response, "update");
    return;
  }

  const boundary = `localagent-${crypto.randomUUID()}`;
  const metadata = { name: `${record.id}.json`, parents: ["appDataFolder"], appProperties: { sessionId: record.id } };
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--`;

  const response = await fetchImpl(`${DRIVE_UPLOAD_ENDPOINT}?uploadType=multipart`, {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  await checkDriveResponse(response, "create");
}

/** Best-effort delete of a session's Drive file, if one exists. No-op if there is none. */
export async function deleteRemoteSession(accessToken: string, sessionId: string, fetchImpl: FetchImpl = fetch): Promise<void> {
  const fileId = await findRemoteFile(accessToken, sessionId, fetchImpl);
  if (!fileId) return;
  const response = await fetchImpl(`${DRIVE_FILES_ENDPOINT}/${fileId}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  if (response.status === 404) return;
  await checkDriveResponse(response, "delete");
}
```

- [ ] **Step 4: Run to verify GREEN**

Run: `npm run build && node dist/test/cloudSync.test.js`
Expected: all checks pass, `0 test(s) FAILED`.

- [ ] **Step 5: Commit**

```bash
git add src/cloudSync.ts src/test/cloudSync.test.ts package.json
git commit -m "feat: add Drive-backed CRUD operations for session cloud sync"
```

---

### Task 3: `reconcileSessions` — pull/push/last-writer-wins on sign-in

**Files:**
- Modify: `src/cloudSync.ts`
- Modify: `src/test/cloudSync.test.ts`

**Interfaces:**
- Consumes: `listSessions`, `loadSessionRecord`, `saveSession` from `src/sessionStore.ts` (unchanged signatures); `listRemoteSessions`, `downloadSession`, `uploadSession` from Task 2 (same file).
- Produces: `reconcileSessions(sessionsDir: string, accessToken: string, deps?: { fetchImpl?: FetchImpl; ops?: ReconcileOps }): Promise<{ pulled: number; pushed: number }>` — consumed by Task 5's sign-in handler in `main.ts`.

- [ ] **Step 1: Write the failing tests**

Add this section to `src/test/cloudSync.test.ts`, before the final failure-count summary line. It needs three more imports at the top of the file — add `os`, `path`, `fs/promises`, `reconcileSessions`, and `loadSessionRecord`/`saveSession` from `sessionStore.js`:

```typescript
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { reconcileSessions } from "../cloudSync.js"; // add to the existing cloudSync import instead of a new line
import { loadSessionRecord, saveSession } from "../sessionStore.js";
```

Then the test section:

```typescript
console.log("\nreconcileSessions:");
{
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-reconcile-test-"));
  await saveSession(sessionsDir, makeRecord("local-only", 100));

  const uploaded: SessionRecord[] = [];
  const result = await reconcileSessions(sessionsDir, "tok", {
    ops: {
      listRemoteSessions: async () => [],
      downloadSession: async () => {
        throw new Error("should not be called");
      },
      uploadSession: async (_token, record) => {
        uploaded.push(record);
      },
    },
  });
  check("pushes a local-only session to remote", uploaded.length === 1 && uploaded[0].id === "local-only");
  check("reports one pushed, zero pulled", result.pushed === 1 && result.pulled === 0);
}

{
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-reconcile-test-"));
  const remoteRecord = makeRecord("remote-only", 200);

  const result = await reconcileSessions(sessionsDir, "tok", {
    ops: {
      listRemoteSessions: async () => [{ sessionId: "remote-only", driveFileId: "f1" }],
      downloadSession: async () => remoteRecord,
      uploadSession: async () => {
        throw new Error("should not be called");
      },
    },
  });
  const local = await loadSessionRecord(sessionsDir, "remote-only");
  check("pulls a remote-only session to local", local !== null && local.title === remoteRecord.title);
  check("reports one pulled, zero pushed", result.pulled === 1 && result.pushed === 0);
}

{
  // Same id both places, remote newer -> pull and overwrite local.
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-reconcile-test-"));
  await saveSession(sessionsDir, makeRecord("both", 100));
  const newerRemote = makeRecord("both", 200);

  await reconcileSessions(sessionsDir, "tok", {
    ops: {
      listRemoteSessions: async () => [{ sessionId: "both", driveFileId: "f1" }],
      downloadSession: async () => newerRemote,
      uploadSession: async () => {
        throw new Error("should not be called");
      },
    },
  });
  const local = await loadSessionRecord(sessionsDir, "both");
  check("remote-newer overwrites the local copy", local?.updatedAt === 200);
}

{
  // Same id both places, local newer -> push and overwrite remote.
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-reconcile-test-"));
  await saveSession(sessionsDir, makeRecord("both", 300));
  const olderRemote = makeRecord("both", 100);
  const uploaded: SessionRecord[] = [];

  await reconcileSessions(sessionsDir, "tok", {
    ops: {
      listRemoteSessions: async () => [{ sessionId: "both", driveFileId: "f1" }],
      downloadSession: async () => olderRemote,
      uploadSession: async (_token, record) => {
        uploaded.push(record);
      },
    },
  });
  check("local-newer pushes the local copy to remote", uploaded.length === 1 && uploaded[0].updatedAt === 300);
  const local = await loadSessionRecord(sessionsDir, "both");
  check("local file is left untouched when local was already newer", local?.updatedAt === 300);
}

{
  // One session's failure doesn't block another's sync.
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-reconcile-test-"));
  await saveSession(sessionsDir, makeRecord("ok", 100));

  const uploaded: SessionRecord[] = [];
  const result = await reconcileSessions(sessionsDir, "tok", {
    ops: {
      listRemoteSessions: async () => [{ sessionId: "broken", driveFileId: "f-broken" }],
      downloadSession: async (_token, id) => {
        if (id === "f-broken") throw new Error("simulated network failure");
        throw new Error("unexpected id");
      },
      uploadSession: async (_token, record) => {
        uploaded.push(record);
      },
    },
  });
  check("a failed remote download doesn't abort the rest of the pass", uploaded.some((r) => r.id === "ok"));
  check("the failed session isn't counted as pulled", result.pulled === 0);
}
```

- [ ] **Step 2: Run to verify RED**

Run: `npm run build && node dist/test/cloudSync.test.js`
Expected: build fails — `reconcileSessions` is not exported yet.

- [ ] **Step 3: Implement `reconcileSessions`**

Append to `src/cloudSync.ts`. First add this import at the top of the file (alongside the existing `SessionRecord` type import):

```typescript
import { listSessions, loadSessionRecord, saveSession, type SessionRecord } from "./sessionStore.js";
```

(This replaces the Task 2 line `import type { SessionRecord } from "./sessionStore.js";`.)

Then add at the end of the file:

```typescript
export interface ReconcileResult {
  pulled: number;
  pushed: number;
}

export interface ReconcileOps {
  listRemoteSessions: (accessToken: string) => Promise<RemoteSessionMeta[]>;
  downloadSession: (accessToken: string, driveFileId: string) => Promise<SessionRecord>;
  uploadSession: (accessToken: string, record: SessionRecord) => Promise<void>;
}

function defaultReconcileOps(fetchImpl: FetchImpl): ReconcileOps {
  return {
    listRemoteSessions: (token) => listRemoteSessions(token, fetchImpl),
    downloadSession: (token, id) => downloadSession(token, id, fetchImpl),
    uploadSession: (token, record) => uploadSession(token, record, fetchImpl),
  };
}

/**
 * Runs once per successful sign-in. Diffs local sessionsDir against the
 * Drive appDataFolder: pulls anything remote-only, pushes anything
 * local-only, and for a session present in both keeps whichever has the
 * newer updatedAt (last-writer-wins), overwriting the other. Each
 * session's sync is caught individually so one bad file can't block the
 * rest of the pass.
 */
export async function reconcileSessions(
  sessionsDir: string,
  accessToken: string,
  deps: { fetchImpl?: FetchImpl; ops?: ReconcileOps } = {}
): Promise<ReconcileResult> {
  const ops = deps.ops ?? defaultReconcileOps(deps.fetchImpl ?? fetch);

  const [localEntries, remoteEntries] = await Promise.all([listSessions(sessionsDir), ops.listRemoteSessions(accessToken)]);
  const remoteIds = new Set(remoteEntries.map((e) => e.sessionId));

  let pulled = 0;
  let pushed = 0;

  for (const remote of remoteEntries) {
    try {
      const localEntry = localEntries.find((e) => e.id === remote.sessionId);
      if (!localEntry) {
        const record = await ops.downloadSession(accessToken, remote.driveFileId);
        await saveSession(sessionsDir, record);
        pulled++;
        continue;
      }
      const localRecord = await loadSessionRecord(sessionsDir, remote.sessionId);
      if (!localRecord) continue;
      const remoteRecord = await ops.downloadSession(accessToken, remote.driveFileId);
      if (remoteRecord.updatedAt > localRecord.updatedAt) {
        await saveSession(sessionsDir, remoteRecord);
        pulled++;
      } else if (localRecord.updatedAt > remoteRecord.updatedAt) {
        await ops.uploadSession(accessToken, localRecord);
        pushed++;
      }
    } catch {
      // One session's sync failure must not block the rest of the pass.
    }
  }

  for (const local of localEntries) {
    if (remoteIds.has(local.id)) continue;
    try {
      const record = await loadSessionRecord(sessionsDir, local.id);
      if (!record) continue;
      await ops.uploadSession(accessToken, record);
      pushed++;
    } catch {
      // Same as above.
    }
  }

  return { pulled, pushed };
}
```

- [ ] **Step 4: Run to verify GREEN**

Run: `npm run build && node dist/test/cloudSync.test.js`
Expected: all checks pass, `0 test(s) FAILED`.

- [ ] **Step 5: Commit**

```bash
git add src/cloudSync.ts src/test/cloudSync.test.ts
git commit -m "feat: add reconcileSessions for sign-in backup/restore"
```

---

### Task 4: `sessionRegistry.ts` — upload on save, delete on remove

**Files:**
- Modify: `src/electron/sessionRegistry.ts`
- Modify: `src/test/sessionRegistry.test.ts`

**Interfaces:**
- Consumes: `uploadSession`, `deleteRemoteSession`, `DriveScopeError` from `src/cloudSync.ts` (Task 2); `SessionRecord` type from `src/sessionStore.ts`.
- Produces: `createSessionRegistry(sessionsDir: string, cloudSync?: CloudSyncConfig): SessionRegistry` (second parameter is new — existing single-argument call sites keep working since it's optional) and the new `CloudSyncConfig` interface, consumed by Task 5's `main.ts`.

- [ ] **Step 1: Write the failing tests**

Add this section to the end of `src/test/sessionRegistry.test.ts` (inside the same top-level `await (async () => { ... })();` IIFE the rest of the file's checks live in, right before its closing `})();`). Add `import { DriveScopeError } from "../cloudSync.js";` to the top of the file alongside the existing imports.

```typescript
  console.log("\nCloud sync integration:");
  {
    const registry = createSessionRegistry(sessionsDir);
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "small" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider([{ turn: { type: "final", content: "done" } }]) }
    );
    await runTask(registry, sessionId, "a task", () => {});
    check("runTask completes without a cloudSync config and doesn't throw", true);
  }

  {
    let uploadedRecord: { token: string; record: { id: string } } | null = null;
    const registry = createSessionRegistry(sessionsDir, {
      getAccessToken: async () => "fake-token",
      onScopeError: () => {
        throw new Error("should not be called");
      },
      uploadSession: async (token, record) => {
        uploadedRecord = { token, record };
      },
    });
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "small" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider([{ turn: { type: "final", content: "done" } }]) }
    );
    await runTask(registry, sessionId, "sync me", () => {});
    check(
      "a completed task uploads the session record when signed in",
      uploadedRecord?.token === "fake-token" && uploadedRecord?.record.id === sessionId
    );
  }

  {
    let uploadCalled = false;
    const registry = createSessionRegistry(sessionsDir, {
      getAccessToken: async () => null,
      onScopeError: () => {},
      uploadSession: async () => {
        uploadCalled = true;
      },
    });
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "small" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider([{ turn: { type: "final", content: "done" } }]) }
    );
    await runTask(registry, sessionId, "not signed in", () => {});
    check("no upload is attempted when getAccessToken resolves null (signed out)", !uploadCalled);
  }

  {
    let scopeErrorCalled = false;
    const registry = createSessionRegistry(sessionsDir, {
      getAccessToken: async () => "fake-token",
      onScopeError: () => {
        scopeErrorCalled = true;
      },
      uploadSession: async () => {
        throw new DriveScopeError("upload");
      },
    });
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "small" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider([{ turn: { type: "final", content: "done" } }]) }
    );
    await runTask(registry, sessionId, "bad scope", () => {});
    check("a DriveScopeError from upload invokes onScopeError", scopeErrorCalled);
  }

  {
    let scopeErrorCalled = false;
    const registry = createSessionRegistry(sessionsDir, {
      getAccessToken: async () => "fake-token",
      onScopeError: () => {
        scopeErrorCalled = true;
      },
      uploadSession: async () => {
        throw new Error("network blip");
      },
    });
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "small" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider([{ turn: { type: "final", content: "done" } }]) }
    );
    let threw = false;
    try {
      await runTask(registry, sessionId, "transient failure", () => {});
    } catch {
      threw = true;
    }
    check("a non-scope upload failure is swallowed, not thrown, and doesn't call onScopeError", !threw && !scopeErrorCalled);
  }

  {
    let deletedSessionId: string | null = null;
    const registry = createSessionRegistry(sessionsDir, {
      getAccessToken: async () => "fake-token",
      onScopeError: () => {},
      deleteRemoteSession: async (_token, id) => {
        deletedSessionId = id;
      },
    });
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "small" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider([]) }
    );
    await removeSession(registry, sessionId);
    check("removeSession best-effort deletes the remote copy when signed in", deletedSessionId === sessionId);
  }
```

- [ ] **Step 2: Run to verify RED**

Run: `npm run build && node dist/test/sessionRegistry.test.js`
Expected: build fails — `createSessionRegistry` doesn't yet accept a second argument, `CloudSyncConfig` doesn't exist.

- [ ] **Step 3: Implement the registry changes**

In `src/electron/sessionRegistry.ts`, change the import line:

```typescript
import { saveSession, deleteSession } from "../sessionStore.js";
```

to:

```typescript
import { saveSession, deleteSession, type SessionRecord } from "../sessionStore.js";
import { uploadSession as driveUploadSession, deleteRemoteSession as driveDeleteRemoteSession, DriveScopeError } from "../cloudSync.js";
```

Add this new interface near the top, after `ResumePayload`:

```typescript
/** Best-effort cloud sync wiring, supplied by main.ts. uploadSession/deleteRemoteSession default to the real Drive-backed implementations — tests override them directly instead of faking fetch. */
export interface CloudSyncConfig {
  getAccessToken: () => Promise<string | null>;
  onScopeError: () => void;
  uploadSession?: (accessToken: string, record: SessionRecord) => Promise<void>;
  deleteRemoteSession?: (accessToken: string, sessionId: string) => Promise<void>;
}
```

Change `SessionRegistry` and `createSessionRegistry`:

```typescript
export interface SessionRegistry {
  sessions: Map<string, SessionEntry>;
  sessionsDir: string;
  cloudSync?: CloudSyncConfig;
}

export function createSessionRegistry(sessionsDir: string, cloudSync?: CloudSyncConfig): SessionRegistry {
  return { sessions: new Map(), sessionsDir, cloudSync };
}
```

Replace `persistSession` and add the two sync helpers after it:

```typescript
async function persistSession(registry: SessionRegistry, sessionId: string, entry: SessionEntry): Promise<void> {
  if (entry.deleted) return;
  const record: SessionRecord = {
    id: sessionId,
    title: entry.title ?? "(untitled)",
    messages: entry.session.getMessages(),
    events: entry.events,
    createdAt: entry.createdAt,
    updatedAt: Date.now(),
  };
  await saveSession(registry.sessionsDir, record);
  await syncUploadToCloud(registry, record);
}

/** Best-effort: cloud sync must never fail or delay the caller. A missing drive.appdata scope (DriveScopeError) is reported once via onScopeError; any other failure (offline, revoked token, transient Drive error) is silently swallowed and simply retried on the next save. */
async function syncUploadToCloud(registry: SessionRegistry, record: SessionRecord): Promise<void> {
  if (!registry.cloudSync) return;
  const { getAccessToken, onScopeError, uploadSession: upload = driveUploadSession } = registry.cloudSync;
  try {
    const token = await getAccessToken();
    if (!token) return;
    await upload(token, record);
  } catch (err) {
    if (err instanceof DriveScopeError) onScopeError();
  }
}

/** Mirrors syncUploadToCloud's best-effort contract for the delete path. */
async function syncDeleteFromCloud(registry: SessionRegistry, sessionId: string): Promise<void> {
  if (!registry.cloudSync) return;
  const { getAccessToken, onScopeError, deleteRemoteSession: del = driveDeleteRemoteSession } = registry.cloudSync;
  try {
    const token = await getAccessToken();
    if (!token) return;
    await del(token, sessionId);
  } catch (err) {
    if (err instanceof DriveScopeError) onScopeError();
  }
}
```

Update `removeSession`'s last line to also call the new delete-sync helper:

```typescript
export async function removeSession(registry: SessionRegistry, sessionId: string): Promise<void> {
  const entry = registry.sessions.get(sessionId);
  if (entry) {
    entry.deleted = true;
    await finalizeEntry(entry);
  }
  await deleteSession(registry.sessionsDir, sessionId);
  registry.sessions.delete(sessionId);
  await syncDeleteFromCloud(registry, sessionId);
}
```

- [ ] **Step 4: Run to verify GREEN**

Run: `npm run build && node dist/test/sessionRegistry.test.js`
Expected: all checks pass, `0 test(s) FAILED`.

- [ ] **Step 5: Commit**

```bash
git add src/electron/sessionRegistry.ts src/test/sessionRegistry.test.ts
git commit -m "feat: upload sessions to Drive on save, delete on remove"
```

---

### Task 5: Wire it up — `main.ts`, `preload.cjs`, `renderer.ts`

**Files:**
- Modify: `src/electron/main.ts`
- Modify: `src/electron/preload.cjs`
- Modify: `src/electron/renderer/renderer.ts`

**Interfaces:**
- Consumes: `getFreshAccessToken` (Task 1), `reconcileSessions`/`DriveScopeError` (Tasks 2-3), `createSessionRegistry(sessionsDir, cloudSync?)` (Task 4).
- No new exports — this task only wires existing pieces together and adds two new one-way IPC push channels (`agent:sessions-changed`, `agent:cloud-sync-scope-warning`).

This app has no automated test coverage for `main.ts`/`preload.cjs`/renderer wiring (same as every other IPC handler in this file) — verification here is a manual live run, matching how the session-persistence branch's model-dispose fix was verified.

- [ ] **Step 1: Update `main.ts`**

Change the import block at the top of `src/electron/main.ts`:

```typescript
import { createSessionRegistry, startSession, runTask, respondPermission, cancelSession, removeSession } from "./sessionRegistry.js";
import type { SessionConfig, ResumePayload } from "./sessionRegistry.js";
import { checkCachedModels } from "./modelCache.js";
import { detectHardware, recommendModelSize } from "./hardwareInfo.js";
import { signInWithGoogle, signOut, getAuthStatus } from "./googleAuth.js";
import { listSessions, searchSessions, loadSessionRecord } from "../sessionStore.js";
```

to:

```typescript
import { createSessionRegistry, startSession, runTask, respondPermission, cancelSession, removeSession } from "./sessionRegistry.js";
import type { SessionConfig, ResumePayload } from "./sessionRegistry.js";
import { checkCachedModels } from "./modelCache.js";
import { detectHardware, recommendModelSize } from "./hardwareInfo.js";
import { signInWithGoogle, signOut, getAuthStatus, getFreshAccessToken } from "./googleAuth.js";
import { listSessions, searchSessions, loadSessionRecord } from "../sessionStore.js";
import { reconcileSessions, DriveScopeError } from "../cloudSync.js";
```

Replace the body of `app.whenReady().then(() => { ... })` from its start through the `agent:google-sign-in` handler with:

```typescript
app.whenReady().then(() => {
  const authFilePath = path.join(app.getPath("userData"), "auth.json");
  const sessionsDir = path.join(app.getPath("userData"), "sessions");
  const win = createWindow();

  let scopeWarningSent = false;
  function notifyScopeWarning(): void {
    if (scopeWarningSent) return;
    scopeWarningSent = true;
    win.webContents.send("agent:cloud-sync-scope-warning");
  }

  const registry = createSessionRegistry(sessionsDir, {
    getAccessToken: () =>
      getFreshAccessToken(authFilePath, process.env.GOOGLE_OAUTH_CLIENT_ID ?? "", process.env.GOOGLE_OAUTH_CLIENT_SECRET),
    onScopeError: notifyScopeWarning,
  });

  ipcMain.handle("agent:start-session", (event, config: SessionConfig, resume?: ResumePayload) =>
    startSession(registry, config, {
      onDownloadProgress: (status) => event.sender.send("agent:model-progress", status),
      resume,
    })
  );

  ipcMain.handle("agent:run-task", (event, sessionId: string, task: string) =>
    runTask(registry, sessionId, task, (agentEvent) => {
      event.sender.send("agent:event", sessionId, agentEvent);
    })
  );

  ipcMain.handle("agent:respond-permission", (_event, sessionId: string, callId: string, approved: boolean) =>
    respondPermission(registry, sessionId, callId, approved)
  );

  ipcMain.handle("agent:cancel-session", (_event, sessionId: string) => cancelSession(registry, sessionId));

  ipcMain.handle("agent:list-cached-models", () => checkCachedModels());

  ipcMain.handle("agent:hardware-info", async () => {
    const info = await detectHardware();
    return { ...info, recommended: recommendModelSize(info) };
  });

  ipcMain.handle("agent:pick-workspace", async () => {
    const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });
  ipcMain.handle("agent:google-sign-in", async () => {
    const result = await signInWithGoogle(
      process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
      authFilePath,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET
    );
    if (!("error" in result)) {
      try {
        const token = await getFreshAccessToken(
          authFilePath,
          process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
          process.env.GOOGLE_OAUTH_CLIENT_SECRET
        );
        if (token) {
          await reconcileSessions(sessionsDir, token);
          win.webContents.send("agent:sessions-changed");
        }
      } catch (err) {
        if (err instanceof DriveScopeError) notifyScopeWarning();
        // Any other reconcile failure is non-fatal — sign-in itself already succeeded.
      }
    }
    return result;
  });
```

Leave everything from `ipcMain.handle("agent:sign-out", ...)` through the end of the file unchanged.

- [ ] **Step 2: Update `preload.cjs`**

In `src/electron/preload.cjs`, add these two entries to the `contextBridge.exposeInMainWorld("agent", { ... })` object, right after the existing `deleteSession` entry:

```javascript
  deleteSession: (id) => ipcRenderer.invoke("agent:delete-session", id),
  onSessionsChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("agent:sessions-changed", listener);
    return () => ipcRenderer.removeListener("agent:sessions-changed", listener);
  },
  onCloudSyncScopeWarning: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("agent:cloud-sync-scope-warning", listener);
    return () => ipcRenderer.removeListener("agent:cloud-sync-scope-warning", listener);
  },
});
```

(That is: keep the existing `deleteSession` line as-is, add the two new entries after it, keep the closing `});`.)

- [ ] **Step 3: Update `renderer.ts`**

In `src/electron/renderer/renderer.ts`, add two methods to the `AgentBridge` interface, right after the existing `deleteSession` line:

```typescript
  deleteSession(id: string): Promise<void>;
  onSessionsChanged(callback: () => void): () => void;
  onCloudSyncScopeWarning(callback: () => void): () => void;
}
```

Near the end of the file, right before the final line `window.agent.getAuthStatus().then(renderAuthState).catch(() => {});`, add:

```typescript
window.agent.onSessionsChanged(() => {
  void refreshSessionList(sessionSearchInput.value.trim());
});

window.agent.onCloudSyncScopeWarning(() => {
  authError.textContent = "Sign in again to keep backing up your sessions to Google Drive.";
});

window.agent.getAuthStatus().then(renderAuthState).catch(() => {});
```

(Remove the old standalone `window.agent.getAuthStatus().then(renderAuthState).catch(() => {});` line from its original position — it moves to the end of this new block.)

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: compiles with no errors.

- [ ] **Step 5: Manual live verification**

This wiring has no automated test in this codebase (consistent with the rest of `main.ts`) — verify it live:

1. Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` (same line as the command, or exported first) and run `npm run electron`.
2. Sign in with a real Google account. Because the OAuth scope changed, Google's consent screen will ask for Drive `appdata` access even for an account that signed in before this feature — that's expected, not a bug.
3. Run one task to create a session; confirm it appears in the sidebar.
4. Quit the app. Find the session storage directory (Electron's `app.getPath('userData')` + `/sessions` — on macOS this is normally `~/Library/Application Support/localagent/sessions`; if unsure, temporarily add a `console.log(sessionsDir)` in `main.ts` and check the terminal) and rename or delete it, to simulate a fresh install.
5. Relaunch the app and sign in again. Confirm the session reappears in the sidebar without being manually recreated (the reconcile pass's pull path).
6. Click into the restored session and send another task referencing the first one (e.g. "what did I just ask you?") — confirm the model's reply shows it has the full prior context, not just a blank session with the same title.
7. Sign out. Create a new session while signed out; confirm nothing errors (cloud sync is skipped while signed out).
8. Sign back in. Confirm that session now appears in Drive too — i.e., the next reconcile pass's push path picked it up. (Indirect check: delete the local copy of that session's file only, leaving the index — actually simpler: just trust the automated reconcile tests from Task 3 for the push-path logic itself, and use this step only to confirm no crash/error occurs signing in with a locally-newer, not-yet-uploaded session present.)

If any step fails, fix forward before moving on — do not commit broken wiring.

- [ ] **Step 6: Commit**

```bash
git add src/electron/main.ts src/electron/preload.cjs src/electron/renderer/renderer.ts
git commit -m "feat: wire Drive sync into sign-in, save, and delete flows"
```

---

## Plan self-review notes

- Spec coverage: architecture (Tasks 2-3), scope/gating behavior (Task 5's optional `cloudSync` — absent when signed out, exactly today's behavior), backup flow (Task 4), restore/reconcile flow (Task 3, wired in Task 5), conflict resolution (Task 3's last-writer-wins branch, tested both directions), scope/consent change (Task 1's scope string + Task 5's `DriveScopeError` → `notifyScopeWarning` wiring), error handling (best-effort try/catch at every call site, Tasks 4-5), testing (Tasks 1-4 automated, Task 5 manual per the spec's own "no Playwright/live-Drive verification is planned for the design itself... manual" note).
- No placeholders — every step has real code, not a description of code.
- Type consistency checked: `CloudSyncConfig`, `ReconcileOps`, `SessionRecord` field names match across Tasks 2-5.
