import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCheckpoint } from "../checkpoints.js";
import { listChangedFiles, getChanges } from "../changesSince.js";

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

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-changes-test-"));
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  return dir;
}

console.log("listChangedFiles / getChanges:");

{
  const repo = await makeRepo();
  await fs.writeFile(path.join(repo, "tracked.txt"), "line1\nline2\nline3\n", "utf-8");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "initial"]);

  const headBefore = await git(repo, ["rev-parse", "HEAD"]);
  const branchBefore = await git(repo, ["branch", "--show-current"]);
  const indexBefore = await fs.readFile(path.join(repo, ".git", "index"));
  const stashBefore = await git(repo, ["stash", "list"]);

  const checkpoint = await createCheckpoint(repo);
  if (!checkpoint) throw new Error("setup failed: no checkpoint created");

  // Task's changes: modify a tracked file, add a new (untracked) file,
  // delete nothing yet — covered in a separate case below.
  await fs.writeFile(path.join(repo, "tracked.txt"), "line1\nCHANGED\nline3\n", "utf-8");
  await fs.writeFile(path.join(repo, "new-file.txt"), "brand new\n", "utf-8");

  const files = await listChangedFiles(repo, checkpoint);
  check("reports exactly the 2 changed files", files.length === 2);
  const tracked = files.find((f) => f.path === "tracked.txt");
  const added = files.find((f) => f.path === "new-file.txt");
  check("the modified tracked file is reported as modified", tracked?.status === "modified");
  check("the new untracked file is reported as added", added?.status === "added");

  const headAfter = await git(repo, ["rev-parse", "HEAD"]);
  const branchAfter = await git(repo, ["branch", "--show-current"]);
  const indexAfter = await fs.readFile(path.join(repo, ".git", "index"));
  const stashAfter = await git(repo, ["stash", "list"]);
  check("HEAD is unchanged after listing changes", headAfter === headBefore);
  check("the current branch is unchanged", branchAfter === branchBefore);
  check("the real index file is byte-for-byte unchanged (scratch index never touched it)", indexBefore.equals(indexAfter));
  check("nothing was added to the stash list", stashBefore === stashAfter);

  const changes = await getChanges(repo, checkpoint);
  const trackedChange = changes.find((c) => c.path === "tracked.txt")!;
  const addedChange = changes.find((c) => c.path === "new-file.txt")!;

  check("the modified file's diff shows the changed line as removed", trackedChange.diff.some((c) => c.removed && c.value.includes("line2")));
  check("the modified file's diff shows the new line as added", trackedChange.diff.some((c) => c.added && c.value.includes("CHANGED")));
  check("the modified file's diff preserves the unchanged surrounding lines", trackedChange.diff.some((c) => !c.added && !c.removed && c.value.includes("line1")));
  check("the added file's diff is entirely an addition", addedChange.diff.length === 1 && addedChange.diff[0]?.added === true && addedChange.diff[0]?.value === "brand new\n");

  await fs.rm(repo, { recursive: true, force: true });
}

{
  // A file that existed at checkpoint time and gets deleted by the task.
  const repo = await makeRepo();
  await fs.writeFile(path.join(repo, "doomed.txt"), "goodbye\n", "utf-8");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "initial"]);

  const checkpoint = await createCheckpoint(repo);
  if (!checkpoint) throw new Error("setup failed: no checkpoint created");

  await fs.rm(path.join(repo, "doomed.txt"));

  const files = await listChangedFiles(repo, checkpoint);
  check("the deleted file is reported as deleted", files.length === 1 && files[0]?.status === "deleted" && files[0]?.path === "doomed.txt");

  const changes = await getChanges(repo, checkpoint);
  check("a deleted file's diff shows its whole content as removed", !!changes[0]?.diff.some((c) => c.removed && c.value === "goodbye\n"));

  await fs.rm(repo, { recursive: true, force: true });
}

{
  // No changes at all since the checkpoint — an empty list, not an error.
  const repo = await makeRepo();
  await fs.writeFile(path.join(repo, "untouched.txt"), "same as ever\n", "utf-8");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "initial"]);

  const checkpoint = await createCheckpoint(repo);
  if (!checkpoint) throw new Error("setup failed: no checkpoint created");

  const files = await listChangedFiles(repo, checkpoint);
  check("no changes since the checkpoint reports an empty list", files.length === 0);

  await fs.rm(repo, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
