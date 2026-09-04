import type { AgentEvent, AttachedImage, AttachedText, ChatMessage, PermissionMode, ProposedPlan, ToolCall } from "../../types.js";
import type { Change } from "diff";
import { groupDiffIntoSegments } from "../../diffUtil.js";
import type { ProviderConfig, SessionConfig } from "../sessionRegistry.js";
import type { FileChangeWithDiff } from "../../changesSince.js";
import type { PickedAttachment } from "../attachments.js";
import {
  createTabRegistry,
  openNewTab,
  closeTab,
  focusTab,
  findTabForSession,
  tabDotState,
  activeTab,
  routeEvent,
  resetTabToUnconfigured,
  defaultTabConfig,
  lastEventStillRunning,
  MAX_OPEN_TABS,
  type TabRegistry,
  type TabState,
} from "./tabState.js";
import type { UpdateStatus } from "../updateManager.js";
import { estimateCostUsd } from "../../anthropicPricing.js";
import { WHATS_NEW } from "../../whatsNew.js";
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
  workspaceRoot: string;
}

type McpServerStatus = { state: "connecting" } | { state: "connected"; toolCount: number } | { state: "failed"; error: string };
type McpServerView = { id: string; name: string; command: string; args: string[]; status: McpServerStatus };

interface AgentBridge {
  startSession(config: SessionConfig, resume?: ResumePayload): Promise<{ sessionId: string; workspaceRoot: string }>;
  runTask(sessionId: string, task: string, attachments?: { images?: AttachedImage[]; textAttachments?: AttachedText[] }): Promise<void>;
  pickAttachments(limit?: number): Promise<{ attachments: PickedAttachment[]; errors: { name: string; error: string }[]; skipped: number }>;
  respondPermission(sessionId: string, callId: string, approved: boolean, approvedHunkIds?: number[]): Promise<void>;
  respondPlan(sessionId: string, approved: boolean): Promise<void>;
  cancelSession(sessionId: string): Promise<void>;
  getCheckpoint(sessionId: string): Promise<string | null>;
  revertCheckpoint(sessionId: string): Promise<{ ok: boolean; error?: string }>;
  getChanges(sessionId: string): Promise<{ ok: true; changes: FileChangeWithDiff[] } | { ok: false; error: string }>;
  pickWorkspace(): Promise<string | null>;
  onEvent(callback: (sessionId: string, event: AgentEvent) => void): () => void;
  onDownloadProgress(callback: (status: DownloadProgress) => void): () => void;
  listCachedModels(): Promise<Record<string, boolean>>;
  deleteCachedModel(id: string): Promise<boolean>;
  cancelDownload(): Promise<void>;
  getHardwareInfo(): Promise<HardwareInfo>;
  getDiagnostics(): Promise<{ appVersion: string; platform: string; osRelease: string; arch: string }>;
  logRendererError(entry: { kind: string; message: string; stack?: string }): Promise<void>;
  openErrorLog(): Promise<void>;
  googleSignIn(): Promise<SignInResult>;
  signOut(): Promise<void>;
  getAuthStatus(): Promise<AuthStatus>;
  listSessions(): Promise<SessionIndexEntry[]>;
  searchSessions(query: string): Promise<SessionIndexEntry[]>;
  loadSession(id: string): Promise<SessionRecord | null>;
  getLiveSession(id: string): Promise<LiveSessionSnapshot | null>;
  updateSessionSettings(id: string, updates: { workspaceRoot?: string; mode?: PermissionMode; planFirst?: boolean }): Promise<boolean>;
  deleteSession(id: string): Promise<void>;
  onSessionsChanged(callback: () => void): () => void;
  onCloudSyncScopeWarning(callback: () => void): () => void;
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
  installUpdate(): Promise<void>;
  openUpdateFile(): Promise<void>;
  listMcpServers(): Promise<{ id: string; name: string; command: string; args: string[]; status: McpServerStatus }[]>;
  addMcpServer(
    input: { name: string; command: string; args: string[]; env: Record<string, string> }
  ): Promise<{ ok: true; server: { id: string; name: string; command: string; args: string[]; status: McpServerStatus } } | { ok: false; error: string }>;
  removeMcpServer(id: string): Promise<void>;
  onMcpServerStatusChanged(callback: (payload: { id: string; status: McpServerStatus }) => void): () => void;
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

// Local-only error capture, renderer half — see errorLog.ts's doc comment
// for why this is on by default rather than opt-in. crashReporter (main
// process) only catches native crashes; these two catch plain JS errors,
// which is the more likely failure mode in a renderer this size. Registered
// early, before anything else below can throw.
window.addEventListener("error", (event) => {
  void window.agent.logRendererError({ kind: "window.onerror", message: event.message, stack: event.error?.stack });
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  void window.agent.logRendererError({ kind: "unhandledrejection", message, stack });
});

const workspacePathEl = byId<HTMLSpanElement>("workspace-path");
const chooseWorkspaceBtn = byId<HTMLButtonElement>("choose-workspace");
const externalFields = byId<HTMLDivElement>("external-fields");
const anthropicFields = byId<HTMLDivElement>("anthropic-fields");
const baseUrlInput = byId<HTMLInputElement>("base-url");
const externalModelInput = byId<HTMLInputElement>("external-model");
const modelSelect = byId<HTMLSelectElement>("model-select");
// Anthropic models offered in the Cloud group — curated here (not
// user-typed like the custom-server option) since they all share the same
// saved API key and just pick which model id gets sent per request.
const ANTHROPIC_MODELS: Record<string, { name: string; note: string }> = {
  "claude-sonnet-5": { name: "Claude Sonnet 5", note: "balanced quality and cost — default" },
  "claude-opus-5": { name: "Claude Opus 5", note: "most capable, higher cost" },
  "claude-haiku-4-5": { name: "Claude Haiku 4.5", note: "fastest, lowest cost" },
};
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";
const CUSTOM_SERVER_VALUE = "custom-server";
const modeSelect = byId<HTMLSelectElement>("mode");
const planFirstCheckbox = byId<HTMLInputElement>("plan-first");
const modeDescription = byId<HTMLSpanElement>("mode-description");
const startSessionBtn = byId<HTMLButtonElement>("start-session");
const startError = byId<HTMLDivElement>("start-error");
const taskInput = byId<HTMLTextAreaElement>("task-input");
const runTaskBtn = byId<HTMLButtonElement>("run-task");
const attachFileBtn = byId<HTMLButtonElement>("attach-file");
const attachmentChipsRow = byId<HTMLDivElement>("attachment-chips");
const eventLog = byId<HTMLDivElement>("event-log");
const emptyState = byId<HTMLDivElement>("empty-state");
const updateBanner = byId<HTMLDivElement>("update-banner");
const updateBannerText = byId<HTMLSpanElement>("update-banner-text");
const updateBannerLink = byId<HTMLAnchorElement>("update-banner-link");
const updateBannerOpenFileBtn = byId<HTMLButtonElement>("update-banner-open-file");
const updateBannerRestartBtn = byId<HTMLButtonElement>("update-banner-restart");
const updateBannerDismiss = byId<HTMLButtonElement>("update-banner-dismiss");
const aboutToggle = byId<HTMLButtonElement>("about-toggle");
const aboutPanel = byId<HTMLDivElement>("about-panel");
const aboutClose = byId<HTMLButtonElement>("about-close");
const mcpServersToggle = byId<HTMLButtonElement>("mcp-servers-toggle");
const mcpServersPanel = byId<HTMLDivElement>("mcp-servers-panel");
const mcpServersListView = byId<HTMLDivElement>("mcp-servers-list-view");
const mcpServersList = byId<HTMLDivElement>("mcp-servers-list");
const mcpServersListError = byId<HTMLDivElement>("mcp-servers-list-error");
const mcpServersEmpty = byId<HTMLDivElement>("mcp-servers-empty");
const mcpServersAddToggle = byId<HTMLButtonElement>("mcp-servers-add-toggle");
const mcpServersFormView = byId<HTMLDivElement>("mcp-servers-form-view");
const mcpServersFormBack = byId<HTMLButtonElement>("mcp-servers-form-back");
const mcpServerNameInput = byId<HTMLInputElement>("mcp-server-name");
const mcpServerCommandInput = byId<HTMLInputElement>("mcp-server-command");
const mcpServerArgsInput = byId<HTMLInputElement>("mcp-server-args");
const mcpServerEnvInput = byId<HTMLTextAreaElement>("mcp-server-env");
const mcpServerFormError = byId<HTMLDivElement>("mcp-server-form-error");
const mcpServerFormSave = byId<HTMLButtonElement>("mcp-server-form-save");
const mcpServersClose = byId<HTMLButtonElement>("mcp-servers-close");
const reportIssueLink = byId<HTMLAnchorElement>("report-issue-link");
const openErrorLogBtn = byId<HTMLButtonElement>("open-error-log");
const onboardingOverlay = byId<HTMLDivElement>("onboarding-overlay");
const onboardingDismiss = byId<HTMLButtonElement>("onboarding-dismiss");
const whatsNewOverlay = byId<HTMLDivElement>("whats-new-overlay");
const whatsNewTitle = byId<HTMLHeadingElement>("whats-new-title");
const whatsNewList = byId<HTMLUListElement>("whats-new-list");
const whatsNewDismiss = byId<HTMLButtonElement>("whats-new-dismiss");
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
const usageBadge = byId<HTMLSpanElement>("usage-badge");
const editSettingsBtn = byId<HTMLButtonElement>("edit-settings");
const revertCheckpointBtn = byId<HTMLButtonElement>("revert-checkpoint");
const viewChangesBtn = byId<HTMLButtonElement>("view-changes");
const changesPanel = byId<HTMLDivElement>("changes-panel");
const changesPanelBody = byId<HTMLDivElement>("changes-panel-body");
const changesPanelClose = byId<HTMLButtonElement>("changes-panel-close");
const downloadedModelsList = byId<HTMLUListElement>("downloaded-models-list");
const downloadedModelsEmpty = byId<HTMLDivElement>("downloaded-models-empty");
const sidebarSessionList = byId<HTMLDivElement>("session-list");
const sessionListEmpty = byId<HTMLDivElement>("session-list-empty");
const sessionSearchInput = byId<HTMLInputElement>("session-search");
const newSessionBtn = byId<HTMLButtonElement>("new-session-btn");
const setupSection = byId<HTMLElement>("setup");
const statusWorkspaceEl = byId<HTMLSpanElement>("status-workspace");
const themeSelect = byId<HTMLSelectElement>("theme-select");
const tabStripList = byId<HTMLDivElement>("tab-strip-list");
const tabStripNew = byId<HTMLButtonElement>("tab-strip-new");
const tabStripCapMessage = byId<HTMLDivElement>("tab-strip-cap-message");

// Theme (Warm Dark / Mono Ink) — a per-viewer UI preference only, so
// localStorage is the right tool here (same reasoning as the onboarding
// seen-flag above), not the main-process settings store the API keys use.
const THEME_KEY = "localagent:theme";
const DEFAULT_THEME = "warm-dark";
function applyTheme(theme: string): void {
  document.documentElement.setAttribute("data-theme", theme);
}
function loadTheme(): string {
  try {
    return localStorage.getItem(THEME_KEY) ?? DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}
const initialTheme = loadTheme();
applyTheme(initialTheme);
themeSelect.value = initialTheme;
themeSelect.addEventListener("change", () => {
  applyTheme(themeSelect.value);
  try {
    localStorage.setItem(THEME_KEY, themeSelect.value);
  } catch {
    // Best-effort — if this fails, the theme just resets next launch; not worth surfacing an error for.
  }
});

/** Sets both the setup form's workspace text and its collapsed status-bar echo shown once a session is active — kept in one place so the two never drift apart. */
function setWorkspaceText(text: string): void {
  workspacePathEl.textContent = text;
  statusWorkspaceEl.textContent = text;
}

// Declared here (rather than beside renderTabStrip below, which uses it)
// because renderTabStrip is called synchronously from the module-state
// block just below — a module-level `const` referenced before its own
// declaration's line throws (temporal dead zone), even though the
// function that reads it is itself hoisted.
const DOT_GLYPH: Record<ReturnType<typeof tabDotState>, string> = {
  unconfigured: "○",
  running: "●",
  "waiting-approval": "◐",
  done: "✓",
  error: "✕",
};

let hardwareInfo: HardwareInfo | null = null;
const toolCards = new Map<string, HTMLElement>();
const tabRegistry: TabRegistry = createTabRegistry();
// Global launch behavior (see plan Global Constraints): the app always has
// at least one tab, even though open tabs are never restored across a
// relaunch — this is a brand-new, unconfigured one every time.
openNewTab(tabRegistry);
renderTabStrip();

/** Throws if called before the first tab exists — which, given the openNewTab() call directly above and closeTab() never running before then, is only reachable if this module's own invariant is broken. Every call site below already assumes a tab exists (matching every existing `if (!sessionId) return;` guard's assumption that setup has happened), so a thrown error here surfaces a real bug immediately instead of silently no-oping deep in some handler. */
function requireActiveTab(): TabState {
  const tab = activeTab(tabRegistry);
  if (!tab) throw new Error("No active tab — this should be unreachable (see requireActiveTab's doc comment).");
  return tab;
}

/**
 * Running total for the active session, rebuilt from scratch by clearEventLog
 * (both on a fresh/switched session and right before a resumed session's
 * history replays through renderEvent) — never mutated any other way, so a
 * resumed session's badge always reflects that session's own real history,
 * not whatever leaked over from the previous one.
 *
 * `knownCostUsd` accumulates INCREMENTALLY, one usage event at a time, each
 * priced at that event's OWN `model` — never recomputed from the lifetime
 * token totals against a single rate. That distinction matters because a
 * session can switch Anthropic models partway through (Edit settings…),
 * and each usage event already carries the model that was actually active
 * for that specific turn; re-pricing the whole history at whichever model
 * happens to be active now would silently mis-price every token spent
 * under a previous model. `hasUnknownPricedUsage` degrades the badge to
 * token-counts-only (no dollar figure) the moment any turn's model isn't
 * in the pricing table — a partial dollar total that silently excludes
 * some real spend would be worse than no dollar total at all.
 */
let sessionUsage = { inputTokens: 0, outputTokens: 0, knownCostUsd: 0, hasUnknownPricedUsage: false };

function formatTokenCount(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : String(tokens);
}

const MAX_ATTACHMENTS_PER_TASK = 5;

/**
 * Builds one chip — shared by the composer's removable row (Step 3 below)
 * and the read-only copy shown under a sent task's `.log-task` bubble
 * (Step 5), so what a chip looks like is defined in exactly one place.
 * `onRemove` omitted means read-only: no × button.
 */
function buildAttachmentChip(attachment: PickedAttachment, onRemove?: () => void): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "attachment-chip";
  const icon = document.createElement("span");
  icon.className = "attachment-chip-icon";
  icon.textContent = attachment.kind === "image" ? "🖼" : "📄";
  chip.appendChild(icon);
  const label = document.createElement("span");
  label.textContent = attachment.name;
  chip.appendChild(label);
  if (attachment.kind === "text" && attachment.truncated) {
    const badge = document.createElement("span");
    badge.className = "attachment-chip-truncated";
    badge.textContent = "truncated";
    chip.appendChild(badge);
  }
  if (onRemove) {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "attachment-chip-remove";
    removeBtn.textContent = "×";
    removeBtn.setAttribute("aria-label", `Remove ${attachment.name}`);
    removeBtn.addEventListener("click", onRemove);
    chip.appendChild(removeBtn);
  }
  return chip;
}

/** Rebuilds the composer's chip row from `pendingAttachments` — called after every add/remove, same "just re-render from state" pattern renderSessionList already uses for the sidebar. */
function renderAttachmentChips(): void {
  const tab = requireActiveTab();
  attachmentChipsRow.innerHTML = "";
  attachmentChipsRow.hidden = tab.pendingAttachments.length === 0;
  for (const [index, attachment] of tab.pendingAttachments.entries()) {
    attachmentChipsRow.appendChild(
      buildAttachmentChip(attachment, () => {
        tab.pendingAttachments = tab.pendingAttachments.filter((_, i) => i !== index);
        renderAttachmentChips();
      })
    );
  }
}

attachFileBtn.addEventListener("click", () => {
  void withBusyLabel(attachFileBtn, "…", async () => {
    const remaining = MAX_ATTACHMENTS_PER_TASK - requireActiveTab().pendingAttachments.length;
    if (remaining <= 0) {
      logLine(`[attachments] Already at the ${MAX_ATTACHMENTS_PER_TASK}-attachment limit for this task — remove one before adding another.`, "log-error");
      return;
    }
    const { attachments, errors, skipped } = await window.agent.pickAttachments(remaining);
    for (const err of errors) {
      logLine(`[attachments] Couldn't attach ${err.name}: ${err.error}`, "log-error");
    }
    if (skipped > 0) {
      // Informational, not an error — the picked files are fine, the
      // 5-attachment cap is just already-documented product behavior.
      logLine(`[attachments] Only added ${attachments.length} of ${attachments.length + skipped} picked files — the ${MAX_ATTACHMENTS_PER_TASK}-attachment limit was reached.`, "log-status");
    }
    const tab = requireActiveTab();
    tab.pendingAttachments = [...tab.pendingAttachments, ...attachments];
    renderAttachmentChips();
  });
});

/** The workspace/provider/mode controls that lock once a session starts — shared by beginSession's success path, resetToSetup, and the edit-settings toggle so the same list isn't repeated three times. */
function setSetupControlsDisabled(disabled: boolean): void {
  chooseWorkspaceBtn.disabled = disabled;
  modelSelect.disabled = disabled;
  modeSelect.disabled = disabled;
  baseUrlInput.disabled = disabled;
  externalModelInput.disabled = disabled;
  planFirstCheckbox.disabled = disabled;
}

// One dropdown, one source of truth for "which model" — previously a
// separate "Advanced" disclosure held radio buttons that silently
// overrode this select's own visible value once expanded. Every choice
// (embedded, Claude, or a custom server) now lives here as a single flat
// list of options, grouped by kind.
const EMBEDDED_CATEGORY_LABELS: Record<ModelCategory, string> = { coding: "Coding", chat: "Chat", reasoning: "Research & Reasoning" };
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
  modelSelect.appendChild(group);
}

