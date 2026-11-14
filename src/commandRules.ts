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
 * Only an ordinary local test, build or lint command can be remembered.
 * This is an allow list on purpose. A block list of risky commands can
 * always be sidestepped by a spelling it does not know: a path in front
 * of the program, a wrapper such as nohup or env, a global option before
 * the subcommand, an interpreter's -c or -e. Here anything that is not
 * recognised asks every time.
 *
 * The program must be a bare lower-case name, with no path. The checks
 * after it look only at the words that select what runs; the remaining
 * arguments are free, because a rule is one exact string that the user
 * read and approved.
 */
export function isRememberableCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > MAX_COMMAND_LENGTH || /[\r\n]/.test(trimmed)) return false;
  if (hasShellMetacharacters(trimmed)) return false;
  const risk = classifyCommand(trimmed);
  if (risk === "DESTRUCTIVE" || risk === "NETWORK") return false;
  const [program, ...args] = trimmed.split(/\s+/);
  const accepts = program ? REMEMBERABLE_PROGRAMS.get(program) : undefined;
  return accepts !== undefined && accepts(args);
}

const anyArguments = () => true;
const firstIs =
  (...subcommands: string[]) =>
  (args: string[]) =>
    args[0] !== undefined && subcommands.includes(args[0]);
/** A script path or target, not an option: rules out -e, -c, -r and the like. */
const firstIsNotAnOption = (args: string[]) => args[0] !== undefined && !args[0].startsWith("-");
const packageScript = (args: string[]) =>
  args[0] === "test" || args[0] === "t" || ((args[0] === "run" || args[0] === "run-script") && args[1] !== undefined && /^[\w:.-]+$/.test(args[1]));

const REMEMBERABLE_PROGRAMS = new Map<string, (args: string[]) => boolean>([
  ["npm", packageScript],
  ["pnpm", packageScript],
  ["yarn", packageScript],
  ["bun", packageScript],
  ["node", firstIsNotAnOption],
  ["python", (args) => (args[0] === "-m" ? args[1] === "pytest" || args[1] === "unittest" : firstIsNotAnOption(args))],
  ["python3", (args) => (args[0] === "-m" ? args[1] === "pytest" || args[1] === "unittest" : firstIsNotAnOption(args))],
  ["cargo", firstIs("test", "build", "check", "clippy", "fmt", "doc", "bench", "run")],
  ["go", firstIs("test", "build", "vet", "fmt", "run")],
  ["dotnet", firstIs("test", "build")],
  ["swift", firstIs("test", "build")],
  ["mvn", firstIs("test", "verify", "compile", "package")],
  ["gradle", firstIs("test", "build", "check", "assemble")],
  ["git", firstIs("status", "diff", "log", "show")],
  ...["make", "pytest", "jest", "vitest", "mocha", "tsc", "eslint", "prettier", "ruff", "mypy", "black", "flake8", "rspec", "phpunit", "tox", "echo", "ls", "pwd", "cat", "wc", "head", "tail"].map(
    (name): [string, (args: string[]) => boolean] => [name, anyArguments]
  ),
]);

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
