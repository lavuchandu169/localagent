// Bundles vendor/freellmapi's server into dist/freellmapi/server.mjs and
// stages its built dashboard into dist/freellmapi/client-dist — same
// recipe as vendor/freellmapi/desktop/scripts/bundle-server.mjs (built
// FROM the entry point that file's own bundle-server.mjs targets,
// desktop/src/server-host.ts), run against the vendored source directly
// rather than duplicating that script's logic by hand.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Security audit finding (confirmed, high):
// build-freellmapi.mjs:npm-ci:inherits-release-signing-secrets. release.yml's
// build-mac/build-win jobs write these into $GITHUB_ENV (or the step's own
// `env:`) before the `npm run build` step that ends up here — see that
// workflow's "Prepare signing/notarization environment" step (mac) and
// "Prepare signing environment" step (windows), plus the GH_TOKEN/
// GOOGLE_OAUTH_* pair set directly on the package:mac/package:win steps.
// Keep this list in sync with exactly what those steps export.
export const RELEASE_SECRET_ENV_KEYS = [
  // macOS code-signing/notarization (release.yml build-mac)
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_TEAM_ID",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  // Windows code-signing (release.yml build-win)
  "ES_USERNAME",
  "ES_PASSWORD",
  "CREDENTIAL_ID",
  "ES_TOTP_SECRET",
  // Set directly on both package:mac/package:win steps
  "GH_TOKEN",
  "GOOGLE_OAUTH_CLIENT_ID_EMBED",
  "GOOGLE_OAUTH_CLIENT_SECRET_EMBED",
];

/**
 * A privileged release-build step holding code-signing/notarization
 * credentials must not hand them to vendor/freellmapi's own `npm ci` —
 * real lifecycle scripts already exist in its dependency tree today
 * (better-sqlite3, esbuild, fsevents, msw all have hasInstallScript:true),
 * and execFileSync with no `env` override inherits the full parent
 * process.env per Node's own documented child_process semantics. Returns a
 * shallow copy with every known release secret removed, never mutating the
 * caller's own env object.
 */
export function sanitizeEnvForVendorInstall(env) {
  const sanitized = { ...env };
  for (const key of RELEASE_SECRET_ENV_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}

export async function buildFreellmapiBundle(repoRoot) {
  const vendorDir = path.join(repoRoot, "vendor", "freellmapi");
  const outDir = path.join(repoRoot, "dist", "freellmapi");
  fs.mkdirSync(outDir, { recursive: true });
  const vendorInstallEnv = sanitizeEnvForVendorInstall(process.env);

  // The dashboard: vendor/freellmapi's own client workspace, built with its
  // own toolchain (tsc -b && vite build per client/package.json), then
  // copied into dist/freellmapi/client-dist — same "stage it, don't
  // reference it across a relative ../ boundary" reasoning as their own
  // desktop/scripts/stage-client.mjs, which exists specifically because a
  // reached-above-the-app-dir path broke electron-builder on Windows.
  // shell: true — on Windows, "npm" resolves to npm.cmd, which
  // execFileSync cannot locate/execute without going through a shell
  // (confirmed: this is the documented Node/Windows execFileSync+npm
  // interaction, not a hypothetical). All arguments here are fixed,
  // known-safe literals (no user input), so shell interpretation adds no
  // injection risk.
  execFileSync("npm", ["ci"], { cwd: vendorDir, stdio: "inherit", shell: true, env: vendorInstallEnv });
  execFileSync("npm", ["run", "build", "-w", "client"], { cwd: vendorDir, stdio: "inherit", shell: true, env: vendorInstallEnv });
  const clientSrc = path.join(vendorDir, "client", "dist");
  const clientDest = path.join(outDir, "client-dist");
  fs.rmSync(clientDest, { recursive: true, force: true });
  fs.cpSync(clientSrc, clientDest, { recursive: true });

  // The server: identical esbuild options to vendor/freellmapi's own
  // desktop/scripts/bundle-server.mjs (entry point, external, target,
  // banner for express's runtime `require` under ESM) - see that file for
  // why each option is there; not re-explained here to avoid the two
  // drifting out of sync in prose while the actual options do.
  await build({
    entryPoints: [path.join(vendorDir, "desktop", "src", "server-host.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: path.join(outDir, "server.mjs"),
    external: ["better-sqlite3"],
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    logLevel: "info",
  });
}

// pathToFileURL(process.argv[1]).href, not a raw `new URL(process.argv[1],
// "file:")` - the latter mishandles a Windows absolute path (its drive
// letter's colon confuses the URL parser, backslashes aren't forward
// slashes), so this comparison silently evaluates false on Windows and the
// whole block below never runs - no error, no output, just a silent no-op
// that leaves vendor/freellmapi/node_modules never installed and
// dist/freellmapi never written. Confirmed as the real cause of a Windows
// release build failure (generate-third-party-notices.mjs's later scan of
// vendor/freellmapi hit "No packages found" - the actual symptom of this
// script having done nothing - not a bug in that later script itself).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  await buildFreellmapiBundle(repoRoot);
  console.log("[build] wrote dist/freellmapi/server.mjs and dist/freellmapi/client-dist/");
}
