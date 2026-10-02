import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { grepTool, buildRipgrepArgs } from "../tools/grep.js";

const execFileAsync = promisify(execFile);

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

const noopCtx = { workspaceRoot: "", log: () => {} };

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-grep-test-"));
  await fs.writeFile(path.join(root, "a.txt"), "hello world\nfoo bar\n", "utf-8");
  const ctx = { ...noopCtx, workspaceRoot: root };

  console.log("grepTool: ordinary search still works:");
  {
    const result = await grepTool.execute({ pattern: "hello" }, ctx);
    check("finds a plain match", result.ok && typeof result.output?.matches === "string" && result.output.matches.includes("hello world"));
  }

  console.log("\ngrepTool: ripgrep argument injection is blocked (security audit C2):");
  {
    // Direct, environment-independent proof: buildRipgrepArgs must place
    // a "--" end-of-options marker BEFORE the pattern, so a pattern
    // shaped like a flag (e.g. "--pre=sh") can never be parsed as one by
    // rg, regardless of whether a real rg binary happens to be on PATH
    // in whatever environment this test runs in.
    const args = buildRipgrepArgs("--pre=sh");
    const dashDashIndex = args.indexOf("--");
    const patternIndex = args.indexOf("--pre=sh");
    check("buildRipgrepArgs includes a '--' end-of-options marker", dashDashIndex !== -1);
    check("the pattern appears strictly AFTER the '--' marker, so it's always positional", patternIndex !== -1 && patternIndex > dashDashIndex);
  }

  {
    // Belt-and-suspenders: if a real ripgrep binary happens to be
    // available in whatever environment runs this suite, confirm the
    // live exploit (confirmed in the original security audit: --pre=sh
    // makes rg execute every matched file as a shell script) is actually
    // closed, not just that the argv looks right in isolation.
    let hasRealRipgrep = false;
    try {
      await execFileAsync("rg", ["--version"]);
      hasRealRipgrep = true;
    } catch {
      hasRealRipgrep = false;
    }
    if (hasRealRipgrep) {
      const payloadMarker = path.join(root, "PWNED_MARKER");
      await fs.rm(payloadMarker, { force: true });
      await grepTool.execute({ pattern: `--pre=sh -c "touch ${payloadMarker}"` }, ctx);
      const exists = await fs
        .access(payloadMarker)
        .then(() => true)
        .catch(() => false);
      check("[live rg binary] a pattern shaped like an rg flag never gets interpreted as one — no command executed", !exists);
    } else {
      console.log("  (skipped: no real rg binary on PATH in this environment — buildRipgrepArgs test above already covers this)");
    }
  }

  console.log("\ngrepTool: workspace containment (security audit H1 — grep had none at all):");
  {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-grep-outside-"));
    await fs.writeFile(path.join(outsideDir, "secret.key"), "super-secret-value\n", "utf-8");
    const result = await grepTool.execute({ pattern: "secret", path: path.relative(root, outsideDir) }, ctx);
    check("a path escaping the workspace is refused, not searched", result.ok === false);
    await fs.rm(outsideDir, { recursive: true, force: true });
  }

  console.log("\ngrepTool: secret redaction (security audit H1 — grep never redacted, unlike read_file):");
  {
    await fs.writeFile(path.join(root, "creds.txt"), "API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456\n", "utf-8");
    const result = await grepTool.execute({ pattern: "API_KEY" }, ctx);
    check("matched output has the secret value redacted, not the raw key", result.ok && !result.output?.matches.includes("sk-abcdefghijklmnopqrstuvwxyz123456"));
    check("the redaction marker is present", result.ok && !!result.output?.matches.includes("[REDACTED]"));
  }

  await fs.rm(root, { recursive: true, force: true });

  console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
