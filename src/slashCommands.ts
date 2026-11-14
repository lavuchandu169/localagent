import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Slash commands: a task that starts with "/name" is handled before it
 * reaches the model. Built-in commands act on the session. A custom
 * command is a Markdown file whose text becomes the task, with
 * $ARGUMENTS replaced by whatever followed the name.
 *
 * Custom commands are read from the user's own folder
 * (~/.localagent/commands), never from the workspace: the expanded text
 * is sent as the user's request, so a cloned repository must not be
 * able to supply it.
 */
const COMMAND_NAME = /^[a-z0-9][a-z0-9-]*$/;
const MAX_TEMPLATE_CHARS = 20_000;
const BUILTIN_COMMANDS: { name: string; description: string }[] = [
  { name: "compact", description: "Summarise the older part of this conversation to free up context" },
  { name: "help", description: "List the available commands" },
];

export interface CustomCommand {
  name: string;
  description: string;
  template: string;
}

export type SlashResolution =
  | { kind: "task"; task: string; /** Set when the task came from a custom command. */ command?: string }
  | { kind: "compact" }
  | { kind: "message"; text: string };

/**
 * Returns null unless the text starts with "/name" followed by a space
 * or the end. "/Users/me/a.ts is broken" is a path, not a command.
 */
export function parseSlashCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match || !COMMAND_NAME.test(match[1]!)) return null;
  return { name: match[1]!, args: (match[2] ?? "").trim() };
}

export function expandCommand(template: string, args: string): string {
  if (template.includes("$ARGUMENTS")) return template.split("$ARGUMENTS").join(args);
  return args ? `${template}\n\n${args}` : template;
}

/** Never throws: a missing folder means no commands, and a file that cannot be used is skipped with a warning. */
export async function loadCustomCommands(commandsDir: string | undefined): Promise<CustomCommand[]> {
  if (!commandsDir) return [];
  let entries;
  try {
    entries = await fs.readdir(commandsDir, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code !== "ENOENT") console.warn(`[commands] could not list "${commandsDir}": ${err?.message ?? err}`);
    return [];
  }
  const commands: CustomCommand[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!entry.name.endsWith(".md")) continue;
    const name = entry.name.slice(0, -3);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      console.warn(`[commands] skipping "${entry.name}": only regular files are supported`);
      continue;
    }
    if (!COMMAND_NAME.test(name)) {
      console.warn(`[commands] skipping "${entry.name}": a command name uses only lower-case letters, digits and hyphens`);
      continue;
    }
    if (BUILTIN_COMMANDS.some((b) => b.name === name)) {
      console.warn(`[commands] skipping "${entry.name}": /${name} is a built-in command`);
      continue;
    }
    let raw: string;
    try {
      raw = await fs.readFile(path.join(commandsDir, entry.name), "utf8");
    } catch (err: any) {
      console.warn(`[commands] skipping "${entry.name}": ${err?.message ?? err}`);
      continue;
    }
    const template = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).trim();
    if (!template) continue;
    if (template.length > MAX_TEMPLATE_CHARS) {
      console.warn(`[commands] skipping "${entry.name}": longer than ${MAX_TEMPLATE_CHARS} characters`);
      continue;
    }
    const firstLine = template.split("\n", 1)[0]!.replace(/^#+\s*/, "").trim();
    commands.push({ name, description: firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine, template });
  }
  return commands;
}

function helpText(custom: CustomCommand[], commandsDir: string | undefined): string {
  // Written as Markdown lists: the app renders this text as Markdown, where plain line breaks would run together.
  const lines = ["Built-in commands:", "", ...BUILTIN_COMMANDS.map((c) => `- \`/${c.name}\`: ${c.description}`)];
  if (custom.length > 0) lines.push("", "Your commands:", "", ...custom.map((c) => `- \`/${c.name}\`: ${c.description}`));
  if (commandsDir) {
    lines.push("", `To add a command, put a Markdown file in \`${commandsDir}\`. The file name is the command name. \`$ARGUMENTS\` in the text is replaced by what you type after the name.`);
  }
  return lines.join("\n");
}

/** Decides what a typed task means. Text that is not a command comes back unchanged. */
export async function resolveSlashCommand(text: string, commandsDir: string | undefined): Promise<SlashResolution> {
  const parsed = parseSlashCommand(text);
  if (!parsed) return { kind: "task", task: text };
  if (parsed.name === "compact") return { kind: "compact" };
  const custom = await loadCustomCommands(commandsDir);
  if (parsed.name === "help") return { kind: "message", text: helpText(custom, commandsDir) };
  const command = custom.find((c) => c.name === parsed.name);
  if (!command) return { kind: "message", text: `There is no command /${parsed.name}. Type /help to see the available commands.` };
  return { kind: "task", task: expandCommand(command.template, parsed.args), command: command.name };
}
