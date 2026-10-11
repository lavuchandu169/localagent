/**
 * Formats the live local-model performance badge text — pulled into its
 * own module (not inline in renderer.ts, which is a large top-level
 * script not practical to import in a test) so this pure formatting has
 * direct test coverage.
 */
export function formatPerfBadge(tokensPerSecond: number, contextUsedTokens: number, contextSizeTokens: number): string {
  return `⚡ ~${Math.round(tokensPerSecond)} tok/s · ${contextUsedTokens}/${contextSizeTokens} ctx`;
}
