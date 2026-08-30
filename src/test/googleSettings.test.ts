import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  loadGoogleSettings,
  saveGoogleSettings,
  resolveGoogleCredentials,
  type GoogleSettings,
} from "../electron/googleSettings.js";
import type { StorageCrypto } from "../electron/googleAuth.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

/** Not real encryption — just reversible enough to prove the plumbing actually calls encrypt on write and decrypt on read. */
const fakeStorageCrypto: StorageCrypto = {
  encrypt: (plainText) => Buffer.from(plainText, "utf-8").toString("base64"),
  decrypt: (cipherText) => Buffer.from(cipherText, "base64").toString("utf-8"),
};

console.log("googleSettings storage:");

async function runStorageTests() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-google-settings-test-"));

  const missing = await loadGoogleSettings(path.join(dir, "nope.json"));
  check("loading a nonexistent file returns null clientId and clientSecret", missing.clientId === null && missing.clientSecret === null);

  const settingsFile = path.join(dir, "googleSettings.json");
  const settings: GoogleSettings = { clientId: "abc.apps.googleusercontent.com", clientSecret: "shh" };
  await saveGoogleSettings(settingsFile, settings);
  const loaded = await loadGoogleSettings(settingsFile);
  check("saved settings round-trip through load (no crypto)", JSON.stringify(loaded) === JSON.stringify(settings));

  const cryptoFile = path.join(dir, "googleSettingsCrypto.json");
  await saveGoogleSettings(cryptoFile, settings, fakeStorageCrypto);
  const onDisk = await fs.readFile(cryptoFile, "utf-8");
  let onDiskIsPlainJson = true;
  try {
    JSON.parse(onDisk);
  } catch {
    onDiskIsPlainJson = false;
  }
  check("with a storageCrypto, the on-disk content is not plain JSON (it was actually transformed)", !onDiskIsPlainJson);
  const loadedWithCrypto = await loadGoogleSettings(cryptoFile, fakeStorageCrypto);
  check("saved-with-crypto settings round-trip through load with the same crypto", JSON.stringify(loadedWithCrypto) === JSON.stringify(settings));
  const loadedWithoutCrypto = await loadGoogleSettings(cryptoFile);
  check("an encrypted file read back without a storageCrypto returns null/null, not a crash", loadedWithoutCrypto.clientId === null && loadedWithoutCrypto.clientSecret === null);

  const corruptFile = path.join(dir, "corrupt.json");
  await fs.writeFile(corruptFile, "{not valid json", "utf-8");
  const loadedCorrupt = await loadGoogleSettings(corruptFile);
  check("a corrupted file returns null/null, not a crash", loadedCorrupt.clientId === null && loadedCorrupt.clientSecret === null);

  await fs.rm(dir, { recursive: true, force: true });
}

await runStorageTests();

console.log("\nresolveGoogleCredentials:");
async function runPrecedenceTests() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-google-settings-test-"));
  const settingsFilePath = path.join(dir, "googleSettings.json");
  const savedId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const savedSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  try {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;

    const emptyResult = await resolveGoogleCredentials(settingsFilePath);
    check(
      "with no env var and no saved settings, resolves to an empty clientId and undefined secret",
      emptyResult.clientId === "" && emptyResult.clientSecret === undefined
    );

    await saveGoogleSettings(settingsFilePath, { clientId: "saved-id", clientSecret: "saved-secret" });
    const fromSettings = await resolveGoogleCredentials(settingsFilePath);
    check(
      "with no env var, falls back to saved settings",
      fromSettings.clientId === "saved-id" && fromSettings.clientSecret === "saved-secret"
    );

    process.env.GOOGLE_OAUTH_CLIENT_ID = "env-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "env-secret";
    const fromEnv = await resolveGoogleCredentials(settingsFilePath);
    check(
      "an explicit env var wins over saved settings",
      fromEnv.clientId === "env-id" && fromEnv.clientSecret === "env-secret"
    );

    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;

    const emptySettingsFile = path.join(dir, "googleSettingsEmpty.json");
    const fromEmbedded = await resolveGoogleCredentials(emptySettingsFile, undefined, "embedded-id");
    check(
      "with no env var and no saved settings, falls back to the embedded default with no secret",
      fromEmbedded.clientId === "embedded-id" && fromEmbedded.clientSecret === undefined
    );

    const fromSettingsOverEmbedded = await resolveGoogleCredentials(settingsFilePath, undefined, "embedded-id");
    check(
      "saved settings win over the embedded default",
      fromSettingsOverEmbedded.clientId === "saved-id" && fromSettingsOverEmbedded.clientSecret === "saved-secret"
    );

    const withNoEmbeddedDefault = await resolveGoogleCredentials(emptySettingsFile, undefined, null);
    check(
      "with no env var, no saved settings, and no embedded default, resolves to an empty clientId",
      withNoEmbeddedDefault.clientId === "" && withNoEmbeddedDefault.clientSecret === undefined
    );
  } finally {
    if (savedId === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    else process.env.GOOGLE_OAUTH_CLIENT_ID = savedId;
    if (savedSecret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    else process.env.GOOGLE_OAUTH_CLIENT_SECRET = savedSecret;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

await runPrecedenceTests();

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
