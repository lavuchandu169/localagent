/**
 * Wraps fn so that no matter how many times the returned function is
 * called before the next animation frame fires, fn runs at most once for
 * that frame. For a callback that only cares about "latest state so far"
 * — e.g. scrolling a log to its current bottom — this turns N calls within
 * one frame (one per streamed token, in the worst case) into a single
 * scheduled callback instead of N synchronous reflows.
 *
 * scheduleFrame defaults to requestAnimationFrame but is injectable so
 * this can be tested without a browser's animation-frame timing.
 */
export function createFrameCoalescer(fn: () => void, scheduleFrame: (cb: () => void) => void = requestAnimationFrame): () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    scheduleFrame(() => {
      scheduled = false;
      fn();
    });
  };
}
