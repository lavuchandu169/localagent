/**
 * A successful done event's summary is set (agent.ts) to the exact same
 * text as the model's own final answer — already shown moments earlier
 * via its own text/text.delta event(s). Repeating it here was pure visual
 * duplication (confirmed confusing live: "why am I getting this ✔ done —
 * <the same answer again>"), so success collapses to a bare marker.
 * Failure keeps its summary, since that's the ONLY place a failure reason
 * like "Turn budget exceeded" or "Cancelled by user" ever appears —
 * nothing else in the log shows it.
 */
export function formatDoneLine(success: boolean, summary: string): string {
  return success ? "✔ done" : `✗ failed — ${summary}`;
}
