import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getOrCreateFreellmapiEncryptionKey } from "../../electron/freellmapiEncryptionKey.js";
import type { StorageCrypto } from "../../electron/googleAuth.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

const HEX_64 = /^[0-9a-fA-F]{64}$/;

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-freellmapi-key-test-"));

  console.log("getOrCreateFreellmapiEncryptionKey: first call with no storageCrypto generates and persists a key:");
  {
    const keyFile = path.join(dir, "no-crypto.key");
    const key1 = await getOrCreateFreellmapiEncryptionKey(keyFile);
    check("returns a 64-char hex string (32 bytes)", HEX_64.test(key1));

    const key2 = await getOrCreateFreellmapiEncryptionKey(keyFile);
    check("a second call returns the SAME persisted key, not a fresh one", key2 === key1);

    const stat = await fs.stat(keyFile);
    check("the key file is written with 0600 permissions", (stat.mode & 0o777) === 0o600);

    const raw = await fs.readFile(keyFile, "utf-8");
    check("with no storageCrypto, the file is plain hex (not encrypted)", raw.trim() === key1);
  }

  console.log("\ngetOrCreateFreellmapiEncryptionKey: with a storageCrypto, the key is encrypted at rest:");
  {
    const keyFile = path.join(dir, "with-crypto.key");
    const calls: string[] = [];
    const fakeCrypto: StorageCrypto = {
      encrypt: (plainText) => {
        calls.push("encrypt");
        return `ENCRYPTED(${plainText})`;
      },
      decrypt: (cipherText) => {
        calls.push("decrypt");
        const match = /^ENCRYPTED\((.*)\)$/.exec(cipherText);
        if (!match) throw new Error("not encrypted by this fake");
        return match[1]!;
      },
    };

    const key1 = await getOrCreateFreellmapiEncryptionKey(keyFile, fakeCrypto);
    check("returns a valid hex key", HEX_64.test(key1));
    check("the generated key was encrypted before writing", calls.includes("encrypt"));

    const raw = await fs.readFile(keyFile, "utf-8");
    check("the file on disk is NOT plain hex — it went through the fake encrypt()", raw.trim() !== key1 && raw.startsWith("ENCRYPTED("));

    calls.length = 0;
    const key2 = await getOrCreateFreellmapiEncryptionKey(keyFile, fakeCrypto);
    check("a second call decrypts and returns the SAME key", key2 === key1 && calls.includes("decrypt"));
  }

  console.log("\ngetOrCreateFreellmapiEncryptionKey: an existing key that fails to decrypt is a hard error, never silently replaced:");
  {
    const keyFile = path.join(dir, "undecryptable.key");
    await fs.writeFile(keyFile, "not-actually-encrypted-data", { mode: 0o600 });
    const alwaysFailingCrypto: StorageCrypto = {
      encrypt: (plainText) => plainText,
      decrypt: () => {
        throw new Error("decryption failed");
      },
    };

    let threw = false;
    let message = "";
    try {
      await getOrCreateFreellmapiEncryptionKey(keyFile, alwaysFailingCrypto);
    } catch (err: any) {
      threw = true;
      message = String(err?.message ?? err);
    }
    check("throws instead of silently generating a replacement key", threw);
    check("the error explains that previously-stored provider keys would become undecryptable", /previously|provider|key/i.test(message));

    const stillThere = await fs.readFile(keyFile, "utf-8");
    check("the original (undecryptable) file is left untouched, not overwritten", stillThere === "not-actually-encrypted-data");
  }

  console.log("\ngetOrCreateFreellmapiEncryptionKey: a corrupted (wrong-length) plaintext key file is also a hard error:");
  {
    const keyFile = path.join(dir, "corrupted.key");
    await fs.writeFile(keyFile, "not-64-hex-chars", { mode: 0o600 });

    let threw = false;
    try {
      await getOrCreateFreellmapiEncryptionKey(keyFile);
    } catch {
      threw = true;
    }
    check("throws rather than silently regenerating over a corrupted key file", threw);
  }

  await fs.rm(dir, { recursive: true, force: true });

  console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
