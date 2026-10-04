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
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createSessionRegistry, startSession, runTask, respondPermission, respondPlan, cancelSession, removeSession, getLiveSessionSnapshot, updateLiveSessionSettings, getCheckpointHash, revertSessionCheckpoint, getSessionChanges, withPendingApprovalEntries } from "./sessionRegistry.js";
import type { SessionConfig, ResumePayload } from "./sessionRegistry.js";
import type { AttachedImage, AttachedText, PermissionMode } from "../types.js";
import { checkCachedModels, deleteModel } from "./modelCache.js";
import { searchHuggingFaceGgufModels } from "./modelSearch.js";
import { isEmbeddedModelId } from "../models.js";
import { detectHardware, recommendModel } from "./hardwareInfo.js";
import { signInWithGoogle, signOut, getAuthStatus, getFreshAccessToken, getStoredEmail } from "./googleAuth.js";
import { loadGoogleSettings, saveGoogleSettings, resolveGoogleCredentials } from "./googleSettings.js";
import { loadAnthropicSettings, saveAnthropicSettings, resolveAnthropicApiKey } from "./anthropicSettings.js";
import { loadOpenAISettings, saveOpenAISettings, resolveOpenAIApiKey } from "./openaiSettings.js";
import { loadGeminiSettings, saveGeminiSettings, resolveGeminiApiKey } from "./geminiSettings.js";
import { loadMcpSettings, saveMcpSettings, type McpServerConfig } from "./mcpSettings.js";
import { connectMcpServer, disconnectMcpServer, type McpConnection, type McpServerStatus } from "./mcpClient.js";
import { adaptMcpTools, sanitizeMcpServerName, type McpToolCaller } from "../mcpToolAdapter.js";
import { listSessions, searchSessions, loadSessionRecord, claimUnownedSessions } from "../sessionStore.js";
import { reconcileSessions, DriveScopeError } from "../cloudSync.js";
import { loadEnvFile } from "./loadEnvFile.js";
import { isSecureStorageAvailable, electronStorageCrypto } from "./secureStorage.js";
import { connectGithub, loadStoredGithubIdentity, clearStoredGithubIdentity, getGithubAccessToken } from "./githubAuth.js";
import { resolveGithubClientId } from "./githubSettings.js";
import { createGithubCreateRepoTool, createGithubCreatePrTool } from "./githubTools.js";
import { appendErrorLog } from "./errorLog.js";
import { readAttachment, type PickedAttachment } from "./attachments.js";
import { wireAutoUpdater, type UpdateManager } from "./updateManager.js";
import { isFreellmapiRunning, stopFreellmapiServer, setFreellmapiStorageCrypto } from "./freellmapiHost.js";

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

// Chromium's native-window-occlusion tracking (on by default since ~M85)
// throttles a window's rendering/compositing whenever Windows' DWM reports
// it as occluded (covered by another window, minimized, or off-screen) —
// a well-documented source of stutter/frozen-looking rendering on Windows
// specifically when a window comes back into view, especially across
// multiple monitors. Several other Electron apps disable this feature for
// exactly that reason. Must be set before app.whenReady() — commandLine
// switches have no effect once Chromium has already started up.
if (process.platform === "win32") {
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
}

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
  // Security audit finding M1: with no guard, dropping an untrusted HTML
  // file onto the window (or any other in-page navigation away from the
  // app's own bundled page) would load that page with the SAME preload
  // bridge still attached — including addMcpServer, which spawns an
  // arbitrary command. This window never legitimately navigates anywhere
  // after its one loadFile() call below, so every will-navigate is denied
  // unconditionally rather than trying to allowlist specific targets.
  win.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  return win;
}

