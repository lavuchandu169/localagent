import type { AgentEvent, ChatMessage, PermissionMode, ToolCall } from "../../types.js";
import type { ProviderConfig, SessionConfig } from "../sessionRegistry.js";
import { MODE_LABELS } from "../modeLabels.js";
import { EMBEDDED_MODELS, DEFAULT_EMBEDDED_MODEL, describeEmbeddedModel, type EmbeddedModelId, type ModelCategory } from "../../models.js";

interface HardwareInfo {
  totalRamBytes: number;
  gpu: string | false;
  vramBytes: number;
  recommended: string;
}

interface DownloadProgress {
  totalSize: number;
  downloadedSize: number;
}

interface AuthIdentity {
  email: string;
  name: string;
  pictureUrl: string | null;
}
type SignInResult = AuthIdentity | { error: string };
type AuthStatus = { signedIn: false } | ({ signedIn: true } & AuthIdentity);

interface SessionIndexEntry {
  id: string;
  title: string;
  updatedAt: number;
  ownerEmail: string | null;
}

interface SessionRecord {
  id: string;
  title: string;
  messages: ChatMessage[];
  events: AgentEvent[];
  createdAt: number;
  updatedAt: number;
  ownerEmail: string | null;
}

interface ResumePayload {
  sessionId: string;
  initialMessages: ChatMessage[];
  priorEvents: AgentEvent[];
  title: string;
  createdAt: number;
  ownerEmail: string | null;
}

/** The live, in-memory shape of an active session — see getLiveSessionSnapshot in sessionRegistry.ts. Unlike SessionRecord, this is available even for a session that hasn't run a task (and so hasn't hit disk) yet. */
interface LiveSessionSnapshot {
  messages: ChatMessage[];
  events: AgentEvent[];
  title: string;
  createdAt: number;
  ownerEmail: string | null;
}

interface AgentBridge {
  startSession(config: SessionConfig, resume?: ResumePayload): Promise<{ sessionId: string; workspaceRoot: string }>;
  runTask(sessionId: string, task: string): Promise<void>;
  respondPermission(sessionId: string, callId: string, approved: boolean): Promise<void>;
  cancelSession(sessionId: string): Promise<void>;
  pickWorkspace(): Promise<string | null>;
  onEvent(callback: (sessionId: string, event: AgentEvent) => void): () => void;
  onDownloadProgress(callback: (status: DownloadProgress) => void): () => void;
  listCachedModels(): Promise<Record<string, boolean>>;
  deleteCachedModel(id: string): Promise<boolean>;
  cancelDownload(): Promise<void>;
  getHardwareInfo(): Promise<HardwareInfo>;
  googleSignIn(): Promise<SignInResult>;
  signOut(): Promise<void>;
  getAuthStatus(): Promise<AuthStatus>;
  listSessions(): Promise<SessionIndexEntry[]>;
  searchSessions(query: string): Promise<SessionIndexEntry[]>;
  loadSession(id: string): Promise<SessionRecord | null>;
  getLiveSession(id: string): Promise<LiveSessionSnapshot | null>;
  updateSessionSettings(id: string, updates: { workspaceRoot?: string; mode?: PermissionMode }): Promise<boolean>;
  deleteSession(id: string): Promise<void>;
  onSessionsChanged(callback: () => void): () => void;
  onCloudSyncScopeWarning(callback: () => void): () => void;
  getGoogleSettings(): Promise<{ clientId: string; hasSecret: boolean; envOverride: boolean }>;
  saveGoogleSettings(settings: { clientId: string; clientSecret?: string }): Promise<void>;
  getAnthropicSettings(): Promise<{ hasKey: boolean; envOverride: boolean }>;
  saveAnthropicSettings(settings: { apiKey?: string }): Promise<void>;
}