const cloudGroup = document.createElement("optgroup");
cloudGroup.label = "Cloud";
// Note: none of these get `.selected = true` — the embedded default
// option (set above) stays the page's initial selection, same as before
// this group had more than one entry. DEFAULT_ANTHROPIC_MODEL only matters
// once the Cloud group itself is chosen (see deriveProviderConfigFromForm).
for (const [id, info] of Object.entries(ANTHROPIC_MODELS)) {
  const option = document.createElement("option");
  option.value = id;
  option.textContent = `${info.name} (Anthropic API) — ${info.note}`;
  cloudGroup.appendChild(option);
}
modelSelect.appendChild(cloudGroup);

const customGroup = document.createElement("optgroup");
customGroup.label = "Custom";
const customOption = document.createElement("option");
customOption.value = CUSTOM_SERVER_VALUE;
customOption.textContent = "Custom server (Ollama, LM Studio, vLLM)…";
customGroup.appendChild(customOption);
modelSelect.appendChild(customGroup);

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
modeSelect.addEventListener("change", () => {
  updateModeDescription();
  captureFormIntoTab();
});
updateModeDescription();

/** Shows/hides the two fields that only apply to one specific model-select value each — everything else needs neither. */
function updateModelDependentFields() {
  externalFields.hidden = modelSelect.value !== CUSTOM_SERVER_VALUE;
  anthropicFields.hidden = !(modelSelect.value in ANTHROPIC_MODELS);
}
modelSelect.addEventListener("change", () => {
  updateModelDependentFields();
  captureFormIntoTab();
});
updateModelDependentFields();

