// The native replacement for the old separate-window FreeLLMAPI
// dashboard - owns the "Manage free providers..." panel's DOM, styled
// entirely with this app's own CSS custom properties (no vendored CSS,
// no iframe/webview). Reuses the app's existing .modal-card/.modal-close-x
// overlay convention (same treatment as #settings-panel/#about-panel/
// #mcp-servers-panel - see styles.css's shared selector group) rather than
// inventing a parallel one. Follows tabState.ts's separation from
// renderer.ts: this file is DOM-wiring, not unit-tested directly (no
// Electron runtime in this sandbox - the same limitation already flagged
// for the rest of this feature), verified by manual testing on a real
// machine instead.
import type { ProviderRow } from "../freellmapiKeysApi.js";

/** Static signup-URL map, re-derived from the vendored client's own
 * PLATFORMS constant (vendor/freellmapi/client/src/data/) rather than
 * imported across the client/server package boundary - that's a
 * separate Vite project this Node/Electron-main-adjacent file can't
 * reach into. Extend as needed; a platform missing here just shows no
 * "Get key" link, never breaks anything. */
const PROVIDER_SIGNUP_URLS: Record<string, string> = {
  groq: "https://console.groq.com/keys",
  gemini: "https://aistudio.google.com/apikey",
  openrouter: "https://openrouter.ai/keys",
  cerebras: "https://cloud.cerebras.ai/",
  cohere: "https://dashboard.cohere.com/api-keys",
};

let panel: HTMLElement;
let closeBtn: HTMLButtonElement;
let refreshBtn: HTMLButtonElement;
let errorEl: HTMLElement;
let loadingEl: HTMLElement;
let listEl: HTMLElement;

export function initFreellmapiPanel(): void {
  panel = document.getElementById("freellmapi-panel")!;
  closeBtn = document.getElementById("freellmapi-panel-close-x") as HTMLButtonElement;
  refreshBtn = document.getElementById("freellmapi-panel-refresh") as HTMLButtonElement;
  errorEl = document.getElementById("freellmapi-panel-error")!;
  loadingEl = document.getElementById("freellmapi-panel-loading")!;
  listEl = document.getElementById("freellmapi-provider-list")!;

  closeBtn.addEventListener("click", closeFreellmapiPanel);
  // Spec's "optimize" requirement: no polling, fetched once per open, but a
  // manual way to re-fetch without a close/reopen round trip.
  refreshBtn.addEventListener("click", () => void refreshProviders());
  panel.addEventListener("click", (e) => {
    if (e.target === panel) closeFreellmapiPanel();
  });
}

/** Exported so renderer.ts's other panel toggles (Settings/About/MCP
 * Servers) can close this one before opening themselves, matching the
 * mutual-exclusion convention already wired for every other panel in
 * this file - Task 9 wires the reverse direction when it rewires the
 * "Manage free providers..." button itself. */
export function closeFreellmapiPanel(): void {
  panel.hidden = true;
}

export async function openFreellmapiPanel(): Promise<void> {
  panel.hidden = false;
  await refreshProviders();
}

async function refreshProviders(): Promise<void> {
  errorEl.hidden = true;
  loadingEl.hidden = false;
  listEl.innerHTML = "";
  try {
    const result = await window.agent.freellmapiListProviders();
    renderProviders(result.providers);
  } catch (err) {
    errorEl.hidden = false;
    errorEl.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    loadingEl.hidden = true;
  }
}

function renderProviders(providers: ProviderRow[]): void {
  listEl.innerHTML = "";
  for (const provider of providers) {
    const row = document.createElement("div");
    row.className = "freellmapi-provider-row";

    const name = document.createElement("span");
    name.className = "freellmapi-provider-name";
    name.textContent = provider.name;

    const status = document.createElement("span");
    status.className = provider.configured ? "freellmapi-provider-status configured" : "freellmapi-provider-status";
    status.textContent = provider.configured ? `Configured (${provider.enabledKeyCount} active)` : "Not configured";

    row.appendChild(name);
    row.appendChild(status);

    const signupUrl = PROVIDER_SIGNUP_URLS[provider.platform];
    if (signupUrl && !provider.keyless) {
      const link = document.createElement("a");
      link.textContent = "Get key →";
      link.href = "#";
      link.addEventListener("click", (e) => {
        e.preventDefault();
        window.agent.openExternal(signupUrl);
      });
      row.appendChild(link);
    }

    listEl.appendChild(row);
  }
}
