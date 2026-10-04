import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { buildFreellmapiBundle, sanitizeEnvForVendorInstall, RELEASE_SECRET_ENV_KEYS } from "./build-freellmapi.mjs";

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("sanitizeEnvForVendorInstall:");
{
  // Security audit finding (confirmed, high):
  // build-freellmapi.mjs:npm-ci:inherits-release-signing-secrets. The real
  // release job writes code-signing/notarization secrets (mac) or
  // ES_USERNAME/ES_PASSWORD/etc (windows), plus GH_TOKEN and the Google
  // OAuth embed secrets, into this process's env before `npm run build` -
  // which runs vendor/freellmapi's own `npm ci`, a lower-trust third-party
  // install with real lifecycle scripts in its tree today (better-sqlite3,
  // esbuild, fsevents, msw all have hasInstallScript:true). Every secret
  // name release.yml actually exports must come out before that child
  // process starts, or a compromised install script could read them.
  const fakeEnv = {
    PATH: "/usr/bin",
    HOME: "/home/runner",
    CSC_LINK: "secret-mac-cert",
    CSC_KEY_PASSWORD: "secret-mac-pw",
    APPLE_API_KEY: "secret-apple-key",
    APPLE_API_KEY_ID: "secret-apple-key-id",
    APPLE_API_ISSUER: "secret-apple-issuer",
    APPLE_TEAM_ID: "secret-apple-team",
    APPLE_ID: "secret-apple-id",
    APPLE_APP_SPECIFIC_PASSWORD: "secret-apple-app-pw",
    ES_USERNAME: "secret-es-user",
    ES_PASSWORD: "secret-es-pw",
    CREDENTIAL_ID: "secret-cred-id",
    ES_TOTP_SECRET: "secret-es-totp",
    GH_TOKEN: "secret-gh-token",
    GOOGLE_OAUTH_CLIENT_ID_EMBED: "secret-google-id",
    GOOGLE_OAUTH_CLIENT_SECRET_EMBED: "secret-google-secret",
  };
  const sanitized = sanitizeEnvForVendorInstall(fakeEnv);

  check("every known release-signing/notarization/OAuth/token secret is stripped", RELEASE_SECRET_ENV_KEYS.every((key) => !(key in sanitized)));
  check("non-secret vars needed for npm ci to run are kept", sanitized.PATH === "/usr/bin" && sanitized.HOME === "/home/runner");
  check("the caller's own env object is not mutated in place", "CSC_LINK" in fakeEnv);
}

console.log("\nbuildFreellmapiBundle:");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

await buildFreellmapiBundle(repoRoot);

const serverOut = path.join(repoRoot, "dist/freellmapi/server.mjs");
check("writes the bundled server file", fs.existsSync(serverOut));

const contents = fs.readFileSync(serverOut, "utf-8");
// esbuild renames the createRequire-derived identifier to avoid collisions
// with its own internal shims (observed in the real bundle as
// `runtimeRequire2("better-sqlite3")`, not a literal `require(...)`), but
// the string argument itself is never renamed — matching any call whose
// sole argument is that exact string is the robust signal that the module
// stayed external instead of being inlined.
check("keeps better-sqlite3 as an external require, not inlined", /\w+\(["']better-sqlite3["']\)/.test(contents));
check("exports startServer", /export\s*\{[^}]*startServer/.test(contents) || /export\s+(async\s+)?function\s+startServer/.test(contents));

// A real Node syntax check catches a genuinely broken bundle (bad esbuild
// config, a missed external) without needing to actually boot the server.
check("the bundle is syntactically valid ESM", (() => {
  try {
    execFileSync(process.execPath, ["--check", serverOut]);
    return true;
  } catch {
    return false;
  }
})());

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
