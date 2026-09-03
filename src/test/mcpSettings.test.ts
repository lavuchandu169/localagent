import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { loadMcpSettings, saveMcpSettings, type McpServerConfig } from "../electron/mcpSettings.js";
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

const sampleServer: McpServerConfig = {
  id: "srv-1",
  name: "github",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { GITHUB_TOKEN: "fake-token" },
  enabled: true,
};

console.log("mcpSettings storage:");

async function run() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-mcp-settings-test-"));

  const missing = await loadMcpSettings(path.join(dir, "nope.json"));
  check("loading a nonexistent file returns an empty array", Array.isArray(missing) && missing.length === 0);

  const settingsFile = path.join(dir, "mcpServers.json");
  await saveMcpSettings(settingsFile, [sampleServer]);
  const loaded = await loadMcpSettings(settingsFile);
  check("saved settings round-trip through load (no crypto)", JSON.stringify(loaded) === JSON.stringify([sampleServer]));

  const cryptoFile = path.join(dir, "mcpServersCrypto.json");
  await saveMcpSettings(cryptoFile, [sampleServer], fakeStorageCrypto);
  const onDisk = await fs.readFile(cryptoFile, "utf-8");
  let onDiskIsPlainJson = true;
  try {
    JSON.parse(onDisk);
  } catch {
    onDiskIsPlainJson = false;
  }
  check("with a storageCrypto, the on-disk content is not plain JSON (it was actually transformed)", !onDiskIsPlainJson);
  const loadedWithCrypto = await loadMcpSettings(cryptoFile, fakeStorageCrypto);
  check("saved-with-crypto settings round-trip through load with the same crypto", JSON.stringify(loadedWithCrypto) === JSON.stringify([sampleServer]));
  const loadedWithoutCrypto = await loadMcpSettings(cryptoFile);
  check("an encrypted file read back without a storageCrypto returns an empty array, not a crash", loadedWithoutCrypto.length === 0);

  const corruptFile = path.join(dir, "corrupt.json");
  await fs.writeFile(corruptFile, "{not valid json", "utf-8");
  const loadedCorrupt = await loadMcpSettings(corruptFile);
  check("a corrupted file returns an empty array, not a crash", loadedCorrupt.length === 0);

  const malformedFile = path.join(dir, "malformed.json");
  await fs.writeFile(malformedFile, JSON.stringify([sampleServer, { id: "srv-2", name: "broken" /* missing command/args/env/enabled */ }]), "utf-8");
  const loadedMalformed = await loadMcpSettings(malformedFile);
  check("an entry missing required fields is dropped, valid entries are kept", loadedMalformed.length === 1 && loadedMalformed[0]!.id === "srv-1");

  const notAnArrayFile = path.join(dir, "not-an-array.json");
  await fs.writeFile(notAnArrayFile, JSON.stringify({ id: "srv-1" }), "utf-8");
  const loadedNotArray = await loadMcpSettings(notAnArrayFile);
  check("a top-level object instead of an array returns an empty array, not a crash", loadedNotArray.length === 0);

  await fs.rm(dir, { recursive: true, force: true });
}

await run();

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
