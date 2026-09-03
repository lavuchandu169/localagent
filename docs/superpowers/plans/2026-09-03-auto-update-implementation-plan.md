# Automatic Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace today's notify-only update banner (a link to GitHub the user has to click, download, and install by hand) with a background auto-download and one-click restart-to-install flow, on top of this app's current unsigned builds.

**Architecture:** A new pure, testable `updateManager.ts` module wraps `electron-updater`'s `autoUpdater` behind a small state machine (`downloading` → `ready` → installed, with a `fallback` state reachable from any failure). `main.ts` becomes a thin wiring layer that constructs the real dependencies and hands them to it, exactly like this app's existing `attachments.ts`-vs-`main.ts` split. The renderer's existing `#update-banner` grows from a single static message into three states driven by the same broadcast.

**Tech Stack:** Electron, `electron-updater` (already a dependency), `electron-builder` (already a dependency), this project's hand-rolled `check()`-based test harness (no test framework).

**Spec:** docs/superpowers/specs/2026-09-03-auto-update-design.md

## Global Constraints

- Update checks (initial and periodic) run only in packaged builds (`app.isPackaged`) — a from-source `npm run electron` run must be completely unaffected, matching today's exact guard.
- `autoUpdater.allowPrerelease` stays `true` — every release on this project ships as a GitHub prerelease.
- Every failure (a failed check, a failed download, a failed install) must land the UI on the exact same banner state that ships today ("a new version vX is available" + a manual link to the GitHub release) — this feature is only allowed to add capability, never regress below current behavior.
- The `before-quit` guard must not loop: `autoUpdater.quitAndInstall()` itself closes all windows and then re-fires `before-quit` — the guard flag must let that second firing proceed rather than re-entering.
- Periodic re-checks must not fire while a download is already pending or complete — no double-downloading, no re-firing "ready" for a version already staged.
- No code signing, no certificate/credential wiring, no change to `release.yml`'s `prerelease` flag — explicitly out of scope for this plan.

---

### Task 1: The update-manager core (pure, testable)

**Files:**
- Create: `src/electron/updateManager.ts`
- Create: `src/test/updateManager.test.ts`
- Modify: `package.json` (`test` script)

