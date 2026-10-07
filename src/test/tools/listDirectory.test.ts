import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listDirectoryTool } from "../../tools/listDirectory.js";

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-listdir-test-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "a.ts"), "", "utf-8");
  const ctx = { workspaceRoot: root, log: () => {} };

  console.log("listDirectoryTool: ordinary listing still works, relative to the whole workspace:");
  {
    const result = await listDirectoryTool.execute({}, ctx);
    check("lists the top-level entries", result.ok && result.output!.entries.includes("src/"));
  }
  {
    const result = await listDirectoryTool.execute({ path: "src" }, ctx);
    check("a subdirectory listing is still workspace-relative, not subdir-relative", result.ok && result.output!.entries.includes("src/a.ts"));
  }

  console.log("\nlistDirectoryTool: no containment check at all before this fix (security audit M1):");
  {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-listdir-outside-"));
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "", "utf-8");
    const result = await listDirectoryTool.execute({ path: path.relative(root, outsideDir) }, ctx);
    check("a path escaping the workspace is refused, not listed", result.ok === false);
    await fs.rm(outsideDir, { recursive: true, force: true });
  }

  console.log("\nlistDirectoryTool: symlink escape is blocked (security audit H2):");
  {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-listdir-outside2-"));
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "", "utf-8");
    const linkPath = path.join(root, "escape-link");
    await fs.symlink(outsideDir, linkPath, "dir");

    const result = await listDirectoryTool.execute({ path: "escape-link" }, ctx);
    check("a symlink pointing outside the workspace is refused, not listed", result.ok === false);

    await fs.rm(linkPath, { force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }

  await fs.rm(root, { recursive: true, force: true });

  console.log("\nlistDirectoryTool: result is capped at 500 entries, and truncated is reported correctly (performance finding — code-review-and-quality pass):");
  {
    const bigRoot = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-listdir-big-"));
    // 20 subdirectories x 30 files = 600 entries (+ 20 dir entries = 620),
    // well past the 500 cap, flat enough to stay within the walk's own
    // maxDepth of 3.
    for (let d = 0; d < 20; d++) {
      const dirPath = path.join(bigRoot, `dir-${d}`);
      await fs.mkdir(dirPath, { recursive: true });
      await Promise.all(Array.from({ length: 30 }, (_, f) => fs.writeFile(path.join(dirPath, `file-${f}.txt`), "", "utf-8")));
    }
    const bigCtx = { workspaceRoot: bigRoot, log: () => {} };
    const result = await listDirectoryTool.execute({}, bigCtx);
    check("the result is capped at exactly 500 entries, not 620", result.ok && result.output!.entries.length === 500);
    check("truncated is reported as true", result.ok && result.truncated === true);
    await fs.rm(bigRoot, { recursive: true, force: true });
  }

  console.log("\nlistDirectoryTool: truncated is false when genuinely everything fit (regression guard for the early-exit's cap-vs-naturally-finished distinction):");
  {
    const smallRoot = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-listdir-small-"));
    await fs.writeFile(path.join(smallRoot, "one.txt"), "", "utf-8");
    await fs.writeFile(path.join(smallRoot, "two.txt"), "", "utf-8");
    const smallCtx = { workspaceRoot: smallRoot, log: () => {} };
    const result = await listDirectoryTool.execute({}, smallCtx);
    check("every entry is present (nothing dropped)", result.ok && result.output!.entries.length === 2);
    check("truncated is false — this genuinely is everything, not a cap hit", result.ok && result.truncated === false);
    await fs.rm(smallRoot, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
