import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadGeminiSettings, saveGeminiSettings, resolveGeminiApiKey } from "../../electron/geminiSettings.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("Gemini settings:");

{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-gemini-settings-test-"));
  const settingsFile = path.join(tmpDir, "gemini-settings.json");

  const empty = await loadGeminiSettings(settingsFile);
  check("no saved key loads as null with no addedAt", empty.apiKey === null && empty.addedAt === null);

  await saveGeminiSettings(settingsFile, { apiKey: "gk-1" });
  const first = await loadGeminiSettings(settingsFile);
  check("a saved key loads back", first.apiKey === "gk-1");
  check("addedAt is set on first save", typeof first.addedAt === "number");

  await saveGeminiSettings(settingsFile, { apiKey: "gk-2" });
  const second = await loadGeminiSettings(settingsFile);
  check("rotating the key doesn't change addedAt", second.addedAt === first.addedAt);
}

console.log("\nresolveGeminiApiKey:");
{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-gemini-settings-test-"));
  const settingsFile = path.join(tmpDir, "gemini-settings.json");
  const resolved = await resolveGeminiApiKey(settingsFile);
  check("resolves to undefined with nothing saved and no env var", resolved === undefined);

  await saveGeminiSettings(settingsFile, { apiKey: "gk-saved" });
  const resolvedAfterSave = await resolveGeminiApiKey(settingsFile);
  check("resolves to the saved key", resolvedAfterSave === "gk-saved");
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
