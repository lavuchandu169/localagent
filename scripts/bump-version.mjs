#!/usr/bin/env node
// Computes the next release version and formats a new CHANGELOG.md entry
// — used by .github/workflows/cut-release.yml to automate the one manual
// step CONTRIBUTING.md's release process used to require by hand: bump
// package.json's version, add a matching CHANGELOG.md entry, push a
// vX.Y.Z tag. Pure functions here, a thin CLI-mutation block below,
// mirroring generate-whats-new.mjs's own split (see its test file for
// the same pattern — this script's test lives alongside it the same way).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BETA_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/;
const PLAIN_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Every release so far has bumped the trailing beta number
 * (0.1.0-beta.N → 0.1.0-beta.N+1) — "beta" does exactly that, and is the
 * only bump type any release has ever used. The other three exist for
 * whenever this project eventually leaves beta: each drops the "-beta.N"
 * suffix and bumps the matching semver segment (resetting the segments
 * below it to 0, standard semver behavior).
 */
export function bumpVersion(currentVersion, bumpType) {
  const betaMatch = currentVersion.match(BETA_VERSION_RE);
  const plainMatch = currentVersion.match(PLAIN_VERSION_RE);
  const match = betaMatch ?? plainMatch;
  if (!match) {
    throw new Error(`bumpVersion: "${currentVersion}" isn't a recognized version shape (expected "X.Y.Z" or "X.Y.Z-beta.N")`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  if (bumpType === "beta") {
    if (!betaMatch) {
      throw new Error(
        `bumpVersion: "${currentVersion}" has no "-beta.N" suffix to bump — use "patch"/"minor"/"major" to start a new beta line, or pass an already-beta version.`
      );
    }
    const beta = Number(betaMatch[4]);
    return `${major}.${minor}.${patch}-beta.${beta + 1}`;
  }
  if (bumpType === "patch") return `${major}.${minor}.${patch + 1}`;
  if (bumpType === "minor") return `${major}.${minor + 1}.0`;
  if (bumpType === "major") return `${major + 1}.0.0`;
  throw new Error(`bumpVersion: unknown bump type "${bumpType}" — expected "beta", "patch", "minor", or "major".`);
}

/**
 * Formats one CHANGELOG.md entry exactly as generate-whats-new.mjs's
 * extractLatestEntry expects to parse it back: a "## vX.Y.Z — DATE"
 * heading, then one flat "- " bullet per non-empty input line. The
 * source text is trusted to already be one bullet per line — no wrapping
 * or re-flowing happens here.
 */
export function formatChangelogEntry(version, date, rawEntryText) {
  const bullets = rawEntryText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (bullets.length === 0) {
    throw new Error("formatChangelogEntry: the changelog entry text has no non-empty lines to turn into bullets.");
  }
  const bulletLines = bullets.map((b) => `- ${b}`).join("\n");
  return `## v${version} — ${date}\n\n${bulletLines}\n`;
}

/**
 * Inserts a freshly-formatted entry immediately before the changelog's
 * current newest entry (its first "## v" heading), preserving the intro
 * paragraph above it and the blank-line spacing every existing entry uses.
 */
export function insertChangelogEntry(existingChangelogText, newEntryText) {
  const headingIndex = existingChangelogText.indexOf("\n## v");
  if (headingIndex === -1) {
    throw new Error("insertChangelogEntry: couldn't find an existing '## v' entry in CHANGELOG.md to insert the new one before.");
  }
  const insertAt = headingIndex + 1;
  return existingChangelogText.slice(0, insertAt) + newEntryText + "\n" + existingChangelogText.slice(insertAt);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bumpType = process.argv[2] ?? "beta";
  const changelogEntryText = process.env.CHANGELOG_ENTRY;
  if (!changelogEntryText || changelogEntryText.trim() === "") {
    throw new Error("bump-version.mjs: the CHANGELOG_ENTRY env var is required and must be non-empty.");
  }

  const packageJsonPath = path.join(__dirname, "..", "package.json");
  const changelogPath = path.join(__dirname, "..", "CHANGELOG.md");

  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf-8"));
  const nextVersion = bumpVersion(packageJson.version, bumpType);
  packageJson.version = nextVersion;
  await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf-8");

  const date = new Date().toISOString().slice(0, 10);
  const newEntry = formatChangelogEntry(nextVersion, date, changelogEntryText);
  const existingChangelog = await fs.readFile(changelogPath, "utf-8");
  await fs.writeFile(changelogPath, insertChangelogEntry(existingChangelog, newEntry), "utf-8");

  console.log(`[bump-version] bumped package.json and CHANGELOG.md to v${nextVersion}`);
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, `version=${nextVersion}\n`, "utf-8");
  }
}
