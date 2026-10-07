import { byId } from "./domHelpers.js";
import { openOverlayPanel, closeOverlayPanel } from "./overlayPanel.js";

// Architecture finding (code-review-and-quality pass, part 2 of
// renderer.ts's decomposition): the About panel — version/hardware info,
// the report-issue link, the error-log opener — moved out of renderer.ts.
// Two pieces of state it displays (the current workspace, the detected
// hardware line) are set from elsewhere in the app (the workspace picker,
// beginSession, hardware detection), so those are exposed as setters
// rather than exporting the raw DOM elements — callers update a fact,
// they don't reach into this panel's internals. buildReportIssueUrl()
// itself stays in renderer.ts (it depends on that file's own hardwareInfo
// module state) and is passed in as a dependency, same for closing every
// OTHER full-screen modal first (renderer.ts's closeAllFullScreenModals,
// which itself needs to close THIS panel — importing it directly would
// be circular).

const aboutToggle = byId<HTMLButtonElement>("about-toggle");
const aboutPanel = byId<HTMLDivElement>("about-panel");
const aboutClose = byId<HTMLButtonElement>("about-close");
const aboutCloseX = byId<HTMLButtonElement>("about-close-x");
const reportIssueLink = byId<HTMLAnchorElement>("report-issue-link");
const openErrorLogBtn = byId<HTMLButtonElement>("open-error-log");
const aboutWorkspace = byId<HTMLSpanElement>("about-workspace");
const aboutHardware = byId<HTMLSpanElement>("about-hardware");

export function setAboutWorkspaceText(text: string): void {
  aboutWorkspace.textContent = text;
}

export function setAboutHardwareText(text: string): void {
  aboutHardware.textContent = text;
}

/** For renderer.ts's shared Escape/closeAllFullScreenModals dispatchers, which cover several unrelated panels and so can't themselves live in this module. */
export function isAboutPanelOpen(): boolean {
  return !aboutPanel.hidden;
}

/** Hides the panel, updates its toggle's aria-expanded, and returns focus to the toggle — the reverse of opening it, so a keyboard/screen-reader user always lands back where they started instead of on a now-hidden element. */
export function closeAboutPanel(): void {
  closeOverlayPanel(aboutPanel);
  aboutToggle.setAttribute("aria-expanded", "false");
  aboutToggle.focus();
}

export interface AboutPanelDeps {
  /** Closes every other full-screen modal first (mutual exclusion) — returns false if the caller should abort (an unsaved-changes guard elsewhere declined), same contract as every other panel's open path. */
  closeOtherFullScreenModals: () => boolean;
  /** Builds the GitHub "new issue" URL pre-filled with app version/OS/hardware. */
  buildReportIssueUrl: () => Promise<string>;
}

/** Opens the panel unconditionally — used by both the toggle button's "currently closed" branch and the command palette's "Open About" entry, which always wants it open regardless of current state. */
export function openAboutPanel(deps: AboutPanelDeps): void {
  if (!deps.closeOtherFullScreenModals()) return;
  openOverlayPanel(aboutPanel);
  aboutToggle.setAttribute("aria-expanded", "true");
  void deps
    .buildReportIssueUrl()
    .then((url) => (reportIssueLink.href = url))
    .catch((err) => console.error("[about] buildReportIssueUrl failed:", err));
  aboutClose.focus(); // moves focus into the panel, so a keyboard/screen-reader user actually lands on its content
}

export function initAboutPanel(deps: AboutPanelDeps): void {
  aboutToggle.addEventListener("click", () => {
    if (aboutPanel.hidden) {
      openAboutPanel(deps);
    } else {
      // Deliberately not closeAboutPanel() here: the user is already
      // focused on the toggle they just clicked, so re-focusing it (what
      // closeAboutPanel's refocus is for) would be a no-op at best.
      closeOverlayPanel(aboutPanel);
      aboutToggle.setAttribute("aria-expanded", "false");
    }
  });
  aboutClose.addEventListener("click", closeAboutPanel);
  aboutCloseX.addEventListener("click", closeAboutPanel);
  // Clicking the dimmed backdrop (not the card itself) closes it — the
  // standard modal affordance, and the only way to close that doesn't
  // depend on scroll position within a possibly-long panel.
  aboutPanel.addEventListener("click", (e) => {
    if (e.target === aboutPanel) closeAboutPanel();
  });
  openErrorLogBtn.addEventListener("click", () => {
    void window.agent.openErrorLog();
  });
}
