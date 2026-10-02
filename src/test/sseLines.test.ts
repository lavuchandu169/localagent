// src/test/sseLines.test.ts
import { parseSseLines } from "../providers/sseLines.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

/** A fake Response whose body streams the given raw byte chunks one at a time — lets a test control exactly how bytes are split across reader.read() calls, independent of how the string was originally written. */
function fakeSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream);
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of gen) out.push(line);
  return out;
}

console.log("parseSseLines:");
{
  const response = fakeSseResponse(['data: {"a":1}\n\n', 'data: {"a":2}\n\n']);
  const lines = await collect(parseSseLines(response));
  check("yields each event's JSON payload, in order", JSON.stringify(lines) === JSON.stringify(['{"a":1}', '{"a":2}']));
}

{
  // A line split across two separate read() calls, mid-payload — proves
  // the buffering actually waits for a full "\n\n" terminator rather than
  // assuming one read() call always delivers one whole event.
  const response = fakeSseResponse(['data: {"a":', '1}\n\n']);
  const lines = await collect(parseSseLines(response));
  check("reassembles a payload split across chunk boundaries", JSON.stringify(lines) === JSON.stringify(['{"a":1}']));
}

{
  const response = fakeSseResponse(["data: [DONE]\n\n"]);
  const lines = await collect(parseSseLines(response));
  check("filters out the [DONE] sentinel instead of yielding it as a payload", lines.length === 0);
}

{
  const response = fakeSseResponse(['data: {"a":1}\n\ndata: [DONE]\n\n']);
  const lines = await collect(parseSseLines(response));
  check("a [DONE] sentinel after real events still stops cleanly, without yielding it", JSON.stringify(lines) === JSON.stringify(['{"a":1}']));
}

{
  const response = fakeSseResponse([""]);
  const lines = await collect(parseSseLines(response));
  check("an empty body yields nothing, not a crash", lines.length === 0);
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
