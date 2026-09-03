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

export interface ModelProvider {
  id: string;
  listModels(): Promise<ModelInfo[]>;
  healthCheck(): Promise<boolean>;
  chat(request: ChatRequest): Promise<ChatResponse>;
  /** Releases any local native resources (loaded model weights, KV cache/context). Optional — only providers holding local resources (the embedded provider) implement it; remote providers have nothing to release. */
  dispose?(): Promise<void>;
}

export type PermissionMode = "PLAN" | "DEFAULT" | "ACCEPT_EDITS" | "AUTO_SAFE";

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
  | { type: "tool.start"; call: ToolCall }
  | { type: "tool.result"; call: ToolCall; result: ToolResult }
  | { type: "permission.request"; call: ToolCall; decision: PermissionDecision; diff?: Change[] }
  | { type: "checkpoint.created"; checkpointHash: string }
  | { type: "plan.proposed"; plan: ProposedPlan }
  /** One real API call's token cost, whenever the provider's response reports it — see ChatResponse.usage. Carries `model` since a single session's cost depends on which Claude model actually served each turn. */
  | { type: "usage"; model: string; inputTokens: number; outputTokens: number }
  | { type: "done"; success: boolean; summary: string }
  | { type: "error"; message: string };
