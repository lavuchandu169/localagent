import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileTool } from "../tools/readFile.js";

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-readfile-test-"));
  await fs.writeFile(path.join(root, "a.txt"), "hello\n", "utf-8");
  const ctx = { workspaceRoot: root, log: () => {} };

  console.log("readFileTool: ordinary read still works:");
  {
    const result = await readFileTool.execute({ path: "a.txt" }, ctx);
    check("reads the file", result.ok && result.output?.content === "hello\n");
  }

  console.log("\nreadFileTool: symlink escape is blocked (security audit H2):");
  {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-readfile-outside-"));
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "not yours\n", "utf-8");
    const linkPath = path.join(root, "escape-link");
    await fs.symlink(outsideDir, linkPath, "dir");

    const result = await readFileTool.execute({ path: "escape-link/secret.txt" }, ctx);
    check("a symlink pointing outside the workspace is refused, not read", result.ok === false);

    await fs.rm(linkPath, { force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }

  console.log("\nreadFileTool: sibling-directory prefix bypass is blocked (security audit M2):");
  {
    const siblingRoot = `${root}-evil`;
    await fs.mkdir(siblingRoot, { recursive: true });
    await fs.writeFile(path.join(siblingRoot, "secret.txt"), "not yours\n", "utf-8");
    const relativeToSibling = path.relative(root, path.join(siblingRoot, "secret.txt"));
    const result = await readFileTool.execute({ path: relativeToSibling }, ctx);
    check("a sibling directory whose name starts with the workspace root's name is still refused", result.ok === false);
    await fs.rm(siblingRoot, { recursive: true, force: true });
  }

  await fs.rm(root, { recursive: true, force: true });

  console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