**Interfaces:**
- Produces: `AutoUpdaterLike` (the minimal structural shape `main.ts`'s real `autoUpdater` singleton satisfies), `UpdateStatus` (discriminated union), `UpdateManagerDeps`, `UpdateManager`, and `wireAutoUpdater(deps: UpdateManagerDeps): UpdateManager`, all exported from `src/electron/updateManager.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/test/updateManager.test.ts`:

```typescript
import { wireAutoUpdater, type AutoUpdaterLike, type UpdateStatus } from "../electron/updateManager.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

/**
 * A hand-rolled fake of the real electron-updater `autoUpdater` singleton —
 * just enough surface (`on`, `checkForUpdates`, `quitAndInstall`, the two
 * settable properties) for wireAutoUpdater to drive, plus an `emit` this
 * test uses to trigger the handlers wireAutoUpdater registered. `listener`
 * is typed `(...args: any[]) => void` rather than `unknown[]` deliberately —
 * TypeScript's structural check against AutoUpdaterLike's per-event
 * overloads only accepts the wider `any[]` form here.
 */
function createFakeAutoUpdater() {
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  let quitAndInstallCalls = 0;
  let checkForUpdatesCalls = 0;
  const fake: AutoUpdaterLike & {
    emit: (event: string, ...args: unknown[]) => void;
    quitAndInstallCallCount: () => number;
    checkForUpdatesCallCount: () => number;
  } = {
    allowPrerelease: false,
    autoDownload: false,
    on(event: string, listener: (...args: any[]) => void) {
      (listeners[event] ??= []).push(listener);
      return fake;
    },
    checkForUpdates: async () => {
      checkForUpdatesCalls++;
      return null;
    },
    quitAndInstall: () => {
      quitAndInstallCalls++;
    },
    emit(event: string, ...args: unknown[]) {
      for (const l of listeners[event] ?? []) l(...args);
    },
    quitAndInstallCallCount: () => quitAndInstallCalls,
    checkForUpdatesCallCount: () => checkForUpdatesCalls,
  };
  return fake;
}

console.log("wireAutoUpdater — state machine:");
{
  const fakeUpdater = createFakeAutoUpdater();
  const statuses: UpdateStatus[] = [];
  const beforeQuitHandlerRef: { current: ((event: { preventDefault: () => void }) => void) | null } = { current: null };

  const manager = wireAutoUpdater({
    autoUpdater: fakeUpdater,
    broadcast: (s) => statuses.push(s),
    onBeforeQuit: (h) => {
      beforeQuitHandlerRef.current = h;
    },
    setIntervalFn: () => 0,
  });

  check("allowPrerelease is set to true on wiring", fakeUpdater.allowPrerelease === true);
  check("autoDownload is set to true on wiring", fakeUpdater.autoDownload === true);
  check("checkForUpdates is called once immediately on wiring", fakeUpdater.checkForUpdatesCallCount() === 1);

  fakeUpdater.emit("update-available", { version: "1.2.3" });
  check("update-available broadcasts a downloading status at 0%", JSON.stringify(statuses[0]) === JSON.stringify({ state: "downloading", percent: 0 }));

  fakeUpdater.emit("download-progress", { percent: 55.4 });
  check("download-progress broadcasts a downloading status with the rounded percent", JSON.stringify(statuses[1]) === JSON.stringify({ state: "downloading", percent: 55 }));

  fakeUpdater.emit("update-downloaded", { version: "1.2.3" });
  check("update-downloaded broadcasts a ready status with the version", JSON.stringify(statuses[2]) === JSON.stringify({ state: "ready", version: "1.2.3" }));

  manager.installUpdate();
  check("installUpdate() calls quitAndInstall when an update is ready", fakeUpdater.quitAndInstallCallCount() === 1);

  manager.installUpdate();
  check("a second installUpdate() call is a no-op (already installing)", fakeUpdater.quitAndInstallCallCount() === 1);

  let prevented = false;
  if (beforeQuitHandlerRef.current) beforeQuitHandlerRef.current({ preventDefault: () => (prevented = true) });
  check("before-quit does NOT prevent default once installUpdate() already started installing", prevented === false);
}

console.log("\nwireAutoUpdater — natural quit before Restart Now is clicked:");
{
  const fakeUpdater = createFakeAutoUpdater();
  const beforeQuitHandlerRef: { current: ((event: { preventDefault: () => void }) => void) | null } = { current: null };

  wireAutoUpdater({
    autoUpdater: fakeUpdater,
    broadcast: () => {},
    onBeforeQuit: (h) => {
      beforeQuitHandlerRef.current = h;
    },
    setIntervalFn: () => 0,
  });

  fakeUpdater.emit("update-downloaded", { version: "9.9.9" });

  let prevented1 = false;
  if (beforeQuitHandlerRef.current) beforeQuitHandlerRef.current({ preventDefault: () => (prevented1 = true) });
  check("the first before-quit (a real user quit) is prevented so quitAndInstall can run first", prevented1 === true);
  check("quitAndInstall is called exactly once from that first before-quit", fakeUpdater.quitAndInstallCallCount() === 1);

  // electron-updater's real quitAndInstall() closes all windows and then
  // re-fires before-quit itself — this must NOT be treated as a second
  // real quit request and must NOT call quitAndInstall again.
  let prevented2 = false;
  if (beforeQuitHandlerRef.current) beforeQuitHandlerRef.current({ preventDefault: () => (prevented2 = true) });
  check("the second (re-entrant) before-quit is allowed through, not prevented again", prevented2 === false);
  check("quitAndInstall is still only called once after the re-entrant before-quit", fakeUpdater.quitAndInstallCallCount() === 1);
}

console.log("\nwireAutoUpdater — errors fall back, never get stuck:");
{
  const fakeUpdater = createFakeAutoUpdater();
  const statuses: UpdateStatus[] = [];

  wireAutoUpdater({
    autoUpdater: fakeUpdater,
    broadcast: (s) => statuses.push(s),
    onBeforeQuit: () => {},
    setIntervalFn: () => 0,
  });

  fakeUpdater.emit("update-available", { version: "2.0.0" });
  fakeUpdater.emit("error", new Error("network blip"));
  const last = statuses[statuses.length - 1];
  check("an error after update-available falls back with that same version", JSON.stringify(last) === JSON.stringify({ state: "fallback", version: "2.0.0" }));
}

console.log("\nwireAutoUpdater — periodic re-check:");
{
  const fakeUpdater = createFakeAutoUpdater();
  let scheduledCallback: (() => void) | null = null;
  let scheduledMs: number | null = null;

  wireAutoUpdater({
    autoUpdater: fakeUpdater,
    broadcast: () => {},
    onBeforeQuit: () => {},
    checkIntervalMs: 999,
    setIntervalFn: (cb, ms) => {
      scheduledCallback = cb;
      scheduledMs = ms;
      return 0;
    },
  });

  check("the interval is scheduled at the configured checkIntervalMs", scheduledMs === 999);
  check("checkForUpdates was called once already (the initial check)", fakeUpdater.checkForUpdatesCallCount() === 1);

  if (scheduledCallback) (scheduledCallback as () => void)();
  check("firing the interval re-checks when no update is pending", fakeUpdater.checkForUpdatesCallCount() === 2);

  fakeUpdater.emit("update-downloaded", { version: "3.0.0" });
  if (scheduledCallback) (scheduledCallback as () => void)();
  check("firing the interval again does NOT re-check once an update is ready", fakeUpdater.checkForUpdatesCallCount() === 2);
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node dist/test/updateManager.test.js`
Expected: FAIL — `src/electron/updateManager.ts` doesn't exist yet, so the build itself fails with "Cannot find module '../electron/updateManager.js'".

- [ ] **Step 3: Write `src/electron/updateManager.ts`**

```typescript
export interface AutoUpdaterLike {
  allowPrerelease: boolean;
  autoDownload: boolean;
  on(event: "update-available", listener: (info: { version: string }) => void): unknown;
  on(event: "download-progress", listener: (progress: { percent: number }) => void): unknown;
  on(event: "update-downloaded", listener: (info: { version: string }) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

export type UpdateStatus =
  | { state: "downloading"; percent: number }
  | { state: "ready"; version: string }
  | { state: "fallback"; version: string };

export interface UpdateManagerDeps {
  autoUpdater: AutoUpdaterLike;
  broadcast: (status: UpdateStatus) => void;
  /** Registers a handler that runs when Electron's `app` fires `before-quit` — kept as an injected function (not a direct `app.on` call) so this module stays Electron-app-free and testable. */
  onBeforeQuit: (handler: (event: { preventDefault: () => void }) => void) => void;
  /** How often to re-check for an update while the app stays open. Defaults to 4 hours; overridable for tests. */
  checkIntervalMs?: number;
  /** Injectable in place of the real `setInterval` so tests can capture and manually fire the scheduled callback instead of waiting on a real timer. */
  setIntervalFn?: (callback: () => void, ms: number) => unknown;
}

export interface UpdateManager {
  /** Applies a downloaded update immediately — the "Restart Now" button's handler. A no-op if no update is ready yet, or one is already installing. */
  installUpdate: () => void;
}

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

/**
 * Wires electron-updater's autoUpdater (or, in tests, a fake shaped like
 * one) into this app's downloading → ready → installed state machine.
 * Every failure — a failed check, a failed download, a failed install —
 * broadcasts the same `fallback` state so the UI never gets stuck: it
 * degrades to today's existing "here's a manual link" banner instead.
 */
export function wireAutoUpdater(deps: UpdateManagerDeps): UpdateManager {
  const { autoUpdater, broadcast, onBeforeQuit } = deps;
  const intervalMs = deps.checkIntervalMs ?? FOUR_HOURS_MS;
  const scheduleInterval = deps.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));

  autoUpdater.allowPrerelease = true;
  autoUpdater.autoDownload = true;

  let updateReadyToInstall = false;
  let installingForUpdate = false;
  let currentlyKnownUpdateVersion = "";

  autoUpdater.on("update-available", (info) => {
    currentlyKnownUpdateVersion = info.version;
    broadcast({ state: "downloading", percent: 0 });
  });

  autoUpdater.on("download-progress", (progress) => {
    broadcast({ state: "downloading", percent: Math.round(progress.percent) });
  });

  autoUpdater.on("update-downloaded", (info) => {
    updateReadyToInstall = true;
    currentlyKnownUpdateVersion = info.version;
    broadcast({ state: "ready", version: info.version });
  });

  autoUpdater.on("error", (err) => {
    // Same failure posture as this app's other best-effort background work
    // (cloud sync, the update check itself) — logged, never surfaced as a
    // blocking error, and here specifically it degrades to the exact
    // banner this feature is layered on top of.
    console.warn("[autoUpdater] update failed:", err);
    broadcast({ state: "fallback", version: currentlyKnownUpdateVersion });
  });

  // autoUpdater.quitAndInstall() itself closes every window and THEN
  // re-fires before-quit — the installingForUpdate guard is what lets that
  // second, re-entrant firing proceed instead of preventing default again
  // and looping forever.
  onBeforeQuit((event) => {
    if (updateReadyToInstall && !installingForUpdate) {
      event.preventDefault();
      installingForUpdate = true;
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.checkForUpdates().catch((err) => {
    console.warn("[autoUpdater] checkForUpdates() threw:", err);
  });

  scheduleInterval(() => {
    if (!updateReadyToInstall) {
      autoUpdater.checkForUpdates().catch((err) => console.warn("[autoUpdater] periodic check failed:", err));
    }
  }, intervalMs);

  return {
    installUpdate: () => {
      if (!updateReadyToInstall || installingForUpdate) return;
      installingForUpdate = true;
      autoUpdater.quitAndInstall();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node dist/test/updateManager.test.js`
Expected: PASS — every `check` line prints `ok`.

- [ ] **Step 5: Wire the new test file into `package.json`'s `test` script**

In `package.json`, the `"test"` script is a single `&&`-chained line ending in
`... && node dist/test/attachments.test.js && node dist/test/openaiCompatible.test.js`.
Append ` && node dist/test/updateManager.test.js` to the end of that line.

- [ ] **Step 6: Run the full suite to confirm nothing else broke**

Run: `npm test`
Expected: `All tests passed.` at the end, with `updateManager.test.js`'s own `ok` lines visible in the output.

- [ ] **Step 7: Commit**

```bash
git add src/electron/updateManager.ts src/test/updateManager.test.ts package.json
git commit -m "feat: a testable state machine for the auto-update flow"
```

---

### Task 2: Wire the real app into it — main.ts + preload.cjs

**Files:**
- Modify: `src/electron/main.ts`
- Modify: `src/electron/preload.cjs`

**Interfaces:**
- Consumes: `wireAutoUpdater`, `UpdateStatus` from `src/electron/updateManager.js` (Task 1).
- Produces: a new `agent:install-update` IPC channel (no args, no return value); `agent:update-status` replaces `agent:update-available` as the broadcast channel, carrying `UpdateStatus`.

Note for whoever reads the spec alongside this: the spec's "Main process changes" section shows the state machine as inline code for readability. What actually gets built is the extraction below — `main.ts` constructs the real dependencies and hands them to Task 1's `wireAutoUpdater` — because the spec's own Testing section commits to unit-testing the state machine by mocking the `autoUpdater` boundary, which is only possible once that logic lives in its own module. Same behavior, same events, same guard logic; just where it lives differs from the spec's illustration.

- [ ] **Step 1: Replace the notify-only `autoUpdater` block in `main.ts`**

Find this block (inside `app.whenReady().then(() => { ... })`, right after the `showOpenDialog` helper function and its closing brace):

```typescript
  // Checks GitHub Releases once per launch for a newer version and lets the
  // renderer show an in-app banner pointing at it. Deliberately notify-only,
  // not a full silent download-and-install: electron-updater's actual
  // update-apply step (Squirrel.Mac) generally requires a signed app on
  // macOS, and this app isn't signed yet — attempting a real auto-install
  // now would likely fail silently on Mac specifically, which is worse
  // than no auto-updater at all. autoDownload stays false for that reason;
  // revisit once code signing lands. Only runs in a packaged app — electron
  // -builder only generates the app-update.yml this needs for a real
  // build, so a from-source `npm run electron` has nothing to check
  // against and would just log a harmless error every launch otherwise.
  if (app.isPackaged) {
    autoUpdater.allowPrerelease = true; // every release here is tagged "prerelease" on GitHub — without this, updater finds nothing
    autoUpdater.autoDownload = false;
    autoUpdater.on("update-available", (info) => {
      broadcastToAllWindows("agent:update-available", { version: info.version });
    });
    autoUpdater.on("error", (err) => {
      // Best-effort, same failure posture as cloud sync's own handling — a
      // failed update check is logged, never surfaced as an error to the user.
      console.warn("[autoUpdater] update check failed:", err);
    });
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn("[autoUpdater] checkForUpdates() threw:", err);
    });
  }
```

Replace it with:

```typescript
  // Auto-downloads a newer release in the background and offers a one-click
  // restart to apply it, on top of today's still-unsigned builds — see
  // docs/superpowers/specs/2026-09-03-auto-update-design.md for why that's
  // a real constraint and not just a note: every failure path here degrades
  // to the exact "here's a manual GitHub link" banner this replaces, so an
  // unsigned Mac build in the worst case behaves exactly like it does
  // today, never worse. Only runs in a packaged app — electron-builder only
  // generates the app-update.yml this needs for a real build, so a
  // from-source `npm run electron` has nothing to check against and would
  // just log a harmless error every launch otherwise.
  let updateManager: UpdateManager | null = null;
  if (app.isPackaged) {
    updateManager = wireAutoUpdater({
      autoUpdater,
      broadcast: (status) => broadcastToAllWindows("agent:update-status", status),
      onBeforeQuit: (handler) => app.on("before-quit", handler),
    });
  }
```

Add the import for `wireAutoUpdater` and its `UpdateManager` type near the top of the file, alongside the other local-module imports (right after the `import { readAttachment, type PickedAttachment } from "./attachments.js";` line):

```typescript
import { wireAutoUpdater, type UpdateManager } from "./updateManager.js";
```

- [ ] **Step 2: Add the `agent:install-update` IPC handler**

Right after the block from Step 1 (still inside `app.whenReady().then(...)`, before `let scopeWarningSent = false;`), add:

```typescript
  ipcMain.handle("agent:install-update", () => {
    updateManager?.installUpdate();
  });
```

- [ ] **Step 3: Update `preload.cjs`**

Find:

```javascript
  onUpdateAvailable: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on("agent:update-available", listener);
    return () => ipcRenderer.removeListener("agent:update-available", listener);
  },
```

Replace with:

```javascript
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("agent:update-status", listener);
    return () => ipcRenderer.removeListener("agent:update-status", listener);
  },
  installUpdate: () => ipcRenderer.invoke("agent:install-update"),
```

- [ ] **Step 4: Run the build to confirm everything type-checks**

Run: `npm run build`
Expected: succeeds with no errors. (`main.ts`'s changes are Electron-glue and get no automated test of their own here — Task 1's `updateManager.test.ts` already covers the state-machine logic this wiring delegates to, matching how `attachments.ts`'s pure logic is unit-tested while its `main.ts` IPC wrapper isn't.)

- [ ] **Step 5: Run the full suite to confirm nothing broke**

Run: `npm test`
Expected: `All tests passed.`

- [ ] **Step 6: Commit**

```bash
git add src/electron/main.ts src/electron/preload.cjs
git commit -m "feat: auto-download updates in the background, add the restart-to-install IPC channel"
```

---

### Task 3: The banner UI — three states instead of one

**Files:**
- Modify: `src/electron/renderer/index.html`
- Modify: `src/electron/renderer/renderer.ts`
- Modify: `src/electron/renderer/styles.css`

**Interfaces:**
- Consumes: `window.agent.onUpdateStatus(callback)`, `window.agent.installUpdate()` (Task 2's preload bridge), `UpdateStatus` shape (Task 1: `{state:"downloading",percent} | {state:"ready",version} | {state:"fallback",version}`).

- [ ] **Step 1: Add the restart button to `index.html`**

Find:

```html
        <div id="update-banner" hidden>
          <span id="update-banner-text"></span>
          <a id="update-banner-link" href="#" target="_blank" rel="noopener">View release</a>
          <button id="update-banner-dismiss" type="button" title="Dismiss" aria-label="Dismiss update notice">×</button>
        </div>
```

Replace with:

```html
        <div id="update-banner" hidden>
          <span id="update-banner-text"></span>
          <a id="update-banner-link" href="#" target="_blank" rel="noopener">View release</a>
          <button id="update-banner-restart" type="button" hidden>Restart Now</button>
          <button id="update-banner-dismiss" type="button" title="Dismiss" aria-label="Dismiss update notice">×</button>
        </div>
```

- [ ] **Step 2: Style the restart button in `styles.css`**

Find:

```css
#update-banner-link:hover {
  text-decoration: underline;
}
```

Add right after it:

```css
#update-banner-restart {
  background: var(--accent);
  color: var(--bg);
  border: none;
  border-radius: 4px;
  padding: 3px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  font-family: var(--font-sans);
}

#update-banner-restart:hover {
  opacity: 0.9;
}

#update-banner-restart[hidden] {
  display: none;
}
```

- [ ] **Step 3: Replace the update-banner wiring in `renderer.ts`**

Find the `AgentBridge` interface entry:

```typescript
  onUpdateAvailable(callback: (info: { version: string }) => void): () => void;
```

Replace with:

```typescript
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
  installUpdate(): Promise<void>;
```

Add the type import — find the existing `import type { PickedAttachment } from "../attachments.js";` line and add right after it:

```typescript
import type { UpdateStatus } from "../updateManager.js";
```

Find the `byId` block that declares the update-banner elements:

```typescript
const updateBanner = byId<HTMLDivElement>("update-banner");
const updateBannerText = byId<HTMLSpanElement>("update-banner-text");
const updateBannerLink = byId<HTMLAnchorElement>("update-banner-link");
const updateBannerDismiss = byId<HTMLButtonElement>("update-banner-dismiss");
```

Add the new button right after:

```typescript
const updateBanner = byId<HTMLDivElement>("update-banner");
const updateBannerText = byId<HTMLSpanElement>("update-banner-text");
const updateBannerLink = byId<HTMLAnchorElement>("update-banner-link");
const updateBannerRestartBtn = byId<HTMLButtonElement>("update-banner-restart");
const updateBannerDismiss = byId<HTMLButtonElement>("update-banner-dismiss");
```

Find:

```typescript
updateBannerDismiss.addEventListener("click", () => {
  updateBanner.hidden = true;
});

window.agent.onUpdateAvailable((info) => {
  updateBannerText.textContent = `A new version (v${info.version}) is available.`;
  updateBannerLink.href = `https://github.com/lavuchandu169/localagent/releases/tag/v${info.version}`;
  updateBanner.hidden = false;
});
```

Replace with:

```typescript
updateBannerDismiss.addEventListener("click", () => {
  // Hides the banner only — a background download in progress keeps
  // downloading, and an already-downloaded update still applies itself on
  // the next natural quit either way. Dismiss is a view-layer action; the
  // state that matters lives in the main process, not the DOM.
  updateBanner.hidden = true;
});

