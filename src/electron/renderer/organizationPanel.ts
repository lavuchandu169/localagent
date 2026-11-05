import { byId, errorMessage } from "./domHelpers.js";
import { openOverlayPanel, closeOverlayPanel } from "./overlayPanel.js";
import { EMBEDDED_MODELS } from "../../models.js";
import { buildInitiativeTask, type Organization, type Role, type Initiative } from "../../organization.js";
import type { AgentEvent } from "../../types.js";

/** Same restricted model-id set resolveRoleProviderConfig (organizationSession.ts)
 * actually supports — a role offered a model id here that the backend would
 * reject is a dead end a user could pick, so this list must stay the same
 * set, not the full renderer-wide model-select options (which also include
 * custom-server/custom-embedded, deliberately unsupported for roles; see
 * that file's own comment for why). */
const ROLE_CLOUD_MODELS: { id: string; label: string }[] = [
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-opus-5", label: "Claude Opus 5" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { id: "gpt-5-nano", label: "GPT-5 Nano" },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
];
const ROLE_FREELLMAPI_ID = "freellmapi-auto";

const organizationToggle = byId<HTMLButtonElement>("organization-toggle");
const organizationPanel = byId<HTMLDivElement>("organization-panel");
const organizationCloseX = byId<HTMLButtonElement>("organization-close-x");
const organizationClose = byId<HTMLButtonElement>("organization-close");
const organizationChooseWorkspace = byId<HTMLButtonElement>("organization-choose-workspace");
const organizationWorkspacePath = byId<HTMLSpanElement>("organization-workspace-path");
const organizationBody = byId<HTMLDivElement>("organization-body");
const organizationGoal = byId<HTMLTextAreaElement>("organization-goal");
const organizationGoalError = byId<HTMLDivElement>("organization-goal-error");
const organizationRolesList = byId<HTMLDivElement>("organization-roles-list");
const organizationRolesEmpty = byId<HTMLDivElement>("organization-roles-empty");
const organizationRolesError = byId<HTMLDivElement>("organization-roles-error");
const organizationRoleTitle = byId<HTMLInputElement>("organization-role-title");
const organizationRoleResponsibilities = byId<HTMLInputElement>("organization-role-responsibilities");
const organizationRoleModel = byId<HTMLSelectElement>("organization-role-model");
const organizationRoleReportsTo = byId<HTMLSelectElement>("organization-role-reports-to");
const organizationRoleAdd = byId<HTMLButtonElement>("organization-role-add");
const organizationInitiativesList = byId<HTMLDivElement>("organization-initiatives-list");
const organizationInitiativesEmpty = byId<HTMLDivElement>("organization-initiatives-empty");
const organizationInitiativesError = byId<HTMLDivElement>("organization-initiatives-error");
const organizationInitiativeTitle = byId<HTMLInputElement>("organization-initiative-title");
const organizationInitiativeRole = byId<HTMLSelectElement>("organization-initiative-role");
const organizationInitiativeAdd = byId<HTMLButtonElement>("organization-initiative-add");

let workspaceRoot: string | null = null;
let org: Organization = { goal: "", roles: [], initiatives: [] };
/** Which initiatives are actively running right now, and the latest
 * status line to show under each — purely local UI state, never
 * persisted (the organization.json backlog only ever records
 * todo/in-progress/done, not a live transcript). */
const runningStatus = new Map<string, string>();
let unsubscribeEvents: (() => void) | null = null;
let unsubscribeSessionStarted: (() => void) | null = null;
const initiativeIdBySessionId = new Map<string, string>();

export interface OrganizationPanelDeps {
  closeOtherFullScreenModals: () => void;
  /**
   * Opens (or focuses, if a tab for it already exists) a real session tab
   * for an initiative's just-started role session, so the user sees its
   * full transcript and can approve/deny its permission requests like any
   * other session. Without this, "Run as <role>" only ever showed this
   * panel's own one-line inline status (see describeEventForStatus/
   * runningStatus below) — which has no way at all to surface an approval
   * UI, so any initiative whose role actually needed to write a file or
   * run a command would hang forever with no one able to respond.
   *
   * Called as soon as onOrganizationSessionStarted fires below, which is
   * guaranteed to happen before any of that session's own agent:event
   * messages can arrive — see main.ts's organization:run-initiative
   * handler, where onSessionStarted always fires (and sends
   * organization:session-started) before runTask's first event, and
   * startInitiativeSession's own doc comment on why that ordering holds.
   */
  openSessionTab: (params: { sessionId: string; workspaceRoot: string; task: string; title: string }) => void;
}

