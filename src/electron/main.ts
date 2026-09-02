import { app, BrowserWindow, ipcMain, dialog, shell, crashReporter } from "electron";
// electron-updater is CommonJS; Node's ESM/CJS interop fails to statically
// detect `autoUpdater` as a named export from it (confirmed live — a plain
// `import { autoUpdater } from "electron-updater"` throws
// "Named export 'autoUpdater' not found" the instant this file loads,
// which would have crashed the app on every single launch). The default-
// import-then-destructure form Node's own error message suggests is the
// only shape that actually works here.
import electronUpdaterPkg from "electron-updater";
const { autoUpdater } = electronUpdaterPkg;
import path from "node:path";
import os from "node:os";
import fsPromises from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createSessionRegistry, startSession, runTask, respondPermission, respondPlan, cancelSession, removeSession, getLiveSessionSnapshot, updateLiveSessionSettings, getCheckpointHash, revertSessionCheckpoint, getSessionChanges } from "./sessionRegistry.js";
import type { SessionConfig, ResumePayload } from "./sessionRegistry.js";
import type { AttachedImage, AttachedText, PermissionMode } from "../types.js";
import { checkCachedModels, deleteModel } from "./modelCache.js";
import { isEmbeddedModelId } from "../models.js";
import { detectHardware, recommendModel } from "./hardwareInfo.js";
import { signInWithGoogle, signOut, getAuthStatus, getFreshAccessToken, getStoredEmail } from "./googleAuth.js";
import { loadGoogleSettings, saveGoogleSettings, resolveGoogleCredentials } from "./googleSettings.js";
import { loadAnthropicSettings, saveAnthropicSettings, resolveAnthropicApiKey } from "./anthropicSettings.js";
import { listSessions, searchSessions, loadSessionRecord, claimUnownedSessions } from "../sessionStore.js";
import { reconcileSessions, DriveScopeError } from "../cloudSync.js";
import { loadEnvFile } from "./loadEnvFile.js";
import { isSecureStorageAvailable, electronStorageCrypto } from "./secureStorage.js";
import { appendErrorLog } from "./errorLog.js";
import { readAttachment, type PickedAttachment } from "./attachments.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// app.getPath("userData") depends on the app's name having been resolved
// yet — normally read from package.json automatically, but NOT reliably
// resolved this early (before app.whenReady()): calling getPath this
// early was confirmed live to return Electron's own generic userData
// path ("Application Support/Electron") instead of this app's
// ("Application Support/localagent"), silently writing the error log
// somewhere no other part of this app's storage ever goes. Every other
// userData-based path in this file is computed safely inside
// whenReady(), where that resolution has already happened by then; this
// one can't wait that long (it needs to exist before whenReady() so
// startup-time crashes are still caught), so the name is set explicitly
// instead of relying on the timing to work out.
app.setName("localagent");

// Local-only crash/error capture — never uploaded anywhere, no external
// service or account needed (see errorLog.ts's own doc comment for why
// this doesn't need to be opt-in the way a remote crash reporter would).
// crashReporter covers native crashes (segfaults, OOM); it does NOT catch
// plain JS exceptions, which is why the process-level handlers below
// exist too — between the two, both failure classes actually get logged.
// Registered as early as possible, before anything else in this file can
// throw.
crashReporter.start({ uploadToServer: false, compress: true });
const errorLogPath = path.join(app.getPath("userData"), "error.log");

process.on("uncaughtException", (err) => {
  // Preserve Node's default "the process exits" behavior for this one —
  // registering a listener suppresses that automatically, so it's done
  // explicitly here, but only AFTER the write actually completes (app
  // state after an uncaught exception can't be trusted enough to keep
  // running, but it also can't be trusted enough to skip logging first).
  appendErrorLog(errorLogPath, { source: "main", kind: "uncaughtException", message: err.message, stack: err.stack }).finally(() =>
    app.exit(1)
  );
});

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  void appendErrorLog(errorLogPath, { source: "main", kind: "unhandledRejection", message: err.message, stack: err.stack });
});

// Picks up GOOGLE_OAUTH_CLIENT_ID/SECRET (and anything else) from a local
// .env in the project root, if present — so `npm run electron` alone works
// without manually exporting credentials into the shell first. An
// already-set environment variable always wins over the file.
loadEnvFile(process.cwd());

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1000,
    height: 720,
    backgroundColor: "#14181c",
    icon: path.join(__dirname, "renderer", "icon-512.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  return win;
}

