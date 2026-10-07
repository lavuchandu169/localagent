// Core shared types — kept provider/IDE agnostic (Section 4, 70).
import type { Change } from "diff";

export type PermissionLevel = "READ" | "WRITE" | "EXECUTE" | "NETWORK" | "DANGEROUS";

export interface ToolResult<T = unknown> {
  ok: boolean;
  output: T | null;
  error?: string;
  truncated?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AttachedImage {
  name: string;
  mediaType: string;
  dataBase64: string;
}

export interface AttachedText {
  name: string;
  content: string;
}

export interface ToolContext {
  workspaceRoot: string;
  log: (msg: string) => void;
  /** Returns the currently-connected GitHub account's access token, or null
   * if none is connected. Only run_command's git-push handling consumes
   * this — every other tool ignores it. Undefined in the CLI/demo entry
   * points (neither wires Electron's stored credentials), which is exactly
   * "no account connected" as far as this feature is concerned. */
  getGithubToken?: () => Promise<string | null>;
}

export interface Tool<TInput = any, TOutput = any> {
  name: string;
  description: string;
  permission: PermissionLevel;
  /** JSON schema (subset) describing input shape, sent to the model. */
  inputSchema: Record<string, unknown>;
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult<TOutput>>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: ToolCall[];
  images?: AttachedImage[];
  textAttachments?: AttachedText[];
}

export interface ModelInfo {
  id: string;
  contextWindow?: number;
  local: boolean;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  maxTokens?: number;
  /** Aborts this one in-flight call when the user stops the running task (see AgentSession.stopCurrentTask) — optional since MockProvider and any other test double have no real request to abort. A provider that ignores this still works, it just can't be interrupted mid-call. */
  signal?: AbortSignal;
}

export type AssistantTurn =
  | { type: "final"; content: string }
  | { type: "tool_calls"; toolCalls: ToolCall[]; content?: string };

export interface ChatResponse {
  turn: AssistantTurn;
  /** Real token counts for this one API call, when the provider's response actually reports them — only AnthropicProvider populates this today; the embedded and OpenAI-compatible providers leave it undefined. */
  usage?: { inputTokens: number; outputTokens: number };
  raw?: unknown;
}

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_call_start"; index: number; name: string }
  | { type: "tool_call_delta"; index: number; argumentsDelta: string }
  /** A provider's own signal to discard whatever text/tool-card state has
   * streamed so far THIS turn, before its own `done` — distinct from a
   * fallback-retry's stream.reset (agent.ts emits that one itself, from
   * the catch block). Used by the embedded provider when a small model's
   * mis-flagged <tool_call> token makes generateResponse() stream what
   * LOOKS like prose but is actually serialized tool-call JSON, later
   * recovered by fromLlamaResult's text-fallback parsing — the streamed
   * "text" was never real prose, so it must never stay on screen above
   * the tool card that recovery produces. */
  | { type: "reset" }
  | { type: "done"; response: ChatResponse };

/** healthCheck's result: `ok:false` always carries the real failure reason — the underlying error message, not a bare boolean — so a caller can show the user something more useful than "health check failed". */
export type HealthCheckResult = { ok: true } | { ok: false; error: string };

/**
 * Every provider's chat() throws this for an HTTP-shaped failure instead
 * of a bare Error, so agent.ts's fallback layer has one reliable signal
 * to act on instead of parsing status codes out of message strings.
 * `retryable` is true exactly for a rate-limit/quota-exhausted response —
 * anything else (bad key, 500, network down) is `false` and behaves
 * exactly like today's unconditional task failure.
 */
export class ProviderChatError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  constructor(message: string, opts: { status?: number; retryable: boolean }) {
    super(message);
    this.name = "ProviderChatError";
    this.status = opts.status;
    this.retryable = opts.retryable;
  }
}

