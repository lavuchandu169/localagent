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

  wireImportExport();
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
    row.appendChild(name);

    const status = document.createElement("span");
    status.className = provider.configured ? "freellmapi-provider-status configured" : "freellmapi-provider-status";
    status.textContent = provider.configured ? `Configured (${provider.enabledKeyCount} active)` : "Not configured";
    row.appendChild(status);

    const signupUrl = PROVIDER_SIGNUP_URLS[provider.platform];
    if (signupUrl && !provider.keyless && !provider.configured) {
      const link = document.createElement("a");
      link.textContent = "Get key →";
      link.href = "#";
      link.addEventListener("click", (e) => {
        e.preventDefault();
        window.agent.openExternal(signupUrl);
      });
      row.appendChild(link);
    }

    const controls = document.createElement("div");
    controls.className = "freellmapi-provider-controls";

    if (!provider.configured && provider.keyless) {
      const enableBtn = document.createElement("button");
      enableBtn.type = "button";
      enableBtn.textContent = "Enable";
      enableBtn.addEventListener("click", () => withRowBusy(row, () => addKeyForPlatform(provider.platform)));
      controls.appendChild(enableBtn);
    } else if (!provider.configured) {
      const input = document.createElement("input");
      input.type = "password";
      input.placeholder = "Paste key";
      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.textContent = "Save";
      saveBtn.addEventListener("click", () =>
        withRowBusy(row, () => addKeyForPlatform(provider.platform, input.value))
      );
      controls.appendChild(input);
      controls.appendChild(saveBtn);
    } else {
      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.textContent = provider.enabledKeyCount > 0 ? "Disable" : "Enable";
      toggleBtn.addEventListener("click", () => withRowBusy(row, () => toggleFirstKeyEnabled(provider.platform)));
      const revealBtn = document.createElement("button");
      revealBtn.type = "button";
      revealBtn.textContent = "Reveal";
      revealBtn.addEventListener("click", () => withRowBusy(row, () => revealFirstKey(provider.platform, row)));
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", () => withRowBusy(row, () => removeFirstKey(provider.platform)));
      controls.appendChild(toggleBtn);
      controls.appendChild(revealBtn);
      controls.appendChild(removeBtn);
    }

    row.appendChild(controls);
    listEl.appendChild(row);
  }
}

/** Disables every button in the row for the duration of an action - the
 * concrete guard against the double-click race called out in this plan's
 * Review Focus: a second click while the first request is still in
 * flight is simply impossible, not merely unlikely. */
async function withRowBusy(row: HTMLElement, action: () => Promise<void>): Promise<void> {
  const buttons = row.querySelectorAll("button");
  buttons.forEach((b) => (b.disabled = true));
  try {
    await action();
  } catch (err) {
    errorEl.hidden = false;
    errorEl.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

async function addKeyForPlatform(platform: string, key?: string): Promise<void> {
  await window.agent.freellmapiAddKey({ platform, key });
  await refreshProviders();
}

/** The provider list doesn't carry individual key ids - fetch the key
 * list once per action rather than keeping a second cached copy that
 * could drift from what refreshProviders() just rendered. */
async function findFirstKeyId(platform: string): Promise<number | undefined> {
  const keys = await window.agent.freellmapiListKeys();
  return keys.find((k) => k.platform === platform)?.id;
}

async function revealFirstKey(platform: string, row: HTMLElement): Promise<void> {
  const id = await findFirstKeyId(platform);
  if (id === undefined) return;
  const { key } = await window.agent.freellmapiRevealKey(id);
  const existing = row.querySelector(".freellmapi-revealed-key");
  if (existing) existing.remove();
  const revealed = document.createElement("code");
  revealed.className = "freellmapi-revealed-key";
  revealed.textContent = key;
  row.appendChild(revealed);
}

async function removeFirstKey(platform: string): Promise<void> {
  const id = await findFirstKeyId(platform);
  if (id === undefined) return;
  await window.agent.freellmapiRemoveKey(id);
  await refreshProviders();
}

async function toggleFirstKeyEnabled(platform: string): Promise<void> {
  const keys = await window.agent.freellmapiListKeys();
  const current = keys.find((k) => k.platform === platform);
  if (!current) return;
  await window.agent.freellmapiUpdateKey(current.id, { enabled: !current.enabled });
  await refreshProviders();
}

function wireImportExport(): void {
  const importBtn = document.getElementById("freellmapi-import-btn") as HTMLButtonElement;
  const exportJsonBtn = document.getElementById("freellmapi-export-json-btn") as HTMLButtonElement;
  const exportEnvBtn = document.getElementById("freellmapi-export-env-btn") as HTMLButtonElement;
  const previewEl = document.getElementById("freellmapi-import-preview")!;

  importBtn.addEventListener("click", async () => {
    try {
      const files = await window.agent.freellmapiPickImportFiles();
      if (!files) return;
      const preview = await window.agent.freellmapiPreviewImport(files);
      renderImportPreview(preview, previewEl);
    } catch (err) {
      errorEl.hidden = false;
      errorEl.textContent = err instanceof Error ? err.message : String(err);
    }
  });

  const doExport = (format: "json" | "env") => async () => {
    try {
      // exportKeys() throws the real server message (e.g. "No keys to
      // export") on a 404 - freellmapiExportToFile mirrors that same
      // call internally, so the same message surfaces here.
      const result = await window.agent.freellmapiExportToFile(format);
      if (!result.saved) return; // user cancelled the save dialog - not an error
    } catch (err) {
      errorEl.hidden = false;
      errorEl.textContent = err instanceof Error ? err.message : String(err);
    }
  };
  exportJsonBtn.addEventListener("click", doExport("json"));
  exportEnvBtn.addEventListener("click", doExport("env"));
}

function renderImportPreview(preview: Awaited<ReturnType<typeof window.agent.freellmapiPreviewImport>>, container: HTMLElement): void {
  container.hidden = false;
  container.innerHTML = "";
  const summary = document.createElement("p");
  summary.textContent = `Found ${preview.total} key(s)${preview.duplicates ? `, ${preview.duplicates} duplicate(s)` : ""}.`;
  container.appendChild(summary);

  const importBtn = document.createElement("button");
  importBtn.type = "button";
  importBtn.textContent = `Import ${preview.keys.filter((k) => !k.isDuplicate).length} key(s)`;
  importBtn.addEventListener("click", async () => {
    try {
      const toImport = preview.keys
        .filter((k) => !k.isDuplicate && k.detectedPlatform)
        .map((k) => ({ keyName: k.keyName, keyValue: k.keyValue, platform: k.detectedPlatform!, baseUrl: k.baseUrl, models: k.models }));
      await window.agent.freellmapiImportSelected(toImport);
      container.hidden = true;
      await refreshProviders();
    } catch (err) {
      errorEl.hidden = false;
      errorEl.textContent = err instanceof Error ? err.message : String(err);
    }
  });
  container.appendChild(importBtn);
}
