import fs from "node:fs";
import path from "node:path";

/**
 * Parses simple `KEY=value` / `export KEY=value` lines — one per line,
 * optional surrounding quotes, `#` comments and blank lines skipped. Not a
 * full dotenv implementation, just enough for local dev credentials like
 * GOOGLE_OAUTH_CLIENT_ID/SECRET.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length) : line;
    const eq = withoutExport.indexOf("=");
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

/**
 * Loads `.env` from the given directory into process.env, if the file
 * exists — never overwrites a variable already set (an explicit
 * environment always wins over the file). Silent no-op if there's no
 * `.env` there.
 */
export function loadEnvFile(dir: string): void {
  let content: string;
  try {
    content = fs.readFileSync(path.join(dir, ".env"), "utf-8");
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(parseEnvFile(content))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