// The other three controls syncFormFromTab restores. Without these, the
// active tab's stored provider/mode/planFirst silently drift away from what
// the form actually shows the moment the user touches any of them — which is
// what made switching tabs reset a configured tab back to the embedded
// defaults, and made "Apply changes" on a running session compare a reset
// form against the real running provider and destructively restart it.
planFirstCheckbox.addEventListener("change", () => captureFormIntoTab());
baseUrlInput.addEventListener("input", () => captureFormIntoTab());
externalModelInput.addEventListener("input", () => captureFormIntoTab());

/**
 * Rebuilds every EMBEDDED model option's label from scratch (base name +
 * size note, then "recommended"/"downloaded" suffixes) rather than
 * appending onto whatever text is already there — so this is safe to call
 * again after a model is deleted or a download finishes, not just once at
 * startup. The Cloud/Custom options have no such state, so they're
 * skipped (EMBEDDED_MODELS has no entry for their values).
 */
function refreshEmbeddedModelLabels(cached: Record<string, boolean>): void {
  for (const option of Array.from(modelSelect.options)) {
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
    deleteBtn.setAttribute("aria-label", `Delete ${info.name}`);
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

/** Builds a GitHub "new issue" URL pre-filled with app version/OS/hardware, so a reporter doesn't have to dig this up themselves. */
async function buildReportIssueUrl(): Promise<string> {
  const diag = await window.agent.getDiagnostics();
  const hwText = hardwareInfo
    ? `${(hardwareInfo.totalRamBytes / 1024 ** 3).toFixed(0)}GB RAM, ${hardwareInfo.gpu ? `${hardwareInfo.gpu} GPU` : "CPU only"}`
    : "unknown";
  const body = [
    "**Describe the issue:**\n\n\n",
    "---",
    `App version: ${diag.appVersion}`,
    `Platform: ${diag.platform} ${diag.osRelease} (${diag.arch})`,
    `Hardware: ${hwText}`,
  ].join("\n");
  return `https://github.com/lavuchandu169/localagent/issues/new?${new URLSearchParams({ body }).toString()}`;
}

/** Hides the panel, updates its toggle's aria-expanded, and returns focus to the toggle — the reverse of opening it, so a keyboard/screen-reader user always lands back where they started instead of on a now-hidden element. */
function closeAboutPanel(): void {
  aboutPanel.hidden = true;
  aboutToggle.setAttribute("aria-expanded", "false");
  aboutToggle.focus();
}

aboutToggle.addEventListener("click", () => {
  const opening = aboutPanel.hidden;
  aboutPanel.hidden = !opening;
  aboutToggle.setAttribute("aria-expanded", String(opening));
  if (opening) {
    void buildReportIssueUrl().then((url) => (reportIssueLink.href = url));
    aboutClose.focus(); // moves focus into the panel, so a keyboard/screen-reader user actually lands on its content
  }
});
aboutClose.addEventListener("click", closeAboutPanel);

function closeMcpServersPanel() {
  mcpServersPanel.hidden = true;
  mcpServersToggle.setAttribute("aria-expanded", "false");
  mcpServersToggle.focus();
}

function showMcpServersListView() {
  mcpServersFormView.hidden = true;
  mcpServersListView.hidden = false;
  mcpServerFormError.textContent = "";
}

/** Builds one server row via createElement/.textContent, never innerHTML — server.name/command/args and a failed connection's status.error are all untrusted (user-typed, or emitted by a third-party MCP server process), so they must never be parsed as HTML. Same pattern as refreshDownloadedModelsList's list items elsewhere in this file. */
function renderMcpServerRow(server: McpServerView): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "mcp-server-row";
  const dot = server.status.state === "connected" ? "🟢" : server.status.state === "connecting" ? "🟡" : "🔴";
  const detail =
    server.status.state === "connected"
      ? `${server.status.toolCount} tool${server.status.toolCount === 1 ? "" : "s"} available`
      : server.status.state === "connecting"
        ? "Connecting…"
        : server.status.error;

  const dotSpan = document.createElement("span");
  dotSpan.className = "mcp-server-status-dot";
  dotSpan.textContent = dot;

  const nameSpan = document.createElement("span");
  nameSpan.className = "mcp-server-name";
  nameSpan.textContent = server.name;

  const commandSpan = document.createElement("span");
  commandSpan.className = "mcp-server-detail";
  commandSpan.textContent = [server.command, ...server.args].join(" ");

  const detailSpan = document.createElement("span");
  detailSpan.className = "mcp-server-detail";
  detailSpan.textContent = detail;

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", () => {
    void (async () => {
      try {
        await window.agent.removeMcpServer(server.id);
      } catch (err) {
        mcpServersListError.textContent = `Couldn't remove "${server.name}": ${err instanceof Error ? err.message : String(err)}`;
      }
      await refreshMcpServersList();
    })();
  });

  row.appendChild(dotSpan);
  row.appendChild(nameSpan);
  row.appendChild(commandSpan);
  row.appendChild(detailSpan);
  row.appendChild(removeBtn);
  return row;
}

/** Never throws — a failure to list (or, via the callers above, to remove) a server leaves the panel showing stale data, but always with a visible reason rather than silently, per the existing #mcp-server-form-error pattern this mirrors for the list view. */
async function refreshMcpServersList() {
  try {
    const servers = await window.agent.listMcpServers();
    mcpServersListError.textContent = "";
    mcpServersList.innerHTML = "";
    mcpServersEmpty.hidden = servers.length > 0;
    for (const server of servers) mcpServersList.appendChild(renderMcpServerRow(server));
  } catch (err) {
    mcpServersListError.textContent = `Couldn't load MCP servers: ${err instanceof Error ? err.message : String(err)}`;
  }
}

mcpServersToggle.addEventListener("click", () => {
  const opening = mcpServersPanel.hidden;
  mcpServersPanel.hidden = !opening;
  mcpServersToggle.setAttribute("aria-expanded", String(opening));
  if (opening) {
    showMcpServersListView();
    void refreshMcpServersList();
  }
});

mcpServersClose.addEventListener("click", closeMcpServersPanel);

mcpServersAddToggle.addEventListener("click", () => {
  mcpServerNameInput.value = "";
  mcpServerCommandInput.value = "";
  mcpServerArgsInput.value = "";
  mcpServerEnvInput.value = "";
  mcpServerFormError.textContent = "";
  mcpServersListView.hidden = true;
  mcpServersFormView.hidden = false;
  mcpServerNameInput.focus();
});

mcpServersFormBack.addEventListener("click", showMcpServersListView);

/** One KEY=value per line; blank lines and lines with no '=' are ignored. */
function parseEnvVarsText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

mcpServerFormSave.addEventListener("click", () => {
  mcpServerFormError.textContent = "";
  const name = mcpServerNameInput.value.trim();
  const command = mcpServerCommandInput.value.trim();
  if (!name || !command) {
    mcpServerFormError.textContent = "Name and command are required.";
    return;
  }
  const args = mcpServerArgsInput.value.trim().split(/\s+/).filter(Boolean);
  const env = parseEnvVarsText(mcpServerEnvInput.value);
  void withBusyLabel(mcpServerFormSave, "Saving…", async () => {
    try {
      const result = await window.agent.addMcpServer({ name, command, args, env });
      if (result.ok) {
        showMcpServersListView();
        await refreshMcpServersList();
      } else {
        mcpServerFormError.textContent = result.error;
      }
    } catch (err) {
      mcpServerFormError.textContent = err instanceof Error ? err.message : String(err);
    }
  });
});

window.agent.onMcpServerStatusChanged(() => {
  if (!mcpServersPanel.hidden && !mcpServersListView.hidden) void refreshMcpServersList();
});

openErrorLogBtn.addEventListener("click", () => {
  void window.agent.openErrorLog();
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

/** Same contract as closeAboutPanel — hide, update aria-expanded, return focus to the toggle. */
function closeSettingsPanel(): void {
  settingsPanel.hidden = true;
  settingsToggle.setAttribute("aria-expanded", "false");
  settingsToggle.focus();
}

settingsToggle.addEventListener("click", async () => {
  const opening = settingsPanel.hidden;
  if (opening) await openSettingsPanel();
  settingsPanel.hidden = !opening;
  settingsToggle.setAttribute("aria-expanded", String(opening));
  if (opening) settingsClose.focus();
});

settingsClose.addEventListener("click", closeSettingsPanel);

// Escape closes whichever of these dismissible panels/modals is currently
// open — the standard keyboard expectation. Onboarding and what's-new take
// priority since they're the only truly modal ones (block the rest of the
// page); at most one of the two is ever open at once (see
// showWhatsNewIfNeeded's own reasoning below), and neither can be open
// alongside the other dismissible panels anyway (nothing else is
// interactive until whichever modal is up gets dismissed).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!onboardingOverlay.hidden) dismissOnboarding();
  else if (!whatsNewOverlay.hidden) dismissWhatsNew();
  else if (!aboutPanel.hidden) closeAboutPanel();
  else if (!mcpServersPanel.hidden) closeMcpServersPanel();
  else if (!settingsPanel.hidden) closeSettingsPanel();
  else if (!changesPanel.hidden) closeChangesPanel();
});

// A focus trap for the onboarding/what's-new modals specifically — they're
// the only truly modal overlays in this app, so Tab must never move focus
// out to the page behind whichever one is open. Single focusable element
// each (their own dismiss button), so trapping is just "always land back
// on it."
document.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  if (!onboardingOverlay.hidden) {
    e.preventDefault();
    onboardingDismiss.focus();
  } else if (!whatsNewOverlay.hidden) {
    e.preventDefault();
    whatsNewDismiss.focus();
  }
});

const ONBOARDING_SEEN_KEY = "localagent:onboarding-seen";

/** Per-viewer UI preference only (not security/cross-device data) — localStorage is the right tool here, unlike everything else in this app which persists through the main process. */
function showOnboardingIfFirstRun(): void {
  let seen = false;
  try {
    seen = localStorage.getItem(ONBOARDING_SEEN_KEY) === "1";
  } catch {
    seen = true; // an inaccessible localStorage shouldn't block the app — treat as already seen
  }
  if (seen) return;
  onboardingOverlay.hidden = false;
  onboardingDismiss.focus();
}

