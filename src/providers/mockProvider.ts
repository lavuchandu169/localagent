import type { ChatRequest, ChatResponse, HealthCheckResult, ModelInfo, ModelProvider } from "../types.js";

/** A scripted step that throws instead of returning a response — lets a
 * test simulate a provider error (e.g. a rate limit) at a specific point
 * in a multi-turn script, without a real network call. */
export type MockScriptEntry = ChatResponse | { throws: Error };

function isThrowsEntry(entry: MockScriptEntry): entry is { throws: Error } {
  return typeof entry === "object" && entry !== null && "throws" in entry;
}

/**
 * A scripted provider: each call to chat() returns the next scripted response
 * in sequence, regardless of input. Used for unit/integration tests and for
 * "product-eval" scenarios (Section 54) where a live LLM is unavailable, so
 * the harness (loop, permissions, tools) can be verified independently of any model.
 */
export class MockProvider implements ModelProvider {
  id = "mock";
  private step = 0;
  /** Every request this provider has received, in order — lets a test verify what was actually sent (e.g. which tools were offered), not just what came back. */
  receivedRequests: ChatRequest[] = [];
  constructor(private script: MockScriptEntry[]) {}

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "mock-model", local: true }];
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return { ok: true };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.receivedRequests.push(request);
    const entry = this.script[this.step];
    if (!entry) {
      return { turn: { type: "final", content: "(mock provider script exhausted)" } };
    }
    this.step++;
    if (isThrowsEntry(entry)) throw entry.throws;
    return entry;
  }
}
