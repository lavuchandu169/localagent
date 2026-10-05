import { byId } from "./domHelpers.js";
import { WHATS_NEW } from "../../whatsNew.js";

// Architecture finding (code-review-and-quality pass, part 1 of renderer.ts's
// decomposition): the first-run onboarding modal, the "what's new" modal,
// and the first-task example-prompt chips are a self-contained first-run/
// upgrade UX concern — their own DOM elements, their own localStorage keys,
// no dependency on live session state. Moved out of renderer.ts verbatim
// (same logic, same localStorage keys, same load-order via initOnboarding()
// called from the exact point this code used to run inline) as the first
// slice of that file's split into focused modules.

const onboardingOverlay = byId<HTMLDivElement>("onboarding-overlay");
const onboardingDismiss = byId<HTMLButtonElement>("onboarding-dismiss");
const whatsNewOverlay = byId<HTMLDivElement>("whats-new-overlay");
const whatsNewTitle = byId<HTMLHeadingElement>("whats-new-title");
const whatsNewList = byId<HTMLUListElement>("whats-new-list");
const whatsNewDismiss = byId<HTMLButtonElement>("whats-new-dismiss");
const examplePrompts = byId<HTMLDivElement>("example-prompts");
const modelSelect = byId<HTMLSelectElement>("model-select");
const taskInput = byId<HTMLTextAreaElement>("task-input");

/** Exported for the one other place in renderer.ts (the hardware-info
 * callback that picks a recommended model on a brand-new install) that
 * needs this same flag — a plain read-only string, not worth a function. */
export const ONBOARDING_SEEN_KEY = "localagent:onboarding-seen";

// Example-task chips — shown above the composer only for the very first
// session this machine has ever sent a task in, never again after that.
// Deliberately NOT tied to #empty-state's own visibility: beginSession
// always logs a "Session started" status line the instant a session
// starts, which hides #empty-state immediately — before the user would
// ever get a chance to see anything nested inside it. Distinct from
// ONBOARDING_SEEN_KEY too: a user can dismiss the onboarding modal (just
// reading it) well before actually starting a session and sending a task,
// so this needs its own flag set at the actual moment that matters —
// runTaskBtn's handler, in renderer.ts.
const FIRST_TASK_SENT_KEY = "localagent:first-task-sent";

const WHATS_NEW_SEEN_KEY = "localagent:whats-new-seen-version";

/** Per-viewer UI preference only (not security/cross-device data) — localStorage is the right tool here, unlike everything else in this app which persists through the main process. */
export function showOnboardingIfFirstRun(): void {
  let seen = false;
  try {
    seen = localStorage.getItem(ONBOARDING_SEEN_KEY) === "1";
  } catch {
    seen = true; // an inaccessible localStorage shouldn't block the app — treat as already seen
  }
  if (seen) return;
  onboardingOverlay.hidden = false;
  onboardingDismiss.focus();
}

export function dismissOnboarding(): void {
  onboardingOverlay.hidden = true;
  try {
    localStorage.setItem(ONBOARDING_SEEN_KEY, "1");
  } catch {
    // Best-effort — if this fails, onboarding just shows again next launch; not worth surfacing an error for.
  }
  modelSelect.focus();
}

function firstTaskAlreadySent(): boolean {
  try {
    return localStorage.getItem(FIRST_TASK_SENT_KEY) === "1";
  } catch {
    return true; // an inaccessible localStorage shouldn't show this every time — treat as already past it
  }
}

export function markFirstTaskSent(): void {
  try {
    localStorage.setItem(FIRST_TASK_SENT_KEY, "1");
  } catch {
    // Best-effort — if this fails, the chips just show again next time; not worth surfacing an error for.
  }
}

/** Called from clearAndReplayEventLog, which already knows whether the active tab has a live session — the chips only make sense once a task can actually be sent (taskInput isn't disabled). */
export function updateExamplePromptsVisibility(hasSession: boolean): void {
  examplePrompts.hidden = !hasSession || firstTaskAlreadySent();
}

