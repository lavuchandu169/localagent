import crypto from "node:crypto";
import os from "node:os";
import { AgentSession } from "../agent.js";
import { defaultToolRegistry } from "../toolRegistry.js";
import { OpenAICompatibleProvider } from "../providers/openaiCompatible.js";
import { EmbeddedLlamaProvider } from "../providers/embeddedLlama.js";
import { AnthropicProvider } from "../providers/anthropicProvider.js";
import { OpenAIProvider } from "../providers/openaiProvider.js";
import { GeminiProvider } from "../providers/geminiProvider.js";
import { FreellmapiProxyProvider } from "../providers/freellmapiProxy.js";
import { isEmbeddedModelId } from "../models.js";
import { saveSession, deleteSession, loadSessionRecord, type SessionRecord, type PersistedProviderConfig, type SessionIndexEntry } from "../sessionStore.js";
import { uploadSession as driveUploadSession, deleteRemoteSession as driveDeleteRemoteSession, DriveScopeError } from "../cloudSync.js";
import type { AgentEvent, AttachedImage, AttachedText, ChatMessage, ModelProvider, PermissionMode, PermissionResponse, Tool } from "../types.js";
import { isEphemeralStreamEvent } from "../types.js";
import { revertToCheckpoint } from "../checkpoints.js";
import { getChanges, type FileChangeWithDiff } from "../changesSince.js";
import { resolveFallbackOrder, DEFAULT_MODEL_BY_KIND as DEFAULT_MODEL_BY_CLOUD_KIND, type CloudProviderKind } from "./providerFallback.js";
import type { StorageCrypto } from "./googleAuth.js";

export type ProviderConfig =
  | { kind: "openai-compatible"; baseUrl: string; model: string }
  | { kind: "embedded"; size: string }
  | { kind: "anthropic"; apiKey?: string; model?: string }
  | { kind: "openai"; apiKey?: string; model?: string }
  | { kind: "gemini"; apiKey?: string; model?: string }
  | { kind: "freellmapi"; userDataDir?: string };

const CLOUD_LABEL_BY_KIND: Record<CloudProviderKind, string> = {
  anthropic: "Claude",
  openai: "OpenAI",
  gemini: "Gemini",
};

export interface SessionConfig {
  /** Omit to chat without file access — defaults to the home directory. */
  workspaceRoot?: string;
  provider: ProviderConfig;
  mode: PermissionMode;
  /** When true, every task's first turn is held for approval before executing — see AgentSessionOptions.planFirst. Omitted/false preserves today's behavior. */
  planFirst?: boolean;
}

export type ModelDownloadProgress = { totalSize: number; downloadedSize: number };

/** Everything needed to resume a previously-saved session with full context, reusing its original id. */
export interface ResumePayload {
  sessionId: string;
  initialMessages: ChatMessage[];
  priorEvents: AgentEvent[];
  title: string;
  createdAt: number;
  ownerEmail: string | null;
  /** Correctness audit finding (session High #2): without this, a resumed session always starts with no checkpoint — "Revert this task" silently disappears across an app restart. Null for a session that never took one. */
  checkpointHash: string | null;
  /** Final-review finding C3: the workspace checkpointHash was actually made in — startSession only restores the hash when this matches the workspace the session is about to run in (config.workspaceRoot below), refusing it outright otherwise rather than risking a revert against the wrong repo. See SessionRecord.checkpointWorkspaceRoot. */
  checkpointWorkspaceRoot: string | null;
}

/** Best-effort cloud sync wiring, supplied by main.ts. uploadSession/deleteRemoteSession default to the real Drive-backed implementations — tests override them directly instead of faking fetch. */
export interface CloudSyncConfig {
  getAccessToken: () => Promise<string | null>;
  onScopeError: () => void;
  uploadSession?: (accessToken: string, record: SessionRecord) => Promise<{ modifiedTime: string }>;
  deleteRemoteSession?: (accessToken: string, sessionId: string) => Promise<void>;
  /** Cheap, no-network read of the currently signed-in account's email (or null if signed out) — stamped onto every saved session as its owner, so the UI can later filter local history by account. */
  getOwnerEmail: () => Promise<string | null>;
}

interface SessionEntry {
  session: AgentSession;
  provider: ModelProvider;
  pendingApprovals: Map<string, (response: PermissionResponse) => void>;
  /** At most one pending plan approval per session (only turn 1 of a task is ever gated) — a mutable single-slot object rather than a Map, wired into AgentSession's onPlanApprovalNeeded before this entry exists (see startSession), same reason pendingApprovals is a pre-built Map rather than something attached after the fact. */
  pendingPlanApproval: { resolve: ((approved: boolean) => void) | null };
  events: AgentEvent[];
  title: string | null;
  createdAt: number;
  deleted: boolean;
  /** The currently in-flight runTask() call, if any — awaited by finalizeEntry before disposing the provider, so a model's native resources are never freed while it's still mid-generation. */
  running: Promise<void> | null;
  /** Fixed once at session creation (or carried over from a resumed session's prior record) — never re-derived from "whoever's currently signed in" on every save, so signing out or switching accounts mid-conversation can't silently strip ownership from an already-owned session. */
  ownerEmail: string | null;
  /** Fixed once at session creation — the provider/model never change for a live session's lifetime (editing either requires cancelSession + startSession(resume) instead, per updateLiveSessionSettings's own doc comment), so caching this here (rather than trying to derive it from the live ModelProvider instance, which has no clean way back to the original ProviderConfig "kind") is always accurate. Correctness audit finding (session High #1): persisted alongside mode/planFirst so resuming a session restores its real settings instead of silently falling back to a form's current defaults. */
  providerConfig: PersistedProviderConfig;
}

