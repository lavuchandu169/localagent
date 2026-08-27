import type { AgentEvent, ChatMessage, PermissionMode, ToolCall } from "../../types.js";
import type { ProviderConfig, SessionConfig } from "../sessionRegistry.js";
import { MODE_LABELS } from "../modeLabels.js";
import { EMBEDDED_MODELS } from "../../models.js";

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
}

interface SessionRecord {
  id: string;
  title: string;
  messages: ChatMessage[];
  events: AgentEvent[];
  createdAt: number;
  updatedAt: number;
}

interface ResumePayload {
  sessionId: string;
  initialMessages: ChatMessage[];
  priorEvents: AgentEvent[];
  title: string;
  createdAt: number;
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
  getHardwareInfo(): Promise<HardwareInfo>;
  googleSignIn(): Promise<SignInResult>;
  signOut(): Promise<void>;
  getAuthStatus(): Promise<AuthStatus>;
  listSessions(): Promise<SessionIndexEntry[]>;
  searchSessions(query: string): Promise<SessionIndexEntry[]>;
  loadSession(id: string): Promise<SessionRecord | null>;
  deleteSession(id: string): Promise<void>;
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
const activeModelBadge = byId<HTMLDivElement>("active-model-badge");
const sidebarSessionList = byId<HTMLDivElement>("session-list");
const sessionListEmpty = byId<HTMLDivElement>("session-list-empty");
const sessionSearchInput = byId<HTMLInputElement>("session-search");
const newSessionBtn = byId<HTMLButtonElement>("new-session-btn");

let workspaceRoot: string | null = null;
let sessionId: string | null = null;
let hardwareInfo: HardwareInfo | null = null;
const toolCards = new Map<string, HTMLElement>();

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

Promise.all([window.agent.listCachedModels(), window.agent.getHardwareInfo()]).then(([cached, hw]) => {
  hardwareInfo = hw;
  const ramGb = (hw.totalRamBytes / 1024 ** 3).toFixed(0);
  aboutHardware.textContent = hw.gpu ? `${ramGb}GB RAM · ${hw.gpu} GPU` : `${ramGb}GB RAM · CPU only`;
  for (const option of Array.from(embeddedSizeSelect.options)) {
    const suffixes: string[] = [];
    if (option.value === hw.recommended) suffixes.push("recommended for this machine");
    if (cached[option.value]) suffixes.push("downloaded");
    if (suffixes.length > 0) option.textContent += ` · ${suffixes.join(", ")}`;
    // Informational only — shows what fits the machine without changing the user's selection.
  }
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

async function beginSession(resume?: ResumePayload): Promise<void> {
  startError.textContent = "";

  const useAnthropic = advancedDisclosure.open && advancedProviderAnthropic.checked;
  const useExternal = advancedDisclosure.open && advancedProviderExternal.checked && baseUrlInput.value.trim().length > 0;
  const provider: ProviderConfig = useAnthropic
    ? { kind: "anthropic" }
    : useExternal
      ? { kind: "openai-compatible", baseUrl: baseUrlInput.value.trim(), model: externalModelInput.value.trim() }
      : { kind: "embedded", size: embeddedSizeSelect.value };

  // workspaceRoot omitted entirely when none was picked — startSession defaults
  // it to the home directory and hands back whichever path it actually used.
  const config: SessionConfig = { ...(workspaceRoot ? { workspaceRoot } : {}), provider, mode: modeSelect.value as PermissionMode };

  startSessionBtn.disabled = true;
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
    // All setup controls lock here, not just Start: Foundation has no way to
    // apply a changed workspace/provider/mode to an already-running session,
    // so leaving them interactive would let the displayed value silently
    // drift from what the session actually started with.
    chooseWorkspaceBtn.disabled = true;
    embeddedSizeSelect.disabled = true;
    modeSelect.disabled = true;
    baseUrlInput.disabled = true;
    externalModelInput.disabled = true;
    advancedProviderExternal.disabled = true;
    advancedProviderAnthropic.disabled = true;

    const modelText =
      provider.kind === "embedded"
        ? EMBEDDED_MODELS[provider.size as keyof typeof EMBEDDED_MODELS]?.description ?? provider.size
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
    startError.textContent = err?.message ?? String(err);
    startSessionBtn.disabled = false;
  } finally {
    downloadProgressRow.hidden = true;
    progressLastTime = 0;
  }
}

startSessionBtn.addEventListener("click", () => void beginSession());

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
  clearEventLog();
  taskInput.value = "";
  taskInput.disabled = true;
  runTaskBtn.disabled = true;
  activeModelBadge.hidden = true;
  startError.textContent = "";
  workspacePathEl.textContent = "No workspace selected — optional, you can just chat";
  aboutWorkspace.textContent = "(none selected)";
  chooseWorkspaceBtn.disabled = false;
  embeddedSizeSelect.disabled = false;
  modeSelect.disabled = false;
  baseUrlInput.disabled = false;
  externalModelInput.disabled = false;
  advancedProviderExternal.disabled = false;
  advancedProviderAnthropic.disabled = false;
  startSessionBtn.disabled = false;
  void refreshSessionList(sessionSearchInput.value.trim());
}

newSessionBtn.addEventListener("click", resetToSetup);

async function resumeSession(id: string): Promise<void> {
  const record = await window.agent.loadSession(id);
  if (!record) {
    startError.textContent = "Couldn't load this session — the saved file looks corrupted.";
    return;
  }

  if (sessionId) {
    await window.agent.cancelSession(sessionId);
  }

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
  });
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
    label.addEventListener("click", () => void resumeSession(entry.id));

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

googleSignInBtn.addEventListener("click", async () => {
  authError.textContent = "";
  googleSignInBtn.disabled = true;
  try {
    const result = await window.agent.googleSignIn();
    if ("error" in result) {
      authError.textContent = result.error;
    } else {
      renderAuthState({ signedIn: true, ...result });
    }
  } finally {
    googleSignInBtn.disabled = false;
  }
});

signOutBtn.addEventListener("click", async () => {
  authError.textContent = "";
  signOutBtn.disabled = true;
  try {
    await window.agent.signOut();
    renderAuthState({ signedIn: false });
  } catch (err) {
    authError.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    signOutBtn.disabled = false;
  }
});

window.agent.getAuthStatus().then(renderAuthState).catch(() => {});
