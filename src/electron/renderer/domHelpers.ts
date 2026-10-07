/** Looks up a required element by id, throwing immediately (rather than
 * returning null and deferring the crash to whatever first touches it)
 * if the id doesn't exist — every caller treats these as always-present
 * fixtures of index.html, not optional. */
export function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

/** The single shared spelling of "turn whatever was caught into a
 * message" — used throughout renderer.ts and its extracted panel
 * modules alike, so moved here rather than duplicated or re-imported
 * circularly between them. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Disables `button` and swaps its label to `busyText` while `fn` runs,
 * always restoring the original label and re-enabling it afterward —
 * regardless of outcome. The button-level equivalent of a spinner, for
 * actions (sign-in, sign-out) that otherwise give no visible sign
 * anything is happening beyond a plain disabled state, which reads as
 * unresponsive rather than "working." Not used for start-session, whose
 * disabled state deliberately does NOT reset on success (the setup
 * controls stay locked once a session is running) — that one keeps its
 * own inline handling instead of this always-restore helper.
 */
export async function withBusyLabel<T>(button: HTMLButtonElement, busyText: string, fn: () => Promise<T>): Promise<T> {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}
