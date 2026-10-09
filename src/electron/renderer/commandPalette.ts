import { byId } from "./domHelpers.js";
import { openOverlayPanel, closeOverlayPanel } from "./overlayPanel.js";
import type { SessionIndexEntry } from "./renderer.js";

// Architecture finding (code-review-and-quality pass, part 5 of
// renderer.ts's decomposition): the command palette (Ctrl+K / ⌘K) —
// navigation only: jump to an existing session, or open one of the other
// full-screen panels. Its "open X" entries and session-resume action all
// reach into renderer.ts-owned state, so (same pattern as the About/MCP
// panels in parts 2-3) those become injected callbacks rather than this
// module importing renderer.ts's runtime values directly. SessionIndexEntry
// is a type genuinely owned by renderer.ts, imported back type-only
// (erased at compile time, so this isn't a real circular dependency).

interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

const commandPaletteToggle = byId<HTMLButtonElement>("command-palette-toggle");
const commandPaletteOverlay = byId<HTMLDivElement>("command-palette-overlay");
const commandPaletteCloseX = byId<HTMLButtonElement>("command-palette-close-x");
const commandPaletteInput = byId<HTMLInputElement>("command-palette-input");
const commandPaletteResults = byId<HTMLUListElement>("command-palette-results");
const commandPaletteEmpty = byId<HTMLDivElement>("command-palette-empty");

export interface CommandPaletteDeps {
  /** Closes every other full-screen modal first (mutual exclusion) — returns false if the caller should abort, same contract as every other panel's open path. */
  closeOtherFullScreenModals: () => boolean;
  openNewSession: () => void;
  openSettings: () => void;
  openAbout: () => void;
  openMcpServers: () => void;
  resumeSession: (id: string) => void;
}

/** Fetched fresh each time the palette opens (see openCommandPalette) — hasn't gone stale by the time it's used, since the palette is a short-lived one-shot flow, not something left open in the background. */
let paletteSessions: SessionIndexEntry[] = [];
let paletteSelectedIndex = 0;

/** For renderer.ts's shared Escape/closeAllFullScreenModals dispatchers, which cover several unrelated panels and so can't themselves live in this module. */
export function isCommandPaletteOpen(): boolean {
  return !commandPaletteOverlay.hidden;
}

export function closeCommandPalette(): void {
  closeOverlayPanel(commandPaletteOverlay);
  commandPaletteToggle.setAttribute("aria-expanded", "false");
  commandPaletteToggle.focus();
}

/** The four fixed entries, always present regardless of what's typed — the dynamic per-session entries (below) are appended after these. */
function staticPaletteCommands(deps: CommandPaletteDeps): PaletteCommand[] {
  return [
    {
      id: "new-session",
      label: "New session",
      run: () => {
        closeCommandPalette();
        deps.openNewSession();
      },
    },
    {
      id: "open-settings",
      label: "Open Settings",
      run: () => {
        closeCommandPalette();
        deps.openSettings();
      },
    },
    {
      id: "open-about",
      label: "Open About",
      run: () => {
        closeCommandPalette();
        deps.openAbout();
      },
    },
    {
      id: "open-mcp-servers",
      label: "Open MCP Servers",
      run: () => {
        closeCommandPalette();
        deps.openMcpServers();
      },
    },
  ];
}

function sessionPaletteCommands(deps: CommandPaletteDeps): PaletteCommand[] {
  return paletteSessions.map((entry) => ({
    id: `session:${entry.id}`,
    label: entry.title,
    hint: "session",
    run: () => {
      closeCommandPalette();
      deps.resumeSession(entry.id);
    },
  }));
}

function filteredPaletteCommands(deps: CommandPaletteDeps): PaletteCommand[] {
  const query = commandPaletteInput.value.trim().toLowerCase();
  const all = [...staticPaletteCommands(deps), ...sessionPaletteCommands(deps)];
  if (!query) return all;
  return all.filter((c) => c.label.toLowerCase().includes(query));
}

/** Unique, stable per-row id for the ARIA listbox pattern below — referenced by both the <li>'s own id and the input's aria-activedescendant. */
function paletteOptionId(index: number): string {
  return `command-palette-option-${index}`;
}

