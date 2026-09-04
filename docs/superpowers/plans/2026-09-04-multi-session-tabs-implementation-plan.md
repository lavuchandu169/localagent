# Multi-Session Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the renderer's single global `sessionId` with a real tab strip holding up to 6 open sessions, each fully live in the background — no lost events, no reload on switch.

**Architecture:** One shared DOM (the existing event log/composer/status bar/setup form), driven by whichever tab is focused; a new pure `tabState.ts` module owns a `Map`-backed `TabRegistry` of `TabState` objects (identity + raw event history + composer draft + form selections), independent of any DOM. Switching tabs is a "replay render" — clear the shared DOM, replay the newly-focused tab's stored `events` through the *existing* `renderEvent` function, exactly the mechanism `resumeSession` already uses to load a session from disk today. A backgrounded tab's incoming events are stored into its `TabState` but never rendered until it's focused again.

**Tech Stack:** TypeScript, no new dependencies — built entirely on `AgentBridge` methods that already exist (`onEvent`, `getLiveSession`, `loadSession`, `startSession`, `runTask`, etc.).

**Spec:** [docs/superpowers/specs/2026-09-04-multi-session-tabs-design.md](../specs/2026-09-04-multi-session-tabs-design.md)

## Global Constraints

- Cap: **6 tabs** open at once. Opening past the cap shows a clear, non-blocking message instead of failing silently.
- A tab's backend session is never affected by closing its tab — closing only removes it from the strip; the session keeps running (`sessionRegistry.ts` already doesn't care whether any UI points at it). Reopening later re-seeds from `getLiveSession`.
- No restore-on-relaunch of previously-open tabs.
- **Refinement of the spec's launch behavior:** the spec says "every launch starts with zero tabs open — just the sidebar." Read literally against the real current code, today's launch *always* shows the setup screen (workspace/model/mode picker) immediately, not a blank page — `sessionId` starts `null`, which is exactly the "unconfigured" tab state this plan introduces. To preserve that exact launch experience, the app **auto-opens one fresh, unconfigured tab on every launch** (never a restored/previously-open one — it's a brand-new blank tab, satisfying "no restore" while never showing a blank screen with nowhere to type). This is a plan-level clarification of the spec's intent, not a contradiction of it.
- **New behavior discovered while reading the real code, not explicitly covered by the spec:** `resumeSession` (the sidebar-click handler) currently does `if (sessionId) { await window.agent.cancelSession(sessionId); }` before loading the clicked session — i.e., opening a different session today **cancels whatever was running**. This must NOT carry over: opening/focusing a tab must never touch any other open tab's session. Task 4 removes this call.
- **Refinement of the spec's `TabState` sketch:** the spec's `TabState` includes `usage` and `checkpointHash` fields. Reading the real `renderer.ts` (Task 3) showed both are fully derivable by replaying a tab's `events` through the existing `renderEvent` function — the same mechanism `toolCards` (a Map cache) already relies on today whenever `resumeSession` loads a session from disk. Storing them again on `TabState` would let them drift from the real history; this plan's `TabState` (Task 1) omits both and instead adds `provider`/`mode`/`planFirst`/`activeProvider`/`editingSession`/`draftTask` — the setup-form and session-lifecycle fields the spec's sketch didn't fully enumerate but the real `renderer.ts` needs restored on every tab switch.
- **New behavior, same reason:** only one embedded-model download can be in progress across all tabs at once (the download-progress UI — `#download-progress`, `#download-bar-fill`, `#cancel-download` — is a single shared element, not per-tab, and two simultaneous local model loads is unwanted resource contention anyway). Starting a session that needs a download while another tab's download is already in progress shows a clear message instead of a confusing shared progress bar. Task 5 adds this guard.
- No `Co-Authored-By` trailer in any commit — verify with `git log -1 --format="%an <%ae>"` after every commit.
- Use the project's existing `check(name, cond)`-based plain-Node test style for `tabState.ts` (no test framework). `renderer.ts` changes have no automated test coverage, matching this app's established renderer pattern (see `updateManager`'s banner, the MCP Servers panel) — verified live via Chrome DevTools Protocol against the real running app, the same technique used for every prior renderer feature this session: the real Electron binary directly (`node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`, never `npx electron`), `ELECTRON_RUN_AS_NODE` unset, an isolated `--user-data-dir`, `--remote-debugging-port`, driven via `Runtime.evaluate`/`Page.captureScreenshot` over the real WebSocket debugger with real `.click()` dispatch — run with a Node ≥22 binary (try `/opt/homebrew/bin/node` first) since the default `node` on this machine lacks a global `WebSocket`. Full teardown (kill Electron, remove the scratch profile, confirm production `userData` untouched) after every live-verification task.

---

### Task 1: `tabState.ts` — the pure tab data model

**Files:**
- Create: `src/electron/renderer/tabState.ts`
- Test: `src/test/tabState.test.ts`
- Modify: `package.json` (append the new test file to the `"test"` script chain)

**Interfaces:**
- Produces: `MAX_OPEN_TABS`, `TabDotState`, `TabState`, `TabRegistry`, `createTabRegistry()`, `openNewTab(registry)`, `closeTab(registry, tabId)`, `focusTab(registry, tabId)`, `findTabForSession(registry, sessionId)`, `routeEvent(registry, sessionId, event)`, `tabDotState(tab)`, `activeTab(registry)`.

`renderer.ts`'s real, current types this module must match: `AgentEvent`, `PermissionMode`, `PickedAttachment` (from `../../types.js` and `../attachments.js`), and `ProviderConfig` (from `../sessionRegistry.js`, real shape: `{kind:"openai-compatible";baseUrl:string;model:string} | {kind:"embedded";size:string} | {kind:"anthropic";apiKey?:string;model?:string}`).

- [ ] **Step 1: Write the failing test**

Create `src/test/tabState.test.ts`:

```typescript
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

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build`
Expected: FAIL — `TS2307: Cannot find module '../electron/renderer/tabState.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/electron/renderer/tabState.ts`:

```typescript
import crypto from "node:crypto";
import type { AgentEvent, PermissionMode } from "../../types.js";
import type { PickedAttachment } from "../attachments.js"; // same import renderer.ts already uses
import type { ProviderConfig } from "../sessionRegistry.js";

export const MAX_OPEN_TABS = 6;

export type TabDotState = "unconfigured" | "running" | "waiting-approval" | "done" | "error";

export interface TabState {
  tabId: string;
  /** null until Start succeeds for this tab. */
  sessionId: string | null;
  title: string | null;
  /** Raw event history for this tab, replayed through renderer.ts's renderEvent() whenever this tab is focused — the single source of truth this whole module works from. Every derived value (tool cards, usage totals, dot state) is recomputed from this, never stored separately. */
  events: AgentEvent[];
  draftTask: string;
  pendingAttachments: PickedAttachment[];
  workspaceRoot: string | null;
  /** The setup form's current (possibly still-being-edited) selection for this tab — restored into modelSelect/baseUrlInput/externalModelInput whenever this tab is focused. */
  provider: ProviderConfig;
  mode: PermissionMode;
  planFirst: boolean;
  /** Set once Start actually succeeds — the config the running session was started with, distinct from `provider` above (which keeps tracking the form's live selection, used when re-opening Edit settings…). null for an unconfigured tab. */
  activeProvider: ProviderConfig | null;
  editingSession: boolean;
}

export interface TabRegistry {
  tabs: Map<string, TabState>;
  /** Display order — append-on-open, unchanged by focusing. */
  order: string[];
  activeTabId: string | null;
}

export function createTabRegistry(): TabRegistry {
  return { tabs: new Map(), order: [], activeTabId: null };
}

export function activeTab(registry: TabRegistry): TabState | undefined {
  return registry.activeTabId ? registry.tabs.get(registry.activeTabId) : undefined;
}

/** Refuses past MAX_OPEN_TABS — returns null instead of creating a tab. The new tab always becomes the active one. */
export function openNewTab(registry: TabRegistry): TabState | null {
  if (registry.order.length >= MAX_OPEN_TABS) return null;
  const tab: TabState = {
    tabId: crypto.randomUUID(),
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
  };
  registry.tabs.set(tab.tabId, tab);
  registry.order.push(tab.tabId);
  registry.activeTabId = tab.tabId;
  return tab;
}

/** A no-op if tabId isn't open. Falls back to focusing the previous tab in display order (or the next one, if the closed tab was first); leaves activeTabId null if no tabs remain. */
export function closeTab(registry: TabRegistry, tabId: string): void {
  const index = registry.order.indexOf(tabId);
  if (index === -1) return;
  registry.tabs.delete(tabId);
  registry.order.splice(index, 1);
  if (registry.activeTabId !== tabId) return;
  if (registry.order.length === 0) {
    registry.activeTabId = null;
    return;
  }
  const fallbackIndex = index > 0 ? index - 1 : 0;
  registry.activeTabId = registry.order[fallbackIndex]!;
}

/** A no-op if tabId isn't open. */
export function focusTab(registry: TabRegistry, tabId: string): void {
  if (!registry.tabs.has(tabId)) return;
  registry.activeTabId = tabId;
}

export function findTabForSession(registry: TabRegistry, sessionId: string): TabState | undefined {
  for (const tab of registry.tabs.values()) {
    if (tab.sessionId === sessionId) return tab;
  }
  return undefined;
}

/** Stores the event into whichever tab has this sessionId — a no-op if none does (mirrors today's silent-discard behavior for a session with no open view, e.g. one that kept running after its tab was closed). Always stores, regardless of whether that tab is currently focused; renderer.ts decides separately whether to also render it live. */
export function routeEvent(registry: TabRegistry, sessionId: string, event: AgentEvent): void {
  const tab = findTabForSession(registry, sessionId);
  if (!tab) return;
  tab.events.push(event);
}

/** Pure function of a tab's stored state — derives what dot to show from its most recent events, without any side effects or DOM access. */
export function tabDotState(tab: TabState): TabDotState {
  if (!tab.sessionId) return "unconfigured";
  const last = tab.events[tab.events.length - 1];
  if (!last) return "running";
  if (last.type === "done") return last.success ? "done" : "error";
  if (last.type === "error") return "error";
  if (last.type === "permission.request" && last.decision === "ASK") return "waiting-approval";
  if (last.type === "plan.proposed") return "waiting-approval";
  return "running";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node dist/test/tabState.test.js`
Expected: every `check(...)` line prints `ok`, then `All tests passed.`, exit code 0.

- [ ] **Step 5: Wire into the test script and commit**

In `package.json`, append `&& node dist/test/tabState.test.js` to the `"test"` script chain.

```bash
npm run build && npm test
git add package.json src/electron/renderer/tabState.ts src/test/tabState.test.ts
git commit -m "feat: add the pure tab data model for multi-session tabs"
```

---

### Task 2: Tab strip markup and styles

**Files:**
- Modify: `src/electron/renderer/index.html`
- Modify: `src/electron/renderer/styles.css`

**Interfaces:**
- Produces: the DOM elements Task 3/4 will look up via `byId` — `#tab-strip`, `#tab-strip-list`, `#tab-strip-new`, `#tab-strip-cap-message`, plus the per-tab template structure a tab element must have (built by Task 4's `renderTabStrip()`, but the CSS classes/selectors below are what it must produce).

- [ ] **Step 1: Replace the single-tab markup**

In `src/electron/renderer/index.html`, find (confirmed current content):

```html
        <div id="tab-bar" hidden>
          <div id="tab-item"><span id="tab-dot"></span><span id="tab-label"></span></div>
        </div>
```

Replace with:

```html
        <div id="tab-strip">
          <div id="tab-strip-list"></div>
          <button id="tab-strip-new" type="button" title="New session" aria-label="New session">+</button>
          <div id="tab-strip-cap-message" hidden>Close a tab before opening another — up to 6 can be open at once.</div>
        </div>
```

(Unlike the old `#tab-bar[hidden]`, `#tab-strip` is never hidden — Global Constraints' launch behavior means at least one tab, hence one tab strip entry, always exists once the app has loaded.)

- [ ] **Step 2: Replace the old tab-bar styles with tab-strip styles**

In `src/electron/renderer/styles.css`, find (confirmed current content, lines 373-401):

```css
#tab-bar {
  flex-shrink: 0;
  display: flex;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
}

#tab-bar[hidden] {
  display: none;
}

#tab-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 14px;
  font-size: 11px;
  color: var(--text);
  background: var(--bg);
  border-right: 1px solid var(--border);
}

#tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warn);
  flex-shrink: 0;
}
```

Replace with:

```css
#tab-strip {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
}

#tab-strip-list {
  display: flex;
  flex: 1;
  min-width: 0;
}

.tab-strip-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  font-size: 12px;
  color: var(--text);
  background: var(--bg);
  border-right: 1px solid var(--border);
  border-bottom: 2px solid transparent;
  max-width: 160px;
  cursor: pointer;
  flex-shrink: 0;
}

.tab-strip-item.active {
  background: var(--bg-raised);
  border-bottom-color: var(--accent);
}

.tab-strip-item-dot {
  flex-shrink: 0;
  font-size: 10px;
}

.tab-strip-item-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.tab-strip-item-close {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 0 2px;
}

.tab-strip-item-close:hover {
  color: var(--text);
}

#tab-strip-new {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 14px;
  padding: 6px 12px;
}

#tab-strip-new:hover {
  color: var(--text);
}

#tab-strip-new[disabled] {
  opacity: 0.4;
  cursor: not-allowed;
}

#tab-strip-cap-message {
  font-size: 11px;
  color: var(--warn);
  padding: 4px 10px;
  flex-shrink: 0;
}

#tab-strip-cap-message[hidden] {
  display: none;
}
```

- [ ] **Step 3: Build and commit**

Run: `npm run build`
Expected: exit 0 (no TypeScript changes in this task, but confirms `copy-electron-assets.mjs` still copies the edited files correctly).

```bash
git add src/electron/renderer/index.html src/electron/renderer/styles.css
git commit -m "feat: replace the single-tab indicator with tab-strip markup and styles"
```

---

### Task 3: Behavior-preserving refactor onto `TabRegistry`

**Files:**
- Modify: `src/electron/renderer/renderer.ts`

This is the highest-risk task: it replaces every read/write of the module-level `sessionId`/`workspaceRoot`/`editingSession`/`activeProviderConfig`/`pendingAttachments`/`sessionUsage` singletons with reads/writes through a `TabRegistry`'s active tab — **without changing any user-visible behavior**. At the end of this task the app must work exactly as it does today: one implicit tab, opening a session still replaces whatever's showing, the tab strip shows exactly one entry. Task 4 adds the actual multi-tab capability on top of this now-safe foundation. Splitting it this way means the large, mechanical, error-prone rewiring gets its own isolated review gate, separate from new behavior.

**Interfaces:**
- Consumes: everything from `tabState.ts` (Task 1) — `TabRegistry`, `TabState`, `createTabRegistry`, `openNewTab`, `closeTab`, `focusTab`, `findTabForSession`, `routeEvent`, `activeTab`.
- Produces: a `tabRegistry: TabRegistry` module-level instance in `renderer.ts`, and a `syncFormFromTab(tab: TabState): void` / `clearAndReplayEventLog(tab: TabState): void` pair of render helpers Task 4 will reuse.

- [ ] **Step 1: Add the import and the registry instance**

In `src/electron/renderer/renderer.ts`, add to the top imports (after the existing `import type { PickedAttachment } from "../attachments.js";` line):

```typescript
import { createTabRegistry, openNewTab, activeTab, type TabRegistry, type TabState } from "./tabState.js";
```

Replace the existing module-level state block:

```typescript
let workspaceRoot: string | null = null;
let sessionId: string | null = null;
let hardwareInfo: HardwareInfo | null = null;
/** True while the setup controls are unlocked for editing an already-active session's workspace/model/mode — see editSettingsBtn/applySessionEdits. */
let editingSession = false;
const toolCards = new Map<string, HTMLElement>();
```

with:

```typescript
let hardwareInfo: HardwareInfo | null = null;
const toolCards = new Map<string, HTMLElement>();
const tabRegistry: TabRegistry = createTabRegistry();
// Global launch behavior (see plan Global Constraints): the app always has
// at least one tab, even though open tabs are never restored across a
// relaunch — this is a brand-new, unconfigured one every time.
openNewTab(tabRegistry);

/** Throws if called before the first tab exists — which, given the openNewTab() call directly above and closeTab() never running before then, is only reachable if this module's own invariant is broken. Every call site below already assumes a tab exists (matching every existing `if (!sessionId) return;` guard's assumption that setup has happened), so a thrown error here surfaces a real bug immediately instead of silently no-oping deep in some handler. */
function requireActiveTab(): TabState {
  const tab = activeTab(tabRegistry);
  if (!tab) throw new Error("No active tab — this should be unreachable (see requireActiveTab's doc comment).");
  return tab;
}
```

`pendingAttachments` and `sessionUsage`'s declarations (Steps 5-6 below) move onto the tab too — remove their two standalone `let` declarations at their current locations (`let pendingAttachments: PickedAttachment[] = [];` and `let sessionUsage = { ... };`) as part of this task; every reference to them becomes a reference to `requireActiveTab().pendingAttachments` / a locally-recomputed value (see Step 6).

- [ ] **Step 2: Replace every bare `sessionId` read/write**

Every one of these is a mechanical, minimal-diff replacement — the surrounding logic is unchanged.

In `renderEvent`'s `permission.request` case, replace:
```typescript
        if (sessionId) void window.agent.respondPermission(sessionId, event.call.id, approved, approvedHunkIds);
```
with:
```typescript
        const tab = activeTab(tabRegistry);
        if (tab?.sessionId) void window.agent.respondPermission(tab.sessionId, event.call.id, approved, approvedHunkIds);
```

In `renderEvent`'s `plan.proposed` case, replace:
```typescript
        if (sessionId) void window.agent.respondPlan(sessionId, approved);
```
with:
```typescript
        const tab = activeTab(tabRegistry);
        if (tab?.sessionId) void window.agent.respondPlan(tab.sessionId, approved);
```

In the `window.agent.onEvent` handler, replace:
```typescript
window.agent.onEvent((incomingSessionId, event) => {
  if (incomingSessionId !== sessionId) return;
  renderEvent(event);
});
```
with:
```typescript
window.agent.onEvent((incomingSessionId, event) => {
  const tab = activeTab(tabRegistry);
  if (incomingSessionId !== tab?.sessionId) return;
  renderEvent(event);
});
```
(This still only ever renders the active tab's events, matching today's exact filter — Task 5 widens this to also store a backgrounded tab's events via `routeEvent`.)

In `beginSession`, replace:
```typescript
    const result = await window.agent.startSession(config, resume);
    sessionId = result.sessionId;
    if (!workspaceRoot) {
      workspaceRoot = result.workspaceRoot;
```
with:
```typescript
    const tab = requireActiveTab();
    const result = await window.agent.startSession(config, resume);
    tab.sessionId = result.sessionId;
    if (!tab.workspaceRoot) {
      tab.workspaceRoot = result.workspaceRoot;
```
and later in the same function, replace:
```typescript
    activeProviderConfig = provider;
```
with:
```typescript
    tab.activeProvider = provider;
```

In `revertCheckpointBtn`'s click handler, replace:
```typescript
revertCheckpointBtn.addEventListener("click", () => {
  if (!sessionId) return;
  const idToRevert = sessionId;
```
with:
```typescript
revertCheckpointBtn.addEventListener("click", () => {
  const tab = activeTab(tabRegistry);
  if (!tab?.sessionId) return;
  const idToRevert = tab.sessionId;
```

In `viewChangesBtn`'s click handler, replace:
```typescript
viewChangesBtn.addEventListener("click", () => {
  if (!sessionId) return;
  const idToView = sessionId;
```
with:
```typescript
viewChangesBtn.addEventListener("click", () => {
  const tab = activeTab(tabRegistry);
  if (!tab?.sessionId) return;
  const idToView = tab.sessionId;
```

In `applySessionEdits`, replace:
```typescript
async function applySessionEdits(): Promise<void> {
  if (!sessionId || !activeProviderConfig) return;
  const idBeingEdited = sessionId;
  const newProvider = deriveProviderConfigFromForm();
  const newMode = modeSelect.value as PermissionMode;
  startError.textContent = "";

  if (providerConfigsEqual(newProvider, activeProviderConfig)) {
```
with:
```typescript
async function applySessionEdits(): Promise<void> {
  const tab = activeTab(tabRegistry);
  if (!tab?.sessionId || !tab.activeProvider) return;
  const idBeingEdited = tab.sessionId;
  const newProvider = deriveProviderConfigFromForm();
  const newMode = modeSelect.value as PermissionMode;
  startError.textContent = "";

  if (providerConfigsEqual(newProvider, tab.activeProvider)) {
```
and, further down in the same function, replace:
```typescript
    const ok = await window.agent.updateSessionSettings(idBeingEdited, {
      workspaceRoot: workspaceRoot ?? undefined,
      mode: newMode,
      planFirst: planFirstCheckbox.checked,
    });
```
with:
```typescript
    const ok = await window.agent.updateSessionSettings(idBeingEdited, {
      workspaceRoot: tab.workspaceRoot ?? undefined,
      mode: newMode,
      planFirst: planFirstCheckbox.checked,
    });
```
and replace the two lines:
```typescript
    await window.agent.cancelSession(idBeingEdited);
    sessionId = null;
```
with:
```typescript
    await window.agent.cancelSession(idBeingEdited);
    tab.sessionId = null;
```

In `resetToSetup`, replace:
```typescript
function resetToSetup(): void {
  if (sessionId) void window.agent.cancelSession(sessionId);
  sessionId = null;
  workspaceRoot = null;
  activeProviderConfig = null;
  clearEventLog();
```
with:
```typescript
function resetToSetup(): void {
  const tab = requireActiveTab();
  if (tab.sessionId) void window.agent.cancelSession(tab.sessionId);
  tab.sessionId = null;
  tab.workspaceRoot = null;
  tab.activeProvider = null;
  clearEventLog();
```

In `resumeSession`, replace:
```typescript
    if (sessionId) {
      await window.agent.cancelSession(sessionId);
    }
    sessionId = null;
```
with:
```typescript
    const tab = requireActiveTab();
    if (tab.sessionId) {
      await window.agent.cancelSession(tab.sessionId);
    }
    tab.sessionId = null;
```
(Task 4 removes this cancel-the-current-session behavior entirely, per Global Constraints — this task only makes it tab-aware, preserving today's exact behavior for now.)

In `renderSessionList`, replace:
```typescript
    if (entry.id === sessionId) item.classList.add("active");
```
with:
```typescript
    if (entry.id === activeTab(tabRegistry)?.sessionId) item.classList.add("active");
```
and, in the same function's delete-button handler, replace:
```typescript
        if (entry.id === sessionId) {
          resetToSetup();
```
with:
```typescript
        if (entry.id === activeTab(tabRegistry)?.sessionId) {
          resetToSetup();
```

In `runTaskBtn`'s click handler, replace:
```typescript
runTaskBtn.addEventListener("click", async () => {
  if (!sessionId || (!taskInput.value.trim() && pendingAttachments.length === 0)) return;
  toolCards.clear();
  runTaskBtn.disabled = true;
  const task = taskInput.value;
  const sentAttachments = pendingAttachments;
```
with:
```typescript
runTaskBtn.addEventListener("click", async () => {
  const tab = activeTab(tabRegistry);
  if (!tab?.sessionId || (!taskInput.value.trim() && tab.pendingAttachments.length === 0)) return;
  toolCards.clear();
  runTaskBtn.disabled = true;
  const task = taskInput.value;
  const sentAttachments = tab.pendingAttachments;
```
and, later in the same handler, replace:
```typescript
  pendingAttachments = [];
  renderAttachmentChips();
  await window.agent.runTask(sessionId, task, attachments);
```
with:
```typescript
  tab.pendingAttachments = [];
  renderAttachmentChips();
  await window.agent.runTask(tab.sessionId, task, attachments);
```

- [ ] **Step 3: Run a build to catch every remaining reference**

Run: `npm run build`

TypeScript will now report `TS2304: Cannot find name 'sessionId'`/`'workspaceRoot'`/`'editingSession'`/`'activeProviderConfig'`/`'pendingAttachments'` at every call site Step 2 above didn't yet cover — this is the mechanism for finding the rest; the list above was compiled by reading the whole file once, but let the compiler be the final check. Fix each remaining error the same way: read the surrounding function, replace the bare variable with `activeTab(tabRegistry)` (or `requireActiveTab()` where the existing code already assumed non-null, e.g. inside `beginSession`/`resetToSetup`) and the corresponding field access. Do not weaken any existing `if (!sessionId) return;`-style guard's behavior — every one becomes `if (!tab?.sessionId) return;`, same effective check.

- [ ] **Step 4: `editingSession` and `chooseWorkspaceBtn`**

Six occurrences, each in a context where a tab is already guaranteed to exist (inside `beginSession`/`resetToSetup`/`applySessionEdits`, or a handler already gated on one being active) — matching the non-null assumption the original bare `editingSession` variable already made, so each becomes `requireActiveTab().editingSession` or, where a `tab`/`const tab = activeTab(tabRegistry)` binding from an earlier step in this same function is already in scope, `tab.editingSession`.

In `beginSession`'s success path, replace:
```typescript
    setSetupControlsDisabled(true);
    editingSession = false;
    editSettingsBtn.textContent = "Edit settings…";
```
with:
```typescript
    setSetupControlsDisabled(true);
    tab.editingSession = false;
    editSettingsBtn.textContent = "Edit settings…";
```
(`tab` here is the same binding Step 2 already introduced at this function's top via `const tab = requireActiveTab();`.)

In `beginSession`'s catch block, replace:
```typescript
    editingSession = false;
    editSettingsBtn.hidden = true;
```
with:
```typescript
    tab.editingSession = false;
    editSettingsBtn.hidden = true;
```

In `applySessionEdits`, replace:
```typescript
    editingSession = false;
    if (!ok) {
```
with:
```typescript
    tab.editingSession = false;
    if (!ok) {
```
and replace its `finally` block:
```typescript
  } finally {
    editingSession = false;
  }
```
with:
```typescript
  } finally {
    tab.editingSession = false;
  }
```
(`tab` here is the same binding Step 2 introduced at this function's top.)

In `editSettingsBtn`'s click handler, replace:
```typescript
editSettingsBtn.addEventListener("click", () => {
  editingSession = !editingSession;
  setSetupControlsDisabled(!editingSession);
  startSessionBtn.disabled = !editingSession;
  startSessionBtn.textContent = editingSession ? "Apply changes" : "Start session";
  editSettingsBtn.textContent = editingSession ? "Cancel edit" : "Edit settings…";
  setupSection.hidden = editingSession ? false : true;
});
```
with:
```typescript
editSettingsBtn.addEventListener("click", () => {
  const tab = requireActiveTab();
  tab.editingSession = !tab.editingSession;
  setSetupControlsDisabled(!tab.editingSession);
  startSessionBtn.disabled = !tab.editingSession;
  startSessionBtn.textContent = tab.editingSession ? "Apply changes" : "Start session";
  editSettingsBtn.textContent = tab.editingSession ? "Cancel edit" : "Edit settings…";
  setupSection.hidden = tab.editingSession ? false : true;
});
```

In `resetToSetup`, replace:
```typescript
  editingSession = false;
  editSettingsBtn.hidden = true;
```
with:
```typescript
  tab.editingSession = false;
  editSettingsBtn.hidden = true;
```
(`tab` here is the same binding Step 2 introduced at this function's top via `const tab = requireActiveTab();`.)

In `chooseWorkspaceBtn`'s click handler, replace:
```typescript
chooseWorkspaceBtn.addEventListener("click", async () => {
  const picked = await window.agent.pickWorkspace();
  if (picked) {
    workspaceRoot = picked;
    setWorkspaceText(picked);
    aboutWorkspace.textContent = picked;
  }
});
```
with:
```typescript
chooseWorkspaceBtn.addEventListener("click", async () => {
  const picked = await window.agent.pickWorkspace();
  if (picked) {
    requireActiveTab().workspaceRoot = picked;
    setWorkspaceText(picked);
    aboutWorkspace.textContent = picked;
  }
});
```

- [ ] **Step 5: `pendingAttachments`**

Replace every remaining `pendingAttachments` reference — `attachFileBtn`'s click handler (`pendingAttachments.length`, `pendingAttachments = [...]`), `renderAttachmentChips` (`pendingAttachments.length`, `pendingAttachments.entries()`, the filter-on-remove reassignment), and `resetToSetup` (`pendingAttachments = [];`) — with `requireActiveTab().pendingAttachments`. For `renderAttachmentChips`, since it's called from several places and always operates on the active tab, add the tab lookup at its top:

```typescript
function renderAttachmentChips(): void {
  const tab = requireActiveTab();
  attachmentChipsRow.innerHTML = "";
  attachmentChipsRow.hidden = tab.pendingAttachments.length === 0;
  for (const [index, attachment] of tab.pendingAttachments.entries()) {
    attachmentChipsRow.appendChild(
      buildAttachmentChip(attachment, () => {
        tab.pendingAttachments = tab.pendingAttachments.filter((_, i) => i !== index);
        renderAttachmentChips();
      })
    );
  }
}
```

- [ ] **Step 6: `sessionUsage` — recomputed on replay, not stored on the tab**

`sessionUsage` stays a single module-level mutable object, exactly as it is today — it does NOT move onto `TabState` (it's fully derivable by replaying a tab's `events` through the existing `"usage"` case in `renderEvent`, the same way `toolCards` already gets rebuilt today whenever `clearEventLog()` runs followed by a replay). No code change needed for `sessionUsage` itself in this task; `clearEventLog()`'s existing reset of it is exactly what Task 4's tab-switch replay will rely on.

- [ ] **Step 7: Run the full build and verify byte-for-byte behavior preservation**

Run: `npm run build`
Expected: exit 0, zero TypeScript errors.

Live-verify (see Global Constraints for the CDP technique): launch the real app, confirm the setup screen appears exactly as before, start a session, run a simple task, confirm the event log/composer/status bar/revert button/changes panel all behave exactly as they did before this task — this task must be **invisible** to a user. Screenshot before/after for your own comparison. Full teardown after.

- [ ] **Step 8: Commit**

```bash
git add src/electron/renderer/renderer.ts
git commit -m "refactor: back session state with a TabRegistry, one implicit tab (no behavior change)"
```

---

### Task 4: Real multi-tab open, close, and focus

**Files:**
- Modify: `src/electron/renderer/renderer.ts`

Layers the actual new capability onto Task 3's now-safe foundation: the "+" button opens a new unconfigured tab instead of resetting the current one; clicking a sidebar session opens/focuses its tab instead of replacing whatever's active; the tab strip renders every open tab and lets you close (×) or focus (click) one; the 6-tab cap shows the message from Task 2's markup.

**Interfaces:**
- Consumes: `closeTab`, `focusTab`, `findTabForSession`, `tabDotState`, `MAX_OPEN_TABS` from `tabState.ts` (Task 1); the DOM elements from Task 2 (`#tab-strip-list`, `#tab-strip-new`, `#tab-strip-cap-message`).
- Produces: `renderTabStrip(): void`, `syncFormFromTab(tab: TabState): void`, `clearAndReplayEventLog(tab: TabState): void`, `switchToTab(tabId: string): void` — reused by Task 5.

- [ ] **Step 1: Import the rest of `tabState.ts`'s exports**

Extend the Task 3 import line:

```typescript
import { createTabRegistry, openNewTab, closeTab, focusTab, findTabForSession, tabDotState, activeTab, MAX_OPEN_TABS, type TabRegistry, type TabState } from "./tabState.js";
```

Add the new `byId` lookups next to the existing `tabBar`/`tabLabel` declarations (which Task 2 already removed from `index.html` — remove these two stale lookups):

```typescript
const tabStripList = byId<HTMLDivElement>("tab-strip-list");
const tabStripNew = byId<HTMLButtonElement>("tab-strip-new");
const tabStripCapMessage = byId<HTMLDivElement>("tab-strip-cap-message");
```

(Delete the now-unused `const tabBar = byId<HTMLDivElement>("tab-bar");` and `const tabLabel = byId<HTMLSpanElement>("tab-label");` lines, and remove the `tabBar.hidden = false;`/`tabLabel.textContent = ...` lines in `beginSession` and the `tabBar.hidden = true;`/`tabLabel.textContent = "";` lines in `resetToSetup` — the tab strip Step 3 below renders unconditionally now.)

- [ ] **Step 2: `syncFormFromTab` and `clearAndReplayEventLog` — the "replay render"**

Add these two functions right after `clearEventLog` (which they call):

```typescript
/** Restores the setup form's fields (workspace text, model/mode selects, plan-first checkbox, and the two custom-server subfields) from a tab's stored selection — the visual half of switching tabs. Does not touch anything session-lifecycle-related (setSetupControlsDisabled, editSettingsBtn, revert/changes buttons) — that's handled by clearAndReplayEventLog below, since those depend on whether the tab has ever had a session, which the event replay determines. */
function syncFormFromTab(tab: TabState): void {
  setWorkspaceText(tab.workspaceRoot ? tab.workspaceRoot : "No workspace selected — optional, you can just chat");
  aboutWorkspace.textContent = tab.workspaceRoot ?? "(none selected)";

  if (tab.provider.kind === "embedded") {
    modelSelect.value = tab.provider.size;
  } else if (tab.provider.kind === "anthropic") {
    modelSelect.value = tab.provider.model ?? DEFAULT_ANTHROPIC_MODEL;
  } else {
    modelSelect.value = CUSTOM_SERVER_VALUE;
    baseUrlInput.value = tab.provider.baseUrl;
    externalModelInput.value = tab.provider.model;
  }
  updateModelDependentFields();

  modeSelect.value = tab.mode;
  updateModeDescription();
  planFirstCheckbox.checked = tab.planFirst;

  taskInput.value = tab.draftTask;
  renderAttachmentChips();
}

/** Clears the shared event log and re-renders a tab's entire stored `events` history through it — the same reconstruction resumeSession already does when loading a session from disk, just from memory instead. Also restores every other piece of UI state that Step 6's replay-driven renderEvent cases set as a side effect (revert/changes button visibility via checkpoint.created, the usage badge via "usage" events) by virtue of actually replaying those events. Session-lifecycle chrome that ISN'T derivable from events alone (setSetupControlsDisabled, editSettingsBtn's label/visibility, the model badge) is set here directly from the tab's own fields. */
function clearAndReplayEventLog(tab: TabState): void {
  clearEventLog();
  for (const event of tab.events) renderEvent(event);

  const hasSession = tab.sessionId !== null;
  setSetupControlsDisabled(hasSession);
  setupSection.hidden = hasSession && !tab.editingSession;
  editSettingsBtn.hidden = !hasSession;
  editSettingsBtn.textContent = tab.editingSession ? "Cancel edit" : "Edit settings…";
  startSessionBtn.disabled = tab.editingSession ? false : hasSession;
  startSessionBtn.textContent = tab.editingSession ? "Apply changes" : hasSession ? "Starting…" : "Start session";
  taskInput.disabled = !hasSession;
  attachFileBtn.disabled = !hasSession;
  runTaskBtn.disabled = !hasSession;

  if (hasSession && tab.activeProvider) {
    const provider = tab.activeProvider;
    const modelText =
      provider.kind === "embedded"
        ? (provider.size in EMBEDDED_MODELS ? describeEmbeddedModel(provider.size as EmbeddedModelId) : provider.size)
        : provider.kind === "anthropic"
          ? (() => {
              const modelId = provider.model ?? DEFAULT_ANTHROPIC_MODEL;
              return `${ANTHROPIC_MODELS[modelId]?.name ?? modelId} (Anthropic API)`;
            })()
          : `${provider.model} (${provider.baseUrl})`;
    const gpuText = provider.kind === "embedded" && hardwareInfo?.gpu ? ` · ${hardwareInfo.gpu} GPU` : "";
    activeModelBadge.innerHTML = "";
    const dot = document.createElement("span");
    dot.className = "signal-dot";
    activeModelBadge.appendChild(dot);
    activeModelBadge.appendChild(document.createTextNode(`${modelText}${gpuText}`));
    activeModelBadge.hidden = false;
  } else {
    activeModelBadge.hidden = true;
  }
}
```

- [ ] **Step 3: `renderTabStrip` and `switchToTab`**

Add these after `clearAndReplayEventLog`:

```typescript
const DOT_GLYPH: Record<ReturnType<typeof tabDotState>, string> = {
  unconfigured: "○",
  running: "●",
  "waiting-approval": "◐",
  done: "✓",
  error: "✕",
};

/** Rebuilds the whole tab strip from tabRegistry — called after any open/close/focus/title/dot-state change. Built via createElement/textContent, never innerHTML: a tab's title comes from a resumed session's saved title, which — like every other user/session-derived string in this file (see renderMcpServerRow's own doc comment) — must never be parsed as HTML. */
function renderTabStrip(): void {
  tabStripList.innerHTML = "";
  for (const tabId of tabRegistry.order) {
    const tab = tabRegistry.tabs.get(tabId)!;
    const item = document.createElement("div");
    item.className = "tab-strip-item" + (tabId === tabRegistry.activeTabId ? " active" : "");

    const dot = document.createElement("span");
    dot.className = "tab-strip-item-dot";
    dot.textContent = DOT_GLYPH[tabDotState(tab)];
    item.appendChild(dot);

    const title = document.createElement("span");
    title.className = "tab-strip-item-title";
    title.textContent = tab.title ?? "New session";
    item.appendChild(title);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab-strip-item-close";
    close.textContent = "×";
    close.setAttribute("aria-label", `Close ${tab.title ?? "New session"}`);
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(tabRegistry, tabId);
      renderTabStrip();
      const stillActive = activeTab(tabRegistry);
      if (stillActive) {
        syncFormFromTab(stillActive);
        clearAndReplayEventLog(stillActive);
      } else {
        // Every tab closed — Global Constraints guarantees this doesn't
        // happen from user action alone (closing the app's only tab is
        // still allowed, same as it is today via the sidebar's delete
        // button through resetToSetup), so immediately open a fresh one
        // rather than leaving the shared DOM pointed at nothing.
        const fresh = openNewTab(tabRegistry)!;
        renderTabStrip();
        syncFormFromTab(fresh);
        clearAndReplayEventLog(fresh);
      }
    });
    item.appendChild(close);

    item.addEventListener("click", () => switchToTab(tabId));
    tabStripList.appendChild(item);
  }
  tabStripNew.disabled = tabRegistry.order.length >= MAX_OPEN_TABS;
}

/** Focuses an already-open tab and re-renders the shared DOM from it — a no-op if tabId isn't open or is already active (avoids a pointless clear+replay of the tab you're already looking at). */
function switchToTab(tabId: string): void {
  if (tabId === tabRegistry.activeTabId) return;
  focusTab(tabRegistry, tabId);
  renderTabStrip();
  const tab = activeTab(tabRegistry);
  if (!tab) return;
  syncFormFromTab(tab);
  clearAndReplayEventLog(tab);
}

tabStripNew.addEventListener("click", () => {
  const tab = openNewTab(tabRegistry);
  if (!tab) {
    tabStripCapMessage.hidden = false;
    return;
  }
  tabStripCapMessage.hidden = true;
  renderTabStrip();
  syncFormFromTab(tab);
  clearAndReplayEventLog(tab);
});
```

- [ ] **Step 4: Replace `resetToSetup`'s binding and body**

The `newSessionBtn` ("+") in the sidebar and the new `#tab-strip-new` button (Step 3 above) now both mean "open a new tab" — `resetToSetup` (which used to mean "blank out the one implicit tab") is no longer the right operation for either. Replace:

```typescript
newSessionBtn.addEventListener("click", resetToSetup);
```

with:

```typescript
newSessionBtn.addEventListener("click", () => tabStripNew.click());
```

`resetToSetup` itself stays defined (Task 3 already made it tab-aware) — it's still used by the sidebar's delete-button handler when deleting the currently-active tab's session (Step 6 below), where "blank out THIS tab in place" is still exactly the right behavior, unlike the "+" button.

- [ ] **Step 5: `resumeSession` — open/focus a tab instead of replacing the active one**

Replace the whole function body:

```typescript
async function resumeSession(id: string, triggerEl?: HTMLButtonElement): Promise<void> {
  const originalLabel = triggerEl?.textContent ?? null;
  if (triggerEl) {
    triggerEl.disabled = true;
    triggerEl.textContent = "Resuming…";
  }
  try {
    const alreadyOpen = findTabForSession(tabRegistry, id);
    if (alreadyOpen) {
      switchToTab(alreadyOpen.tabId);
      return;
    }

    const record = await window.agent.loadSession(id);
    if (!record) {
      startError.textContent = "Couldn't load this session — the saved file looks corrupted.";
      return;
    }

    // Reuses the current tab if it's still unconfigured (never started a
    // session) — matches today's "+" button's own default-fresh-tab
    // starting point — otherwise opens a new one, respecting the cap.
    const current = activeTab(tabRegistry);
    const tab = current && current.sessionId === null ? current : openNewTab(tabRegistry);
    if (!tab) {
      tabStripCapMessage.hidden = false;
      return;
    }
    tabStripCapMessage.hidden = true;

    tab.events = [...record.events];
    tab.title = record.title;
    renderTabStrip();
    focusTab(tabRegistry, tab.tabId);
    renderTabStrip();
    syncFormFromTab(tab);
    clearAndReplayEventLog(tab);

    await beginSession({
      sessionId: record.id,
      initialMessages: record.messages,
      priorEvents: record.events,
      title: record.title,
      createdAt: record.createdAt,
      ownerEmail: record.ownerEmail,
    });
    tab.title = record.title;
    renderTabStrip();
  } finally {
    if (triggerEl) {
      triggerEl.disabled = false;
      triggerEl.textContent = originalLabel;
    }
  }
}
```

(This removes the old `if (sessionId) { await window.agent.cancelSession(sessionId); } sessionId = null;` pair entirely, per Global Constraints — opening a different session must never touch another open tab's session. `beginSession` itself is unchanged by this task; it already operates on `requireActiveTab()` from Task 3, and `focusTab` above ensures that's the tab this function just prepared.)

- [ ] **Step 6: `renderSessionList`'s delete handler — only reset in place if that tab is still open**

Replace:

```typescript
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void (async () => {
        await window.agent.deleteSession(entry.id);
        if (entry.id === sessionId) {
          resetToSetup();
        } else {
          await refreshSessionList(sessionSearchInput.value.trim());
        }
      })();
    });
```

(Task 3 already changed the `entry.id === sessionId` check to `entry.id === activeTab(tabRegistry)?.sessionId` — this step's diff is against that already-updated version) with:

```typescript
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void (async () => {
        await window.agent.deleteSession(entry.id);
        const tabForThisSession = findTabForSession(tabRegistry, entry.id);
        if (tabForThisSession && tabForThisSession.tabId === tabRegistry.activeTabId) {
          resetToSetup();
        } else if (tabForThisSession) {
          closeTab(tabRegistry, tabForThisSession.tabId);
          renderTabStrip();
        }
        await refreshSessionList(sessionSearchInput.value.trim());
      })();
    });
```

- [ ] **Step 7: Sidebar's open-tab marker**

In `renderSessionList`, extend the existing active-check (from Task 3):

```typescript
    if (entry.id === activeTab(tabRegistry)?.sessionId) item.classList.add("active");
```

to also mark any session that's open in a non-active tab:

```typescript
    if (entry.id === activeTab(tabRegistry)?.sessionId) item.classList.add("active");
    if (findTabForSession(tabRegistry, entry.id)) item.classList.add("open-in-tab");
```

In `src/electron/renderer/styles.css`, add near the existing `.session-item.active` rule (find it first — it already exists for the current single-session highlight):

```css
.session-item.open-in-tab .session-item-label {
  font-weight: 600;
}
```

- [ ] **Step 8: Call `renderTabStrip()` once at startup, after the initial tab exists**

Right after Task 3's `openNewTab(tabRegistry);` call (in the module-level state block), add:

```typescript
renderTabStrip();
```

- [ ] **Step 9: Build and live-verify**

Run: `npm run build`
Expected: exit 0.

Live-verify (technique in Global Constraints): launch the app, confirm exactly one tab shows in the strip on startup. Click "+" — confirm a second, unconfigured tab appears and becomes active, and the setup form is blank. Start a session in it. Click the sidebar's "New session" — confirm it opens a THIRD tab (not replacing the second). Click back to the second tab in the strip — confirm the running session's state is still there (not reset). Click a saved session in the sidebar — confirm it opens as a new tab (or focuses one, if already open) without cancelling anything running in another tab. Close a tab via × — confirm the strip updates and no other tab is affected. Open tabs up to the cap (6) and confirm the 7th attempt shows the cap message and `#tab-strip-new` is disabled. Screenshot the strip at a few of these states. Full teardown after.

- [ ] **Step 10: Commit**

```bash
git add src/electron/renderer/renderer.ts src/electron/renderer/styles.css
git commit -m "feat: real multi-tab open, close, and focus"
```

---

### Task 5: Backgrounded tabs stay live; dot states; download-concurrency guard

**Files:**
- Modify: `src/electron/renderer/renderer.ts`

The last functional gap: today, `window.agent.onEvent` only stores/renders an event for the currently active tab (Task 3 preserved this on purpose, to keep that task behavior-neutral) — a backgrounded tab's task doesn't actually keep updating its own stored state. This task closes that gap using `routeEvent` from Task 1, adds the single-download-at-a-time guard, and confirms the dot states actually reach the strip live.

**Interfaces:**
- Consumes: `routeEvent` from `tabState.ts` (Task 1).

- [ ] **Step 1: Route every event to its tab, render only if it's the active one**

Replace the `window.agent.onEvent` handler (as it stands after Task 3):

```typescript
window.agent.onEvent((incomingSessionId, event) => {
  const tab = activeTab(tabRegistry);
  if (incomingSessionId !== tab?.sessionId) return;
  renderEvent(event);
});
```

with:

```typescript
window.agent.onEvent((incomingSessionId, event) => {
  routeEvent(tabRegistry, incomingSessionId, event);
  const tab = findTabForSession(tabRegistry, incomingSessionId);
  if (!tab) return; // a session with no open tab at all — same silent-discard as before this task
  if (tab.tabId === tabRegistry.activeTabId) {
    renderEvent(event);
  }
  // Re-render the strip on every event regardless of which tab it belongs
  // to, so a backgrounded tab's dot (waiting-approval, done, error) updates
  // live without needing to switch to it first.
  renderTabStrip();
});
```

(Add `routeEvent` to the existing `tabState.js` import line from Task 4.)

- [ ] **Step 2: Title updates for a backgrounded tab too**

`beginSession` currently sets the tab's title once, at start (`tabLabel.textContent = ...`, already removed in Task 4). A session's real title is only known once its first task completes and it's actually saved — today that arrives via the `agent:sessions-changed` broadcast, handled by `window.agent.onSessionsChanged(() => { void refreshSessionList(...); })`, which only touches the sidebar, not tab titles. Extend it to also refresh tab titles: replace

```typescript
window.agent.onSessionsChanged(() => {
  void refreshSessionList(sessionSearchInput.value.trim());
});
```

with:

```typescript
window.agent.onSessionsChanged(() => {
  void refreshSessionList(sessionSearchInput.value.trim());
  void syncTabTitlesFromSidebar();
});

/** Sessions get their real title only once their first task completes and they're actually saved to disk (see agent:sessions-changed) — this keeps every open tab's displayed title in sync with that, including tabs that aren't currently focused, without needing a dedicated per-session title-changed event. */
async function syncTabTitlesFromSidebar(): Promise<void> {
  if (tabRegistry.order.length === 0) return;
  const entries = await window.agent.listSessions();
  let changed = false;
  for (const entry of entries) {
    const tab = findTabForSession(tabRegistry, entry.id);
    if (tab && tab.title !== entry.title) {
      tab.title = entry.title;
      changed = true;
    }
  }
  if (changed) renderTabStrip();
}
```

- [ ] **Step 3: Single-download-at-a-time guard across tabs**

`beginSession` starts a real download (for an uncached embedded model) via `window.agent.startSession`, whose progress is reported through the single shared `window.agent.onDownloadProgress` → `#download-progress` row. Guard against a second tab starting a second download while one is already showing:

Add a module-level flag right after `let progressLastBytes = 0;`:

```typescript
let downloadInProgress = false;
```

In `window.agent.onDownloadProgress`'s handler, at its start, add:

```typescript
window.agent.onDownloadProgress((status) => {
  downloadInProgress = true;
  downloadProgressRow.hidden = false;
  // ...unchanged below...
```

In `beginSession`, right after `startSessionBtn.disabled = true;` / `startSessionBtn.textContent = "Starting…";` and before the `try`, add the guard:

```typescript
  if (downloadInProgress) {
    startError.textContent = "Another tab is already downloading a model — wait for it to finish before starting a session that needs a download.";
    startSessionBtn.disabled = false;
    startSessionBtn.textContent = "Start session";
    return;
  }
```

In `beginSession`'s `finally` block, replace:

```typescript
  } finally {
    downloadProgressRow.hidden = true;
    progressLastTime = 0;
  }
```

with:

```typescript
  } finally {
    downloadProgressRow.hidden = true;
    progressLastTime = 0;
    downloadInProgress = false;
  }
```

This is a conservative guard, not a perfectly precise one — it blocks starting a NEW download-requiring session while ANY download is in flight, even from the tab that's already downloading (which is fine, since that tab's Start button is already disabled for the duration by the existing `setSetupControlsDisabled`/`startSessionBtn.disabled` logic and can't be clicked twice).

- [ ] **Step 4: Build and live-verify the full multi-tab story**

Run: `npm run build`
Expected: exit 0.

Live-verify (technique in Global Constraints), the complete flow described in the spec's Purpose: open two tabs, start a real (fast, embedded or a scripted Anthropic call — whichever is practical in the test environment) task in tab A, switch to tab B while A is still running, confirm — via a `Runtime.evaluate` read of the strip's DOM — that tab A's dot shows `●` (running) while backgrounded, wait for it to finish, confirm the dot updates to `✓` (or `✕` on a deliberately-failed task) WITHOUT switching to it, then switch back to tab A and confirm every event that happened while backgrounded is now visible in the replayed event log (compare against what `getLiveSession` independently reports for that same session, to prove nothing was lost). Full teardown after.

- [ ] **Step 5: Commit**

```bash
git add src/electron/renderer/renderer.ts
git commit -m "feat: keep backgrounded tabs live, sync titles, guard concurrent downloads"
```

---

### Task 6: Composer draft persistence and final whole-flow verification

**Files:**
- Modify: `src/electron/renderer/renderer.ts`

The last piece the spec calls for that isn't yet wired: an unsent draft (typed but not submitted task text) surviving a tab switch. `syncFormFromTab` (Task 4) already restores `tab.draftTask` into `taskInput.value` on focus — this task makes sure it's actually kept up to date as you type, and does a final, comprehensive live pass over everything this plan built.

**Interfaces:**
- Consumes: nothing new.

- [ ] **Step 1: Keep `tab.draftTask` in sync as the user types**

Add, right after the existing `taskInput.addEventListener("keydown", ...)` block:

```typescript
taskInput.addEventListener("input", () => {
  const tab = activeTab(tabRegistry);
  if (tab) tab.draftTask = taskInput.value;
});
```

In `runTaskBtn`'s click handler, after the task is actually sent (right after `pendingAttachments`'s replacement from Task 3, `tab.pendingAttachments = [];`), also clear the draft:

```typescript
  tab.pendingAttachments = [];
  tab.draftTask = "";
  renderAttachmentChips();
```

and clear the visible field too — find where `taskInput.value` is used after a successful send (there isn't an explicit clear today; check the current code — if `runTaskBtn`'s handler doesn't already clear `taskInput.value` after sending, add `taskInput.value = "";` right after the `tab.draftTask = "";` line above, matching the field and the stored draft).

- [ ] **Step 2: Full whole-flow live verification**

Run: `npm run build && npm test`
Expected: both exit 0.

Live-verify the complete spec end to end (technique in Global Constraints):
1. Launch fresh — confirm exactly one unconfigured tab, matching today's launch screen.
2. Open a second tab, type a partial task into its composer WITHOUT sending it, switch to the first tab, switch back — confirm the draft text is still there.
3. Start sessions in two different tabs, run a task in each, confirm both progress independently and neither's events leak into the other's event log.
4. Close a tab with a task still running in it (confirm via checking `getLiveSession` for that session id directly, not through any tab) — confirm the session is still genuinely running server-side after the tab is gone.
5. Reopen that same session from the sidebar — confirm it catches up to everything that happened while its tab was closed.
6. Confirm the sidebar's bold/open-tab marker (Task 4 Step 7) appears for sessions currently open as tabs and disappears once closed.
7. Screenshot the final strip state with several tabs in different dot states (unconfigured/running/waiting-approval/done/error) for visual confirmation all five render distinctly.

Full teardown after — kill Electron, remove the scratch profile, confirm the real production `userData` sessions/settings are untouched.

- [ ] **Step 3: Commit**

```bash
git add src/electron/renderer/renderer.ts
git commit -m "feat: persist composer drafts per tab; final multi-session tabs verification"
```

---

## Final Verification

After Task 6:

```bash
npm run build && npm test
```

Expected: exit code 0, every test across the whole suite prints `ok`/`All tests passed.`.

Then follow this project's established finishing flow: merge the feature branch/worktree via `superpowers:finishing-a-development-branch`, and ship the next beta release following the same CHANGELOG/version-bump/tag/CI-poll/asset-verification process used for every prior feature this session.
