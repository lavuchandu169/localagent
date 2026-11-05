import { isEmbeddedModelId } from "../models.js";
import { buildInitiativeTask, findRole, type Organization, type Role, type Initiative } from "../organization.js";
import { startSession, runTask, buildProvider, type SessionRegistry, type ProviderConfig, type ModelDownloadProgress } from "./sessionRegistry.js";
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

/**
 * Wraps an already-resolved (and, for cloud kinds, API-key-injected)
 * ProviderConfig as a `startSession`-shaped providerFactory — the hook
 * main.ts's organization:run-initiative handler uses to substitute its
 * own keyed config for the unkeyed one `startInitiativeSession` derives
 * internally via `resolveRoleProviderConfig` (which deliberately never
 * carries a key; see that function's own doc comment).
 *
 * Takes `buildProviderFn` as a parameter (defaulting to the real
 * `buildProvider`) purely so a test can substitute a spy without
 * actually constructing a real provider — the bug this guards against
 * (a previous version of this closure ignored its own
 * onDownloadProgress/signal arguments, silently dropping embedded-model
 * download progress and the ability to cancel one) is only observable
 * through exactly those two forwarded arguments.
 */
export function keyedProviderFactory(
  resolvedConfig: ProviderConfig | undefined,
  buildProviderFn: typeof buildProvider = buildProvider
): ((config: ProviderConfig, onDownloadProgress?: (status: ModelDownloadProgress) => void, signal?: AbortSignal) => ReturnType<typeof buildProvider>) | undefined {
  if (!resolvedConfig) return undefined;
  return (_config, onDownloadProgress, signal) => buildProviderFn(resolvedConfig, onDownloadProgress, signal);
}

/**
 * The full orchestration behind "Run as `<role>`": looks up the
 * initiative and its assigned role, resolves the role's model into a
 * real (API-key-injected, for cloud kinds) ProviderConfig, and hands off
 * to startInitiativeSession. Never throws — every failure mode (unknown
 * initiative, no assigned role, unresolvable model id, a provider
 * health-check failure, a task error) comes back as `{ ok: false, error
 * }`, exactly like startInitiativeSession's own contract, so main.ts's
 * IPC handler can simply `return` this function's result unconditionally
 * instead of re-throwing it — throwing here would discard the very
 * "record which initiative failed and why without an exception unwinding
 * past that bookkeeping" property startInitiativeSession's doc comment
 * already calls out, and would make the renderer's existing `result.ok
 * === false` branch (organizationPanel.ts's runInitiative) permanently
 * unreachable dead code instead of the real failure path it reads as.
 */
export async function runOrganizationInitiative(
  registry: SessionRegistry,
  org: Organization,
  initiativeId: string,
  workspaceRoot: string,
  onEvent: (event: AgentEvent) => void,
  onSessionStarted: ((sessionId: string) => void) | undefined,
  deps: Parameters<typeof startSession>[2] & {
    /** Resolves the real cloud API key for a role's provider kind — a
     * main-process-only concern (settings file paths, StorageCrypto)
     * this module has no business knowing about directly. Omitted (e.g.
     * in a test) means cloud roles start with no key, exactly like
     * omitting apiKey on a ProviderConfig elsewhere in this app. */
    resolveApiKey?: (kind: "anthropic" | "openai" | "gemini") => Promise<string | undefined>;
    /** Only consulted for the freellmapi kind — see buildProvider's own
     * "main.ts must resolve it" comment on why this can't default to
     * anything sensible on its own. */
    freellmapiUserDataDir?: string;
    /** Forwarded to keyedProviderFactory — defaults to the real
     * buildProvider. Lets a test substitute a fake builder (so a cloud
     * role's "ok: true" path doesn't have to make a real network call)
     * without that seam existing anywhere a production caller could
     * accidentally use it to skip real provider construction. */
    buildProviderFn?: typeof buildProvider;
  } = {}
): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
  const initiative = org.initiatives.find((i) => i.id === initiativeId);
  if (!initiative) return { ok: false, error: `Unknown initiative: ${initiativeId}` };
  const role = initiative.assignedRoleId ? findRole(org, initiative.assignedRoleId) : undefined;
  if (!role) return { ok: false, error: `Initiative "${initiative.title}" has no assigned role.` };

  const baseResolved = resolveRoleProviderConfig(role);
  let keyedConfig: ProviderConfig | undefined;
  if (baseResolved.ok) {
    const c = baseResolved.config;
    keyedConfig =
      c.kind === "anthropic"
        ? { ...c, apiKey: await deps.resolveApiKey?.("anthropic") }
        : c.kind === "openai"
          ? { ...c, apiKey: await deps.resolveApiKey?.("openai") }
          : c.kind === "gemini"
            ? { ...c, apiKey: await deps.resolveApiKey?.("gemini") }
            : c.kind === "freellmapi"
              ? { ...c, userDataDir: deps.freellmapiUserDataDir }
              : c;
  }

  const { resolveApiKey, freellmapiUserDataDir, buildProviderFn, ...startSessionDeps } = deps;
  return startInitiativeSession(
    registry,
    org,
    initiative,
    role,
    workspaceRoot,
    onEvent,
    { ...startSessionDeps, providerFactory: keyedProviderFactory(keyedConfig, buildProviderFn) },
    onSessionStarted
  );
}