updateBannerRestartBtn.addEventListener("click", () => {
  void window.agent.installUpdate();
});

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
    // fallback — identical to this banner's only behavior before this feature existed
    updateBannerText.textContent = `A new version (v${status.version}) is available.`;
    updateBannerLink.href = `https://github.com/lavuchandu169/localagent/releases/tag/v${status.version}`;
    updateBannerRestartBtn.hidden = true;
    updateBannerLink.hidden = false;
  }
  updateBanner.hidden = false;
});
```

- [ ] **Step 4: Run the build to confirm everything type-checks**

Run: `npm run build`
Expected: succeeds with no errors.

- [ ] **Step 5: Run the full suite to confirm nothing broke**

Run: `npm test`
Expected: `All tests passed.` (renderer UI changes get no automated test of their own — this project's consistent treatment of Electron renderer code, same as the rest of this banner's history and Task 7 of the file-upload plan.)

- [ ] **Step 6: Live-verify the three banner states**

This can't be driven by `window.agent` directly (there's no real update server to point a dev build at), so verify by temporarily monkey-patching the bridge from the DevTools console of a running `npm run electron` session, one state at a time — confirm each one visually, then move to the next:

```javascript
// Downloading state:
window.agent.onUpdateStatus.toString(); // (sanity check the bridge exists)
document.getElementById("update-banner").hidden = false;
document.getElementById("update-banner-text").textContent = "Downloading update… (42%)";
document.getElementById("update-banner-restart").hidden = true;
document.getElementById("update-banner-link").hidden = true;

