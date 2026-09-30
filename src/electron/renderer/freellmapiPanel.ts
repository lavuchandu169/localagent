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
import type { ProviderRow, KeyRow } from "../freellmapiKeysApi.js";
import { openOverlayPanel, closeOverlayPanel } from "./overlayPanel.js";

/** Full signup-URL map, transcribed from the vendored client's own
 * PLATFORMS constant (vendor/freellmapi/client/src/components/keys/shared.tsx,
 * read directly - not guessed) rather than imported across the
 * client/server package boundary, which this Node/Electron-main-adjacent
 * file can't reach into (separate Vite project, separate build). The
 * platform ids here are the server's own values (e.g. "google", not
 * "gemini") - confirmed against the same source. Extend as needed; a
 * platform missing here just shows no "Get key" link, never breaks
 * anything. */
const PROVIDER_SIGNUP_URLS: Record<string, string> = {
  aclide: "https://aclide.com/en/dashboard/api-keys",
  speka: "https://speka.me/dashboard/keys",
  moondream: "https://moondream.ai/c/cloud/api-keys",
  google: "https://aistudio.google.com/apikey",
  groq: "https://console.groq.com/keys",
  cerebras: "https://cloud.cerebras.ai",
  sail: "https://app.sailresearch.com",
  electronhub: "https://app.electronhub.ai",
  experiential: "https://platform.experientiallabs.ai",
  router9: "https://www.router9.com",
  septor: "https://septorlabs.com/dashboard",
  clod: "https://newapp.clod.io",
  speechify: "https://platform.speechify.ai",
  blaze: "https://blazeapi.org/dashboard",
  lucidity: "https://composite.lucidity.sh",
  airforce: "https://api.airforce",
  dreamprompting: "https://dreamprompting.com",
  waterfall: "https://getwaterfall.org",
  logfare: "https://logfare.ai",
  bai: "https://b.ai",
  radeon: "https://developer.amd.com.cn/radeon/tokenfactory",
  nvidia: "https://build.nvidia.com/settings/api-keys",
  mistral: "https://console.mistral.ai/api-keys/",
  openrouter: "https://openrouter.ai/keys",
  github: "https://github.com/settings/tokens",
  cohere: "https://dashboard.cohere.com/api-keys",
  cloudflare: "https://dash.cloudflare.com",
  zhipu: "https://z.ai/manage-apikey/apikey-list",
  ollama: "https://ollama.com/settings/keys",
  kilo: "https://app.kilo.ai",
  pollinations: "https://enter.pollinations.ai",
  ovh: "https://endpoints.ai.cloud.ovh.net",
  llm7: "https://llm7.io",
  huggingface: "https://huggingface.co/settings/tokens",
  opencode: "https://opencode.ai/auth",
  agnes: "https://platform.agnes-ai.com",
  reka: "https://platform.reka.ai",
  siliconflow: "https://siliconflow.com",
  routeway: "https://routeway.ai",
  bazaarlink: "https://bazaarlink.ai",
  ainative: "https://ainative.studio",
  aion: "https://www.aionlabs.ai",
  requesty: "https://www.requesty.ai",
  navy: "https://api.navy",
  nara: "https://router.bynara.id",
  sealion: "https://sea-lion.ai",
  orcarouter: "https://www.orcarouter.ai",
  unorouter: "https://unorouter.com",
  xkiro: "https://xkiro.com",
  anyapi: "https://anyapi.ai",
  modelscope: "https://modelscope.cn/my/myaccesstoken",
  aihorde: "https://aihorde.net/register",
  qianfan: "https://console.bce.baidu.com/qianfan/overview",
  volcengine: "https://console.volcengine.com/ark",
  longcat: "https://longcat.chat/platform",
  xfyun: "https://console.xfyun.cn",
};

let panel: HTMLElement;
let closeBtn: HTMLButtonElement;
let refreshBtn: HTMLButtonElement;
let errorEl: HTMLElement;
let loadingEl: HTMLElement;
let listEl: HTMLElement;
let customEndpointsEl: HTMLElement;

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
  wireCustomProvider();
}

/** Exported so renderer.ts's other panel toggles (Settings/About/MCP
 * Servers) can close this one before opening themselves, matching the
 * mutual-exclusion convention already wired for every other panel in
 * this file - Task 9 wires the reverse direction when it rewires the
 * "Manage free providers..." button itself. */
export function closeFreellmapiPanel(): void {
  closeOverlayPanel(panel);
}

export async function openFreellmapiPanel(): Promise<void> {
  openOverlayPanel(panel);
  await refreshProviders();
  await refreshCustomEndpoints(customEndpointsEl);
}

// Refresh generation counter: every refreshProviders() call (Refresh
// button, or any action's own re-fetch after add/remove/toggle) increments
// this and captures its own number. Two calls can be in flight at once -
// clicking Refresh mid-action, or two different rows' actions overlapping -
// and whichever response arrives LAST is not necessarily the one that was
// requested last. Applying a stale response over a newer one would flash
// the list back to old data. Only the call whose captured number still
// matches the current one when its response lands is allowed to render.
let refreshGeneration = 0;

