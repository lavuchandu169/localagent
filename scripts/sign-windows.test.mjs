#!/usr/bin/env node
// Real tests for scripts/sign-windows.mjs — a build-tool script, not
// application code, so it lives here rather than in src/test/. Same
// hand-rolled check()/console.log style as every other test in this
// project — no framework.
//
// Only the deterministic parts are covered: buildSignArgs (pure) and
// sign()'s no-op-when-unconfigured behavior. Actually downloading
// CodeSignTool and invoking a real eSigner account isn't testable without
// live credentials and a Windows host — see the doc comment at the top of
// sign-windows.mjs.
import sign, { buildSignArgs } from "./sign-windows.mjs";

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("buildSignArgs:");
{
  const args = buildSignArgs({
    credentialId: "cred-123",
    username: "user@example.com",
    password: "p@ssW0rd!",
    totpSecret: "totp-secret-abc",
    inputPath: "C:\\build\\localagent Setup.exe",
    outputDir: "C:\\temp\\out",
  });
  check("starts with the sign subcommand", args[0] === "sign");
  check("includes -credential_id", args.includes("-credential_id=cred-123"));
  check("includes -username", args.includes("-username=user@example.com"));
  check("includes -password", args.includes("-password=p@ssW0rd!"));
  check(
    "includes -totp_secret so CodeSignTool computes its own OTP instead of prompting (would hang CI)",
    args.includes("-totp_secret=totp-secret-abc")
  );
  check("includes -input_file_path with the real path, spaces and all", args.includes("-input_file_path=C:\\build\\localagent Setup.exe"));
  check(
    "includes -output_dir_path, which also avoids CodeSignTool's interactive overwrite prompt",
    args.includes("-output_dir_path=C:\\temp\\out")
  );
}

console.log("\nsign() with no SSL.com credentials configured:");
{
  const originalEnv = { ...process.env };
  for (const name of ["ES_USERNAME", "ES_PASSWORD", "CREDENTIAL_ID", "ES_TOTP_SECRET"]) {
    delete process.env[name];
  }
  let threw = false;
  try {
    await sign({ path: "/does/not/exist/app.exe" });
  } catch {
    threw = true;
  }
  check("is a safe no-op — doesn't throw, doesn't try to download/sign anything", !threw);
  process.env = originalEnv;
}

console.log("\nsign() with only SOME SSL.com credentials configured:");
{
  const originalEnv = { ...process.env };
  delete process.env.ES_USERNAME;
  delete process.env.ES_PASSWORD;
  delete process.env.CREDENTIAL_ID;
  delete process.env.ES_TOTP_SECRET;
  process.env.ES_USERNAME = "someone@example.com";
  // ES_PASSWORD / CREDENTIAL_ID / ES_TOTP_SECRET deliberately left unset.
  let threw = false;
  try {
    await sign({ path: "/does/not/exist/app.exe" });
  } catch {
    threw = true;
  }
  check("a partially-configured environment is still treated as unconfigured — no-op, not a half-attempt", !threw);
  process.env = originalEnv;
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
