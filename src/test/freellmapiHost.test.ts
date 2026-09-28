import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  startFreellmapiServer,
  getFreellmapiUnifiedApiKey,
  ensureFreellmapiSessionToken,
  stopFreellmapiServer,
  resetFreellmapiHostForTests,
  isFreellmapiRunning,
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

console.log("\nstopFreellmapiServer while a request is in flight:");
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "freellmapi-host-test-"));
  const file = path.join(dir, "server.mjs");
  await fs.writeFile(
    file,
    `
    export async function startServer(opts) {
      let closed = false;
      return {
        server: {
          close(cb) {
            closed = true;
            // Simulate a request that was mid-flight when shutdown was
            // requested still finishing its own work after close() is
            // called - close() itself must not throw or hang either way.
            setTimeout(() => cb && cb(), 5);
          },
        },
        port: opts.preferredPort,
      };
    }
    export function getUnifiedApiKey() { return "k"; }
    export function ensureSessionToken() { return "t"; }
    `,
    "utf-8"
  );
  resetFreellmapiHostForTests();
  await startFreellmapiServer({ userDataDir: dir, bundlePath: file, clientDistPath: dir, preferredPort: 19996 });

  let threw = false;
  try {
    await stopFreellmapiServer();
  } catch {
    threw = true;
  }
  check("stopping while a request is conceptually in flight resolves cleanly, never throws", !threw);

  await fs.rm(dir, { recursive: true, force: true });
}

console.log("\nstartFreellmapiServer neutralizes the bundle's own global process-crash handlers:");
{
  // Real finding, confirmed by reading vendor/freellmapi/server/src/lib/process-safety-net.ts
  // directly: the vendored server's startServer() calls installProcessSafetyNet(),
  // which registers GLOBAL process.on('uncaughtException'/'unhandledRejection')
  // listeners that call process.exit(1) on anything it doesn't recognize as a
  // transient transport error. Since this runs inside localagent's own Electron
  // main process (not a subprocess), that would silently kill the whole app on
  // any unrelated error, anywhere, the moment this feature is first used - and
  // race ahead of main.ts's own uncaughtException handler's async error-log
  // write, which is registered first but does real (slower) async work before
  // exiting. This fake bundle simulates exactly that registration.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "freellmapi-host-test-"));
  const file = path.join(dir, "server.mjs");
  await fs.writeFile(
    file,
    `
    export async function startServer(opts) {
      process.on('uncaughtException', () => {});
      process.on('unhandledRejection', () => {});
      return { server: { close: (cb) => cb && cb() }, port: opts.preferredPort };
    }
    export function getUnifiedApiKey() { return "k"; }
    export function ensureSessionToken() { return "t"; }
    `,
    "utf-8"
  );
  resetFreellmapiHostForTests();

  const uncaughtBefore = process.listeners("uncaughtException").length;
  const rejectionBefore = process.listeners("unhandledRejection").length;

  await startFreellmapiServer({ userDataDir: dir, bundlePath: file, clientDistPath: dir, preferredPort: 19994 });

  check(
    "no new uncaughtException listener survives startup",
    process.listeners("uncaughtException").length === uncaughtBefore
  );
  check(
    "no new unhandledRejection listener survives startup",
    process.listeners("unhandledRejection").length === rejectionBefore
  );

  await stopFreellmapiServer();
  await fs.rm(dir, { recursive: true, force: true });
}

console.log("\nstartFreellmapiServer disables the vendored server's own network call to freellmapi.co:");
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "freellmapi-host-test-"));
  const bundlePath = await writeFakeBundle(dir);
  resetFreellmapiHostForTests();
  const before = process.env.CATALOG_SYNC_DISABLED;
  delete process.env.CATALOG_SYNC_DISABLED;

  await startFreellmapiServer({ userDataDir: dir, bundlePath, clientDistPath: dir, preferredPort: 19993 });

  check(
    "CATALOG_SYNC_DISABLED is set before the vendored server boots, honoring the spec's never-talks-to-freellmapi.co constraint",
    process.env.CATALOG_SYNC_DISABLED === "1"
  );

  if (before === undefined) delete process.env.CATALOG_SYNC_DISABLED;
  else process.env.CATALOG_SYNC_DISABLED = before;
  await stopFreellmapiServer();
  await fs.rm(dir, { recursive: true, force: true });
}

