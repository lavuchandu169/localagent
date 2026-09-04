# Multi-session / tabs — design spec

Date: 2026-09-04

## Purpose

The backend already runs multiple sessions concurrently — `sessionRegistry.ts`'s
`registry.sessions` is a `Map`, and `getLiveSessionSnapshot` exists specifically
because a session's live state is meaningful independent of any one open view.
The renderer doesn't take advantage of this: [renderer.ts:309](../../../src/electron/renderer/renderer.ts#L309)
holds a single module-level `let sessionId: string | null = null` that ~20
places in the file read or mutate — the composer, the event log, permission/
plan approval, revert, the changes panel, model editing, cancel — and event
routing itself currently **discards** any incoming event whose `sessionId`
doesn't match the current one
([renderer.ts:1250](../../../src/electron/renderer/renderer.ts#L1250)). Switching
sessions today means tearing down and reloading the whole view; a backgrounded
session's live progress is silently thrown away, not just hidden.

This adds real tabs: an actual tab strip holding multiple open sessions, each
one's task keeping running and updating in the background whether or not
you're looking at it, with no lost events and no reload when you switch back.

## Scope

- Local, renderer-side only. No backend changes — `sessionRegistry.ts` already
  supports everything this needs.
- Up to **6 tabs** open at once; opening past the cap shows a clear message
  instead of degrading silently.
- Every launch starts with **zero tabs open** (just the sidebar) — open tabs
  are not persisted or restored across a restart.
- Keyboard shortcuts, tab reordering, and cross-session actions (e.g. compare
  two tabs) are out of scope for this pass.

## Tab lifecycle

- **Opening:** clicking a session in the sidebar either focuses its
  already-open tab, or opens a new one and seeds it from `getLiveSession`
  (for a session with in-memory state) or `loadSession` (a saved-but-not-live
  one) — the exact same two calls the current single-session load path
  already uses. The "+" button opens a new, **unconfigured** tab — no
  `sessionId` yet, just today's setup screen (choose workspace, pick model,
  mode, Start), now scoped to that one tab instead of being the app's single
  global setup state. Clicking Start in that tab turns it into a real running
  session exactly as it does today.
- **Closing:** removes the tab from the strip and drops its in-memory
  `TabState` — the backend session is completely unaffected and keeps
  running; `sessionRegistry` was already designed not to care whether any UI
  is currently pointed at a session. Reopening it later re-seeds a fresh
  `TabState` via `getLiveSession`, catching up on everything that happened
  while it was closed. A pending permission or plan approval in a closed tab
  is never auto-resolved — it just waits, same as it does today for any
  session that isn't the active one.
- **Focusing:** switching the active tab swaps the shared DOM's content to
  reflect that tab's stored `TabState` (a "replay render" from memory,
  structurally the same reconstruction `loadSession` already does from disk)
  — no backend call, no lost state.