declare global {
  interface Window {
    agent: AgentBridge;
  }
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

/**
 * Disables `button` and swaps its label to `busyText` while `fn` runs,
 * always restoring the original label and re-enabling it afterward —
 * regardless of outcome. The button-level equivalent of a spinner, for
 * actions (sign-in, sign-out) that otherwise give no visible sign
 * anything is happening beyond a plain disabled state, which reads as
 * unresponsive rather than "working."  Not used for start-session, whose
 * disabled state deliberately does NOT reset on success (the setup
 * controls stay locked once a session is running) — that one keeps its
 * own inline handling instead of this always-restore helper.
 */
async function withBusyLabel<T>(button: HTMLButtonElement, busyText: string, fn: () => Promise<T>): Promise<T> {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

const workspacePathEl = byId<HTMLSpanElement>("workspace-path");
const chooseWorkspaceBtn = byId<HTMLButtonElement>("choose-workspace");
const advancedDisclosure = byId<HTMLDetailsElement>("advanced-disclosure");
const advancedProviderExternal = byId<HTMLInputElement>("advanced-provider-external");
const advancedProviderAnthropic = byId<HTMLInputElement>("advanced-provider-anthropic");
const externalFields = byId<HTMLDivElement>("external-fields");
const anthropicFields = byId<HTMLDivElement>("anthropic-fields");
const baseUrlInput = byId<HTMLInputElement>("base-url");
const externalModelInput = byId<HTMLInputElement>("external-model");
const embeddedSizeSelect = byId<HTMLSelectElement>("embedded-size");
const modeSelect = byId<HTMLSelectElement>("mode");
const modeDescription = byId<HTMLSpanElement>("mode-description");
const startSessionBtn = byId<HTMLButtonElement>("start-session");
const startError = byId<HTMLDivElement>("start-error");
const taskInput = byId<HTMLTextAreaElement>("task-input");
const runTaskBtn = byId<HTMLButtonElement>("run-task");
const eventLog = byId<HTMLDivElement>("event-log");
const emptyState = byId<HTMLDivElement>("empty-state");
const aboutToggle = byId<HTMLButtonElement>("about-toggle");
const aboutPanel = byId<HTMLDivElement>("about-panel");
const aboutClose = byId<HTMLButtonElement>("about-close");
const aboutWorkspace = byId<HTMLSpanElement>("about-workspace");
const aboutHardware = byId<HTMLSpanElement>("about-hardware");
const settingsToggle = byId<HTMLButtonElement>("settings-toggle");
const settingsPanel = byId<HTMLDivElement>("settings-panel");
const settingsClose = byId<HTMLButtonElement>("settings-close");
const settingsClientIdInput = byId<HTMLInputElement>("settings-client-id");
const settingsClientSecretInput = byId<HTMLInputElement>("settings-client-secret");
const settingsEnvOverrideNotice = byId<HTMLDivElement>("settings-env-override");
const settingsError = byId<HTMLDivElement>("settings-error");
const settingsSaved = byId<HTMLDivElement>("settings-saved");
const settingsSaveBtn = byId<HTMLButtonElement>("settings-save");
const anthropicApiKeyInput = byId<HTMLInputElement>("anthropic-api-key");
const anthropicEnvOverrideNotice = byId<HTMLDivElement>("anthropic-env-override");
const anthropicSettingsError = byId<HTMLDivElement>("anthropic-settings-error");
const anthropicSettingsSaved = byId<HTMLDivElement>("anthropic-settings-saved");
const anthropicSettingsSaveBtn = byId<HTMLButtonElement>("anthropic-settings-save");
const googleSignInBtn = byId<HTMLButtonElement>("google-sign-in");
const signOutBtn = byId<HTMLButtonElement>("sign-out-btn");
const authSignedOut = byId<HTMLDivElement>("auth-signed-out");
const authSignedIn = byId<HTMLDivElement>("auth-signed-in");
const authAvatar = byId<HTMLSpanElement>("auth-avatar");
const authName = byId<HTMLSpanElement>("auth-name");
const authError = byId<HTMLDivElement>("auth-error");
const downloadProgressRow = byId<HTMLDivElement>("download-progress");
const downloadBarFill = byId<HTMLDivElement>("download-bar-fill");
const downloadLabel = byId<HTMLSpanElement>("download-label");
const cancelDownloadBtn = byId<HTMLButtonElement>("cancel-download");
const activeModelBadge = byId<HTMLDivElement>("active-model-badge");
const editSettingsBtn = byId<HTMLButtonElement>("edit-settings");
const downloadedModelsList = byId<HTMLUListElement>("downloaded-models-list");
const downloadedModelsEmpty = byId<HTMLDivElement>("downloaded-models-empty");
const sidebarSessionList = byId<HTMLDivElement>("session-list");
const sessionListEmpty = byId<HTMLDivElement>("session-list-empty");
const sessionSearchInput = byId<HTMLInputElement>("session-search");
const newSessionBtn = byId<HTMLButtonElement>("new-session-btn");

let workspaceRoot: string | null = null;
let sessionId: string | null = null;
let hardwareInfo: HardwareInfo | null = null;
/** True while the setup controls are unlocked for editing an already-active session's workspace/model/mode — see editSettingsBtn/applySessionEdits. */
let editingSession = false;
const toolCards = new Map<string, HTMLElement>();

/** The workspace/provider/mode controls that lock once a session starts — shared by beginSession's success path, resetToSetup, and the edit-settings toggle so the same list isn't repeated three times. */
function setSetupControlsDisabled(disabled: boolean): void {
  chooseWorkspaceBtn.disabled = disabled;
  embeddedSizeSelect.disabled = disabled;
  modeSelect.disabled = disabled;
  baseUrlInput.disabled = disabled;
  externalModelInput.disabled = disabled;
  advancedProviderExternal.disabled = disabled;
  advancedProviderAnthropic.disabled = disabled;
}

const EMBEDDED_CATEGORY_LABELS: Record<ModelCategory, string> = { coding: "Coding", chat: "Chat" };
for (const category of Object.keys(EMBEDDED_CATEGORY_LABELS) as ModelCategory[]) {
  const group = document.createElement("optgroup");
  group.label = EMBEDDED_CATEGORY_LABELS[category];
  for (const id of Object.keys(EMBEDDED_MODELS) as EmbeddedModelId[]) {
    const info = EMBEDDED_MODELS[id];
    if (info.category !== category) continue;
    const option = document.createElement("option");
    option.value = id;
    option.textContent = `${info.name} — ${info.sizeNote}`;
    if (id === DEFAULT_EMBEDDED_MODEL) option.selected = true;
    group.appendChild(option);
  }
  embeddedSizeSelect.appendChild(group);
}

for (const mode of Object.keys(MODE_LABELS) as PermissionMode[]) {
  const option = document.createElement("option");
  option.value = mode;
  option.textContent = MODE_LABELS[mode].label;
  if (mode === "DEFAULT") option.selected = true;
  modeSelect.appendChild(option);
}
function updateModeDescription() {
  modeDescription.textContent = MODE_LABELS[modeSelect.value as PermissionMode].description;
}
modeSelect.addEventListener("change", updateModeDescription);
updateModeDescription();

function updateAdvancedProviderFields() {
  const useAnthropic = advancedProviderAnthropic.checked;
  externalFields.hidden = useAnthropic;
  anthropicFields.hidden = !useAnthropic;
}
advancedProviderExternal.addEventListener("change", updateAdvancedProviderFields);
advancedProviderAnthropic.addEventListener("change", updateAdvancedProviderFields);
updateAdvancedProviderFields();

/**
 * Rebuilds every model option's label from scratch (base name + size note,
 * then "recommended"/"downloaded" suffixes) rather than appending onto
 * whatever text is already there — so this is safe to call again after a
 * model is deleted or a download finishes, not just once at startup.
 */
function refreshEmbeddedModelLabels(cached: Record<string, boolean>): void {
  for (const option of Array.from(embeddedSizeSelect.options)) {
    const info = EMBEDDED_MODELS[option.value as EmbeddedModelId];
    if (!info) continue;
    const suffixes: string[] = [];
    if (hardwareInfo && option.value === hardwareInfo.recommended) suffixes.push("recommended for this machine");
    if (cached[option.value]) suffixes.push("downloaded");
    option.textContent = suffixes.length > 0 ? `${info.name} — ${info.sizeNote} · ${suffixes.join(", ")}` : `${info.name} — ${info.sizeNote}`;
  }
}

/** Populates the Settings panel's "Downloaded models" list — only models actually on disk, each with a Delete button. Re-fetches listCachedModels() fresh rather than trusting stale state, since this can be called after a delete or after a download completes elsewhere in the app. */
async function refreshDownloadedModelsList(): Promise<void> {
  const cached = await window.agent.listCachedModels();
  refreshEmbeddedModelLabels(cached);

  downloadedModelsList.innerHTML = "";
  const cachedIds = (Object.keys(cached) as EmbeddedModelId[]).filter((id) => cached[id]);
  downloadedModelsEmpty.hidden = cachedIds.length > 0;

  for (const id of cachedIds) {
    const info = EMBEDDED_MODELS[id];
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${info.name} — ${info.sizeNote}`;
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => {
      void withBusyLabel(deleteBtn, "Deleting…", async () => {
        await window.agent.deleteCachedModel(id);
        await refreshDownloadedModelsList();
      });
    });
    item.appendChild(label);
    item.appendChild(deleteBtn);
    downloadedModelsList.appendChild(item);
  }
}

Promise.all([window.agent.listCachedModels(), window.agent.getHardwareInfo()]).then(([cached, hw]) => {
  hardwareInfo = hw;
  const ramGb = (hw.totalRamBytes / 1024 ** 3).toFixed(0);
  aboutHardware.textContent = hw.gpu ? `${ramGb}GB RAM · ${hw.gpu} GPU` : `${ramGb}GB RAM · CPU only`;
  // Informational only — shows what fits the machine without changing the user's selection.
  refreshEmbeddedModelLabels(cached);
});

aboutToggle.addEventListener("click", () => {
  const opening = aboutPanel.hidden;
  aboutPanel.hidden = !opening;
  aboutToggle.setAttribute("aria-expanded", String(opening));
});
aboutClose.addEventListener("click", () => {
  aboutPanel.hidden = true;
  aboutToggle.setAttribute("aria-expanded", "false");
});

// Tracks whether the user actually typed into the secret field this time
// it was open — saving must NOT overwrite a previously-saved secret just
// because the field displays its masked placeholder unchanged.
let settingsSecretTouched = false;
settingsClientSecretInput.addEventListener("input", () => {
  settingsSecretTouched = true;
});

// Same touched-tracking contract as settingsSecretTouched above, for the
// separate Anthropic API key field/form.
let anthropicApiKeyTouched = false;
anthropicApiKeyInput.addEventListener("input", () => {
  anthropicApiKeyTouched = true;
});

async function openSettingsPanel(): Promise<void> {
  settingsError.textContent = "";
  settingsSaved.hidden = true;
  settingsSecretTouched = false;
  const current = await window.agent.getGoogleSettings();
  settingsClientIdInput.value = current.clientId;
  settingsClientSecretInput.value = "";
  settingsClientSecretInput.placeholder = current.hasSecret ? "•••• saved" : "";
  settingsEnvOverrideNotice.hidden = !current.envOverride;

  anthropicSettingsError.textContent = "";
  anthropicSettingsSaved.hidden = true;
  anthropicApiKeyTouched = false;
  const currentAnthropic = await window.agent.getAnthropicSettings();
  anthropicApiKeyInput.value = "";
  anthropicApiKeyInput.placeholder = currentAnthropic.hasKey ? "•••• saved" : "";
  anthropicEnvOverrideNotice.hidden = !currentAnthropic.envOverride;

  await refreshDownloadedModelsList();
}

settingsToggle.addEventListener("click", async () => {
  const opening = settingsPanel.hidden;
  if (opening) await openSettingsPanel();
  settingsPanel.hidden = !opening;
  settingsToggle.setAttribute("aria-expanded", String(opening));
});

settingsClose.addEventListener("click", () => {
  settingsPanel.hidden = true;
  settingsToggle.setAttribute("aria-expanded", "false");
});

settingsSaveBtn.addEventListener("click", () => {
  settingsError.textContent = "";
  settingsSaved.hidden = true;
  void withBusyLabel(settingsSaveBtn, "Saving…", async () => {
    try {
      const secretValueSent = settingsSecretTouched ? settingsClientSecretInput.value.trim() : undefined;
      await window.agent.saveGoogleSettings({
        clientId: settingsClientIdInput.value.trim(),
        clientSecret: secretValueSent,
      });
      settingsSecretTouched = false;
      if (secretValueSent !== undefined) {
        // A secret was actually sent this save — clear the plaintext out of the
        // DOM and reflect what's now stored (a real secret, or none if the user
        // cleared the field), matching openSettingsPanel's own placeholder logic.
        settingsClientSecretInput.value = "";
        settingsClientSecretInput.placeholder = secretValueSent ? "•••• saved" : "";
      }
      settingsSaved.hidden = false;
    } catch (err) {
      settingsError.textContent = err instanceof Error ? err.message : String(err);
    }
  });
});

anthropicSettingsSaveBtn.addEventListener("click", () => {
  anthropicSettingsError.textContent = "";
  anthropicSettingsSaved.hidden = true;
  void withBusyLabel(anthropicSettingsSaveBtn, "Saving…", async () => {
    try {
      const keyValueSent = anthropicApiKeyTouched ? anthropicApiKeyInput.value.trim() : undefined;
      await window.agent.saveAnthropicSettings({ apiKey: keyValueSent });
      anthropicApiKeyTouched = false;
      if (keyValueSent !== undefined) {
        anthropicApiKeyInput.value = "";
        anthropicApiKeyInput.placeholder = keyValueSent ? "•••• saved" : "";
      }
      anthropicSettingsSaved.hidden = false;
    } catch (err) {
      anthropicSettingsError.textContent = err instanceof Error ? err.message : String(err);
    }
  });
});

chooseWorkspaceBtn.addEventListener("click", async () => {
  const picked = await window.agent.pickWorkspace();
  if (picked) {
    workspaceRoot = picked;
    workspacePathEl.textContent = picked;
    aboutWorkspace.textContent = picked;
  }
});

function logLine(text: string, className: string): void {
  emptyState.hidden = true;
  const line = document.createElement("div");
  line.className = className;
  line.textContent = text;
  eventLog.appendChild(line);
  eventLog.scrollTop = eventLog.scrollHeight;
}

function toolCard(call: ToolCall): HTMLElement {
  emptyState.hidden = true;
  const card = document.createElement("div");
  card.className = "tool-card pending";
  const header = document.createElement("div");
  header.className = "tool-card-header";
  const dot = document.createElement("span");
  dot.className = "pulse-dot";
  header.appendChild(dot);
  header.appendChild(document.createTextNode(`${call.name}(${JSON.stringify(call.arguments)})`));
  card.appendChild(header);
  eventLog.appendChild(card);
  eventLog.scrollTop = eventLog.scrollHeight;
  toolCards.set(call.id, card);
  return card;
}

function renderEvent(event: AgentEvent): void {
  switch (event.type) {
    case "status":
      logLine(event.message, "log-status");
      break;
    case "tool.start":
      toolCard(event.call);
      break;
    case "tool.result": {
      const card = toolCards.get(event.call.id) ?? toolCard(event.call);
      card.classList.remove("pending");
      card.classList.add(event.result.ok ? "resolved-ok" : "resolved-error");
      const result = document.createElement("div");
      result.className = event.result.ok ? "tool-card-ok" : "tool-card-error";
      result.textContent = event.result.ok ? "ok" : `error: ${event.result.error ?? "unknown"}`;
      card.appendChild(result);
      break;
    }
    case "permission.request": {
      if (event.decision !== "ASK") {
        logLine(`[permission] ${event.call.name} -> ${event.decision}`, "log-status");
        break;
      }
      const card = toolCards.get(event.call.id) ?? toolCard(event.call);
      const prompt = document.createElement("div");
      prompt.className = "permission-prompt";
      const approve = document.createElement("button");
      approve.className = "approve-btn";
      approve.textContent = "Approve";
      const deny = document.createElement("button");
      deny.className = "deny-btn";
      deny.textContent = "Deny";
      const respond = (approved: boolean) => {
        approve.disabled = true;
        deny.disabled = true;
        prompt.classList.add("permission-resolved");
        if (sessionId) void window.agent.respondPermission(sessionId, event.call.id, approved);
      };
      approve.addEventListener("click", () => respond(true));
      deny.addEventListener("click", () => respond(false));
      prompt.appendChild(approve);
      prompt.appendChild(deny);
      card.appendChild(prompt);
      break;
    }
    case "text":
      logLine(event.text, "log-text");
      break;
    case "error":
      logLine(`✗ ${event.message}`, "log-error");
      break;
    case "done":
      logLine(event.success ? `✔ done — ${event.summary}` : `✗ failed — ${event.summary}`, event.success ? "log-done" : "log-error");
      runTaskBtn.disabled = false;
      break;
  }
}

window.agent.onEvent((incomingSessionId, event) => {
  if (incomingSessionId !== sessionId) return;
  renderEvent(event);
});

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)}MB`;
}

let progressLastTime = 0;
let progressLastBytes = 0;

window.agent.onDownloadProgress((status) => {
  downloadProgressRow.hidden = false;
  const pct = status.totalSize > 0 ? (status.downloadedSize / status.totalSize) * 100 : 0;
  downloadBarFill.style.width = `${pct.toFixed(1)}%`;

  const now = Date.now();
  let speedText = "";
  if (progressLastTime > 0) {
    const elapsedSec = (now - progressLastTime) / 1000;
    const bytesSince = status.downloadedSize - progressLastBytes;
    if (elapsedSec > 0.15 && bytesSince >= 0) {
      const bytesPerSec = bytesSince / elapsedSec;
      speedText = ` — ${formatBytes(bytesPerSec)}/s`;
    }
  }
  if (Date.now() - progressLastTime > 400) {
    progressLastTime = now;
    progressLastBytes = status.downloadedSize;
  }

  downloadLabel.textContent = `Downloading model: ${formatBytes(status.downloadedSize)} / ${formatBytes(status.totalSize)}${speedText}`;
});

/** Reads the provider config the form controls currently describe — shared by beginSession and applySessionEdits, which needs it BEFORE deciding whether beginSession's tear-down-and-rebuild path is even safe to take. */
function deriveProviderConfigFromForm(): ProviderConfig {
  const useAnthropic = advancedDisclosure.open && advancedProviderAnthropic.checked;
  const useExternal = advancedDisclosure.open && advancedProviderExternal.checked && baseUrlInput.value.trim().length > 0;
  return useAnthropic
    ? { kind: "anthropic" }
    : useExternal
      ? { kind: "openai-compatible", baseUrl: baseUrlInput.value.trim(), model: externalModelInput.value.trim() }
      : { kind: "embedded", size: embeddedSizeSelect.value };
}

/** The provider config the currently-active session actually started with — set whenever beginSession succeeds, compared against in applySessionEdits to decide whether a settings edit is safe to apply in place. */
let activeProviderConfig: ProviderConfig | null = null;

async function beginSession(resume?: ResumePayload): Promise<void> {
  startError.textContent = "";

  const provider = deriveProviderConfigFromForm();

  // workspaceRoot omitted entirely when none was picked — startSession defaults
  // it to the home directory and hands back whichever path it actually used.
  const config: SessionConfig = { ...(workspaceRoot ? { workspaceRoot } : {}), provider, mode: modeSelect.value as PermissionMode };

  startSessionBtn.disabled = true;
  startSessionBtn.textContent = "Starting…";
  try {
    const result = await window.agent.startSession(config, resume);
    sessionId = result.sessionId;
    if (!workspaceRoot) {
      workspaceRoot = result.workspaceRoot;
      workspacePathEl.textContent = `${result.workspaceRoot} (default — no folder chosen)`;
      aboutWorkspace.textContent = result.workspaceRoot;
    }
    taskInput.disabled = false;
    runTaskBtn.disabled = false;
    logLine(
      resume ? `Resumed session (${provider.kind}, mode=${config.mode})` : `Session started (${provider.kind}, mode=${config.mode})`,
      "log-status"
    );
    // All setup controls lock here, not just Start — see setSetupControlsDisabled.
    setSetupControlsDisabled(true);
    editingSession = false;
    editSettingsBtn.textContent = "Edit settings…";
    editSettingsBtn.hidden = false;
    activeProviderConfig = provider;

    const modelText =
      provider.kind === "embedded"
        ? (provider.size in EMBEDDED_MODELS ? describeEmbeddedModel(provider.size as EmbeddedModelId) : provider.size)
        : provider.kind === "anthropic"
          ? "Claude Sonnet 5 (Anthropic API)"
          : `${provider.model} (${provider.baseUrl})`;
    const gpuText = provider.kind === "embedded" && hardwareInfo?.gpu ? ` · ${hardwareInfo.gpu} GPU` : "";
    activeModelBadge.innerHTML = "";
    const dot = document.createElement("span");
    dot.className = "signal-dot";
    activeModelBadge.appendChild(dot);
    activeModelBadge.appendChild(document.createTextNode(`${modelText}${gpuText}`));
    activeModelBadge.hidden = false;
    await refreshSessionList(sessionSearchInput.value.trim());
  } catch (err: any) {
    // A cancelled download surfaces here as a rejected startSession() call —
    // main.ts's agent:start-session handler already turns that specific
    // case into the plain "Download cancelled." message before it ever
    // reaches the renderer, so this can just show whatever it received.
    startError.textContent = err?.message ?? String(err);
    startSessionBtn.disabled = false;
    startSessionBtn.textContent = "Start session";
    // A failed edit-apply already cancelled the live session before getting
    // here (see applySessionEdits) — there's nothing left to edit, so this
    // falls back to a normal "start fresh" state rather than staying in
    // edit mode pointed at a session that no longer exists.
    editingSession = false;
    editSettingsBtn.hidden = true;
  } finally {
    downloadProgressRow.hidden = true;
    progressLastTime = 0;
  }
}

startSessionBtn.addEventListener("click", () => {
  if (editingSession) void applySessionEdits();
  else void beginSession();
});

cancelDownloadBtn.addEventListener("click", () => {
  void window.agent.cancelDownload();
});

function providerConfigsEqual(a: ProviderConfig, b: ProviderConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Applies edited settings to the currently active session. Two cases:
 *
 * 1. Workspace and/or mode only, provider/model unchanged: updated in
 *    place via agent:update-session-settings — the provider is never
 *    touched, so this is instant and carries zero risk.
 * 2. Provider/model changed (including switching between two embedded
 *    models): reads the live session (not loadSession's disk record — a
 *    session with no completed task yet has never been persisted, so
 *    that would silently no-op here), cancels it, then re-runs
 *    beginSession() as a resume, exactly like resumeSession() does when
 *    reopening a session from the sidebar.
 *
 * Switching embedded models here used to be refused outright: starting a
 * second embedded model load shortly after disposing the first crashed
 * the whole Electron process with an uncaught native exception inside
 * llama-addon.node. Root cause was EmbeddedLlamaProvider.dispose() never
 * disposing the Llama instance itself (a distinct native backend object
 * getLlama() returns, separate from and outliving the model/context built
 * on it) — only the model and context were freed, leaking the backend
 * every time. Fixed in embeddedLlama.ts; verified with the exact
 * cancel-then-resume-under-the-same-id sequence this function performs,
 * alternating models, no crash.
 */
async function applySessionEdits(): Promise<void> {
  if (!sessionId || !activeProviderConfig) return;
  const idBeingEdited = sessionId;
  const newProvider = deriveProviderConfigFromForm();
  const newMode = modeSelect.value as PermissionMode;
  startError.textContent = "";

  if (providerConfigsEqual(newProvider, activeProviderConfig)) {
    startSessionBtn.disabled = true;
    startSessionBtn.textContent = "Applying…";
    const ok = await window.agent.updateSessionSettings(idBeingEdited, { workspaceRoot: workspaceRoot ?? undefined, mode: newMode });
    editingSession = false;
    if (!ok) {
      startError.textContent = "Couldn't apply changes — the session may have already ended.";
      startSessionBtn.disabled = false;
      startSessionBtn.textContent = "Edit settings…";
      return;
    }
    logLine(`Settings updated (mode=${newMode})`, "log-status");
    setSetupControlsDisabled(true);
    startSessionBtn.disabled = true;
    startSessionBtn.textContent = "Starting…"; // matches beginSession's own (pre-existing, unchanged) post-success label
    editSettingsBtn.textContent = "Edit settings…";
    return;
  }

  try {
    const snapshot = await window.agent.getLiveSession(idBeingEdited);
    if (!snapshot) {
      startError.textContent = "Couldn't read the current session to apply changes.";
      return;
    }
    await window.agent.cancelSession(idBeingEdited);
    sessionId = null;
    taskInput.disabled = true;
    runTaskBtn.disabled = true;
    await beginSession({
      sessionId: idBeingEdited,
      initialMessages: snapshot.messages,
      priorEvents: snapshot.events,
      title: snapshot.title,
      createdAt: snapshot.createdAt,
      ownerEmail: snapshot.ownerEmail,
    });
  } finally {
    editingSession = false;
  }
}

editSettingsBtn.addEventListener("click", () => {
  editingSession = !editingSession;
  setSetupControlsDisabled(!editingSession);
  startSessionBtn.disabled = !editingSession;
  startSessionBtn.textContent = editingSession ? "Apply changes" : "Start session";
  editSettingsBtn.textContent = editingSession ? "Cancel edit" : "Edit settings…";
});

function clearEventLog(): void {
  toolCards.clear();
  eventLog.innerHTML = "";
  emptyState.hidden = false;
  eventLog.appendChild(emptyState);
}

function resetToSetup(): void {
  if (sessionId) void window.agent.cancelSession(sessionId);
  sessionId = null;
  workspaceRoot = null;
  activeProviderConfig = null;
  clearEventLog();
  taskInput.value = "";
  taskInput.disabled = true;
  runTaskBtn.disabled = true;
  activeModelBadge.hidden = true;
  editingSession = false;
  editSettingsBtn.hidden = true;
  editSettingsBtn.textContent = "Edit settings…";
  startError.textContent = "";
  workspacePathEl.textContent = "No workspace selected — optional, you can just chat";
  aboutWorkspace.textContent = "(none selected)";
  setSetupControlsDisabled(false);
  startSessionBtn.disabled = false;
  startSessionBtn.textContent = "Start session";
  void refreshSessionList(sessionSearchInput.value.trim());
}

newSessionBtn.addEventListener("click", resetToSetup);

// `triggerEl` is the specific sidebar item that was clicked — previously
// clicking it gave no feedback at all until the resume finished. It's
// optional because resumeSession has no clickable trigger the very first
// time a session is opened programmatically (there isn't one today, but
// keeping this an optional param rather than required avoids assuming
// every future caller has a button to point at).
async function resumeSession(id: string, triggerEl?: HTMLButtonElement): Promise<void> {
  const originalLabel = triggerEl?.textContent ?? null;
  if (triggerEl) {
    triggerEl.disabled = true;
    triggerEl.textContent = "Resuming…";
  }
  try {
    const record = await window.agent.loadSession(id);
    if (!record) {
      startError.textContent = "Couldn't load this session — the saved file looks corrupted.";
      return;
    }

    if (sessionId) {
      await window.agent.cancelSession(sessionId);
    }
    sessionId = null;
    taskInput.disabled = true;
    runTaskBtn.disabled = true;

    clearEventLog();
    for (const event of record.events) {
      renderEvent(event);
    }

    await beginSession({
      sessionId: record.id,
      initialMessages: record.messages,
      priorEvents: record.events,
      title: record.title,
      createdAt: record.createdAt,
      ownerEmail: record.ownerEmail,
    });
  } finally {
    // On success, beginSession's own refreshSessionList call already
    // rebuilt the sidebar (replacing triggerEl with a freshly-labeled
    // element), so this is a harmless no-op on a now-detached node in that
    // case — it only visibly matters on the failure path above, where the
    // list never re-rendered and this element is still the one on screen.
    if (triggerEl) {
      triggerEl.disabled = false;
      triggerEl.textContent = originalLabel;
    }
  }
}

function renderSessionList(entries: SessionIndexEntry[]): void {
  for (const el of Array.from(sidebarSessionList.querySelectorAll(".session-item"))) {
    el.remove();
  }
  sessionListEmpty.hidden = entries.length > 0;
  for (const entry of entries) {
    const item = document.createElement("div");
    item.className = "session-item";
    if (entry.id === sessionId) item.classList.add("active");

    const label = document.createElement("button");
    label.type = "button";
    label.className = "session-item-label";
    label.textContent = entry.title;
    label.title = entry.title;
    label.addEventListener("click", () => void resumeSession(entry.id, label));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "session-item-delete";
    deleteBtn.title = "Delete session";
    deleteBtn.textContent = "×";
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

    item.appendChild(label);
    item.appendChild(deleteBtn);
    sidebarSessionList.appendChild(item);
  }
}

async function refreshSessionList(query: string): Promise<void> {
  const entries = query ? await window.agent.searchSessions(query) : await window.agent.listSessions();
  renderSessionList(entries);
}

sessionSearchInput.addEventListener("input", () => {
  void refreshSessionList(sessionSearchInput.value.trim());
});

void refreshSessionList("");

runTaskBtn.addEventListener("click", async () => {
  if (!sessionId || !taskInput.value.trim()) return;
  toolCards.clear();
  runTaskBtn.disabled = true;
  const task = taskInput.value;
  logLine(task, "log-task");
  await window.agent.runTask(sessionId, task);
  await refreshSessionList(sessionSearchInput.value.trim());
});

taskInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!runTaskBtn.disabled) runTaskBtn.click();
  }
});

