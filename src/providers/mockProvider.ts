import type { ChatRequest, ChatResponse, ModelInfo, ModelProvider } from "../types.js";

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
  constructor(private script: ChatResponse[]) {}

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "mock-model", local: true }];
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.receivedRequests.push(request);
    const response = this.script[this.step];
    if (!response) {
      return { turn: { type: "final", content: "(mock provider script exhausted)" } };
    }
    this.step++;
    return response;
  }
}
