import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkSubmoduleFiles } from "./verify-freellmapi-submodule.mjs";

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("checkSubmoduleFiles:");

{
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const root = path.join(__dirname, "..");
  const result = checkSubmoduleFiles(root);
  check("finds every expected vendored file", result.missing.length === 0);
  check("returns the exact list it checked, for a useful error message", result.checked.length === 8);
}

{
  const result = checkSubmoduleFiles("/tmp/definitely-does-not-exist-xyz");
  check("an empty/missing submodule reports every expected file as missing", result.missing.length === 8);
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