export function isOrganizationPanelOpen(): boolean {
  return !organizationPanel.hidden;
}

export function closeOrganizationPanel(): void {
  closeOverlayPanel(organizationPanel);
  organizationToggle.setAttribute("aria-expanded", "false");
  organizationToggle.focus();
}

function populateRoleModelSelect(select: HTMLSelectElement): void {
  select.replaceChildren();
  const embeddedGroup = document.createElement("optgroup");
  embeddedGroup.label = "Embedded (offline)";
  for (const [id, info] of Object.entries(EMBEDDED_MODELS)) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = info.name;
    embeddedGroup.appendChild(opt);
  }
  select.appendChild(embeddedGroup);

  const freeOpt = document.createElement("option");
  freeOpt.value = ROLE_FREELLMAPI_ID;
  freeOpt.textContent = "Free-tier router (34 providers)";
  select.appendChild(freeOpt);

  const cloudGroup = document.createElement("optgroup");
  cloudGroup.label = "Cloud (your own key)";
  for (const { id, label } of ROLE_CLOUD_MODELS) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = label;
    cloudGroup.appendChild(opt);
  }
  select.appendChild(cloudGroup);
}

function populateReportsToSelect(select: HTMLSelectElement, excludeRoleId?: string): void {
  const keep = select.value;
  select.replaceChildren();
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "Reports to: nobody";
  select.appendChild(none);
  for (const role of org.roles) {
    if (role.id === excludeRoleId) continue;
    const opt = document.createElement("option");
    opt.value = role.id;
    opt.textContent = role.title;
    select.appendChild(opt);
  }
  select.value = keep;
}

function populateInitiativeRoleSelect(select: HTMLSelectElement): void {
  const keep = select.value;
  select.replaceChildren();
  const none = document.createElement("option");
  none.value = "";
  none.textContent = org.roles.length === 0 ? "No roles yet" : "Unassigned";
  select.appendChild(none);
  for (const role of org.roles) {
    const opt = document.createElement("option");
    opt.value = role.id;
    opt.textContent = role.title;
    select.appendChild(opt);
  }
  select.value = keep;
}

/** Every row below is built via createElement/.textContent, never
 * innerHTML — role/initiative text is user-typed content (same
 * convention mcpServersPanel.ts's renderMcpServerRow already
 * establishes for this codebase). */
function renderRoles(): void {
  organizationRolesList.replaceChildren();
  organizationRolesEmpty.hidden = org.roles.length > 0;
  for (const role of org.roles) {
    const row = document.createElement("div");
    row.className = "organization-row";

    const titleSpan = document.createElement("span");
    titleSpan.className = "organization-row-title";
    titleSpan.textContent = role.title;

    const detailSpan = document.createElement("span");
    detailSpan.className = "hint-text";
    const reportsToRole = role.reportsTo ? org.roles.find((r) => r.id === role.reportsTo) : undefined;
    detailSpan.textContent = `${role.responsibilities || "(no responsibilities set)"} — ${role.model}${reportsToRole ? ` — reports to ${reportsToRole.title}` : ""}`;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => removeRole(role.id));

    row.append(titleSpan, detailSpan, removeBtn);
    organizationRolesList.appendChild(row);
  }
  populateReportsToSelect(organizationRoleReportsTo);
  populateInitiativeRoleSelect(organizationInitiativeRole);
}

function statusLabel(status: Initiative["status"]): string {
  return status === "todo" ? "To do" : status === "in-progress" ? "In progress" : "Done";
}