async function refreshProviders(): Promise<void> {
  const generation = ++refreshGeneration;
  errorEl.hidden = true;
  loadingEl.hidden = false;
  try {
    const result = await window.agent.freellmapiListProviders();
    if (generation !== refreshGeneration) return; // a newer refresh has already started or finished
    renderProviders(result.providers);
  } catch (err) {
    if (generation !== refreshGeneration) return;
    errorEl.hidden = false;
    errorEl.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    if (generation === refreshGeneration) loadingEl.hidden = true;
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
/**
 * Reveal/Remove/the Enable-Disable toggle each act on ONE key, but a
 * platform can have several (import routinely creates GROQ_KEY,
 * GROQ_KEY_2, ...). Silently picking "the first one found" would let
 * Remove delete an arbitrary key out of several, or the toggle flip a
 * DIFFERENT key than the one its own label describes - a real, silent
 * data-integrity risk, not just a display quirk. Refuses instead of
 * guessing whenever more than one key exists for a platform; managing
 * individual keys when a provider has several is real future work this
 * pass doesn't build (see the plan's Task 9 ledger ruling).
 */
async function findSoleKeyId(platform: string): Promise<number | undefined> {
  const keys = await window.agent.freellmapiListKeys();
  const matching = keys.filter((k) => k.platform === platform);
  if (matching.length > 1) {
    throw new Error(
      `${platform} has ${matching.length} keys configured - this panel can only manage a single key per provider right now. Remove the extras via Export first, or wait for per-key management.`
    );
  }
  return matching[0]?.id;
}

async function revealFirstKey(platform: string, row: HTMLElement): Promise<void> {
  const id = await findSoleKeyId(platform);
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
  const id = await findSoleKeyId(platform);
  if (id === undefined) return;
  await window.agent.freellmapiRemoveKey(id);
  await refreshProviders();
}

async function toggleFirstKeyEnabled(platform: string): Promise<void> {
  const id = await findSoleKeyId(platform);
  if (id === undefined) return;
  const keys = await window.agent.freellmapiListKeys();
  const current = keys.find((k) => k.id === id);
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

  // Computed once, reused for both the button's own label and the request
  // body - the label previously counted "not a duplicate" while the actual
  // request also dropped entries with no detected platform, so the two
  // numbers could disagree.
  const toImport = preview.keys
    .filter((k) => !k.isDuplicate && k.detectedPlatform)
    .map((k) => ({ keyName: k.keyName, keyValue: k.keyValue, platform: k.detectedPlatform!, baseUrl: k.baseUrl, models: k.models }));
  const undetected = preview.keys.filter((k) => !k.isDuplicate && !k.detectedPlatform).length;

  const summary = document.createElement("p");
  const summaryParts = [`Found ${preview.total} key(s)`];
  if (preview.duplicates) summaryParts.push(`${preview.duplicates} duplicate(s)`);
  if (undetected) summaryParts.push(`${undetected} with no recognized platform`);
  summary.textContent = summaryParts.join(", ") + ".";
  container.appendChild(summary);

  if (preview.skipped.length > 0) {
    const skippedEl = document.createElement("p");
    skippedEl.className = "hint-text";
    skippedEl.textContent = `Skipped: ${preview.skipped.join(", ")}`;
    container.appendChild(skippedEl);
  }

  const importBtn = document.createElement("button");
  importBtn.type = "button";
  importBtn.textContent = `Import ${toImport.length} key(s)`;
  importBtn.disabled = toImport.length === 0;
  importBtn.addEventListener("click", async () => {
    importBtn.disabled = true;
    try {
      const result = await window.agent.freellmapiImportSelected(toImport);
      // A per-key failure (a duplicate that slipped through, an SSRF-
      // rejected custom baseUrl, a platform the server itself rejects) is
      // real, user-relevant information - reported here rather than
      // silently closing the preview as if every key had succeeded.
      if (result.errors.length > 0) {
        const errorLines = result.errors.map((e) => `${e.key}: ${e.error}`).join("; ");
        if (result.imported === 0) {
          throw new Error(`Import failed for all keys — ${errorLines}`);
        }
        errorEl.hidden = false;
        errorEl.textContent = `Imported ${result.imported} of ${toImport.length}. Failed: ${errorLines}`;
      } else {
        container.hidden = true;
      }
      await refreshProviders();
    } catch (err) {
      errorEl.hidden = false;
      errorEl.textContent = err instanceof Error ? err.message : String(err);
      importBtn.disabled = false;
    }
  });
  container.appendChild(importBtn);
}

/**
 * GET /providers deliberately excludes platform === 'custom' (confirmed by
 * reading keys.ts directly - it filters `.filter(p => p.platform !==
 * 'custom')`), so a custom endpoint just added would otherwise be
 * invisible anywhere in this panel with no way to see, reveal or remove
 * it again. Fetches the real key list and renders only the custom rows,
 * refreshed after every add.
 */
async function refreshCustomEndpoints(container: HTMLElement): Promise<void> {
  let keys: KeyRow[];
  try {
    keys = await window.agent.freellmapiListKeys();
  } catch {
    return; // the shared error banner already reports listKeys() failures elsewhere; this section just stays empty
  }
  const customKeys = keys.filter((k) => k.platform === "custom");
  container.innerHTML = "";
  if (customKeys.length === 0) return;

  const heading = document.createElement("p");
  heading.className = "hint-text";
  heading.textContent = "Configured custom endpoints:";
  container.appendChild(heading);

  for (const key of customKeys) {
    const row = document.createElement("div");
    row.className = "freellmapi-provider-row";
    const label = document.createElement("span");
    label.className = "freellmapi-provider-name";
    label.textContent = key.label || key.baseUrl || `#${key.id}`;
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", async () => {
      removeBtn.disabled = true;
      try {
        await window.agent.freellmapiRemoveKey(key.id);
        await refreshCustomEndpoints(container);
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = err instanceof Error ? err.message : String(err);
        removeBtn.disabled = false;
      }
    });
    row.appendChild(label);
    row.appendChild(removeBtn);
    container.appendChild(row);
  }
}

