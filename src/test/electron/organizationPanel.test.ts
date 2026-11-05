// organizationPanel.ts reads the global `document` via byId() AT MODULE
// LOAD TIME — same pattern as aboutPanel.test.ts/changesPanel.test.ts: load
// the real index.html, install it as the global document, then dynamically
// import so the module's top-level byId() calls run against a real
// document instead of throwing on a missing element.
//
// This file covers the fix for the v1 "Run as <role>" gap: when a role's
// initiative session starts, the panel must call deps.openSessionTab with
// the real sessionId/workspaceRoot/composed task/title so renderer.ts can
// open an interactive tab for it — not just update the panel's own
// inline status line (which has no way to surface a permission approval).
// The actual tab-opening logic (openOrganizationSessionTab in renderer.ts)
// is DOM/tabRegistry wiring verified only by reading the code — see the
// final report. What's unit-tested here is organizationPanel.ts's own
// responsibility: computing the right call into that dependency as soon
// as onOrganizationSessionStarted fires.
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Organization } from "../../organization.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexHtmlPath = path.join(__dirname, "../../electron/renderer/index.html");
const html = readFileSync(indexHtmlPath, "utf-8");

const dom = new JSDOM(html, { url: "https://example.com/" });
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;

let orgToLoad: Organization = { goal: "", roles: [], initiatives: [] };
let savedOrg: Organization | null = null;
let sessionStartedCallback: ((sessionId: string, initiativeId: string) => void) | null = null;

(dom.window as any).agent = {
  pickWorkspace: async () => "/workspace/acme",
  loadOrganization: async () => orgToLoad,
  saveOrganization: async (_workspaceRoot: string, org: Organization) => {
    savedOrg = org;
    return { ok: true };
  },
  runInitiative: async () => ({ ok: true, sessionId: "unused" }),
  onEvent: () => () => {},
  onOrganizationSessionStarted: (cb: (sessionId: string, initiativeId: string) => void) => {
    sessionStartedCallback = cb;
    return () => {
      sessionStartedCallback = null;
    };
  },
};

const { initOrganizationPanel } = await import("../../electron/renderer/organizationPanel.js");
const { buildInitiativeTask } = await import("../../organization.js");

const organizationChooseWorkspace = dom.window.document.getElementById("organization-choose-workspace") as any;

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

let openSessionTabCalls: { sessionId: string; workspaceRoot: string; task: string; title: string }[] = [];
initOrganizationPanel({
  closeOtherFullScreenModals: () => {},
  openSessionTab: (params) => {
    openSessionTabCalls.push(params);
  },
});

console.log("onOrganizationSessionStarted opens a real session tab:");
{
  const role = { id: "role-1", title: "Engineer", responsibilities: "Ship fixes", model: "claude-sonnet-5", reportsTo: null };
  const initiative = { id: "initiative-1", title: "Fix the login bug", assignedRoleId: "role-1", status: "in-progress" as const, notes: "" };
  orgToLoad = { goal: "Build a great product", roles: [role], initiatives: [initiative] };

  organizationChooseWorkspace.dispatchEvent(new dom.window.Event("click"));
  await sleep(10);
  check("picking a workspace loads the organization", savedOrg === null); // chooseWorkspace itself never saves

  check("a session-started callback was registered", sessionStartedCallback !== null);
  openSessionTabCalls = [];
  sessionStartedCallback!("session-abc", "initiative-1");

  check("openSessionTab was called exactly once", openSessionTabCalls.length === 1);
  const call = openSessionTabCalls[0]!;
  check("the real sessionId is passed through", call.sessionId === "session-abc");
  check("the panel's current workspaceRoot is passed through", call.workspaceRoot === "/workspace/acme");
  check("the title names the role and the initiative", call.title === "Engineer: Fix the login bug");
  check(
    "the task is the same composed text startInitiativeSession actually started the session with",
    call.task === buildInitiativeTask(orgToLoad, initiative, role)
  );
}

console.log("\nonOrganizationSessionStarted is a no-op when the initiative/role can't be resolved:");
{
  // An initiative id this panel's current org doesn't know about (e.g. a
  // race with a concurrent edit) must never throw or call openSessionTab
  // with guessed-wrong data — the inline status line is still the fallback.
  openSessionTabCalls = [];
  sessionStartedCallback!("session-xyz", "no-such-initiative");
  check("openSessionTab is not called for an unknown initiative id", openSessionTabCalls.length === 0);
}

console.log("\nonOrganizationSessionStarted is a no-op for an initiative with no assigned role:");
{
  orgToLoad = {
    goal: "",
    roles: [],
    initiatives: [{ id: "initiative-2", title: "Unassigned work", assignedRoleId: null, status: "todo", notes: "" }],
  };
  // Re-pick the workspace so the panel's in-memory org reflects the new fixture.
  organizationChooseWorkspace.dispatchEvent(new dom.window.Event("click"));
  await sleep(10);

  openSessionTabCalls = [];
  sessionStartedCallback!("session-def", "initiative-2");
  check("openSessionTab is not called when the initiative has no role to resolve", openSessionTabCalls.length === 0);
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
