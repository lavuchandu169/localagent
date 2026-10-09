// debounce.ts was pulled out of renderer.ts (web-performance-auditor
// finding: the sidebar's session-search input fired an IPC call to a
// disk-backed search on every keystroke, with no debounce) so the
// debouncing behavior itself has direct test coverage — renderer.ts is a
// large top-level script wired at import time and not practical to unit
// test as a whole.
import { createDebouncer } from "../../electron/renderer/debounce.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

// A fake scheduler standing in for setTimeout/clearTimeout: captures the
// pending callback instead of running it on a real clock, so the test
// controls exactly when the delay elapses.
function fakeTimers() {
  let nextHandle = 0;
  const pending = new Map<number, { cb: () => void; ms: number }>();
  return {
    schedule: (cb: () => void, ms: number) => {
      const handle = nextHandle++;
      pending.set(handle, { cb, ms });
      return handle;
    },
    cancel: (handle: unknown) => {
      pending.delete(handle as number);
    },
    fireAll: () => {
      const callbacks = Array.from(pending.values());
      pending.clear();
      for (const { cb } of callbacks) cb();
    },
    pendingCount: () => pending.size,
    pendingDelay: () => Array.from(pending.values())[0]?.ms,
  };
}

console.log("createDebouncer:");
{
  const timers = fakeTimers();
  const calls: string[] = [];
  const debounced = createDebouncer((text: string) => calls.push(text), 200, timers.schedule, timers.cancel);

  debounced("h");
  check("a single call schedules exactly one pending timer", timers.pendingCount() === 1);
  check("fn has not run yet — only the timer was scheduled", calls.length === 0);
  check("the timer was scheduled for the configured delay", timers.pendingDelay() === 200);

  timers.fireAll();
  check("fn runs exactly once, with the single call's argument, once the timer fires", calls.length === 1 && calls[0] === "h");
}
{
  const timers = fakeTimers();
  const calls: string[] = [];
  const debounced = createDebouncer((text: string) => calls.push(text), 200, timers.schedule, timers.cancel);

  // Simulates fast typing — each keystroke arrives before the previous
  // timer elapses, the exact scenario the original bug fired an IPC call
  // for on every single one of.
  debounced("h");
  debounced("he");
  debounced("hel");
  debounced("hell");
  debounced("hello");
  check("rapid-fire calls leave only one pending timer, not one per call", timers.pendingCount() === 1);

  timers.fireAll();
  check("fn runs exactly once", calls.length === 1);
  check("fn runs with the LATEST call's argument, not an earlier one", calls[0] === "hello");
}
{
  const timers = fakeTimers();
  const calls: string[] = [];
  const debounced = createDebouncer((text: string) => calls.push(text), 200, timers.schedule, timers.cancel);

  debounced("first");
  timers.fireAll();
  debounced("second");
  timers.fireAll();
  check("a call after a previous debounced call already fired schedules and runs again — not a run-once-ever latch", calls.length === 2 && calls[0] === "first" && calls[1] === "second");
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
