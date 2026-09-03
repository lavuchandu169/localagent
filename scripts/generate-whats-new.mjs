#!/usr/bin/env node
// Writes src/whatsNew.ts from CHANGELOG.md's newest entry, at build time —
// so the in-app "what's new" modal always matches exactly what shipped in
// this build, with no network fetch needed at runtime (this app is
// local-first; hitting GitHub on every launch just to show a changelog
// would be a real regression). Every release is EXPECTED to bump
// package.json's version and add a matching CHANGELOG.md entry in the
// same commit, but nothing in CI actually checks the two stay in lockstep
// (release.yml's "Verify tag matches package.json version" step only
// checks the git tag against package.json — it never looks at
// CHANGELOG.md at all) — so this script enforces that invariant itself,
// right here, rather than relying on commit discipline alone: a real
// mismatch fails the build loudly instead of silently shipping a modal
// with the wrong version number.
//
// Runs as an early step of `npm run build`, before `tsc` — same position
// and reasoning as generate-embedded-credentials.mjs: it writes a .ts
// SOURCE file that tsc then needs to see when it runs.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const changelogPath = path.join(__dirname, "..", "CHANGELOG.md");
const packageJsonPath = path.join(__dirname, "..", "package.json");
const outFile = path.join(__dirname, "..", "src", "whatsNew.ts");

const HEADING_RE = /^## v(\S+)\s+—\s+(.+)$/;

/**
 * Extracts the newest entry from a CHANGELOG.md-shaped string: the first
 * "## vX.Y.Z — DATE" heading, and every top-level bullet under it (up to
 * the next "## " heading or end of file). A bullet is a line starting with
 * "- " at column 0; any non-blank line immediately following it is that
 * bullet's markdown-wrapped continuation and gets joined back into one
 * string with single spaces, matching how this project's CHANGELOG entries
 * wrap prose across multiple source lines for readability in the raw file.
 *
 * Throws — rather than silently producing something wrong — for two shapes
 * this app's changelog has never used and isn't meant to support: an entry
 * with no bullets at all (the modal would otherwise show an empty list),
 * and an indented line that is ITSELF a bullet (` - like this`), which
 * would otherwise silently get appended as plain text onto the end of the
 * previous bullet instead of being recognized as its own item. Both are a
 * "fix the changelog entry" problem for whoever wrote it, not something
 * this generator should paper over.
 */
export function extractLatestEntry(changelogText) {
  // Normalize CRLF to LF before splitting — confirmed live to matter, not
  // theoretical: a Windows git checkout of this repo converts CHANGELOG.md's
  // committed LF line endings to CRLF, and HEADING_RE's trailing `$` can
  // never match a line ending in a stray `\r` (`.` excludes line-terminator
  // characters, `\r` among them, so `(.+)$` has no way to consume it) —
  // every heading line silently failed to match, "No heading found" even
  // though the file plainly has one. Doing this once, up front, makes the
  // rest of this function's line-based parsing correct on any platform's
  // checkout, not just this generator's own direct callers.
  const lines = changelogText.replace(/\r\n/g, "\n").split("\n");
  const headingIndex = lines.findIndex((line) => HEADING_RE.test(line));
  if (headingIndex === -1) {
    throw new Error("No '## vX.Y.Z — DATE' heading found in CHANGELOG.md");
  }
  const heading = lines[headingIndex].match(HEADING_RE);
  const version = heading[1];
  const date = heading[2];

  let bodyEnd = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      bodyEnd = i;
      break;
    }
  }

  const bullets = [];
  for (let i = headingIndex + 1; i < bodyEnd; i++) {
    const line = lines[i];
    if (line.startsWith("- ")) {
      bullets.push(line.slice(2).trim());
    } else if (line.trim() !== "") {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ")) {
        throw new Error(
          `CHANGELOG.md's newest entry (v${version}) has an indented bullet ("${trimmed}") — this generator only supports flat, top-level bullets. Rewrite it as its own top-level "- " line.`
        );
      }
      if (bullets.length === 0) {
        throw new Error(`CHANGELOG.md's newest entry (v${version}) has body text before its first "- " bullet — expected every entry to start with a bullet list.`);
      }
      // An indented continuation line of the current bullet's wrapped text.
      bullets[bullets.length - 1] += ` ${trimmed}`;
    }
    // Blank lines are pure separators — skipped either way.
  }

  if (bullets.length === 0) {
    throw new Error(`CHANGELOG.md's newest entry (v${version}) has no "- " bullets — the what's new modal needs at least one.`);
  }

  return { version, date, bullets };
}

// Only runs the actual file-reading/writing when invoked directly (`node
// scripts/generate-whats-new.mjs`, which is how `npm run build` calls it)
// — not when this module is merely imported for extractLatestEntry, e.g.
// from generate-whats-new.test.mjs. Without this guard, importing the
// function for testing would also silently re-run the real generation
// step as a side effect of the import itself.
//
// pathToFileURL(process.argv[1]).href, not a raw `file://${process.argv[1]}`
// string — confirmed live to matter, not just theoretical: on Windows,
// process.argv[1] is a backslash path with a drive letter (e.g.
// "D:\a\localagent\localagent\scripts\generate-whats-new.mjs"), which a
// plain template-string concatenation never turns into a real file: URL
// (forward slashes, percent-encoding, triple-slash drive syntax) — so the
// naive comparison against import.meta.url was always false on Windows,
// this guard never ran even on direct invocation, src/whatsNew.ts was
// never written, and the next build step (tsc) failed with "Cannot find
// module '../../whatsNew.js'". pathToFileURL performs that same
// platform-correct conversion Node itself uses, so the comparison is
// exact on every OS.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [changelogText, packageJsonText] = await Promise.all([fs.readFile(changelogPath, "utf-8"), fs.readFile(packageJsonPath, "utf-8")]);
  const entry = extractLatestEntry(changelogText);

  const packageVersion = JSON.parse(packageJsonText).version;
  if (entry.version !== packageVersion) {
    throw new Error(
      `CHANGELOG.md's newest entry is v${entry.version} but package.json's version is ${packageVersion} — these must match. Update whichever one is stale before building.`
    );
  }

  const contents = `// Generated by scripts/generate-whats-new.mjs at build time from CHANGELOG.md — do not edit or commit.
export interface WhatsNewEntry {
  version: string;
  date: string;
  bullets: string[];
}

export const WHATS_NEW: WhatsNewEntry = ${JSON.stringify(entry, null, 2)};
`;

  await fs.writeFile(outFile, contents, "utf-8");
  console.log(`[build] wrote ${path.relative(process.cwd(), outFile)} (version ${entry.version}, ${entry.bullets.length} bullet(s))`);
}
