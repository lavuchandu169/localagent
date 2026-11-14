import { byId } from "./domHelpers.js";

// The Settings section that lists the active workspace's "always allow"
// commands and lets the user remove one. The rules themselves live in
// the main process (commandRules.ts); this module only shows them.

const hint = byId<HTMLParagraphElement>("command-rules-hint");
const list = byId<HTMLUListElement>("command-rules-list");

export interface CommandRulesPanelDeps {
  /** The active tab's workspace, or null when no folder is chosen. */
  getWorkspaceRoot: () => string | null;
}

let deps: CommandRulesPanelDeps | null = null;

export function initCommandRulesPanel(d: CommandRulesPanelDeps): void {
  deps = d;
}

/** Re-reads the rules for the active workspace and redraws the list. Call when Settings opens. */
export async function refreshCommandRulesPanel(): Promise<void> {
  const workspaceRoot = deps?.getWorkspaceRoot() ?? null;
  list.replaceChildren();
  if (!workspaceRoot) {
    hint.textContent = "Choose a workspace to see its always-allowed commands.";
    return;
  }
  let commands: string[];
  try {
    commands = await window.agent.listCommandRules(workspaceRoot);
  } catch {
    hint.textContent = "Could not read the always-allowed commands.";
    return;
  }
  hint.textContent =
    commands.length === 0
      ? `No always-allowed commands for ${workspaceRoot}. To add one, select "Always allow" when the agent asks to run a command.`
      : `These commands run without asking in ${workspaceRoot}:`;
  for (const command of commands) {
    const item = document.createElement("li");
    item.className = "command-rule";
    const text = document.createElement("code");
    text.textContent = command;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "command-rule-remove";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove always-allowed command: ${command}`);
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await window.agent.removeCommandRule(workspaceRoot, command);
      } finally {
        await refreshCommandRulesPanel();
      }
    });
    item.append(text, remove);
    list.appendChild(item);
  }
}
