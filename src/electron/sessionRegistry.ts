import crypto from "node:crypto";
import os from "node:os";
import { AgentSession } from "../agent.js";
import { defaultToolRegistry } from "../toolRegistry.js";
import { OpenAICompatibleProvider } from "../providers/openaiCompatible.js";
import { EmbeddedLlamaProvider } from "../providers/embeddedLlama.js";
import { AnthropicProvider } from "../providers/anthropicProvider.js";
import { isEmbeddedModelId } from "../models.js";
import { saveSession, deleteSession, type SessionRecord } from "../sessionStore.js";
import { uploadSession as driveUploadSession, deleteRemoteSession as driveDeleteRemoteSession, DriveScopeError } from "../cloudSync.js";
import type { AgentEvent, ChatMessage, ModelProvider, PermissionMode } from "../types.js";
import { revertToCheckpoint } from "../checkpoints.js";
import { getChanges, type FileChangeWithDiff } from "../changesSince.js";

export type ProviderConfig =
  | { kind: "openai-compatible"; baseUrl: string; model: string }
  | { kind: "embedded"; size: string }
  | { kind: "anthropic"; apiKey?: string; model?: string };

export interface SessionConfig {
  /** Omit to chat without file access — defaults to the home directory. */
  workspaceRoot?: string;
  provider: ProviderConfig;
  mode: PermissionMode;
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
}

/** Best-effort cloud sync wiring, supplied by main.ts. uploadSession/deleteRemoteSession default to the real Drive-backed implementations — tests override them directly instead of faking fetch. */
export interface CloudSyncConfig {
  getAccessToken: () => Promise<string | null>;
  onScopeError: () => void;
  uploadSession?: (accessToken: string, record: SessionRecord) => Promise<void>;
  deleteRemoteSession?: (accessToken: string, sessionId: string) => Promise<void>;
  /** Cheap, no-network read of the currently signed-in account's email (or null if signed out) — stamped onto every saved session as its owner, so the UI can later filter local history by account. */
  getOwnerEmail: () => Promise<string | null>;
}

interface SessionEntry {
  session: AgentSession;
  provider: ModelProvider;
  pendingApprovals: Map<string, (approved: boolean) => void>;
  events: AgentEvent[];
  title: string | null;
  createdAt: number;
  deleted: boolean;
  /** The currently in-flight runTask() call, if any — awaited by finalizeEntry before disposing the provider, so a model's native resources are never freed while it's still mid-generation. */
  running: Promise<void> | null;
  /** Fixed once at session creation (or carried over from a resumed session's prior record) — never re-derived from "whoever's currently signed in" on every save, so signing out or switching accounts mid-conversation can't silently strip ownership from an already-owned session. */
  ownerEmail: string | null;
}

export interface SessionRegistry {
  sessions: Map<string, SessionEntry>;
  sessionsDir: string;
  cloudSync?: CloudSyncConfig;
}

