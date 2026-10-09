// changesPanel.ts reads the global `document` via byId() AT MODULE LOAD
// TIME — same pattern as aboutPanel.test.ts/authPanel.test.ts: load the
// real index.html, install it as the global document, then dynamically
// import so the module's top-level byId() calls run against a real
// document instead of throwing on a missing element.
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { computeFileDiff } from "../../diffCompute.js";
import type { FileChangeWithDiff } from "../../changesSince.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexHtmlPath = path.join(__dirname, "../../electron/renderer/index.html");
const html = readFileSync(indexHtmlPath, "utf-8");

const dom = new JSDOM(html, { url: "https://example.com/" });
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;

let getChangesResult: { ok: true; changes: FileChangeWithDiff[] } | { ok: false; error: string } = { ok: true, changes: [] };
let getChangesCalledWith: string | null = null;

(dom.window as any).agent = {
  getChanges: async (sessionId: string) => {
    getChangesCalledWith = sessionId;
    return getChangesResult;
  },
};

const { isChangesPanelOpen, closeChangesPanel, setViewChangesButtonVisible, resetChangesPanel, initChangesPanel } = await import(
  "../../electron/renderer/changesPanel.js"
);

const viewChangesBtn = dom.window.document.getElementById("view-changes") as any;
const changesPanel = dom.window.document.getElementById("changes-panel") as any;
const changesPanelBody = dom.window.document.getElementById("changes-panel-body") as any;
const changesPanelClose = dom.window.document.getElementById("changes-panel-close") as any;

let activeSessionId: string | null = "session-1";
const loggedErrors: string[] = [];
initChangesPanel({
  getActiveSessionId: () => activeSessionId,
  logError: (text: string) => loggedErrors.push(text),
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

function diffFor(oldContent: string | null, newContent: string) {
  return computeFileDiff(oldContent, newContent);
}

console.log("setViewChangesButtonVisible / resetChangesPanel / closeChangesPanel / isChangesPanelOpen:");
{
  setViewChangesButtonVisible(true);
  check("the toggle is shown when told to be visible", viewChangesBtn.hidden === false);
  setViewChangesButtonVisible(false);
  check("the toggle is hidden when told not to be visible", viewChangesBtn.hidden === true);
}
{
  setViewChangesButtonVisible(true);
  changesPanel.hidden = false;
  check("the panel reports itself open while visible", isChangesPanelOpen() === true);
  resetChangesPanel();
  check("resetChangesPanel hides the toggle", viewChangesBtn.hidden === true);
  check("resetChangesPanel hides the panel too", changesPanel.hidden === true);
  check("the panel reports itself closed after reset", isChangesPanelOpen() === false);
}
{
  changesPanel.hidden = false;
  closeChangesPanel();
  check("closeChangesPanel hides the panel", changesPanel.hidden === true);
  check("closeChangesPanel returns focus to the toggle", dom.window.document.activeElement === viewChangesBtn);
}

console.log("\nviewChangesBtn click — no active session:");
{
  activeSessionId = null;
  getChangesCalledWith = null;
  viewChangesBtn.dispatchEvent(new dom.window.Event("click"));
  await sleep(10);
  check("with no active session, getChanges is never called at all", getChangesCalledWith === null);
}

console.log("\nviewChangesBtn click — loads and renders changes:");
{
  activeSessionId = "session-1";
  getChangesCalledWith = null;
  getChangesResult = {
    ok: true,
    changes: [
      { path: "src/a.ts", status: "modified", diff: diffFor("old\n", "new\n") },
      { path: "src/b.ts", status: "added", diff: diffFor(null, "brand new\n") },
    ],
  };
  viewChangesBtn.dispatchEvent(new dom.window.Event("click"));
  await sleep(10);
  check("getChanges is called with the active session's id", getChangesCalledWith === "session-1");
  check("the panel becomes visible", changesPanel.hidden === false);
  check("focus moves to the Close button", dom.window.document.activeElement === changesPanelClose);
  const sections = changesPanelBody.querySelectorAll(".changed-file");
  check("one section is rendered per changed file", sections.length === 2);
  check("the first file's path is shown", sections[0]?.querySelector(".changed-file-path")?.textContent === "src/a.ts");
  check("a modified file gets the M status badge", sections[0]?.querySelector(".change-status")?.textContent === "M");
  check("an added file gets the A status badge", sections[1]?.querySelector(".change-status")?.textContent === "A");
  check("each section's diff is actually rendered (reuses renderDiff)", sections[0]?.querySelector(".diff-view") !== null);
  check("an added file's diff shows a + count and 0 removed", sections[1]?.querySelector(".diff-added-count")?.textContent === "+1" && sections[1]?.querySelector(".diff-removed-count")?.textContent === "-0");
}

console.log("\nviewChangesBtn click — empty changes:");
{
  getChangesResult = { ok: true, changes: [] };
  viewChangesBtn.dispatchEvent(new dom.window.Event("click"));
  await sleep(10);
  check("an empty change list shows a friendly empty-state message, not a blank panel", changesPanelBody.textContent?.includes("No changes since the checkpoint."));
}

console.log("\nviewChangesBtn click — load failure:");
{
  getChangesResult = { ok: false, error: "disk read failed" };
  changesPanel.hidden = true;
  viewChangesBtn.dispatchEvent(new dom.window.Event("click"));
  await sleep(10);
  check("a load failure is reported through the injected logError callback", loggedErrors.some((e) => e.includes("disk read failed")));
  check("the panel is NOT shown on a failed load", changesPanel.hidden === true);
}

console.log("\nchangesPanelClose click:");
{
  changesPanel.hidden = false;
  changesPanelClose.dispatchEvent(new dom.window.Event("click"));
  check("clicking Close hides the panel, same as calling closeChangesPanel directly", changesPanel.hidden === true);
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
