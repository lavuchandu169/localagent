import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { buildFreellmapiBundle } from "./build-freellmapi.mjs";

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("buildFreellmapiBundle:");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

await buildFreellmapiBundle(repoRoot);

const serverOut = path.join(repoRoot, "dist/freellmapi/server.mjs");
check("writes the bundled server file", fs.existsSync(serverOut));

const contents = fs.readFileSync(serverOut, "utf-8");
// esbuild renames the createRequire-derived identifier to avoid collisions
// with its own internal shims (observed in the real bundle as
// `runtimeRequire2("better-sqlite3")`, not a literal `require(...)`), but
// the string argument itself is never renamed — matching any call whose
// sole argument is that exact string is the robust signal that the module
// stayed external instead of being inlined.
check("keeps better-sqlite3 as an external require, not inlined", /\w+\(["']better-sqlite3["']\)/.test(contents));
check("exports startServer", /export\s*\{[^}]*startServer/.test(contents) || /export\s+(async\s+)?function\s+startServer/.test(contents));

// A real Node syntax check catches a genuinely broken bundle (bad esbuild
// config, a missed external) without needing to actually boot the server.
check("the bundle is syntactically valid ESM", (() => {
  try {
    execFileSync(process.execPath, ["--check", serverOut]);
    return true;
  } catch {
    return false;
  }
})());

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
