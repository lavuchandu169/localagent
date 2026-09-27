#!/usr/bin/env node
// Real tests for scripts/bump-version.mjs's pure functions — a build-tool
// script, not application code, so it lives here rather than in src/test/
// (which compiles via tsc). Same hand-rolled check()/console.log style as
// every other test in this project — no framework. Wired into `npm
// test`'s script chain like generate-whats-new.test.mjs.
import { bumpVersion, formatChangelogEntry, insertChangelogEntry } from "./bump-version.mjs";

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

console.log("bumpVersion:");

check("'beta' increments the trailing beta number", bumpVersion("0.1.0-beta.45", "beta") === "0.1.0-beta.46");
check("'beta' works from beta.9 to beta.10 (no lexicographic surprises)", bumpVersion("0.1.0-beta.9", "beta") === "0.1.0-beta.10");
check("'patch' drops the beta suffix and bumps patch", bumpVersion("0.1.0-beta.45", "patch") === "0.1.1");
check("'minor' drops the beta suffix, bumps minor, resets patch", bumpVersion("0.1.5-beta.3", "minor") === "0.2.0");
check("'major' drops the beta suffix, bumps major, resets minor and patch", bumpVersion("0.1.5-beta.3", "major") === "1.0.0");
check("'patch' also works from an already-plain version", bumpVersion("1.2.3", "patch") === "1.2.4");

expectThrows(
  "'beta' on a version with no beta suffix throws instead of guessing",
  () => bumpVersion("1.2.3", "beta"),
  "has no \"-beta.N\" suffix"
);
expectThrows("an unrecognized version shape throws", () => bumpVersion("not-a-version", "patch"), "isn't a recognized version shape");
expectThrows("an unknown bump type throws", () => bumpVersion("0.1.0-beta.45", "sideways"), 'unknown bump type "sideways"');

console.log("\nformatChangelogEntry:");

{
  const entry = formatChangelogEntry("0.1.0-beta.46", "2026-09-27", "Did the thing.");
  check("single-line input becomes a heading plus one bullet", entry === "## v0.1.0-beta.46 — 2026-09-27\n\n- Did the thing.\n");
}

{
  const entry = formatChangelogEntry("0.1.0-beta.46", "2026-09-27", "First thing.\nSecond thing.\n\n  Third thing, with stray whitespace.  ");
  check(
    "each non-empty input line becomes its own bullet, blank lines skipped, and whitespace is trimmed",
    entry === "## v0.1.0-beta.46 — 2026-09-27\n\n- First thing.\n- Second thing.\n- Third thing, with stray whitespace.\n"
  );
}

expectThrows("empty entry text throws instead of writing a bullet-less heading", () => formatChangelogEntry("1.0.0", "2026-01-01", "   \n\n  "), "no non-empty lines");

console.log("\ninsertChangelogEntry:");

{
  const existing = `# Changelog

All notable changes to localagent are documented here, newest first.

## v0.1.0-beta.45 — 2026-09-15

- Something that already shipped.
`;
  const newEntry = "## v0.1.0-beta.46 — 2026-09-27\n\n- The new thing.\n";
  const result = insertChangelogEntry(existing, newEntry);
  check(
    "the new entry lands directly above the previous newest entry, with the intro paragraph preserved above both",
    result ===
      `# Changelog

All notable changes to localagent are documented here, newest first.

## v0.1.0-beta.46 — 2026-09-27

- The new thing.

## v0.1.0-beta.45 — 2026-09-15

- Something that already shipped.
`
  );
}

expectThrows("a changelog with no '## v' heading at all throws", () => insertChangelogEntry("# Changelog\n\nNo entries yet.\n", "## v1.0.0 — 2026-01-01\n\n- x\n"), "couldn't find an existing");

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
