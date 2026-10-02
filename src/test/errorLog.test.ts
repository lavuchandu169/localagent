import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { appendErrorLog } from "../electron/errorLog.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("appendErrorLog:");

async function run() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-errorlog-test-"));
  const logFile = path.join(dir, "error.log");

  await appendErrorLog(logFile, { source: "main", kind: "uncaughtException", message: "boom", stack: "at foo\nat bar" });
  const afterFirst = await fs.readFile(logFile, "utf-8");
  check("a new log file is created on first write", afterFirst.includes("[main] [uncaughtException] boom"));
  check("the stack trace is included", afterFirst.includes("at foo\nat bar"));
  check("the entry has an ISO timestamp prefix", /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(afterFirst));

  await appendErrorLog(logFile, { source: "renderer", kind: "window.onerror", message: "second error" });
  const afterSecond = await fs.readFile(logFile, "utf-8");
  check("a second write appends rather than overwriting", afterSecond.includes("boom") && afterSecond.includes("second error"));
  check("entries without a stack still log cleanly", afterSecond.includes("[renderer] [window.onerror] second error"));

  // A write to a directory that can't exist (parent missing, no recursive
  // create) must not throw out of appendErrorLog itself — it's a
  // best-effort diagnostic aid, not something that can crash the app it's
  // trying to help debug.
  const badPath = path.join(dir, "does", "not", "exist", "error.log");
  let threw = false;
  try {
    await appendErrorLog(badPath, { source: "main", kind: "test", message: "should not throw" });
  } catch {
    threw = true;
  }
  check("a write failure is swallowed, not thrown", !threw);

  await fs.rm(dir, { recursive: true, force: true });
}

async function runSecurityAuditFixes() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-errorlog-security-test-"));
  const logFile = path.join(dir, "error.log");

  await appendErrorLog(logFile, { source: "main", kind: "uncaughtException", message: "boom" });
  if (process.platform !== "win32") {
    const stat = await fs.stat(logFile);
    check("the error log is created with owner-only permissions (0600) (security audit M4)", (stat.mode & 0o777) === 0o600);
  }

  const secretKey = "sk-" + "i".repeat(36);
  await appendErrorLog(logFile, { source: "main", kind: "fetch failed", message: `request to https://api.example.com?key=${secretKey} failed` });
  const content = await fs.readFile(logFile, "utf-8");
  check("a secret accidentally embedded in an error message is redacted before being written (security audit M4)", !content.includes(secretKey));

  await fs.rm(dir, { recursive: true, force: true });
}

await run();
await runSecurityAuditFixes();

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
