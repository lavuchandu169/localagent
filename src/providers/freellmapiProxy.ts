import type { ChatRequest, ChatResponse, HealthCheckResult, ModelInfo, ModelProvider } from "../types.js";
import { OpenAICompatibleProvider } from "./openaiCompatible.js";
import { startFreellmapiServer, getFreellmapiUnifiedApiKey } from "../electron/freellmapiHost.js";

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
    return this.inner.chat(request);
  }
}
