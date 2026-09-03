export interface AutoUpdaterLike {
  allowPrerelease: boolean;
  autoDownload: boolean;
  on(event: "update-available", listener: (info: { version: string }) => void): unknown;
  on(event: "download-progress", listener: (progress: { percent: number }) => void): unknown;
  on(event: "update-downloaded", listener: (info: { version: string; downloadedFile?: string }) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

export type UpdateStatus =
  | { state: "downloading"; percent: number }
  | { state: "ready"; version: string }
  /** canOpenDownloadedFile is true only when a real download completed (update-downloaded fired with a real downloadedFile path) before whatever failed — the common case on an unsigned Mac build, where the download itself succeeds but Squirrel.Mac's in-place apply step doesn't. */
  | { state: "fallback"; version: string; canOpenDownloadedFile: boolean };

export interface UpdateManagerDeps {
  autoUpdater: AutoUpdaterLike;
  broadcast: (status: UpdateStatus) => void;
  /** Registers a handler that runs when Electron's `app` fires `before-quit` — kept as an injected function (not a direct `app.on` call) so this module stays Electron-app-free and testable. */
  onBeforeQuit: (handler: (event: { preventDefault: () => void }) => void) => void;
  /**
   * Opens an already-downloaded file in its OS default handler — Electron's
   * `shell.openPath`, injected (not called directly) for the same testability
   * reason as `onBeforeQuit`. Resolves to `""` on success or an error message
   * on failure, matching `shell.openPath`'s real return shape exactly so
   * main.ts can pass it through with no wrapping.
   */
  openPath: (path: string) => Promise<string>;
  /** How often to re-check for an update while the app stays open. Defaults to 4 hours; overridable for tests. */
  checkIntervalMs?: number;
  /** Injectable in place of the real `setInterval` so tests can capture and manually fire the scheduled callback instead of waiting on a real timer. */
  setIntervalFn?: (callback: () => void, ms: number) => unknown;
}

export interface UpdateManager {
  /** Applies a downloaded update immediately — the "Restart Now" button's handler. A no-op if no update is ready yet, or one is already installing. */
  installUpdate: () => void;
  /**
   * Opens the already-downloaded update file, if one exists — the fallback
   * action for when the in-place apply step failed (e.g. Squirrel.Mac
   * rejecting an unsigned Mac build) but the real download itself
   * succeeded, so there's a real file worth opening instead of sending the
   * user back to a webpage to download the same bytes again. A no-op if
   * nothing has ever been downloaded, or a newer update-available since
   * reset that path (see downloadedFilePath below).
   */
  openDownloadedFile: () => void;
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
  const { autoUpdater, broadcast, onBeforeQuit, openPath } = deps;
  const intervalMs = deps.checkIntervalMs ?? FOUR_HOURS_MS;
  const scheduleInterval = deps.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));

  autoUpdater.allowPrerelease = true;
  autoUpdater.autoDownload = true;

  let updateReadyToInstall = false;
  let installingForUpdate = false;
  let currentlyKnownUpdateVersion = "";
  /** The real path electron-updater downloaded the update artifact to, once a download has actually completed for the CURRENT currentlyKnownUpdateVersion — reset on every fresh update-available so a stale path from a superseded version's failed attempt never leaks into a newer version's fallback state. */
  let downloadedFilePath: string | undefined;

  autoUpdater.on("update-available", (info) => {
    currentlyKnownUpdateVersion = info.version;
    downloadedFilePath = undefined;
    broadcast({ state: "downloading", percent: 0 });
  });

  autoUpdater.on("download-progress", (progress) => {
    broadcast({ state: "downloading", percent: Math.round(progress.percent) });
  });

  autoUpdater.on("update-downloaded", (info) => {
    updateReadyToInstall = true;
    currentlyKnownUpdateVersion = info.version;
    downloadedFilePath = info.downloadedFile;
    broadcast({ state: "ready", version: info.version });
  });

  autoUpdater.on("error", (err) => {
    // Same failure posture as this app's other best-effort background work
    // (cloud sync, the update check itself) — logged, never surfaced as a
    // blocking error, and here specifically it degrades to the exact
    // banner this feature is layered on top of.
    console.warn("[autoUpdater] update failed:", err);
    // A failed install attempt (e.g. Squirrel.Mac rejecting an unsigned app)
    // must not leave the app permanently unable to quit, nor permanently
    // disable the periodic re-check — reset both flags unconditionally.
    updateReadyToInstall = false;
    installingForUpdate = false;
    if (!currentlyKnownUpdateVersion) return;
    broadcast({ state: "fallback", version: currentlyKnownUpdateVersion, canOpenDownloadedFile: downloadedFilePath !== undefined });
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
    openDownloadedFile: () => {
      if (!downloadedFilePath) return;
      void openPath(downloadedFilePath).then((errorMessage) => {
        if (errorMessage) console.warn("[autoUpdater] couldn't open the downloaded update file:", errorMessage);
      });
    },
  };
}
