import fs from "node:fs/promises";
import type { StorageCrypto } from "./googleAuth.js";

/**
 * Readability finding (code-review-and-quality pass): every one of this
 * app's settings files (Anthropic/OpenAI/Gemini API keys, Google/GitHub
 * OAuth credentials, the MCP server list) independently re-implemented
 * this exact read-decrypt-parse-or-fallback skeleton, differing only in
 * how the parsed JSON becomes their own typed shape. `parse` runs inside
 * the same try/catch as the read/decrypt/JSON.parse — any throw from a
 * malformed shape (e.g. indexing into a parsed `null`) falls through to
 * `fallback` exactly like every file's own `catch { return fallback; }`
 * already did, so `parse` doesn't need its own defensive null-check.
 */
export async function loadEncryptedJson<T>(
  settingsFilePath: string,
  storageCrypto: StorageCrypto | undefined,
  parse: (parsed: unknown) => T,
  fallback: T
): Promise<T> {
  try {
    const raw = await fs.readFile(settingsFilePath, "utf-8");
    const json = storageCrypto ? storageCrypto.decrypt(raw) : raw;
    const parsed = JSON.parse(json) as unknown;
    return parse(parsed);
  } catch {
    return fallback;
  }
}

/** Same mode (0600 — owner-only) and encrypt-if-available convention as
 * loadEncryptedJson's read side; see that function's doc comment. */
export async function saveEncryptedJson(settingsFilePath: string, data: unknown, storageCrypto?: StorageCrypto): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  const toWrite = storageCrypto ? storageCrypto.encrypt(json) : json;
  await fs.writeFile(settingsFilePath, toWrite, { encoding: "utf-8", mode: 0o600 });
}