function wireCustomProvider(): void {
  const baseUrlInput = document.getElementById("freellmapi-custom-base-url") as HTMLInputElement;
  const apiKeyInput = document.getElementById("freellmapi-custom-api-key") as HTMLInputElement;
  const displayNameInput = document.getElementById("freellmapi-custom-display-name") as HTMLInputElement;
  const probeBtn = document.getElementById("freellmapi-custom-probe-btn") as HTMLButtonElement;
  const discoverBtn = document.getElementById("freellmapi-custom-discover-btn") as HTMLButtonElement;
  const modelsEl = document.getElementById("freellmapi-custom-models")!;
  const statusEl = document.getElementById("freellmapi-custom-status")!;
  customEndpointsEl = document.getElementById("freellmapi-custom-endpoints")!;
  void refreshCustomEndpoints(customEndpointsEl);

  const params = () => ({ baseUrl: baseUrlInput.value.trim(), apiKey: apiKeyInput.value.trim() || undefined });

  probeBtn.addEventListener("click", async () => {
    statusEl.textContent = "Testing…";
    probeBtn.disabled = true;
    discoverBtn.disabled = true;
    try {
      await window.agent.freellmapiProbeCustomProvider(params());
      statusEl.textContent = "Connection OK.";
    } catch (err) {
      // A probe failure is expected user-input feedback, not a panel-wide
      // error — surfaced next to the form, not in the shared error banner,
      // per this task's Review Focus item.
      statusEl.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      probeBtn.disabled = false;
      discoverBtn.disabled = false;
    }
  });

  discoverBtn.addEventListener("click", async () => {
    statusEl.textContent = "Discovering models…";
    probeBtn.disabled = true;
    discoverBtn.disabled = true;
    modelsEl.hidden = true;
    try {
      const { models } = await window.agent.freellmapiDiscoverModels(params());
      statusEl.textContent = `Found ${models.length} model(s).`;
      renderCustomModels(models, modelsEl, baseUrlInput, apiKeyInput, displayNameInput, statusEl, customEndpointsEl);
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      probeBtn.disabled = false;
      discoverBtn.disabled = false;
    }
  });
}

function renderCustomModels(
  models: Array<{ id: string }>,
  container: HTMLElement,
  baseUrlInput: HTMLInputElement,
  apiKeyInput: HTMLInputElement,
  displayNameInput: HTMLInputElement,
  statusEl: HTMLElement,
  endpointsEl: HTMLElement
): void {
  container.hidden = false;
  container.innerHTML = "";
  for (const model of models) {
    const row = document.createElement("div");
    row.className = "freellmapi-provider-row";
    const label = document.createElement("span");
    label.textContent = model.id;
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.textContent = "Add";
    addBtn.addEventListener("click", async () => {
      addBtn.disabled = true;
      try {
        await window.agent.freellmapiAddCustomProvider({
          baseUrl: baseUrlInput.value.trim(),
          apiKey: apiKeyInput.value.trim() || undefined,
          model: model.id,
          displayName: displayNameInput.value.trim() || undefined,
        });
        statusEl.textContent = `Added ${model.id}.`;
        await refreshProviders();
        await refreshCustomEndpoints(endpointsEl);
      } catch (err) {
        statusEl.textContent = err instanceof Error ? err.message : String(err);
        addBtn.disabled = false;
      }
    });
    row.appendChild(label);
    row.appendChild(addBtn);
    container.appendChild(row);
  }
}
