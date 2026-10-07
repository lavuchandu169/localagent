import type { Change } from "diff";
import { groupDiffIntoSegments } from "../../diffUtil.js";

// Architecture finding (code-review-and-quality pass, part 4 of
// renderer.ts's decomposition): renderDiff is a pure rendering function —
// no DOM lookups, no ambient state — shared by two call sites that are
// themselves splitting apart: the per-edit approval card in renderer.ts's
// event log, and the "Files changed" panel now in changesPanel.ts. Moved
// here rather than into either of those so neither has to import from the
// other.

const DIFF_LINE_CAP = 300;

/** Splits a segment's value into its individual lines the same way the old flat renderer did — split("\n") on a trailing-newline string leaves one empty trailing entry, popped off. */
function linesOf(value: string): string[] {
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Renders a diff as context lines interleaved with per-hunk blocks, each
 * hunk carrying its own checkbox (checked by default, matching today's
 * implicit "approve everything") so an Approve click can read back exactly
 * which hunks are still checked. `readOnly` is used for a diff shown
 * alongside a decision that isn't ASK (already-decided ALLOW/DENY, or the
 * read-only copy under a sent task) — no checkboxes there, since there's
 * no prompt to attach a selection to.
 */
export function renderDiff(diff: Change[], readOnly = false): HTMLElement {
  const container = document.createElement("div");
  container.className = "diff-view";
  const segments = groupDiffIntoSegments(diff);
  let linesShown = 0;

  outer: for (const segment of segments) {
    let hunkWrapper: HTMLElement | null = null;
    if (segment.kind === "hunk" && !readOnly) {
      hunkWrapper = document.createElement("div");
      hunkWrapper.className = "diff-hunk";
      const toggle = document.createElement("label");
      toggle.className = "diff-hunk-toggle";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.dataset.hunkId = String(segment.id);
      toggle.appendChild(checkbox);
      toggle.appendChild(document.createTextNode("Apply this change"));
      hunkWrapper.appendChild(toggle);
      container.appendChild(hunkWrapper);
    }
    const target = hunkWrapper ?? container;

    const parts: { value: string; added?: boolean; removed?: boolean }[] =
      segment.kind === "context"
        ? [{ value: segment.value }]
        : [
            ...(segment.removedValue !== undefined ? [{ value: segment.removedValue, removed: true }] : []),
            ...(segment.addedValue !== undefined ? [{ value: segment.addedValue, added: true }] : []),
          ];

    for (const part of parts) {
      for (const line of linesOf(part.value)) {
        if (linesShown >= DIFF_LINE_CAP) {
          const truncated = document.createElement("div");
          truncated.className = "diff-line diff-truncated";
          truncated.textContent = "… diff truncated …";
          container.appendChild(truncated);
          break outer;
        }
        const lineEl = document.createElement("div");
        lineEl.className = `diff-line ${part.added ? "diff-added" : part.removed ? "diff-removed" : "diff-context"}`;
        lineEl.textContent = `${part.added ? "+" : part.removed ? "-" : " "} ${line}`;
        target.appendChild(lineEl);
        linesShown++;
      }
    }
  }
  return container;
}
