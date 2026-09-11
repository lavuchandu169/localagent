#!/usr/bin/env node
// electron-builder's `win.sign` hook — called once per file that needs an
// Authenticode signature (the .exe, and the NSIS installer itself).
//
// SSL.com's eSigner is a cloud HSM: there's no exportable .p12/.pfx for the
// CSC_LINK/CSC_KEY_PASSWORD mechanism electron-builder uses by default (see
// mac's signing, which does use that mechanism). Signing instead goes
// through their CodeSignTool CLI, authenticated with account credentials —
// this script is the integration point for that.
//
// Deliberately left as a stub for now: without a real SSL.com account to
// test against, guessing CodeSignTool's exact invocation risks a
// confidently-wrong script that silently fails once real credentials are
// added. Fill in the actual `sign()` body using SSL.com's current docs
// (https://www.ssl.com/how-to/cloud-code-signing-integration-with-github-actions/
// and https://github.com/SSLcom/CodeSignTool) once ES_USERNAME etc. are
// real GitHub Secrets.
//
// Until then, this safely does nothing — exactly today's unsigned-build
// behavior — whenever the required env vars aren't set, so adding this
// file doesn't change anything about the current release pipeline.

const REQUIRED_ENV_VARS = ["ES_USERNAME", "ES_PASSWORD", "CREDENTIAL_ID", "ES_TOTP_SECRET"];

export default async function sign(configuration) {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    // No SSL.com credentials configured yet — leave the file unsigned,
    // matching every release before this one.
    return;
  }

  throw new Error(
    `sign-windows.mjs: SSL.com credentials are set, but the actual CodeSignTool ` +
      `invocation for "${configuration.path}" hasn't been implemented yet — see the ` +
      `comment at the top of this file for what to fill in.`
  );
}
