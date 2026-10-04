import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { StorageCrypto } from "./googleAuth.js";

const KEY_BYTES = 32;
const HEX_64 = /^[0-9a-fA-F]{64}$/;

/**
 * Loads (or, on first use, generates and persists) the hex-encoded
 * ENCRYPTION_KEY the bundled FreeLLMAPI server uses to encrypt every
 * stored provider API key. Without this, that server falls back to
 * writing the key itself in plaintext next to its database (security
 * audit finding: freellmapi-server:encryption-key-plaintext-colocated) —
 * this generates a real key instead and protects it the same way this
 * app already protects every other credential (optional StorageCrypto,
 * backed by Electron's safeStorage / OS keychain, with a 0600-permissioned
 * plaintext fallback when that's unavailable — same pattern as
 * googleAuth.ts's saveStoredIdentity/loadStoredIdentity).
 *
 * Deliberately does NOT fall back to silently generating a replacement
 * key when an existing file fails to decrypt or doesn't parse as a valid
 * key: unlike an identity token (where that would just mean "sign in
 * again"), replacing this key would permanently and silently strand every
 * already-stored provider API key as undecryptable ciphertext, with
 * nothing in the UI ever explaining why. Fails loudly instead, so the
 * real cause (e.g. secure-storage availability changed since this key was
 * written) surfaces rather than destroying data.
 */
export async function getOrCreateFreellmapiEncryptionKey(keyFilePath: string, storageCrypto?: StorageCrypto): Promise<string> {
  let raw: string;
  try {
    raw = await fs.readFile(keyFilePath, "utf-8");
  } catch {
    return generateAndPersist(keyFilePath, storageCrypto);
  }

  let hex: string;
  try {
    hex = storageCrypto ? storageCrypto.decrypt(raw) : raw.trim();
  } catch (err) {
    throw new Error(
      `Could not decrypt the existing FreeLLMAPI encryption key at ${keyFilePath}. Refusing to generate a replacement: ` +
        `every provider key already stored would become permanently undecryptable with no warning. ` +
        `This usually means secure-storage availability changed since the key was written. Original error: ${String((err as Error)?.message ?? err)}`
    );
  }

  if (!HEX_64.test(hex)) {
    throw new Error(
      `The existing FreeLLMAPI encryption key at ${keyFilePath} is not a valid 64-character hex key. ` +
        `Refusing to generate a replacement: every provider key already stored would become permanently undecryptable with no warning.`
    );
  }

  return hex;
}

async function generateAndPersist(keyFilePath: string, storageCrypto: StorageCrypto | undefined): Promise<string> {
  const hex = crypto.randomBytes(KEY_BYTES).toString("hex");
  const toWrite = storageCrypto ? storageCrypto.encrypt(hex) : hex;
  await fs.mkdir(path.dirname(keyFilePath), { recursive: true });
  await fs.writeFile(keyFilePath, toWrite, { encoding: "utf-8", mode: 0o600 });
  return hex;
}
