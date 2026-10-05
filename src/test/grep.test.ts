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
      // Final review Important #7: rg's --pre=<program> runs a single
      // PROGRAM (by name/path), not a shell string — the original test's
      // payload `sh -c "touch X"` as ONE argv element is a program name
      // literally containing spaces, which rg can't find and fails to
      // start, so it passed even with the pre-fix vulnerable code. A real
      // exploit needs an actual executable file for rg to invoke.
      const payloadMarker = path.join(root, "PWNED_MARKER");
      const scriptPath = path.join(root, "pwn.sh");
      await fs.rm(payloadMarker, { force: true });
      await fs.writeFile(scriptPath, `#!/bin/sh\ntouch "${payloadMarker}"\n`, { mode: 0o755 });
      await grepTool.execute({ pattern: `--pre=${scriptPath}` }, ctx);
      const exists = await fs
        .access(payloadMarker)
        .then(() => true)
        .catch(() => false);
      check("[live rg binary] a pattern shaped like an rg flag never gets interpreted as one — no script executed", !exists);
      await fs.rm(scriptPath, { force: true });
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

  console.log("\ngrepTool: the JS fallback never follows a symlink outside the workspace (final review Important #5, confirmed live — the common path for most users, since ripgrep is rarely installed):");
  {
    // Forces the JS fallback deterministically, regardless of whether a
    // real rg binary happens to be installed wherever this test runs: a
    // lookbehind assertion is valid JS RegExp syntax (what jsFallbackGrep
    // uses) but unsupported by ripgrep's underlying Rust regex engine,
    // which exits with its own "invalid pattern" error (code 2) —
    // tryRipgrep treats any code > 1 as "couldn't run it", falling
        // through to the JS path exactly like a missing rg binary would.
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-grep-jsfallback-outside-"));
    await fs.writeFile(path.join(outsideDir, "s.txt"), "findmeSECRETOUT\n", "utf-8");
    const linkPath = path.join(root, "link.txt");
    await fs.symlink(path.join(outsideDir, "s.txt"), linkPath);

    const result = await grepTool.execute({ pattern: "(?<=findme)SECRETOUT" }, ctx);
    check("a symlink pointing outside the workspace is never read by the JS fallback", result.ok && !result.output?.matches.includes("SECRETOUT"));

    await fs.rm(linkPath, { force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }

  console.log("\ngrepTool: the JS fallback skips protected paths (.env, id_rsa, etc.), matching read_file's own posture:");
  {
    await fs.writeFile(path.join(root, ".env"), "aaaFINDABLE_ENV_SECRET\n", "utf-8");
    const result = await grepTool.execute({ pattern: "(?<=aaa)FINDABLE_ENV_SECRET" }, ctx);
    check("a protected file (.env) is never searched/matched by the JS fallback", result.ok && !result.output?.matches.includes("FINDABLE_ENV_SECRET"));
    await fs.rm(path.join(root, ".env"), { force: true });
  }

  console.log("\ngrepTool: the JS fallback skips binary files instead of decoding them as mangled text (performance finding — code-review-and-quality pass):");
  {
    // A NUL byte never throws from fs.readFile(..., "utf8") — it silently
    // decodes to U+0000 and keeps going, so the OLD code's
    // `catch { /* binary, skip */ }` never actually caught this case: the
    // plain-ASCII match on a later line of the same "binary" file was
    // still found and returned. The fix's looksBinary() check (peeking for
    // a NUL in the first 512 bytes) is what actually makes this skip.
    const binPath = path.join(root, "data.bin");
    await fs.writeFile(binPath, Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from("\naaaBINARYFILEMATCH\n")]));
    const result = await grepTool.execute({ pattern: "(?<=aaa)BINARYFILEMATCH" }, ctx);
    check("a match inside a file with a NUL byte is not returned — the whole file is skipped as binary", result.ok && !result.output?.matches.includes("BINARYFILEMATCH"));
    await fs.rm(binPath, { force: true });
  }

  console.log("\ngrepTool: the JS fallback skips files over its size cap instead of loading them whole into memory (performance finding — code-review-and-quality pass):");
  {
    const bigPath = path.join(root, "big.txt");
    const filler = "x".repeat(1024 * 1024); // 1MB of filler per chunk
    await fs.writeFile(bigPath, filler + filler + filler + "\naaaBIGFILEMATCH\n"); // > 2MB total
    const result = await grepTool.execute({ pattern: "(?<=aaa)BIGFILEMATCH" }, ctx);
    check("a match inside a file over MAX_SEARCHABLE_FILE_BYTES is not returned — the file is skipped outright", result.ok && !result.output?.matches.includes("BIGFILEMATCH"));
    await fs.rm(bigPath, { force: true });
  }

  await fs.rm(root, { recursive: true, force: true });

  console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
