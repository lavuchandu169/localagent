import type { ChatMessage, ChatRequest } from "./types.js";

/** Compaction starts when the estimated history passes this share of the context window. */
export const COMPACTION_THRESHOLD = 0.7;
/** Used when neither the session nor the provider states a context window. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 100_000;
/** The most recent messages always stay word for word. */
export const KEEP_RECENT_MESSAGES = 6;
/** Fewer old messages than this is not worth a summary call. */
export const MIN_MESSAGES_TO_COMPACT = 6;

const CHARS_PER_TOKEN = 3.5;
const TOOL_RESULT_TRANSCRIPT_CHARS = 800;
const MESSAGE_TRANSCRIPT_CHARS = 2000;

export const SUMMARY_SYSTEM_PROMPT =
  "You compress the history of a coding agent's conversation so the agent can continue the work with less context. " +
  "Write a summary that covers: the user's goals and constraints; decisions made; files read or changed, with their paths and what changed; " +
  "commands run and their results; errors that are still unresolved; and what remains to do. " +
  "State only what the conversation shows. Do not call tools. Use at most 300 words.";

/** A rough size estimate with no tokenizer: good enough to decide when to compact. */
export function estimateTokens(messages: ChatMessage[], tools?: ChatRequest["tools"]): number {
  let chars = tools ? JSON.stringify(tools).length : 0;
  for (const m of messages) {
    chars += m.content.length;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
    for (const t of m.textAttachments ?? []) chars += JSON.stringify(t).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export interface CompactionPlan {
  system: ChatMessage | undefined;
  /** Loaded skills and project instructions: kept so they stay in force and a resumed session does not load them twice. */
  pinned: ChatMessage[];
  toSummarize: ChatMessage[];
  /** The latest user request, when it falls inside the summarised range. Also present in toSummarize. */
  currentRequest: ChatMessage | undefined;
  tail: ChatMessage[];
}

function isSkillLoad(m: ChatMessage): boolean {
  return m.role === "assistant" && !!m.tool_calls && m.tool_calls.length > 0 && m.tool_calls.every((c) => c.name === "load_skill");
}

/** Splits a history into what to keep and what to summarise. Returns null when there is too little to gain. */
export function planCompaction(messages: ChatMessage[]): CompactionPlan | null {
  const start = messages[0]?.role === "system" ? 1 : 0;
  let cut = Math.max(start, messages.length - KEEP_RECENT_MESSAGES);
  // A tool result must stay with the assistant message that called it.
  while (cut > start && messages[cut]?.role === "tool") cut--;

  const pinned: ChatMessage[] = [];
  const toSummarize: ChatMessage[] = [];
  for (let i = start; i < cut; i++) {
    const m = messages[i]!;
    if (isSkillLoad(m)) {
      const ids = new Set(m.tool_calls!.map((c) => c.id));
      pinned.push(m);
      while (i + 1 < cut && messages[i + 1]!.role === "tool" && ids.has(messages[i + 1]!.tool_call_id ?? "")) {
        pinned.push(messages[++i]!);
      }
    } else {
      toSummarize.push(m);
    }
  }
  if (toSummarize.length < MIN_MESSAGES_TO_COMPACT) return null;

  const tail = messages.slice(cut);
  const currentRequest = tail.some((m) => m.role === "user") ? undefined : [...toSummarize].reverse().find((m) => m.role === "user");
  return { system: start === 1 ? messages[0] : undefined, pinned, toSummarize, currentRequest, tail };
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)} [... ${text.length - max} more characters]`;
}

/** Renders messages as plain text for the summary call, keeping the most recent part when over budget. */
export function renderTranscript(messages: ChatMessage[], maxChars: number): string {
  const parts = messages.map((m) => {
    if (m.role === "tool") return `TOOL RESULT (${m.name ?? "tool"}): ${shorten(m.content, TOOL_RESULT_TRANSCRIPT_CHARS)}`;
    const calls = (m.tool_calls ?? []).map((c) => `\n  called ${c.name}(${shorten(JSON.stringify(c.arguments), TOOL_RESULT_TRANSCRIPT_CHARS)})`).join("");
    return `${m.role.toUpperCase()}: ${shorten(m.content, MESSAGE_TRANSCRIPT_CHARS)}${calls}`;
  });
  const text = parts.join("\n\n");
  if (text.length <= maxChars) return text;
  return `[The earliest part of the conversation is omitted.]\n${text.slice(text.length - maxChars)}`;
}

export function buildCompactedHistory(plan: CompactionPlan, summary: string): ChatMessage[] {
  const summaryMessage: ChatMessage = {
    role: "user",
    content:
      "[Summary of the earlier conversation. The original messages were removed to save context space.]\n" +
      `${summary.trim()}\n` +
      "[End of summary. File contents shown earlier are no longer available: read a file again before you edit it.]",
  };
  return [
    ...(plan.system ? [plan.system] : []),
    ...plan.pinned,
    summaryMessage,
    ...(plan.currentRequest ? [plan.currentRequest] : []),
    ...plan.tail,
  ];
}

/** Paths of the read_file calls that are still visible in a history. */
export function readPathsIn(messages: ChatMessage[]): Set<string> {
  const paths = new Set<string>();
  for (const m of messages) {
    for (const call of m.tool_calls ?? []) {
      if (call.name === "read_file" && typeof call.arguments.path === "string") paths.add(call.arguments.path);
    }
  }
  return paths;
}