/** Strips the API key (if any) before caching/persisting — see PersistedProviderConfig's own doc comment for why a key never belongs here. */
function toPersistedProviderConfig(config: ProviderConfig): PersistedProviderConfig {
  switch (config.kind) {
    case "openai-compatible":
      return { kind: "openai-compatible", baseUrl: config.baseUrl, model: config.model };
    case "embedded":
      return { kind: "embedded", size: config.size };
    case "anthropic":
    case "openai":
    case "gemini":
      return { kind: config.kind, model: config.model };
    case "freellmapi":
      return { kind: "freellmapi" };
  }
}

export interface SessionRegistry {
  sessions: Map<string, SessionEntry>;
  sessionsDir: string;
  cloudSync?: CloudSyncConfig;
  /** Correctness audit finding (session Medium #4): fired whenever any session's pending permission/plan approval starts, gets answered, or is swept away (session cancelled/deleted) — lets main.ts rebroadcast agent:sessions-changed so the sidebar's "waiting for approval" indicator (see getSessionIdsWithPendingApproval) stays live even for a session with no tab currently open. */
  onPendingApprovalsChanged?: () => void;
}

export function createSessionRegistry(sessionsDir: string, cloudSync?: CloudSyncConfig, onPendingApprovalsChanged?: () => void): SessionRegistry {
  return { sessions: new Map(), sessionsDir, cloudSync, onPendingApprovalsChanged };
}

/**
 * Correctness audit finding (session Medium #4): closing the tab for a
 * session with an in-flight permission or plan approval doesn't cancel
 * that approval — the task just sits there forever, waiting for a click
 * nothing can ever send again, with no record of this anywhere the user
 * would see it. Surfaces exactly which live sessions are in that state
 * right now, so callers (main.ts's agent:list-sessions) can flag them for
 * the sidebar, independent of whether any tab is open for them.
 */
export function getSessionIdsWithPendingApproval(registry: SessionRegistry): Set<string> {
  const ids = new Set<string>();
  for (const [id, entry] of registry.sessions) {
    if (entry.pendingApprovals.size > 0 || entry.pendingPlanApproval.resolve !== null) ids.add(id);
  }
  return ids;
}

export type SessionIndexEntryWithApproval = SessionIndexEntry & { waitingForApproval: boolean };

/**
 * Merges live waitingForApproval state onto a disk-backed session list —
 * a session can have a dangling, unanswerable approval with no tab open
 * for it at all, so this can't be derived from anything the renderer
 * already tracks per-tab.
 *
 * Final-review finding I4: a session's disk record is only ever written
 * once a task completes (persistSession) — a BRAND NEW session whose
 * very first task is still waiting on an approval has no disk record at
 * all yet, so flagging only EXISTING entries left it invisible no matter
 * what. Synthesizes a minimal row straight from the live registry for
 * exactly that case, filtered by the same owner (and, when `query` is
 * given, the same title-substring match) the disk-backed list already
 * applies, so it never leaks across accounts or defeats a search.
 */
export function withPendingApprovalEntries(registry: SessionRegistry, entries: SessionIndexEntry[], email: string | null, query?: string): SessionIndexEntryWithApproval[] {
  const pendingIds = getSessionIdsWithPendingApproval(registry);
  const flagged: SessionIndexEntryWithApproval[] = entries.map((e) => ({ ...e, waitingForApproval: pendingIds.has(e.id) }));
  const existingIds = new Set(entries.map((e) => e.id));
  const trimmedQuery = query?.trim().toLowerCase();
  for (const id of pendingIds) {
    if (existingIds.has(id)) continue;
    const liveEntry = registry.sessions.get(id);
    if (!liveEntry || liveEntry.ownerEmail !== email) continue;
    const title = liveEntry.title ?? "(untitled)";
    if (trimmedQuery && !title.toLowerCase().includes(trimmedQuery)) continue;
    flagged.push({ id, title, updatedAt: liveEntry.createdAt, ownerEmail: liveEntry.ownerEmail, waitingForApproval: true });
  }
  return flagged;
}

