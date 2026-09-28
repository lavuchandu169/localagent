import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  startFreellmapiServer,
  getFreellmapiUnifiedApiKey,
  ensureFreellmapiSessionToken,
  stopFreellmapiServer,
  resetFreellmapiHostForTests,
} from "../electron/freellmapiHost.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

// A minimal fake "bundle" implementing exactly the three functions
// freellmapiHost.ts imports - proves the wrapper's own logic (singleton
// caching, dep-passing, shutdown) without paying for a real vendored
// server boot in every CI run. Task 6's manual verification step is what
// exercises the REAL bundle end-to-end.
// Node's dynamic import() caches modules by resolved URL — overwriting the
// SAME file path with new content and re-importing it returns the STALE
// cached module, not the fresh one (confirmed live: a retry-after-failure
// test reusing one path kept re-throwing the original failure). Each call
// gets its own filename so every import() genuinely loads fresh content.
let fakeBundleCounter = 0;
async function writeFakeBundle(dir: string, opts: { failStart?: boolean; simulatePortConflict?: boolean } = {}) {
  const file = path.join(dir, `server-${fakeBundleCounter++}.mjs`);
  await fs.writeFile(
    file,
    `
    let startCount = 0;
    export async function startServer(opts) {
      startCount++;
      globalThis.__fakeBundleStartCount = startCount;
      globalThis.__fakeBundleLastOpts = opts;
      ${opts.failStart ? "throw new Error('fake boot failure');" : ""}
      // The REAL vendored server-host.ts does its own scan-and-retry
      // (listenWithScan) when opts.preferredPort is taken, and can end up
      // listening on a DIFFERENT port than the one it was asked for. This
      // fake stands in for that outcome directly, since re-implementing a
      // real port-conflict here would only prove Node's own listen()
      // behavior, not freellmapiHost.ts's own logic.
      const actualPort = ${opts.simulatePortConflict ? "opts.preferredPort + 1" : "opts.preferredPort"};
      return { server: { close: (cb) => cb && cb() }, port: actualPort };
    }
    export function getUnifiedApiKey() { return "fake-unified-key"; }
    export function ensureSessionToken() { return "fake-session-token"; }
    `,
    "utf-8"
  );
  return file;
}

console.log("freellmapiHost:");

{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "freellmapi-host-test-"));
  const bundlePath = await writeFakeBundle(dir);
  resetFreellmapiHostForTests();

  const first = await startFreellmapiServer({ userDataDir: dir, bundlePath, clientDistPath: dir, preferredPort: 19999 });
  const second = await startFreellmapiServer({ userDataDir: dir, bundlePath, clientDistPath: dir, preferredPort: 19999 });

  check("returns the preferred port", first.port === 19999);
  check("a second call returns the SAME port without starting again", second.port === first.port);
  check(
    "the bundle's startServer was only actually invoked once (singleton, not one server per call)",
    (globalThis as any).__fakeBundleStartCount === 1
  );
  check("getFreellmapiUnifiedApiKey delegates to the bundle", getFreellmapiUnifiedApiKey() === "fake-unified-key");
  check("ensureFreellmapiSessionToken delegates to the bundle", ensureFreellmapiSessionToken() === "fake-session-token");

  await stopFreellmapiServer();
  await fs.rm(dir, { recursive: true, force: true });
}

{
  // Review Focus: "port conflict on first start" — the bundle's own
  // scan-and-retry can hand back a DIFFERENT port than requested;
  // freellmapiHost.ts must surface that REAL port, never the originally
  // requested one it happened to pass in.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "freellmapi-host-test-"));
  const bundlePath = await writeFakeBundle(dir, { simulatePortConflict: true });
  resetFreellmapiHostForTests();

  const result = await startFreellmapiServer({ userDataDir: dir, bundlePath, clientDistPath: dir, preferredPort: 19995 });
  check("when the preferred port was taken, the actual (scanned) port is what's returned", result.port === 19996);

  await stopFreellmapiServer();
  await fs.rm(dir, { recursive: true, force: true });
}

{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "freellmapi-host-test-"));
  const bundlePath = await writeFakeBundle(dir, { failStart: true });
  resetFreellmapiHostForTests();

  let threw = false;
  try {
    await startFreellmapiServer({ userDataDir: dir, bundlePath, clientDistPath: dir, preferredPort: 19998 });
  } catch (err) {
    threw = true;
    check("a boot failure's real message reaches the caller", err instanceof Error && err.message.includes("fake boot failure"));
  }
  check("a failed start throws rather than silently returning", threw);

  // A failed start must not poison the singleton forever - retrying after
  // fixing whatever was wrong should be able to succeed.
  resetFreellmapiHostForTests();
  const goodBundle = await writeFakeBundle(dir, { failStart: false });
  const retried = await startFreellmapiServer({ userDataDir: dir, bundlePath: goodBundle, clientDistPath: dir, preferredPort: 19998 });
  check("a fresh attempt after a failure can still succeed", retried.port === 19998);

  await stopFreellmapiServer();
  await fs.rm(dir, { recursive: true, force: true });
}

{
  // Two "sessions" both wanting the free-tier router concurrently must
  // share one boot, not race two - this is the Review Focus item about
  // never running two server instances.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "freellmapi-host-test-"));
  const bundlePath = await writeFakeBundle(dir);
  resetFreellmapiHostForTests();

  const [a, b] = await Promise.all([
    startFreellmapiServer({ userDataDir: dir, bundlePath, clientDistPath: dir, preferredPort: 19997 }),
    startFreellmapiServer({ userDataDir: dir, bundlePath, clientDistPath: dir, preferredPort: 19997 }),
  ]);
  check("concurrent start calls resolve to the same port", a.port === b.port);
  check("concurrent start calls only actually boot the server once", (globalThis as any).__fakeBundleStartCount === 1);

  await stopFreellmapiServer();
  await fs.rm(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
