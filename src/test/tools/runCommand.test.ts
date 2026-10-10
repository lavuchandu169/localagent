import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommandTool } from "../../tools/runCommand.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-runcommand-test-"));
  const ctx = { workspaceRoot: root, log: () => {}, getGithubToken: async () => null };

  console.log("runCommandTool: ordinary command still works:");
  {
    const result = await runCommandTool.execute({ command: "echo hello" }, ctx);
    check("runs successfully", result.ok === true);
    check("stdout has the real output", (result.output as any)?.stdout.trim() === "hello");
  }

  console.log("\nrunCommandTool: a secret straddling the stdout character-truncation boundary is still fully redacted, not partially leaked (security audit finding: truncate-before-redact-order):");
  {
    // MAX_OUTPUT is 8000 — the BEGIN line and secret body land comfortably
    // BEFORE that boundary, with padding pushing the closing END marker
    // comfortably PAST it. Under the old (buggy) order, slicing stdout to
    // 8000 chars BEFORE redacting excludes the closing END marker
    // entirely, so the PEM regex (which requires it) never matches and
    // the body — fully present in the truncated slice — survives
    // completely raw in the output.
    const filler = "A".repeat(7000);
    const secretBody = "RUNCOMMANDSECRETBODYDATA1234567890";
    const padding = "B".repeat(2000); // pushes the closing END marker past the 8000-char cutoff
    const fileContent = filler + `-----BEGIN RSA PRIVATE KEY-----\n${secretBody}\n${padding}\n-----END RSA PRIVATE KEY-----\n`;
    const fixturePath = path.join(root, "straddle.txt");
    await fs.writeFile(fixturePath, fileContent, "utf-8");

    const result = await runCommandTool.execute({ command: `cat ${fixturePath}` }, ctx);
    check("the result is ok", result.ok === true);
    const stdout = (result.output as any)?.stdout ?? "";
    check("the PEM body never appears raw in the truncated output", !stdout.includes(secretBody));
    check("the redaction marker is present instead", stdout.includes("[REDACTED]"));
  }

  console.log("\nrunCommandTool: a fast, unbounded-output command is capped and killed during accumulation, not left to grow until close (security audit finding: unbounded-stdout-stderr-accumulation):");
  {
    // `yes` is a genuine, truly open-ended producer (a real OS process,
    // not a Node script that would just stall once the OS pipe buffer
    // fills without ever yielding its own event loop) — the ONLY thing
    // that can end this before its own generous timeout is
    // runCommandTool's own accumulation cap killing the process early.
    // Before the fix, nothing stops accumulation until close(), so this
    // would run for the full timeout; after the fix, the cap triggers a
    // kill almost immediately once ~1MB has accumulated.
    //
    // `& wait` (not a bare `yes ...`) is deliberate: it forces the shell
    // to background `yes` and stay alive to wait for it, so the shell
    // can NEVER exec-optimize itself away into `yes` the way a bare
    // trailing command can on some shells (confirmed live: this is
    // exactly what let an earlier, bare-command version of this test
    // pass locally on macOS's shell while hanging for ~20 minutes on
    // Ubuntu CI's dash — only `& wait` guarantees `yes` is a genuine
    // grandchild of this process on every shell, which is the actual
    // shape killProcessTree exists to handle).
    const start = Date.now();
    const result = await runCommandTool.execute(
      { command: "yes AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA & wait", timeoutMs: 10000 },
      ctx
    );
    const elapsedMs = Date.now() - start;
    check("resolves well before its own generous timeout — the accumulation cap, not the timeout, ended it", elapsedMs < 5000);
    check("still returns a usable result rather than hanging or crashing the test process", result.output !== undefined || result.error !== undefined);
  }

  console.log(
    "\nrunCommandTool: a command that traps and ignores SIGTERM is still killed, via the 2s SIGKILL escalation (test-engineer finding, full-project audit — the SIGKILL fallback itself had no test, only the SIGTERM-succeeds path above did):"
  );
  {
    // `trap '' TERM` makes the shell itself ignore SIGTERM outright — a
    // real, OS-level non-cooperative process, not a Node script that could
    // just be slow to respond. `escalateToKill`'s first SIGTERM will be a
    // genuine no-op here; only the SIGKILL fired ~2s later (SIGKILL cannot
    // be trapped or ignored by any process) can actually end it. A short
    // timeoutMs triggers escalateToKill almost immediately, so the test's
    // wall-clock cost is ~2s (the hardcoded escalation delay), not the
    // sleep's own 30s.
    const start = Date.now();
    const result = await runCommandTool.execute({ command: "trap '' TERM; sleep 30", timeoutMs: 300 }, ctx);
    const elapsedMs = Date.now() - start;
    check("resolves at all, rather than hanging for the full 30s sleep — proves SOME signal actually ended it", elapsedMs < 10000);
    check("took at least the ~2s SIGKILL escalation delay — proves it was the SECOND signal, not a SIGTERM that actually worked", elapsedMs >= 1900);
    check("still returns a usable result instead of crashing the test process", result.output !== undefined || result.error !== undefined);
    const exitCode = (result.output as any)?.exitCode;
    check("the exit code reflects death by signal (non-zero/null), not a clean exit", result.ok === false && (exitCode === null || exitCode !== 0));
  }

  await fs.rm(root, { recursive: true, force: true });

  console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
