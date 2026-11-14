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
  const risk = classifyCommand(trimmed);
  return risk !== "DESTRUCTIVE" && risk !== "NETWORK";
}

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

async function writeRules(filePath: string, rules: RulesFile): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rules, null, 2), { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

export async function listAllowedCommands(filePath: string, workspaceRoot: string): Promise<string[]> {
  return (await readRules(filePath)).workspaces[await workspaceKey(workspaceRoot)] ?? [];
}

/** Returns false when the command cannot be remembered or the workspace is at its limit. */
export async function addAllowedCommand(filePath: string, workspaceRoot: string, command: string): Promise<boolean> {
  if (!isRememberableCommand(command)) return false;
  const trimmed = command.trim();
  const rules = await readRules(filePath);
  const key = await workspaceKey(workspaceRoot);
  const commands = rules.workspaces[key] ?? [];
  if (commands.includes(trimmed)) return true;
  if (commands.length >= MAX_COMMANDS_PER_WORKSPACE) return false;
  rules.workspaces[key] = [...commands, trimmed];
  await writeRules(filePath, rules);
  return true;
}

export async function removeAllowedCommand(filePath: string, workspaceRoot: string, command: string): Promise<void> {
  const rules = await readRules(filePath);
  const key = await workspaceKey(workspaceRoot);
  const commands = rules.workspaces[key];
  if (!commands) return;
  const remaining = commands.filter((c) => c !== command.trim());
  if (remaining.length === commands.length) return;
  if (remaining.length > 0) rules.workspaces[key] = remaining;
  else delete rules.workspaces[key];
  await writeRules(filePath, rules);
}
