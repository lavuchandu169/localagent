// Hand-written CommonJS, not compiled from TypeScript: Electron's sandboxed
// preload context is the one place ESM support is still inconsistent, and
// this file is small enough that hand-authoring sidesteps the issue
// entirely. Exposes a narrow bridge — the renderer never gets raw
// ipcRenderer or require (contextIsolation: true, nodeIntegration: false).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agent", {
  startSession: (config, resume) => ipcRenderer.invoke("agent:start-session", config, resume),
  runTask: (sessionId, task) => ipcRenderer.invoke("agent:run-task", sessionId, task),
  respondPermission: (sessionId, callId, approved) =>
    ipcRenderer.invoke("agent:respond-permission", sessionId, callId, approved),
  respondPlan: (sessionId, approved) => ipcRenderer.invoke("agent:respond-plan", sessionId, approved),
  cancelSession: (sessionId) => ipcRenderer.invoke("agent:cancel-session", sessionId),
  getCheckpoint: (sessionId) => ipcRenderer.invoke("agent:get-checkpoint", sessionId),
  revertCheckpoint: (sessionId) => ipcRenderer.invoke("agent:revert-checkpoint", sessionId),
  getChanges: (sessionId) => ipcRenderer.invoke("agent:get-changes", sessionId),
  pickWorkspace: () => ipcRenderer.invoke("agent:pick-workspace"),
  listCachedModels: () => ipcRenderer.invoke("agent:list-cached-models"),
  deleteCachedModel: (id) => ipcRenderer.invoke("agent:delete-cached-model", id),
  cancelDownload: () => ipcRenderer.invoke("agent:cancel-download"),
  getHardwareInfo: () => ipcRenderer.invoke("agent:hardware-info"),
  getDiagnostics: () => ipcRenderer.invoke("agent:diagnostics"),
  logRendererError: (entry) => ipcRenderer.invoke("agent:log-renderer-error", entry),
  openErrorLog: () => ipcRenderer.invoke("agent:open-error-log"),
  onEvent: (callback) => {
    const listener = (_event, sessionId, agentEvent) => callback(sessionId, agentEvent);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
  onDownloadProgress: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("agent:model-progress", listener);
    return () => ipcRenderer.removeListener("agent:model-progress", listener);
  },
  googleSignIn: () => ipcRenderer.invoke("agent:google-sign-in"),
  signOut: () => ipcRenderer.invoke("agent:sign-out"),
  getAuthStatus: () => ipcRenderer.invoke("agent:auth-status"),
  listSessions: () => ipcRenderer.invoke("agent:list-sessions"),
  searchSessions: (query) => ipcRenderer.invoke("agent:search-sessions", query),
  loadSession: (id) => ipcRenderer.invoke("agent:load-session", id),
  getLiveSession: (id) => ipcRenderer.invoke("agent:get-live-session", id),
  updateSessionSettings: (id, updates) => ipcRenderer.invoke("agent:update-session-settings", id, updates),
  deleteSession: (id) => ipcRenderer.invoke("agent:delete-session", id),
  onSessionsChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("agent:sessions-changed", listener);
    return () => ipcRenderer.removeListener("agent:sessions-changed", listener);
  },
  onCloudSyncScopeWarning: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("agent:cloud-sync-scope-warning", listener);
    return () => ipcRenderer.removeListener("agent:cloud-sync-scope-warning", listener);
  },
  onUpdateAvailable: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on("agent:update-available", listener);
    return () => ipcRenderer.removeListener("agent:update-available", listener);
  },
  getGoogleSettings: () => ipcRenderer.invoke("agent:get-google-settings"),
  saveGoogleSettings: (settings) => ipcRenderer.invoke("agent:save-google-settings", settings),
  getAnthropicSettings: () => ipcRenderer.invoke("agent:get-anthropic-settings"),
  saveAnthropicSettings: (settings) => ipcRenderer.invoke("agent:save-anthropic-settings", settings),
});
