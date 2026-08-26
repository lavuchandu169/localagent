# Google / Apple sign-in — design spec

Date: 2026-08-26

## Purpose

Add a sign-in/sign-out mechanism to the Electron app, identifying who's
using it. Deliberately scoped to identity only — nothing is gated behind
being signed in yet. What (if anything) sign-in eventually protects —
licensing, settings sync — is a separate future decision, not part of
this spec.

This is a real addition to the app's surface area, not a small toggle:
the app's own About panel says "Everything runs on this machine. Nothing
is sent anywhere else," and OAuth sign-in is a genuine network-dependent
flow, even though it never touches your code or files. Worth naming
plainly rather than glossing over.

## Scope: Google now, Apple deferred

Google Sign-In is fully buildable today — no external account needed
beyond a free Google Cloud OAuth client ID, which the user creates
themselves (see Prerequisites).

Sign in with Apple, for a desktop app outside the App Store, requires a
paid Apple Developer Program membership ($99/year) and a real public web
domain registered as the redirect target — Apple does not accept
`localhost` or a custom URL scheme as the redirect the way Google's flow
allows. Neither exists for this project. Apple sign-in is stubbed as a
visibly disabled "Sign in with Apple (coming soon)" control; wiring it up
for real is a follow-on piece of work once those prerequisites exist, not
part of this implementation.

## Architecture: system browser + loopback server + PKCE

Three approaches were considered:

- **Chosen: system browser + a temporary local loopback HTTP server +
  PKCE.** Google's own documented pattern for desktop apps. The app opens
  the real OS default browser via `shell.openExternal` for the consent
  screen (Google blocks its login page inside embedded app webviews —
  Electron's `BrowserWindow` counts), and a short-lived
  `http://127.0.0.1:<port>` server the main process starts just for this
  exchange catches the redirect. Zero new npm dependencies — Node's
  built-in `crypto`, `http`, and `fetch` cover PKCE generation, the
  loopback listener, and the token/userinfo HTTPS calls.
- **Rejected: custom URL scheme** (`localagent://oauth-callback`). No
  local server needed, but OS-level protocol-handler registration is
  unreliable for an app launched from source via `npm run electron`
  rather than a packaged/installed one — and packaging remains explicitly
  out of scope for this project.
- **Rejected: a hosted auth service** (Auth0/Firebase Auth/Clerk). Less
  code, but adds a real third-party service dependency — running on
  someone else's servers — just to answer "who's signed in," which is
  the same local-first tension this project has already deliberately
  avoided elsewhere (e.g. choosing the embedded model over an LM
  Studio/Ollama server dependency). Over-engineered for identity-only
  scope.

### Flow

1. User clicks "Sign in with Google" in the renderer.
2. Main process (`src/electron/googleAuth.ts`) generates a PKCE
   `code_verifier`/`code_challenge` pair via `node:crypto`, and starts a
   one-shot HTTP server on an OS-assigned loopback port
   (`http://127.0.0.1:0`, letting the OS pick a free port).
3. Main opens `https://accounts.google.com/o/oauth2/v2/auth?...` in the
   system default browser via `shell.openExternal`, with
   `redirect_uri=http://127.0.0.1:<port>/callback` and the PKCE
   `code_challenge`.
4. User signs in and consents in their real browser.
5. Google redirects to the loopback server with `?code=...`. The server
   captures it, responds with a simple "you can close this tab, return to
   localagent" HTML page, and shuts itself down.
6. Main exchanges the code (+ `code_verifier`) for tokens via a direct
   HTTPS POST to `https://oauth2.googleapis.com/token` — no client secret
   needed for a "Desktop app" OAuth client type combined with PKCE.
7. Main calls `https://www.googleapis.com/oauth2/v3/userinfo` with the
   access token for `{ email, name, picture }`.
8. Identity (email, name, picture URL, refresh token) is written to
   `app.getPath('userData')/auth.json`. The refresh token lets sign-in
   persist across app restarts without re-prompting.
9. Main notifies the renderer over IPC that sign-in succeeded, with the
   display identity (never the tokens — those stay main-process-only,
   same boundary the rest of this app already keeps for anything
   sensitive).

Sign-out deletes `auth.json` and notifies the renderer.

## IPC contract

Mirrors the existing pattern in `preload.cjs`/`sessionRegistry.ts` —
narrow, typed, main-owns-state:

- `agent:google-sign-in()` → `{ email, name, pictureUrl } | { error: string }`.
  Runs the whole flow above; the invoke doesn't resolve until the user
  finishes (or abandons) the browser flow.
- `agent:sign-out()` → `void`. Clears `auth.json`, notifies the renderer.
- `agent:auth-status()` → `{ signedIn: false } | { signedIn: true, email, name, pictureUrl }`.
  Called once on renderer load to restore UI state from `auth.json`
  (validating/refreshing the stored token if present) without requiring a
  fresh sign-in every launch.

## Storage

`app.getPath('userData')/auth.json`, main-process-only file access (same
pattern already used for everything else — the renderer never gets raw
`fs`). Contains `{ email, name, pictureUrl, refreshToken }`. This file is
equivalent in sensitivity to a browser's saved-login state; no new
protection beyond normal OS file permissions is in scope here, consistent
with how e.g. `~/.node-llama-cpp/models` is already handled.

## UI

A compact control in `#app-header`, next to the existing "?" About
button:

- Signed out: "Sign in with Google" (functional) and "Sign in with Apple"
  (rendered `disabled`, tooltip "Coming soon — needs an Apple Developer
  account and a registered domain").
- Signed in: "{name} · Sign out" (picture optional — small avatar if
  present, initials fallback otherwise, to avoid a broken-image state).
- No blocking modal — sign-in is optional and doesn't gate anything else
  in the UI, consistent with the "identity only" scope.

## Prerequisites (user-side, not part of this implementation)

Before this can be exercised live, the user creates a Google Cloud OAuth
client ID:

1. https://console.cloud.google.com/ → create/select a project.
2. APIs & Services → OAuth consent screen → configure (External or
   Internal, as applicable) with an app name and support email.
3. APIs & Services → Credentials → Create Credentials → OAuth client ID →
   Application type: **Desktop app**.
4. Copy the generated Client ID.
5. Set it as `GOOGLE_OAUTH_CLIENT_ID` in the environment the Electron app
   launches from — same pattern as `ANTHROPIC_API_KEY`, no UI text field,
   nothing committed to the repo.

If `GOOGLE_OAUTH_CLIENT_ID` is unset, "Sign in with Google" surfaces a
clear inline error rather than silently failing, matching how a missing
`ANTHROPIC_API_KEY` is already handled for the Claude provider.

## Testing

The PKCE-generation and token/userinfo-parsing logic are pure functions,
unit-testable the same way as the rest of this codebase (no real network
needed): given a mocked token/userinfo response shape, does the code
produce the right stored identity object. The loopback server, the real
Google network calls, and `shell.openExternal` are not unit-testable —
verified manually once a real `GOOGLE_OAUTH_CLIENT_ID` exists, the same
documented gap as the embedded model's real load path.

## Known limitations (accepted for this pass)

- Apple sign-in is a disabled stub, not implemented.
- No token refresh *scheduling* — the stored refresh token is used
  opportunistically to re-establish a session on launch; if it's expired
  or revoked, the user just signs in again.
- Nothing in the app is currently gated by sign-in state — this is
  intentional, per scope.
