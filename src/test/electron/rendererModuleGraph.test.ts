// The renderer loads renderer.js as a native browser ES module
// (`<script type="module" src="./renderer.js">`, see index.html) with no
// bundler and no import map. Every import reachable from that entry point
// must therefore be a relative specifier the browser can fetch as a file
// — a bare specifier (an npm package, or a Node builtin like "node:fs")
// is not a URL the browser can resolve, and Chromium's module loader
// fails the *entire* graph when one import can't be resolved, not just
// the one module that needed it. That failure shows up as a silent
// console error (not a catchable exception), so the whole renderer.js
// module — every top-level side effect, every addEventListener — simply
// never runs. This happened for real: organizationPanel.ts picked up a
// value import (not just `import type`) of `buildInitiativeTask` from
// organization.ts, which imports "node:fs"/"node:path" at module scope,
// and the running app's model dropdown silently had zero options with
// every button dead, in a way no existing unit test caught (they all run
// the compiled JS directly under Node, where "node:fs" resolves fine).
// This test walks the actual compiled output's import graph the way the
// browser does, so a renderer module gaining a transitive dependency on a
// Node builtin or an unbundled package fails the build instead of the app.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(__dirname, "../../electron/renderer");
const entry = path.join(rendererDir, "renderer.js");

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

/** Every `from "..."` (static or re-export) and `import("...")` (dynamic) specifier in a file's text. Regex over the compiled JS rather than a real parser — this codebase's existing test-time checks (e.g. aboutPanel.test.ts's index.html check) take the same lightweight approach for a repo-shape assertion like this one. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const m of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) if (m[1]) specifiers.push(m[1]);
  for (const m of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) if (m[1]) specifiers.push(m[1]);
  return specifiers;
}

function walk(): { visited: Set<string>; violations: { file: string; specifier: string }[] } {
  const visited = new Set<string>();
  const violations: { file: string; specifier: string }[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = fs.readFileSync(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) {
        violations.push({ file, specifier });
        continue;
      }
      const resolved = path.normalize(path.join(path.dirname(file), specifier));
      if (!visited.has(resolved)) queue.push(resolved);
    }
  }
  return { visited, violations };
}

console.log("renderer module graph (loaded as native ES modules, no bundler):");
{
  check("the compiled renderer entry point exists", fs.existsSync(entry));
}
{
  const { visited, violations } = walk();
  check("walks more than just the entry file (the graph is actually connected)", visited.size > 5);
  check(
    "every reachable import is a relative specifier — no bare package or Node builtin the browser can't resolve" +
      (violations.length > 0
        ? ": " + violations.map((v) => `${path.relative(rendererDir, v.file)} imports "${v.specifier}"`).join(", ")
        : ""),
    violations.length === 0
  );
}

if (failures > 0) {
  console.error(`${failures} failure(s).`);
  process.exit(1);
} else {
  console.log("All tests passed.");
}
