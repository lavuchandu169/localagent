#!/usr/bin/env node
// electron-builder's `win.sign` hook — called once per file that needs an
// Authenticode signature (the .exe, and the NSIS installer itself). Only one
// call per file: package.json's win.signtoolOptions.signingHashAlgorithms is
// pinned to ["sha256"], so electron-builder doesn't also ask for a legacy
// sha1 pass — CodeSignTool does a single Authenticode sign, not the
// signtool.exe-style dual-sign dance, and sha1 is a Windows-XP-era
// compatibility concern nobody needs in 2026.
//
// SSL.com's eSigner is a cloud HSM: there's no exportable .p12/.pfx for the
// CSC_LINK/CSC_KEY_PASSWORD mechanism electron-builder uses by default (see
// mac's signing, which does use that mechanism). Signing instead goes
// through their CodeSignTool CLI, authenticated with account credentials.
//
// CodeSignTool.bat is NOT run as a shell command here — its own contents
// (confirmed by actually extracting and reading it, not guessed) are just:
//   .\jdk-11.0.2\bin\java -jar .\jar\code_sign_tool-1.3.2.jar %*
// so this invokes that bundled java.exe directly, with shell:false and a
// real argv array. That sidesteps two problems Windows .bat files force
// otherwise: (1) Node refuses to spawn .bat/.cmd without shell:true at all,
// and (2) shell:true on Windows routes everything through cmd.exe, which
// has its own metacharacter parsing (&, |, ^, %, ...) layered on top of the
// process's normal argv — exactly the layer you don't want a secret
// password/TOTP value passing through uninspected. Spawning java.exe
// directly has neither problem: Windows CreateProcess-level argv, no shell
// in between.
//
// Residual, vendor-imposed limitation: CodeSignTool's own documented CLI
// takes -password and -totp_secret as plain arguments with no env-var or
// config-file alternative (conf/code_sign_tool.properties, also actually
// inspected, only holds SSL.com's own fixed OAuth app registration, not a
// slot for user credentials) — so they're still visible in this process's
// argv for its lifetime (e.g. to anyone who can list processes on the same
// CI runner or machine while it's running). That's inherent to the tool as
// shipped, not something this script can route around.
//
// The downloaded release zip's SHA-256 is pinned and checked before
// extraction: the archive still contains, among a lot of files, a Java
// runtime and a JAR that then run with real signing credentials. Downloaded
// fresh into its own mkdtemp directory every time (no persistent, path-
// guessable shared cache another process on the same machine could plant
// something into first).
//
// Implemented against SSL.com's documented CLI (see
// https://www.ssl.com/guide/esigner-codesigntool-command-guide/) and the
// real v1.3.2 Windows release's actual contents, but NOT yet verified
// against a real SSL.com account, since none exists yet at the time this
// was written. The first real Windows release build after
// ES_USERNAME/ES_PASSWORD/CREDENTIAL_ID/ES_TOTP_SECRET are set as real
// secrets is the actual test; watch that build's log closely rather than
// assuming this is correct.
//
// Until those env vars are set, this safely does nothing — exactly today's
// unsigned-build behavior — so adding this file doesn't change anything
// about the release pipeline for any fork/from-source build without
// credentials.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const REQUIRED_ENV_VARS = ["ES_USERNAME", "ES_PASSWORD", "CREDENTIAL_ID", "ES_TOTP_SECRET"];

const CODESIGNTOOL_VERSION = "1.3.2";
const CODESIGNTOOL_DOWNLOAD_URL = `https://github.com/SSLcom/CodeSignTool/releases/download/v${CODESIGNTOOL_VERSION}/CodeSignTool-v${CODESIGNTOOL_VERSION}-windows.zip`;
// Computed directly off the real release asset (shasum -a 256), not taken
// from any SSL.com-published checksum — they don't publish one for this
// release. Re-verify and update this alongside CODESIGNTOOL_VERSION on any
// future version bump.
const CODESIGNTOOL_WINDOWS_ZIP_SHA256 = "4afc32e8b7f79bbe1de7e4e7049aaad4e0f754357613b9bbec0e3052f06fd36b";

// The zip's own internal layout (verified by extracting and inspecting it
// directly): no top-level wrapper folder, java.exe and the jar at these
// fixed relative paths.
const JAVA_RELATIVE_PATH = path.join("jdk-11.0.2", "bin", "java.exe");
const JAR_RELATIVE_PATH = path.join("jar", `code_sign_tool-${CODESIGNTOOL_VERSION}.jar`);

/**
 * The CodeSignTool argument array for signing one file (everything after
 * the jar path on the java -jar invocation). Pure/testable — no filesystem
 * or process access.
 *
 * -totp_secret lets CodeSignTool compute its own one-time password instead
 * of prompting interactively (which would hang a CI job forever).
 * -output_dir_path writes the signed file to a separate directory instead
 * of overwriting the input in place, which also avoids CodeSignTool's
 * interactive overwrite-confirmation prompt.
 */
