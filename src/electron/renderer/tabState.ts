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
