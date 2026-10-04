import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { StorageCrypto } from "./googleAuth.js";
import { getOrCreateFreellmapiEncryptionKey } from "./freellmapiEncryptionKey.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface FreellmapiHostDeps {
  userDataDir: string;
  bundlePath?: string;
  clientDistPath?: string;
  preferredPort?: number;
}

interface FreellmapiBundle {
  startServer(opts: { dbPath: string; clientDist: string; host: string; preferredPort: number }): Promise<{
    server: { close(cb?: () => void): void };
    port: number;
  }>;
  getUnifiedApiKey(): string;
  ensureSessionToken(): string;
  /** Optional: only the real vendored bundle exports this (server-host.ts re-exports server/src/db/index.ts's getDb). Absent from hand-written test fakes that don't care about DB shutdown. */
  getDb?(): { close?(): void };
}

const DEFAULT_PORT = 8687;
const DEFAULT_STOP_TIMEOUT_MS = 5000;

let bundle: FreellmapiBundle | null = null;
let running: { server: { close(cb?: () => void): void }; port: number } | null = null;
let startPromise: Promise<{ port: number }> | null = null;
let storageCrypto: StorageCrypto | undefined;

/**
 * Set once by main.ts at startup, with the exact same storageCrypto every
 * other credential in this app already uses (safeStorage-backed when
 * available, undefined otherwise). startFreellmapiServer() is a
 * process-wide singleton already (see its own doc comment), so this
 * module-level value — rather than threading a new parameter through
 * buildProvider()/FreellmapiProxyProvider's constructor across several
 * files — is how it reaches the ENCRYPTION_KEY generation/persistence
 * below regardless of whether freellmapiProxy.ts's healthCheck() or
 * main.ts's freellmapiConn() is the caller that actually starts the
 * server first. Never calling this (e.g. in tests) just means the key is
 * persisted as a 0600 plaintext file instead — the same unavailable-
 * secure-storage fallback every other credential in this app already has.
 */
export function setFreellmapiStorageCrypto(crypto: StorageCrypto | undefined): void {
  storageCrypto = crypto;
}

/**
 * Process-wide singleton: every caller (regardless of how many sessions/tabs
 * select the "freellmapi" provider) shares ONE running server. The bundled
 * server owns its own SQLite database and account, so a second instance
 * would mean two independent, out-of-sync copies of both - not just wasted
 * resources. Concurrent callers before the first start resolves all await
 * the SAME in-flight promise (see startPromise) rather than racing.
 */
