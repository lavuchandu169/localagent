# In-app Google OAuth Settings — design spec

Date: 2026-08-30

## Purpose

Google sign-in is non-functional in the distributed `.dmg`/`.exe` — a real
gap discovered during the first beta release
(`docs/superpowers/specs/2026-08-29-packaging-design.md`). `main.ts` calls
`loadEnvFile(process.cwd())` to pick up `GOOGLE_OAUTH_CLIENT_ID`/
`GOOGLE_OAUTH_CLIENT_SECRET`, but for an app launched from Finder/Start
menu, `process.cwd()` is never a project root — no `.env` is ever found.
Today the only way to sign in is running from source, or launching the
packaged binary directly from a terminal with credentials passed inline —
both undiscoverable for a normal user who just downloaded the app.

This adds a Settings panel inside the app itself, so a user can paste in
their own Google OAuth Client ID/Secret and sign in — no terminal, no
`.env`, no source checkout.

## Scope

Google OAuth credentials only — not a general settings screen. Other
env-configurable values (`ANTHROPIC_API_KEY`, `--base-url`, etc.) stay
exactly as they are today. This is deliberately narrow: it closes the one
gap that's actually broken, not a general preferences system nobody asked
for yet.

## Storage

A new file, `app.getPath('userData')/googleSettings.json`, holding:

```typescript
interface GoogleSettings {
  clientId: string | null;
  clientSecret: string | null;
}
```

Encrypted at rest via the exact same mechanism already built for the
stored refresh token: `src/electron/secureStorage.ts`'s `StorageCrypto`
(Electron's `safeStorage`, OS Keychain/DPAPI/libsecret). No new
dependency, no new pattern — this file is functionally a sibling of
`auth.json`, reusing the same optional-crypto-parameter shape.

### `src/electron/googleSettings.ts` (new)

Electron-free, mirrors `googleAuth.ts`'s `loadStoredIdentity`/
`saveStoredIdentity` exactly:

```typescript
export interface GoogleSettings {
  clientId: string | null;
  clientSecret: string | null;
}

export async function loadGoogleSettings(
  settingsFilePath: string,
  storageCrypto?: StorageCrypto
): Promise<GoogleSettings>

export async function saveGoogleSettings(
  settingsFilePath: string,
  settings: GoogleSettings,
  storageCrypto?: StorageCrypto
): Promise<void>
```

`loadGoogleSettings` returns `{ clientId: null, clientSecret: null }` (not
an error) when the file doesn't exist yet — first run, nothing saved.
`StorageCrypto` is imported as a type from `googleAuth.ts` (already
exported there from the packaging-adjacent security work), not
redefined.

## Precedence: environment variables still win

A new helper, `resolveGoogleCredentials(settingsFilePath, storageCrypto?)`,
replaces every direct `process.env.GOOGLE_OAUTH_CLIENT_ID ?? ""` /
`process.env.GOOGLE_OAUTH_CLIENT_SECRET` read in `main.ts` (currently 7
call sites):

```typescript
export async function resolveGoogleCredentials(
  settingsFilePath: string,
  storageCrypto?: StorageCrypto
): Promise<{ clientId: string; clientSecret: string | undefined }> {
  if (process.env.GOOGLE_OAUTH_CLIENT_ID) {
    return { clientId: process.env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET };
  }
  const settings = await loadGoogleSettings(settingsFilePath, storageCrypto);
  return { clientId: settings.clientId ?? "", clientSecret: settings.clientSecret ?? undefined };
}
```

This matches `loadEnvFile`'s own existing rule verbatim ("an
already-set environment variable always wins over the file") — the
existing from-source `.env` workflow is completely unaffected; Settings
is purely the fallback for exactly the case that's broken today (no env
var, no `.env`, packaged install).

## IPC

Two new channels, following this app's existing `agent:*` naming and
main-process-owns-the-file-access pattern (same as every other IPC
handler in `main.ts`):

