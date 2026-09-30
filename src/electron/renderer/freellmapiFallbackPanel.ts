// src/electron/renderer/freellmapiFallbackPanel.ts
// The Fallback page's native panel - second of FreeLLMAPI's vendored
// dashboard pages reimplemented (Keys, PR #35, was the first). Same
// .modal-card convention, same untested-DOM-wiring-by-convention posture
// (no Electron runtime in this sandbox) as freellmapiPanel.ts.
import type { RoutingSettings, RoutingStrategy, KeySelectionStrategy } from "../freellmapiFallbackApi.js";

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

  closeBtn.addEventListener("click", closeFreellmapiFallbackPanel);
  refreshBtn.addEventListener("click", () => void refreshRouting());
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

export function closeFreellmapiFallbackPanel(): void {
  panel.hidden = true;
}

export async function openFreellmapiFallbackPanel(): Promise<void> {
  panel.hidden = false;
  await refreshRouting();
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
