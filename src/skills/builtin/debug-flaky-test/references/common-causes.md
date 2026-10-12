# Common causes of flaky tests, in the order to check them

1. **Shared mutable state between tests** — a module-level variable, a
   singleton, or a file on disk that one test leaves in a different
   state than the next test expects. Run the failing test ALONE
   (filtered to just that one test) several times in a row; if it never
   fails alone, the cause is cross-test pollution, not the test itself.
2. **Timing assumptions** — a fixed `sleep`/`setTimeout` standing in for
   "wait until X is actually ready," racing against real async work (a
   network call, a file write, a spawned process) that doesn't always
   finish within that fixed window under load.
3. **Unseeded randomness or real wall-clock time** — `Math.random()`,
   `Date.now()`, or any real clock/UUID touching an assertion.
4. **Real network/filesystem/external-process dependencies** inside a
   unit test — anything that should have been mocked but wasn't is
   inherently nondeterministic.
