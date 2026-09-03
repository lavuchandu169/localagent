export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * Standard (non-batch, non-cached, global-routing) per-million-token USD
 * pricing for the three Claude models this app offers — confirmed live
 * against https://platform.claude.com/docs/en/about-claude/pricing at the
 * time this was written. Anthropic can change pricing; update this table
 * if they do — it's the one place that needs to change. Deliberately not
 * modeling prompt-caching or batch discounts: this app never uses either,
 * so the standard rate is the actual rate every real request here pays.
 */
export const ANTHROPIC_PRICING: Record<string, ModelPricing> = {
  "claude-sonnet-5": { inputPerMillion: 2, outputPerMillion: 10 },
  "claude-opus-5": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-haiku-4-5": { inputPerMillion: 1, outputPerMillion: 5 },
};

/**
 * Returns null for a model id not in the table (a future/renamed Claude
 * model this table hasn't been updated for yet) rather than guessing a
 * price — callers should fall back to showing raw token counts with no
 * dollar estimate in that case, never an invented number.
 */
export function estimateCostUsd(modelId: string, inputTokens: number, outputTokens: number): number | null {
  const pricing = ANTHROPIC_PRICING[modelId];
  if (!pricing) return null;
  return (inputTokens / 1_000_000) * pricing.inputPerMillion + (outputTokens / 1_000_000) * pricing.outputPerMillion;
}