function renderInitiatives(): void {
  organizationInitiativesList.replaceChildren();
  organizationInitiativesEmpty.hidden = org.initiatives.length > 0;
  for (const initiative of org.initiatives) {
    const row = document.createElement("div");
    row.className = "organization-row";

    const titleSpan = document.createElement("span");
    titleSpan.className = "organization-row-title";
    titleSpan.textContent = initiative.title;

    const role = initiative.assignedRoleId ? org.roles.find((r) => r.id === initiative.assignedRoleId) : undefined;
    const statusSpan = document.createElement("span");
    statusSpan.className = "hint-text";
    const live = runningStatus.get(initiative.id);
    statusSpan.textContent = live ?? `${role ? role.title : "Unassigned"} — ${statusLabel(initiative.status)}`;

    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.textContent = runningStatus.has(initiative.id) ? "Running…" : "Run as " + (role ? role.title : "…");
    runBtn.disabled = !role || runningStatus.has(initiative.id);
    runBtn.addEventListener("click", () => runInitiative(initiative.id));

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "Remove";
    removeBtn.disabled = runningStatus.has(initiative.id);
    removeBtn.addEventListener("click", () => removeInitiative(initiative.id));

    row.append(titleSpan, statusSpan, runBtn, removeBtn);
    organizationInitiativesList.appendChild(row);
  }
}

async function persist(): Promise<boolean> {
  if (!workspaceRoot) return false;
  const result = await window.agent.saveOrganization(workspaceRoot, org);
  if (!result.ok) {
    organizationGoalError.textContent = `Could not save: ${result.error}`;
    return false;
  }
  organizationGoalError.textContent = "";
  return true;
}

async function saveGoal(): Promise<void> {
  org = { ...org, goal: organizationGoal.value };
  await persist();
}

async function addRole(): Promise<void> {
  const title = organizationRoleTitle.value.trim();
  if (!title) {
    organizationRolesError.textContent = "A title is required.";
    return;
  }
  const role: Role = {
    id: crypto.randomUUID(),
    title,
    responsibilities: organizationRoleResponsibilities.value.trim(),
    model: organizationRoleModel.value,
    reportsTo: organizationRoleReportsTo.value || null,
  };
  org = { ...org, roles: [...org.roles, role] };
  organizationRolesError.textContent = "";
  organizationRoleTitle.value = "";
  organizationRoleResponsibilities.value = "";
  renderRoles();
  renderInitiatives();
  if (!(await persist())) organizationRolesError.textContent = organizationGoalError.textContent;
}

async function removeRole(roleId: string): Promise<void> {
  org = {
    ...org,
    roles: org.roles.filter((r) => r.id !== roleId),
    // An initiative assigned to a removed role becomes unassigned rather
    // than pointing at a role that no longer exists.
    initiatives: org.initiatives.map((i) => (i.assignedRoleId === roleId ? { ...i, assignedRoleId: null } : i)),
  };
  renderRoles();
  renderInitiatives();
  await persist();
}

async function addInitiative(): Promise<void> {
  const title = organizationInitiativeTitle.value.trim();
  if (!title) {
    organizationInitiativesError.textContent = "A title is required.";
    return;
  }
  const initiative: Initiative = {
    id: crypto.randomUUID(),
    title,
    assignedRoleId: organizationInitiativeRole.value || null,
    status: "todo",
    notes: "",
  };
  org = { ...org, initiatives: [...org.initiatives, initiative] };
  organizationInitiativesError.textContent = "";
  organizationInitiativeTitle.value = "";
  renderInitiatives();
  if (!(await persist())) organizationInitiativesError.textContent = organizationGoalError.textContent;
}

async function removeInitiative(initiativeId: string): Promise<void> {
  org = { ...org, initiatives: org.initiatives.filter((i) => i.id !== initiativeId) };
  renderInitiatives();
  await persist();
}

function applyInitiativeUpdate(initiativeId: string, patch: Partial<Pick<Initiative, "status" | "notes">>): void {
  org = { ...org, initiatives: org.initiatives.map((i) => (i.id === initiativeId ? { ...i, ...patch } : i)) };
}