- **Sidebar integration:** a session currently open in a tab gets a visual
  marker in the sidebar list (extending the existing `entry.id === sessionId`
  → `"active"` class check at [renderer.ts:1681](../../../src/electron/renderer/renderer.ts#L1681)
  to check open-tab membership instead of the single `sessionId`). Clicking an
  already-open one focuses it rather than opening a duplicate tab.

## Architecture

**One shared DOM, N in-memory tab models.** The event log, composer, status
bar, changes panel, and revert button stay the single set of DOM elements
they are today. What changes is what feeds them: instead of one global
`sessionId`, a new module owns a `Map<tabId, TabState>`, and the DOM is always
rendering whichever tab is currently focused.

An alternative — N full live DOM subtrees, one per tab, shown/hidden via CSS
like today's About/Settings panels multiplied by N — was considered and
rejected: "fully live in the background" only requires the *data* to keep
updating while backgrounded, not the *DOM*. N live DOM trees with N sets of
event listeners is real, ongoing memory/perf cost for zero behavioral
benefit over storing events in memory and rendering only the focused tab.

## New module: `src/electron/renderer/tabState.ts`

Framework-free, no DOM access — the first unit-testable piece of this app's
renderer code. Owns tab identity, the open-tab list, the 6-tab cap, and
routing an incoming event to the right tab's state.

```typescript
import type { AgentEvent, PermissionMode } from "../../types.js";
import type { PickedAttachment } from "../attachments.js"; // same import renderer.ts already uses (renderer.ts:6)

export const MAX_OPEN_TABS = 6;

export type TabDotState = "unconfigured" | "running" | "waiting-approval" | "done" | "error";

export interface TabState {
  tabId: string;
  sessionId: string | null; // null until Start is clicked
  title: string | null;
  events: AgentEvent[];
  draftTask: string;
  pendingAttachments: PickedAttachment[];
  workspaceRoot: string | null;
  mode: PermissionMode;
  planFirst: boolean;
  usage: { inputTokens: number; outputTokens: number; costUsd: number } | null;
  checkpointHash: string | null;
}

export interface TabRegistry {
  tabs: Map<string, TabState>;
  order: string[]; // tab display order, append-on-open
  activeTabId: string | null;
}

export function createTabRegistry(): TabRegistry;

/** Refuses past MAX_OPEN_TABS — returns null instead of creating a tab. */
export function openNewTab(registry: TabRegistry): TabState | null;

/** Finds an existing tab for this sessionId, or null if none is open. */
export function findTabForSession(registry: TabRegistry, sessionId: string): TabState | null;

export function closeTab(registry: TabRegistry, tabId: string): void;

export function focusTab(registry: TabRegistry, tabId: string): void;

/** Routes one incoming AgentEvent to the tab whose sessionId matches — a no-op if no open tab matches (mirrors today's silent-discard behavior for an event belonging to a session with no open view at all). Always stores the event in that tab's `events` array, regardless of whether that tab is currently focused. */
export function routeEvent(registry: TabRegistry, sessionId: string, event: AgentEvent): void;

/** Derives a tab's dot-state from its stored events/session state — pure function of TabState, no side effects. */
export function tabDotState(tab: TabState): TabDotState;
```

`renderer.ts` keeps every DOM-manipulation responsibility it has today; it
calls into `tabState.ts` for the data model and re-renders the shared DOM
from `registry.tabs.get(registry.activeTabId)` whenever that changes.

## Tab strip UI

Browser-style tabs (confirmed via mockup during brainstorming), inserted
where today's single `#tab-bar` indicator (`index.html`'s `#tab-bar`/
`#tab-item`/`#tab-dot`/`#tab-label`) currently sits — that element already
exists for exactly one tab; this replaces it with a real strip of N. Each
tab shows: a state dot, the title (session title once set, "New session"
until then), and an always-visible `×` to close. A trailing `+` opens a new
tab, disabled with a tooltip once `MAX_OPEN_TABS` is reached. The active
tab gets an underline in the accent color.

**Dot states:** ○ unconfigured (setup screen, no session started) · ●
running (task in progress) · ◐ waiting for your approval (a pending
permission or plan-approval prompt) · ✓ done (last task finished cleanly) ·
✕ error (last task or provider call failed) — giving every one of these a
state means a backgrounded tab that needs attention is visible from the
strip without switching to it.

## Error handling

- A pending permission/plan approval in a backgrounded or closed tab is
  never auto-resolved — `onApprovalNeeded`'s promise just keeps waiting,
  exactly as it already behaves for any non-active session today. The ◐ dot
  is how you notice it needs you.
- A task/provider error in a backgrounded tab sets that tab's dot to ✕
  rather than surfacing a dialog — same "don't interrupt what you're not
  looking at" posture already established elsewhere in this app (cloud
  sync, the auto-updater).
- Opening past the 6-tab cap shows a clear, non-blocking message ("close a
  tab first") rather than silently refusing with no explanation.

## Testing

- `tabState.ts`: full TDD unit coverage — the cap, opening, closing,
  focusing, `findTabForSession`, event routing to the correct tab
  regardless of which is focused, and `tabDotState`'s derivation for every
  state including the transition into ✕ on an error event and ◐ on a
  `permission.request`/`plan.proposed` event. Pure, no DOM, no fakes needed
  beyond plain `AgentEvent` fixtures.
- `renderer.ts`'s DOM-manipulation changes: no automated coverage, matching
  this app's established renderer pattern — verified live via Chrome
  DevTools Protocol against the real running app (open two tabs, run a task
  in one, switch away, confirm it kept progressing in the background via
  its dot state, switch back, confirm no events were lost).

## Out of scope

- Keyboard shortcuts (new tab, close tab, switch to tab N) — mouse-only
  interaction for this pass, matching how the sidebar already works.
- Tab reordering (drag and drop) — tabs open in the order you open them.
- Restoring previously-open tabs on app relaunch — every launch starts with
  zero tabs open; the sidebar already remembers every session, so reopening
  what you need is one click.
- Any change to `sessionRegistry.ts` or other backend code — this is a
  renderer-only feature built entirely on APIs that already exist.
