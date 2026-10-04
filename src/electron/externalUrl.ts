/**
 * Security audit finding (confirmed, medium): open-external-no-url-scheme-
 * allowlist. main.ts's agent:open-external IPC handler and
 * win.webContents.setWindowOpenHandler both called shell.openExternal(url)
 * directly on a string originating from the renderer, with no validation
 * that the scheme is http/https. shell.openExternal on a non-http(s)
 * scheme (file:, a custom app's own registered URI scheme, a documented
 * OS-handler argument-injection class) is a documented Electron hardening
 * gap — handing it an arbitrary scheme is exactly what a compromised
 * renderer (XSS, or a compromised bundled dependency — the same
 * precondition this app's IPC surface already treats as realistic) would
 * do to reach further than "open a browser tab."
 *
 * Only http/https pass; anything else — including a string that fails to
 * parse as a URL at all — is rejected rather than guessed at.
 */
export function isAllowedExternalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}