function dismissOnboarding(): void {
  onboardingOverlay.hidden = true;
  try {
    localStorage.setItem(ONBOARDING_SEEN_KEY, "1");
  } catch {
    // Best-effort — if this fails, onboarding just shows again next launch; not worth surfacing an error for.
  }
  modelSelect.focus();
}

onboardingDismiss.addEventListener("click", dismissOnboarding);
showOnboardingIfFirstRun();

const WHATS_NEW_SEEN_KEY = "localagent:whats-new-seen-version";

/** Turns a changelog bullet's `` `code span` `` markdown into a real <code> element, leaving everything else as plain text — built via DOM nodes rather than innerHTML since this text ultimately comes from a file in the repo, not a trusted-but-still-worth-being-careful-with input. */
function renderWhatsNewBullet(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const parts = text.split("`");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (i % 2 === 1) {
      const code = document.createElement("code");
      code.textContent = part;
      fragment.appendChild(code);
    } else if (part) {
      fragment.appendChild(document.createTextNode(part));
    }
  }
  return fragment;
}

/**
 * Shows this build's changelog entry once per version, but only for
 * someone who's already past onboarding — a brand-new install gets the
 * onboarding modal's own "here's what this app does" and doesn't need a
 * second, redundant welcome. That also means the very first time this
 * feature ships, every existing user (onboarding already seen, no
 * what's-new-seen entry yet at all) correctly sees this version's notes
 * once, which is exactly the case the feature exists for.
 */
function showWhatsNewIfNeeded(): void {
  let onboardingSeen = false;
  let lastSeenVersion: string | null = null;
  try {
    onboardingSeen = localStorage.getItem(ONBOARDING_SEEN_KEY) === "1";
    lastSeenVersion = localStorage.getItem(WHATS_NEW_SEEN_KEY);
  } catch {
    return; // no localStorage available — nothing to show or track this run
  }

  if (!onboardingSeen) {
    // First-ever run: seed silently so this only ever fires for a real
    // upgrade from here on, never as a second welcome on top of onboarding.
    try {
      localStorage.setItem(WHATS_NEW_SEEN_KEY, WHATS_NEW.version);
    } catch {
      // Best-effort — worst case this shows once more than intended later; not worth surfacing an error for.
    }
    return;
  }

  if (lastSeenVersion === WHATS_NEW.version) return;

  whatsNewTitle.textContent = `What's new in v${WHATS_NEW.version}`;
  whatsNewList.innerHTML = "";
  for (const bullet of WHATS_NEW.bullets) {
    const li = document.createElement("li");
    li.appendChild(renderWhatsNewBullet(bullet));
    whatsNewList.appendChild(li);
  }
  whatsNewOverlay.hidden = false;
  whatsNewDismiss.focus();
}

function dismissWhatsNew(): void {
  whatsNewOverlay.hidden = true;
  try {
    localStorage.setItem(WHATS_NEW_SEEN_KEY, WHATS_NEW.version);
  } catch {
    // Best-effort — if this fails, the modal just shows again next launch; not worth surfacing an error for.
  }
  // Unlike onboarding (which always lands on a fresh setup form and so
  // always has a sensible next field to focus), this modal can appear
  // either before or after a session has started — the composer isn't
  // always the right next stop. Only claim focus when it's actually usable.
  if (!taskInput.disabled) taskInput.focus();
}

whatsNewDismiss.addEventListener("click", dismissWhatsNew);
showWhatsNewIfNeeded();

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
    requireActiveTab().workspaceRoot = picked;
    setWorkspaceText(picked);
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

const DIFF_LINE_CAP = 300;

/** Splits a segment's value into its individual lines the same way the old flat renderer did — split("\n") on a trailing-newline string leaves one empty trailing entry, popped off. */
function linesOf(value: string): string[] {
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Renders a diff as context lines interleaved with per-hunk blocks, each
 * hunk carrying its own checkbox (checked by default, matching today's
 * implicit "approve everything") so an Approve click can read back exactly
 * which hunks are still checked. `readOnly` is used for a diff shown
 * alongside a decision that isn't ASK (already-decided ALLOW/DENY, or the
 * read-only copy under a sent task) — no checkboxes there, since there's
 * no prompt to attach a selection to.
 */
function renderDiff(diff: Change[], readOnly = false): HTMLElement {
  const container = document.createElement("div");
  container.className = "diff-view";
  const segments = groupDiffIntoSegments(diff);
  let linesShown = 0;

  outer: for (const segment of segments) {
    let hunkWrapper: HTMLElement | null = null;
    if (segment.kind === "hunk" && !readOnly) {
      hunkWrapper = document.createElement("div");
      hunkWrapper.className = "diff-hunk";
      const toggle = document.createElement("label");
      toggle.className = "diff-hunk-toggle";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.dataset.hunkId = String(segment.id);
      toggle.appendChild(checkbox);
      toggle.appendChild(document.createTextNode("Apply this change"));
      hunkWrapper.appendChild(toggle);
      container.appendChild(hunkWrapper);
    }
    const target = hunkWrapper ?? container;

    const parts: { value: string; added?: boolean; removed?: boolean }[] =
      segment.kind === "context"
        ? [{ value: segment.value }]
        : [
            ...(segment.removedValue !== undefined ? [{ value: segment.removedValue, removed: true }] : []),
            ...(segment.addedValue !== undefined ? [{ value: segment.addedValue, added: true }] : []),
          ];

    for (const part of parts) {
      for (const line of linesOf(part.value)) {
        if (linesShown >= DIFF_LINE_CAP) {
          const truncated = document.createElement("div");
          truncated.className = "diff-line diff-truncated";
          truncated.textContent = "… diff truncated …";
          container.appendChild(truncated);
          break outer;
        }
        const lineEl = document.createElement("div");
        lineEl.className = `diff-line ${part.added ? "diff-added" : part.removed ? "diff-removed" : "diff-context"}`;
        lineEl.textContent = `${part.added ? "+" : part.removed ? "-" : " "} ${line}`;
        target.appendChild(lineEl);
        linesShown++;
      }
    }
  }
  return container;
}

/**
 * Renders a task's proposed first move (see planFirst) as a card: either
 * the list of tool calls it wants to make (name + arguments, same format
 * toolCard uses so it reads consistently with the rest of the log) or the
 * plain text it would have answered with directly — followed by an
 * Approve/Reject prompt reusing the exact same visual language as a
 * per-edit permission.request prompt, since both are "review before it
 * happens" moments.
 */
