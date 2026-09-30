// src/electron/renderer/freellmapiFallbackPanel.ts
// The Fallback page's native panel - second of FreeLLMAPI's vendored
// dashboard pages reimplemented (Keys, PR #35, was the first). Same
// .modal-card convention, same untested-DOM-wiring-by-convention posture
// (no Electron runtime in this sandbox) as freellmapiPanel.ts.
import type { RoutingSettings, RoutingStrategy, KeySelectionStrategy, FallbackModelRow, SortPreset } from "../freellmapiFallbackApi.js";
import { openOverlayPanel, closeOverlayPanel } from "./overlayPanel.js";

let panel: HTMLElement;
let closeBtn: HTMLButtonElement;
let refreshBtn: HTMLButtonElement;
let errorEl: HTMLElement;
let loadingEl: HTMLElement;
let strategySelect: HTMLSelectElement;
let customWeightsRow: HTMLElement;
let weightReliability: HTMLInputElement;
let weightSpeed: HTMLInputElement;
let weightIntelligence: HTMLInputElement;
let exploreCheckbox: HTMLInputElement;
let keySelectionSelect: HTMLSelectElement;
let peakEnabledCheckbox: HTMLInputElement;
let peakStartInput: HTMLInputElement;
let peakEndInput: HTMLInputElement;
let peakTimezoneInput: HTMLInputElement;
let timezoneErrorEl: HTMLElement;
let cooldownUncappedCheckbox: HTMLInputElement;
let cooldownMinutesInput: HTMLInputElement;
let saveRoutingBtn: HTMLButtonElement;

let modelListEl: HTMLElement;
let saveModelsBtn: HTMLButtonElement;
let discardModelsBtn: HTMLButtonElement;
let unsavedHintEl: HTMLElement;
let sortIntelligenceBtn: HTMLButtonElement;
let sortSpeedBtn: HTMLButtonElement;
let sortBudgetBtn: HTMLButtonElement;

// The working copy the user edits locally - nothing hits the network until
// Save. A sort-preset click is the one exception (see wireModelList below):
// it writes immediately, matching the real server's own behavior, and this
// array is replaced wholesale with the result rather than merged.
let workingModels: FallbackModelRow[] = [];
let modelsDirty = false;

export function initFreellmapiFallbackPanel(): void {
  panel = document.getElementById("freellmapi-fallback-panel")!;
  closeBtn = document.getElementById("freellmapi-fallback-close-x") as HTMLButtonElement;
  refreshBtn = document.getElementById("freellmapi-fallback-refresh") as HTMLButtonElement;
  errorEl = document.getElementById("freellmapi-fallback-error")!;
  loadingEl = document.getElementById("freellmapi-fallback-loading")!;
  strategySelect = document.getElementById("freellmapi-fallback-strategy") as HTMLSelectElement;
  customWeightsRow = document.getElementById("freellmapi-fallback-custom-weights")!;
  weightReliability = document.getElementById("freellmapi-fallback-weight-reliability") as HTMLInputElement;
  weightSpeed = document.getElementById("freellmapi-fallback-weight-speed") as HTMLInputElement;
  weightIntelligence = document.getElementById("freellmapi-fallback-weight-intelligence") as HTMLInputElement;
  exploreCheckbox = document.getElementById("freellmapi-fallback-explore") as HTMLInputElement;
  keySelectionSelect = document.getElementById("freellmapi-fallback-key-selection") as HTMLSelectElement;
  peakEnabledCheckbox = document.getElementById("freellmapi-fallback-peak-enabled") as HTMLInputElement;
  peakStartInput = document.getElementById("freellmapi-fallback-peak-start") as HTMLInputElement;
  peakEndInput = document.getElementById("freellmapi-fallback-peak-end") as HTMLInputElement;
  peakTimezoneInput = document.getElementById("freellmapi-fallback-peak-timezone") as HTMLInputElement;
  timezoneErrorEl = document.getElementById("freellmapi-fallback-timezone-error")!;
  cooldownUncappedCheckbox = document.getElementById("freellmapi-fallback-cooldown-uncapped") as HTMLInputElement;
  cooldownMinutesInput = document.getElementById("freellmapi-fallback-cooldown-minutes") as HTMLInputElement;
  saveRoutingBtn = document.getElementById("freellmapi-fallback-save-routing") as HTMLButtonElement;
  modelListEl = document.getElementById("freellmapi-fallback-model-list")!;
  saveModelsBtn = document.getElementById("freellmapi-fallback-save-models") as HTMLButtonElement;
  discardModelsBtn = document.getElementById("freellmapi-fallback-discard-models") as HTMLButtonElement;
  unsavedHintEl = document.getElementById("freellmapi-fallback-unsaved-hint")!;
  sortIntelligenceBtn = document.getElementById("freellmapi-fallback-sort-intelligence") as HTMLButtonElement;
  sortSpeedBtn = document.getElementById("freellmapi-fallback-sort-speed") as HTMLButtonElement;
  sortBudgetBtn = document.getElementById("freellmapi-fallback-sort-budget") as HTMLButtonElement;
  wireModelList();

  closeBtn.addEventListener("click", closeFreellmapiFallbackPanel);
  refreshBtn.addEventListener("click", () => {
    if (modelsDirty && !confirm("You have unsaved model priority changes. Discard them?")) {
      return;
    }
    void refreshRouting();
    void refreshModels();
  });
  panel.addEventListener("click", (e) => {
    if (e.target === panel) closeFreellmapiFallbackPanel();
  });
  strategySelect.addEventListener("change", () => {
    customWeightsRow.hidden = strategySelect.value !== "custom";
  });
  // No cooldown cap and an explicit minute value are mutually exclusive
  // inputs for the same field (Review Focus: null vs. omitted must both be
  // expressible) - checking "No cap" disables the minutes input so the
  // request sends cooldownCeilingMs: null unambiguously, never a stale
  // leftover number.
  cooldownUncappedCheckbox.addEventListener("change", () => {
    cooldownMinutesInput.disabled = cooldownUncappedCheckbox.checked;
  });
  saveRoutingBtn.addEventListener("click", () => void saveRouting());
}