export async function startFreellmapiServer(deps: FreellmapiHostDeps): Promise<{ port: number }> {
  if (running) return { port: running.port };
  if (startPromise) return startPromise;

  startPromise = (async () => {
    const bundlePath = deps.bundlePath ?? path.join(__dirname, "..", "..", "dist", "freellmapi", "server.mjs");
    const clientDist = deps.clientDistPath ?? path.join(__dirname, "..", "..", "dist", "freellmapi", "client-dist");
    const dbPath = path.join(deps.userDataDir, "freellmapi", "data.db");

    // The vendored server's own startServer() calls installProcessSafetyNet(),
    // which registers GLOBAL process.on('uncaughtException'/'unhandledRejection')
    // listeners that call process.exit(1) on anything not recognized as a
    // transient transport error - confirmed by reading
    // vendor/freellmapi/server/src/lib/process-safety-net.ts directly. Since
    // this runs IN-PROCESS inside localagent's own Electron main process (not
    // a subprocess), left alone this would silently kill the whole app on any
    // unrelated error the moment this feature is first used, racing ahead of
    // main.ts's own uncaughtException handler (registered first, but does
    // real async work - writing error.log - before exiting). The vendored
    // code exports no way to opt out of this (installProcessSafetyNet isn't
    // even re-exported from server-host.ts), so this snapshots each event's
    // listeners before startServer() runs and removes whatever new ones
    // appeared after - leaving every pre-existing listener (localagent's own)
    // completely untouched.
    const uncaughtBefore = new Set(process.listeners("uncaughtException"));
    const rejectionBefore = new Set(process.listeners("unhandledRejection"));

    // The vendored server calls startCatalogSync() unconditionally at boot
    // (confirmed by reading vendor/freellmapi/desktop/src/server-host.ts and
    // server/src/services/catalog-sync.ts directly), which by default fetches
    // https://api.freellmapi.co/v1/latest 10s after boot and every 12h after
    // that. The spec is explicit that this integration runs free/self-hosted
    // mode only and never talks to freellmapi.co on the user's behalf -
    // catalog-sync.ts itself checks this exact env var before making the
    // call, so setting it here (before the bundle's module code runs) is a
    // clean, non-invasive way to honor that without patching vendored source.
    process.env.CATALOG_SYNC_DISABLED = "1";

    // The vendored DB init (server/src/db/index.ts) expects, when
    // NODE_ENV === "development", that the database was already migrated by
    // a separate `npm run db:migration:up` step - and calls process.exit(1)
    // (killing the whole localagent app) if it wasn't. localagent's bundled
    // DB is always freshly created, never pre-migrated by any separate step,
    // so this would crash on first real use whenever the environment
    // happens to have NODE_ENV=development set (a common dev-machine value,
    // confirmed as a real risk, not hypothetical). Suppressed only around
    // this call, restored immediately after in the finally block below, so
    // nothing else in the app (or in the bundle's OTHER NODE_ENV checks)
    // observes a different value than what was actually set.
    const originalNodeEnv = process.env.NODE_ENV;
    if (originalNodeEnv === "development") {
      process.env.NODE_ENV = "production";
    }

    const originalEncryptionKey = process.env.ENCRYPTION_KEY;

    try {
      // Security audit finding: freellmapi-server:encryption-key-plaintext-colocated.
      // With no ENCRYPTION_KEY env var, the vendored server's own
      // isDevFallbackAllowed() (NODE_ENV !== "production") silently writes
      // the key that protects every stored provider API key as a plaintext
      // file next to its database — readable by any other process running
      // as the same OS user, no auth or race needed. initEncryptionKey()
      // runs synchronously during the vendored server's own DB-init step,
      // which happens before bundle.startServer() below resolves (confirmed
      // by reading vendor/freellmapi/server/src/db/index.ts directly), so
      // setting ENCRYPTION_KEY here and restoring it in the finally block —
      // the same pattern already used for NODE_ENV above — is safe: by the
      // time this function returns, the vendored module has already cached
      // the real key for the rest of this process's life and never consults
      // the env var again. Inside this try (not before it) so a failure
      // here still restores NODE_ENV via the existing finally below.
      const keyFilePath = path.join(deps.userDataDir, "freellmapi", ".localagent-encryption-key");
      process.env.ENCRYPTION_KEY = await getOrCreateFreellmapiEncryptionKey(keyFilePath, storageCrypto);

      bundle = (await import(pathToFileURL(bundlePath).href)) as unknown as FreellmapiBundle;
      const { server, port } = await bundle.startServer({
        dbPath,
        clientDist,
        host: "127.0.0.1",
        preferredPort: deps.preferredPort ?? DEFAULT_PORT,
      });
      running = { server, port };
      return { port };
    } finally {
      for (const listener of process.listeners("uncaughtException")) {
        if (!uncaughtBefore.has(listener as NodeJS.UncaughtExceptionListener)) {
          process.removeListener("uncaughtException", listener as NodeJS.UncaughtExceptionListener);
        }
      }
      for (const listener of process.listeners("unhandledRejection")) {
        if (!rejectionBefore.has(listener as NodeJS.UnhandledRejectionListener)) {
          process.removeListener("unhandledRejection", listener as NodeJS.UnhandledRejectionListener);
        }
      }
      // process.env coerces `undefined` to the literal string "undefined" -
      // delete the key instead when it was never set, rather than leaving a
      // bogus NODE_ENV=undefined behind for the rest of the app.
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      // Same undefined-vs-"undefined" restore for ENCRYPTION_KEY — it's
      // already cached inside the vendored module by this point (see the
      // comment above), so nothing observes this real secret sitting in
      // the ambient environment for the rest of the process's life.
      if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = originalEncryptionKey;
      // Whether it succeeded or threw, this attempt is over - a later call
      // must be free to try again rather than seeing a stale in-flight
      // promise from a failed attempt forever.
      startPromise = null;
    }
  })();

  return startPromise;
}

export function getFreellmapiUnifiedApiKey(): string {
  if (!bundle) throw new Error("getFreellmapiUnifiedApiKey() called before startFreellmapiServer() resolved");
  return bundle.getUnifiedApiKey();
}

export function ensureFreellmapiSessionToken(): string {
  if (!bundle) throw new Error("ensureFreellmapiSessionToken() called before startFreellmapiServer() resolved");
  return bundle.ensureSessionToken();
}

/**
 * before-quit needs this to know whether there's anything to shut down at
 * all - a session that never selected the "freellmapi" provider should
 * quit exactly as fast as it always did, not pay for an async
 * import()+stop() round-trip on every exit.
 */
export function isFreellmapiRunning(): boolean {
  return running !== null;
}

export async function stopFreellmapiServer(opts: { timeoutMs?: number } = {}): Promise<void> {
  if (!running) return;
  const server = running.server;
  const currentBundle = bundle;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;

  // server.close() waits for in-flight requests/connections to finish
  // before its callback fires. A request that never finishes (a stuck
  // upstream provider call, a dropped connection the OS never reports)
  // would otherwise hang app exit forever - this race against a timeout
  // guarantees shutdown always completes.
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    server.close(() => {
      clearTimeout(timer);
      finish();
    });
  });

  // Best-effort: the process may be exiting either way, and a DB already
  // left in a bad state by whatever caused close() to hang isn't made
  // worse by a close() call that itself throws.
  try {
    currentBundle?.getDb?.()?.close?.();
  } catch (err) {
    console.error("[freellmapi] error closing database on shutdown:", err);
  }

  running = null;
  bundle = null;
}

/** Test-only: clears the module-level singleton between test cases, since real app code never needs to "forget" a running server mid-process. */
export function resetFreellmapiHostForTests(): void {
  running = null;
  bundle = null;
  startPromise = null;
}