function renderCommandPaletteResults(deps: CommandPaletteDeps): void {
  const commands = filteredPaletteCommands(deps);
  paletteSelectedIndex = Math.min(paletteSelectedIndex, Math.max(commands.length - 1, 0));
  commandPaletteResults.innerHTML = "";
  commandPaletteEmpty.hidden = commands.length > 0;
  commands.forEach((cmd, i) => {
    const li = document.createElement("li");
    // ARIA listbox pattern (combobox on the input below, listbox on the
    // <ul>): each row is the "option" a screen reader announces, with
    // aria-selected tracking arrow-key navigation the same way the
    // "selected" CSS class already does visually.
    li.id = paletteOptionId(i);
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", i === paletteSelectedIndex ? "true" : "false");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = cmd.label;
    if (cmd.hint) {
      const hintSpan = document.createElement("span");
      hintSpan.className = "command-palette-hint";
      hintSpan.textContent = cmd.hint;
      button.appendChild(hintSpan);
    }
    if (i === paletteSelectedIndex) {
      button.classList.add("selected");
      // Keeps arrow-key navigation visible once the list is taller than its
      // own scrollable area (many saved sessions) — a mouse click never
      // needs this, only ArrowUp/ArrowDown do.
      button.scrollIntoView({ block: "nearest" });
    }
    button.addEventListener("click", () => cmd.run());
    li.appendChild(button);
    commandPaletteResults.appendChild(li);
  });
  // The input itself owns the combobox role (see initCommandPalette) — this
  // is the piece that actually changes on every render, telling a screen
  // reader which option is "virtually" focused without moving real focus
  // off the input (arrow keys/typing still happen there, same as today).
  if (commands.length > 0) {
    commandPaletteInput.setAttribute("aria-activedescendant", paletteOptionId(paletteSelectedIndex));
  } else {
    commandPaletteInput.removeAttribute("aria-activedescendant");
  }
}

export function openCommandPalette(deps: CommandPaletteDeps): void {
  if (!deps.closeOtherFullScreenModals()) return;
  commandPaletteInput.value = "";
  paletteSelectedIndex = 0;
  openOverlayPanel(commandPaletteOverlay);
  commandPaletteToggle.setAttribute("aria-expanded", "true");
  renderCommandPaletteResults(deps); // static commands show immediately; the line below fills in sessions once they've loaded
  commandPaletteInput.focus();
  void window.agent
    .listSessions()
    .then((entries) => {
      paletteSessions = entries;
      if (!commandPaletteOverlay.hidden) renderCommandPaletteResults(deps);
    })
    .catch((err) => console.error("[command-palette] listSessions failed:", err));
}

export function initCommandPalette(deps: CommandPaletteDeps): void {
  // Static half of the ARIA combobox/listbox pattern — set once, since none
  // of this changes between renders (unlike aria-activedescendant/
  // aria-selected above, which track the current selection every render).
  commandPaletteInput.setAttribute("role", "combobox");
  commandPaletteInput.setAttribute("aria-autocomplete", "list");
  commandPaletteInput.setAttribute("aria-expanded", "true");
  commandPaletteInput.setAttribute("aria-controls", "command-palette-results");
  commandPaletteResults.setAttribute("role", "listbox");

  commandPaletteToggle.addEventListener("click", () => {
    if (commandPaletteOverlay.hidden) openCommandPalette(deps);
    else closeCommandPalette();
  });
  commandPaletteCloseX.addEventListener("click", closeCommandPalette);
  commandPaletteOverlay.addEventListener("click", (e) => {
    if (e.target === commandPaletteOverlay) closeCommandPalette();
  });

  commandPaletteInput.addEventListener("input", () => {
    paletteSelectedIndex = 0;
    renderCommandPaletteResults(deps);
  });

  commandPaletteInput.addEventListener("keydown", (e) => {
    const commands = filteredPaletteCommands(deps);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      paletteSelectedIndex = Math.min(paletteSelectedIndex + 1, commands.length - 1);
      renderCommandPaletteResults(deps);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      paletteSelectedIndex = Math.max(paletteSelectedIndex - 1, 0);
      renderCommandPaletteResults(deps);
    } else if (e.key === "Enter") {
      e.preventDefault();
      commands[paletteSelectedIndex]?.run();
    }
  });

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (commandPaletteOverlay.hidden) openCommandPalette(deps);
      else closeCommandPalette();
    }
  });
}