function renderPlanProposal(plan: ProposedPlan): HTMLElement {
  const card = document.createElement("div");
  card.className = "plan-card";

  const header = document.createElement("div");
  header.className = "plan-card-header";
  header.textContent = "Proposed plan";
  card.appendChild(header);

  if (plan.kind === "tool_calls") {
    if (plan.content) {
      const intro = document.createElement("div");
      intro.className = "log-text";
      intro.textContent = plan.content;
      card.appendChild(intro);
    }
    for (const call of plan.toolCalls) {
      const line = document.createElement("div");
      line.className = "plan-call";
      line.textContent = `${call.name}(${JSON.stringify(call.arguments)})`;
      card.appendChild(line);
    }
  } else {
    const text = document.createElement("div");
    text.className = "log-text";
    text.textContent = plan.content;
    card.appendChild(text);
  }

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
      const hasDiff = !!event.diff && event.diff.length > 0;
      if (event.decision !== "ASK" && !hasDiff) {
        logLine(`[permission] ${event.call.name} -> ${event.decision}`, "log-status");
        break;
      }
      const card = toolCards.get(event.call.id) ?? toolCard(event.call);
      if (hasDiff) card.appendChild(renderDiff(event.diff!, event.decision !== "ASK"));
      if (event.decision !== "ASK") {
        // Not asking (ALLOW/DENY), but still had a diff worth showing — no
        // approve/deny buttons needed, just the diff plus the same status
        // line the no-diff path above already logs for every other call.
        const status = document.createElement("div");
        status.className = "log-status";
        status.textContent = `[permission] ${event.call.name} -> ${event.decision}`;
        card.appendChild(status);
        break;
      }
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
        // Only meaningful for an edit_file approval. DIFF_LINE_CAP can mean
        // renderDiff never rendered a checkbox at all for a hunk past the
        // truncation point — that hunk must still count as approved on a
        // plain Approve click, or a long diff would silently have its tail
        // reverted to the old content even though every VISIBLE checkbox
        // was checked. So: every real hunk id in the diff (not just the
        // rendered ones) is approved unless it has a checkbox that's
        // present and unchecked. Undefined for a deny (never read) and
        // harmless-but-unused for a call with no diff at all (the two sets
        // below are both empty, so the filter below is a no-op).
        let approvedHunkIds: number[] | undefined;
        if (approved) {
          const allHunkIds = hasDiff ? groupDiffIntoSegments(event.diff!).flatMap((s) => (s.kind === "hunk" ? [s.id] : [])) : [];
          const renderedIds = new Set(Array.from(card.querySelectorAll<HTMLInputElement>(".diff-hunk-toggle input")).map((el) => Number(el.dataset.hunkId)));
          const checkedIds = new Set(Array.from(card.querySelectorAll<HTMLInputElement>(".diff-hunk-toggle input:checked")).map((el) => Number(el.dataset.hunkId)));
          approvedHunkIds = allHunkIds.filter((id) => !renderedIds.has(id) || checkedIds.has(id));
        }
        const tab = activeTab(tabRegistry);
        if (tab?.sessionId) void window.agent.respondPermission(tab.sessionId, event.call.id, approved, approvedHunkIds);
      };
      approve.addEventListener("click", () => respond(true));
      deny.addEventListener("click", () => respond(false));
      prompt.appendChild(approve);
      prompt.appendChild(deny);
      card.appendChild(prompt);
      break;
    }
    case "checkpoint.created":
      logLine("[checkpoint] Saved — this task can now be reverted.", "log-status");
      revertCheckpointBtn.hidden = false;
      viewChangesBtn.hidden = false;
      break;
    case "usage": {
      // Only ever fires for an Anthropic-backed session (the only provider
      // that reports real token counts today — see ChatResponse.usage) —
      // the badge simply never appears for embedded/custom-server sessions,
      // no explicit provider-kind check needed here.
      sessionUsage.inputTokens += event.inputTokens;
      sessionUsage.outputTokens += event.outputTokens;
      // Priced THIS event alone, at THIS event's own model, then added onto
      // the running dollar total — never recomputed from the lifetime token
      // totals against a single rate. A session that switches Anthropic
      // models partway through (Edit settings…) still prices every turn
      // correctly this way, since each usage event already carries the
      // model that was actually active for it.
      const eventCost = estimateCostUsd(event.model, event.inputTokens, event.outputTokens);
      if (eventCost === null) {
        sessionUsage.hasUnknownPricedUsage = true;
      } else {
        sessionUsage.knownCostUsd += eventCost;
      }
      const tokenText = `${formatTokenCount(sessionUsage.inputTokens)} in / ${formatTokenCount(sessionUsage.outputTokens)} out`;
      usageBadge.textContent = sessionUsage.hasUnknownPricedUsage ? tokenText : `~$${sessionUsage.knownCostUsd.toFixed(3)} (${tokenText})`;
      usageBadge.hidden = false;
      break;
    }
    case "plan.proposed": {
      emptyState.hidden = true;
      const card = renderPlanProposal(event.plan);
      const prompt = document.createElement("div");
      prompt.className = "permission-prompt";
      const approve = document.createElement("button");
      approve.className = "approve-btn";
      approve.textContent = "Approve";
      const reject = document.createElement("button");
      reject.className = "deny-btn";
      reject.textContent = "Reject";
      const respond = (approved: boolean) => {
        approve.disabled = true;
        reject.disabled = true;
        prompt.classList.add("permission-resolved");
        const tab = activeTab(tabRegistry);
        if (tab?.sessionId) void window.agent.respondPlan(tab.sessionId, approved);
      };
      approve.addEventListener("click", () => respond(true));
      reject.addEventListener("click", () => respond(false));
      prompt.appendChild(approve);
      prompt.appendChild(reject);
      card.appendChild(prompt);
      eventLog.appendChild(card);
      eventLog.scrollTop = eventLog.scrollHeight;
      break;
    }
    case "text":
      logLine(event.text, "log-text");
      break;
    case "task.sent":
      // Renderer-only synthetic event — see its own doc comment in
      // types.ts. In practice only ever reached via replay
      // (clearAndReplayEventLog): the live path already writes this exact
      // line itself at send time (runTaskBtn's handler), so this case
      // exists purely so switching away from a tab mid-task and back
      // reproduces the same line.
      logLine(event.task, "log-task");
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
  routeEvent(tabRegistry, incomingSessionId, event);
  const tab = findTabForSession(tabRegistry, incomingSessionId);
  if (!tab) return; // a session with no open tab at all — same silent-discard as before this task
  if (tab.tabId === tabRegistry.activeTabId) {
    renderEvent(event);
  }
  // Re-render the strip on every event regardless of which tab it belongs
  // to, so a backgrounded tab's dot (waiting-approval, done, error) updates
  // live without needing to switch to it first.
  renderTabStrip();
});

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)}MB`;
}

let progressLastTime = 0;
let progressLastBytes = 0;
let downloadInProgress = false;
/** Which tab's beginSession call claimed the in-flight model download (null when nothing is downloading). Only that call may clear `downloadInProgress`/the progress row when it finishes — see beginSession's finally. */
let downloadOwnerTabId: string | null = null;

window.agent.onDownloadProgress((status) => {
  downloadInProgress = true;
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

/** Reads the provider config the Model select (plus its dependent fields) currently describes — shared by beginSession and applySessionEdits, which needs it BEFORE deciding whether beginSession's tear-down-and-rebuild path is even safe to take. */
function deriveProviderConfigFromForm(): ProviderConfig {
  if (modelSelect.value in ANTHROPIC_MODELS) return { kind: "anthropic", model: modelSelect.value };
  if (modelSelect.value === CUSTOM_SERVER_VALUE) {
    return { kind: "openai-compatible", baseUrl: baseUrlInput.value.trim(), model: externalModelInput.value.trim() };
  }
  return { kind: "embedded", size: modelSelect.value };
}

/**
 * The exact inverse of syncFormFromTab: copies the setup form's current
 * selection into the ACTIVE tab, so `provider`/`mode`/`planFirst` never drift
 * away from what the form actually shows. Wired to every control those three
 * fields are restored from (model select, the two custom-server subfields,
 * mode select, plan-first checkbox) — miss one and switching away from that
 * tab and back silently reverts the user's choice, since syncFormFromTab
 * repaints the form from these fields alone.
 */
function captureFormIntoTab(): void {
  const tab = requireActiveTab();
  tab.provider = deriveProviderConfigFromForm();
  tab.mode = modeSelect.value as PermissionMode;
  tab.planFirst = planFirstCheckbox.checked;
}

/**
 * The provider config each session id was actually started with, remembered
 * for as long as this renderer lives. A LiveSessionSnapshot carries the
 * conversation (messages/events/title) but NOT the provider it's running on,
 * so reopening a still-live session whose tab was closed (see resumeSession)
 * has no other way to show the right model badge — or to give applySessionEdits
 * a truthful `activeProvider` to compare an edited form against. Every live
 * session was necessarily started by beginSession in this same renderer, so
 * this always has an entry for one; the only miss is a renderer reload with
 * the main process still holding the session, which falls back to leaving the
 * tab's provider fields at their defaults and activeProvider null (the safe
 * direction: applySessionEdits refuses to touch a session with no known
 * provider rather than guessing and restarting it under the wrong one).
 */
const startedSessionConfigs = new Map<string, { provider: ProviderConfig; mode: PermissionMode; planFirst: boolean }>();

/** True only while `tab` is the one the shared DOM is currently painting. Every DOM write in beginSession that happens AFTER an await has to ask this first: the user is free to switch tabs while an embedded model spends 30s loading, and painting "Session started"/an unlocked composer/a collapsed setup form into whatever tab they switched to is exactly the leak this guards. The tab's OWN fields (sessionId, activeProvider, …) are still updated unconditionally, so switching back to it later renders the right state through the normal syncFormFromTab/clearAndReplayEventLog path. */
function isActiveTab(tab: TabState): boolean {
  return tab.tabId === tabRegistry.activeTabId;
}

/** Paints the status-bar model badge for a provider — shared by beginSession's success path and clearAndReplayEventLog's tab-switch repaint so the two can't drift. */
function renderActiveModelBadge(provider: ProviderConfig): void {
  const modelText =
    provider.kind === "embedded"
      ? (provider.size in EMBEDDED_MODELS ? describeEmbeddedModel(provider.size as EmbeddedModelId) : provider.size)
      : provider.kind === "anthropic"
        ? (() => {
            const modelId = provider.model ?? DEFAULT_ANTHROPIC_MODEL;
            return `${ANTHROPIC_MODELS[modelId]?.name ?? modelId} (Anthropic API)`;
          })()
        : `${provider.model} (${provider.baseUrl})`;
  const gpuText = provider.kind === "embedded" && hardwareInfo?.gpu ? ` · ${hardwareInfo.gpu} GPU` : "";
  activeModelBadge.innerHTML = "";
  const dot = document.createElement("span");
  dot.className = "signal-dot";
  activeModelBadge.appendChild(dot);
  activeModelBadge.appendChild(document.createTextNode(`${modelText}${gpuText}`));
  activeModelBadge.hidden = false;
}

/**
 * Starts (or resumes) a session for ONE specific tab, passed in explicitly
 * rather than re-derived from `requireActiveTab()` inside. That parameter is
 * load-bearing: applySessionEdits awaits getLiveSession and cancelSession
 * before calling this, and a tab switch during those awaits used to hand the
 * edited session's identity to whichever tab happened to be active by then.
 */
async function beginSession(tab: TabState, resume?: ResumePayload): Promise<void> {
  // The form only describes the ACTIVE tab, so it's only read when that's the
  // tab being started; a background start (applySessionEdits after a switch)
  // uses the config already captured onto the tab itself.
  if (isActiveTab(tab)) {
    captureFormIntoTab();
    startError.textContent = "";
  }

  const provider = tab.provider;

  // workspaceRoot omitted entirely when none was picked — startSession defaults
  // it to the home directory and hands back whichever path it actually used.
  const config: SessionConfig = {
    ...(tab.workspaceRoot ? { workspaceRoot: tab.workspaceRoot } : {}),
    provider,
    mode: tab.mode,
    planFirst: tab.planFirst,
  };

  if (isActiveTab(tab)) {
    startSessionBtn.disabled = true;
    startSessionBtn.textContent = "Starting…";
  }

  // Whether THIS call is the one that owns whatever model download ends up in
  // flight. Only the owner may clear the shared download flag/progress row in
  // the finally below — a second tab starting an Anthropic session while the
  // first is still downloading an embedded model used to clear both, hiding a
  // live progress bar and dropping the concurrency guard mid-download.
  let ownsDownload = false;
  if (provider.kind === "embedded") {
    const cached = await window.agent.listCachedModels();
    if (!cached[provider.size]) {
      if (downloadInProgress) {
        if (isActiveTab(tab)) {
          startError.textContent = "Another tab is already downloading a model — wait for it to finish before starting a session that needs a download.";
          startSessionBtn.disabled = false;
          startSessionBtn.textContent = "Start session";
        }
        return;
      }
      // Claimed here rather than waiting for the first onDownloadProgress
      // tick, so a second tab racing into this same check can't slip past the
      // guard in the window before the download actually starts reporting.
      ownsDownload = true;
      downloadInProgress = true;
      downloadOwnerTabId = tab.tabId;
    }
  }
  try {
    const result = await window.agent.startSession(config, resume);
    tab.sessionId = result.sessionId;
    tab.running = false;
    if (!tab.workspaceRoot) {
      tab.workspaceRoot = result.workspaceRoot;
      if (isActiveTab(tab)) {
        setWorkspaceText(`${result.workspaceRoot} (default — no folder chosen)`);
        aboutWorkspace.textContent = result.workspaceRoot;
      }
    }
    tab.editingSession = false;
    tab.activeProvider = provider;
    startedSessionConfigs.set(result.sessionId, { provider, mode: tab.mode, planFirst: tab.planFirst });
    if (isActiveTab(tab)) {
      taskInput.disabled = false;
      attachFileBtn.disabled = false;
      runTaskBtn.disabled = false;
      logLine(
        resume ? `Resumed session (${provider.kind}, mode=${config.mode})` : `Session started (${provider.kind}, mode=${config.mode})`,
        "log-status"
      );
      // All setup controls lock here, not just Start — see setSetupControlsDisabled.
      setSetupControlsDisabled(true);
      editSettingsBtn.textContent = "Edit settings…";
      editSettingsBtn.hidden = false;
      revertCheckpointBtn.hidden = true; // a fresh/resumed/edited session has no checkpoint of its own yet — see the checkpoint.created event handler
      viewChangesBtn.hidden = true;
      // Chat-first once a session is running: the setup form collapses out of
      // the way, and Edit settings… brings it back (see editSettingsBtn's
      // handler for the reverse, and resetToSetup for the full teardown).
      setupSection.hidden = true;
      renderActiveModelBadge(provider);
    }
    // Cheap and correct for a backgrounded tab too — the strip is always
    // redrawn wholesale from tabRegistry, so this just flips this tab's dot
    // off "unconfigured" now that it genuinely has a session.
    renderTabStrip();
    await refreshSessionList(sessionSearchInput.value.trim());
  } catch (err: any) {
    // A failed edit-apply already cancelled the live session before getting
    // here (see applySessionEdits) — there's nothing left to edit, so this
    // falls back to a normal "start fresh" state rather than staying in
    // edit mode pointed at a session that no longer exists.
    tab.editingSession = false;
    if (isActiveTab(tab)) {
      // A cancelled download surfaces here as a rejected startSession() call —
      // main.ts's agent:start-session handler already turns that specific
      // case into the plain "Download cancelled." message before it ever
      // reaches the renderer, so this can just show whatever it received.
      startError.textContent = err?.message ?? String(err);
      startSessionBtn.disabled = false;
      startSessionBtn.textContent = "Start session";
      editSettingsBtn.hidden = true;
    }
    renderTabStrip();
  } finally {
    // `downloadOwnerTabId === null` covers stray progress nobody claimed
    // (nothing else would ever hide the row in that case); an owned download
    // is only ever cleared by its own owner.
    if (ownsDownload || downloadOwnerTabId === null) {
      downloadProgressRow.hidden = true;
      progressLastTime = 0;
      downloadInProgress = false;
      downloadOwnerTabId = null;
    }
  }
}

startSessionBtn.addEventListener("click", () => {
  const tab = requireActiveTab();
  if (tab.editingSession) void applySessionEdits();
  else void beginSession(tab);
});

cancelDownloadBtn.addEventListener("click", () => {
  void window.agent.cancelDownload();
});

revertCheckpointBtn.addEventListener("click", () => {
  const tab = activeTab(tabRegistry);
  if (!tab?.sessionId) return;
  const idToRevert = tab.sessionId;
  void withBusyLabel(revertCheckpointBtn, "Reverting…", async () => {
    const result = await window.agent.revertCheckpoint(idToRevert);
    if (result.ok) {
      logLine("[checkpoint] Reverted — the workspace is back to how it was before this task.", "log-done");
      revertCheckpointBtn.hidden = true;
      // Nothing's changed anymore — reverting undid it all.
      viewChangesBtn.hidden = true;
      changesPanel.hidden = true;
    } else {
      // Same graceful-failure posture as everywhere else in this app: show
      // the real reason (most likely "a task is running") rather than
      // silently doing nothing or throwing.
      logLine(`[checkpoint] Couldn't revert: ${result.error ?? "unknown error"}`, "log-error");
    }
  });
});

