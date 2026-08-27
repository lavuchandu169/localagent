import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionRegistry, startSession, runTask, respondPermission, cancelSession, removeSession } from "./sessionRegistry.js";
import type { SessionConfig, ResumePayload } from "./sessionRegistry.js";
import { checkCachedModels } from "./modelCache.js";
import { detectHardware, recommendModelSize } from "./hardwareInfo.js";
import { signInWithGoogle, signOut, getAuthStatus } from "./googleAuth.js";
import { listSessions, searchSessions, loadSessionRecord } from "../sessionStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  return win;
}

app.whenReady().then(() => {
  const authFilePath = path.join(app.getPath("userData"), "auth.json");
  const sessionsDir = path.join(app.getPath("userData"), "sessions");
  const registry = createSessionRegistry(sessionsDir);
  const win = createWindow();

  ipcMain.handle("agent:start-session", (event, config: SessionConfig, resume?: ResumePayload) =>
    startSession(registry, config, {
      onDownloadProgress: (status) => event.sender.send("agent:model-progress", status),
      resume,
    })
  );

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

  ipcMain.handle("agent:hardware-info", async () => {
    const info = await detectHardware();
    return { ...info, recommended: recommendModelSize(info) };
  });

  ipcMain.handle("agent:pick-workspace", async () => {
    const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });
  ipcMain.handle("agent:google-sign-in", () =>
    signInWithGoogle(process.env.GOOGLE_OAUTH_CLIENT_ID ?? "", authFilePath, process.env.GOOGLE_OAUTH_CLIENT_SECRET)
  );
  ipcMain.handle("agent:sign-out", () => signOut(authFilePath));
  ipcMain.handle("agent:auth-status", () =>
    getAuthStatus(authFilePath, process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET)
  );
  ipcMain.handle("agent:list-sessions", () => listSessions(sessionsDir));
  ipcMain.handle("agent:search-sessions", (_event, query: string) => searchSessions(sessionsDir, query));
  ipcMain.handle("agent:load-session", (_event, id: string) => loadSessionRecord(sessionsDir, id));
  ipcMain.handle("agent:delete-session", (_event, id: string) => removeSession(registry, id));
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