/** Mirrors the provider construction in cli.ts's --base-url branch. `signal` only matters for the embedded provider — it's the model download's cancellation handle; the other two providers make no download, so they simply ignore it. */
export function buildProvider(
  config: ProviderConfig,
  onDownloadProgress?: (status: ModelDownloadProgress) => void,
  signal?: AbortSignal
): ModelProvider {
  if (config.kind === "openai-compatible") {
    return new OpenAICompatibleProvider({ baseUrl: config.baseUrl, local: true });
  }
  if (config.kind === "anthropic") {
    return new AnthropicProvider({ apiKey: config.apiKey, model: config.model });
  }
  if (config.kind === "openai") {
    return new OpenAIProvider({ apiKey: config.apiKey ?? "", model: config.model });
  }
  if (config.kind === "gemini") {
    return new GeminiProvider({ apiKey: config.apiKey ?? "", model: config.model });
  }
  if (config.kind === "freellmapi") {
    // Always provided by main.ts's resolvedConfig ternary before a real
    // session starts — this only fires if some other future caller (a
    // test, a hypothetical CLI path) constructs this config directly
    // without going through that resolution step. Silently falling back
    // to "" the way apiKey does for openai/gemini would be actively
    // wrong here: it'd point the vendored server at a nonsensical DB
    // path instead of just running with no key configured.
    if (!config.userDataDir) {
      throw new Error("freellmapi provider config is missing userDataDir — main.ts must resolve it before starting a session.");
    }
    return new FreellmapiProxyProvider({ userDataDir: config.userDataDir });
  }
  if (!isEmbeddedModelId(config.size) && !config.size.startsWith("hf:")) {
    throw new Error(`Invalid embedded model size: ${config.size}`);
  }
  return new EmbeddedLlamaProvider({ size: config.size, onDownloadProgress, signal });
}

