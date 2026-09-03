#!/usr/bin/env node
// Real tests for scripts/generate-whats-new.mjs's extractLatestEntry — a
// build-tool script, not application code, so it lives here rather than in
// src/test/ (which compiles via tsc); wired into `npm test`'s script chain
// like every other suite, just run directly since there's nothing to
// compile. Same hand-rolled check()/console.log style as every other test
// in this project — no framework.
import { extractLatestEntry } from "./generate-whats-new.mjs";

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

function expectThrows(name, fn, messageIncludes) {
  try {
    fn();
    failures++;
    console.error(`  FAIL - ${name} (did not throw)`);
  } catch (err) {
    check(name, err instanceof Error && err.message.includes(messageIncludes));
  }
}

console.log("extractLatestEntry:");

{
  const changelog = `# Changelog

## v1.2.3 — 2026-01-01

- First bullet, on one line.
- Second bullet wraps across
  two source lines that should
  join into one string.

## v1.2.2 — 2025-12-31

- An older entry that must never be reached.
`;
  const result = extractLatestEntry(changelog);
  check("extracts the newest heading's version", result.version === "1.2.3");
  check("extracts the newest heading's date", result.date === "2026-01-01");
  check("extracts exactly the newest entry's bullets, not the older one's", result.bullets.length === 2);
  check("a single-line bullet is captured verbatim", result.bullets[0] === "First bullet, on one line.");
  check("a multi-line bullet's wrapped continuation joins into one string", result.bullets[1] === "Second bullet wraps across two source lines that should join into one string.");
}

{
  const changelog = `## v0.1.0-beta.23 — 2026-09-03

- Only one bullet here.
`;
  const result = extractLatestEntry(changelog);
  check("a single-bullet entry works (no older entry to accidentally bleed into)", result.bullets.length === 1 && result.bullets[0] === "Only one bullet here.");
}

{
  const changelog = `## v1.0.0 — 2026-01-01

Some text with no bullets at all.
`;
  expectThrows("stray prose with no bullets at all throws (caught as text before the first bullet)", () => extractLatestEntry(changelog), "has body text before its first");
}

{
  const changelog = `## v1.0.0 — 2026-01-01
## v0.9.0 — 2025-12-01

- An older entry's bullet, irrelevant here.
`;
  expectThrows("a heading with a genuinely empty body (nothing before the next heading) throws", () => extractLatestEntry(changelog), "has no");
}

{
  const changelog = `## v1.0.0 — 2026-01-01

- A top-level bullet.
  - An indented sub-bullet, which this generator doesn't support.
`;
  expectThrows("an indented sub-bullet throws instead of silently merging into the previous bullet's text", () => extractLatestEntry(changelog), "indented bullet");
}

{
  const changelog = `No heading here at all, just prose.`;
  expectThrows("a changelog with no '## vX.Y.Z — DATE' heading throws", () => extractLatestEntry(changelog), "No '## vX.Y.Z");
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
