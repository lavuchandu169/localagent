// src/providers/asyncEventQueue.ts

/**
 * Bridges a callback-driven producer (node-llama-cpp's onTextChunk/
 * onFunctionCallParamsChunk options, which fire synchronously as side
 * effects of one long-running awaited call) into something an async
 * generator can `yield*` from. A callback can't itself `yield` — only the
 * generator's own body can — so the callback instead `push()`es into this
 * queue, and `embeddedLlama.ts`'s chatStream does `yield* queue` to drain
 * it live as items arrive, not after the whole generation finishes.
 */
export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void)[] = [];
  private ended = false;
  private error: unknown;

  push(item: T): void {
    const resolve = this.waiting.shift();
    if (resolve) resolve({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    this.ended = true;
    while (this.waiting.length > 0) this.waiting.shift()!({ value: undefined as unknown as T, done: true });
  }

  fail(err: unknown): void {
    this.error = err;
    this.end();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift()!;
        continue;
      }
      if (this.ended) {
        if (this.error) throw this.error;
        return;
      }
      const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
      if (result.done) {
        if (this.error) throw this.error;
        return;
      }
      yield result.value;
    }
  }
}