export async function startSession(
  registry: SessionRegistry,
  config: SessionConfig,
  deps: {
    providerFactory?: (c: ProviderConfig, onDownloadProgress?: (status: ModelDownloadProgress) => void, signal?: AbortSignal) => ModelProvider;
    onDownloadProgress?: (status: ModelDownloadProgress) => void;
    /** Lets the caller cancel an in-progress embedded-model download — see buildProvider. */
    signal?: AbortSignal;
    resume?: ResumePayload;
    /** Live getter for currently-connected MCP servers' tools (plus the
     * GitHub tools), supplied by main.ts — see mcpClient.ts/mcpToolAdapter.ts.
     * A function, not a snapshot array (correctness audit finding, MCP
     * Medium): ToolRegistry re-calls this on every lookup rather than
     * caching its result once, so an MCP server disconnected or removed
     * after this session starts stops being callable on the very next
     * turn instead of staying stale for the session's whole life. Defaults
     * to none, so every existing caller/test is unaffected. */
    getExtraTools?: () => Tool[];
    /** Directory holding anthropic-settings.json/openai-settings.json/gemini-settings.json — passed so startSession can resolve fallback candidates via providerFallback.ts. Undefined (every existing caller/test that doesn't care about fallback) means no fallback is ever configured, exactly like today's behavior. */
    settingsDir?: string;
    storageCrypto?: StorageCrypto;
    getGithubToken?: () => Promise<string | null>;
  } = {}
): Promise<{ sessionId: string; workspaceRoot: string; checkpointHash: string | null }> {
  const provider = (deps.providerFactory ?? buildProvider)(config.provider, deps.onDownloadProgress, deps.signal);
  const health = await provider.healthCheck();
  if (!health.ok) {
    throw new Error(`Could not start provider "${provider.id}": ${health.error}`);
  }

  const sessionId = deps.resume?.sessionId ?? crypto.randomUUID();
  const pendingApprovals = new Map<string, (response: PermissionResponse) => void>();
  const pendingPlanApproval: { resolve: ((approved: boolean) => void) | null } = { resolve: null };
  const workspaceRoot = config.workspaceRoot ?? os.homedir();

  // Starting a session under an id that's already live (a resume of a
  // session whose previous in-memory entry was never cleaned up) must not
  // leak the old entry's model — tear it down first.
  const existing = registry.sessions.get(sessionId);
  if (existing) {
    await finalizeEntry(registry, existing);
  }

  const CLOUD_KINDS: CloudProviderKind[] = ["anthropic", "openai", "gemini"];
  const isCloudPrimary = (CLOUD_KINDS as string[]).includes(config.provider.kind);
  // freellmapi is never itself a CloudProviderKind (no per-provider
  // settings file, never a valid fallback TARGET — cloud providers don't
  // fall back to it), but the spec requires the opposite direction: when
  // the free-tier router comes back exhausted, fall back to whatever cloud
  // provider the user has configured. excludeKind: undefined here means
  // "every configured cloud provider is a candidate", not "exclude none of
  // three minus itself" — freellmapi isn't in that set to begin with.
  const isFreellmapiPrimary = config.provider.kind === "freellmapi";
  let fallbackProviders: { provider: ModelProvider; model: string; label: string }[] | undefined;
  if (deps.settingsDir && (isCloudPrimary || isFreellmapiPrimary)) {
    const candidates = await resolveFallbackOrder(
      deps.settingsDir,
      deps.storageCrypto,
      isCloudPrimary ? (config.provider.kind as CloudProviderKind) : undefined
    );
    // Goes through the same providerFactory injection point the primary
    // provider does (not a bare buildProvider() call) — a fallback
    // candidate is still a provider a caller/test may need to substitute,
    // and building it any other way would make fallback behavior
    // impossible to exercise without a real network call.
    fallbackProviders = candidates.map((c) => ({
      provider: (deps.providerFactory ?? buildProvider)({ kind: c.kind, apiKey: c.apiKey, model: c.model } as ProviderConfig),
      model: c.model,
      label: CLOUD_LABEL_BY_KIND[c.kind],
    }));
  }
  const providerLabel = isCloudPrimary
    ? CLOUD_LABEL_BY_KIND[config.provider.kind as CloudProviderKind]
    : isFreellmapiPrimary
      ? "The free-tier router"
      : undefined;

  const session = new AgentSession({
    workspaceRoot,
    model:
      config.provider.kind === "openai-compatible"
        ? config.provider.model
        : config.provider.kind === "anthropic" || config.provider.kind === "openai" || config.provider.kind === "gemini"
          ? (config.provider.model ?? DEFAULT_MODEL_BY_CLOUD_KIND[config.provider.kind])
          : config.provider.kind === "freellmapi"
            ? "auto"
            : config.provider.size,
    provider,
    tools: defaultToolRegistry(deps.getExtraTools ?? (() => [])),
    getGithubToken: deps.getGithubToken,
    permissionMode: config.mode,
    initialMessages: deps.resume?.initialMessages,
    onApprovalNeeded: (call) =>
      new Promise<PermissionResponse>((resolve) => {
        pendingApprovals.set(call.id, resolve);
        registry.onPendingApprovalsChanged?.();
      }),
    planFirst: config.planFirst,
    onPlanApprovalNeeded: () =>
      new Promise<boolean>((resolve) => {
        pendingPlanApproval.resolve = resolve;
        registry.onPendingApprovalsChanged?.();
      }),
    fallbackProviders,
    providerLabel,
    // Final-review finding C3: only restore the checkpoint when it was
    // actually made in THIS workspace — a resumed session or a
    // provider-change mid-session restart can land in a workspace the
    // old checkpoint hash doesn't belong to at all (SessionRecord never
    // used to persist workspaceRoot, so a resume just runs in whatever
    // the tab currently shows). Usually a mismatched hash just makes a
    // later `git checkout` fail, but git worktrees of the same repo share
    // one object database — there it can resolve successfully in the
    // WRONG worktree and overwrite its files. A legacy record (no
    // checkpointWorkspaceRoot recorded at all) is treated as "unknown",
    // which never matches, same safe default as discarding the checkpoint.
    initialCheckpointHash: deps.resume && deps.resume.checkpointWorkspaceRoot === workspaceRoot ? deps.resume.checkpointHash : null,
  });

  // Fixed once here: a resumed session keeps its original owner regardless
  // of who's signed in right now; a brand-new session is stamped with
  // whoever's signed in at the moment it's created, once, not re-derived
  // on every later save (see the field's own doc comment).
  const ownerEmail = deps.resume ? deps.resume.ownerEmail : registry.cloudSync ? await registry.cloudSync.getOwnerEmail() : null;

  registry.sessions.set(sessionId, {
    session,
    provider,
    pendingApprovals,
    pendingPlanApproval,
    events: deps.resume ? [...deps.resume.priorEvents] : [],
    title: deps.resume?.title ?? null,
    createdAt: deps.resume?.createdAt ?? Date.now(),
    deleted: false,
    running: null,
    ownerEmail,
    providerConfig: toPersistedProviderConfig(config.provider),
  });
  // Final-review finding I3: lets the renderer show "Revert this task"
  // immediately on a successful resume with a real, workspace-matching
  // checkpoint, instead of only after a later tab-switch happens to
  // replay a stale checkpoint.created event from the old task's history
  // (beginSession's own "fresh session" code otherwise unconditionally
  // hides the button, assuming there's nothing to revert yet).
  return { sessionId, workspaceRoot, checkpointHash: session.getCheckpointHash() };
}

/**
 * Updates an active session's workspace and/or permission mode in place —
 * deliberately the ONLY way to change a live session's settings without
 * tearing down and rebuilding its provider. Editing the provider/model
 * itself must go through cancelSession + startSession(resume) instead,
 * and the embedded provider specifically must never do that while another
 * one is live: node-llama-cpp's native addon crashed the whole process
 * (an uncaught C++ exception, not a JS error catch could stop) when a
 * second model load started shortly after the first's disposal — a real
 * finding from live testing, not a hypothetical. This function exists so
 * the overwhelmingly common edit (workspace or mode, not model) never has
 * to risk that path at all.
 */