// Ready state:
document.getElementById("update-banner-text").textContent = "Update v0.1.0-beta.99 ready.";
document.getElementById("update-banner-restart").hidden = false;
document.getElementById("update-banner-link").hidden = true;

// Fallback state (today's exact original look):
document.getElementById("update-banner-text").textContent = "A new version (v0.1.0-beta.99) is available.";
document.getElementById("update-banner-restart").hidden = true;
document.getElementById("update-banner-link").hidden = false;
```

Confirm all three render legibly (button placement, text truncation at narrow window widths, dismiss still works in every state), then close the dev app without saving any of this — it's a manual visual check, not a code change.

- [ ] **Step 7: Commit**

```bash
git add src/electron/renderer/index.html src/electron/renderer/renderer.ts src/electron/renderer/styles.css
git commit -m "feat: a three-state update banner — downloading, ready to restart, or manual fallback"
```

---

### Task 4: The Mac build needs a zip artifact to auto-update at all

**Files:**
- Modify: `package.json` (`build.mac.target`)

**Interfaces:**
- None — this is a packaging-config-only change; nothing in the codebase imports from it.

- [ ] **Step 1: Add the `zip` target alongside the existing `dmg` target**

In `package.json`, find:

```json
  "mac": {
    "category": "public.app-category.developer-tools",
    "icon": "src/electron/renderer/icon-512.png",
    "target": [
      {
        "target": "dmg",
        "arch": [
          "arm64"
        ]
      }
    ]
  },
