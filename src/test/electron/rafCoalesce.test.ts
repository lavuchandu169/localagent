// rafCoalesce.ts was pulled out of renderer.ts (web-performance-auditor
// finding: text.delta forces a synchronous reflow on every streamed
// token by reading eventLog.scrollHeight right after each mutation) so
// the coalescing behavior itself has direct test coverage — renderer.ts
// is a large top-level script wired at import time and not practical to
// unit test as a whole.
import { createFrameCoalescer } from "../../electron/renderer/rafCoalesce.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

// A fake scheduler standing in for requestAnimationFrame: captures the
// callback instead of running it, so the test controls exactly when a
// "frame" fires rather than depending on real browser timing.
function fakeScheduler() {
  const pending: Array<() => void> = [];
  return {
    schedule: (cb: () => void) => pending.push(cb),
    fireFrame: () => {
      const callbacks = pending.splice(0, pending.length);
      for (const cb of callbacks) cb();
    },
    pendingCount: () => pending.length,
  };
}

console.log("createFrameCoalescer:");
{
  const scheduler = fakeScheduler();
  let calls = 0;
  const coalesced = createFrameCoalescer(() => calls++, scheduler.schedule);

  coalesced();
  check("a single call schedules exactly one frame", scheduler.pendingCount() === 1);
  check("fn has not run yet — only the frame was scheduled", calls === 0);

  scheduler.fireFrame();
  check("fn runs exactly once once the frame fires", calls === 1);
}
{
  const scheduler = fakeScheduler();
  let calls = 0;
  const coalesced = createFrameCoalescer(() => calls++, scheduler.schedule);

  // Simulates many streamed tokens arriving within the same animation
  // frame — the exact scenario the original bug hit once per token.
  for (let i = 0; i < 50; i++) coalesced();
  check("50 calls within the same frame schedule only one frame", scheduler.pendingCount() === 1);

  scheduler.fireFrame();
  check("fn still only runs once for all 50 coalesced calls", calls === 1);
}
{
  const scheduler = fakeScheduler();
  let calls = 0;
  const coalesced = createFrameCoalescer(() => calls++, scheduler.schedule);

  coalesced();
  scheduler.fireFrame();
  coalesced();
  scheduler.fireFrame();
  check("a call AFTER a frame has already fired schedules and runs again — this isn't a run-once-ever latch", calls === 2);
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
