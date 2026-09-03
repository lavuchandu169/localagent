# Automatic updates — design spec

Date: 2026-09-03

## Purpose

Today a user on an old build gets a small banner saying a new version
exists, with a link to the GitHub release page — they still have to visit
GitHub, pick the right installer for their OS, download it, and run it by
hand. This replaces that with: detect a new release in the background,
download and verify it with no click required, then offer a one-click
restart to apply it (or apply it automatically the next time the user
quits on their own).

## A prerequisite this design does not solve: code signing

This app ships completely unsigned on both platforms today — no
`mac.identity`/notarization, no Windows certificate, confirmed in
`package.json`'s `build` config and `.github/workflows/release.yml`. That
matters for two separate reasons:

1. **macOS Gatekeeper** blocks an unsigned app from launching after any
   replacement of its files — including a self-update. electron-updater's
   Mac updater is also known to sometimes refuse to *apply* an update to
   an unsigned/non-notarized app at all (an upstream limitation, not
   something this design can route around).
2. **Windows SmartScreen/UAC** will very likely show one "Unknown
   Publisher" prompt during install of an unsigned build. That's an OS
   elevation gate — nothing in this design can suppress it, and nothing
   should try to.

There's a third dimension beyond OS-level UX gates: without code signing,
there is no cryptographic binding between a downloaded update and this
project's publisher identity. electron-updater verifies a downloaded
artifact's sha512 against the metadata file it fetched over TLS from
GitHub — a reasonable integrity check — but nothing verifies *who*
produced that artifact. Anyone able to publish a release to this repo (a
compromised `GITHUB_TOKEN`, a compromised maintainer account, or a
malicious workflow edit) can push to every installed client with zero
user consent step, once this feature ships. That's inherent to auto-update
in general, not a defect in this design — but it's a real reason "sign
later" matters beyond smoothing out Gatekeeper/SmartScreen prompts, and is
worth weighing when prioritizing that follow-up.

Real code signing (an Apple Developer ID + notarization; a Windows
code-signing certificate) is the only real fix for both, and needs
accounts/purchases only the project owner can make. This spec builds the
full mechanism on top of today's unsigned builds — "best-effort now, sign
later" — and is written so that adding signing later is purely a CI/config
change, not a redesign: every fallback path below exists specifically so
an unsigned Mac build degrades to today's manual-link banner instead of
breaking, while Windows likely works close to end-to-end already.

## Scope

Applies to packaged builds only (`app.isPackaged`), exactly like today's
notify-only check — a from-source `npm run electron` run has nothing to
check against and continues to skip this entirely. Every tagged release is
a valid update target (this app has no stable/beta channel split — every
release ships as a GitHub prerelease already, `allowPrerelease` stays
`true`, unchanged).

## State machine

```
idle → downloading (auto, no click) → ready (Restart Now | dismiss)
  │                                        │
  └──────────────► fallback ◄──────────────┘
       (any check/download/install error)
```

`fallback` is exactly today's existing banner: "a new version is
available" + a link to the GitHub release page. Every failure path in this
design lands there — the feature can degrade to current behavior, never
below it.

## Main process (`src/electron/main.ts`)

The existing `autoUpdater` block (inside `app.whenReady()`, gated by
`app.isPackaged`) grows from notify-only into the full flow:

```typescript
autoUpdater.allowPrerelease = true; // unchanged
autoUpdater.autoDownload = true;    // was false — download starts the instant an update is found, no click

let updateReadyToInstall = false;
let installingForUpdate = false; // guards the before-quit handler against re-entering quitAndInstall's own quit
let currentlyKnownUpdateVersion = ""; // the version an in-progress or failed update was for — carried into the fallback banner's text/link

autoUpdater.on("update-available", (info) => {
  currentlyKnownUpdateVersion = info.version;
  broadcastToAllWindows("agent:update-status", { state: "downloading", percent: 0 });
});

autoUpdater.on("download-progress", (progress) => {
  broadcastToAllWindows("agent:update-status", { state: "downloading", percent: Math.round(progress.percent) });
});

autoUpdater.on("update-downloaded", (info) => {
  updateReadyToInstall = true;
  broadcastToAllWindows("agent:update-status", { state: "ready", version: info.version });
});

autoUpdater.on("error", (err) => {
  // Same failure posture as the rest of this app's best-effort background
  // work (cloud sync, the update check itself) — logged, never thrown at
  // the user, and here specifically it degrades to the exact banner this
  // feature is replacing rather than leaving the UI stuck on "downloading".
  console.warn("[autoUpdater] update failed:", err);
  broadcastToAllWindows("agent:update-status", { state: "fallback", version: currentlyKnownUpdateVersion });
});

app.on("before-quit", (event) => {
  if (updateReadyToInstall && !installingForUpdate) {
    event.preventDefault();
    installingForUpdate = true;
    autoUpdater.quitAndInstall();
  }
});

autoUpdater.checkForUpdates().catch((err) => {
  console.warn("[autoUpdater] checkForUpdates() threw:", err);
});

// Re-check periodically — the app may stay open for days. Skipped rather
// than re-triggered while a download is already pending or complete, so a
// long-running session can't double-download or re-fire "ready" for the
// version it already has staged.
setInterval(() => {
  if (!updateReadyToInstall) autoUpdater.checkForUpdates().catch((err) => console.warn("[autoUpdater] periodic check failed:", err));
}, 4 * 60 * 60 * 1000);
```

(`currentlyKnownUpdateVersion` is tracked from the existing
`update-available` event's `info.version`, same value the current
notify-only banner already uses — carried through so the fallback banner's
"a new version vX is available" text and its GitHub link are identical to
what ships today.)