- `agent:get-google-settings()` → `{ clientId: string; hasSecret: boolean }`.
  The secret itself is never sent to the renderer once saved — only
  whether one exists, shown as a masked state. This avoids ever having a
  plaintext secret sitting in renderer-process memory/dev tools after the
  first save.
- `agent:save-google-settings({ clientId, clientSecret })` → `void`.
  Writes both fields via `saveGoogleSettings`. No app restart needed —
  `resolveGoogleCredentials` is already called fresh on every sign-in
  attempt (mirroring how `process.env` is already read fresh per-call
  today, not cached at startup).

## UI

A new "Settings" panel, structurally identical to the existing "About"
panel (`#about-toggle` / `#about-panel` / `#about-close` in
`index.html`) — same toggle-button-next-to-header pattern, same
show/hide mechanics in `renderer.ts`. A new `#settings-toggle` button
sits beside the existing `#about-toggle` "?" button.

Panel contents:
- Client ID field (text input).
- Client Secret field (password-masked input) — placeholder shows
  "•••• saved" when `hasSecret` is true from the last `get-google-settings`
  call, otherwise empty. Typing a new value and saving overwrites the
  stored secret; leaving it as the masked placeholder and saving only a
  changed Client ID leaves the previously-saved secret untouched (the
  IPC call only overwrites fields that were actually edited — the
  renderer tracks whether the secret field was touched, not just its
  displayed value).
- The same 4-step "create your own OAuth Client ID" instructions
  currently only in the README (Google Cloud Console → OAuth consent
  screen → Credentials → Desktop app type), condensed inline, with a
  link to the fuller README section for anyone who wants the
  troubleshooting table (test users, Drive API enablement, etc.) too.
- A Save button; on success, a brief inline confirmation, no page reload.

`googleSignInBtn`'s existing inline error text
("`GOOGLE_OAUTH_CLIENT_ID is not set — see README for how to create one.`",
defined in `googleAuth.ts`'s `signInWithGoogle`) changes to
"`GOOGLE_OAUTH_CLIENT_ID is not set — add your Google OAuth credentials in Settings.`" —
this is a plain string change in existing code, not new logic.

## Error handling

- Saving with an empty Client ID is allowed (clears it back to
  unset/fallback-to-env-var state) — no validation blocking a user from
  clearing their own settings.
- No validation that the Client ID/Secret are actually well-formed or
  correct — exactly like the existing `.env`/environment-variable path
  today, a bad value just surfaces as the existing sign-in error flow
  (`{ error: string }` from `signInWithGoogle`), not a new validation
  layer.
- File read/write failures for `googleSettings.json` follow the same
  lenient pattern as `loadStoredIdentity` (corrupted/missing file →
  treated as "nothing saved yet", not a crash).

## Testing

`googleSettings.ts` is Electron-free and pure — unit-testable the same
way `googleAuth.test.ts` already tests identity storage: round-trip
save/load, missing-file defaults, and the same fake-`StorageCrypto`
round-trip/mismatch tests already established for `auth.json`.
`resolveGoogleCredentials`'s env-var-wins-over-settings precedence gets
its own test (env var present → settings ignored; env var absent →
settings used; neither present → empty clientId, undefined secret).

`main.ts`/`preload.cjs`/renderer UI changes get no automated test
(matches this project's consistent treatment of Electron-only code
throughout) — verified live, the same way prior Electron-touching
features in this project were verified: a real Playwright-driven launch
confirming the Settings panel opens, accepts input, saves, and that
`get-google-settings` reflects the saved state on next load.

## Out of scope

- Any settings beyond Google OAuth Client ID/Secret.
- Settings sync/backup (Drive cloud sync already covers session history
  only, not app configuration).
- In-app validation/testing of entered credentials beyond the existing
  sign-in flow's own error surface.
- Removing or changing the `.env`/environment-variable path — it remains
  the primary, higher-priority path for from-source development.
