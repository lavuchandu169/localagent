import { isEmbeddedModelId } from "../models.js";
import { buildInitiativeTask, type Organization, type Role, type Initiative } from "../organization.js";
import { startSession, runTask, type SessionRegistry, type ProviderConfig } from "./sessionRegistry.js";
import type { AgentEvent } from "../types.js";

/**
 * Mirrors the cloud-model id lists `deriveProviderConfigFromForm` uses in
 * the renderer (renderer.ts) — kept as a small, separate copy rather than
 * importing from the renderer (which also pulls in live DOM element
 * references that don't exist outside a page) or refactoring that
 * existing, working function to extract a shared helper. If the
 * renderer's own lists change, these need updating too; that coupling is
 * accepted here rather than risking a refactor of session-start code
 * this slice doesn't otherwise need to touch.
 */
const ANTHROPIC_MODELS = new Set(["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5"]);
const OPENAI_MODELS = new Set(["gpt-5.5", "gpt-5.6-sol", "gpt-5-nano"]);
const GEMINI_MODELS = new Set(["gemini-3.8-flash", "gemini-3.1-pro", "gemini-3.5-flash-lite"]);
const FREELLMAPI_MODEL_ID = "freellmapi-auto";

/**
 * Resolves a role's plain `model` string into the real `ProviderConfig`
 * a session actually starts with. Deliberately narrower than the
 * renderer's own `deriveProviderConfigFromForm`: custom-server and
 * custom-embedded both need extra fields (a base URL, an external model
 * name, a GGUF URI) that `Role` doesn't carry, since nothing has asked
 * for organization roles to point at a custom server or a custom HF GGUF
 * yet — refused with a clear error rather than silently guessing wrong
 * values for those fields.
 */
export function resolveRoleProviderConfig(role: Role): { ok: true; config: ProviderConfig } | { ok: false; error: string } {
  const modelId = role.model;
  if (ANTHROPIC_MODELS.has(modelId)) return { ok: true, config: { kind: "anthropic", model: modelId } };
  if (OPENAI_MODELS.has(modelId)) return { ok: true, config: { kind: "openai", model: modelId } };
  if (GEMINI_MODELS.has(modelId)) return { ok: true, config: { kind: "gemini", model: modelId } };
  if (modelId === FREELLMAPI_MODEL_ID) return { ok: true, config: { kind: "freellmapi" } };
  if (isEmbeddedModelId(modelId)) return { ok: true, config: { kind: "embedded", size: modelId } };
  return {
    ok: false,
    error: `Role "${role.title}" has an unrecognized model id "${modelId}" — custom servers and custom embedded models aren't supported for organization roles yet; pick one of the built-in model ids.`,
  };
}

/**
 * Starts a real session for one role's initiative and runs it to
 * completion — the actual hand-off point from the Organization data
 * model into localagent's existing session machinery. A role carries no
 * special authority of its own: this always starts in "DEFAULT" mode
 * (ask before every change), the exact same permission engine, per-hunk
 * diff approval, and checkpoints any session a human starts goes
 * through. `onEvent` streams every turn, tool call, and permission
 * request exactly like a normal session — including any pending
 * approval, which the caller (eventually the Organization UI) answers
 * through the existing `respondPermission`/`respondPlan`, not anything
 * new here.
 *
 * Returns a result rather than throwing: a caller tracking a backlog of
 * initiatives needs to record *which* one failed and *why*, not have an
 * exception unwind past that bookkeeping.
 *
 * Deliberately does NOT update the initiative's status or save the
 * organization — that's the caller's job (via updateInitiative +
 * saveOrganization), keeping this function's only side effect the
 * session it actually starts.
 */
export async function startInitiativeSession(
  registry: SessionRegistry,
  org: Organization,
  initiative: Initiative,
  role: Role,
  workspaceRoot: string,
  onEvent: (event: AgentEvent) => void,
  deps: Parameters<typeof startSession>[2] = {},
  /** Fired as soon as the session exists (right after startSession
   * resolves), before the task itself has run at all — a caller
   * streaming events to a UI (an IPC handler forwarding to a renderer)
   * needs the sessionId this early to label those events and let the
   * UI open that session's tab immediately, not only once the whole
   * task finishes and this function's own promise resolves. */
  onSessionStarted?: (sessionId: string) => void
): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
  if (initiative.assignedRoleId !== role.id) {
    return { ok: false, error: `Initiative "${initiative.title}" is assigned to a different role than "${role.title}".` };
  }
  const resolved = resolveRoleProviderConfig(role);
  if (!resolved.ok) return resolved;

  const task = buildInitiativeTask(org, initiative, role);
  try {
    const { sessionId } = await startSession(registry, { workspaceRoot, provider: resolved.config, mode: "DEFAULT" }, deps);
    onSessionStarted?.(sessionId);
    await runTask(registry, sessionId, task, onEvent);
    return { ok: true, sessionId };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