const CHANGE_STATUS_LABEL: Record<FileChangeWithDiff["status"], string> = { added: "A", modified: "M", deleted: "D" };

/** Sums the line count of every added (or every removed) chunk in a diff — the +N/-M counts shown next to each file, same source data renderDiff already walks. */
function countDiffLines(diff: FileChangeWithDiff["diff"], kind: "added" | "removed"): number {
  return diff.reduce((total, chunk) => total + (chunk[kind] ? (chunk.count ?? 0) : 0), 0);
}

/**
 * Renders the "Files changed" panel — one section per file (path, status
 * badge, +insertions/-deletions), each followed by its diff rendered with
 * the exact same renderDiff() the per-edit approval view uses, so a whole
 * task's changes read like a single GitHub commit/PR page instead of
 * being scattered across individual approval prompts in the log.
 */
function renderChangesPanel(changes: FileChangeWithDiff[]): void {
  changesPanelBody.innerHTML = "";
  if (changes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hint-text";
    empty.textContent = "No changes since the checkpoint.";
    changesPanelBody.appendChild(empty);
    return;
  }
  for (const file of changes) {
    const section = document.createElement("div");
    section.className = "changed-file";

    const header = document.createElement("div");
    header.className = "changed-file-header";
    const badge = document.createElement("span");
    badge.className = `change-status change-status-${file.status}`;
    badge.textContent = CHANGE_STATUS_LABEL[file.status];
    header.appendChild(badge);
    const pathEl = document.createElement("span");
    pathEl.className = "changed-file-path";
    pathEl.textContent = file.path;
    header.appendChild(pathEl);
    const added = countDiffLines(file.diff, "added");
    const removed = countDiffLines(file.diff, "removed");
    const counts = document.createElement("span");
    counts.className = "changed-file-counts";
    counts.innerHTML = `<span class="diff-added-count">+${added}</span> <span class="diff-removed-count">-${removed}</span>`;
    header.appendChild(counts);
    section.appendChild(header);

    section.appendChild(renderDiff(file.diff, true));
    changesPanelBody.appendChild(section);
  }
}

/** Same contract as closeAboutPanel/closeSettingsPanel — hide, return focus to the toggle. */
function closeChangesPanel(): void {
  changesPanel.hidden = true;
  viewChangesBtn.focus();
}

viewChangesBtn.addEventListener("click", () => {
  const tab = activeTab(tabRegistry);
  if (!tab?.sessionId) return;
  const idToView = tab.sessionId;
  void withBusyLabel(viewChangesBtn, "Loading…", async () => {
    const result = await window.agent.getChanges(idToView);
    if (result.ok) {
      renderChangesPanel(result.changes);
      changesPanel.hidden = false;
      changesPanelClose.focus();
    } else {
      logLine(`[changes] Couldn't load changes: ${result.error}`, "log-error");
    }
  });
});

changesPanelClose.addEventListener("click", closeChangesPanel);

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
  const tab = activeTab(tabRegistry);
  if (!tab?.sessionId || !tab.activeProvider) return;
  const idBeingEdited = tab.sessionId;
  // Read the form ONCE here, while this tab is still definitely the active
  // one, and store it on the tab — everything below (including beginSession,
  // which runs after two awaits) works from the tab, never from a form that
  // may by then be showing some other tab's settings.
  captureFormIntoTab();
  const newProvider = tab.provider;
  const newMode = tab.mode;
  startError.textContent = "";

  if (providerConfigsEqual(newProvider, tab.activeProvider)) {
    startSessionBtn.disabled = true;
    startSessionBtn.textContent = "Applying…";
    const ok = await window.agent.updateSessionSettings(idBeingEdited, {
      workspaceRoot: tab.workspaceRoot ?? undefined,
      mode: newMode,
      planFirst: tab.planFirst,
    });
    startedSessionConfigs.set(idBeingEdited, { provider: newProvider, mode: newMode, planFirst: tab.planFirst });
    tab.editingSession = false;
    // Same rule as beginSession: nothing past an await paints the shared DOM
    // unless this tab is still the one it's showing.
    if (!ok) {
      if (isActiveTab(tab)) {
        startError.textContent = "Couldn't apply changes — the session may have already ended.";
        startSessionBtn.disabled = false;
        startSessionBtn.textContent = "Edit settings…";
      }
      return;
    }
    if (isActiveTab(tab)) {
      logLine(`Settings updated (mode=${newMode})`, "log-status");
      setSetupControlsDisabled(true);
      startSessionBtn.disabled = true;
      startSessionBtn.textContent = "Starting…"; // matches beginSession's own (pre-existing, unchanged) post-success label
      editSettingsBtn.textContent = "Edit settings…";
      setupSection.hidden = true;
    }
    return;
  }

  try {
    const snapshot = await window.agent.getLiveSession(idBeingEdited);
    if (!snapshot) {
      if (isActiveTab(tab)) startError.textContent = "Couldn't read the current session to apply changes.";
      return;
    }
    await window.agent.cancelSession(idBeingEdited);
    tab.sessionId = null;
    tab.running = false;
    if (isActiveTab(tab)) {
      taskInput.disabled = true;
      attachFileBtn.disabled = true;
      runTaskBtn.disabled = true;
    }
    await beginSession(tab, {
      sessionId: idBeingEdited,
      initialMessages: snapshot.messages,
      priorEvents: snapshot.events,
      title: snapshot.title,
      createdAt: snapshot.createdAt,
      ownerEmail: snapshot.ownerEmail,
    });
  } finally {
    tab.editingSession = false;
  }
}

editSettingsBtn.addEventListener("click", () => {
  const tab = requireActiveTab();
  tab.editingSession = !tab.editingSession;
  setSetupControlsDisabled(!tab.editingSession);
  startSessionBtn.disabled = !tab.editingSession;
  startSessionBtn.textContent = tab.editingSession ? "Apply changes" : "Start session";
  editSettingsBtn.textContent = tab.editingSession ? "Cancel edit" : "Edit settings…";
  // Editing brings the collapsed setup form back into view; cancelling
  // (without applying) collapses it again — applying goes through
  // applySessionEdits/beginSession above, which already re-collapse it.
  setupSection.hidden = tab.editingSession ? false : true;
});

