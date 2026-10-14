/**
 * Collapsed/expanded state for the session sidebar — a per-viewer UI
 * preference only, same reasoning and same localStorage-based pattern as
 * the theme preference in renderer.ts (THEME_KEY/loadTheme/applyTheme),
 * not the main-process settings store the API keys use.
 */
export const SIDEBAR_COLLAPSED_KEY = "localagent:sidebar-collapsed";

export function loadSidebarCollapsed(storage: Pick<Storage, "getItem">): boolean {
  try {
    return storage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveSidebarCollapsed(storage: Pick<Storage, "setItem">, collapsed: boolean): void {
  try {
    storage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Best-effort — if this fails, the sidebar just resets to expanded next launch; not worth surfacing an error for.
  }
}
