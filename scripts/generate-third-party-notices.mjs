#!/usr/bin/env node
// Writes THIRD-PARTY-NOTICES.md from the current production dependency
// tree — same "derive it at build time, never hand-maintain it" pattern
// as generate-whats-new.mjs. localagent's own license (see LICENSE) is
// proprietary, but the app bundles ~200 permissively-licensed open-source
// packages (MIT/BSD/Apache/ISC/Unlicense/OFL for the 3 fonts) — every one
// of those licenses requires reproducing its copyright notice and license
// text when the software is redistributed, even packaged as a compiled
// proprietary app. This file is how that requirement gets satisfied,
// regenerated fresh whenever the dependency tree changes rather than
// drifting out of sync with a hand-maintained one.
//
// devDependencies (electron-builder, typescript's own dev usage, this
// script's own license-checker-rseidelsohn, etc.) are deliberately
// excluded — they never ship inside the packaged app, so they carry no
// redistribution obligation.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { init as initLicenseChecker } from "license-checker-rseidelsohn";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

// A handful of real, well-known packages ship no separate LICENSE file in
// their published npm tarball even though package.json declares one —
// confirmed by hand for each entry here, not guessed. Recording the
// declared license and a pointer to the upstream repo for these instead
// of fabricating license text this script has no way to verify.
const KNOWN_MISSING_LICENSE_FILE = {
  "simple-git": { license: "MIT", author: "Steve King <steve@mydev.co>", repository: "https://github.com/steveukx/git-js" },
  "@simple-git/args-pathspec": { license: "MIT", author: "Steve King <steve@mydev.co>", repository: "https://github.com/steveukx/git-js" },
  "@simple-git/argv-parser": { license: "MIT", author: "Steve King <steve@mydev.co>", repository: "https://github.com/steveukx/git-js" },
};

function packageNameFrom(key) {
  // license-checker keys are "name@version" - name itself may contain "@"
  // (scoped packages), so split on the LAST "@".
  const at = key.lastIndexOf("@");
  return key.slice(0, at);
}

/** Renders one package's own heading/license block — shared by the main dependency list and a vendored project's own sub-dependency list, since both need identical file-reading and fallback behavior. */
async function renderPackageEntry(key, info) {
  const name = packageNameFrom(key);
  const licenseLine = info.licenses ?? "UNKNOWN";
  const repoLine = info.repository ? `  ·  **Repository:** ${info.repository}` : "";
  const lines = [`## ${key}`, "", `**License:** ${licenseLine}${repoLine}`, ""];

  let text = null;
  if (info.licenseFile) {
    try {
      const raw = await fs.readFile(info.licenseFile, "utf-8");
      // license-checker sometimes points at README.md when a package has
      // no separate LICENSE file at all - a huge non-license readme is
      // worse than no text, so it's treated the same as "missing" below.
      const looksLikeReadme = /readme/i.test(path.basename(info.licenseFile));
      if (!(looksLikeReadme && raw.length > 4000)) {
        text = raw.trim();
      }
    } catch {
      text = null;
    }
  }

  if (text) {
    lines.push("```", text, "```", "");
  } else if (KNOWN_MISSING_LICENSE_FILE[name]) {
    const fallback = KNOWN_MISSING_LICENSE_FILE[name];
    lines.push(
      "_This package does not ship a separate license file in its published npm package._",
      `Declared license: ${fallback.license}. Author: ${fallback.author}. See ${fallback.repository} for the canonical license text.`,
      ""
    );
  } else {
    lines.push(
      `_No bundled license file found for this package — declared license is "${licenseLine}". See its repository for the canonical text.${info.repository ? ` (${info.repository})` : ""}_`,
      ""
    );
  }

  return lines;
}

