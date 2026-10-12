---
name: debug-flaky-test
description: Use when a test fails intermittently, not every run.
triggers: [flaky, intermittent, "fails sometimes", nondeterministic]
---
A test that fails sometimes and passes other times almost never has a
root cause in the assertion itself — chasing the assertion wastes time.

Reproduce it deterministically before attempting a fix: run the suspect
test in a tight loop (10-50x) to get a reliable local repro, or add
targeted logging and capture a failing run. A fix proposed without a
reliable repro is a guess, not a fix — say so explicitly if a repro
can't be obtained rather than claiming the issue is resolved.

See references/common-causes.md for the four most common root causes,
in the order to check them.
