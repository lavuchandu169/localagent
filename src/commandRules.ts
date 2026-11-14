import { promises as fs } from "node:fs";
import path from "node:path";
import { classifyCommand, hasShellMetacharacters } from "./permissions.js";

/**
 * "Always allow this command in this workspace" rules. A rule is one
 * exact command string: a different flag or argument is a different
 * command and asks again. The rules file lives in the app's own data
 * folder, never in the workspace, so a cloned repository cannot grant
 * itself permission to run anything.
 */
export const MAX_COMMANDS_PER_WORKSPACE = 200;
const MAX_COMMAND_LENGTH = 500;

/**
 * Some commands ask every time, with no way to turn that off:
 * destructive ones; network ones, because the same text can fetch or
 * send something different on each run; and anything with shell
 * metacharacters, because a compound command can hide a second one.
 */
export function isRememberableCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > MAX_COMMAND_LENGTH || /[\r\n]/.test(trimmed)) return false;
  if (hasShellMetacharacters(trimmed)) return false;
  if (NEVER_REMEMBER.some((r) => r.test(trimmed))) return false;
  const risk = classifyCommand(trimmed);
  return risk !== "DESTRUCTIVE" && risk !== "NETWORK";
}

/**
 * classifyCommand's NETWORK and DESTRUCTIVE lists name only a few
 * spellings. A standing rule needs a wider net: package installs and
 * package runners in every common tool, git commands that fetch or
 * rewrite the working tree, remote access, containers, and commands
 * that move, re-permission or kill things. This is still a list of
 * known risks, not a proof that every other command is safe: a rule is
 * the user's own standing approval of one exact command.
 */
const NEVER_REMEMBER: RegExp[] = [
  /^(npm|pnpm|yarn|bun)\s+(i|install|add|ci|update|upgrade|up|exec|dlx|x|create|link|publish|remove|rm|uninstall)\b/,
  /^yarn\s*$/,
  /^(npx|bunx|pnpx)\b/,
  /^(pip|pip3|pipx|uv|poetry|pipenv|conda|gem|brew|apt|apt-get|yum|dnf|pacman|choco|winget)\b/,
  /^python3?\s+-m\s+(pip|ensurepip|venv)\b/,
  /^cargo\s+(install|add|update|publish|fetch)\b/,
  /^go\s+(get|install|mod)\b/,
  /^git\s+(pull|fetch|clone|push|checkout|switch|clean|reset|restore|rebase|merge|stash|submodule|apply|am|cherry-pick|revert|commit|remote|config|worktree|gc|filter-branch)\b/,
  /^(curl|wget|ssh|scp|sftp|rsync|nc|ncat|netcat|telnet|ftp)\b/,
  /^(docker|podman|kubectl|helm|terraform)\b/,
  /^(chmod|chown|chgrp|mv|dd|kill|pkill|killall|shutdown|reboot|launchctl|systemctl|crontab|open|osascript|eval|exec|source|sh|bash|zsh|env)\b/,
];

type RulesFile = { version: 1; workspaces: Record<string, string[]> };

async function workspaceKey(workspaceRoot: string): Promise<string> {
  try {
    return await fs.realpath(workspaceRoot);
  } catch {
    return path.resolve(workspaceRoot);
  }
}

/** Never throws: a missing or damaged file reads as no rules. */
async function readRules(filePath: string): Promise<RulesFile> {
  const empty: RulesFile = { version: 1, workspaces: {} };
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    const workspaces = (parsed as { workspaces?: unknown } | null)?.workspaces;
    if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces)) return empty;
    for (const [key, value] of Object.entries(workspaces as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const commands = value.filter((c): c is string => typeof c === "string" && isRememberableCommand(c)).map((c) => c.trim());
      empty.workspaces[key] = [...new Set(commands)].slice(0, MAX_COMMANDS_PER_WORKSPACE);
    }
    return empty;
  } catch {
    return empty;
  }
}

let tmpCounter = 0;

async function writeRules(filePath: string, rules: RulesFile): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${++tmpCounter}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rules, null, 2), { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

/**
 * Every change to a rules file is a read, a modification and a write.
 * Two of them at the same time would lose one of the changes, so each
 * file's changes run one after the other.
 */
const pendingChanges = new Map<string, Promise<unknown>>();

function inOrder<T>(filePath: string, change: () => Promise<T>): Promise<T> {
  const previous = pendingChanges.get(filePath) ?? Promise.resolve();
  const next = previous.then(change, change);
  pendingChanges.set(
    filePath,
    next.catch(() => {})
  );
  return next;
}

/** Reads wait for pending changes, so a read never returns rules that a clear in progress is about to remove. */
export async function listAllowedCommands(filePath: string, workspaceRoot: string): Promise<string[]> {
  return inOrder(filePath, async () => (await readRules(filePath)).workspaces[await workspaceKey(workspaceRoot)] ?? []);
}

function isSameOrNested(a: string, b: string): boolean {
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/** Returns false when the command cannot be remembered or the workspace is at its limit. */
export async function addAllowedCommand(filePath: string, workspaceRoot: string, command: string): Promise<boolean> {
  if (!isRememberableCommand(command)) return false;
  const trimmed = command.trim();
  return inOrder(filePath, async () => {
    const rules = await readRules(filePath);
    const key = await workspaceKey(workspaceRoot);
    const commands = rules.workspaces[key] ?? [];
    if (commands.includes(trimmed)) return true;
    if (commands.length >= MAX_COMMANDS_PER_WORKSPACE) return false;
    rules.workspaces[key] = [...commands, trimmed];
    await writeRules(filePath, rules);
    return true;
  });
}

export async function removeAllowedCommand(filePath: string, workspaceRoot: string, command: string): Promise<void> {
  return inOrder(filePath, async () => {
    const rules = await readRules(filePath);
    const key = await workspaceKey(workspaceRoot);
    const commands = rules.workspaces[key];
    if (!commands) return;
    const remaining = commands.filter((c) => c !== command.trim());
    if (remaining.length === commands.length) return;
    if (remaining.length > 0) rules.workspaces[key] = remaining;
    else delete rules.workspaces[key];
    await writeRules(filePath, rules);
  });
}

/** Removes every rule of a workspace, and of any workspace that contains it or sits inside it: used when a file there changed with no prompt, so no stored rule can run what changed. */
export async function clearAllowedCommands(filePath: string, workspaceRoot: string): Promise<void> {
  return inOrder(filePath, async () => {
    const rules = await readRules(filePath);
    const key = await workspaceKey(workspaceRoot);
    // A file under this root also belongs to any workspace opened on a
    // parent folder or on a folder nested inside it.
    const affected = Object.keys(rules.workspaces).filter((k) => isSameOrNested(k, key) || isSameOrNested(key, k));
    if (affected.length === 0) return;
    for (const k of affected) delete rules.workspaces[k];
    await writeRules(filePath, rules);
  });
}