/** Turns a changelog bullet's `` `code span` `` markdown into a real <code> element, leaving everything else as plain text — built via DOM nodes rather than innerHTML since this text ultimately comes from a file in the repo, not a trusted-but-still-worth-being-careful-with input. */
function renderWhatsNewBullet(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const parts = text.split("`");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (i % 2 === 1) {
      const code = document.createElement("code");
      code.textContent = part;
      fragment.appendChild(code);
    } else if (part) {
      fragment.appendChild(document.createTextNode(part));
    }
  }
  return fragment;
}

/**
 * Shows this build's changelog entry once per version, but only for
 * someone who's already past onboarding — a brand-new install gets the
 * onboarding modal's own "here's what this app does" and doesn't need a
 * second, redundant welcome. That also means the very first time this
 * feature ships, every existing user (onboarding already seen, no
 * what's-new-seen entry yet at all) correctly sees this version's notes
 * once, which is exactly the case the feature exists for.
 */
export function showWhatsNewIfNeeded(): void {
  let onboardingSeen = false;
  let lastSeenVersion: string | null = null;
  try {
    onboardingSeen = localStorage.getItem(ONBOARDING_SEEN_KEY) === "1";
    lastSeenVersion = localStorage.getItem(WHATS_NEW_SEEN_KEY);
  } catch {
    return; // no localStorage available — nothing to show or track this run
  }

  if (!onboardingSeen) {
    // First-ever run: seed silently so this only ever fires for a real
    // upgrade from here on, never as a second welcome on top of onboarding.
    try {
      localStorage.setItem(WHATS_NEW_SEEN_KEY, WHATS_NEW.version);
    } catch {
      // Best-effort — worst case this shows once more than intended later; not worth surfacing an error for.
    }
    return;
  }

  if (lastSeenVersion === WHATS_NEW.version) return;

  whatsNewTitle.textContent = `What's new in v${WHATS_NEW.version}`;
  whatsNewList.innerHTML = "";
  for (const bullet of WHATS_NEW.bullets) {
    const li = document.createElement("li");
    li.appendChild(renderWhatsNewBullet(bullet));
    whatsNewList.appendChild(li);
  }
  whatsNewOverlay.hidden = false;
  whatsNewDismiss.focus();
}

export function dismissWhatsNew(): void {
  whatsNewOverlay.hidden = true;
  try {
    localStorage.setItem(WHATS_NEW_SEEN_KEY, WHATS_NEW.version);
  } catch {
    // Best-effort — if this fails, the modal just shows again next launch; not worth surfacing an error for.
  }
  // Unlike onboarding (which always lands on a fresh setup form and so
  // always has a sensible next field to focus), this modal can appear
  // either before or after a session has started — the composer isn't
  // always the right next stop. Only claim focus when it's actually usable.
  if (!taskInput.disabled) taskInput.focus();
}

/** Whether the onboarding modal is currently showing — for renderer.ts's
 * shared Escape/Tab-trap keydown dispatchers, which cover several
 * unrelated panels and so can't themselves live in this module. */
export function isOnboardingOpen(): boolean {
  return !onboardingOverlay.hidden;
}

/** Whether the what's-new modal is currently showing — see isOnboardingOpen. */
export function isWhatsNewOpen(): boolean {
  return !whatsNewOverlay.hidden;
}

export function focusOnboardingDismiss(): void {
  onboardingDismiss.focus();
}

export function focusWhatsNewDismiss(): void {
  whatsNewDismiss.focus();
}

/** Wires both modals' dismiss buttons and the example-prompt chips, then
 * shows whichever of onboarding/what's-new is due — called once from
 * renderer.ts at the exact point this code used to run inline, so
 * load-order relative to the rest of renderer.ts's top-level setup is
 * unchanged. */
export function initOnboarding(): void {
  onboardingDismiss.addEventListener("click", dismissOnboarding);
  showOnboardingIfFirstRun();

  for (const chip of document.querySelectorAll<HTMLButtonElement>(".example-prompt-chip")) {
    chip.addEventListener("click", () => {
      taskInput.value = chip.textContent ?? "";
      taskInput.focus();
    });
  }

  whatsNewDismiss.addEventListener("click", dismissWhatsNew);
  showWhatsNewIfNeeded();
}
