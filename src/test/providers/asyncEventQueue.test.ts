// src/test/asyncEventQueue.test.ts
import { AsyncEventQueue } from "../../providers/asyncEventQueue.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

async function collect<T>(queue: AsyncEventQueue<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of queue) out.push(item);
  return out;
}

console.log("AsyncEventQueue:");
{
  // Items pushed BEFORE any consumer starts iterating must still be
  // delivered, in order — the queue buffers rather than drops.
  const queue = new AsyncEventQueue<number>();
  queue.push(1);
  queue.push(2);
  queue.end();
  const items = await collect(queue);
  check("delivers items pushed before iteration started, in order", JSON.stringify(items) === JSON.stringify([1, 2]));
}

{
  // The consumer is often AHEAD of the producer (waiting on the next
  // push) — the queue must resolve that wait the moment push() is called,
  // not require the producer to push everything upfront.
  const queue = new AsyncEventQueue<string>();
  const resultPromise = collect(queue);
  await new Promise((r) => setTimeout(r, 10));
  queue.push("a");
  await new Promise((r) => setTimeout(r, 10));
  queue.push("b");
  queue.end();
  const items = await resultPromise;
  check("delivers items pushed AFTER the consumer was already waiting", JSON.stringify(items) === JSON.stringify(["a", "b"]));
}

{
  const queue = new AsyncEventQueue<number>();
  queue.push(1);
  queue.fail(new Error("boom"));
  const received: number[] = [];
  let threw: any = null;
  try {
    for await (const item of queue) received.push(item);
  } catch (err) {
    threw = err;
  }
  check("an item pushed before fail() is still delivered before the throw", received.length === 1 && received[0] === 1);
  check("fail() surfaces its error to the consumer after any already-queued items", threw instanceof Error && threw.message === "boom");
}

{
  const queue = new AsyncEventQueue<number>();
  queue.end();
  const items = await collect(queue);
  check("ending an empty queue yields nothing, not a hang or a crash", items.length === 0);
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
