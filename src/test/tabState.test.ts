import {
  MAX_OPEN_TABS,
  createTabRegistry,
  openNewTab,
  closeTab,
  focusTab,
  findTabForSession,
  routeEvent,
  tabDotState,
  activeTab,
  resetTabToUnconfigured,
  lastEventStillRunning,
  type TabState,
} from "../electron/renderer/tabState.js";
import type { AgentEvent } from "../types.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("createTabRegistry / openNewTab:");
{
  const registry = createTabRegistry();
  check("starts with no tabs and no active tab", registry.order.length === 0 && registry.activeTabId === null);

  const tab = openNewTab(registry);
  check("openNewTab returns the new tab", tab !== null && tab.tabId.length > 0);
  check("the new tab is unconfigured (no sessionId)", tab!.sessionId === null);
  check("the new tab defaults to an embedded provider so the setup form has something to show", tab!.provider.kind === "embedded");
  check("the new tab becomes the active tab", registry.activeTabId === tab!.tabId);
  check("the registry now has exactly one tab, in order", registry.order.length === 1 && registry.order[0] === tab!.tabId);
  check("activeTab() returns that same tab", activeTab(registry) === tab);
}

console.log("\nMAX_OPEN_TABS cap:");
{
  const registry = createTabRegistry();
  for (let i = 0; i < MAX_OPEN_TABS; i++) {
    check(`tab ${i + 1}/${MAX_OPEN_TABS} opens successfully`, openNewTab(registry) !== null);
  }
  check(`registry has exactly ${MAX_OPEN_TABS} tabs`, registry.order.length === MAX_OPEN_TABS);
  const overCap = openNewTab(registry);
  check("opening past the cap returns null", overCap === null);
  check("the registry still has exactly the cap, not more", registry.order.length === MAX_OPEN_TABS);
}

console.log("\nfindTabForSession:");
{
  const registry = createTabRegistry();
  const tab = openNewTab(registry)!;
  tab.sessionId = "session-abc";
  check("finds the tab whose sessionId matches", findTabForSession(registry, "session-abc") === tab);
  check("returns undefined when no tab matches", findTabForSession(registry, "no-such-session") === undefined);
}

console.log("\ncloseTab:");
{
  const registry = createTabRegistry();
  const tabA = openNewTab(registry)!;
  const tabB = openNewTab(registry)!;
  check("opening a second tab focuses it", registry.activeTabId === tabB.tabId);

  closeTab(registry, tabB.tabId);
  check("closing the active tab removes it from order", !registry.order.includes(tabB.tabId));
  check("closing the active tab falls back to focusing the previous tab in order", registry.activeTabId === tabA.tabId);
  check("the closed tab's state is gone from the map", registry.tabs.get(tabB.tabId) === undefined);

  closeTab(registry, tabA.tabId);
  check("closing the last remaining tab leaves no active tab", registry.activeTabId === null);
  check("closing an already-closed tabId is a harmless no-op", (() => {
    closeTab(registry, tabA.tabId);
    return registry.order.length === 0;
  })());
}

console.log("\nfocusTab:");
{
  const registry = createTabRegistry();
  const tabA = openNewTab(registry)!;
  openNewTab(registry); // tabB, now active
  focusTab(registry, tabA.tabId);
  check("focusTab switches the active tab", registry.activeTabId === tabA.tabId);
  focusTab(registry, "not-a-real-tab-id");
  check("focusing a nonexistent tabId is a harmless no-op, active tab unchanged", registry.activeTabId === tabA.tabId);
}

console.log("\nrouteEvent:");
{
  const registry = createTabRegistry();
  const tabA = openNewTab(registry)!;
  tabA.sessionId = "session-a";
  const tabB = openNewTab(registry)!; // now active
  tabB.sessionId = "session-b";

  const eventForA: AgentEvent = { type: "status", message: "hello A" };
  routeEvent(registry, "session-a", eventForA);
  check("an event for a backgrounded tab's session is stored in that tab's events", tabA.events.length === 1 && tabA.events[0] === eventForA);
  check("routing to a backgrounded tab does not touch the active tab's events", tabB.events.length === 0);

  const eventForNoSession: AgentEvent = { type: "status", message: "orphaned" };
  routeEvent(registry, "no-tab-has-this-session", eventForNoSession);
  check("an event for a session with no open tab is a harmless no-op", tabA.events.length === 1 && tabB.events.length === 0);
}

console.log("\nlastEventStillRunning:");
{
  check("no events at all -> not running (never sent a task)", lastEventStillRunning([]) === false);
  check(
    "last event is a mid-task status -> running",
    lastEventStillRunning([{ type: "status", message: "..." }]) === true
  );
  check(
    "last event is a terminal done -> not running",
    lastEventStillRunning([{ type: "status", message: "..." }, { type: "done", success: true, summary: "ok" }]) === false
  );
  check(
    "a later status after a done -> running again (a fresh task started)",
    lastEventStillRunning([{ type: "done", success: true, summary: "ok" }, { type: "status", message: "starting again" }]) === true
  );
}

