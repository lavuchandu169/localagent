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

/** A hand-rolled fake of the injected openPath dependency (Electron's shell.openPath shape: resolves to "" on success, an error string on failure) — records every path it was called with. */
function createFakeOpenPath() {
  const calls: string[] = [];
  const openPath = async (path: string) => {
    calls.push(path);
    return "";
  };
  return { openPath, calls };
}

console.log("wireAutoUpdater — state machine:");
{
  const fakeUpdater = createFakeAutoUpdater();
  const { openPath } = createFakeOpenPath();
  const statuses: UpdateStatus[] = [];
  const beforeQuitHandlerRef: { current: ((event: { preventDefault: () => void }) => void) | null } = { current: null };

  const manager = wireAutoUpdater({
    autoUpdater: fakeUpdater,
    broadcast: (s) => statuses.push(s),
    onBeforeQuit: (h) => {
      beforeQuitHandlerRef.current = h;
    },
    openPath,
    setIntervalFn: () => 0,
  });

  check("allowPrerelease is set to true on wiring", fakeUpdater.allowPrerelease === true);
  check("autoDownload is set to true on wiring", fakeUpdater.autoDownload === true);
  check("checkForUpdates is called once immediately on wiring", fakeUpdater.checkForUpdatesCallCount() === 1);

  fakeUpdater.emit("update-available", { version: "1.2.3" });
  check("update-available broadcasts a downloading status at 0%", JSON.stringify(statuses[0]) === JSON.stringify({ state: "downloading", percent: 0 }));

  fakeUpdater.emit("download-progress", { percent: 55.4 });
  check("download-progress broadcasts a downloading status with the rounded percent", JSON.stringify(statuses[1]) === JSON.stringify({ state: "downloading", percent: 55 }));

  fakeUpdater.emit("update-downloaded", { version: "1.2.3", downloadedFile: "/tmp/cache/localagent-1.2.3-mac.zip" });
  check("update-downloaded broadcasts a ready status with the version", JSON.stringify(statuses[2]) === JSON.stringify({ state: "ready", version: "1.2.3" }));

  manager.installUpdate();
  check("installUpdate() calls quitAndInstall when an update is ready", fakeUpdater.quitAndInstallCallCount() === 1);

  manager.installUpdate();
  check("a second installUpdate() call is a no-op (already installing)", fakeUpdater.quitAndInstallCallCount() === 1);

  let prevented = false;
  if (beforeQuitHandlerRef.current) beforeQuitHandlerRef.current({ preventDefault: () => (prevented = true) });
  check("before-quit does NOT prevent default once installUpdate() already started installing", !prevented);
}

console.log("\nwireAutoUpdater — natural quit before Restart Now is clicked:");
{
  const fakeUpdater = createFakeAutoUpdater();
  const { openPath } = createFakeOpenPath();
  const beforeQuitHandlerRef: { current: ((event: { preventDefault: () => void }) => void) | null } = { current: null };

  wireAutoUpdater({
    autoUpdater: fakeUpdater,
    broadcast: () => {},
    onBeforeQuit: (h) => {
      beforeQuitHandlerRef.current = h;
    },
    openPath,
    setIntervalFn: () => 0,
  });

  fakeUpdater.emit("update-downloaded", { version: "9.9.9" });

  let prevented1 = false;
  const event1: { preventDefault: () => void } = { preventDefault: () => { prevented1 = true; } };
  if (beforeQuitHandlerRef.current) beforeQuitHandlerRef.current(event1);
  check("the first before-quit (a real user quit) is prevented so quitAndInstall can run first", prevented1);
  check("quitAndInstall is called exactly once from that first before-quit", fakeUpdater.quitAndInstallCallCount() === 1);

  // electron-updater's real quitAndInstall() closes all windows and then
  // re-fires before-quit itself — this must NOT be treated as a second
  // real quit request and must NOT call quitAndInstall again.
  let prevented2 = false;
  const event2: { preventDefault: () => void } = { preventDefault: () => { prevented2 = true; } };
  if (beforeQuitHandlerRef.current) beforeQuitHandlerRef.current(event2);
  check("the second (re-entrant) before-quit is allowed through, not prevented again", !prevented2);
  check("quitAndInstall is still only called once after the re-entrant before-quit", fakeUpdater.quitAndInstallCallCount() === 1);
}

