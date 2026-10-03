import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deleteFileTool } from "../tools/deleteFile.js";

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-deletefile-test-"));
  const ctx = { workspaceRoot: root, log: () => {} };

  console.log("deleteFileTool: deletes an ordinary file:");
  {
    await fs.writeFile(path.join(root, "gone.txt"), "bye\n", "utf-8");
    const result = await deleteFileTool.execute({ path: "gone.txt" }, ctx);
    check("reports success", result.ok === true);
    const stillExists = await fs
      .access(path.join(root, "gone.txt"))
      .then(() => true)
      .catch(() => false);
    check("the file is actually gone from disk", !stillExists);
  }

  console.log("\ndeleteFileTool: deleting a path that doesn't exist is a clear error, not a crash:");
  {
    const result = await deleteFileTool.execute({ path: "never-existed.txt" }, ctx);
    check("reports a clear failure instead of throwing", result.ok === false && typeof result.error === "string");
  }

  console.log("\ndeleteFileTool: refuses to delete a directory unless recursive is explicitly true:");
  {
    await fs.mkdir(path.join(root, "a-folder"), { recursive: true });
    await fs.writeFile(path.join(root, "a-folder", "inside.txt"), "x\n", "utf-8");

    const result = await deleteFileTool.execute({ path: "a-folder" }, ctx);
    check("refuses without recursive:true", result.ok === false);
    const stillThere = await fs
      .access(path.join(root, "a-folder", "inside.txt"))
      .then(() => true)
      .catch(() => false);
    check("the folder and its contents are untouched", stillThere);

    const recursiveResult = await deleteFileTool.execute({ path: "a-folder", recursive: true }, ctx);
    check("deletes the whole folder when recursive:true is explicit", recursiveResult.ok === true);
    const goneNow = await fs
      .access(path.join(root, "a-folder"))
      .then(() => true)
      .catch(() => false);
    check("the folder is actually gone from disk", !goneNow);
  }

  console.log("\ndeleteFileTool: a path escaping the workspace is refused (matches edit_file's own containment check):");
  {
    const result = await deleteFileTool.execute({ path: "../../etc/hosts" }, ctx);
    check("refuses a path that escapes the workspace root", result.ok === false);
  }

  console.log("\ndeleteFileTool: a protected path is refused, same as edit_file/read_file:");
  {
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.writeFile(path.join(root, ".git", "config"), "[core]\n", "utf-8");
    const result = await deleteFileTool.execute({ path: ".git/config" }, ctx);
    check("refuses to delete a protected path", result.ok === false);
    const stillThere = await fs
      .access(path.join(root, ".git", "config"))
      .then(() => true)
      .catch(() => false);
    check(".git/config is untouched", stillThere);
    await fs.rm(path.join(root, ".git"), { recursive: true, force: true });
  }

  console.log("\ndeleteFileTool: symlink escape is blocked, never deletes through it (matches edit_file's own defense):");
  {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-deletefile-outside-"));
    const outsideFile = path.join(outsideDir, "precious.txt");
    await fs.writeFile(outsideFile, "important\n", "utf-8");
    const linkPath = path.join(root, "escape-link");
    await fs.symlink(outsideDir, linkPath, "dir");

    const result = await deleteFileTool.execute({ path: "escape-link/precious.txt" }, ctx);
    check("a symlink pointing outside the workspace is refused, not deleted through", result.ok === false);
    const stillThere = await fs
      .access(outsideFile)
      .then(() => true)
      .catch(() => false);
    check("the file outside the workspace was never actually deleted", stillThere);

    await fs.rm(linkPath, { force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }

  await fs.rm(root, { recursive: true, force: true });

  console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