export function createSessionRegistry(sessionsDir: string, cloudSync?: CloudSyncConfig): SessionRegistry {
  return { sessions: new Map(), sessionsDir, cloudSync };
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
  if (!isEmbeddedModelId(config.size)) {
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
  } = {}
): Promise<{ sessionId: string; workspaceRoot: string }> {
  const provider = (deps.providerFactory ?? buildProvider)(config.provider, deps.onDownloadProgress, deps.signal);
  const healthy = await provider.healthCheck();
  if (!healthy) {
    throw new Error(`Could not start provider "${provider.id}" — health check failed.`);
  }

  const sessionId = deps.resume?.sessionId ?? crypto.randomUUID();
  const pendingApprovals = new Map<string, (approved: boolean) => void>();
  const workspaceRoot = config.workspaceRoot ?? os.homedir();

  // Starting a session under an id that's already live (a resume of a
  // session whose previous in-memory entry was never cleaned up) must not
  // leak the old entry's model — tear it down first.
  const existing = registry.sessions.get(sessionId);
  if (existing) {
    await finalizeEntry(existing);
  }

  const session = new AgentSession({
    workspaceRoot,
    model:
      config.provider.kind === "openai-compatible"
        ? config.provider.model
        : config.provider.kind === "anthropic"
          ? (config.provider.model ?? "claude-sonnet-5")
          : config.provider.size,
    provider,
    tools: defaultToolRegistry(),
    permissionMode: config.mode,
    initialMessages: deps.resume?.initialMessages,
    onApprovalNeeded: (call) =>
      new Promise<boolean>((resolve) => {
        pendingApprovals.set(call.id, resolve);
      }),
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
    events: deps.resume ? [...deps.resume.priorEvents] : [],
    title: deps.resume?.title ?? null,
    createdAt: deps.resume?.createdAt ?? Date.now(),
    deleted: false,
    running: null,
    ownerEmail,
  });
  return { sessionId, workspaceRoot };
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
export function updateLiveSessionSettings(registry: SessionRegistry, sessionId: string, updates: { workspaceRoot?: string; mode?: PermissionMode }): boolean {
  const entry = registry.sessions.get(sessionId);
  if (!entry) return false;
  if (updates.workspaceRoot !== undefined) entry.session.setWorkspaceRoot(updates.workspaceRoot);
  if (updates.mode !== undefined) entry.session.setPermissionMode(updates.mode);
  return true;
}

export interface LiveSessionSnapshot {
  messages: ChatMessage[];
  events: AgentEvent[];
  title: string;
  createdAt: number;
  ownerEmail: string | null;
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
export function getLiveSessionSnapshot(registry: SessionRegistry, sessionId: string): LiveSessionSnapshot | null {
  const entry = registry.sessions.get(sessionId);
  if (!entry) return null;
  return {
    messages: entry.session.getMessages(),
    events: entry.events,
    title: entry.title ?? "(untitled)",
    createdAt: entry.createdAt,
    ownerEmail: entry.ownerEmail,
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
  await revertToCheckpoint(entry.session.getWorkspaceRoot(), hash);
  return { ok: true };
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
  const record: SessionRecord = {
    id: sessionId,
    title: entry.title ?? "(untitled)",
    messages: entry.session.getMessages(),
    events: entry.events,
    createdAt: entry.createdAt,
    updatedAt: Date.now(),
    ownerEmail: entry.ownerEmail,
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
    await upload(token, record);
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
  onEvent: (event: AgentEvent) => void
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
    for await (const event of entry.session.run(task)) {
      entry.events.push(event);
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
  onEvent: (event: AgentEvent) => void
): Promise<void> {
  const entry = registry.sessions.get(sessionId);
  if (!entry) throw new Error(`Unknown session: ${sessionId}`);

  const runPromise = doRunTask(registry, sessionId, entry, task, onEvent);
  entry.running = runPromise;
  try {
    await runPromise;
  } finally {
    if (entry.running === runPromise) entry.running = null;
  }
}

/** No-op on an unknown session/callId — the renderer may race a stale click against a session that already moved on. */
export function respondPermission(registry: SessionRegistry, sessionId: string, callId: string, approved: boolean): void {
  const entry = registry.sessions.get(sessionId);
  if (!entry) return;
  const resolve = entry.pendingApprovals.get(callId);
  if (!resolve) return;
  entry.pendingApprovals.delete(callId);
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
async function finalizeEntry(entry: SessionEntry): Promise<void> {
  for (const resolve of entry.pendingApprovals.values()) resolve(false);
  entry.pendingApprovals.clear();
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
  await finalizeEntry(entry);
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
    await finalizeEntry(entry);
  }
  await deleteSession(registry.sessionsDir, sessionId);
  registry.sessions.delete(sessionId);
  // Fire-and-forget for the same reason as persistSession's upload call —
  // syncDeleteFromCloud never rejects, and callers no longer need to wait on
  // it for correctness.
  void syncDeleteFromCloud(registry, sessionId);
}
