import { byId, errorMessage, withBusyLabel } from "./domHelpers.js";
import { openOverlayPanel, closeOverlayPanel } from "./overlayPanel.js";
import type { McpServerStatus } from "./renderer.js";

// Architecture finding (code-review-and-quality pass, part 3 of
// renderer.ts's decomposition): the MCP servers panel — list view, the
// add-server form, remove — moved out of renderer.ts. Fully self-
// contained: no other part of the app reads or writes this panel's DOM,
// so (unlike the About panel in part 2) nothing here needed to become a
// setter/getter for outside callers. The one piece of shared state it
// touches is window.agent itself (same ambient global every renderer
// file already has), plus McpServerStatus — a type genuinely owned by
// the AgentBridge interface in renderer.ts, imported back type-only
// (erased at compile time, so this isn't a real circular dependency).

type McpServerView = { id: string; name: string; command: string; args: string[]; status: McpServerStatus };

const mcpServersToggle = byId<HTMLButtonElement>("mcp-servers-toggle");
const mcpServersPanel = byId<HTMLDivElement>("mcp-servers-panel");
const mcpServersListView = byId<HTMLDivElement>("mcp-servers-list-view");
const mcpServersList = byId<HTMLDivElement>("mcp-servers-list");
const mcpServersListError = byId<HTMLDivElement>("mcp-servers-list-error");
const mcpServersEmpty = byId<HTMLDivElement>("mcp-servers-empty");
const mcpServersAddToggle = byId<HTMLButtonElement>("mcp-servers-add-toggle");
const mcpServersFormView = byId<HTMLDivElement>("mcp-servers-form-view");
const mcpServersFormBack = byId<HTMLButtonElement>("mcp-servers-form-back");
const mcpServerNameInput = byId<HTMLInputElement>("mcp-server-name");
const mcpServerCommandInput = byId<HTMLInputElement>("mcp-server-command");
const mcpServerArgsInput = byId<HTMLInputElement>("mcp-server-args");
const mcpServerEnvInput = byId<HTMLTextAreaElement>("mcp-server-env");
const mcpServerFormError = byId<HTMLDivElement>("mcp-server-form-error");
const mcpServerFormSave = byId<HTMLButtonElement>("mcp-server-form-save");
const mcpServersClose = byId<HTMLButtonElement>("mcp-servers-close");
const mcpServersCloseX = byId<HTMLButtonElement>("mcp-servers-close-x");

/** For renderer.ts's shared Escape/closeAllFullScreenModals dispatchers, which cover several unrelated panels and so can't themselves live in this module. */
export function isMcpServersPanelOpen(): boolean {
  return !mcpServersPanel.hidden;
}

export function closeMcpServersPanel(): void {
  closeOverlayPanel(mcpServersPanel);
  mcpServersToggle.setAttribute("aria-expanded", "false");
  mcpServersToggle.focus();
}

function showMcpServersListView(): void {
  mcpServersFormView.hidden = true;
  mcpServersListView.hidden = false;
  mcpServerFormError.textContent = "";
}

/** Builds one server row via createElement/.textContent, never innerHTML — server.name/command/args and a failed connection's status.error are all untrusted (user-typed, or emitted by a third-party MCP server process), so they must never be parsed as HTML. Same pattern as refreshDownloadedModelsList's list items elsewhere in this file. */
function renderMcpServerRow(server: McpServerView): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "mcp-server-row";
  const dot = server.status.state === "connected" ? "🟢" : server.status.state === "connecting" ? "🟡" : "🔴";
  const detail =
    server.status.state === "connected"
      ? `${server.status.toolCount} tool${server.status.toolCount === 1 ? "" : "s"} available`
      : server.status.state === "connecting"
        ? "Connecting…"
        : server.status.error;

  const dotSpan = document.createElement("span");
  dotSpan.className = "mcp-server-status-dot";
  dotSpan.textContent = dot;

  const nameSpan = document.createElement("span");
  nameSpan.className = "mcp-server-name";
  nameSpan.textContent = server.name;

  const commandSpan = document.createElement("span");
  commandSpan.className = "mcp-server-detail";
  commandSpan.textContent = [server.command, ...server.args].join(" ");

  const detailSpan = document.createElement("span");
  detailSpan.className = "mcp-server-detail";
  detailSpan.textContent = detail;

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", () => {
    void (async () => {
      try {
        await window.agent.removeMcpServer(server.id);
      } catch (err) {
        mcpServersListError.textContent = `Couldn't remove "${server.name}": ${errorMessage(err)}`;
      }
      await refreshMcpServersList();
    })();
  });

  row.appendChild(dotSpan);
  row.appendChild(nameSpan);
  row.appendChild(commandSpan);
  row.appendChild(detailSpan);
  row.appendChild(removeBtn);
  return row;
}