console.log("\nwireAutoUpdater — errors fall back, never get stuck:");
{
  const fakeUpdater = createFakeAutoUpdater();
  const { openPath } = createFakeOpenPath();
  const statuses: UpdateStatus[] = [];

  wireAutoUpdater({
    autoUpdater: fakeUpdater,
    broadcast: (s) => statuses.push(s),
    onBeforeQuit: () => {},
    openPath,
    setIntervalFn: () => 0,
  });

  fakeUpdater.emit("update-available", { version: "2.0.0" });
  fakeUpdater.emit("error", new Error("network blip"));
  const last = statuses[statuses.length - 1];
  check(
    "an error after update-available (no download ever completed) falls back with that version and canOpenDownloadedFile: false",
    JSON.stringify(last) === JSON.stringify({ state: "fallback", version: "2.0.0", canOpenDownloadedFile: false })
  );
}

{
  const fakeUpdater = createFakeAutoUpdater();
  const { openPath } = createFakeOpenPath();
  const statuses: UpdateStatus[] = [];

  wireAutoUpdater({
    autoUpdater: fakeUpdater,
    broadcast: (s) => statuses.push(s),
    onBeforeQuit: () => {},
    openPath,
    setIntervalFn: () => 0,
  });

  fakeUpdater.emit("error", new Error("offline"));
  check("an error with no prior update-available broadcasts nothing (matches today's silent behavior)", statuses.length === 0);
}

{
  // The realistic Mac scenario: update-downloaded fires (ready state, flags set),
  // then the actual apply attempt fails. The app must not get stuck refusing to quit.
  const fakeUpdater = createFakeAutoUpdater();
  const { openPath } = createFakeOpenPath();
  const beforeQuitHandlerRef: { current: ((event: { preventDefault: () => void }) => void) | null } = { current: null };

  wireAutoUpdater({
    autoUpdater: fakeUpdater,
    broadcast: () => {},
    onBeforeQuit: (h) => {
      beforeQuitHandlerRef.current = h;
    },
    openPath,
    setIntervalFn: () => 0,
  });

  fakeUpdater.emit("update-downloaded", { version: "1.0.0" });
  fakeUpdater.emit("error", new Error("squirrel rejected unsigned app"));

  let prevented = false;
  if (beforeQuitHandlerRef.current) beforeQuitHandlerRef.current({ preventDefault: () => (prevented = true) });
  check("after update-downloaded then error, the next before-quit is NOT prevented (the app can actually quit)", !prevented);
}

{
  // The same scenario must also re-enable the periodic re-check, not leave it
  // permanently disabled because updateReadyToInstall was never cleared.
  const fakeUpdater = createFakeAutoUpdater();
  const { openPath } = createFakeOpenPath();
  let scheduledCallback: (() => void) | null = null;

  wireAutoUpdater({
    autoUpdater: fakeUpdater,
    broadcast: () => {},
    onBeforeQuit: () => {},
    openPath,
    setIntervalFn: (cb) => {
      scheduledCallback = cb;
      return 0;
    },
  });

  fakeUpdater.emit("update-downloaded", { version: "1.0.0" });
  fakeUpdater.emit("error", new Error("squirrel rejected unsigned app"));

  const before = fakeUpdater.checkForUpdatesCallCount();
  if (scheduledCallback) (scheduledCallback as () => void)();
  check("after update-downloaded then error, the periodic re-check resumes (was not left permanently disabled)", fakeUpdater.checkForUpdatesCallCount() === before + 1);
}

