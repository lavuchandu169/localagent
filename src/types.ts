// Core shared types — kept provider/IDE agnostic (Section 4, 70).

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

export type AgentEvent =
  | { type: "status"; message: string }
  | { type: "text"; text: string }
  | { type: "tool.start"; call: ToolCall }
  | { type: "tool.result"; call: ToolCall; result: ToolResult }
  | { type: "permission.request"; call: ToolCall; decision: PermissionDecision }
  | { type: "done"; success: boolean; summary: string }
  | { type: "error"; message: string };
