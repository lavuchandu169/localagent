import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isGitRepo, createCheckpoint, revertToCheckpoint } from "../../checkpoints.js";

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-checkpoints-test-"));
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  return dir;
}

console.log("isGitRepo:");
{
  const repo = await makeRepo();
  check("a real git repo (even with zero commits) reports true", await isGitRepo(repo));
  await fs.rm(repo, { recursive: true, force: true });

  const notRepo = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-checkpoints-notrepo-"));
  check("a plain directory with no .git reports false", !(await isGitRepo(notRepo)));
  await fs.rm(notRepo, { recursive: true, force: true });
}

console.log("\ncreateCheckpoint:");
{
  const notRepo = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-checkpoints-notrepo2-"));
  check("returns null for a non-git directory", (await createCheckpoint(notRepo)) === null);
  await fs.rm(notRepo, { recursive: true, force: true });
}

{
  const repo = await makeRepo();
  check("returns null for a git repo with zero commits (nothing to parent a checkpoint on)", (await createCheckpoint(repo)) === null);
  await fs.rm(repo, { recursive: true, force: true });
}

{
  const repo = await makeRepo();
  await fs.writeFile(path.join(repo, "tracked.txt"), "original\n", "utf-8");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "initial"]);

  const headBefore = await git(repo, ["rev-parse", "HEAD"]);
  const branchBefore = await git(repo, ["branch", "--show-current"]);
  const indexBefore = await fs.readFile(path.join(repo, ".git", "index"));

  const checkpoint = await createCheckpoint(repo);
  check("returns a real commit hash for a repo with a commit", typeof checkpoint === "string" && /^[0-9a-f]{40}$/.test(checkpoint));

  const headAfter = await git(repo, ["rev-parse", "HEAD"]);
  const branchAfter = await git(repo, ["branch", "--show-current"]);
  const indexAfter = await fs.readFile(path.join(repo, ".git", "index"));
  check("HEAD is unchanged after creating a checkpoint", headAfter === headBefore);
  check("the current branch is unchanged", branchAfter === branchBefore);
  check("the real index file is byte-for-byte unchanged (scratch index never touched it)", indexBefore.equals(indexAfter));

  const stashList = await git(repo, ["stash", "list"]);
  check("nothing was added to the stash list", stashList === "");

  await fs.rm(repo, { recursive: true, force: true });
}

console.log("\nrevertToCheckpoint:");
{
  const repo = await makeRepo();
  await fs.writeFile(path.join(repo, "tracked.txt"), "original content\n", "utf-8");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "initial"]);

  const checkpoint = await createCheckpoint(repo);
  if (!checkpoint) throw new Error("setup failed: no checkpoint created");

  // Simulate a task's changes: modify the tracked file, create a new
  // untracked file, AND create a new file that gets git-added too.
  await fs.writeFile(path.join(repo, "tracked.txt"), "MODIFIED BY TASK\n", "utf-8");
  await fs.writeFile(path.join(repo, "untracked-new.txt"), "new untracked file\n", "utf-8");
  await fs.writeFile(path.join(repo, "added-new.txt"), "new file that got git add'ed\n", "utf-8");
  await git(repo, ["add", "added-new.txt"]);

  await revertToCheckpoint(repo, checkpoint);

  const trackedContent = await fs.readFile(path.join(repo, "tracked.txt"), "utf-8");
  check("the modified tracked file's content is restored to the checkpoint's version", trackedContent === "original content\n");

  const untrackedExists = await fs
    .access(path.join(repo, "untracked-new.txt"))
    .then(() => true)
    .catch(() => false);
  check("a newly-created UNTRACKED file (never git add'ed) is removed", !untrackedExists);

  const addedExists = await fs
    .access(path.join(repo, "added-new.txt"))
    .then(() => true)
    .catch(() => false);
  check("a newly-created file that WAS git add'ed is also removed", !addedExists);

  await fs.rm(repo, { recursive: true, force: true });
}

{
  // A file that existed at checkpoint time, then got deleted by the task —
  // revert must bring it back.
  const repo = await makeRepo();
  await fs.writeFile(path.join(repo, "will-be-deleted.txt"), "keep me\n", "utf-8");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "initial"]);

  const checkpoint = await createCheckpoint(repo);
  if (!checkpoint) throw new Error("setup failed: no checkpoint created");

  await fs.rm(path.join(repo, "will-be-deleted.txt"));
  await revertToCheckpoint(repo, checkpoint);

  const restoredContent = await fs.readFile(path.join(repo, "will-be-deleted.txt"), "utf-8").catch(() => null);
  check("a file deleted by the task is restored on revert", restoredContent === "keep me\n");

  await fs.rm(repo, { recursive: true, force: true });
}

{
  // The checkpoint itself must capture UNTRACKED files present at checkpoint
  // time too (not just tracked ones) — otherwise reverting after further
  // task changes would lose them.
  const repo = await makeRepo();
  await fs.writeFile(path.join(repo, "tracked.txt"), "tracked\n", "utf-8");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "initial"]);
  // Untracked BEFORE the checkpoint is taken — should be part of the snapshot.
  await fs.writeFile(path.join(repo, "untracked-before-checkpoint.txt"), "was here at checkpoint time\n", "utf-8");

  const checkpoint = await createCheckpoint(repo);
  if (!checkpoint) throw new Error("setup failed: no checkpoint created");

  // Task deletes it, then revert should bring it back — proving it was
  // actually captured in the checkpoint's tree, not just ignored.
  await fs.rm(path.join(repo, "untracked-before-checkpoint.txt"));
  await revertToCheckpoint(repo, checkpoint);

  const restored = await fs.readFile(path.join(repo, "untracked-before-checkpoint.txt"), "utf-8").catch(() => null);
  check("an untracked file present AT checkpoint time is captured and restored on revert", restored === "was here at checkpoint time\n");

  await fs.rm(repo, { recursive: true, force: true });
}

if (process.platform !== "win32") {
  // Functional-correctness audit finding (agent core High #1):
  // createCheckpoint's own doc comment promises it degrades to null on
  // EVERY failure, so a caller never has to handle it throwing — but
  // fs.mkdtemp was called BEFORE the try block that catches every other
  // failure mode, so a tmpdir failure (e.g. a read-only/quota-exhausted
  // TMPDIR, realistic in a sandboxed/containerized environment) threw
  // instead, aborting the whole task in agent.ts rather than just
  // skipping the checkpoint like every other failure path does.
  const repo = await makeRepo();
  await fs.writeFile(path.join(repo, "a.txt"), "hello\n", "utf-8");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "initial"]);

  const unwritableTmp = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-checkpoints-unwritable-"));
  await fs.chmod(unwritableTmp, 0o000);
  const realTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = unwritableTmp;
  let threw = false;
  let result: string | null = null;
  try {
    result = await createCheckpoint(repo);
  } catch {
    threw = true;
  } finally {
    process.env.TMPDIR = realTmpdir;
    await fs.chmod(unwritableTmp, 0o700);
    await fs.rm(unwritableTmp, { recursive: true, force: true });
  }
  check("a tmpdir failure degrades to null rather than throwing, matching every other failure path", !threw && result === null);

  await fs.rm(repo, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
