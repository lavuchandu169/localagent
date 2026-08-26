import crypto from "node:crypto";
import os from "node:os";
import { AgentSession } from "../agent.js";
import { defaultToolRegistry } from "../toolRegistry.js";
import { OpenAICompatibleProvider } from "../providers/openaiCompatible.js";
import { EmbeddedLlamaProvider } from "../providers/embeddedLlama.js";
import { AnthropicProvider } from "../providers/anthropicProvider.js";
import { isEmbeddedModelSize } from "../models.js";
import type { AgentEvent, ModelProvider, PermissionMode } from "../types.js";

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

interface SessionEntry {
  session: AgentSession;
  pendingApprovals: Map<string, (approved: boolean) => void>;
}

export interface SessionRegistry {
  sessions: Map<string, SessionEntry>;
}

export function createSessionRegistry(): SessionRegistry {
  return { sessions: new Map() };
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
  } = {}
): Promise<{ sessionId: string; workspaceRoot: string }> {
  const provider = (deps.providerFactory ?? buildProvider)(config.provider, deps.onDownloadProgress);
  const healthy = await provider.healthCheck();
  if (!healthy) {
    throw new Error(`Could not start provider "${provider.id}" — health check failed.`);
  }

  const sessionId = crypto.randomUUID();
  const pendingApprovals = new Map<string, (approved: boolean) => void>();
  const workspaceRoot = config.workspaceRoot ?? os.homedir();

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
    onApprovalNeeded: (call) =>
      new Promise<boolean>((resolve) => {
        pendingApprovals.set(call.id, resolve);
      }),
  });

  registry.sessions.set(sessionId, { session, pendingApprovals });
  return { sessionId, workspaceRoot };
}

export async function runTask(
  registry: SessionRegistry,
  sessionId: string,
  task: string,
  onEvent: (event: AgentEvent) => void
): Promise<void> {
  const entry = registry.sessions.get(sessionId);
  if (!entry) throw new Error(`Unknown session: ${sessionId}`);

  try {
    for await (const event of entry.session.run(task)) {
      onEvent(event);
    }
  } catch (err: any) {
    onEvent({ type: "error", message: `Unexpected session error: ${err.message}` });
    onEvent({ type: "done", success: false, summary: "Unexpected error." });
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

/** Cooperative: agent.ts checks the cancelled flag at loop boundaries, not mid-await. */
export function cancelSession(registry: SessionRegistry, sessionId: string): void {
  registry.sessions.get(sessionId)?.session.cancel();
}
