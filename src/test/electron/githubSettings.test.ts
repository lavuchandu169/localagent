// src/test/githubSettings.test.ts
import { loadGithubSettings, saveGithubSettings, resolveGithubClientId } from "../../electron/githubSettings.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

async function withTempFile<T>(fn: (filePath: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-github-settings-test-"));
  const filePath = path.join(dir, "githubSettings.json");
  try {
    return await fn(filePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

console.log("loadGithubSettings/saveGithubSettings:");
await withTempFile(async (filePath) => {
  const before = await loadGithubSettings(filePath);
  check("defaults to null clientId when no file exists", before.clientId === null);

  await saveGithubSettings(filePath, { clientId: "user-entered-id" });
  const after = await loadGithubSettings(filePath);
  check("round-trips a saved clientId", after.clientId === "user-entered-id");
});

console.log("\nresolveGithubClientId precedence:");
await withTempFile(async (filePath) => {
  const noneConfigured = await resolveGithubClientId(filePath, undefined, null);
  check("falls back to empty string when nothing is configured anywhere", noneConfigured === "");

  const embeddedOnly = await resolveGithubClientId(filePath, undefined, "embedded-id");
  check("uses the embedded id when Settings has none", embeddedOnly === "embedded-id");

  await saveGithubSettings(filePath, { clientId: "settings-id" });
  const settingsOverEmbedded = await resolveGithubClientId(filePath, undefined, "embedded-id");
  check("a saved Settings value beats the embedded default", settingsOverEmbedded === "settings-id");

  const originalEnv = process.env.GITHUB_OAUTH_CLIENT_ID;
  process.env.GITHUB_OAUTH_CLIENT_ID = "env-id";
  try {
    const envOverridesAll = await resolveGithubClientId(filePath, undefined, "embedded-id");
    check("an env var beats both Settings and the embedded default", envOverridesAll === "env-id");
  } finally {
    if (originalEnv === undefined) delete process.env.GITHUB_OAUTH_CLIENT_ID;
    else process.env.GITHUB_OAUTH_CLIENT_ID = originalEnv;
  }
});

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
