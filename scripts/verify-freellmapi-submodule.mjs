// Confirms the vendored FreeLLMAPI submodule (see .gitmodules) actually
// checked out — a shallow clone, a fresh checkout that skipped
// `git submodule update --init`, or a bad pin all leave vendor/freellmapi/
// present but empty or wrong, which every later build/host step depends on
// silently working. This is the one place that fails loudly and early.
import fs from "node:fs";
import path from "node:path";

const EXPECTED_RELATIVE_PATHS = [
  "vendor/freellmapi/LICENSE",
  "vendor/freellmapi/server/package.json",
  "vendor/freellmapi/shared/package.json",
  "vendor/freellmapi/client/package.json",
  "vendor/freellmapi/desktop/src/server-host.ts",
  "vendor/freellmapi/desktop/src/window.ts",
  "vendor/freellmapi/desktop/src/preload.ts",
  "vendor/freellmapi/desktop/scripts/bundle-server.mjs",
];

export function checkSubmoduleFiles(repoRoot) {
  const checked = EXPECTED_RELATIVE_PATHS.map((p) => path.join(repoRoot, p));
  const missing = checked.filter((p) => !fs.existsSync(p));
  return { checked, missing };
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const repoRoot = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
  const { missing } = checkSubmoduleFiles(repoRoot);
  if (missing.length > 0) {
    console.error(
      `[verify-freellmapi-submodule] Missing ${missing.length} expected vendored file(s):\n` +
        missing.map((p) => `  - ${p}`).join("\n") +
        `\nRun: git submodule update --init --recursive`
    );
    process.exit(1);
  }
  console.log("[verify-freellmapi-submodule] vendor/freellmapi is present and checked out correctly.");
}
