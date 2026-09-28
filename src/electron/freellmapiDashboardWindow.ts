import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

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

  dashboardWindow.loadURL(`http://127.0.0.1:${port}`);
  dashboardWindow.on("closed", () => {
    dashboardWindow = null;
  });
}