function renderAuthState(status: AuthStatus): void {
  authError.textContent = "";
  if (status.signedIn) {
    authSignedOut.hidden = true;
    authSignedIn.hidden = false;
    authName.textContent = `${status.name} · `;
    if (status.pictureUrl) {
      authAvatar.style.backgroundImage = `url(${JSON.stringify(status.pictureUrl)})`;
      authAvatar.textContent = "";
    } else {
      authAvatar.style.backgroundImage = "";
      authAvatar.textContent = status.name.slice(0, 1).toUpperCase();
    }
  } else {
    authSignedOut.hidden = false;
    authSignedIn.hidden = true;
  }
}

googleSignInBtn.addEventListener("click", () => {
  authError.textContent = "";
  // The whole flow — waiting for you to finish in the browser, plus
  // claiming unowned local sessions and running the Drive reconcile pass
  // — happens before this resolves, which can take real time. A plain
  // disabled button with no label change reads as frozen; this makes
  // clear it's actually working.
  void withBusyLabel(googleSignInBtn, "Signing in…", async () => {
    const result = await window.agent.googleSignIn();
    if ("error" in result) {
      authError.textContent = result.error;
    } else {
      renderAuthState({ signedIn: true, ...result });
    }
  });
});

signOutBtn.addEventListener("click", () => {
  authError.textContent = "";
  void withBusyLabel(signOutBtn, "Signing out…", async () => {
    try {
      await window.agent.signOut();
      renderAuthState({ signedIn: false });
      // Session history is filtered by the signed-in account server-side —
      // refresh now so the sidebar clears immediately instead of continuing
      // to show the just-signed-out account's sessions until the next
      // unrelated list refresh.
      await refreshSessionList(sessionSearchInput.value.trim());
    } catch (err) {
      authError.textContent = err instanceof Error ? err.message : String(err);
    }
  });
});

window.agent.onSessionsChanged(() => {
  void refreshSessionList(sessionSearchInput.value.trim());
});

window.agent.onCloudSyncScopeWarning(() => {
  authError.textContent = "Sign in again to keep backing up your sessions to Google Drive.";
});

window.agent.getAuthStatus().then(renderAuthState).catch(() => {});
