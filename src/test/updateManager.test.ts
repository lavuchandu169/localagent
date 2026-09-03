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
  check("before-quit does NOT prevent default once installUpdate() already started installing", (prevented as boolean) === false);
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
  const event1: { preventDefault: () => void } = { preventDefault: () => { prevented1 = true; } };
  if (beforeQuitHandlerRef.current) beforeQuitHandlerRef.current(event1);
  check("the first before-quit (a real user quit) is prevented so quitAndInstall can run first", (prevented1 as boolean) === true);
  check("quitAndInstall is called exactly once from that first before-quit", fakeUpdater.quitAndInstallCallCount() === 1);

  // electron-updater's real quitAndInstall() closes all windows and then
  // re-fires before-quit itself — this must NOT be treated as a second
  // real quit request and must NOT call quitAndInstall again.
  let prevented2 = false;
  const event2: { preventDefault: () => void } = { preventDefault: () => { prevented2 = true; } };
  if (beforeQuitHandlerRef.current) beforeQuitHandlerRef.current(event2);
  check("the second (re-entrant) before-quit is allowed through, not prevented again", (prevented2 as boolean) === false);
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
