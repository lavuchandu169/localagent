import type { UpdateStatus } from "../updateManager.js";
import { byId } from "./domHelpers.js";

// Architecture finding (code-review-and-quality pass, part 7 of
// renderer.ts's decomposition): the update banner — fully self-contained,
// no coupling to tabs, sessions, or any other part of the app beyond the
// ambient window.agent.onUpdateStatus feed and its own DOM. Unlike every
// other panel extracted so far, nothing outside this module reads or
// writes any of its state, so it needs no deps object at all — just an
// init() call.

/** Correctness audit finding (updateManager Low/Medium): on an unsigned Mac
 * build, Squirrel.Mac's in-place apply step fails every time (the download
 * itself succeeds, only the apply fails — see UpdateStatus's "fallback"
 * doc comment), which resets updateReadyToInstall and lets the periodic
 * 4-hour re-check (updateManager.ts) re-detect the SAME version and run
 * through the whole cycle again. Before this, that re-detection forced the
 * banner back open (see the state-transition check below) for a version
 * the user already saw and dismissed, with nothing new to tell them.
 * Per-viewer UI preference only, same reasoning as WHATS_NEW_SEEN_KEY. */
const UPDATE_FALLBACK_DISMISSED_VERSION_KEY = "localagent:update-fallback-dismissed-version";

const updateBanner = byId<HTMLDivElement>("update-banner");
const updateBannerText = byId<HTMLSpanElement>("update-banner-text");
const updateBannerLink = byId<HTMLAnchorElement>("update-banner-link");
const updateBannerOpenFileBtn = byId<HTMLButtonElement>("update-banner-open-file");
const updateBannerRestartBtn = byId<HTMLButtonElement>("update-banner-restart");
const updateBannerDismiss = byId<HTMLButtonElement>("update-banner-dismiss");

let lastUpdateStatus: UpdateStatus | null = null;
let lastKnownUpdateVersion: string | null = null;
let lastRenderedUpdateState: string | null = null;

function readDismissedUpdateVersion(): string | null {
  try {
    return localStorage.getItem(UPDATE_FALLBACK_DISMISSED_VERSION_KEY);
  } catch {
    return null;
  }
}

export function initUpdateBanner(): void {
  updateBannerDismiss.addEventListener("click", () => {
    // Hides the banner only — a background download in progress keeps
    // downloading, and an already-downloaded update still applies itself on
    // the next natural quit either way. Dismiss is a view-layer action; the
    // state that matters lives in the main process, not the DOM.
    updateBanner.hidden = true;
    // Only remembered for a "fallback" dismiss — "ready"/"downloading" are
    // still actionable (or self-resolving) and should always be able to
    // reopen; "fallback" on an unsigned build is the one case that just
    // repeats the same unactionable message every periodic re-check.
    if (lastUpdateStatus?.state === "fallback") {
      try {
        localStorage.setItem(UPDATE_FALLBACK_DISMISSED_VERSION_KEY, lastUpdateStatus.version);
      } catch {
        // Best-effort — worst case the banner just reopens again next re-check; not worth surfacing an error for.
      }
    }
  });

  updateBannerRestartBtn.addEventListener("click", () => {
    void window.agent.installUpdate();
  });

  updateBannerOpenFileBtn.addEventListener("click", () => {
    void window.agent.openUpdateFile();
  });

  window.agent.onUpdateStatus((status) => {
    lastUpdateStatus = status;
    // "downloading" carries no version of its own — the most recently known
    // version (from this same run's last "ready"/"fallback") is the best
    // available signal for "is this still the same already-dismissed cycle
    // restarting", since a periodic re-check re-detecting an unsigned
    // build's stuck version runs through downloading → fallback again with
    // no new information in between.
    if (status.state !== "downloading") lastKnownUpdateVersion = status.version;

    if (status.state === "downloading") {
      updateBannerText.textContent = `Downloading update… (${status.percent}%)`;
      updateBannerRestartBtn.hidden = true;
      updateBannerOpenFileBtn.hidden = true;
      updateBannerLink.hidden = true;
    } else if (status.state === "ready") {
      updateBannerText.textContent = `Update v${status.version} ready.`;
      updateBannerRestartBtn.hidden = false;
      updateBannerOpenFileBtn.hidden = true;
      updateBannerLink.hidden = true;
    } else if (status.canOpenDownloadedFile) {
      // fallback, but the real download did complete — e.g. Squirrel.Mac
      // rejecting an unsigned Mac build's in-place apply step. Offer the
      // downloaded file directly instead of sending the user back to GitHub
      // to download the same bytes again.
      updateBannerText.textContent = `Update v${status.version} downloaded, but couldn't finish installing automatically on this build.`;
      updateBannerRestartBtn.hidden = true;
      updateBannerOpenFileBtn.hidden = false;
      updateBannerLink.hidden = true;
    } else {
      // fallback with nothing downloaded — identical to this banner's only behavior before this feature existed
      updateBannerText.textContent = `A new version (v${status.version}) is available.`;
      updateBannerLink.href = `https://github.com/lavuchandu169/localagent/releases/tag/v${status.version}`;
      updateBannerRestartBtn.hidden = true;
      updateBannerOpenFileBtn.hidden = true;
      updateBannerLink.hidden = false;
    }
    // Only force the banner back open on an actual state transition — a
    // download-progress tick re-broadcasts "downloading" many times a
    // second, and forcing hidden=false on every one of those made the
    // dismiss button impossible to use for the duration of a download.
    // "ready" always reopens regardless (still actionable); "downloading"/
    // "fallback" don't, when the version involved is one the user already
    // dismissed a fallback banner for — correctness audit finding
    // (updateManager Low/Medium): without this, an unsigned Mac build's
    // periodic re-check re-opened this exact dismissed banner every 4 hours
    // with nothing new to tell the user.
    const alreadyDismissedVersion = status.state !== "ready" && lastKnownUpdateVersion !== null && lastKnownUpdateVersion === readDismissedUpdateVersion();
    if (status.state !== lastRenderedUpdateState && !alreadyDismissedVersion) {
      updateBanner.hidden = false;
    }
    lastRenderedUpdateState = status.state;
  });
}