export function buildSignArgs({ credentialId, username, password, totpSecret, inputPath, outputDir }) {
  return [
    "sign",
    `-credential_id=${credentialId}`,
    `-username=${username}`,
    `-password=${password}`,
    `-totp_secret=${totpSecret}`,
    `-input_file_path=${inputPath}`,
    `-output_dir_path=${outputDir}`,
  ];
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    // shell:false — command is always a real executable here (java.exe),
    // never a .bat/.cmd, so there is no Windows shell-spawn restriction to
    // work around and no cmd.exe metacharacter layer for a secret argument
    // to pass through. See the file-level doc comment.
    const child = spawn(command, args, { stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`sign-windows.mjs: "${command}" exited with code ${code}`));
    });
  });
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

// Downloads CodeSignTool fresh into its own mkdtemp directory — never a
// fixed/predictable shared path another process could have written into
// first — verifies its SHA-256 against the pinned value above, and only
// then extracts it. Cached (module-level promise) across the multiple
// sign() calls one electron-builder run makes (one per target file), so
// the ~200MB archive is only ever downloaded and verified once per build,
// but never reused across separate builds/processes.
let toolDirPromise = null;

function getToolDir() {
  if (!toolDirPromise) toolDirPromise = downloadAndExtractCodeSignTool();
  return toolDirPromise;
}

async function downloadAndExtractCodeSignTool() {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "codesigntool-"));
  const zipPath = path.join(workDir, "CodeSignTool.zip");

  const response = await fetch(CODESIGNTOOL_DOWNLOAD_URL);
  if (!response.ok || !response.body) {
    throw new Error(`sign-windows.mjs: failed to download CodeSignTool (${response.status} ${response.statusText})`);
  }
  await pipeline(response.body, createWriteStream(zipPath));

  const actualHash = await sha256File(zipPath);
  if (actualHash !== CODESIGNTOOL_WINDOWS_ZIP_SHA256) {
    throw new Error(
      `sign-windows.mjs: CodeSignTool download failed integrity check — expected sha256 ${CODESIGNTOOL_WINDOWS_ZIP_SHA256}, got ${actualHash}. ` +
        `Refusing to extract or run it. If SSL.com genuinely republished this release, verify the new hash out-of-band and update CODESIGNTOOL_WINDOWS_ZIP_SHA256.`
    );
  }

  const extractDir = path.join(workDir, "extracted");
  // PowerShell's Expand-Archive rather than a new npm dependency — this
  // hook only ever runs on windows-latest (electron-builder only calls
  // win.sign during a Windows build), so a Windows-only unzip tool costs
  // nothing extra here.
  await run("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`]);

  const javaPath = path.join(extractDir, JAVA_RELATIVE_PATH);
  const jarPath = path.join(extractDir, JAR_RELATIVE_PATH);
  const [javaExists, jarExists] = await Promise.all([
    stat(javaPath)
      .then(() => true)
      .catch(() => false),
    stat(jarPath)
      .then(() => true)
      .catch(() => false),
  ]);
  if (!javaExists || !jarExists) {
    throw new Error(
      `sign-windows.mjs: extracted CodeSignTool v${CODESIGNTOOL_VERSION} but its layout doesn't match what this script expects ` +
        `(java: ${javaExists ? "found" : "MISSING"} at ${javaPath}, jar: ${jarExists ? "found" : "MISSING"} at ${jarPath}). ` +
        `SSL.com may have changed the release layout — re-inspect the zip and update JAVA_RELATIVE_PATH/JAR_RELATIVE_PATH.`
    );
  }
  return { javaPath, jarPath, workDir };
}

export default async function sign(configuration) {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    // No SSL.com credentials configured yet — leave the file unsigned,
    // matching every release before this one.
    return;
  }

  const { javaPath, jarPath } = await getToolDir();
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "codesigntool-out-"));

  try {
    const args = buildSignArgs({
      credentialId: process.env.CREDENTIAL_ID,
      username: process.env.ES_USERNAME,
      password: process.env.ES_PASSWORD,
      totpSecret: process.env.ES_TOTP_SECRET,
      inputPath: configuration.path,
      outputDir,
    });

    await run(javaPath, ["-jar", jarPath, ...args]);

    const signedPath = path.join(outputDir, path.basename(configuration.path));
    const signedExists = await stat(signedPath)
      .then(() => true)
      .catch(() => false);
    if (!signedExists) {
      throw new Error(`sign-windows.mjs: CodeSignTool reported success but no signed file was found at ${signedPath}`);
    }
    await copyFile(signedPath, configuration.path);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}
