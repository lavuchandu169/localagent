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
function* eventsFromRawText(rawEvent: string): Generator<string> {
  for (const line of rawEvent.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice("data: ".length);
    if (payload === "" || payload === "[DONE]") continue;
    yield payload;
  }
}

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
      // The SSE wire format permits LF, CR, or CRLF line endings (not just
      // LF) — normalize to LF before splitting so every framing style is
      // parsed identically.
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n|\r/g, "\n");

      let separatorIndex: number;
      while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        yield* eventsFromRawText(rawEvent);
      }
    }
    // A final event isn't always terminated by a trailing blank line — the
    // stream can simply end right after it. Flush whatever's left rather
    // than silently dropping it.
    if (buffer.length > 0) yield* eventsFromRawText(buffer);
  } finally {
    reader.releaseLock();
  }
}
