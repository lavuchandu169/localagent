/**
 * True for any http(s) URL that isn't the local dashboard itself — mirrors
 * vendor/freellmapi/desktop/src/main.ts's own `isExternal` exactly (read
 * directly, not guessed). Kept in its own module, separate from
 * freellmapiDashboardWindow.ts, specifically so it can be unit-tested under
 * plain Node: any file that imports from "electron" cannot be imported
 * outside a real Electron process at all (confirmed live — electron's
 * CJS/ESM interop throws "Named export 'BrowserWindow' not found" under
 * plain `node`), so this is the only way this logic is actually testable
 * in this sandbox, which has no real Electron runtime.
 */
export function isExternal(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "127.0.0.1";
  } catch {
    return false;
  }
}
