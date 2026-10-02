// src/providers/sseLines.ts

/**
 * Parses a `text/event-stream` HTTP response body (the `data: {json}\n\n`
 * framing OpenAI, OpenAI-compatible servers, and Gemini's `alt=sse` mode
 * all use) into its raw JSON payload strings, one per event. Buffers
 * across chunk boundaries — a single event's bytes are never guaranteed
 * to arrive in one `reader.read()` call — and filters out a literal
 * `[DONE]` payload (OpenAI's own stream-end sentinel) rather than hand
 * it to a caller expecting JSON.
 */
export async function* parseSseLines(response: Response): AsyncGenerator<string> {
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separatorIndex: number;
      while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        for (const line of rawEvent.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice("data: ".length);
          if (payload === "[DONE]") continue;
          yield payload;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
