#!/usr/bin/env node
// Real tests for scripts/generate-third-party-notices.mjs's buildNoticesMarkdown
// — a build-tool script, not application code, so it lives here rather than in
// src/test/ (which compiles via tsc). Same hand-rolled check()/console.log
// style as every other test in this project — no framework.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildNoticesMarkdown } from "./generate-third-party-notices.mjs";

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("buildNoticesMarkdown:");

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tpn-test-"));
const realLicensePath = path.join(tmpDir, "LICENSE");
await fs.writeFile(realLicensePath, "MIT License text goes here.", "utf-8");

{
  const md = await buildNoticesMarkdown({
    "some-pkg@1.2.3": { licenses: "MIT", repository: "https://example.com/some-pkg", licenseFile: realLicensePath },
  });
  check("includes the package name and version as a heading", md.includes("## some-pkg@1.2.3"));
  check("includes the declared license", md.includes("**License:** MIT"));
  check("includes the repository link", md.includes("https://example.com/some-pkg"));
  check("includes the real license text read from disk", md.includes("MIT License text goes here."));
}

{
  const md = await buildNoticesMarkdown({
    "no-file-pkg@2.0.0": { licenses: "ISC", repository: "https://example.com/no-file-pkg" },
  });
  check(
    "a package with no licenseFile at all gets an honest fallback note, not fabricated text",
    md.includes('declared license is "ISC"') && md.includes("https://example.com/no-file-pkg")
  );
}

{
  const md = await buildNoticesMarkdown({
    "simple-git@3.36.0": { licenses: "MIT", repository: "https://github.com/steveukx/git-js" },
  });
  check(
    "a known missing-license-file package (simple-git) uses its specific fallback note",
    md.includes("does not ship a separate license file") && md.includes("Steve King")
  );
}

{
  const nonexistentPath = path.join(tmpDir, "does-not-exist-LICENSE");
  const md = await buildNoticesMarkdown({
    "broken-path-pkg@1.0.0": { licenses: "MIT", licenseFile: nonexistentPath },
  });
  check(
    "a licenseFile path that can't actually be read falls back gracefully instead of throwing",
    md.includes("## broken-path-pkg@1.0.0") && md.includes("No bundled license file found")
  );
}

{
  const readmePath = path.join(tmpDir, "readme.md");
  await fs.writeFile(readmePath, "x".repeat(5000), "utf-8");
  const md = await buildNoticesMarkdown({
    "readme-only-pkg@1.0.0": { licenses: "MIT", licenseFile: readmePath },
  });
  check(
    "a huge README.md standing in for a real license file is treated as missing, not dumped in full",
    !md.includes("x".repeat(5000)) && md.includes("No bundled license file found")
  );
}

{
  const md = await buildNoticesMarkdown({
    "localagent@0.1.0": { licenses: "UNLICENSED" },
    "real-dep@1.0.0": { licenses: "MIT", licenseFile: realLicensePath },
  });
  check("the project's own root package entry is excluded from the notices", !md.includes("## localagent@0.1.0"));
  check("a real third-party dependency is still included", md.includes("## real-dep@1.0.0"));
}

{
  const md = await buildNoticesMarkdown({
    "zzz-last@1.0.0": { licenses: "MIT", licenseFile: realLicensePath },
    "aaa-first@1.0.0": { licenses: "MIT", licenseFile: realLicensePath },
  });
  check("entries are sorted alphabetically by package name", md.indexOf("aaa-first") < md.indexOf("zzz-last"));
}

await fs.rm(tmpDir, { recursive: true, force: true });

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
