// src/test/githubPushAuth.test.ts
import { isUnauthenticatedGithubRemote, parseGitPushRemoteName, buildAuthenticatedGitPushCommand, prepareGitPushCommand } from "../electron/githubPushAuth.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("isUnauthenticatedGithubRemote:");
check("true for a bare https github.com URL", isUnauthenticatedGithubRemote("https://github.com/owner/repo.git") === true);
check("false for an already-authenticated URL", isUnauthenticatedGithubRemote("https://x-access-token:abc@github.com/owner/repo.git") === false);
check("false for an SSH remote", isUnauthenticatedGithubRemote("git@github.com:owner/repo.git") === false);
check("false for a non-github host", isUnauthenticatedGithubRemote("https://gitlab.com/owner/repo.git") === false);
check("false for a local bare repo path", isUnauthenticatedGithubRemote("/tmp/some/bare-repo.git") === false);

console.log("\nparseGitPushRemoteName:");
check("defaults to origin for a bare 'git push'", parseGitPushRemoteName("git push") === "origin");
check("defaults to origin for 'git push --set-upstream'", parseGitPushRemoteName("git push --set-upstream origin main") === "origin");
check("picks up an explicit remote name", parseGitPushRemoteName("git push upstream main") === "upstream");
check("still defaults to origin when only a branch is given after flags", parseGitPushRemoteName("git push -u origin feature-branch") === "origin");

console.log("\nbuildAuthenticatedGitPushCommand:");
{
  const { command, env } = buildAuthenticatedGitPushCommand("git push origin main", "gho_thetoken");
  check("prefixes an inline credential.helper override", command.includes("-c credential.helper="));
  check("keeps the original push arguments", command.includes("push origin main"));
  check("never embeds the raw token as a literal in the command string", !command.includes("gho_thetoken"));
  check("passes the token only via the returned env map", env.LOCALAGENT_GH_TOKEN === "gho_thetoken");
}

async function withTempGitRepo<T>(remoteUrl: string | null, fn: (repoPath: string) => Promise<T>): Promise<T> {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-github-push-test-"));
  spawnSync("git", ["init", "-q"], { cwd: repoPath });
  if (remoteUrl) spawnSync("git", ["remote", "add", "origin", remoteUrl], { cwd: repoPath });
  try {
    return await fn(repoPath);
  } finally {
    await fs.rm(repoPath, { recursive: true, force: true });
  }
}

console.log("\nprepareGitPushCommand (Review Focus: only rewrites a real, unauthenticated github.com remote):");
await withTempGitRepo("https://github.com/owner/repo.git", async (repoPath) => {
  const result = await prepareGitPushCommand("git push", repoPath, async () => "gho_thetoken");
  check("rewrites a plain push to a connected github.com remote", result.kind === "authenticated");
  if (result.kind === "authenticated") {
    check("command includes the credential helper", result.command.includes("credential.helper"));
    check("env carries the token", result.env.LOCALAGENT_GH_TOKEN === "gho_thetoken");
  }
});
await withTempGitRepo("https://gitlab.com/owner/repo.git", async (repoPath) => {
  const result = await prepareGitPushCommand("git push", repoPath, async () => "gho_thetoken");
  check("a non-github.com remote passes through unmodified", result.kind === "unchanged" && result.command === "git push");
});
await withTempGitRepo("https://github.com/owner/repo.git", async (repoPath) => {
  const result = await prepareGitPushCommand("git push", repoPath, async () => null);
  check("no connected account blocks with a clear error instead of spawning git (Review Focus)", result.kind === "blocked");
  if (result.kind === "blocked") check("error names Settings as the fix", result.reason.toLowerCase().includes("settings"));
});
await withTempGitRepo(null, async (repoPath) => {
  const result = await prepareGitPushCommand("git push", repoPath, async () => "gho_thetoken");
  check("no remote configured at all passes through unmodified (git's own error is clear enough)", result.kind === "unchanged");
});
await withTempGitRepo("https://github.com/owner/repo.git", async (repoPath) => {
  const result = await prepareGitPushCommand("git status", repoPath, async () => "gho_thetoken");
  check("a non-push command is never touched", result.kind === "unchanged" && result.command === "git status");
});
await withTempGitRepo("https://x-access-token:already@github.com/owner/repo.git", async (repoPath) => {
  const result = await prepareGitPushCommand("git push", repoPath, async () => "gho_thetoken");
  check("a remote that already embeds credentials is left alone", result.kind === "unchanged");
});

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