/** Returns true once the panel is actually closed (or was already closed) -
 * false means the user cancelled an unsaved-changes prompt, and callers must
 * not proceed to open their own panel or this panel stacks on top of theirs. */
export function closeFreellmapiFallbackPanel(): boolean {
  if (panel.hidden) return true;
  if (modelsDirty && !confirm("You have unsaved model priority changes. Discard them?")) {
    return false;
  }
  markDirty(false);
  closeOverlayPanel(panel);
  return true;
}

export async function openFreellmapiFallbackPanel(): Promise<void> {
  openOverlayPanel(panel);
  await refreshRouting();
  await refreshModels();
}

function populateForm(settings: RoutingSettings): void {
  strategySelect.value = settings.strategy;
  customWeightsRow.hidden = settings.strategy !== "custom";
  weightReliability.value = String(settings.customWeights.reliability);
  weightSpeed.value = String(settings.customWeights.speed);
  weightIntelligence.value = String(settings.customWeights.intelligence);
  exploreCheckbox.checked = settings.exploreEnabled;
  keySelectionSelect.value = settings.keySelectionStrategy;
  peakEnabledCheckbox.checked = settings.peakHoursAdjust;
  peakStartInput.value = String(settings.peakStartHour);
  peakEndInput.value = String(settings.peakEndHour);
  peakTimezoneInput.value = settings.peakTimezone;
  const uncapped = settings.cooldownCeilingMs === null;
  cooldownUncappedCheckbox.checked = uncapped;
  cooldownMinutesInput.disabled = uncapped;
  cooldownMinutesInput.value = uncapped ? "" : String(Math.round((settings.cooldownCeilingMs ?? 0) / 60000));
}

async function refreshRouting(): Promise<void> {
  errorEl.hidden = true;
  timezoneErrorEl.hidden = true;
  loadingEl.hidden = false;
  try {
    const settings = await window.agent.freellmapiFallbackGetRouting();
    populateForm(settings);
  } catch (err) {
    errorEl.hidden = false;
    errorEl.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    loadingEl.hidden = true;
  }
}

async function saveRouting(): Promise<void> {
  errorEl.hidden = true;
  timezoneErrorEl.hidden = true;
  saveRoutingBtn.disabled = true;
  const strategy = strategySelect.value as RoutingStrategy;
  try {
    await window.agent.freellmapiFallbackUpdateRouting({
      strategy,
      // Only sent under 'custom' - sending a stale weight vector under any
      // other strategy would be meaningless (the server ignores it there),
      // and omitting it entirely when not custom avoids ever asserting a
      // vector the user didn't actually set (Review Focus item 1).
      ...(strategy === "custom"
        ? { weights: { reliability: Number(weightReliability.value), speed: Number(weightSpeed.value), intelligence: Number(weightIntelligence.value) } }
        : {}),
      exploreEnabled: exploreCheckbox.checked,
      keySelectionStrategy: keySelectionSelect.value as KeySelectionStrategy,
      peakHoursAdjust: peakEnabledCheckbox.checked,
      peakStartHour: Number(peakStartInput.value),
      peakEndHour: Number(peakEndInput.value),
      peakTimezone: peakTimezoneInput.value.trim(),
      cooldownCeilingMs: cooldownUncappedCheckbox.checked ? null : Number(cooldownMinutesInput.value) * 60000,
    });
    await refreshRouting();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The real server's peak-hours validation error names the timezone
    // specifically - surfaced next to that field, not just the shared
    // error area, per Review Focus item 3.
    if (message.toLowerCase().includes("timezone")) {
      timezoneErrorEl.hidden = false;
      timezoneErrorEl.textContent = message;
    } else {
      errorEl.hidden = false;
      errorEl.textContent = message;
    }
  } finally {
    saveRoutingBtn.disabled = false;
  }
}