console.log("\nstartFreellmapiServer works when NODE_ENV=development (a real dev-machine setting, not hypothetical):");
{
  // Real finding, confirmed by reading vendor/freellmapi/server/src/db/index.ts
  // directly: when NODE_ENV === "development", the vendored DB init code
  // expects a database that was ALREADY migrated by a separate
  // `npm run db:migration:up` step, and calls process.exit(1) - killing the
  // whole localagent app - if it wasn't. localagent's own bundled DB is
  // always freshly created, never pre-migrated by any separate step, so this
  // would crash on the very first real use whenever a developer's
  // environment happens to have NODE_ENV=development set (common). The
  // fake bundle here can't reproduce process.exit(1) itself (that would kill
  // the test runner), so this instead verifies the mechanism the real fix
  // relies on: NODE_ENV is temporarily suppressed around the startServer()
  // call and restored afterward, regardless of success or failure.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "freellmapi-host-test-"));
  const file = path.join(dir, "server.mjs");
  await fs.writeFile(
    file,
    `
    export async function startServer(opts) {
      globalThis.__nodeEnvDuringStart = process.env.NODE_ENV;
      return { server: { close: (cb) => cb && cb() }, port: opts.preferredPort };
    }
    export function getUnifiedApiKey() { return "k"; }
    export function ensureSessionToken() { return "t"; }
    `,
    "utf-8"
  );
  resetFreellmapiHostForTests();
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";

  await startFreellmapiServer({ userDataDir: dir, bundlePath: file, clientDistPath: dir, preferredPort: 19992 });

  check(
    "NODE_ENV is not 'development' while the vendored server actually boots, so it runs migrations instead of expecting a pre-migrated DB",
    (globalThis as any).__nodeEnvDuringStart !== "development"
  );
  check("NODE_ENV is restored to its real value afterward, for the rest of the app", process.env.NODE_ENV === "development");

  process.env.NODE_ENV = originalNodeEnv;
  await stopFreellmapiServer();
  await fs.rm(dir, { recursive: true, force: true });
}

console.log("\nstartFreellmapiServer restores an originally-UNSET NODE_ENV to unset, not the string 'undefined':");
{
  // process.env coerces `undefined` to the literal string "undefined" on
  // assignment - a naive `process.env.NODE_ENV = originalValue` restore
  // would leave NODE_ENV="undefined" behind for the rest of the app when it
  // was never set in the first place. Caught this in review before it ever
  // ran, not after a failure - this test is what actually proves the fix.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "freellmapi-host-test-"));
  const bundlePath = await writeFakeBundle(dir);
  resetFreellmapiHostForTests();
  const originalNodeEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV;

  await startFreellmapiServer({ userDataDir: dir, bundlePath, clientDistPath: dir, preferredPort: 19991 });

  check("an originally-unset NODE_ENV stays genuinely unset afterward, not the string 'undefined'", process.env.NODE_ENV === undefined);

  if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
  await stopFreellmapiServer();
  await fs.rm(dir, { recursive: true, force: true });
}

console.log("\nisFreellmapiRunning:");
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "freellmapi-host-test-"));
  const bundlePath = await writeFakeBundle(dir);
  resetFreellmapiHostForTests();

  check("false before startFreellmapiServer has ever been called", !isFreellmapiRunning());

  await startFreellmapiServer({ userDataDir: dir, bundlePath, clientDistPath: dir, preferredPort: 19990 });
  check("true once startFreellmapiServer has resolved", isFreellmapiRunning());

  await stopFreellmapiServer();
  check("false again after stopFreellmapiServer resolves", !isFreellmapiRunning());

  await fs.rm(dir, { recursive: true, force: true });
}

console.log("\nstopFreellmapiServer closes the bundle's SQLite handle:");
{
  // Real finding: the vendored bundle exports getDb() (server-host.ts
  // re-exports it), and freellmapiHost.ts never called it on shutdown —
  // the SQLite connection was simply abandoned when the HTTP server closed,
  // relying on process exit to release the file handle rather than closing
  // it cleanly. A clean close on quit avoids leaving the WAL file in a
  // state that needs recovery on next launch.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "freellmapi-host-test-"));
  const file = path.join(dir, "server.mjs");
  await fs.writeFile(
    file,
    `
    let dbClosed = false;
    export async function startServer(opts) {
      return { server: { close: (cb) => cb && cb() }, port: opts.preferredPort };
    }
    export function getUnifiedApiKey() { return "k"; }
    export function ensureSessionToken() { return "t"; }
    export function getDb() {
      return {
        close() {
          dbClosed = true;
          globalThis.__fakeDbClosed = true;
        },
      };
    }
    `,
    "utf-8"
  );
  resetFreellmapiHostForTests();
  (globalThis as any).__fakeDbClosed = false;

  await startFreellmapiServer({ userDataDir: dir, bundlePath: file, clientDistPath: dir, preferredPort: 19989 });
  await stopFreellmapiServer();

  check("the bundle's getDb().close() was called during shutdown", (globalThis as any).__fakeDbClosed === true);

  await fs.rm(dir, { recursive: true, force: true });
}

console.log("\nstopFreellmapiServer does not hang forever if server.close() never calls back:");
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "freellmapi-host-test-"));
  const file = path.join(dir, "server.mjs");
  await fs.writeFile(
    file,
    `
    export async function startServer(opts) {
      return { server: { close(cb) { /* never calls cb — simulates a hung close */ } }, port: opts.preferredPort };
    }
    export function getUnifiedApiKey() { return "k"; }
    export function ensureSessionToken() { return "t"; }
    `,
    "utf-8"
  );
  resetFreellmapiHostForTests();
  await startFreellmapiServer({ userDataDir: dir, bundlePath: file, clientDistPath: dir, preferredPort: 19988 });

  const started = Date.now();
  await stopFreellmapiServer({ timeoutMs: 50 });
  const elapsedMs = Date.now() - started;

  check("stopFreellmapiServer resolves via its own timeout instead of hanging forever", elapsedMs < 2000);
  check("isFreellmapiRunning() is false after a timed-out stop, so app exit isn't blocked", !isFreellmapiRunning());

  await fs.rm(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
