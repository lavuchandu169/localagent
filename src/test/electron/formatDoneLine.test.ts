// formatDoneLine lives in its own small module (not renderer.ts, which is
// a large top-level script wired at import time and not practical to
// import in a test) after a live report: a successful task's done event
// always repeated the model's own final answer a second time, prefixed
// with "✔ done — " — confusing, since the answer already appeared via its
// own text/text.delta event moments earlier.
import { formatDoneLine } from "../../electron/renderer/doneLine.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("formatDoneLine:");
{
  const line = formatDoneLine(true, "Hello! How can I assist you today?");
  check("a successful done collapses to a bare marker", line === "✔ done");
  check("the summary text is NOT repeated — it already appeared as the model's own answer", !line.includes("Hello"));
}
{
  const line = formatDoneLine(false, "Turn budget exceeded.");
  check("a failure keeps its summary — it's the only place this message ever appears", line === "✗ failed — Turn budget exceeded.");
}
{
  const line = formatDoneLine(false, "Cancelled by user.");
  check("a different failure summary is shown correctly too, not a fixed string", line === "✗ failed — Cancelled by user.");
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