export function updateLiveSessionSettings(
  registry: SessionRegistry,
  sessionId: string,
  updates: { workspaceRoot?: string; mode?: PermissionMode; planFirst?: boolean }
): boolean {
  const entry = registry.sessions.get(sessionId);
  if (!entry) return false;
  if (updates.workspaceRoot !== undefined) entry.session.setWorkspaceRoot(updates.workspaceRoot);
  if (updates.mode !== undefined) entry.session.setPermissionMode(updates.mode);
  if (updates.planFirst !== undefined) entry.session.setPlanFirst(updates.planFirst);
  return true;
}

export interface LiveSessionSnapshot {
  messages: ChatMessage[];
  events: AgentEvent[];
  title: string;
  createdAt: number;
  ownerEmail: string | null;
  /** The workspace this session is actually running against right now — read live off the session (reflects a mid-session setWorkspaceRoot via Edit settings…), not merely whatever it started with. A tab reattaching to a still-live session (see resumeSession in renderer.ts) has no other way to show the right workspace text. */
  workspaceRoot: string;
}

/**
 * The live, in-memory state of an active session — same shape persistSession
 * writes to disk, but read directly from the registry entry instead. A
 * session is only ever saved to disk once its first task completes
 * (persistSession runs from doRunTask, not from startSession), so a caller
 * that needs "whatever this session currently is" — e.g. applying edited
 * settings mid-conversation — can't rely on loadSessionRecord() returning
 * anything for a session that hasn't run a task yet. This works regardless.
 */
/**
 * Security audit finding (confirmed, medium): session-ipc-missing-owner-
 * authorization. agent:list-sessions/agent:search-sessions filter by the
 * signed-in account's ownerEmail, but every other session-mutating/
 * controlling IPC handler (load-session, get-live-session,
 * update-session-settings, delete-session, respond-permission,
 * respond-plan, cancel-session, get-checkpoint, revert-checkpoint,
 * get-changes, run-task) took a bare session id with no ownership check
 * at all — any caller holding a foreign session id could load/run/
 * modify/delete it. A concrete reachability path: account A starts a
 * task, signs out mid-task, account B signs in within the same running
 * window — A's task keeps running in the registry, and a generic,
 * non-account-scoped agent:event listener could leak A's real session id
 * to the now-B-signed-in renderer, which could then feed it to any of
 * these unguarded handlers.
 *
 * This is the single shared authorization check main.ts's IPC handlers
 * use before acting on a caller-supplied session id — checked at the
 * actual IPC trust boundary (main.ts), not pushed down into this
 * module's own session-mutating functions, so none of their existing
 * signatures (or their many existing callers/tests) need to change.
 * Checks the LIVE registry entry first (an active session not yet
 * persisted to disk has no on-disk record to read at all), falling back
 * to the on-disk record for a session the live registry has forgotten
 * (e.g. after an app restart). Returns undefined — distinct from a real
 * `null` owner — when the session exists nowhere at all, so a caller can
 * tell "doesn't exist" apart from "exists, but isn't yours" without an
 * extra lookup.
 */
export async function getSessionOwnerEmail(registry: SessionRegistry, sessionId: string): Promise<string | null | undefined> {
  const live = registry.sessions.get(sessionId);
  if (live) return live.ownerEmail;
  const record = await loadSessionRecord(registry.sessionsDir, sessionId);
  return record ? record.ownerEmail : undefined;
}

export function getLiveSessionSnapshot(registry: SessionRegistry, sessionId: string): LiveSessionSnapshot | null {
  const entry = registry.sessions.get(sessionId);
  if (!entry) return null;
  return {
    messages: entry.session.getMessages(),
    events: entry.events,
    title: entry.title ?? "(untitled)",
    createdAt: entry.createdAt,
    ownerEmail: entry.ownerEmail,
    workspaceRoot: entry.session.getWorkspaceRoot(),
  };
}

/** Whether the session currently has a checkpoint to revert to — used by the renderer to decide whether to show "Revert this task" at all. */
export function getCheckpointHash(registry: SessionRegistry, sessionId: string): string | null {
  return registry.sessions.get(sessionId)?.session.getCheckpointHash() ?? null;
}

/**
 * Reverts the session's workspace to its current checkpoint (see
 * AgentSession.getCheckpointHash — one per task, the most recent task that
 * actually wrote/executed something). Refuses while a task is actively
 * running: reverting mid-write risks either the in-flight write completing
 * AFTER the revert (silently undoing it) or corrupting a file the revert
 * and the write touch at the same instant — neither is a checkpoint bug to
 * paper over, it's a real race to refuse outright instead.
 */
