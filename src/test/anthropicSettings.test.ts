import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { loadAnthropicSettings, saveAnthropicSettings, resolveAnthropicApiKey, type AnthropicSettings } from "../electron/anthropicSettings.js";
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

console.log("anthropicSettings storage:");

async function runStorageTests() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-anthropic-settings-test-"));

  const missing = await loadAnthropicSettings(path.join(dir, "nope.json"));
  check("loading a nonexistent file returns null apiKey", missing.apiKey === null);

  const settingsFile = path.join(dir, "anthropicSettings.json");
  const settings: AnthropicSettings = { apiKey: "sk-ant-fake-key" };
  await saveAnthropicSettings(settingsFile, settings);
  const loaded = await loadAnthropicSettings(settingsFile);
  check("saved settings round-trip through load (no crypto)", JSON.stringify(loaded) === JSON.stringify(settings));

  const cryptoFile = path.join(dir, "anthropicSettingsCrypto.json");
  await saveAnthropicSettings(cryptoFile, settings, fakeStorageCrypto);
  const onDisk = await fs.readFile(cryptoFile, "utf-8");
  let onDiskIsPlainJson = true;
  try {
    JSON.parse(onDisk);
  } catch {
    onDiskIsPlainJson = false;
  }
  check("with a storageCrypto, the on-disk content is not plain JSON (it was actually transformed)", !onDiskIsPlainJson);
  const loadedWithCrypto = await loadAnthropicSettings(cryptoFile, fakeStorageCrypto);
  check("saved-with-crypto settings round-trip through load with the same crypto", JSON.stringify(loadedWithCrypto) === JSON.stringify(settings));
  const loadedWithoutCrypto = await loadAnthropicSettings(cryptoFile);
  check("an encrypted file read back without a storageCrypto returns null, not a crash", loadedWithoutCrypto.apiKey === null);

  const corruptFile = path.join(dir, "corrupt.json");
  await fs.writeFile(corruptFile, "{not valid json", "utf-8");
  const loadedCorrupt = await loadAnthropicSettings(corruptFile);
  check("a corrupted file returns null, not a crash", loadedCorrupt.apiKey === null);

  await fs.rm(dir, { recursive: true, force: true });
}

await runStorageTests();

console.log("\nresolveAnthropicApiKey:");
async function runPrecedenceTests() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-anthropic-settings-test-"));
  const settingsFilePath = path.join(dir, "anthropicSettings.json");
  const savedKey = process.env.ANTHROPIC_API_KEY;
  try {
    delete process.env.ANTHROPIC_API_KEY;

    const emptyResult = await resolveAnthropicApiKey(settingsFilePath);
    check("with no env var and no saved settings, resolves to undefined", emptyResult === undefined);

    await saveAnthropicSettings(settingsFilePath, { apiKey: "sk-ant-saved-key" });
    const fromSettings = await resolveAnthropicApiKey(settingsFilePath);
    check("with no env var, falls back to the saved key", fromSettings === "sk-ant-saved-key");

    process.env.ANTHROPIC_API_KEY = "sk-ant-env-key";
    const fromEnv = await resolveAnthropicApiKey(settingsFilePath);
    check("an explicit env var wins over the saved key", fromEnv === "sk-ant-env-key");
  } finally {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

await runPrecedenceTests();

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
