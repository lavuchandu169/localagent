// src/electron/githubPushAuth.ts
import { spawn } from "node:child_process";

export function isUnauthenticatedGithubRemote(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false; // SSH shorthand (git@github.com:owner/repo.git) and local paths aren't parseable URLs — neither needs this rewrite.
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname !== "github.com") return false;
  if (parsed.username || parsed.password) return false; // already has embedded credentials
  return true;
}

/** Mirrors git's own default: the named remote right after "push" (skipping
 * leading flags like -u/--set-upstream), or "origin" if none is named. Good
 * enough for the common invocation shapes this feature targets — it never
 * needs to be a full git-argument parser, since a shape it doesn't
 * recognize just falls through to parseGitPushRemoteName's "origin"
 * default, which prepareGitPushCommand then verifies against the real
 * configured remote before doing anything. */
export function parseGitPushRemoteName(command: string): string {
  const afterPush = command.trim().replace(/^git\s+push\s*/, "");
  const tokens = afterPush.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (token.startsWith("-")) continue;
    return token;
  }
  return "origin";
}

export function buildAuthenticatedGitPushCommand(command: string, token: string): { command: string; env: Record<string, string> } {
  const helper = `!f() { echo username=x-access-token; echo \"password=$LOCALAGENT_GH_TOKEN\"; }; f`;
  const rewritten = command.replace(/^git\s+/, `git -c credential.helper='${helper}' `);
  return { command: rewritten, env: { LOCALAGENT_GH_TOKEN: token } };
}

async function getConfiguredRemoteUrl(workspaceRoot: string, remoteName: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["remote", "get-url", remoteName], { cwd: workspaceRoot });
    let stdout = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.on("close", (code) => resolve(code === 0 ? stdout.trim() : null));
    proc.on("error", () => resolve(null));
  });
}

export type PreparedCommand =
  | { kind: "unchanged"; command: string }
  | { kind: "authenticated"; command: string; env: Record<string, string> }
  | { kind: "blocked"; reason: string };

/**
 * Decides whether a run_command invocation needs GitHub push authentication
 * injected, and produces the rewritten command if so. Never touches
 * anything but an actual `git push` targeting an unauthenticated
 * github.com HTTPS remote (Review Focus: non-github remotes pass through
 * untouched). When that IS the target but no account is connected, blocks
 * with a clear, actionable error rather than letting git fail confusingly
 * on its own (Review Focus) — the caller must not spawn git at all in that
 * case.
 */
export async function prepareGitPushCommand(command: string, workspaceRoot: string, getToken: () => Promise<string | null>): Promise<PreparedCommand> {
  if (!/^git\s+push\b/.test(command.trim())) return { kind: "unchanged", command };

  const remoteName = parseGitPushRemoteName(command);
  const remoteUrl = await getConfiguredRemoteUrl(workspaceRoot, remoteName);
  if (!remoteUrl || !isUnauthenticatedGithubRemote(remoteUrl)) return { kind: "unchanged", command };

  const token = await getToken();
  if (!token) {
    return { kind: "blocked", reason: "This push targets GitHub, but no GitHub account is connected — connect one in Settings first." };
  }
  const { command: rewritten, env } = buildAuthenticatedGitPushCommand(command, token);
  return { kind: "authenticated", command: rewritten, env };
}