export async function revertSessionCheckpoint(registry: SessionRegistry, sessionId: string): Promise<{ ok: boolean; error?: string }> {
  const entry = registry.sessions.get(sessionId);
  if (!entry) return { ok: false, error: "Unknown session." };
  if (entry.running) return { ok: false, error: "Can't revert while a task is running." };
  const hash = entry.session.getCheckpointHash();
  if (!hash) return { ok: false, error: "No checkpoint available for this session." };
  // Correctness audit finding (session Medium #2): the entry.running
  // check just above was the ONLY guard against a task starting mid-revert
  // — checked once, synchronously, then several awaited git subprocess
  // calls ran with no lock held across that window, leaving a real
  // check-then-act race (a runTask call issued during that window
  // started a real task concurrently with the revert's own checkout).
  // Claiming the SAME entry.running lock revertSessionCheckpoint already
  // reads from — synchronously, before the first await below — closes it
  // symmetrically: runTask now refuses while this is set, exactly like
  // this function already refuses while a task is running.
  const revertPromise = (async () => {
    // Correctness audit finding (session Medium #3): a checkpoint is a
    // deliberately dangling, unreferenced git commit (see checkpoints.ts's
    // own doc comment — "eventually GC'd"), so revertToCheckpoint can
    // genuinely fail for reasons outside this function's control (the
    // commit got pruned, a git subprocess error) — same shape of failure
    // getSessionChanges below already guards against. Without this, that
    // failure propagated as an unhandled rejection instead of the clear
    // {ok:false, error} this function's own return type promises.
    await revertToCheckpoint(entry.session.getWorkspaceRoot(), hash);
  })();
  entry.running = revertPromise;
  try {
    await revertPromise;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (entry.running === revertPromise) entry.running = null;
  }
}

/**
 * Every file changed since the session's current checkpoint, each with its
 * full diff attached — read-only, so unlike revertSessionCheckpoint this is
 * safe to call even while a task is actively running (it's just a snapshot
 * of that instant, not a mutation racing the task's own writes).
 */
