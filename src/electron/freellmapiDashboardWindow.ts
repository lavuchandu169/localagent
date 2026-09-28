import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, shell, BrowserWindow } from "electron";
import { isExternal } from "./urlClassification.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let dashboardWindow: BrowserWindow | null = null;

/**
 * Opens (or focuses, if already open) FreeLLMAPI's own dashboard,
 * pre-authenticated as the hidden local account freellmapiHost.ts
 * auto-provisions - see vendor/freellmapi/desktop/src/window.ts, which
 * this mirrors. The window loads their vendored preload
 * (vendor/freellmapi/desktop/src/preload.ts, built alongside the server
 * bundle in Task 2) rather than localagent's own preload.cjs: it seeds
 * the session token into localStorage and exposes the
 * __FREEAPI_SESSION__/__FREEAPI_DESKTOP__ globals their client code
 * expects, which localagent's own preload has no reason to know about.
 */
export function openFreellmapiDashboard(port: number, token: string): void {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.show();
    dashboardWindow.focus();
    return;
  }

  dashboardWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: "Free-tier providers — localagent",
    webPreferences: {
      preload: path.join(__dirname, "..", "..", "dist", "freellmapi", "dashboard-preload.cjs"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      additionalArguments: [`--freeapi-token=${token}`, `--freeapi-version=${app.getVersion()}`],
    },
  });

  // Without this, target="_blank" links (e.g. "Get API key" on the Keys
  // page — the exact onboarding flow this feature depends on) spawn a bare
  // child window that inherits the dashboard preload and renders blank
  // (upstream's own issue #304, confirmed by reading their main.ts) — deny
  // the window/navigation and hand external URLs to the system browser
  // instead. Scoped to this window's own webContents specifically, not
  // registered globally via app.on("web-contents-created", ...) the way
  // upstream does it, since that would also affect localagent's own main
  // window, which already has its own equivalent handler.
  dashboardWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  dashboardWindow.webContents.on("will-navigate", (event, url) => {
    if (isExternal(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  dashboardWindow.loadURL(`http://127.0.0.1:${port}`);
  dashboardWindow.on("closed", () => {
    dashboardWindow = null;
  });
}