app.whenReady().then(async () => {
  const authFilePath = path.join(app.getPath("userData"), "auth.json");
  const githubAuthFilePath = path.join(app.getPath("userData"), "github-auth.json");
  const githubSettingsFilePath = path.join(app.getPath("userData"), "githubSettings.json");
  const settingsFilePath = path.join(app.getPath("userData"), "googleSettings.json");
  const anthropicSettingsFilePath = path.join(app.getPath("userData"), "anthropicSettings.json");
  const openaiSettingsFilePath = path.join(app.getPath("userData"), "openaiSettings.json");
  const geminiSettingsFilePath = path.join(app.getPath("userData"), "geminiSettings.json");
  const mcpSettingsFilePath = path.join(app.getPath("userData"), "mcpServers.json");
  const freellmapiUserDataDir = app.getPath("userData");
  const sessionsDir = path.join(app.getPath("userData"), "sessions");
  const win = createWindow();

  // The stored Google identity (including the refresh token) is encrypted
  // at rest via the OS-native credential backend (Keychain/DPAPI/libsecret)
  // wherever it's available. Falls back to a plain (still 0600-permissioned)
  // file rather than failing sign-in outright on a system with no
  // secret-service/keyring daemon running (some minimal Linux setups).
  const storageCrypto = isSecureStorageAvailable() ? electronStorageCrypto : undefined;
  if (!storageCrypto) {
    // Security audit finding M4: this one `storageCrypto` value governs
    // EVERY secret this app stores — not just the Google identity file:
    // the Anthropic/OpenAI/Gemini API keys, the GitHub OAuth token, MCP
    // server configs, and (as of the fix for finding
    // freellmapi-server:encryption-key-plaintext-colocated) the generated
    // encryption key for the bundled FreeLLMAPI server's own stored
    // provider keys all fall back to plain text (still 0600) the same
    // way. The warning said only "the Google identity file", which
    // understated the real scope of what's affected on a system with no
    // OS keychain/DPAPI/libsecret available.
    console.warn(
      "[auth] OS-native secure storage isn't available on this system — every credential this app stores (provider API keys, the GitHub token, the Google identity file, MCP server configs, the FreeLLMAPI encryption key) will be saved as plain text (0600 permissions) instead of OS-encrypted."
    );
  }
  // Security audit finding freellmapi-server:encryption-key-plaintext-colocated:
  // without this, the bundled FreeLLMAPI server generates its own
  // ENCRYPTION_KEY and writes it as a plaintext file next to its database
  // whenever NODE_ENV isn't exactly "production" (the normal packaged-app
  // case) — readable by any other process running as this OS user, no
  // auth or race needed. Set once here, before any session can select the
  // freellmapi provider and trigger startFreellmapiServer() from either of
  // its two call sites (freellmapiProxy.ts's healthCheck, or this file's
  // own freellmapiConn()) — see freellmapiHost.ts's own doc comment for
  // why a module-level setter, not a threaded parameter, is how it reaches
  // the key-generation step regardless of which call site goes first.
  setFreellmapiStorageCrypto(storageCrypto);

  const getGithubToken = () => getGithubAccessToken(githubAuthFilePath, storageCrypto);
  // Correctness audit finding (GitHub Medium #2): a 401 from a GitHub tool
  // call means the stored token itself is dead (revoked on GitHub's side,
  // most likely) — clear the stored identity so Settings stops claiming
  // "Connected as @x" and the user gets a real path back to reconnecting.
  const onGithubUnauthorized = () => clearStoredGithubIdentity(githubAuthFilePath);

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

  /**
   * Resolves the window to attach a modal dialog to at call time, not at
   * app-startup time — `dialog.showOpenDialog` needs a live BrowserWindow
   * or none at all; passing a destroyed one either throws or attaches to
   * the wrong window. Same hazard broadcastToAllWindows (above) exists to
   * avoid: the window captured once when the app started isn't
   * necessarily the window that's still open when a dialog is requested
   * later (macOS: close-then-reopen via app.on("activate") creates an
   * entirely new BrowserWindow no captured reference ever gets updated
   * to).
   */
  function showOpenDialog(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
    const parentWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    return parentWindow ? dialog.showOpenDialog(parentWindow, options) : dialog.showOpenDialog(options);
  }

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
      openPath: (path) => shell.openPath(path),
    });
  }

  let mcpConnections: McpConnection[] = [];

  function currentMcpTools() {
    return mcpConnections
      .filter((c) => c.status.state === "connected" && c.client)
      .flatMap((c) => {
        // adaptMcpTools's McpToolCaller is deliberately narrower than the SDK's
        // real Client.callTool (whose return type also covers task-based tool
        // results, {toolResult: unknown} — a feature this app doesn't use).
        // This one-line wrapper is the single place that narrowing happens,
        // rather than widening McpToolCaller itself and making every adapter
        // consumer handle a shape it never actually receives.
        const caller = { callTool: (params: { name: string; arguments: Record<string, unknown> }) => c.client!.callTool(params) as ReturnType<McpToolCaller["callTool"]> };
        return adaptMcpTools(c.config.name, caller, c.tools);
      });
  }

  async function connectAndTrack(config: McpServerConfig): Promise<McpConnection> {
    // Correctness audit finding (MCP Low/Medium): a server's entry used to
    // appear in mcpConnections (and therefore in agent:list-mcp-servers'
    // response) only once connectMcpServer's whole promise resolved —
    // connecting or failed both arrive in the SAME resolution, so there
    // was never a window where a caller could observe "connecting" for a
    // server that hadn't finished yet. At app startup, where every enabled
    // server connects without anything awaiting the result (see the
    // fire-and-forget chain below), that meant opening the MCP panel
    // during the first several seconds after launch showed a server as
    // simply MISSING rather than "connecting" — it would then pop into
    // existence once the connect settled. Seeding a "connecting" entry
    // synchronously, before the first await, closes that window: it's the
    // same object connectMcpServer's onStatusChange callback already looks
    // up and mutates in place below.
    mcpConnections = mcpConnections.filter((c) => c.config.id !== config.id).concat({ config, status: { state: "connecting" }, client: undefined, tools: [] });
    const connection = await connectMcpServer(config, (status: McpServerStatus) => {
      const existing = mcpConnections.find((c) => c.config.id === config.id);
      if (existing) existing.status = status;
      broadcastToAllWindows("agent:mcp-server-status-changed", { id: config.id, status });
    });
    mcpConnections = mcpConnections.filter((c) => c.config.id !== config.id).concat(connection);
    return connection;
  }

  ipcMain.handle("agent:install-update", () => {
    updateManager?.installUpdate();
  });

  ipcMain.handle("agent:open-update-file", () => {
    updateManager?.openDownloadedFile();
  });

  ipcMain.handle("agent:list-mcp-servers", () => {
    return mcpConnections.map((c) => ({
      id: c.config.id,
      name: c.config.name,
      command: c.config.command,
      args: c.config.args,
      status: c.status,
    }));
  });

  ipcMain.handle("agent:add-mcp-server", async (_event, input: { name: string; command: string; args: string[]; env: Record<string, string> }) => {
    const existingConfigs = await loadMcpSettings(mcpSettingsFilePath, storageCrypto);
    // Compared sanitized, not raw: sanitizeMcpServerName (mcpToolAdapter.ts)
    // lowercases and strips symbols when building each tool's
    // mcp__<server>__<tool> prefix, so e.g. "GitHub" and "github" are
    // different strings here but would produce IDENTICAL tool-name
    // prefixes — the second server's tools would silently shadow the
    // first's in the tool registry (last-write-wins, no error) if both
    // were allowed to save.
    if (existingConfigs.some((c) => sanitizeMcpServerName(c.name) === sanitizeMcpServerName(input.name))) {
      return { ok: false as const, error: `A server matching "${input.name}" already exists (server names that differ only by case or punctuation are treated as the same).` };
    }
    const config: McpServerConfig = { id: crypto.randomUUID(), name: input.name, command: input.command, args: input.args, env: input.env, enabled: true };
    // Connect before persisting. connectAndTrack/connectMcpServer never
    // throws (a bad command resolves to a "failed" status, same as any
    // other connection failure) — so this doesn't gate saving on success;
    // a mistyped command still ends up saved with status "failed", same as
    // before, so the user has something to see and Remove rather than it
    // silently vanishing. What this ordering buys, now that the startup
    // path (see the fire-and-forget connect chain above) no longer lets a
    // slow/hanging connect block the rest of the app's IPC surface, is
    // just that the persisted file and the in-memory connection list
    // always agree with what was actually attempted, instead of a config
    // existing on disk a beat before anything ever tried to use it.
    const connection = await connectAndTrack(config);
    await saveMcpSettings(mcpSettingsFilePath, [...existingConfigs, config], storageCrypto);
    return { ok: true as const, server: { id: config.id, name: config.name, command: config.command, args: config.args, status: connection.status } };
  });

  ipcMain.handle("agent:remove-mcp-server", async (_event, id: string) => {
    const oldConnection = mcpConnections.find((c) => c.config.id === id);
    if (oldConnection) await disconnectMcpServer(oldConnection);
    mcpConnections = mcpConnections.filter((c) => c.config.id !== id);
    const existingConfigs = await loadMcpSettings(mcpSettingsFilePath, storageCrypto);
    await saveMcpSettings(mcpSettingsFilePath, existingConfigs.filter((c) => c.id !== id), storageCrypto);
  });

  let scopeWarningSent = false;
  function notifyScopeWarning(): void {
    if (scopeWarningSent) return;
    scopeWarningSent = true;
    broadcastToAllWindows("agent:cloud-sync-scope-warning");
  }

  const registry = createSessionRegistry(
    sessionsDir,
    {
      getAccessToken: async () => {
        const { clientId, clientSecret } = await resolveGoogleCredentials(settingsFilePath, storageCrypto);
        return getFreshAccessToken(authFilePath, clientId, clientSecret, storageCrypto);
      },
      onScopeError: notifyScopeWarning,
      getOwnerEmail: () => getStoredEmail(authFilePath, storageCrypto),
    },
    // Correctness audit finding (session Medium #4): rebroadcasts the
    // existing sessions-changed signal whenever any session's pending
    // approval starts, gets answered, or is swept on cancel/delete — the
    // renderer's own onSessionsChanged listener already refreshes the
    // sidebar on this event, so this is the only wiring needed to keep the
    // "waiting for approval" indicator (agent:list-sessions' new
    // waitingForApproval field) live, including for a session with no tab
    // currently open.
    () => broadcastToAllWindows("agent:sessions-changed")
  );

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
    // The renderer only ever sends { kind: "anthropic"/"openai"/"gemini", model }
    // — it has no access to the saved key (agent:get-*-settings never sends
    // the real value back). Resolved here, the same place Google credentials
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
        : config.provider.kind === "openai"
          ? {
              ...config,
              provider: {
                kind: "openai",
                model: config.provider.model,
                apiKey: await resolveOpenAIApiKey(openaiSettingsFilePath, storageCrypto),
              },
            }
          : config.provider.kind === "gemini"
            ? {
                ...config,
                provider: {
                  kind: "gemini",
                  model: config.provider.model,
                  apiKey: await resolveGeminiApiKey(geminiSettingsFilePath, storageCrypto),
                },
              }
            : config.provider.kind === "freellmapi"
              ? { ...config, provider: { kind: "freellmapi" as const, userDataDir: freellmapiUserDataDir } }
              : config;
    try {
      return await startSession(registry, resolvedConfig, {
        onDownloadProgress: (status) => event.sender.send("agent:model-progress", status),
        signal: controller.signal,
        resume,
        getExtraTools: () => [...currentMcpTools(), createGithubCreateRepoTool(getGithubToken, onGithubUnauthorized), createGithubCreatePrTool(getGithubToken, onGithubUnauthorized)],
        settingsDir: app.getPath("userData"),
        storageCrypto,
        getGithubToken,
      });
    } catch (err) {
      // healthCheck's real error message now reaches here (see
      // HealthCheckResult), but a deliberate cancel would otherwise surface
      // as a raw AbortError-shaped message instead of the clearer "Download
      // cancelled." — the controller is still the only place that reliably
      // knows THIS failure was a deliberate cancel, so it's checked here
      // rather than pattern-matching the error text.
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

  ipcMain.handle("agent:pick-attachments", async (_event, limit?: number) => {
    const result = await showOpenDialog({ properties: ["openFile", "multiSelections"] });
    if (result.canceled) return { attachments: [], errors: [], skipped: 0 };

    const maxToRead = typeof limit === "number" ? limit : result.filePaths.length;
    const attachments: PickedAttachment[] = [];
    const errors: { name: string; error: string }[] = [];
    let skipped = 0;
    for (const filePath of result.filePaths) {
      // Once enough files have been successfully read to hit the caller's
      // cap, every remaining picked file is skipped without ever being
      // stat'd or read — a large multi-file pick past the composer's
      // 5-attachment limit no longer pays the read cost for files that
      // would just be discarded on the renderer side anyway.
      if (attachments.length >= maxToRead) {
        skipped++;
        continue;
      }
      try {
        attachments.push(await readAttachment(filePath));
      } catch (err) {
        errors.push({ name: path.basename(filePath), error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { attachments, errors, skipped };
  });

  ipcMain.handle("agent:respond-permission", (_event, sessionId: string, callId: string, approved: boolean, approvedHunkIds?: number[]) =>
    respondPermission(registry, sessionId, callId, approved, approvedHunkIds)
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

  ipcMain.handle("agent:search-hf-models", (_event, query: string) => searchHuggingFaceGgufModels(query));

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
    const result = await showOpenDialog({ properties: ["openDirectory"] });
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
          const { pulled, pushed, deletedLocal } = await reconcileSessions(sessionsDir, token);
          console.log(`[cloudSync] reconcile after sign-in: pulled ${pulled}, pushed ${pushed}, deleted locally ${deletedLocal}`);
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
  ipcMain.handle("agent:sign-out", () => signOut(authFilePath, storageCrypto));
  ipcMain.handle("agent:auth-status", async () => {
    const { clientId, clientSecret } = await resolveGoogleCredentials(settingsFilePath, storageCrypto);
    return getAuthStatus(authFilePath, clientId, clientSecret, storageCrypto);
  });
  ipcMain.handle("agent:github-connect", async (event) => {
    const clientId = await resolveGithubClientId(githubSettingsFilePath, storageCrypto);
    return connectGithub(clientId, githubAuthFilePath, storageCrypto, (code) => {
      event.sender.send("agent:github-device-code", {
        userCode: code.userCode,
        verificationUri: code.verificationUri,
      });
    });
  });
  ipcMain.handle("agent:github-status", async () => {
    const identity = await loadStoredGithubIdentity(githubAuthFilePath, storageCrypto);
    return identity ? { connected: true as const, login: identity.login } : { connected: false as const };
  });
  ipcMain.handle("agent:github-disconnect", async () => {
    await clearStoredGithubIdentity(githubAuthFilePath);
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
  ipcMain.handle("agent:get-openai-settings", async () => {
    const settings = await loadOpenAISettings(openaiSettingsFilePath, storageCrypto);
    return { hasKey: !!settings.apiKey, envOverride: !!process.env.OPENAI_API_KEY };
  });
  ipcMain.handle("agent:save-openai-settings", async (_event, input: { apiKey?: string }) => {
    const current = await loadOpenAISettings(openaiSettingsFilePath, storageCrypto);
    await saveOpenAISettings(
      openaiSettingsFilePath,
      { apiKey: input.apiKey !== undefined ? input.apiKey || null : current.apiKey },
      storageCrypto
    );
  });
  ipcMain.handle("agent:get-gemini-settings", async () => {
    const settings = await loadGeminiSettings(geminiSettingsFilePath, storageCrypto);
    return { hasKey: !!settings.apiKey, envOverride: !!process.env.GEMINI_API_KEY };
  });
  ipcMain.handle("agent:save-gemini-settings", async (_event, input: { apiKey?: string }) => {
    const current = await loadGeminiSettings(geminiSettingsFilePath, storageCrypto);
    await saveGeminiSettings(
      geminiSettingsFilePath,
      { apiKey: input.apiKey !== undefined ? input.apiKey || null : current.apiKey },
      storageCrypto
    );
  });
  // Native Keys panel - every handler below does the same three things:
  // lazily start the bundled server (a no-op if already running, same
  // singleton startFreellmapiServer() every provider path already uses),
  // get the current session token, then delegate to freellmapiKeysApi.ts.
  // Errors thrown there cross the IPC boundary as a rejected promise with
  // the same message - freellmapiPanel.ts's own try/catch renders it.
  async function freellmapiConn(): Promise<{ port: number; token: string }> {
    const { startFreellmapiServer, ensureFreellmapiSessionToken } = await import("./freellmapiHost.js");
    const { port } = await startFreellmapiServer({ userDataDir: freellmapiUserDataDir });
    return { port, token: ensureFreellmapiSessionToken() };
  }

  ipcMain.handle("agent:freellmapi-list-providers", async () => {
    const { listProviders } = await import("./freellmapiKeysApi.js");
    return listProviders(await freellmapiConn());
  });
  ipcMain.handle("agent:freellmapi-list-keys", async () => {
    const { listKeys } = await import("./freellmapiKeysApi.js");
    return listKeys(await freellmapiConn());
  });
  ipcMain.handle("agent:freellmapi-add-key", async (_event, params) => {
    const { addKey } = await import("./freellmapiKeysApi.js");
    return addKey(await freellmapiConn(), params);
  });
  ipcMain.handle("agent:freellmapi-update-key", async (_event, id, params) => {
    const { updateKey } = await import("./freellmapiKeysApi.js");
    return updateKey(await freellmapiConn(), id, params);
  });
  ipcMain.handle("agent:freellmapi-remove-key", async (_event, id) => {
    const { removeKey } = await import("./freellmapiKeysApi.js");
    return removeKey(await freellmapiConn(), id);
  });
  ipcMain.handle("agent:freellmapi-clear-cooldown", async (_event, id) => {
    const { clearCooldown } = await import("./freellmapiKeysApi.js");
    return clearCooldown(await freellmapiConn(), id);
  });
  ipcMain.handle("agent:freellmapi-reveal-key", async (_event, id) => {
    const { revealKey } = await import("./freellmapiKeysApi.js");
    return revealKey(await freellmapiConn(), id);
  });
  ipcMain.handle("agent:freellmapi-preview-import", async (_event, files: Array<{ filename: string; content: string }>) => {
    const { previewImport } = await import("./freellmapiKeysApi.js");
    return previewImport(
      await freellmapiConn(),
      files.map((f) => ({ filename: f.filename, content: Buffer.from(f.content, "base64") }))
    );
  });
  ipcMain.handle("agent:freellmapi-import-selected", async (_event, keys) => {
    const { importSelected } = await import("./freellmapiKeysApi.js");
    return importSelected(await freellmapiConn(), keys);
  });
  ipcMain.handle("agent:freellmapi-update-platform-settings", async (_event, platform, params) => {
    const { updatePlatformSettings } = await import("./freellmapiKeysApi.js");
    return updatePlatformSettings(await freellmapiConn(), platform, params);
  });
  ipcMain.handle("agent:freellmapi-add-custom-provider", async (_event, params) => {
    const { addCustomProvider } = await import("./freellmapiKeysApi.js");
    return addCustomProvider(await freellmapiConn(), params);
  });
  ipcMain.handle("agent:freellmapi-discover-models", async (_event, params) => {
    const { discoverModels } = await import("./freellmapiKeysApi.js");
    return discoverModels(await freellmapiConn(), params);
  });
  ipcMain.handle("agent:freellmapi-probe-custom-provider", async (_event, params) => {
    const { probeCustomProvider } = await import("./freellmapiKeysApi.js");
    return probeCustomProvider(await freellmapiConn(), params);
  });
  ipcMain.handle("agent:freellmapi-pick-import-files", async () => {
    const result = await showOpenDialog({ properties: ["openFile", "multiSelections"] });
    if (result.canceled) return null;
    return Promise.all(
      result.filePaths.map(async (filePath) => ({
        filename: path.basename(filePath),
        content: (await fsPromises.readFile(filePath)).toString("base64"),
      }))
    );
  });
  // Mirrors showOpenDialog's own reasoning above (a captured window
  // reference can go stale by the time a dialog is actually requested) -
  // no existing showSaveDialog wrapper to reuse, so the same
  // getFocusedWindow-with-fallback pattern is inlined here directly.
  ipcMain.handle("agent:freellmapi-export-to-file", async (_event, format: "json" | "env") => {
    // exportKeys() returns the server's real response body verbatim - it
    // already formats both types correctly (including edge cases the
    // server's own comments document: duplicate key names, custom-endpoint
    // base URLs), so this just writes it out unchanged rather than
    // re-implementing formatting a second, buggier time.
    const { exportKeys } = await import("./freellmapiKeysApi.js");
    const content = await exportKeys(await freellmapiConn(), format);
    const parentWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = parentWindow
      ? await dialog.showSaveDialog(parentWindow, { defaultPath: `freellmapi-keys.${format}` })
      : await dialog.showSaveDialog({ defaultPath: `freellmapi-keys.${format}` });
    if (result.canceled || !result.filePath) return { saved: false };
    await fsPromises.writeFile(result.filePath, content, "utf-8");
    return { saved: true };
  });
  // Confirmed by reading preload.cjs/main.ts directly: no renderer-callable
  // "open this URL in the system browser" primitive existed yet - the app's
  // own main window opens external links through a setWindowOpenHandler
  // callback, not an IPC method. The panel's "Get key ->" links need one.
  ipcMain.handle("agent:open-external", async (_event, url: string) => {
    await shell.openExternal(url);
  });
  // Native Fallback panel - second of FreeLLMAPI's vendored dashboard pages
  // reimplemented (Keys, above, was the first). Reuses the same
  // freellmapiConn() helper - no new lifecycle code needed.
  ipcMain.handle("agent:freellmapi-fallback-get-routing", async () => {
    const { getRouting } = await import("./freellmapiFallbackApi.js");
    return getRouting(await freellmapiConn());
  });
  ipcMain.handle("agent:freellmapi-fallback-update-routing", async (_event, params) => {
    const { updateRouting } = await import("./freellmapiFallbackApi.js");
    return updateRouting(await freellmapiConn(), params);
  });
  ipcMain.handle("agent:freellmapi-fallback-get-models", async () => {
    const { getModelList } = await import("./freellmapiFallbackApi.js");
    return getModelList(await freellmapiConn());
  });
  ipcMain.handle("agent:freellmapi-fallback-update-models", async (_event, entries) => {
    const { updateModelList } = await import("./freellmapiFallbackApi.js");
    return updateModelList(await freellmapiConn(), entries);
  });
  ipcMain.handle("agent:freellmapi-fallback-sort-models", async (_event, preset) => {
    const { sortModelList } = await import("./freellmapiFallbackApi.js");
    return sortModelList(await freellmapiConn(), preset);
  });
  // Session history is gated by the signed-in account: signed out (or no
  // account ever stored) shows nothing, matching the app's per-account
  // model rather than exposing every local session unconditionally.
  // withPendingApprovalEntries (correctness audit: session Medium #4;
  // final-review finding I4) merges live waitingForApproval state onto
  // the disk-backed list and synthesizes a row for a brand-new session
  // that has no disk record yet.
  ipcMain.handle("agent:list-sessions", async () => {
    const email = await getStoredEmail(authFilePath, storageCrypto);
    return email ? withPendingApprovalEntries(registry, await listSessions(sessionsDir, email), email) : [];
  });
  ipcMain.handle("agent:search-sessions", async (_event, query: string) => {
    const email = await getStoredEmail(authFilePath, storageCrypto);
    return email ? withPendingApprovalEntries(registry, await searchSessions(sessionsDir, query, email), email, query) : [];
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

  // Deliberately NOT awaited here — every ipcMain.handle(...) call above
  // this point has already registered synchronously by the time this line
  // runs, so the renderer's startup IPC calls (hardware info, model list,
  // auth status, session list — all fired the instant createWindow()'s
  // page finishes loading) never race a still-pending await on this chain.
  // Connecting to an MCP server is not fast (mcpClient.ts's own timeout is
  // 10s, and was the SDK's 60s default before that was added) — awaiting
  // this before handler registration used to leave EVERY IPC call in the
  // app rejecting with Electron's "No handler registered" for however long
  // a misconfigured/hanging server took to fail. Connects in dev runs too,
  // unlike the packaged-only autoUpdater — there's no reason to gate this,
  // and testing MCP servers from source is exactly when a developer most
  // needs it to actually run. A session started before a connect finishes
  // simply gets fewer MCP tools this one time — currentMcpTools() is read
  // fresh on every agent:start-session call, not cached at startup, and
  // agent:mcp-server-status-changed already updates the panel live once a
  // connect resolves — the same "config fixed at session start" tradeoff
  // this app already accepts elsewhere.
  void loadMcpSettings(mcpSettingsFilePath, storageCrypto).then((configs) =>
    Promise.all(configs.filter((c) => c.enabled).map(connectAndTrack))
  );

  // Most stdio servers exit on their own once the parent's stdin pipe
  // closes, but that's a convention, not a guarantee — a server that
  // ignores stdin EOF would otherwise orphan a real running process every
  // time this app quits.
  app.on("before-quit", () => {
    for (const connection of mcpConnections) void disconnectMcpServer(connection);
  });

  // A second, independent before-quit listener (Electron dispatches
  // "before-quit" to every registered listener, not just the first — this
  // composes safely with the MCP cleanup listener above). Only runs its
  // cleanup when the freellmapi feature was actually started this session —
  // isFreellmapiRunning() must be checked synchronously, before any await,
  // since Electron only honors event.preventDefault() when it's called
  // during the event's own synchronous dispatch. A session that never
  // touched the feature quits exactly as fast as it always did. When it
  // does run, it defers the actual exit: the bundled server's SQLite handle
  // needs to close cleanly before the process really goes away, not just a
  // best-effort fire-and-forget like the MCP disconnects above.
  app.on("before-quit", (event) => {
    if (!isFreellmapiRunning()) return;
    event.preventDefault();
    stopFreellmapiServer()
      .catch((err) => console.error("[freellmapi] shutdown error:", err))
      .finally(() => {
        // The updater's own before-quit listener is registered earlier (see
        // wireAutoUpdater above), and Electron dispatches before-quit to
        // listeners in registration order — so by the time this .finally()
        // runs, quitAndInstall() may already be underway. It DOES call
        // event.preventDefault() itself while it closes windows and drives
        // the OS-level install/relaunch (confirmed by reading
        // updateManager.ts's onBeforeQuit handler), contrary to what an
        // earlier version of this comment claimed. app.exit() is an
        // immediate, no-draining process kill; calling it while an install
        // is underway could race ahead of the installer actually launching
        // and corrupt the update. Leave process exit to quitAndInstall()
        // itself in that case.
        if (!updateManager?.isInstalling()) {
          app.exit();
        }
      });
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