app.whenReady().then(() => {
  const authFilePath = path.join(app.getPath("userData"), "auth.json");
  const settingsFilePath = path.join(app.getPath("userData"), "googleSettings.json");
  const anthropicSettingsFilePath = path.join(app.getPath("userData"), "anthropicSettings.json");
  const sessionsDir = path.join(app.getPath("userData"), "sessions");
  const win = createWindow();

  // The stored Google identity (including the refresh token) is encrypted
  // at rest via the OS-native credential backend (Keychain/DPAPI/libsecret)
  // wherever it's available. Falls back to a plain (still 0600-permissioned)
  // file rather than failing sign-in outright on a system with no
  // secret-service/keyring daemon running (some minimal Linux setups).
  const storageCrypto = isSecureStorageAvailable() ? electronStorageCrypto : undefined;
  if (!storageCrypto) {
    console.warn(
      "[auth] OS-native secure storage isn't available on this system — the Google identity file will be stored as plain text (0600 permissions) instead of OS-encrypted."
    );
  }

  // Broadcasts to every live window rather than a single captured `win`
  // reference: on macOS, closing the window destroys that BrowserWindow
  // without quitting the app, and app.on("activate", ...) then creates a
  // NEW window without ever updating any closed-over `win` variable. Sending
  // to a destroyed window's webContents throws, so these two notifications
  // must not depend on any single captured window reference.
  function broadcastToAllWindows(channel: string, ...args: unknown[]): void {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, ...args);
    }
  }

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

  let scopeWarningSent = false;
  function notifyScopeWarning(): void {
    if (scopeWarningSent) return;
    scopeWarningSent = true;
    broadcastToAllWindows("agent:cloud-sync-scope-warning");
  }

  const registry = createSessionRegistry(sessionsDir, {
    getAccessToken: async () => {
      const { clientId, clientSecret } = await resolveGoogleCredentials(settingsFilePath, storageCrypto);
      return getFreshAccessToken(authFilePath, clientId, clientSecret, storageCrypto);
    },
    onScopeError: notifyScopeWarning,
    getOwnerEmail: () => getStoredEmail(authFilePath, storageCrypto),
  });

  // Tracks the AbortController for whichever agent:start-session call is
  // currently in flight, so agent:cancel-download has something to abort.
  // A single slot, not a map keyed by session id, is deliberate: the
  // renderer's own Start button is disabled while starting, so only one
  // start attempt is ever actually in flight at a time — the download this
  // cancels is always "the one currently starting up," not any particular
  // already-running session's.
  let currentStartAbortController: AbortController | null = null;

  ipcMain.handle("agent:start-session", async (event, config: SessionConfig, resume?: ResumePayload) => {
    const controller = new AbortController();
    currentStartAbortController = controller;
    // The renderer only ever sends { kind: "anthropic", model } — it has no
    // access to the saved key (agent:get-anthropic-settings never sends the
    // real value back). Resolved here, the same place Google credentials
    // are resolved, right before the config reaches startSession. `model`
    // is carried through unchanged — only apiKey is ever added here.
    const resolvedConfig: SessionConfig =
      config.provider.kind === "anthropic"
        ? {
            ...config,
            provider: {
              kind: "anthropic",
              model: config.provider.model,
              apiKey: await resolveAnthropicApiKey(anthropicSettingsFilePath, storageCrypto),
            },
          }
        : config;
    try {
      return await startSession(registry, resolvedConfig, {
        onDownloadProgress: (status) => event.sender.send("agent:model-progress", status),
        signal: controller.signal,
        resume,
      });
    } catch (err) {
      // EmbeddedLlamaProvider.healthCheck() catches every error internally
      // (including an aborted download) and just returns false, so the
      // original AbortError never reaches here — startSession only ever
      // throws its own generic "health check failed" message regardless of
      // cause. The controller itself is the only place left that still
      // knows whether THIS failure was actually a deliberate cancel, so
      // that's checked here instead of trying to sniff the (already-lost)
      // error text on the renderer side.
      if (controller.signal.aborted) throw new Error("Download cancelled.");
      throw err;
    } finally {
      if (currentStartAbortController === controller) currentStartAbortController = null;
    }
  });

  ipcMain.handle("agent:cancel-download", () => {
    currentStartAbortController?.abort();
  });

  ipcMain.handle(
    "agent:run-task",
    (event, sessionId: string, task: string, attachments?: { images?: AttachedImage[]; textAttachments?: AttachedText[] }) =>
      runTask(
        registry,
        sessionId,
        task,
        (agentEvent) => {
          event.sender.send("agent:event", sessionId, agentEvent);
        },
        attachments
      )
  );

  ipcMain.handle("agent:pick-attachments", async () => {
    const result = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"] });
    if (result.canceled) return { attachments: [], errors: [] };

    const attachments: PickedAttachment[] = [];
    const errors: { name: string; error: string }[] = [];
    for (const filePath of result.filePaths) {
      try {
        attachments.push(await readAttachment(filePath));
      } catch (err) {
        errors.push({ name: path.basename(filePath), error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { attachments, errors };
  });

  ipcMain.handle("agent:respond-permission", (_event, sessionId: string, callId: string, approved: boolean) =>
    respondPermission(registry, sessionId, callId, approved)
  );

  ipcMain.handle("agent:respond-plan", (_event, sessionId: string, approved: boolean) => respondPlan(registry, sessionId, approved));

  ipcMain.handle("agent:cancel-session", (_event, sessionId: string) => cancelSession(registry, sessionId));

  ipcMain.handle("agent:get-checkpoint", (_event, sessionId: string) => getCheckpointHash(registry, sessionId));
  ipcMain.handle("agent:revert-checkpoint", (_event, sessionId: string) => revertSessionCheckpoint(registry, sessionId));
  ipcMain.handle("agent:get-changes", (_event, sessionId: string) => getSessionChanges(registry, sessionId));

  ipcMain.handle("agent:list-cached-models", () => checkCachedModels());

  ipcMain.handle("agent:delete-cached-model", (_event, id: string) => {
    if (!isEmbeddedModelId(id)) return false;
    return deleteModel(id);
  });

  ipcMain.handle("agent:hardware-info", async () => {
    const info = await detectHardware();
    return { ...info, recommended: recommendModel(info) };
  });

  // For the "Report an issue" link — app version + OS info to pre-fill a
  // bug report with, so a reporter doesn't have to dig this up themselves.
  ipcMain.handle("agent:diagnostics", () => ({
    appVersion: app.getVersion(),
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
  }));

  // The renderer-side half of local-only error capture — window.onerror/
  // unhandledrejection in renderer.ts forward here, since the renderer
  // has no filesystem access of its own (contextIsolation).
  ipcMain.handle("agent:log-renderer-error", (_event, entry: { kind: string; message: string; stack?: string }) =>
    appendErrorLog(errorLogPath, { source: "renderer", ...entry })
  );

  // Reveals the log file if anything's actually been written to it yet,
  // otherwise just opens the folder it would appear in — either way gives
  // the user something to look at rather than a silent no-op.
  ipcMain.handle("agent:open-error-log", async () => {
    const exists = await fsPromises
      .access(errorLogPath)
      .then(() => true)
      .catch(() => false);
    if (exists) shell.showItemInFolder(errorLogPath);
    else shell.openPath(path.dirname(errorLogPath));
  });

  ipcMain.handle("agent:pick-workspace", async () => {
    const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });
  ipcMain.handle("agent:google-sign-in", async () => {
    const signInCreds = await resolveGoogleCredentials(settingsFilePath, storageCrypto);
    const result = await signInWithGoogle(signInCreds.clientId, authFilePath, signInCreds.clientSecret, storageCrypto);
    if (!("error" in result)) {
      // Local sessions saved before ownership existed (or by an older
      // version of the app) have no owner yet — claim them for whoever
      // just signed in, rather than leaving them permanently invisible now
      // that the sidebar filters by account. Purely local, so this runs
      // regardless of whether a Drive access token is available below.
      try {
        const claimed = await claimUnownedSessions(sessionsDir, result.email);
        if (claimed > 0) console.log(`[cloudSync] claimed ${claimed} previously-unowned local session(s) for ${result.email}`);
      } catch (err) {
        console.warn("[cloudSync] claiming unowned local sessions failed:", err);
      }

      try {
        const reconcileCreds = await resolveGoogleCredentials(settingsFilePath, storageCrypto);
        const token = await getFreshAccessToken(authFilePath, reconcileCreds.clientId, reconcileCreds.clientSecret, storageCrypto);
        if (token) {
          const { pulled, pushed } = await reconcileSessions(sessionsDir, token);
          console.log(`[cloudSync] reconcile after sign-in: pulled ${pulled}, pushed ${pushed}`);
        } else {
          console.warn("[cloudSync] sign-in succeeded but no access token was available for reconcile — skipping.");
        }
      } catch (err) {
        if (err instanceof DriveScopeError) notifyScopeWarning();
        // Any other reconcile failure is non-fatal — sign-in itself already succeeded.
        console.warn("[cloudSync] reconcile after sign-in failed:", err);
      }

      broadcastToAllWindows("agent:sessions-changed");
    }
    return result;
  });
  ipcMain.handle("agent:sign-out", () => signOut(authFilePath));
  ipcMain.handle("agent:auth-status", async () => {
    const { clientId, clientSecret } = await resolveGoogleCredentials(settingsFilePath, storageCrypto);
    return getAuthStatus(authFilePath, clientId, clientSecret, storageCrypto);
  });
  ipcMain.handle("agent:get-google-settings", async () => {
    const settings = await loadGoogleSettings(settingsFilePath, storageCrypto);
    return {
      clientId: settings.clientId ?? "",
      hasSecret: !!settings.clientSecret,
      envOverride: !!process.env.GOOGLE_OAUTH_CLIENT_ID,
    };
  });
  ipcMain.handle("agent:save-google-settings", async (_event, input: { clientId: string; clientSecret?: string }) => {
    const current = await loadGoogleSettings(settingsFilePath, storageCrypto);
    await saveGoogleSettings(
      settingsFilePath,
      {
        clientId: input.clientId || null,
        clientSecret: input.clientSecret !== undefined ? input.clientSecret || null : current.clientSecret,
      },
      storageCrypto
    );
  });
  ipcMain.handle("agent:get-anthropic-settings", async () => {
    const settings = await loadAnthropicSettings(anthropicSettingsFilePath, storageCrypto);
    return { hasKey: !!settings.apiKey, envOverride: !!process.env.ANTHROPIC_API_KEY };
  });
  // input.apiKey === undefined means "untouched" (leave the saved key as-is,
  // mirroring agent:save-google-settings' clientSecret handling) — an
  // explicit string (including "") sets or clears it.
  ipcMain.handle("agent:save-anthropic-settings", async (_event, input: { apiKey?: string }) => {
    const current = await loadAnthropicSettings(anthropicSettingsFilePath, storageCrypto);
    await saveAnthropicSettings(
      anthropicSettingsFilePath,
      { apiKey: input.apiKey !== undefined ? input.apiKey || null : current.apiKey },
      storageCrypto
    );
  });
  // Session history is gated by the signed-in account: signed out (or no
  // account ever stored) shows nothing, matching the app's per-account
  // model rather than exposing every local session unconditionally.
  ipcMain.handle("agent:list-sessions", async () => {
    const email = await getStoredEmail(authFilePath, storageCrypto);
    return email ? listSessions(sessionsDir, email) : [];
  });
  ipcMain.handle("agent:search-sessions", async (_event, query: string) => {
    const email = await getStoredEmail(authFilePath, storageCrypto);
    return email ? searchSessions(sessionsDir, query, email) : [];
  });
  ipcMain.handle("agent:load-session", async (_event, id: string) => {
    try {
      return await loadSessionRecord(sessionsDir, id);
    } catch {
      return null;
    }
  });
  ipcMain.handle("agent:get-live-session", (_event, id: string) => getLiveSessionSnapshot(registry, id));
  ipcMain.handle("agent:update-session-settings", (_event, id: string, updates: { workspaceRoot?: string; mode?: PermissionMode; planFirst?: boolean }) =>
    updateLiveSessionSettings(registry, id, updates)
  );
  ipcMain.handle("agent:delete-session", async (_event, id: string) => {
    try {
      await removeSession(registry, id);
    } catch {
      // Invalid id — nothing to delete.
    }
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
