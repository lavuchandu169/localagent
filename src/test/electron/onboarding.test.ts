// onboarding.ts reads the global `document` via byId() AT MODULE LOAD
// TIME — same pattern as aboutPanel.test.ts: load the real index.html,
// install it (and jsdom's own localStorage, which this module reads/
// writes directly) as globals, then dynamically import.
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WHATS_NEW } from "../../whatsNew.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexHtmlPath = path.join(__dirname, "../../electron/renderer/index.html");
const html = readFileSync(indexHtmlPath, "utf-8");

const dom = new JSDOM(html, { url: "https://example.com/" });
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).localStorage = dom.window.localStorage;

const {
  ONBOARDING_SEEN_KEY,
  showOnboardingIfFirstRun,
  dismissOnboarding,
  updateExamplePromptsVisibility,
  markFirstTaskSent,
  showWhatsNewIfNeeded,
  dismissWhatsNew,
  isOnboardingOpen,
  isWhatsNewOpen,
  focusOnboardingDismiss,
  focusWhatsNewDismiss,
  initOnboarding,
} = await import("../../electron/renderer/onboarding.js");

const onboardingOverlay = dom.window.document.getElementById("onboarding-overlay") as any;
const onboardingDismiss = dom.window.document.getElementById("onboarding-dismiss") as any;
const whatsNewOverlay = dom.window.document.getElementById("whats-new-overlay") as any;
const whatsNewTitle = dom.window.document.getElementById("whats-new-title") as any;
const whatsNewList = dom.window.document.getElementById("whats-new-list") as any;
const whatsNewDismiss = dom.window.document.getElementById("whats-new-dismiss") as any;
const examplePrompts = dom.window.document.getElementById("example-prompts") as any;
const modelSelect = dom.window.document.getElementById("model-select") as any;
const taskInput = dom.window.document.getElementById("task-input") as any;

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

function resetStorage() {
  localStorage.clear();
}

console.log("showOnboardingIfFirstRun / dismissOnboarding:");
{
  resetStorage();
  showOnboardingIfFirstRun();
  check("a brand-new install (no flag set) shows onboarding", onboardingOverlay.hidden === false);
  check("isOnboardingOpen reflects that", isOnboardingOpen() === true);
  check("focus lands on the dismiss button", dom.window.document.activeElement === onboardingDismiss);

  dismissOnboarding();
  check("dismissing hides the overlay", onboardingOverlay.hidden === true);
  check("dismissing persists the seen flag", localStorage.getItem(ONBOARDING_SEEN_KEY) === "1");
  check("dismissing moves focus to the model select, the setup form's first field", dom.window.document.activeElement === modelSelect);
}
{
  resetStorage();
  localStorage.setItem(ONBOARDING_SEEN_KEY, "1");
  onboardingOverlay.hidden = true;
  showOnboardingIfFirstRun();
  check("once seen, a later call never shows onboarding again", onboardingOverlay.hidden === true);
}

console.log("\nupdateExamplePromptsVisibility / markFirstTaskSent:");
{
  resetStorage();
  updateExamplePromptsVisibility(false);
  check("no active session hides the example prompts regardless of first-task state", examplePrompts.hidden === true);

  updateExamplePromptsVisibility(true);
  check("an active session that's never sent a task shows the example prompts", examplePrompts.hidden === false);

  markFirstTaskSent();
  updateExamplePromptsVisibility(true);
  check("after the first task is sent, the chips never show again even with an active session", examplePrompts.hidden === true);
}

