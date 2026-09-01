import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env });
  return stdout;
}

export async function isGitRepo(workspaceRoot: string): Promise<boolean> {
  try {
    const out = await runGit(workspaceRoot, ["rev-parse", "--is-inside-work-tree"]);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Snapshots the ENTIRE current working-tree state (tracked and untracked
 * files, respecting .gitignore) into a real git commit object — done
 * entirely through a scratch index file (GIT_INDEX_FILE) so it never
 * touches the user's actual index, working tree, HEAD, or any branch/ref.
 * Completely invisible to their normal git workflow: no stash entry, no
 * commit on their current branch, nothing `git status` would ever show.
 *
 * Returns the checkpoint commit's hash, or null if this isn't a git repo,
 * has no commits yet (nothing to parent a checkpoint commit on), or
 * anything about the snapshot fails for any other reason — checkpoints
 * degrade to "unavailable" in every failure case rather than ever risking
 * a bad revert target being offered.
 */
export async function createCheckpoint(workspaceRoot: string): Promise<string | null> {
  if (!(await isGitRepo(workspaceRoot))) return null;

  let head: string;
  try {
    head = (await runGit(workspaceRoot, ["rev-parse", "HEAD"])).trim();
    if (!head) return null;
  } catch {
    return null; // no commits yet
  }

  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-checkpoint-"));
  const scratchIndex = path.join(scratchDir, "index");
  try {
    const env = { ...process.env, GIT_INDEX_FILE: scratchIndex };
    // Seed the scratch index from HEAD (the tracked-file baseline), then
    // stage the real working tree on top of it in that SAME scratch index —
    // captures every current change, including untracked files, excluding
    // whatever .gitignore excludes. The real index is never touched.
    await runGit(workspaceRoot, ["read-tree", head], env);
    await runGit(workspaceRoot, ["add", "-A"], env);
    const treeHash = (await runGit(workspaceRoot, ["write-tree"], env)).trim();
    const commitHash = (await runGit(workspaceRoot, ["commit-tree", treeHash, "-p", head, "-m", "localagent checkpoint"], env)).trim();
    return commitHash || null;
  } catch {
    return null;
  } finally {
    await fs.rm(scratchDir, { recursive: true, force: true });
  }
}

/**
 * Restores the workspace to exactly the state createCheckpoint captured:
 * every file that existed then gets its checkpoint content back (even if
 * the task went on to delete it), and every file that didn't exist then —
 * created by the task since — is deleted. Getting that second half wrong
 * would silently leave junk files behind, so it's computed explicitly via
 * git's own file listing (which respects .gitignore) rather than a manual
 * filesystem walk that could disagree with what was actually snapshotted.
 */
export async function revertToCheckpoint(workspaceRoot: string, checkpointHash: string): Promise<void> {
  const checkpointFiles = new Set(
    (await runGit(workspaceRoot, ["ls-tree", "-r", "--name-only", checkpointHash])).split("\n").filter(Boolean)
  );
  const currentFiles = (await runGit(workspaceRoot, ["ls-files", "-c", "-o", "--exclude-standard"])).split("\n").filter(Boolean);
  const createdSinceCheckpoint = currentFiles.filter((f) => !checkpointFiles.has(f));

  await runGit(workspaceRoot, ["checkout", checkpointHash, "--", "."]);
  for (const relPath of createdSinceCheckpoint) {
    await fs.rm(path.join(workspaceRoot, relPath), { force: true });
  }
}
