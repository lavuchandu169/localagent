import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadOpenAISettings, saveOpenAISettings, resolveOpenAIApiKey } from "../../electron/openaiSettings.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("OpenAI settings:");

{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-openai-settings-test-"));
  const settingsFile = path.join(tmpDir, "openai-settings.json");

  const empty = await loadOpenAISettings(settingsFile);
  check("no saved key loads as null with no addedAt", empty.apiKey === null && empty.addedAt === null);

  await saveOpenAISettings(settingsFile, { apiKey: "sk-1" });
  const first = await loadOpenAISettings(settingsFile);
  check("a saved key loads back", first.apiKey === "sk-1");
  check("addedAt is set on first save", typeof first.addedAt === "number");

  await saveOpenAISettings(settingsFile, { apiKey: "sk-2" });
  const second = await loadOpenAISettings(settingsFile);
  check("rotating the key doesn't change addedAt", second.addedAt === first.addedAt);
}

console.log("\nresolveOpenAIApiKey:");
{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-openai-settings-test-"));
  const settingsFile = path.join(tmpDir, "openai-settings.json");
  const resolved = await resolveOpenAIApiKey(settingsFile);
  check("resolves to undefined with nothing saved and no env var", resolved === undefined);

  await saveOpenAISettings(settingsFile, { apiKey: "sk-saved" });
  const resolvedAfterSave = await resolveOpenAIApiKey(settingsFile);
  check("resolves to the saved key", resolvedAfterSave === "sk-saved");
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