```

Replace with:

```json
  "mac": {
    "category": "public.app-category.developer-tools",
    "icon": "src/electron/renderer/icon-512.png",
    "target": [
      {
        "target": "dmg",
        "arch": [
          "arm64"
        ]
      },
      {
        "target": "zip",
        "arch": [
          "arm64"
        ]
      }
    ]
  },
```

electron-updater's Mac updater applies an update from a `.zip` artifact — never from a `.dmg`, which is only ever used for the first manual install. Without this, `wireAutoUpdater`'s `checkForUpdates()`/download step (Tasks 1-2) has nothing to actually download on Mac and will hit the `error` → `fallback` path every time, regardless of signing status.

- [ ] **Step 2: Live-verify both artifacts actually get built**

This is a real packaging step, not something a unit test can cover, and this environment is macOS — run it for real:

Run: `npm run package:mac`
Expected: succeeds, and `release/` contains both `localagent-<version>-arm64.dmg` (as before) and a new `.zip` file (electron-builder's default Mac zip naming, e.g. `localagent-<version>-arm64-mac.zip`). List the directory to confirm:

```bash
ls -la release/ | grep -E '\.(dmg|zip)$'
```

Both extensions must be present. If only the `.dmg` appears, the target list in Step 1 didn't take — re-check the JSON syntax (a missing comma is the most likely cause) before proceeding.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "fix: publish a zip artifact for Mac so electron-updater has something to auto-update from"
```

---

## Post-implementation note for the human

Everything above ships and tests cleanly, but the two OS-level unknowns the
spec flagged up front — whether electron-updater's Mac updater actually
accepts applying an update to an unsigned/non-notarized app, and exactly
what Windows' UAC prompt looks like when triggered this way — can only be
confirmed by really installing a build and shipping a newer one. After this
plan's changes ship in the next beta, verify once, for real:

1. Install the current beta on a Mac.
2. Publish the next beta.
3. Confirm the running old instance's banner goes `downloading` → `ready`,
   click Restart Now, and confirm it relaunches as the new version. If it
   instead falls back to the manual-link banner, that's the known unsigned-
   Mac limitation the spec called out — not a bug in this plan.
4. Repeat on a Windows machine, noting whether an "Unknown Publisher"
   prompt appears during install (expected, not fixable without signing).