export async function buildNoticesMarkdown(packages, vendoredProjects = []) {
  // Exclude this project's own root entry - license-checker's tree walk
  // includes it, but it isn't a third-party dependency of itself.
  const entries = Object.entries(packages)
    .filter(([key]) => packageNameFrom(key) !== "localagent")
    .sort(([a], [b]) => a.localeCompare(b));

  const lines = [
    "# Third-Party Notices",
    "",
    "localagent is proprietary software (see [LICENSE](LICENSE)), but it is built on",
    `${entries.length} open-source packages, listed below with their license text. All of`,
    "localagent's own direct and transitive dependencies are permissively licensed (MIT,",
    "BSD, Apache-2.0, ISC, Unlicense, BlueOak-1.0.0, or the SIL Open Font License for the",
    "three bundled fonts) - none require this project's own source to be disclosed or",
    "relicensed.",
    "",
    `This file also lists ${vendoredProjects.length} vendored project(s) bundled into the app, each with`,
    "its own license and (where applicable) its own dependency tree - those may include",
    "other license types (e.g. LGPL for a native library one vendored project depends on);",
    "check each vendored section's own entries rather than assuming they match the",
    "guarantee above, which covers localagent's own dependency list only.",
    "",
    "This file exists to satisfy each package's own attribution requirement:",
    "reproducing its copyright notice and license text.",
    "",
    "Generated by `scripts/generate-third-party-notices.mjs` from the real production",
    "dependency tree (`npm run build`) - do not hand-edit; it will be overwritten.",
    "",
    "---",
    "",
  ];

  // Vendored (git-submodule) projects never appear in a node_modules walk
  // at all - license-checker only ever sees real npm dependencies - so
  // they're listed separately, up front, from whatever the caller passes
  // in (see the CLI block below for the real FreeLLMAPI entry).
  for (const project of vendoredProjects) {
    lines.push(`## ${project.name} (vendored)`, "", `**Repository:** ${project.repository}`, "");
    try {
      const text = (await fs.readFile(project.licenseFile, "utf-8")).trim();
      lines.push("```", text, "```", "");
    } catch {
      lines.push(`_Could not read the license file at ${project.licenseFile}._`, "");
    }

    // A vendored project's OWN dependencies (e.g. FreeLLMAPI's client build
    // bundles React, its server bundle inlines whatever it depends on) ship
    // inside the packaged app exactly like a direct localagent dependency
    // would - Vite/esbuild bundling doesn't remove the attribution
    // requirement, it just means license-checker can't find this code by
    // walking localagent's OWN node_modules. Kept as their own subsection
    // (not merged into the flat top-level list below) so provenance stays
    // clear: these ship because of the vendored feature, not localagent's
    // own direct choice. No cross-list dedup against the main entries below
    // - a package used by both simply appears twice, which is harmless for
    // a generated compliance document.
    const subDependencies = Object.entries(project.dependencies ?? {}).sort(([a], [b]) => a.localeCompare(b));
    if (subDependencies.length > 0) {
      lines.push(`### ${project.name}'s own dependencies`, "");
      for (const [key, info] of subDependencies) {
        lines.push(...(await renderPackageEntry(key, info)));
      }
    }
  }

  for (const [key, info] of entries) {
    lines.push(...(await renderPackageEntry(key, info)));
  }

  return lines.join("\n");
}

// FreeLLMAPI's own workspace packages (npm workspaces: shared/server/client/cli
// - confirmed by reading vendor/freellmapi/package.json directly). Three are
// marked private (excludePrivatePackages handles those), but cli publishes to
// npm as bare "freellmapi" and is NOT private, so it needs the same explicit
// self-exclusion "localagent" gets from the main scan below.
const FREELLMAPI_OWN_PACKAGE_NAMES = new Set(["@freellmapi/monorepo", "@freellmapi/shared", "@freellmapi/server", "@freellmapi/client", "freellmapi"]);

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const packages = await new Promise((resolve, reject) => {
    initLicenseChecker({ start: rootDir, production: true, excludePrivatePackages: true }, (err, pkgs) => {
      if (err) reject(err);
      else resolve(pkgs);
    });
  });

  const vendorDir = path.join(rootDir, "vendor", "freellmapi");
  // Scanned at the monorepo ROOT (not just server/client individually) so
  // npm workspaces' hoisted node_modules is walked once - this over-
  // includes the "cli" workspace's own dependencies (never actually
  // bundled into what localagent ships; filtered by NAME below, not by
  // dependency scope) and the root scan's own package.json has no
  // "dependencies" of its own. NOT passing production:true here - confirmed
  // by direct testing that it silently mis-scopes this workspaces layout
  // (some packages are hoisted to the root node_modules, others installed
  // locally inside a workspace's own node_modules): a root-level
  // production:true scan finds ZERO packages at all, and even a per-
  // workspace scan undercounts (server: 2 instead of its real ~12 direct
  // deps, client: 0 instead of ~20, missing react/express entirely). That's
  // a silent under-attribution risk - worse than this scan's real
  // trade-off, which is over-including devDependencies (vitest,
  // typescript, eslint, concurrently - confirmed present, never shipped).
  // Over-attribution in a compliance document is harmless; under-
  // attribution is the actual risk being guarded against throughout this
  // whole vendored-project scan. Must run after build-freellmapi.mjs's own
  // `npm ci` in vendorDir (see package.json's build chain) - this has
  // nothing to scan otherwise.
  const freellmapiPackages = await new Promise((resolve, reject) => {
    initLicenseChecker({ start: vendorDir, excludePrivatePackages: true }, (err, pkgs) => {
      if (err) reject(err);
      else resolve(pkgs);
    });
  });
  const freellmapiDependencies = Object.fromEntries(
    Object.entries(freellmapiPackages).filter(([key]) => !FREELLMAPI_OWN_PACKAGE_NAMES.has(packageNameFrom(key)))
  );

  const markdown = await buildNoticesMarkdown(packages, [
    {
      name: "FreeLLMAPI",
      repository: "https://github.com/tashfeenahmed/freellmapi",
      licenseFile: path.join(vendorDir, "LICENSE"),
      dependencies: freellmapiDependencies,
    },
  ]);
  const outPath = path.join(rootDir, "THIRD-PARTY-NOTICES.md");
  await fs.writeFile(outPath, markdown, "utf-8");
  console.log(
    `[build] wrote THIRD-PARTY-NOTICES.md (${Object.keys(packages).length - 1} third-party packages, ${Object.keys(freellmapiDependencies).length} vendored FreeLLMAPI dependencies)`
  );
}
