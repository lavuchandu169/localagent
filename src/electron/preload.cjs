// Hand-written CommonJS, not compiled from TypeScript: Electron's sandboxed
// preload context is the one place ESM support is still inconsistent, and
// this file is small enough that hand-authoring sidesteps the issue
// entirely. Exposes a narrow bridge — the renderer never gets raw
// ipcRenderer or require (contextIsolation: true, nodeIntegration: false).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agent", {
  startSession: (config) => ipcRenderer.invoke("agent:start-session", config),
  runTask: (sessionId, task) => ipcRenderer.invoke("agent:run-task", sessionId, task),
  respondPermission: (sessionId, callId, approved) =>
    ipcRenderer.invoke("agent:respond-permission", sessionId, callId, approved),
  cancelSession: (sessionId) => ipcRenderer.invoke("agent:cancel-session", sessionId),
  pickWorkspace: () => ipcRenderer.invoke("agent:pick-workspace"),
  listCachedModels: () => ipcRenderer.invoke("agent:list-cached-models"),
  getHardwareInfo: () => ipcRenderer.invoke("agent:hardware-info"),
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
});
