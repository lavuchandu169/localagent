#!/usr/bin/env node
// Real tests for scripts/run-tests.mjs's pure functions — a build-tool
// script, not application code, so it lives here rather than in src/test/
// (which compiles via tsc). Same hand-rolled check()/console.log style as
// every other test in this project — no framework.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectFilesRecursive, summarizeResults } from "./run-tests.mjs";

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("collectFilesRecursive:");

{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "run-tests-test-"));
  try {
    await fs.mkdir(path.join(root, "electron"), { recursive: true });
    await fs.mkdir(path.join(root, "providers"), { recursive: true });
    await fs.writeFile(path.join(root, "top.test.js"), "");
    await fs.writeFile(path.join(root, "electron", "nested.test.js"), "");
    await fs.writeFile(path.join(root, "providers", "nested2.test.js"), "");
    // Not a .test.js file — must be excluded.
    await fs.writeFile(path.join(root, "electron", "helper.js"), "");

    const found = collectFilesRecursive(root, ".test.js");
    const relative = found.map((f) => path.relative(root, f)).sort();
    check(
      "finds every matching file at every depth, mirroring a multi-level domain split, and excludes non-matching files",
      JSON.stringify(relative) === JSON.stringify([path.join("electron", "nested.test.js"), path.join("providers", "nested2.test.js"), "top.test.js"])
    );
    check("the result is sorted for a deterministic run order", JSON.stringify(found) === JSON.stringify([...found].sort()));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

{
  const missing = path.join(os.tmpdir(), "run-tests-test-does-not-exist-" + Date.now());
  check("a directory that doesn't exist returns an empty list rather than throwing", JSON.stringify(collectFilesRecursive(missing, ".test.js")) === "[]");
}

console.log("\nsummarizeResults:");

{
  const summary = summarizeResults([
    { file: "a.test.js", exitCode: 0 },
    { file: "b.test.js", exitCode: 0 },
  ]);
  check("all-zero exit codes report allPassed with no failures", summary.allPassed === true && summary.failed.length === 0 && summary.total === 2);
}

{
  const summary = summarizeResults([
    { file: "a.test.js", exitCode: 0 },
    { file: "b.test.js", exitCode: 1 },
    { file: "c.test.js", exitCode: 1 },
  ]);
  check(
    "a nonzero exit code marks that file as failed, by name, without stopping at the first one",
    summary.allPassed === false && JSON.stringify(summary.failed) === JSON.stringify(["b.test.js", "c.test.js"]) && summary.total === 3
  );
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