/** Never throws — a failure to list (or, via the callers above, to remove) a server leaves the panel showing stale data, but always with a visible reason rather than silently, per the existing #mcp-server-form-error pattern this mirrors for the list view. */
async function refreshMcpServersList(): Promise<void> {
  try {
    const servers = await window.agent.listMcpServers();
    mcpServersListError.textContent = "";
    mcpServersList.innerHTML = "";
    mcpServersEmpty.hidden = servers.length > 0;
    for (const server of servers) mcpServersList.appendChild(renderMcpServerRow(server));
  } catch (err) {
    mcpServersListError.textContent = `Couldn't load MCP servers: ${errorMessage(err)}`;
  }
}

/** One KEY=value per line; blank lines and lines with no '=' are ignored. */
function parseEnvVarsText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

export interface McpServersPanelDeps {
  /** Closes every other full-screen modal first (mutual exclusion) — returns false if the caller should abort, same contract as every other panel's open path. */
  closeOtherFullScreenModals: () => boolean;
}

/** Opens the panel unconditionally — used by both the toggle button's "currently closed" branch and the command palette's "Open MCP Servers" entry, which always wants it open regardless of current state. */
export function openMcpServersPanel(deps: McpServersPanelDeps): void {
  if (!deps.closeOtherFullScreenModals()) return;
  openOverlayPanel(mcpServersPanel);
  mcpServersToggle.setAttribute("aria-expanded", "true");
  showMcpServersListView();
  void refreshMcpServersList();
}

export function initMcpServersPanel(deps: McpServersPanelDeps): void {
  mcpServersToggle.addEventListener("click", () => {
    if (mcpServersPanel.hidden) {
      openMcpServersPanel(deps);
    } else {
      // Deliberately not closeMcpServersPanel() here: the user is already
      // focused on the toggle they just clicked, so re-focusing it (what
      // closeMcpServersPanel's refocus is for) would be a no-op at best.
      closeOverlayPanel(mcpServersPanel);
      mcpServersToggle.setAttribute("aria-expanded", "false");
    }
  });

  mcpServersClose.addEventListener("click", closeMcpServersPanel);
  mcpServersCloseX.addEventListener("click", closeMcpServersPanel);
  mcpServersPanel.addEventListener("click", (e) => {
    if (e.target === mcpServersPanel) closeMcpServersPanel();
  });

  mcpServersAddToggle.addEventListener("click", () => {
    mcpServerNameInput.value = "";
    mcpServerCommandInput.value = "";
    mcpServerArgsInput.value = "";
    mcpServerEnvInput.value = "";
    mcpServerFormError.textContent = "";
    mcpServersListView.hidden = true;
    mcpServersFormView.hidden = false;
    mcpServerNameInput.focus();
  });

  mcpServersFormBack.addEventListener("click", showMcpServersListView);

  mcpServerFormSave.addEventListener("click", () => {
    mcpServerFormError.textContent = "";
    const name = mcpServerNameInput.value.trim();
    const command = mcpServerCommandInput.value.trim();
    if (!name || !command) {
      mcpServerFormError.textContent = "Name and command are required.";
      return;
    }
    const args = mcpServerArgsInput.value.trim().split(/\s+/).filter(Boolean);
    const env = parseEnvVarsText(mcpServerEnvInput.value);
    void withBusyLabel(mcpServerFormSave, "Saving…", async () => {
      try {
        const result = await window.agent.addMcpServer({ name, command, args, env });
        if (result.ok) {
          showMcpServersListView();
          await refreshMcpServersList();
        } else {
          mcpServerFormError.textContent = result.error;
        }
      } catch (err) {
        mcpServerFormError.textContent = errorMessage(err);
      }
    });
  });

  window.agent.onMcpServerStatusChanged(() => {
    if (!mcpServersPanel.hidden && !mcpServersListView.hidden) void refreshMcpServersList();
  });
}
