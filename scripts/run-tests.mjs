#!/usr/bin/env node
// Runs every compiled test file under dist/test/ (recursively, so the
// src/test/{core,electron,providers,tools}/ domain split needs no listing
// here) plus every scripts/*.test.mjs, and reports a single pass/fail
// verdict. Replaces what used to be a single hand-maintained `"test"`
// script in package.json: one giant `node dist/test/a.test.js && node
// dist/test/b.test.js && ...` chain that every new test file had to be
// manually appended to. That chain had already silently dropped two script
// tests (scripts/build-freellmapi.test.mjs and
// scripts/verify-freellmapi-submodule.test.mjs were never in it) — a
// coverage gap auto-discovery makes structurally impossible, since adding
// a test file is now sufficient on its own for it to run.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

/** Recursively collects every file under `dir` whose name ends with `suffix`, sorted for deterministic run order. Returns [] for a directory that doesn't exist, rather than throwing — callers decide whether an empty result is itself an error. */
export function collectFilesRecursive(dir, suffix) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const results = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...collectFilesRecursive(full, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) results.push(full);
  }
  return results.sort();
}

/** Pure summary of a completed run — kept separate from the actual spawning so it's testable without running real child processes. */
export function summarizeResults(results) {
  const failed = results.filter((r) => r.exitCode !== 0).map((r) => r.file);
  return { total: results.length, failed, allPassed: failed.length === 0 };
}

// Only runs the actual test sweep when invoked directly (`node
// scripts/run-tests.mjs`, which is how `npm test` calls it) — not when
// this module is merely imported for collectFilesRecursive/
// summarizeResults, e.g. from run-tests.test.mjs. pathToFileURL(...).href
// rather than a raw string comparison — see generate-whats-new.mjs's own
// doc comment on this same guard for why that matters on Windows.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const testFiles = [
    ...collectFilesRecursive(path.join(repoRoot, "dist", "test"), ".test.js"),
    ...collectFilesRecursive(path.join(repoRoot, "scripts"), ".test.mjs"),
  ];

  if (testFiles.length === 0) {
    console.error("No test files found under dist/test/**/*.test.js or scripts/*.test.mjs — did `npm run build` run first?");
    process.exit(1);
  }

  const results = testFiles.map((file) => {
    console.log(`\n--- ${path.relative(repoRoot, file)} ---`);
    const { status } = spawnSync(process.execPath, [file], { stdio: "inherit" });
    // spawnSync's status is null only if the process was killed by a signal
    // rather than exiting normally — treated as a failure, same as any
    // other nonzero exit.
    return { file: path.relative(repoRoot, file), exitCode: status ?? 1 };
  });

  const summary = summarizeResults(results);
  console.log(`\n${"=".repeat(60)}`);
  if (summary.allPassed) {
    console.log(`All ${summary.total} test file(s) passed.`);
    process.exit(0);
  } else {
    console.log(`${summary.failed.length}/${summary.total} test file(s) failed:`);
    for (const f of summary.failed) console.log(`  - ${f}`);
    process.exit(1);
  }
}
