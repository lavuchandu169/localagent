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
  /** True from the moment a task is sent for this tab until its terminal `done` event arrives. Distinct from "has a sessionId": a backgrounded tab mid-task still has a session, and the Run button must stay disabled for it (a second concurrent runTask against the same live session), which is exactly what re-deriving the button's state from `sessionId` alone got wrong. Not derived from `events` because a just-sent task has no events yet — there's a real window between "sent" and "first status event" where the last stored event is still the PREVIOUS task's `done`. */
  running: boolean;
}

/** The provider/mode/planFirst a brand-new, never-configured tab starts from — also what resetToSetup restores a tab to once its session is deleted. A function (not a shared const) so every tab gets its own object and no caller can mutate another tab's provider by accident. */
export function defaultTabConfig(): { provider: ProviderConfig; mode: PermissionMode; planFirst: boolean } {
  return { provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "DEFAULT", planFirst: false };
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
    ...defaultTabConfig(),
    activeProvider: null,
    editingSession: false,
    running: false,
  };
  registry.tabs.set(tab.tabId, tab);
  registry.order.push(tab.tabId);
  registry.activeTabId = tab.tabId;
  return tab;
}

/**
 * Wipes every trace of a session from a tab, leaving it exactly as if it had
 * just been opened — used when the tab's session is deleted out from under it
 * (see resetToSetup in renderer.ts). Clearing `events`/`draftTask` is the
 * whole point: a tab that keeps them replays the DELETED session's log (and
 * re-populates its composer) the next time you switch back to it.
 *
 * `title` is deliberately NOT reset here — the caller owns it, since a tab
 * can legitimately keep a title it was given for other reasons.
 */
export function resetTabToUnconfigured(tab: TabState): void {
  const defaults = defaultTabConfig();
  tab.sessionId = null;
  tab.workspaceRoot = null;
  tab.activeProvider = null;
  tab.events = [];
  tab.draftTask = "";
  tab.pendingAttachments = [];
  tab.provider = defaults.provider;
  tab.mode = defaults.mode;
  tab.planFirst = defaults.planFirst;
  tab.editingSession = false;
  tab.running = false;
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

/** Whether a stream of events ends mid-task — i.e. its last entry isn't the terminal `done`. No events at all means a session that's started but never run a task, which is NOT in flight, so this is false for an empty array. Used to derive TabState.running both incrementally (routeEvent, below) and wholesale, when a tab is seeded all at once from a LiveSessionSnapshot's events instead of one event at a time (see resumeSession in renderer.ts). */
export function lastEventStillRunning(events: AgentEvent[]): boolean {
  const last = events[events.length - 1];
  return last !== undefined && last.type !== "done";
}

/** Stores the event into whichever tab has this sessionId — a no-op if none does (mirrors today's silent-discard behavior for a session with no open view, e.g. one that kept running after its tab was closed). Always stores, regardless of whether that tab is currently focused; renderer.ts decides separately whether to also render it live. Also keeps `running` in lock-step with the just-appended event — this is what turns it back off once a backgrounded tab's task actually finishes, since nothing else observes events for a tab that isn't the active one. */
export function routeEvent(registry: TabRegistry, sessionId: string, event: AgentEvent): void {
  const tab = findTabForSession(registry, sessionId);
  if (!tab) return;
  tab.events.push(event);
  tab.running = lastEventStillRunning(tab.events);
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
