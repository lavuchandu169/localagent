import crypto from "node:crypto";
import os from "node:os";
import { AgentSession } from "../agent.js";
import { defaultToolRegistry } from "../toolRegistry.js";
import { OpenAICompatibleProvider } from "../providers/openaiCompatible.js";
import { EmbeddedLlamaProvider } from "../providers/embeddedLlama.js";
import { AnthropicProvider } from "../providers/anthropicProvider.js";
import { isEmbeddedModelSize } from "../models.js";
import { saveSession, deleteSession } from "../sessionStore.js";
import type { AgentEvent, ChatMessage, ModelProvider, PermissionMode } from "../types.js";

export type ProviderConfig =
  | { kind: "openai-compatible"; baseUrl: string; model: string }
  | { kind: "embedded"; size: string }
  | { kind: "anthropic" };

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
}

export interface SessionRegistry {
  sessions: Map<string, SessionEntry>;
  sessionsDir: string;
}

export function createSessionRegistry(sessionsDir: string): SessionRegistry {
  return { sessions: new Map(), sessionsDir };
}

/** Mirrors the provider construction in cli.ts's --base-url branch. */
export function buildProvider(config: ProviderConfig, onDownloadProgress?: (status: ModelDownloadProgress) => void): ModelProvider {
  if (config.kind === "openai-compatible") {
    return new OpenAICompatibleProvider({ baseUrl: config.baseUrl, local: true });
  }
  if (config.kind === "anthropic") {
    return new AnthropicProvider();
  }
  if (!isEmbeddedModelSize(config.size)) {
    throw new Error(`Invalid embedded model size: ${config.size}`);
  }
  return new EmbeddedLlamaProvider({ size: config.size, onDownloadProgress });
}

export async function startSession(
  registry: SessionRegistry,
  config: SessionConfig,
  deps: {
    providerFactory?: (c: ProviderConfig, onDownloadProgress?: (status: ModelDownloadProgress) => void) => ModelProvider;
    onDownloadProgress?: (status: ModelDownloadProgress) => void;
    resume?: ResumePayload;
  } = {}
): Promise<{ sessionId: string; workspaceRoot: string }> {
  const provider = (deps.providerFactory ?? buildProvider)(config.provider, deps.onDownloadProgress);
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
          ? "claude-sonnet-5"
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

  registry.sessions.set(sessionId, {
    session,
    provider,
    pendingApprovals,
    events: deps.resume ? [...deps.resume.priorEvents] : [],
    title: deps.resume?.title ?? null,
    createdAt: deps.resume?.createdAt ?? Date.now(),
    deleted: false,
    running: null,
  });
  return { sessionId, workspaceRoot };
}

async function persistSession(registry: SessionRegistry, sessionId: string, entry: SessionEntry): Promise<void> {
  if (entry.deleted) return;
  await saveSession(registry.sessionsDir, {
    id: sessionId,
    title: entry.title ?? "(untitled)",
    messages: entry.session.getMessages(),
    events: entry.events,
    createdAt: entry.createdAt,
    updatedAt: Date.now(),
  });
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

/** Cooperative: agent.ts checks the cancelled flag at loop boundaries, not mid-await. Frees the session's model resources once any in-flight task actually stops. */
export async function cancelSession(registry: SessionRegistry, sessionId: string): Promise<void> {
  const entry = registry.sessions.get(sessionId);
  if (!entry) return;
  await finalizeEntry(entry);
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
}
