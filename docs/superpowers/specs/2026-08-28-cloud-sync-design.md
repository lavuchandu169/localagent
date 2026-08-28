# Google Drive session sync — design spec

Date: 2026-08-28

## Purpose

Session history is currently local-only: it lives in
`sessionsDir/<id>.json` on one machine and nothing connects it to the
Google sign-in feature already built. A reinstall, or a switch to a
different machine, loses everything.

This adds automatic backup of session history to the signed-in user's
Google Drive, and automatic restore on sign-in, so sessions survive a
reinstall or move to a new device. It builds directly on two existing
subsystems: the local file-per-session store (`src/sessionStore.ts`)
and the Google OAuth sign-in flow (`src/electron/googleAuth.ts`).

**Primary scenario:** backup and restore across a reinstall or new
machine. **Not the primary scenario:** live, concurrent multi-device
use — two devices open on the same account at once is handled
correctly (see Conflict resolution) but isn't the design target, and
nothing here does live push/notify between devices.

## Scope change from the original sign-in spec

The original Google sign-in spec was explicit that sign-in gates
nothing — it's optional identity, full stop. This feature keeps that
true for the app as a whole: everything continues to work fully
signed-out, and local session save/resume is unaffected either way.
What changes is narrower — signing in now also turns on automatic
cloud backup of session history. Sign-in remains optional; it just
does more than identity now for users who opt into it.

## Architecture: reuse the existing per-session file shape, sync via Drive's `appDataFolder`

### Approaches considered

- **Chosen: Google Drive `appDataFolder` scope, one Drive file per
  local session file.** `drive.appdata` is a special OAuth scope that
  grants a per-app, per-account hidden folder — invisible in the
  user's normal Drive UI, meant exactly for this kind of app-private
  data. Reuses the existing OAuth/PKCE flow in `googleAuth.ts` almost
  entirely (one added scope); talks to the Drive REST API with plain
  `fetch`, the same pattern already used there for token exchange and
  userinfo. Zero new npm dependencies. One Drive file per session
  mirrors the local `sessionsDir/<id>.json` layout exactly, so the
  sync unit is small and consistent with what already exists.
- **Rejected: a custom backend server.** Needs real infrastructure to
  build and host — a server, a database, ongoing cost. Directly
  contradicts this project's local-first design and the same reasoning
  that already rejected a hosted auth service for sign-in.
- **Rejected: a different cloud storage provider (e.g. S3-compatible).**
  Needs its own separate auth unrelated to the Google account the user
  is asking to sync with, plus either a new SDK dependency or hand-rolled
  request signing. No advantage over Drive `appdata` for this use case.

### Locating a session's Drive file without a local mapping table

Each Drive file is created with `appProperties: { sessionId: "<id>" }`.
To sync a given local session, first query Drive for a file with that
`sessionId` (`files.list` with `q: "appProperties has { key='sessionId' and value='<id>' } and 'appDataFolder' in parents"`) —
update it if found (`files.update`, media upload), create it if not
(`files.create`, multipart upload, `parents: ["appDataFolder"]`). This
avoids adding any new local state just to track which Drive file
belongs to which session — Drive's own metadata is the mapping.

### Data shape

The Drive file's content is exactly the JSON already produced by
`sessionStore.ts`'s `SessionRecord` — no new shape:

```typescript
interface SessionRecord {
  id: string;
  title: string;
  messages: ChatMessage[];
  events: AgentEvent[];
  createdAt: number;
  updatedAt: number;
}
```

## Components

### `src/cloudSync.ts` (new)

Electron-free, pure — every function takes an access token explicitly,
following the same explicit-path pattern as `sessionStore.ts`
(`sessionsDir: string` there, `accessToken: string` here). No Electron
imports, fully unit-testable with a fake `fetch`.

```typescript
export interface RemoteSessionMeta {
  sessionId: string;
  driveFileId: string;
}

/** Lists every session file in this app's Drive appDataFolder, via appProperties.sessionId. */
export async function listRemoteSessions(accessToken: string): Promise<RemoteSessionMeta[]>

/** Downloads and parses one session's full record by its Drive file id. */
export async function downloadSession(accessToken: string, driveFileId: string): Promise<SessionRecord>

/** Creates or updates (by sessionId lookup) the Drive file for this session record. */
export async function uploadSession(accessToken: string, record: SessionRecord): Promise<void>

/** Best-effort delete of a session's Drive file, if one exists. No-op if not found. */
export async function deleteRemoteSession(accessToken: string, sessionId: string): Promise<void>
```

