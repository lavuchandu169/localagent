import fs from "node:fs/promises";

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
  const lines = [`[${timestamp}] [${entry.source}] [${entry.kind}] ${entry.message}`];
  if (entry.stack) lines.push(entry.stack);
  lines.push(""); // blank line between entries
  try {
    await fs.appendFile(logFilePath, lines.join("\n") + "\n", "utf-8");
  } catch {
    // The log is a best-effort diagnostic aid, not something the app can
    // depend on — a failure to write it (disk full, permissions) must
    // never itself become a second error to handle.
  }
}