function clearEventLog(): void {
  toolCards.clear();
  eventLog.innerHTML = "";
  emptyState.hidden = false;
  eventLog.appendChild(emptyState);
  sessionUsage = { inputTokens: 0, outputTokens: 0, knownCostUsd: 0, hasUnknownPricedUsage: false };
  usageBadge.hidden = true;
}

/** Restores the setup form's fields (workspace text, model/mode selects, plan-first checkbox, and the two custom-server subfields) from a tab's stored selection — the visual half of switching tabs. Does not touch anything session-lifecycle-related (setSetupControlsDisabled, editSettingsBtn, revert/changes buttons) — that's handled by clearAndReplayEventLog below, since those depend on whether the tab has ever had a session, which the event replay determines. */
function syncFormFromTab(tab: TabState): void {
  setWorkspaceText(tab.workspaceRoot ? tab.workspaceRoot : "No workspace selected — optional, you can just chat");
  aboutWorkspace.textContent = tab.workspaceRoot ?? "(none selected)";

  // Defense in depth for a tab that already has a running session: show what
  // that session is ACTUALLY running on, not merely whatever the form last
  // captured — so even if some future path forgets to call captureFormIntoTab,
  // "Apply changes" on a running session can never compare a stale form
  // against the real provider and destructively restart it under the wrong
  // one. The exception is a tab mid-edit (Edit settings… open, not yet
  // applied): there the in-progress selection IS the thing to restore.
  const formProvider = tab.activeProvider && !tab.editingSession ? tab.activeProvider : tab.provider;
  if (formProvider.kind === "embedded") {
    modelSelect.value = formProvider.size;
  } else if (formProvider.kind === "anthropic") {
    modelSelect.value = formProvider.model ?? DEFAULT_ANTHROPIC_MODEL;
  } else {
    modelSelect.value = CUSTOM_SERVER_VALUE;
    baseUrlInput.value = formProvider.baseUrl;
    externalModelInput.value = formProvider.model;
  }
  updateModelDependentFields();

  modeSelect.value = tab.mode;
  updateModeDescription();
  planFirstCheckbox.checked = tab.planFirst;

  taskInput.value = tab.draftTask;
  renderAttachmentChips();
}

/** Clears the shared event log and re-renders a tab's entire stored `events` history through it — the same reconstruction resumeSession already does when loading a session from disk, just from memory instead. Also restores every other piece of UI state that Step 6's replay-driven renderEvent cases set as a side effect (revert/changes button visibility via checkpoint.created, the usage badge via "usage" events) by virtue of actually replaying those events. Session-lifecycle chrome that ISN'T derivable from events alone (setSetupControlsDisabled, editSettingsBtn's label/visibility, the model badge) is set here directly from the tab's own fields. */
function clearAndReplayEventLog(tab: TabState): void {
  clearEventLog();
  // Reset the checkpoint-derived chrome BEFORE replaying: these are only ever
  // turned on by a checkpoint.created event, so leaving them as the previous
  // tab left them showed a Revert/View-changes button (and, worse, another
  // tab's open file-diff panel) over a tab that has no checkpoint at all. The
  // replay below re-shows them if and only if THIS tab earned them.
  revertCheckpointBtn.hidden = true;
  viewChangesBtn.hidden = true;
  changesPanel.hidden = true;
  for (const event of tab.events) renderEvent(event);

  const hasSession = tab.sessionId !== null;
  setSetupControlsDisabled(hasSession);
  setupSection.hidden = hasSession && !tab.editingSession;
  editSettingsBtn.hidden = !hasSession;
  editSettingsBtn.textContent = tab.editingSession ? "Cancel edit" : "Edit settings…";
  startSessionBtn.disabled = tab.editingSession ? false : hasSession;
  startSessionBtn.textContent = tab.editingSession ? "Apply changes" : hasSession ? "Starting…" : "Start session";
  taskInput.disabled = !hasSession;
  attachFileBtn.disabled = !hasSession;
  // Having a session is NOT the same as being free to send one: a backgrounded
  // tab whose task is still in flight has a sessionId but must not offer Run,
  // or switching back to it fires a second concurrent runTask at an already
  // running session. The replayed `done` event above may well have re-enabled
  // the button (renderEvent's done case does), which is exactly why this
  // authoritative assignment comes after the replay.
  runTaskBtn.disabled = !hasSession || tab.running;

  if (hasSession && tab.activeProvider) renderActiveModelBadge(tab.activeProvider);
  else activeModelBadge.hidden = true;
}

/** Rebuilds the whole tab strip from tabRegistry — called after any open/close/focus/title/dot-state change. Built via createElement/textContent, never innerHTML: a tab's title comes from a resumed session's saved title, which — like every other user/session-derived string in this file (see renderMcpServerRow's own doc comment) — must never be parsed as HTML. */
function renderTabStrip(): void {
  tabStripList.innerHTML = "";
  for (const tabId of tabRegistry.order) {
    const tab = tabRegistry.tabs.get(tabId)!;
    const item = document.createElement("div");
    item.className = "tab-strip-item" + (tabId === tabRegistry.activeTabId ? " active" : "");

    const dot = document.createElement("span");
    dot.className = "tab-strip-item-dot";
    dot.textContent = DOT_GLYPH[tabDotState(tab)];
    item.appendChild(dot);

    const title = document.createElement("span");
    title.className = "tab-strip-item-title";
    title.textContent = tab.title ?? "New session";
    item.appendChild(title);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab-strip-item-close";
    close.textContent = "×";
    close.setAttribute("aria-label", `Close ${tab.title ?? "New session"}`);
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(tabRegistry, tabId);
      renderTabStrip();
      // Closing a tab always frees a slot, so any "cap reached" message from
      // a moment ago no longer applies — pairs with the same reset on a
      // successful tabStripNew open.
      tabStripCapMessage.hidden = true;
      const stillActive = activeTab(tabRegistry);
      if (stillActive) {
        syncFormFromTab(stillActive);
        clearAndReplayEventLog(stillActive);
      } else {
        // Every tab closed — Global Constraints guarantees this doesn't
        // happen from user action alone (closing the app's only tab is
        // still allowed, same as it is today via the sidebar's delete
        // button through resetToSetup), so immediately open a fresh one
        // rather than leaving the shared DOM pointed at nothing.
        const fresh = openNewTab(tabRegistry)!;
        renderTabStrip();
        syncFormFromTab(fresh);
        clearAndReplayEventLog(fresh);
      }
      // The closed/now-focused tab's session may have changed which sidebar
      // entries count as "open in a tab" (.open-in-tab) or "active"
      // (.active) — repaint those markers now rather than leaving them
      // stale until some unrelated refresh happens to fire.
      void refreshSessionList(sessionSearchInput.value.trim());
    });
    item.appendChild(close);

    item.addEventListener("click", () => switchToTab(tabId));
    tabStripList.appendChild(item);
  }
  tabStripNew.disabled = tabRegistry.order.length >= MAX_OPEN_TABS;
}

/** Focuses an already-open tab and re-renders the shared DOM from it — a no-op if tabId isn't open or is already active (avoids a pointless clear+replay of the tab you're already looking at). */
function switchToTab(tabId: string): void {
  if (tabId === tabRegistry.activeTabId) return;
  focusTab(tabRegistry, tabId);
  renderTabStrip();
  const tab = activeTab(tabRegistry);
  if (!tab) return;
  syncFormFromTab(tab);
  clearAndReplayEventLog(tab);
  // The sidebar's "active"/"open-in-tab" markers are keyed off which tab is
  // focused and which sessions are open — both just changed.
  void refreshSessionList(sessionSearchInput.value.trim());
}

tabStripNew.addEventListener("click", () => {
  const tab = openNewTab(tabRegistry);
  if (!tab) {
    tabStripCapMessage.hidden = false;
    return;
  }
  tabStripCapMessage.hidden = true;
  renderTabStrip();
  syncFormFromTab(tab);
  clearAndReplayEventLog(tab);
});

function resetToSetup(): void {
  const tab = requireActiveTab();
  if (tab.sessionId) void window.agent.cancelSession(tab.sessionId);
  // Wipes sessionId/workspaceRoot/activeProvider AND events/draftTask/
  // pendingAttachments/provider/mode/planFirst/editingSession/running back to
  // a brand-new tab's defaults — leaving any of those set meant switching
  // away from this tab and back replayed the just-deleted session's whole
  // old history (and repopulated its old draft) instead of showing a clean
  // setup form. `title` is deliberately untouched — the caller (the sidebar
  // delete handler) owns that.
  resetTabToUnconfigured(tab);
  clearEventLog();
  taskInput.disabled = true;
  attachFileBtn.disabled = true;
  runTaskBtn.disabled = true;
  activeModelBadge.hidden = true;
  editSettingsBtn.hidden = true;
  editSettingsBtn.textContent = "Edit settings…";
  revertCheckpointBtn.hidden = true;
  viewChangesBtn.hidden = true;
  changesPanel.hidden = true;
  startError.textContent = "";
  // Repaints the workspace text, model/mode/plan-first selects, draft task
  // (now empty), and attachment chips (now empty) from the tab's freshly
  // reset fields — the same restoration a tab switch does, just triggered by
  // this tab's own session having been deleted instead.
  syncFormFromTab(tab);
  setSetupControlsDisabled(false);
  startSessionBtn.disabled = false;
  startSessionBtn.textContent = "Start session";
  setupSection.hidden = false;
  void refreshSessionList(sessionSearchInput.value.trim());
}

