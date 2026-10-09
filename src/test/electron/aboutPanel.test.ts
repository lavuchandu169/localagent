// aboutPanel.ts reads the global `document` via byId() AT MODULE LOAD TIME
// (every const at its top level is a byId(...) call) — unlike
// domHelpers.test.ts/overlayPanel.test.ts, which only touch `document`
// inside functions called later. That means the jsdom document has to
// exist and be installed as the global BEFORE this module is imported, so
// this file loads the real index.html (catching drift between renderer.ts's
// ids and the markup, not just a hand-written fixture that could silently
// go stale) and uses a dynamic import — a static import would be hoisted
// and run before the setup below ever executes.
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexHtmlPath = path.join(__dirname, "../../electron/renderer/index.html");
const html = readFileSync(indexHtmlPath, "utf-8");

const dom = new JSDOM(html, { url: "https://example.com/" });
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;

let openErrorLogCalls = 0;
(dom.window as any).agent = {
  openErrorLog: async () => {
    openErrorLogCalls++;
  },
};

const { openAboutPanel, closeAboutPanel, isAboutPanelOpen, initAboutPanel, setAboutWorkspaceText, setAboutHardwareText } = await import(
  "../../electron/renderer/aboutPanel.js"
);

const aboutPanel = dom.window.document.getElementById("about-panel")!;
const aboutToggle = dom.window.document.getElementById("about-toggle") as any;
const aboutClose = dom.window.document.getElementById("about-close") as any;
const aboutCloseX = dom.window.document.getElementById("about-close-x") as any;
const openErrorLogBtn = dom.window.document.getElementById("open-error-log") as any;
const reportIssueLink = dom.window.document.getElementById("report-issue-link") as any;

initAboutPanel({
  closeOtherFullScreenModals: () => true,
  buildReportIssueUrl: async () => "https://github.com/lavuchandu169/localagent/issues/new?body=test",
});

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** closeOverlayPanel (overlayPanel.ts) only sets `hidden = true` once its closing CSS animation finishes — synchronously after calling it, the panel is still mid-animation with `hidden` still false. Firing this synthetic animationend resolves that instantly instead of waiting out the real fallback timeout, same as overlayPanel.test.ts's own "animationend path" case. */
function fireAnimationEnd(): void {
  aboutPanel.dispatchEvent(new dom.window.Event("animationend"));
}

console.log("initial state (from the real index.html markup):");
{
  check("the panel starts hidden, per index.html's own `hidden` attribute", !isAboutPanelOpen());
  check("the toggle starts with aria-expanded=false, per index.html", aboutToggle.getAttribute("aria-expanded") === "false");
}

console.log("\nopenAboutPanel:");
{
  openAboutPanel({
    closeOtherFullScreenModals: () => true,
    buildReportIssueUrl: async () => "https://github.com/lavuchandu169/localagent/issues/new?body=test",
  });
  check("unhides the panel", isAboutPanelOpen());
  check("sets aria-expanded=true on the toggle", aboutToggle.getAttribute("aria-expanded") === "true");
  check("moves focus to the close button, not left on the toggle", dom.window.document.activeElement === aboutClose);

  await sleep(10); // let buildReportIssueUrl's promise resolve
  check("fills in the report-issue link once buildReportIssueUrl resolves", reportIssueLink.href === "https://github.com/lavuchandu169/localagent/issues/new?body=test");
}

console.log("\ncloseAboutPanel:");
{
  closeAboutPanel();
  fireAnimationEnd();
  check("hides the panel again", !isAboutPanelOpen());
  check("sets aria-expanded=false on the toggle", aboutToggle.getAttribute("aria-expanded") === "false");
  check("returns focus to the toggle button", dom.window.document.activeElement === aboutToggle);
}

console.log("\nopenAboutPanel declines when closeOtherFullScreenModals returns false:");
{
  openAboutPanel({
    closeOtherFullScreenModals: () => false,
    buildReportIssueUrl: async () => "https://should-not-be-used",
  });
  check("the panel stays closed — an unsaved-changes guard elsewhere declined", !isAboutPanelOpen());
}

console.log("\naboutToggle click behavior:");
{
  aboutToggle.click();
  check("clicking the toggle while closed opens the panel", isAboutPanelOpen());
  aboutToggle.click();
  fireAnimationEnd();
  check("clicking the toggle again while open closes it", !isAboutPanelOpen());
}

console.log("\nclose buttons and backdrop click:");
{
  openAboutPanel({ closeOtherFullScreenModals: () => true, buildReportIssueUrl: async () => "https://x" });
  aboutClose.click();
  fireAnimationEnd();
  check("the Close button closes the panel", !isAboutPanelOpen());

  openAboutPanel({ closeOtherFullScreenModals: () => true, buildReportIssueUrl: async () => "https://x" });
  aboutCloseX.click();
  fireAnimationEnd();
  check("the × close button closes the panel too", !isAboutPanelOpen());

  openAboutPanel({ closeOtherFullScreenModals: () => true, buildReportIssueUrl: async () => "https://x" });
  const modalCard = aboutPanel.querySelector(".modal-card") as any;
  modalCard.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  check("clicking inside the modal card does NOT close the panel", isAboutPanelOpen());

  aboutPanel.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  fireAnimationEnd();
  check("clicking the dimmed backdrop itself does close the panel", !isAboutPanelOpen());
}

console.log("\nopen-error-log button:");
{
  openErrorLogBtn.click();
  await sleep(10);
  check("clicking it calls window.agent.openErrorLog", openErrorLogCalls === 1);
}

console.log("\nsetAboutWorkspaceText / setAboutHardwareText:");
{
  setAboutWorkspaceText("/Users/chandu/project");
  check("updates the workspace text", dom.window.document.getElementById("about-workspace")!.textContent === "/Users/chandu/project");
  setAboutHardwareText("Apple M3 Max · 36GB");
  check("updates the hardware text", dom.window.document.getElementById("about-hardware")!.textContent === "Apple M3 Max · 36GB");
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