async function runInitiative(initiativeId: string): Promise<void> {
  if (!workspaceRoot || runningStatus.has(initiativeId)) return;
  runningStatus.set(initiativeId, "Starting…");
  applyInitiativeUpdate(initiativeId, { status: "in-progress" });
  renderInitiatives();
  await persist();

  try {
    const result = await window.agent.runInitiative(workspaceRoot, initiativeId);
    if (result.ok) {
      applyInitiativeUpdate(initiativeId, { status: "done", notes: "" });
    } else {
      applyInitiativeUpdate(initiativeId, { status: "todo", notes: result.error });
      organizationInitiativesError.textContent = result.error;
    }
  } catch (err) {
    applyInitiativeUpdate(initiativeId, { status: "todo", notes: errorMessage(err) });
    organizationInitiativesError.textContent = errorMessage(err);
  } finally {
    runningStatus.delete(initiativeId);
    for (const [sid, iid] of initiativeIdBySessionId) if (iid === initiativeId) initiativeIdBySessionId.delete(sid);
    renderInitiatives();
    await persist();
  }
}

/** Turns one streamed AgentEvent into a short, human-readable status
 * line — the same spirit as the main session transcript's own per-event
 * rendering, just condensed to a single line since this panel only ever
 * shows the latest state, not a full history. */
function describeEventForStatus(event: AgentEvent): string | null {
  switch (event.type) {
    case "status":
      return event.message;
    case "tool.start":
      return `Running ${event.call.name}…`;
    case "permission.request":
      return event.decision === "ASK" ? `Waiting for approval: ${event.call.name}` : null;
    case "text":
      return event.text.slice(0, 80);
    case "done":
      return event.success ? "Done." : `Failed: ${event.summary}`;
    default:
      return null;
  }
}

async function loadAndRender(): Promise<void> {
  if (!workspaceRoot) return;
  org = await window.agent.loadOrganization(workspaceRoot);
  organizationGoal.value = org.goal;
  renderRoles();
  renderInitiatives();
}

async function chooseWorkspace(): Promise<void> {
  const picked = await window.agent.pickWorkspace();
  if (!picked) return;
  workspaceRoot = picked;
  organizationWorkspacePath.textContent = picked;
  organizationBody.hidden = false;
  await loadAndRender();
}

export function openOrganizationPanel(deps: OrganizationPanelDeps): void {
  deps.closeOtherFullScreenModals();
  openOverlayPanel(organizationPanel);
  organizationToggle.setAttribute("aria-expanded", "true");
  populateRoleModelSelect(organizationRoleModel);
}

export function initOrganizationPanel(deps: OrganizationPanelDeps): void {
  organizationToggle.addEventListener("click", () => {
    if (isOrganizationPanelOpen()) closeOrganizationPanel();
    else openOrganizationPanel(deps);
  });
  organizationCloseX.addEventListener("click", closeOrganizationPanel);
  organizationClose.addEventListener("click", closeOrganizationPanel);
  organizationChooseWorkspace.addEventListener("click", () => void chooseWorkspace());
  organizationGoal.addEventListener("blur", () => void saveGoal());
  organizationRoleAdd.addEventListener("click", () => void addRole());
  organizationInitiativeAdd.addEventListener("click", () => void addInitiative());

  unsubscribeSessionStarted = window.agent.onOrganizationSessionStarted((sessionId, initiativeId) => {
    initiativeIdBySessionId.set(sessionId, initiativeId);
    // Open the real tab right away, synchronously within this callback —
    // no agent:event for this sessionId can have arrived yet (see this
    // field's own doc comment on OrganizationPanelDeps.openSessionTab for
    // why that ordering is guaranteed), so there's no window in which an
    // early event gets silently dropped by routeEvent for lack of a
    // matching open tab.
    const initiative = org.initiatives.find((i) => i.id === initiativeId);
    const role = initiative?.assignedRoleId ? org.roles.find((r) => r.id === initiative.assignedRoleId) : undefined;
    if (initiative && role && workspaceRoot) {
      deps.openSessionTab({
        sessionId,
        workspaceRoot,
        task: buildInitiativeTask(org, initiative, role),
        title: `${role.title}: ${initiative.title}`,
      });
    }
  });
  unsubscribeEvents = window.agent.onEvent((sessionId, event) => {
    const initiativeId = initiativeIdBySessionId.get(sessionId);
    if (!initiativeId || !runningStatus.has(initiativeId)) return;
    const label = describeEventForStatus(event);
    if (label) {
      runningStatus.set(initiativeId, label);
      renderInitiatives();
    }
  });
}
