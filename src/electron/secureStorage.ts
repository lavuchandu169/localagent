import { safeStorage } from "electron";
import type { StorageCrypto } from "./googleAuth.js";

/**
 * True when the OS-native credential backend is actually usable — false on
 * some Linux setups with no secret-service/keyring daemon running, where
 * `safeStorage.encryptString`/`decryptString` would throw. Callers should
 * fall back to storing the identity file in plain text (still
 * 0600-permissioned) rather than crash sign-in over this.
 */
export function isSecureStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

/**
 * Wraps Electron's `safeStorage` (macOS Keychain / Windows DPAPI / Linux
 * libsecret) as a plain encrypt/decrypt string pair, so `googleAuth.ts`
 * (which must stay importable without Electron for its own test suite)
 * only ever depends on the `StorageCrypto` interface, never this module
 * directly. `encryptString` returns a Buffer; base64-encoded here so the
 * result is safe to write as a text file with the rest of the identity
 * file's existing `fs.writeFile(..., "utf-8")` call.
 */
export const electronStorageCrypto: StorageCrypto = {
  encrypt: (plainText) => safeStorage.encryptString(plainText).toString("base64"),
  decrypt: (cipherText) => safeStorage.decryptString(Buffer.from(cipherText, "base64")),
};