console.log("\nshowWhatsNewIfNeeded / dismissWhatsNew:");
{
  resetStorage(); // onboarding never seen — first-ever run
  showWhatsNewIfNeeded();
  check("on a first-ever run (onboarding not yet seen), what's-new does not show", whatsNewOverlay.hidden === true);
  check("it silently seeds the seen-version flag so this never fires again as a redundant second welcome", localStorage.getItem("localagent:whats-new-seen-version") === WHATS_NEW.version);
}
{
  resetStorage();
  localStorage.setItem(ONBOARDING_SEEN_KEY, "1"); // onboarding already seen — a real upgrade case
  whatsNewOverlay.hidden = true;
  showWhatsNewIfNeeded();
  check("an existing user with no prior what's-new-seen entry sees this version's notes once", whatsNewOverlay.hidden === false);
  check("isWhatsNewOpen reflects that", isWhatsNewOpen() === true);
  check("the title names the actual current version", whatsNewTitle.textContent === `What's new in v${WHATS_NEW.version}`);
  check("every bullet from WHATS_NEW is rendered as a list item", whatsNewList.querySelectorAll("li").length === WHATS_NEW.bullets.length);
  check("focus lands on the dismiss button", dom.window.document.activeElement === whatsNewDismiss);

  taskInput.disabled = false;
  dismissWhatsNew();
  check("dismissing hides the overlay", whatsNewOverlay.hidden === true);
  check("dismissing persists this version as seen", localStorage.getItem("localagent:whats-new-seen-version") === WHATS_NEW.version);
  check("when the composer is usable, dismissing focuses it", dom.window.document.activeElement === taskInput);
}
{
  resetStorage();
  localStorage.setItem(ONBOARDING_SEEN_KEY, "1");
  localStorage.setItem("localagent:whats-new-seen-version", WHATS_NEW.version);
  whatsNewOverlay.hidden = true;
  showWhatsNewIfNeeded();
  check("already seen this exact version — does not show again", whatsNewOverlay.hidden === true);
}
{
  resetStorage();
  localStorage.setItem(ONBOARDING_SEEN_KEY, "1");
  whatsNewOverlay.hidden = false;
  taskInput.disabled = true;
  // Move focus to a different, definitely-focusable element first and
  // confirm it actually moved — otherwise a no-op (focus simply staying
  // on taskInput from an earlier test) would pass this check without the
  // code under test having done anything.
  whatsNewDismiss.focus();
  check("focus was actually moved away before this case runs", dom.window.document.activeElement === whatsNewDismiss);
  dismissWhatsNew();
  check("dismissing does NOT steal focus into a disabled composer that can't actually be used", dom.window.document.activeElement !== taskInput);
}

console.log("\nrenderWhatsNewBullet (via showWhatsNewIfNeeded's rendered output):");
{
  // Indirect: renderWhatsNewBullet itself isn't exported, but its
  // backtick-to-<code> behavior is observable through the rendered list —
  // exercised by temporarily swapping in a bullet with a code span.
  resetStorage();
  localStorage.setItem(ONBOARDING_SEEN_KEY, "1");
  const originalBullets = [...WHATS_NEW.bullets];
  WHATS_NEW.bullets.length = 0;
  WHATS_NEW.bullets.push("Fixed `formatTextAttachment` to escape names");
  whatsNewOverlay.hidden = true;
  showWhatsNewIfNeeded();
  const li = whatsNewList.querySelector("li");
  check("a backtick-quoted span becomes a real <code> element", li?.querySelector("code")?.textContent === "formatTextAttachment");
  check("the surrounding plain text is preserved outside the <code> element", li?.textContent === "Fixed formatTextAttachment to escape names");
  WHATS_NEW.bullets.length = 0;
  WHATS_NEW.bullets.push(...originalBullets);
}

console.log("\nfocusOnboardingDismiss / focusWhatsNewDismiss:");
{
  dom.window.document.body.focus();
  focusOnboardingDismiss();
  check("focusOnboardingDismiss moves focus to the onboarding dismiss button", dom.window.document.activeElement === onboardingDismiss);
  dom.window.document.body.focus();
  focusWhatsNewDismiss();
  check("focusWhatsNewDismiss moves focus to the what's-new dismiss button", dom.window.document.activeElement === whatsNewDismiss);
}

console.log("\ninitOnboarding — example-prompt chip click:");
{
  resetStorage();
  initOnboarding();
  const chip = dom.window.document.querySelector(".example-prompt-chip") as any;
  check("at least one example-prompt chip exists in the real markup", chip !== null);
  if (chip) {
    taskInput.value = "";
    chip.dispatchEvent(new dom.window.Event("click"));
    check("clicking a chip fills the composer with the chip's own text", taskInput.value === chip.textContent);
  }
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