export async function getSessionChanges(
  registry: SessionRegistry,
  sessionId: string
): Promise<{ ok: true; changes: FileChangeWithDiff[] } | { ok: false; error: string }> {
  const entry = registry.sessions.get(sessionId);
  if (!entry) return { ok: false, error: "Unknown session." };
  const hash = entry.session.getCheckpointHash();
  if (!hash) return { ok: false, error: "No checkpoint available for this session." };
  try {
    const changes = await getChanges(entry.session.getWorkspaceRoot(), hash);
    return { ok: true, changes };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function persistSession(registry: SessionRegistry, sessionId: string, entry: SessionEntry): Promise<void> {
  if (entry.deleted) return;
  // lastSyncCheckpoint is cloud sync's own bookkeeping about ITS last
  // successful push/pull (see SessionRecord's doc comment) — a normal
  // task-completion save has nothing to do with that and must carry it
  // forward unchanged, not silently reset it to null every time a task
  // finishes (which would force every single reconcile pass back onto the
  // less-robust updatedAt-fallback comparison).
  const existing = await loadSessionRecord(registry.sessionsDir, sessionId);
  const checkpointHash = entry.session.getCheckpointHash();
  const record: SessionRecord = {
    id: sessionId,
    title: entry.title ?? "(untitled)",
    messages: entry.session.getMessages(),
    events: entry.events,
    createdAt: entry.createdAt,
    updatedAt: Date.now(),
    ownerEmail: entry.ownerEmail,
    // Correctness audit finding (session High #1, #2): provider/model are
    // fixed for the entry's lifetime (see providerConfig's own doc
    // comment); mode/planFirst/checkpointHash are read LIVE off the
    // session so a mid-session "Edit settings…" change or a later
    // checkpoint is never persisted stale.
    provider: entry.providerConfig,
    mode: entry.session.getPermissionMode(),
    planFirst: entry.session.getPlanFirst(),
    checkpointHash,
    // Final-review finding C3: paired with checkpointHash so a later
    // resume/restart can refuse to restore it into a different workspace
    // — see SessionRecord's own doc comment. getWorkspaceRoot() is the
    // SAME live value setWorkspaceRoot keeps in lock-step with the
    // checkpoint (it clears the hash on any real change), so this is
    // never stale relative to checkpointHash above.
    checkpointWorkspaceRoot: checkpointHash ? entry.session.getWorkspaceRoot() : null,
    lastSyncCheckpoint: existing?.lastSyncCheckpoint ?? null,
  };
  await saveSession(registry.sessionsDir, record);
  // Fire-and-forget: syncUploadToCloud never rejects (it catches everything
  // internally), and this function is awaited inside doRunTask, which
  // entry.running tracks — finalizeEntry awaits entry.running before
  // disposing the model provider's native resources, so an awaited slow/hung
  // cloud sync call here would directly delay freeing the model's memory on
  // cancel/delete/resume-over-existing.
  void syncUploadToCloud(registry, record);
}

/** Best-effort: cloud sync must never fail or delay the caller. A missing drive.appdata scope (DriveScopeError) is reported once via onScopeError; any other failure (offline, revoked token, transient Drive error) is swallowed (never thrown to the caller) and simply retried on the next save — but logged, so a persistently broken backup is diagnosable instead of silently invisible. */
async function syncUploadToCloud(registry: SessionRegistry, record: SessionRecord): Promise<void> {
  if (!registry.cloudSync) return;
  const { getAccessToken, onScopeError, uploadSession: upload = driveUploadSession } = registry.cloudSync;
  try {
    const token = await getAccessToken();
    if (!token) return;
    const { modifiedTime } = await upload(token, record);
    // Correctness audit finding (session Medium #1): without this, every
    // continuous per-task upload (this function) would leave the local
    // checkpoint stale relative to what Drive now actually holds — the
    // NEXT reconcileSessions pass would then see "remote changed" (it did,
    // but only because THIS device just pushed it) and misread its own
    // background upload as a concurrent edit from another device,
    // routing every subsequent save into the conflict-preservation branch
    // for no reason. Refreshing the checkpoint here keeps it accurate
    // between reconcile passes, exactly like reconcileSessions' own push
    // branch does after a push it drives itself.
    //
    // Final-review finding C1: `record` is a snapshot captured when THIS
    // upload started — by the time it finishes (the upload itself is a
    // real network round-trip), a second task can have completed and
    // saved a newer record, or the session can have been deleted outright
    // (removeSession's own file delete doesn't wait for an in-flight
    // upload like this one to finish). Writing `record` back unconditionally
    // would silently roll back that newer save, or resurrect a deleted
    // session's file. Re-reading the CURRENT on-disk state right before
    // this write and only proceeding when nothing has changed since (same
    // updatedAt, still exists) makes this a pure no-op in both of those
    // cases instead of an old-copy overwrite — the next save's own upload
    // will seed a correct, up-to-date checkpoint regardless.
    const current = await loadSessionRecord(registry.sessionsDir, record.id);
    if (current && current.updatedAt === record.updatedAt) {
      await saveSession(registry.sessionsDir, { ...current, lastSyncCheckpoint: { remoteModifiedTime: modifiedTime, localUpdatedAt: record.updatedAt } });
    }
  } catch (err) {
    if (err instanceof DriveScopeError) onScopeError();
    else console.warn(`[cloudSync] upload failed for session ${record.id}, will retry on next save:`, err);
  }
}

/** Mirrors syncUploadToCloud's best-effort contract for the delete path. */
async function syncDeleteFromCloud(registry: SessionRegistry, sessionId: string): Promise<void> {
  if (!registry.cloudSync) return;
  const { getAccessToken, onScopeError, deleteRemoteSession: del = driveDeleteRemoteSession } = registry.cloudSync;
  try {
    const token = await getAccessToken();
    if (!token) return;
    await del(token, sessionId);
  } catch (err) {
    if (err instanceof DriveScopeError) onScopeError();
    else console.warn(`[cloudSync] remote delete failed for session ${sessionId}:`, err);
  }
}

async function doRunTask(
  registry: SessionRegistry,
  sessionId: string,
  entry: SessionEntry,
  task: string,
  onEvent: (event: AgentEvent) => void,
  attachments?: { images?: AttachedImage[]; textAttachments?: AttachedText[] }
): Promise<void> {
  if (entry.title === null) {
    entry.title = task.length > 60 ? `${task.slice(0, 60)}…` : task;
  }

  try {
    // Persisting on "done" alone (not "error") is deliberate, not a gap:
    // every exit path in agent.ts's run() — success, turn-budget exceeded,
    // or a provider error — always yields "done" as its final event, with
    // "error" (when present) yielded immediately before it. Persisting on
    // both would just save the same final state twice.
    for await (const event of entry.session.run(task, attachments)) {
      if (!isEphemeralStreamEvent(event)) entry.events.push(event);
      onEvent(event);
      if (event.type === "done") {
        await persistSession(registry, sessionId, entry).catch(() => {});
      }
    }
  } catch (err: any) {
    const errorEvent: AgentEvent = { type: "error", message: `Unexpected session error: ${err.message}` };
    const doneEvent: AgentEvent = { type: "done", success: false, summary: "Unexpected error." };
    entry.events.push(errorEvent, doneEvent);
    onEvent(errorEvent);
    onEvent(doneEvent);
    await persistSession(registry, sessionId, entry).catch(() => {});
  }
}

export async function runTask(
  registry: SessionRegistry,
  sessionId: string,
  task: string,
  onEvent: (event: AgentEvent) => void,
  attachments?: { images?: AttachedImage[]; textAttachments?: AttachedText[] }
): Promise<void> {
  const entry = registry.sessions.get(sessionId);
  if (!entry) throw new Error(`Unknown session: ${sessionId}`);
  // Correctness audit finding (session Medium #2): the OPPOSITE direction
  // of revertSessionCheckpoint's own "can't revert while a task is
  // running" guard — entry.running is now the single shared lock between
  // a running task AND a mid-flight revert (see that function), so a
  // runTask call during either refuses the same way, rather than racing
  // a live agent write against the revert's own checkout+cleanup.
  if (entry.running) throw new Error("A task or revert is already in progress for this session.");

  const runPromise = doRunTask(registry, sessionId, entry, task, onEvent, attachments);
  entry.running = runPromise;
  try {
    await runPromise;
  } finally {
    if (entry.running === runPromise) entry.running = null;
  }
}

/** No-op on an unknown session/callId — the renderer may race a stale click against a session that already moved on. approvedHunkIds is only ever meaningful for a real edit_file partial approval; every other caller simply omits it. */
export function respondPermission(registry: SessionRegistry, sessionId: string, callId: string, approved: boolean, approvedHunkIds?: number[]): void {
  const entry = registry.sessions.get(sessionId);
  if (!entry) return;
  const resolve = entry.pendingApprovals.get(callId);
  if (!resolve) return;
  entry.pendingApprovals.delete(callId);
  registry.onPendingApprovalsChanged?.();
  resolve({ approved, approvedHunkIds });
}

/** Same contract as respondPermission, for the single pending plan approval (see SessionEntry.pendingPlanApproval) — no callId, since at most one plan is ever pending per session. */
export function respondPlan(registry: SessionRegistry, sessionId: string, approved: boolean): void {
  const entry = registry.sessions.get(sessionId);
  if (!entry) return;
  const resolve = entry.pendingPlanApproval.resolve;
  if (!resolve) return;
  entry.pendingPlanApproval.resolve = null;
  registry.onPendingApprovalsChanged?.();
  resolve(approved);
}

/**
 * Shared teardown for a live entry: resolves any pending permission prompt
 * with `false` (so a run awaiting approval can't hang forever once its
 * session is being cancelled or deleted out from under it), cooperatively
 * cancels the agent loop, waits for whatever task is currently in flight to
 * actually finish (so the model's native resources are never freed mid
 * generation), then disposes the provider's local resources.
 */
async function finalizeEntry(registry: SessionRegistry, entry: SessionEntry): Promise<void> {
  const hadPending = entry.pendingApprovals.size > 0 || entry.pendingPlanApproval.resolve !== null;
  for (const resolve of entry.pendingApprovals.values()) resolve({ approved: false });
  entry.pendingApprovals.clear();
  if (entry.pendingPlanApproval.resolve) {
    entry.pendingPlanApproval.resolve(false);
    entry.pendingPlanApproval.resolve = null;
  }
  if (hadPending) registry.onPendingApprovalsChanged?.();
  entry.session.cancel();
  await entry.running?.catch(() => {});
  await entry.provider.dispose?.().catch(() => {});
}

/**
 * Cooperative: agent.ts checks the cancelled flag at loop boundaries, not
 * mid-await. Frees the session's model resources once any in-flight task
 * actually stops, and removes the entry from the registry — a cancelled
 * session is no longer live, so nothing should keep finding it here.
 *
 * That removal matters beyond tidiness: startSession's own "an entry
 * already exists under this id" cleanup path exists for a session whose
 * previous in-memory entry was never cleaned up (e.g. a stale entry
 * surviving an app reload). It was never meant to handle "this same,
 * already-cancelled entry, seconds ago, in the same running process" — but
 * that's exactly what happens when a caller cancels a session and then
 * immediately calls startSession again with the same id to resume it
 * (editing an active session's settings; also latent in the sidebar's
 * resume flow if a user re-clicks the session that's already active).
 * Without this removal, that second startSession call redundantly
 * re-finalizes (and, for an embedded provider, re-disposes) the same
 * already-torn-down entry while the new provider is concurrently loading a
 * fresh copy of the model — real resource contention, not a deadlock, but
 * severe enough to look like one.
 */
export async function cancelSession(registry: SessionRegistry, sessionId: string): Promise<void> {
  const entry = registry.sessions.get(sessionId);
  if (!entry) return;
  await finalizeEntry(registry, entry);
  // Only remove if this is still the same entry — in principle a caller
  // could already have started a new session under this id while this
  // cancel's async teardown was in flight; that newer entry must survive.
  if (registry.sessions.get(sessionId) === entry) {
    registry.sessions.delete(sessionId);
  }
}

/**
 * Deletes the persisted record and, if the session is currently live, tears
 * it down first (see finalizeEntry) and marks it deleted so an in-flight
 * task's terminal event can't resurrect the record by saving right after
 * this delete completes.
 */
export async function removeSession(registry: SessionRegistry, sessionId: string): Promise<void> {
  const entry = registry.sessions.get(sessionId);
  if (entry) {
    entry.deleted = true;
    await finalizeEntry(registry, entry);
  }
  await deleteSession(registry.sessionsDir, sessionId);
  registry.sessions.delete(sessionId);
  // Fire-and-forget for the same reason as persistSession's upload call —
  // syncDeleteFromCloud never rejects, and callers no longer need to wait on
  // it for correctness.
  void syncDeleteFromCloud(registry, sessionId);
}