newSessionBtn.addEventListener("click", () => tabStripNew.click());

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
    const alreadyOpen = findTabForSession(tabRegistry, id);
    if (alreadyOpen) {
      switchToTab(alreadyOpen.tabId);
      return;
    }

    // Try the still-live in-memory session FIRST, before ever touching disk.
    // A session whose tab was closed (or that's live from before this
    // renderer's own tab bookkeeping existed) keeps running server-side —
    // reopening it must reattach to that same live session, never restart
    // it. Restarting would run it through startSession's "an entry already
    // exists under this id" cleanup path, which resolves every pending
    // approval as denied and disposes the provider (see finalizeEntry) —
    // then rebuilds from whatever loadSession's disk snapshot has, which is
    // only ever written when a task completes, so anything since is lost.
    const liveSnapshot = await window.agent.getLiveSession(id);

    // Only hit disk (and only report "corrupted" for a bad file) once we
    // know there's no live session to reattach to instead.
    const record = liveSnapshot ? null : await window.agent.loadSession(id);
    if (!liveSnapshot && !record) {
      startError.textContent = "Couldn't load this session — the saved file looks corrupted.";
      return;
    }

    // Reuses the current tab if it's still unconfigured (never started a
    // session) — matches today's "+" button's own default-fresh-tab
    // starting point — otherwise opens a new one, respecting the cap. Not
    // claimed any earlier than this: a corrupted/missing record above must
    // leave no stray empty tab behind.
    const current = activeTab(tabRegistry);
    const tab = current && current.sessionId === null ? current : openNewTab(tabRegistry);
    if (!tab) {
      tabStripCapMessage.hidden = false;
      return;
    }
    tabStripCapMessage.hidden = true;

    if (liveSnapshot) {
      // Already running — just point this tab at it and repaint. No
      // startSession call at all, on purpose: see the comment above.
      tab.sessionId = id;
      tab.events = [...liveSnapshot.events];
      tab.title = liveSnapshot.title;
      tab.workspaceRoot = liveSnapshot.workspaceRoot;
      tab.running = lastEventStillRunning(tab.events);
      // LiveSessionSnapshot has no provider/mode/planFirst of its own — only
      // this renderer's own memory of what each session id was started with
      // does (see startedSessionConfigs' doc comment). The one case that
      // memory can't cover is a live session this renderer never itself
      // started (a reload with the main process still holding it) — the
      // safe fallback there is defaultTabConfig() plus a null
      // activeProvider, so applySessionEdits refuses to touch the provider
      // of a session it doesn't actually know the provider of, rather than
      // guessing wrong and destructively restarting it.
      const remembered = startedSessionConfigs.get(id);
      const fallback = defaultTabConfig();
      tab.provider = remembered?.provider ?? fallback.provider;
      tab.mode = remembered?.mode ?? fallback.mode;
      tab.planFirst = remembered?.planFirst ?? fallback.planFirst;
      tab.activeProvider = remembered?.provider ?? null;
      renderTabStrip();
      focusTab(tabRegistry, tab.tabId);
      renderTabStrip();
      syncFormFromTab(tab);
      clearAndReplayEventLog(tab);
      await refreshSessionList(sessionSearchInput.value.trim());
      return;
    }

    const diskRecord = record!;
    tab.events = [...diskRecord.events];
    tab.title = diskRecord.title;
    renderTabStrip();
    focusTab(tabRegistry, tab.tabId);
    renderTabStrip();
    syncFormFromTab(tab);
    clearAndReplayEventLog(tab);

    await beginSession(tab, {
      sessionId: diskRecord.id,
      initialMessages: diskRecord.messages,
      priorEvents: diskRecord.events,
      title: diskRecord.title,
      createdAt: diskRecord.createdAt,
      ownerEmail: diskRecord.ownerEmail,
    });
    tab.title = diskRecord.title;
    renderTabStrip();
  } finally {
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
    if (entry.id === activeTab(tabRegistry)?.sessionId) item.classList.add("active");
    if (findTabForSession(tabRegistry, entry.id)) item.classList.add("open-in-tab");

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
    deleteBtn.setAttribute("aria-label", `Delete session: ${entry.title}`);
    deleteBtn.textContent = "×";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void (async () => {
        await window.agent.deleteSession(entry.id);
        const tabForThisSession = findTabForSession(tabRegistry, entry.id);
        if (tabForThisSession && tabForThisSession.tabId === tabRegistry.activeTabId) {
          tabForThisSession.title = null;
          resetToSetup();
          renderTabStrip();
        } else if (tabForThisSession) {
          closeTab(tabRegistry, tabForThisSession.tabId);
          renderTabStrip();
        }
        await refreshSessionList(sessionSearchInput.value.trim());
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
  const tab = activeTab(tabRegistry);
  if (!tab?.sessionId || (!taskInput.value.trim() && tab.pendingAttachments.length === 0)) return;
  toolCards.clear();
  runTaskBtn.disabled = true;
  tab.running = true;
  const task = taskInput.value;
  const sentAttachments = tab.pendingAttachments;

  if (task.trim()) {
    logLine(task, "log-task");
    // Stored as a replayable event, not just written straight to the shared
    // DOM, so switching away from this tab mid-task and back reconstructs
    // the user's own sent message too — not just the agent's side of the
    // conversation (see AgentEvent's task.sent case, renderer-only, never
    // emitted by the agent itself).
    tab.events.push({ type: "task.sent", task });
  }
  // A read-only copy of the same chips shown under the sent task bubble,
  // so the log reflects exactly what went out — same chip look as the
  // composer's removable row, just without the × (buildAttachmentChip
  // with no onRemove argument), and appended as the log-task line's next
  // sibling rather than inside it.
  if (sentAttachments.length > 0) {
    const sentChipsRow = document.createElement("div");
    sentChipsRow.className = "attachment-chips sent";
    for (const attachment of sentAttachments) {
      sentChipsRow.appendChild(buildAttachmentChip(attachment));
    }
    eventLog.appendChild(sentChipsRow);
    eventLog.scrollTop = eventLog.scrollHeight;
  }

  const images = sentAttachments.filter((a) => a.kind === "image");
  const textAttachments = sentAttachments.filter((a) => a.kind === "text");
  const attachments = sentAttachments.length > 0
    ? {
        images: images.map((img) => ({ name: img.name, mediaType: img.mediaType, dataBase64: img.dataBase64 })),
        textAttachments: textAttachments.map((t) => ({ name: t.name, content: t.content })),
      }
    : undefined;

  tab.pendingAttachments = [];
  tab.draftTask = "";
  taskInput.value = "";
  renderAttachmentChips();
  await window.agent.runTask(tab.sessionId, task, attachments);
  await refreshSessionList(sessionSearchInput.value.trim());
});

taskInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!runTaskBtn.disabled) runTaskBtn.click();
  }
});

taskInput.addEventListener("input", () => {
  const tab = activeTab(tabRegistry);
  if (tab) tab.draftTask = taskInput.value;
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
  void syncTabTitlesFromSidebar();
});

/** Sessions get their real title only once their first task completes and they're actually saved to disk (see agent:sessions-changed) — this keeps every open tab's displayed title in sync with that, including tabs that aren't currently focused, without needing a dedicated per-session title-changed event. */
async function syncTabTitlesFromSidebar(): Promise<void> {
  if (tabRegistry.order.length === 0) return;
  const entries = await window.agent.listSessions();
  let changed = false;
  for (const entry of entries) {
    const tab = findTabForSession(tabRegistry, entry.id);
    if (tab && tab.title !== entry.title) {
      tab.title = entry.title;
      changed = true;
    }
  }
  if (changed) renderTabStrip();
}

window.agent.onCloudSyncScopeWarning(() => {
  authError.textContent = "Sign in again to keep backing up your sessions to Google Drive.";
});

updateBannerDismiss.addEventListener("click", () => {
  // Hides the banner only — a background download in progress keeps
  // downloading, and an already-downloaded update still applies itself on
  // the next natural quit either way. Dismiss is a view-layer action; the
  // state that matters lives in the main process, not the DOM.
  updateBanner.hidden = true;
});

updateBannerRestartBtn.addEventListener("click", () => {
  void window.agent.installUpdate();
});

updateBannerOpenFileBtn.addEventListener("click", () => {
  void window.agent.openUpdateFile();
});

let lastRenderedUpdateState: string | null = null;

window.agent.onUpdateStatus((status) => {
  if (status.state === "downloading") {
    updateBannerText.textContent = `Downloading update… (${status.percent}%)`;
    updateBannerRestartBtn.hidden = true;
    updateBannerOpenFileBtn.hidden = true;
    updateBannerLink.hidden = true;
  } else if (status.state === "ready") {
    updateBannerText.textContent = `Update v${status.version} ready.`;
    updateBannerRestartBtn.hidden = false;
    updateBannerOpenFileBtn.hidden = true;
    updateBannerLink.hidden = true;
  } else if (status.canOpenDownloadedFile) {
    // fallback, but the real download did complete — e.g. Squirrel.Mac
    // rejecting an unsigned Mac build's in-place apply step. Offer the
    // downloaded file directly instead of sending the user back to GitHub
    // to download the same bytes again.
    updateBannerText.textContent = `Update v${status.version} downloaded, but couldn't finish installing automatically on this build.`;
    updateBannerRestartBtn.hidden = true;
    updateBannerOpenFileBtn.hidden = false;
    updateBannerLink.hidden = true;
  } else {
    // fallback with nothing downloaded — identical to this banner's only behavior before this feature existed
    updateBannerText.textContent = `A new version (v${status.version}) is available.`;
    updateBannerLink.href = `https://github.com/lavuchandu169/localagent/releases/tag/v${status.version}`;
    updateBannerRestartBtn.hidden = true;
    updateBannerOpenFileBtn.hidden = true;
    updateBannerLink.hidden = false;
  }
  // Only force the banner back open on an actual state transition — a
  // download-progress tick re-broadcasts "downloading" many times a
  // second, and forcing hidden=false on every one of those made the
  // dismiss button impossible to use for the duration of a download.
  if (status.state !== lastRenderedUpdateState) {
    updateBanner.hidden = false;
  }
  lastRenderedUpdateState = status.state;
});

window.agent.getAuthStatus().then(renderAuthState).catch(() => {});
