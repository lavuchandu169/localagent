import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionRegistry, startSession, runTask, respondPermission, cancelSession, removeSession, getLiveSessionSnapshot, updateLiveSessionSettings } from "./sessionRegistry.js";
import type { SessionConfig, ResumePayload } from "./sessionRegistry.js";
import type { PermissionMode } from "../types.js";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    // The renderer only ever sends { kind: "anthropic" } — it has no access
    // to the saved key (agent:get-anthropic-settings never sends the real
    // value back). Resolved here, the same place Google credentials are
    // resolved, right before the config reaches startSession.
    const resolvedConfig: SessionConfig =
      config.provider.kind === "anthropic"
        ? { ...config, provider: { kind: "anthropic", apiKey: await resolveAnthropicApiKey(anthropicSettingsFilePath, storageCrypto) } }
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

  ipcMain.handle("agent:delete-cached-model", (_event, id: string) => {
    if (!isEmbeddedModelId(id)) return false;
    return deleteModel(id);
  });

  ipcMain.handle("agent:hardware-info", async () => {
    const info = await detectHardware();
    return { ...info, recommended: recommendModel(info) };
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
  ipcMain.handle("agent:update-session-settings", (_event, id: string, updates: { workspaceRoot?: string; mode?: PermissionMode }) =>
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
