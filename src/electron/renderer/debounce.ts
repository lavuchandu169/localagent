/**
 * Wraps fn so that calling the returned function repeatedly only actually
 * runs fn once the calls stop arriving for delayMs — each call resets the
 * pending timer rather than queuing another run. For something like a
 * live search-as-you-type box, this turns N calls (one per keystroke,
 * each round-tripping through IPC to a disk-backed search on the main
 * process) into a single call once typing pauses, instead of one call
 * per keystroke.
 *
 * schedule/cancel default to setTimeout/clearTimeout but are injectable
 * so this can be tested without real timers.
 */
export function createDebouncer<Args extends unknown[]>(
  fn: (...args: Args) => void,
  delayMs: number,
  schedule: (cb: () => void, ms: number) => unknown = (cb, ms) => setTimeout(cb, ms),
  cancel: (handle: unknown) => void = (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0])
): (...args: Args) => void {
  let pending: unknown = null;
  return (...args: Args) => {
    if (pending !== null) cancel(pending);
    pending = schedule(() => {
      pending = null;
      fn(...args);
    }, delayMs);
  };
}
