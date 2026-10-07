import type { FileChangeWithDiff } from "../../changesSince.js";
import { byId, withBusyLabel } from "./domHelpers.js";
import { renderDiff } from "./diffView.js";

// Architecture finding (code-review-and-quality pass, part 4 of
// renderer.ts's decomposition): the "Files changed" panel — one Open
// trigger (the View changes button), a read-only diff per file, a Close
// button — moved out of renderer.ts. Unlike the MCP servers panel (part
// 3), this one's trigger button has state written from several unrelated
// places elsewhere in renderer.ts (a session starting, a checkpoint
// revert, a tab reset/replay), so those become the exported setters below
// rather than this module reaching back into renderer.ts for them.

const CHANGE_STATUS_LABEL: Record<FileChangeWithDiff["status"], string> = { added: "A", modified: "M", deleted: "D" };

const viewChangesBtn = byId<HTMLButtonElement>("view-changes");
const changesPanel = byId<HTMLDivElement>("changes-panel");
const changesPanelBody = byId<HTMLDivElement>("changes-panel-body");
const changesPanelClose = byId<HTMLButtonElement>("changes-panel-close");

/** Sums the line count of every added (or every removed) chunk in a diff — the +N/-M counts shown next to each file, same source data renderDiff already walks. */
function countDiffLines(diff: FileChangeWithDiff["diff"], kind: "added" | "removed"): number {
  return diff.reduce((total, chunk) => total + (chunk[kind] ? (chunk.count ?? 0) : 0), 0);
}

/**
 * Renders the "Files changed" panel — one section per file (path, status
 * badge, +insertions/-deletions), each followed by its diff rendered with
 * the exact same renderDiff() the per-edit approval view uses, so a whole
 * task's changes read like a single GitHub commit/PR page instead of
 * being scattered across individual approval prompts in the log.
 */
function renderChangesPanel(changes: FileChangeWithDiff[]): void {
  changesPanelBody.innerHTML = "";
  if (changes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hint-text";
    empty.textContent = "No changes since the checkpoint.";
    changesPanelBody.appendChild(empty);
    return;
  }
  for (const file of changes) {
    const section = document.createElement("div");
    section.className = "changed-file";

    const header = document.createElement("div");
    header.className = "changed-file-header";
    const badge = document.createElement("span");
    badge.className = `change-status change-status-${file.status}`;
    badge.textContent = CHANGE_STATUS_LABEL[file.status];
    header.appendChild(badge);
    const pathEl = document.createElement("span");
    pathEl.className = "changed-file-path";
    pathEl.textContent = file.path;
    header.appendChild(pathEl);
    const added = countDiffLines(file.diff, "added");
    const removed = countDiffLines(file.diff, "removed");
    const counts = document.createElement("span");
    counts.className = "changed-file-counts";
    const addedCount = document.createElement("span");
    addedCount.className = "diff-added-count";
    addedCount.textContent = `+${added}`;
    const removedCount = document.createElement("span");
    removedCount.className = "diff-removed-count";
    removedCount.textContent = `-${removed}`;
    counts.appendChild(addedCount);
    counts.appendChild(document.createTextNode(" "));
    counts.appendChild(removedCount);
    header.appendChild(counts);
    section.appendChild(header);

    section.appendChild(renderDiff(file.diff, true));
    changesPanelBody.appendChild(section);
  }
}

/** For renderer.ts's shared Escape/closeAllFullScreenModals dispatchers, which cover several unrelated panels and so can't themselves live in this module. */
export function isChangesPanelOpen(): boolean {
  return !changesPanel.hidden;
}

/** Same contract as closeAboutPanel/closeMcpServersPanel — hide, return focus to the toggle. Only for the panel's own dismissal (its Close button, or Escape/closeAllFullScreenModals finding it open); a session ending or resetting has no focus to restore to, so it uses resetChangesPanel() instead. */
export function closeChangesPanel(): void {
  changesPanel.hidden = true;
  viewChangesBtn.focus();
}

/** Shows or hides the View changes toggle itself — driven by checkpoint state elsewhere in renderer.ts (a checkpoint being created, or a resumed session already having one). */
export function setViewChangesButtonVisible(visible: boolean): void {
  viewChangesBtn.hidden = !visible;
}

/** Bare hide of both the toggle and the panel, no focus change — for the three call sites where there's definitively no checkpoint/changes left to show (a checkpoint revert, a tab's event-log replay, resetToSetup's full teardown), none of which are a focus-worthy dismissal the way the panel's own Close button is. */
export function resetChangesPanel(): void {
  viewChangesBtn.hidden = true;
  changesPanel.hidden = true;
}

export interface ChangesPanelDeps {
  /** The active tab's session id, or null if there isn't one — same "no active session, no-op" contract the button's click handler always had. */
  getActiveSessionId: () => string | null;
  /** Reports a load failure into the shared event log, same as every other IPC failure in this app. */
  logError: (text: string) => void;
}

export function initChangesPanel(deps: ChangesPanelDeps): void {
  viewChangesBtn.addEventListener("click", () => {
    const sessionId = deps.getActiveSessionId();
    if (!sessionId) return;
    void withBusyLabel(viewChangesBtn, "Loading…", async () => {
      const result = await window.agent.getChanges(sessionId);
      if (result.ok) {
        renderChangesPanel(result.changes);
        changesPanel.hidden = false;
        changesPanelClose.focus();
      } else {
        deps.logError(`[changes] Couldn't load changes: ${result.error}`);
      }
    });
  });

  changesPanelClose.addEventListener("click", closeChangesPanel);
}