New IPC handler, for the "Restart Now" button:

```typescript
ipcMain.handle("agent:install-update", () => {
  if (!updateReadyToInstall || installingForUpdate) return;
  installingForUpdate = true;
  autoUpdater.quitAndInstall();
});
```

## IPC / preload

`agent:update-available` (today's single `{version}` payload) is replaced
by a richer `agent:update-status` broadcast, matching the state machine
above:

```typescript
type UpdateStatus =
  | { state: "downloading"; percent: number }
  | { state: "ready"; version: string }
  | { state: "fallback"; version: string };
```

`preload.cjs`:

```javascript
onUpdateStatus: (callback) => {
  const listener = (_event, status) => callback(status);
  ipcRenderer.on("agent:update-status", listener);
  return () => ipcRenderer.removeListener("agent:update-status", listener);
},
installUpdate: () => ipcRenderer.invoke("agent:install-update"),
```

## Renderer (`renderer.ts` + the existing `#update-banner` markup)

The existing banner (`#update-banner` / `#update-banner-text` /
`#update-banner-link` / `#update-banner-dismiss`) gains one more element, a
restart button, and its content is driven by `onUpdateStatus` instead of
the old `onUpdateAvailable`:

```typescript
window.agent.onUpdateStatus((status) => {
  if (status.state === "downloading") {
    updateBannerText.textContent = `Downloading update… (${status.percent}%)`;
    updateBannerRestartBtn.hidden = true;
    updateBannerLink.hidden = true;
  } else if (status.state === "ready") {
    updateBannerText.textContent = `Update v${status.version} ready.`;
    updateBannerRestartBtn.hidden = false;
    updateBannerLink.hidden = true;
  } else {
    // fallback — identical to today's only behavior
    updateBannerText.textContent = `A new version (v${status.version}) is available.`;
    updateBannerLink.href = `https://github.com/lavuchandu169/localagent/releases/tag/v${status.version}`;
    updateBannerRestartBtn.hidden = true;
    updateBannerLink.hidden = false;
  }
  updateBanner.hidden = false;
});

updateBannerRestartBtn.addEventListener("click", () => {
  void window.agent.installUpdate();
});
```

Dismiss keeps its exact current behavior — it hides the banner only; it
never cancels a background download or un-schedules the pending
`quitAndInstall()` on next quit, since the state that matters
(`updateReadyToInstall`) lives in the main process, not the DOM. "Later"
is nothing more than not clicking Restart — the update still applies
itself the next time the user quits normally.

## Build pipeline — a required fix, not polish

electron-updater's Mac updater applies an update from a `.zip` build
artifact, never from a `.dmg` — the DMG is only ever used for the first
manual install. `package.json`'s `build.mac.target` today lists only
`dmg`, so **Mac auto-update cannot function at all until this changes**,
independent of the signing question:

```json
"mac": {
  "target": [
    { "target": "dmg", "arch": ["arm64"] },
    { "target": "zip", "arch": ["arm64"] }
  ]
}
```

electron-builder publishes the `.zip` alongside the existing `.dmg` and
extends `latest-mac.yml` to reference it automatically — no other build
config changes needed. Windows needs no target change: the existing NSIS
`oneClick: true` (implicit default, unchanged) already produces a fast,
mostly-invisible installer UI; `quitAndInstall()`'s default (non-silent)
call works with it as-is.

## Error handling

- Every failure — a failed check, a failed download, a failed apply —
  lands on the `fallback` state, which is byte-for-byte today's existing
  banner. A user on an unsigned Mac build in the worst case sees exactly
  what they see today, never worse.
- `error` events are logged via `console.warn`, matching this app's
  existing treatment of every other best-effort background operation
  (cloud sync, the pre-existing update check) — not surfaced as a blocking
  dialog.
- The `before-quit` guard (`installingForUpdate`) exists specifically so
  `quitAndInstall()` — which itself calls `app.quit()` — can't re-enter
  the same `before-quit` handler and loop.

## Testing

`electron-updater`'s `autoUpdater` is the Electron-API boundary this
feature is built on (same category as `dialog`, `BrowserWindow` elsewhere
in this codebase) — real unit tests mock that one boundary and verify the
state machine around it: `update-available` → `downloading` broadcast;
`download-progress` → percent passed through; `update-downloaded` →
`ready` broadcast and `updateReadyToInstall` set; `error` at any stage →
`fallback` broadcast with the last known version; the periodic re-check
timer is skipped while `updateReadyToInstall` is true; the `before-quit`
handler calls `quitAndInstall()` exactly once even if `before-quit` fires
more than once.

What real unit tests cannot cover — actual Gatekeeper/SmartScreen/UAC
behavior, and whether electron-updater's Mac updater actually accepts an
unsigned update — needs a real install of a real build, which isn't
achievable in an automated/sandboxed test. That becomes a one-time manual
verification checklist after this ships: install the current beta,
publish the next beta, confirm the running old instance downloads it,
offers a restart, and comes back up as the new version on both a Mac and
a Windows machine — documented as a checklist rather than skipped
silently.

## Out of scope

- Actually obtaining/wiring code-signing credentials (Apple Developer ID,
  notarization, a Windows certificate) — a separate follow-up once those
  are in hand; this design requires no changes to adopt them beyond CI
  secrets and electron-builder's standard signing config.
- Update channels (stable vs. beta) — everything ships as a prerelease
  today; no split proposed.
- Delta/differential updates — every update downloads the full new build,
  same as electron-updater's default and no different from today's manual
  download.
- Changing `release.yml`'s `prerelease` flag or release cadence.
