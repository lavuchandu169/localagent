import type { AttachedText } from "./types.js";

/**
 * The one place every provider (Anthropic, OpenAI-compatible, embedded
 * llama) formats a text attachment into its folded-in wire text — kept in
 * sync by construction instead of by three separately-maintained literals
 * that happened to match.
 */
export function formatTextAttachment(a: AttachedText): string {
  return `\n\n--- Attached file: ${a.name} ---\n${a.content}\n---`;
}
