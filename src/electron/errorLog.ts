import fs from "node:fs/promises";
import { redactSecrets } from "../protected.js";

/**
 * A local-only error/crash log — never uploaded anywhere, no external
 * service, no account needed. Deliberately not "opt-in" the way a remote
 * crash reporter would need to be: nothing here leaves the machine, so
 * there's no privacy tradeoff to consent to. It's on by default, same
 * posture as any other purely-local file this app already writes
 * (sessions, settings).
 */
export async function appendErrorLog(
  logFilePath: string,
  entry: { source: "main" | "renderer"; kind: string; message: string; stack?: string }
): Promise<void> {
  const timestamp = new Date().toISOString();
  // Security audit finding M4: an uncaught error's own message/stack can
  // incidentally embed a secret (e.g. a network error whose message
  // happens to include a request URL with an API key in it) — redact the
  // same way every other place this app writes raw text to disk does.
  const lines = [`[${timestamp}] [${entry.source}] [${entry.kind}] ${redactSecrets(entry.message)}`];
  if (entry.stack) lines.push(redactSecrets(entry.stack));
  lines.push(""); // blank line between entries
  try {
    // mode only takes effect when this call creates the file — matches
    // every other secret-adjacent file this app writes (settings, session
    // records) at 0600 rather than the platform default.
    await fs.appendFile(logFilePath, lines.join("\n") + "\n", { encoding: "utf-8", mode: 0o600 });
  } catch {
    // The log is a best-effort diagnostic aid, not something the app can
    // depend on — a failure to write it (disk full, permissions) must
    // never itself become a second error to handle.
  }
}