console.log("\nwireAutoUpdater — opening the downloaded file when the in-place apply failed:");
{
  // The exact scenario this feature exists for: a real download completed
  // (update-downloaded carries a real downloadedFile path), then the
  // in-place apply step failed (e.g. Squirrel.Mac rejecting an unsigned
  // Mac build) — the fallback status must say a file CAN be opened, and
  // openDownloadedFile() must actually open that exact path.
  const fakeUpdater = createFakeAutoUpdater();
  const { openPath, calls } = createFakeOpenPath();
  const statuses: UpdateStatus[] = [];

  const manager = wireAutoUpdater({
    autoUpdater: fakeUpdater,
    broadcast: (s) => statuses.push(s),
    onBeforeQuit: () => {},
    openPath,
    setIntervalFn: () => 0,
  });

  fakeUpdater.emit("update-downloaded", { version: "1.0.0", downloadedFile: "/tmp/cache/localagent-1.0.0-mac.zip" });
  fakeUpdater.emit("error", new Error("squirrel rejected unsigned app"));

  const last = statuses[statuses.length - 1];
  check(
    "the fallback status says a downloaded file CAN be opened",
    JSON.stringify(last) === JSON.stringify({ state: "fallback", version: "1.0.0", canOpenDownloadedFile: true })
  );

  manager.openDownloadedFile();
  check("openDownloadedFile() opens the exact real downloaded file path", JSON.stringify(calls) === JSON.stringify(["/tmp/cache/localagent-1.0.0-mac.zip"]));
}

{
  // No download ever completed (e.g. the check itself failed) — nothing to
  // open, and calling openDownloadedFile() must be a harmless no-op.
  const fakeUpdater = createFakeAutoUpdater();
  const { openPath, calls } = createFakeOpenPath();

  const manager = wireAutoUpdater({
    autoUpdater: fakeUpdater,
    broadcast: () => {},
    onBeforeQuit: () => {},
    openPath,
    setIntervalFn: () => 0,
  });

  manager.openDownloadedFile();
  check("openDownloadedFile() is a no-op when nothing has ever been downloaded", calls.length === 0);
}

{
  // A stale downloaded-file path from an earlier, since-superseded update
  // attempt must not leak into a NEWER version's fallback state — a fresh
  // update-available resets it, same as it resets currentlyKnownUpdateVersion.
  const fakeUpdater = createFakeAutoUpdater();
  const { openPath, calls } = createFakeOpenPath();
  const statuses: UpdateStatus[] = [];

  const manager = wireAutoUpdater({
    autoUpdater: fakeUpdater,
    broadcast: (s) => statuses.push(s),
    onBeforeQuit: () => {},
    openPath,
    setIntervalFn: () => 0,
  });

  fakeUpdater.emit("update-downloaded", { version: "1.0.0", downloadedFile: "/tmp/cache/localagent-1.0.0-mac.zip" });
  fakeUpdater.emit("error", new Error("squirrel rejected unsigned app"));
  // A newer version is found and starts downloading — the stale 1.0.0 file
  // must no longer be treated as openable for whatever happens to 2.0.0.
  fakeUpdater.emit("update-available", { version: "2.0.0" });
  fakeUpdater.emit("error", new Error("network blip mid-download"));

  const last = statuses[statuses.length - 1];
  check(
    "a fresh update-available resets canOpenDownloadedFile until a NEW download actually completes",
    JSON.stringify(last) === JSON.stringify({ state: "fallback", version: "2.0.0", canOpenDownloadedFile: false })
  );

  manager.openDownloadedFile();
  check("openDownloadedFile() stays a no-op after the stale path was reset", calls.length === 0);
}

console.log("\nwireAutoUpdater — periodic re-check:");
{
  const fakeUpdater = createFakeAutoUpdater();
  const { openPath } = createFakeOpenPath();
  let scheduledCallback: (() => void) | null = null;
  let scheduledMs: number | null = null;

  wireAutoUpdater({
    autoUpdater: fakeUpdater,
    broadcast: () => {},
    onBeforeQuit: () => {},
    openPath,
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
