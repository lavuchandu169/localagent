import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
}

const DEFAULT_PORT = 8687;

let bundle: FreellmapiBundle | null = null;
let running: { server: { close(cb?: () => void): void }; port: number } | null = null;
let startPromise: Promise<{ port: number }> | null = null;

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

    try {
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

export async function stopFreellmapiServer(): Promise<void> {
  if (!running) return;
  await new Promise<void>((resolve) => running!.server.close(() => resolve()));
  running = null;
  bundle = null;
}

/** Test-only: clears the module-level singleton between test cases, since real app code never needs to "forget" a running server mid-process. */
export function resetFreellmapiHostForTests(): void {
  running = null;
  bundle = null;
  startPromise = null;
}
