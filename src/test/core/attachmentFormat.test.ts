// attachmentFormat.ts had no test coverage at all before this (test-engineer
// finding, full-project audit) despite being the single shared place every
// provider (Anthropic, OpenAI-compatible, embedded llama) formats a text
// attachment into its folded-in wire text.
import { formatTextAttachment } from "../../attachmentFormat.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("formatTextAttachment:");
{
  const result = formatTextAttachment({ name: "notes.txt", content: "hello world" });
  check("starts with a blank line separating it from whatever text precedes it", result.startsWith("\n\n"));
  check("names the attached file", result.includes("Attached file: notes.txt"));
  check("includes the file's content verbatim", result.includes("hello world"));
  check("ends with a closing marker, not left dangling", result.endsWith("---"));
}
{
  const result = formatTextAttachment({ name: "empty.txt", content: "" });
  check("an empty file still produces well-formed markers on both sides, not a broken/collapsed format", result.includes("--- Attached file: empty.txt ---") && result.endsWith("\n---"));
}
{
  const multiline = "line 1\nline 2\nline 3";
  const result = formatTextAttachment({ name: "multi.txt", content: multiline });
  check("multi-line content is preserved verbatim, not flattened to one line", result.includes(multiline));
}
{
  // Two different attachments must not be formatted identically — a
  // trivial but real way a copy-paste bug (e.g. hardcoding one field)
  // could slip through.
  const a = formatTextAttachment({ name: "a.txt", content: "same content" });
  const b = formatTextAttachment({ name: "b.txt", content: "same content" });
  check("two attachments with the same content but different names format differently", a !== b);
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