All four throw on a genuine HTTP/network failure (mirroring
`googleAuth.ts`'s existing `fetch`-wrapping functions) — callers are
responsible for catching and treating sync as best-effort, per Error
handling below.

### `googleAuth.ts` (modified)

`buildGoogleAuthUrl`'s scope string changes from `"openid email profile"`
to `"openid email profile https://www.googleapis.com/auth/drive.appdata"`.
This is the only change to this file's public surface.

**Re-consent for existing sign-ins:** a user already signed in under
the old scope list has an access/refresh token that does not carry
`drive.appdata`. This is a one-time transition, not an ongoing
concern: when a Drive call fails with an insufficient-scope error
(HTTP 403 with reason `insufficientPermissions` or similar in the
response body), treat it the same as "not signed in" for sync purposes
(skip this sync cycle) and surface a one-time prompt asking the user to
sign in again to enable backup. No automatic re-auth — the user drives
it, same as any other sign-in.

### `sessionRegistry.ts` (modified) and `main.ts` (modified)

Sync is triggered from the two places that already own the local
persistence lifecycle — no new orchestration layer:

- **On task completion** (`persistSession`, called from `doRunTask`
  after the `done` event, `sessionRegistry.ts:161`): after the local
  `saveSession` call succeeds, if the user is signed in, call
  `cloudSync.uploadSession` for that one record. Wrapped in the same
  best-effort `.catch(() => {})` style already used for the local save
  itself.
- **On session delete** (`removeSession`, `sessionRegistry.ts:231`):
  after the local `deleteSession` call, if signed in, best-effort call
  `cloudSync.deleteRemoteSession`.
- **On sign-in success** (`main.ts`'s `agent:google-sign-in` handler):
  after `signInWithGoogle` resolves successfully, run the reconcile
  pass described below, then notify the renderer to refresh the
  sidebar (reusing the existing session-list IPC channel).

### Reconcile pass (new function in `src/cloudSync.ts`)

Runs once per successful sign-in (not only on a first-ever/empty
install — every sign-in, so a reinstall, a fresh sign-in after
sign-out, and "sign in again for the new scope" all go through the
same path):

```typescript
export async function reconcileSessions(
  sessionsDir: string,
  accessToken: string
): Promise<{ pulled: number; pushed: number }>
```

1. `listSessions(sessionsDir)` (local) and `listRemoteSessions(accessToken)` (remote).
2. For each remote session missing locally: `downloadSession`, then
   local `saveSession`. (Pull.)
3. For each local session missing remotely: `uploadSession`. (Push —
   catches up anything created while signed out.)
4. For each id present in both: compare `updatedAt`. If remote is
   newer, download and overwrite local. If local is newer, upload and
   overwrite remote. Equal timestamps: no-op (already in sync).
5. Return counts for logging; errors during any individual session's
   sync are caught per-session so one bad file doesn't abort the rest
   of the pass.

This single function serves both "restore on fresh install" (all
sessions are pulls) and "reconcile on every other sign-in" (a mix of
pulls, pushes, and no-ops) — there's no separate first-time-restore
code path.

## Conflict resolution

Last-writer-wins by `updatedAt`, applied only during the reconcile
pass (step 4 above). This is not a live sync — two devices editing the
same session at literally the same moment isn't a scenario this design
protects against beyond "whichever finished saving last wins," which
matches the "backup/restore," not "live collaboration," scope decided
for this feature.

## Error handling

Cloud sync must never fail, block, or delay a local operation — the
app has to work exactly as it does today if Drive is unreachable, the
token is stale, or the user is signed out.

- Every call site wraps its `cloudSync` call in `.catch(() => {})` (or
  equivalent), exactly matching the existing pattern at
  `sessionRegistry.ts:161`'s `persistSession(...).catch(() => {})`.
- Token refresh failure (expired refresh token, revoked access) is
  treated as "sync unavailable this cycle" — it does not sign the user
  out or surface an error dialog. The existing sign-in state shown in
  the UI is unaffected; only backup silently pauses until the user
  next signs in successfully.
- Insufficient-scope errors (old-scope token) trigger the one-time
  re-sign-in prompt described above, at most once per app session (not
  on every single task completion) — a boolean flag on the registry
  suffices to avoid repeat prompts.
- Network failures during the reconcile pass are caught per-session
  (see reconcile step 5) so a single corrupt or unreachable file
  doesn't block the rest of the user's history from restoring.

## Testing

- `src/test/cloudSync.test.ts` (new): unit tests for `listRemoteSessions`,
  `downloadSession`, `uploadSession`, `deleteRemoteSession`, and
  `reconcileSessions` against a fake `fetch` (or a fake `cloudSync`
  module for `reconcileSessions`'s own tests) — no real network, no
  Electron. Covers: create-when-absent vs update-when-present upload
  path, last-writer-wins both directions, per-session error isolation
  in the reconcile pass, and the insufficient-scope error being
  distinguishable from other failures.
- `src/test/sessionRegistry.test.ts` (extended): task-completion and
  delete paths call a stubbed `cloudSync` when "signed in," and do not
  call it at all when signed out — mirrors how this file already stubs
  the model provider.
- No Playwright/live-Drive verification is planned for the design
  itself; the implementation plan's final task should include a real,
  manual sign-in → save → reinstall(simulated: wipe local
  `sessionsDir`) → sign-in → restore check, the same kind of
  independent live verification used for the session-persistence
  feature's model-dispose fix.

## Out of scope

- Live multi-device concurrent sync / push notifications between
  devices.
- Any UI for browsing or managing what's been backed up beyond the
  existing session sidebar (no separate "cloud sessions" view).
- Selective/partial backup (e.g. excluding specific sessions) — all
  sessions sync, matching "automatic" as decided.
- Apple sign-in interaction — Apple sign-in remains the disabled stub
  it already is; this feature is Google-account-only, consistent with
  the existing sign-in feature's scope.