function wireModelList(): void {
  saveModelsBtn.addEventListener("click", () => void saveModels());
  discardModelsBtn.addEventListener("click", () => void refreshModels());
  const doSort = (preset: SortPreset) => async () => {
    // Fires immediately, discarding any in-progress manual reorder - the
    // real server's own presets write directly, they are not a preview
    // (Review Focus item 2). markDirty(false) first so the confirm-on-close
    // guard doesn't fire for a reorder that's already been superseded.
    if (modelsDirty) {
      const proceed = confirm("This will discard your unsaved manual reordering and sort by " + preset + ". Continue?");
      if (!proceed) return;
    }
    try {
      await window.agent.freellmapiFallbackSortModels(preset);
      await refreshModels();
    } catch (err) {
      errorEl.hidden = false;
      errorEl.textContent = err instanceof Error ? err.message : String(err);
    }
  };
  sortIntelligenceBtn.addEventListener("click", doSort("intelligence"));
  sortSpeedBtn.addEventListener("click", doSort("speed"));
  sortBudgetBtn.addEventListener("click", doSort("budget"));
}

async function refreshModels(): Promise<void> {
  try {
    workingModels = await window.agent.freellmapiFallbackGetModels();
    markDirty(false);
    renderModelList();
  } catch (err) {
    errorEl.hidden = false;
    errorEl.textContent = err instanceof Error ? err.message : String(err);
  }
}

function markDirty(dirty: boolean): void {
  modelsDirty = dirty;
  saveModelsBtn.disabled = !dirty;
  discardModelsBtn.disabled = !dirty;
  unsavedHintEl.hidden = !dirty;
}

function renderModelList(): void {
  modelListEl.innerHTML = "";
  // Only models with a configured key are actually routable - the vendored
  // page filters the same way (FallbackPage.tsx). workingModels itself stays
  // unfiltered so saveModels' full-replace PUT still includes every row.
  const sorted = workingModels.filter((m) => m.keyCount > 0).sort((a, b) => a.priority - b.priority);
  sorted.forEach((model, index) => {
    const row = document.createElement("div");
    row.className = "freellmapi-provider-row";

    const priorityBadge = document.createElement("span");
    priorityBadge.className = "freellmapi-model-priority";
    priorityBadge.textContent = String(index + 1);
    row.appendChild(priorityBadge);

    const name = document.createElement("span");
    name.className = "freellmapi-provider-name";
    name.textContent = `${model.displayName} (${model.platform})`;
    row.appendChild(name);

    const controls = document.createElement("div");
    controls.className = "freellmapi-provider-controls";

    const enabledCheckbox = document.createElement("input");
    enabledCheckbox.type = "checkbox";
    enabledCheckbox.checked = model.enabled;
    enabledCheckbox.addEventListener("change", () => {
      model.enabled = enabledCheckbox.checked;
      markDirty(true);
    });
    controls.appendChild(enabledCheckbox);

    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.textContent = "↑";
    upBtn.disabled = index === 0;
    upBtn.addEventListener("click", () => {
      swapPriority(sorted, index, index - 1);
      markDirty(true);
      renderModelList();
    });
    controls.appendChild(upBtn);

    const downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.textContent = "↓";
    downBtn.disabled = index === sorted.length - 1;
    downBtn.addEventListener("click", () => {
      swapPriority(sorted, index, index + 1);
      markDirty(true);
      renderModelList();
    });
    controls.appendChild(downBtn);

    row.appendChild(controls);
    modelListEl.appendChild(row);
  });
}

/** Swaps two rows' priority values in place (on the real model objects
 * workingModels holds, not the sorted copy alone) so the next render sorts
 * them into their new order. */
function swapPriority(sorted: FallbackModelRow[], a: number, b: number): void {
  const temp = sorted[a]!.priority;
  sorted[a]!.priority = sorted[b]!.priority;
  sorted[b]!.priority = temp;
}

async function saveModels(): Promise<void> {
  saveModelsBtn.disabled = true;
  try {
    await window.agent.freellmapiFallbackUpdateModels(
      workingModels.map((m) => ({ modelDbId: m.modelDbId, priority: m.priority, enabled: m.enabled }))
    );
    await refreshModels();
  } catch (err) {
    errorEl.hidden = false;
    errorEl.textContent = err instanceof Error ? err.message : String(err);
    saveModelsBtn.disabled = false;
  }
}