export interface ModelProvider {
  id: string;
  listModels(): Promise<ModelInfo[]>;
  healthCheck(): Promise<HealthCheckResult>;
  chat(request: ChatRequest): Promise<ChatResponse>;
  /** Optional incremental-rendering side channel — see StreamEvent. When
   * present, agent.ts calls this instead of chat(), driving it with
   * `for await` and yielding a corresponding AgentEvent per StreamEvent.
   * The final `done` event's `turn` and `usage` are guaranteed identical
   * to what chat() would return for the same input — streaming never
   * changes what's persisted to session history or what cost is reported,
   * only what's rendered live.
   *
   * `raw` is NOT covered by that guarantee for every provider (correctness
   * audit finding, provider Medium #3): AnthropicProvider and
   * EmbeddedLlamaProvider build it identically in both paths, but
   * OpenAIProvider/OpenAICompatibleProvider/FreellmapiProxyProvider's
   * streaming path yields `raw: undefined` (chat() sets the full parsed
   * response body), and GeminiProvider's streaming path yields a
   * synthetic `{candidates: [...], usageMetadata}` missing fields real
   * non-streaming responses carry (`promptFeedback`, `modelVersion`,
   * etc.). Currently harmless — nothing in this codebase reads `.raw` —
   * but a future caller that does must not assume it's interchangeable
   * between the two paths the way `turn`/`usage` are. */
  chatStream?(request: ChatRequest): AsyncGenerator<StreamEvent>;
  /** Releases any local native resources (loaded model weights, KV cache/context). Optional — only providers holding local resources (the embedded provider) implement it; remote providers have nothing to release. */
  dispose?(): Promise<void>;
}

export type PermissionMode = "PLAN" | "DEFAULT" | "ACCEPT_EDITS" | "AUTO_SAFE";

export interface PermissionResponse {
  approved: boolean;
  /** Only meaningful for an edit_file call with a diff — the DiffSegment hunk ids (see diffUtil.ts) to actually apply. Omitted, or covering every hunk id in the diff, behaves exactly like approving the whole call unmodified. Ignored when approved is false. */
  approvedHunkIds?: number[];
}

export type PermissionDecision = "ALLOW" | "ASK" | "DENY";

export type AgentState =
  | "INITIALIZING"
  | "THINKING"
  | "EXECUTING_TOOL"
  | "VERIFYING"
  | "WAITING_FOR_USER"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

/** What the model's very first turn of a task proposes to do — shown for approval before any of it runs, when planFirst is on (AgentSessionOptions.planFirst). Named distinctly from the unrelated PermissionMode "PLAN" (a read-only exploration mode) to avoid confusion — this is "propose, then approve, then execute", independent of which PermissionMode governs the execution that follows. */
export type ProposedPlan =
  | { kind: "tool_calls"; toolCalls: ToolCall[]; content?: string }
  | { kind: "text"; content: string };

export type AgentEvent =
  | { type: "status"; message: string }
  | { type: "text"; text: string }
  | { type: "text.delta"; text: string }
  | { type: "tool.start"; call: ToolCall }
  | { type: "tool_call.start"; index: number; name: string }
  | { type: "tool_call.delta"; index: number; argumentsDelta: string }
  | { type: "tool.result"; call: ToolCall; result: ToolResult }
  | { type: "permission.request"; call: ToolCall; decision: PermissionDecision; diff?: Change[] }
  | { type: "checkpoint.created"; checkpointHash: string }
  | { type: "plan.proposed"; plan: ProposedPlan }
  /** One real API call's token cost, whenever the provider's response reports it — see ChatResponse.usage. Carries `model` since a single session's cost depends on which Claude model actually served each turn. */
  | { type: "usage"; model: string; inputTokens: number; outputTokens: number }
  /** Ephemeral UI-only signal: discard whatever partial text/tool-card state is being built for the current turn — a provider-fallback retry after a mid-stream failure fires this before its own "retrying..." status message, so the fallback's fresh output never visually mixes with the failed provider's partial one. */
  | { type: "stream.reset" }
  | { type: "done"; success: boolean; summary: string }
  | { type: "error"; message: string }
  /** Renderer-only, never emitted by the agent itself: pushed into a tab's own event history the moment a task is sent, purely so replaying that history (switching away from a tab mid-task and back) reproduces the user's own sent message, not just the agent's side of it. Never persisted to disk — sessionRegistry's own event stream has no equivalent and doesn't need one. */
  | { type: "task.sent"; task: string };

/** text.delta/tool_call.start/tool_call.delta/stream.reset are a purely
 * ephemeral UI side channel — the turn's terminal text/tool.start events
 * already carry the complete, equivalent information. Both sessionRegistry
 * (entry.events, persisted to disk and uploaded via cloudSync) and
 * tabState (tab.events, replayed verbatim on every tab switch) use this to
 * skip storing every streamed token, which would otherwise double a long
 * answer's — or a whole-file edit_file call's — footprint for no benefit. */
export function isEphemeralStreamEvent(event: AgentEvent): boolean {
  return event.type === "text.delta" || event.type === "tool_call.start" || event.type === "tool_call.delta" || event.type === "stream.reset";
}