console.log("\nrouteEvent keeps tab.running in lock-step with the tab's own event stream:");
{
  const registry = createTabRegistry();
  const tab = openNewTab(registry)!;
  tab.sessionId = "session-x";
  check("a freshly-opened tab starts out not running", tab.running === false);

  // Mirrors what the renderer does at task-send time, itself untestable here
  // since it's a DOM click handler — routeEvent picking the flag back up
  // correctly from here on is the part this module owns. (Read back through
  // a fresh lookup rather than the narrowed local below, so TS doesn't
  // statically pin `running` to the literal `true` this line assigns.)
  tab.running = true;
  routeEvent(registry, "session-x", { type: "status", message: "working" });
  check("a mid-task event leaves running true", findTabForSession(registry, "session-x")!.running);

  routeEvent(registry, "session-x", { type: "done", success: true, summary: "ok" });
  check("the terminal done event flips running back to false", !findTabForSession(registry, "session-x")!.running);

  routeEvent(registry, "session-x", { type: "status", message: "a fresh task, started again" });
  check("a later event after done flips running back to true", findTabForSession(registry, "session-x")!.running);
}

console.log("\ntabDotState:");
function makeTab(overrides: Partial<TabState> = {}): TabState {
  return {
    tabId: "t",
    sessionId: null,
    title: null,
    events: [],
    draftTask: "",
    pendingAttachments: [],
    workspaceRoot: null,
    provider: { kind: "embedded", size: "qwen-coder-1.5b" },
    mode: "DEFAULT",
    planFirst: false,
    activeProvider: null,
    editingSession: false,
    running: false,
    ...overrides,
  };
}
{
  check("no session yet -> unconfigured", tabDotState(makeTab()) === "unconfigured");
  check(
    "session running, last event not done/error -> running",
    tabDotState(makeTab({ sessionId: "s", events: [{ type: "status", message: "..." }] })) === "running"
  );
  check(
    "last event is a done:true -> done",
    tabDotState(makeTab({ sessionId: "s", events: [{ type: "done", success: true, summary: "ok" }] })) === "done"
  );
  check(
    "last event is a done:false -> error",
    tabDotState(makeTab({ sessionId: "s", events: [{ type: "done", success: false, summary: "bad" }] })) === "error"
  );
  check(
    "last event is a top-level error event -> error",
    tabDotState(makeTab({ sessionId: "s", events: [{ type: "error", message: "boom" }] })) === "error"
  );
  check(
    "last event is a permission.request with decision ASK -> waiting-approval",
    tabDotState(
      makeTab({
        sessionId: "s",
        events: [{ type: "permission.request", call: { id: "1", name: "edit_file", arguments: {} }, decision: "ASK" }],
      })
    ) === "waiting-approval"
  );
  check(
    "a permission.request with decision ALLOW (not actually asking) -> running, not waiting-approval",
    tabDotState(
      makeTab({
        sessionId: "s",
        events: [{ type: "permission.request", call: { id: "1", name: "read_file", arguments: {} }, decision: "ALLOW" }],
      })
    ) === "running"
  );
  check(
    "last event is a plan.proposed -> waiting-approval",
    tabDotState(makeTab({ sessionId: "s", events: [{ type: "plan.proposed", plan: { kind: "text", content: "..." } }] })) === "waiting-approval"
  );
  check(
    "a later status event after a done resets back to running (a fresh task started)",
    tabDotState(
      makeTab({
        sessionId: "s",
        events: [
          { type: "done", success: true, summary: "ok" },
          { type: "status", message: "starting again" },
        ],
      })
    ) === "running"
  );
}

console.log("\nresetTabToUnconfigured:");
{
  const tab = makeTab({
    sessionId: "session-x",
    title: "Some old session",
    events: [{ type: "status", message: "leftover from the deleted session" }],
    draftTask: "an unsent draft",
    pendingAttachments: [{ kind: "text", name: "a.txt", content: "hi" } as any],
    workspaceRoot: "/some/workspace",
    provider: { kind: "anthropic", model: "claude-opus-4" } as any,
    mode: "AUTO_SAFE",
    planFirst: true,
    activeProvider: { kind: "anthropic", model: "claude-opus-4" } as any,
    editingSession: true,
    running: true,
  });

  resetTabToUnconfigured(tab);

  check("sessionId is cleared", tab.sessionId === null);
  check("workspaceRoot is cleared", tab.workspaceRoot === null);
  check("activeProvider is cleared", tab.activeProvider === null);
  check("events (the deleted session's history) are cleared, not replayed later", tab.events.length === 0);
  check("draftTask (the deleted session's composer draft) is cleared", tab.draftTask === "");
  check("pendingAttachments are cleared", tab.pendingAttachments.length === 0);
  check("provider resets to the same embedded default a brand-new tab starts from", tab.provider.kind === "embedded");
  check("mode resets to DEFAULT", tab.mode === "DEFAULT");
  check("planFirst resets to false", tab.planFirst === false);
  check("editingSession resets to false", tab.editingSession === false);
  check("running resets to false", tab.running === false);
  check("title is deliberately left alone — the caller owns it", tab.title === "Some old session");
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
