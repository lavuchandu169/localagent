import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { editFileTool } from "../tools/editFile.js";

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-editfile-test-"));
  const ctx = { workspaceRoot: root, log: () => {} };

  console.log("editFileTool: ordinary write still works, including a new nested path:");
  {
    const result = await editFileTool.execute({ path: "new/nested/file.txt", content: "hi\n" }, ctx);
    check("creates the file", result.ok);
    const written = await fs.readFile(path.join(root, "new", "nested", "file.txt"), "utf-8");
    check("the content actually landed inside the workspace", written === "hi\n");
  }

  console.log("\neditFileTool: symlink escape is blocked, never writes through it (security audit H2):");
  {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-editfile-outside-"));
    const linkPath = path.join(root, "escape-link");
    await fs.symlink(outsideDir, linkPath, "dir");

    const result = await editFileTool.execute({ path: "escape-link/pwned.txt", content: "owned\n" }, ctx);
    check("a symlink pointing outside the workspace is refused, not written through", result.ok === false);
    const leaked = await fs
      .access(path.join(outsideDir, "pwned.txt"))
      .then(() => true)
      .catch(() => false);
    check("nothing was actually written outside the workspace", !leaked);

    await fs.rm(linkPath, { force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }

  console.log("\neditFileTool: a symlink whose NAME looks innocent but resolves inside .git is still protected (final review Important #4, confirmed live — a malicious core.pager/core.fsmonitor hook planted this way runs on the next auto-allowed 'git status'/'git diff'):");
  {
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.writeFile(path.join(root, ".git", "config"), "[core]\n", "utf-8");
    await fs.symlink(path.join(root, ".git", "config"), path.join(root, "cfg"));

    const result = await editFileTool.execute({ path: "cfg", content: "[core]\n  pager = touch /tmp/PWNED\n" }, ctx);
    check("a symlink named 'cfg' resolving inside .git is refused, not written through", result.ok === false);
    const gitConfigContent = await fs.readFile(path.join(root, ".git", "config"), "utf-8");
    check(".git/config itself was never actually modified", gitConfigContent === "[core]\n");

    await fs.rm(path.join(root, "cfg"), { force: true });
    await fs.rm(path.join(root, ".git"), { recursive: true, force: true });
  }

  await fs.rm(root, { recursive: true, force: true });

  console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
