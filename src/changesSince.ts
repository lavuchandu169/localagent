import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { computeFileDiff } from "./diffCompute.js";
import type { Change } from "diff";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env });
  return stdout;
}

export type ChangeStatus = "added" | "modified" | "deleted";

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
}

export interface FileChangeWithDiff extends ChangedFile {
  diff: Change[];
}

/**
 * Builds the same kind of scratch-index snapshot createCheckpoint uses, but
 * only up to write-tree — no commit-tree, so nothing is added to the repo's
 * history or refs (the tree object itself is unreferenced and eventually
 * garbage-collected by git, same as any other loose object that never got a
 * name). Never touches the real index, HEAD, or any branch.
 */
async function buildCurrentTree(workspaceRoot: string): Promise<string> {
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-changes-"));
  const scratchIndex = path.join(scratchDir, "index");
  try {
    const env = { ...process.env, GIT_INDEX_FILE: scratchIndex };
    const head = (await runGit(workspaceRoot, ["rev-parse", "HEAD"])).trim();
    await runGit(workspaceRoot, ["read-tree", head], env);
    await runGit(workspaceRoot, ["add", "-A"], env);
    return (await runGit(workspaceRoot, ["write-tree"], env)).trim();
  } finally {
    await fs.rm(scratchDir, { recursive: true, force: true });
  }
}

const STATUS_LETTERS: Record<string, ChangeStatus> = { A: "added", M: "modified", D: "deleted" };

/**
 * Lists every file that differs between the checkpoint and the workspace
 * right now — additions, modifications, and deletions, tracked or not
 * (both trees are built the same tracked+untracked way, so this isn't
 * limited to what plain `git diff` against a commit would show). Renames
 * are deliberately not detected (--no-renames): edit_file never renames a
 * file, so a rename only happens via a run_command like `mv`/`git mv`,
 * where showing it as a delete+add is simple, correct, and not worth the
 * added complexity of a third "renamed" status for v1.
 */
export async function listChangedFiles(workspaceRoot: string, checkpointHash: string): Promise<ChangedFile[]> {
  const currentTree = await buildCurrentTree(workspaceRoot);
  const out = await runGit(workspaceRoot, ["diff", "--name-status", "--no-renames", checkpointHash, currentTree]);
  const files: ChangedFile[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [letter, ...pathParts] = line.split("\t");
    const status = letter ? STATUS_LETTERS[letter] : undefined;
    if (!status) continue; // ignores anything unexpected rather than guessing
    files.push({ path: pathParts.join("\t"), status });
  }
  return files;
}

/** Reads a file's content as it existed in the checkpoint commit, or null if it didn't exist there (a newly-added file). */
async function readAtCheckpoint(workspaceRoot: string, checkpointHash: string, relPath: string): Promise<string | null> {
  try {
    return await runGit(workspaceRoot, ["show", `${checkpointHash}:${relPath}`]);
  } catch {
    return null;
  }
}

/**
 * Same file list as listChangedFiles, with each entry's actual diff
 * attached — reusing computeFileDiff, the exact function the per-edit
 * approval diff view already uses, so this renders identically. A file
 * that fails to read (permissions, or it's since become something odd
 * like a directory) gets an empty diff rather than failing the whole
 * batch — one unreadable file shouldn't hide every other change.
 */
export async function getChanges(workspaceRoot: string, checkpointHash: string): Promise<FileChangeWithDiff[]> {
  const files = await listChangedFiles(workspaceRoot, checkpointHash);
  const results: FileChangeWithDiff[] = [];
  for (const file of files) {
    let oldContent: string | null = null;
    let newContent = "";
    try {
      oldContent = file.status === "added" ? null : await readAtCheckpoint(workspaceRoot, checkpointHash, file.path);
      newContent = file.status === "deleted" ? "" : await fs.readFile(path.join(workspaceRoot, file.path), "utf-8");
    } catch {
      // Leave oldContent/newContent at their defaults — an unreadable file
      // (permissions, binary, since replaced by a directory) still gets a
      // list entry, just with an empty diff instead of crashing the batch.
    }
    results.push({ ...file, diff: computeFileDiff(oldContent, newContent) });
  }
  return results;
}
