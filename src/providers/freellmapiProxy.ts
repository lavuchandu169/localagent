import type { ChatRequest, ChatResponse, HealthCheckResult, ModelInfo, ModelProvider, StreamEvent } from "../types.js";
import { ProviderChatError } from "../types.js";
import { OpenAICompatibleProvider } from "./openaiCompatible.js";
import { startFreellmapiServer, getFreellmapiUnifiedApiKey } from "../electron/freellmapiHost.js";

/** Correctness audit finding (FreeLLMAPI Medium #3): OpenAICompatibleProvider
 * (which this class delegates every real request to) only ever marks a bare
 * 429 as retryable — the right call for an arbitrary user-configured custom
 * server, where any other status is a real error worth surfacing as-is.
 * FreeLLMAPI specifically, though, documents these additional statuses as
 * "this free-tier path is unusable right now" rather than "something is
 * wrong with your request" — 502/503 (the bundled router or an upstream
 * model host is down), 413 (the router rejected an oversized request it
 * couldn't route to any configured model), 404 (no model in the free tier
 * currently matches what was requested). Treating these as retryable too
 * lets agent.ts's existing fallback-to-cloud-provider path (see agent.ts's
 * run() catch block: `err.retryable && this.opts.fallbackProviders?.length`)
 * kick in instead of hard-failing the task — a no-op when no fallback
 * provider is configured, since that same check gates it. Scoped to this
 * wrapper (not the shared OpenAICompatibleProvider itself) so an arbitrary
 * custom server's genuine 400/404/413/502/503 keeps failing clearly instead
 * of silently retrying against a provider the user never asked for. */
const FREE_TIER_UNUSABLE_STATUSES = new Set([400, 404, 413, 502, 503]);

function broadenRetryable(err: unknown): never {
  if (err instanceof ProviderChatError && !err.retryable && err.status !== undefined && FREE_TIER_UNUSABLE_STATUSES.has(err.status)) {
    throw new ProviderChatError(err.message, { status: err.status, retryable: true });
  }
  throw err;
}

export interface FreellmapiProxyOptions {
  userDataDir: string;
}

/** Injectable seam over freellmapiHost.js's real functions — ES module named
 * exports are read-only bindings (confirmed live: assigning to the imported
 * namespace throws "Cannot assign to read only property"), so a test can't
 * monkeypatch them the way it can a plain object's properties. Defaulted to
 * the real functions, so every production call site (buildProvider(), Task
 * 7's renderer path) stays exactly `new FreellmapiProxyProvider({ userDataDir })`
 * — only tests ever pass the second argument. */
export interface FreellmapiProxyDeps {
  startFreellmapiServer: typeof startFreellmapiServer;
  getFreellmapiUnifiedApiKey: typeof getFreellmapiUnifiedApiKey;
}

const defaultDeps: FreellmapiProxyDeps = { startFreellmapiServer, getFreellmapiUnifiedApiKey };

/**
 * A thin adapter, not a real HTTP client of its own: once the bundled
 * FreeLLMAPI server is confirmed running (via healthCheck(), lazily -
 * constructing this class never itself starts anything, matching
 * EmbeddedLlamaProvider's existing lazy-load convention), every real
 * request is delegated to the EXISTING OpenAICompatibleProvider, since
 * FreeLLMAPI already speaks the exact same /v1 shape. No new HTTP/parsing
 * code lives here on purpose.
 */
export class FreellmapiProxyProvider implements ModelProvider {
  id = "freellmapi";
  private inner: OpenAICompatibleProvider | null = null;

  constructor(
    private opts: FreellmapiProxyOptions,
    private deps: FreellmapiProxyDeps = defaultDeps
  ) {}

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const { port } = await this.deps.startFreellmapiServer({ userDataDir: this.opts.userDataDir });
      const apiKey = this.deps.getFreellmapiUnifiedApiKey();
      this.inner = new OpenAICompatibleProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey, local: false });
      return this.inner.healthCheck();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.inner ? this.inner.listModels() : [];
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!this.inner) {
      throw new Error("FreellmapiProxyProvider.chat() called before healthCheck() established a connection.");
    }
    try {
      return await this.inner.chat(request);
    } catch (err) {
      broadenRetryable(err);
    }
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    if (!this.inner) {
      throw new Error("FreellmapiProxyProvider.chatStream() called before healthCheck() established a connection.");
    }
    try {
      yield* this.inner.chatStream!(request);
    } catch (err) {
      broadenRetryable(err);
    }
  }
}
