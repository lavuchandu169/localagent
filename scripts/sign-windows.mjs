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
// Implemented against SSL.com's documented CLI (see
// https://www.ssl.com/guide/esigner-codesigntool-command-guide/ and
// https://github.com/SSLcom/CodeSignTool) — NOT yet verified against a real
// SSL.com account, since none exists yet at the time this was written. The
// first real Windows release build after ES_USERNAME/ES_PASSWORD/
// CREDENTIAL_ID/ES_TOTP_SECRET are set as real secrets is the actual test;
// watch that build's log closely rather than assuming this is correct.
//
// Until those env vars are set, this safely does nothing — exactly today's
// unsigned-build behavior — so adding this file doesn't change anything
// about the release pipeline for any fork/from-source build without
// credentials.

import { createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const REQUIRED_ENV_VARS = ["ES_USERNAME", "ES_PASSWORD", "CREDENTIAL_ID", "ES_TOTP_SECRET"];

const CODESIGNTOOL_VERSION = "1.3.2";
const CODESIGNTOOL_DOWNLOAD_URL = `https://github.com/SSLcom/CodeSignTool/releases/download/v${CODESIGNTOOL_VERSION}/CodeSignTool-v${CODESIGNTOOL_VERSION}-windows.zip`;

/**
 * The CodeSignTool.bat argument array for signing one file. Pure/testable —
 * no filesystem or process access.
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
    // shell: true is required on Windows to spawn a .bat file at all — Node
    // refuses to exec .bat/.cmd directly without it. With an argv array,
    // Node quotes each element for cmd.exe itself, so paths/passwords with
    // spaces still need no manual quoting here.
    const child = spawn(command, args, { stdio: "inherit", shell: true });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`sign-windows.mjs: "${command}" exited with code ${code}`));
    });
  });
}

// The release zip's internal folder name isn't documented anywhere, so this
// searches for the wrapper script rather than assuming a path.
async function findCodeSignToolBat(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findCodeSignToolBat(full);
      if (found) return found;
    } else if (entry.name.toLowerCase() === "codesigntool.bat") {
      return full;
    }
  }
  return null;
}

// Cached across the multiple sign() calls one electron-builder run makes
// (one per target file: the .exe, then the NSIS installer) so the tool is
// only ever downloaded and extracted once per build.
let toolDirPromise = null;

function getToolDir() {
  if (!toolDirPromise) toolDirPromise = downloadAndExtractCodeSignTool();
  return toolDirPromise;
}

async function downloadAndExtractCodeSignTool() {
  const cacheDir = path.join(os.tmpdir(), `codesigntool-v${CODESIGNTOOL_VERSION}`);
  const existing = await findCodeSignToolBat(cacheDir).catch(() => null);
  if (existing) return path.dirname(existing);

  await mkdir(cacheDir, { recursive: true });
  const zipPath = path.join(os.tmpdir(), `codesigntool-v${CODESIGNTOOL_VERSION}.zip`);
  const response = await fetch(CODESIGNTOOL_DOWNLOAD_URL);
  if (!response.ok || !response.body) {
    throw new Error(`sign-windows.mjs: failed to download CodeSignTool (${response.status} ${response.statusText})`);
  }
  await pipeline(response.body, createWriteStream(zipPath));

  // PowerShell's Expand-Archive rather than a new npm dependency — this
  // hook only ever runs on windows-latest (electron-builder only calls
  // win.sign during a Windows build), so a Windows-only unzip tool costs
  // nothing extra here.
  await run("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -Path '${zipPath}' -DestinationPath '${cacheDir}' -Force`]);

  const bat = await findCodeSignToolBat(cacheDir);
  if (!bat) {
    throw new Error(`sign-windows.mjs: extracted CodeSignTool but couldn't find CodeSignTool.bat under ${cacheDir}`);
  }
  return path.dirname(bat);
}

export default async function sign(configuration) {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    // No SSL.com credentials configured yet — leave the file unsigned,
    // matching every release before this one.
    return;
  }

  const toolDir = await getToolDir();
  const batPath = path.join(toolDir, "CodeSignTool.bat");
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

    await run(batPath, args);

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
