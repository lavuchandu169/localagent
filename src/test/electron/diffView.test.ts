// diffView.ts had no test coverage at all before this (test-engineer
// finding, full-project audit) despite being the shared rendering
// function behind every edit_file approval card and the "Files changed"
// panel — a jsdom Document is installed before the dynamic import below
// since renderDiff calls document.createElement at call time (not import
// time, so a static import would also work here, but dynamic keeps the
// same established pattern as this repo's other renderer test files).
import { JSDOM } from "jsdom";
import { computeFileDiff } from "../../diffCompute.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(globalThis as any).document = dom.window.document;

const { renderDiff } = await import("../../electron/renderer/diffView.js");

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

function lineTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".diff-line")).map((el) => el.textContent ?? "");
}

console.log("renderDiff:")
{
  const diff = computeFileDiff("line1\nline2\nline3\n", "line1\nCHANGED\nline3\n");
  const container = renderDiff(diff);
  check("renders a container with the diff-view class", container.className === "diff-view");
  const lines = lineTexts(container);
  check("the removed line is rendered with a '-' prefix", lines.some((l) => l === "- line2"));
  check("the added line is rendered with a '+' prefix", lines.some((l) => l === "+ CHANGED"));
  check("unchanged context lines are rendered with a ' ' prefix", lines.some((l) => l === "  line1"));
}
{
  const diff = computeFileDiff("line1\nline2\nline3\n", "line1\nCHANGED\nline3\n");
  const container = renderDiff(diff, false);
  const checkboxes = container.querySelectorAll<HTMLInputElement>(".diff-hunk-toggle input");
  check("a non-read-only diff gets a checkbox for its one real hunk", checkboxes.length === 1);
  check("the checkbox is checked by default (today's implicit approve-everything)", checkboxes[0]?.checked === true);
  check("the checkbox carries the hunk's id for later readback", checkboxes[0]?.dataset.hunkId === "0");
}
{
  const diff = computeFileDiff("line1\nline2\nline3\n", "line1\nCHANGED\nline3\n");
  const container = renderDiff(diff, true);
  check("a read-only diff gets no checkboxes at all — nothing to attach a selection to", container.querySelectorAll(".diff-hunk-toggle input").length === 0);
  const lines = lineTexts(container);
  check("the actual diff content is still fully rendered in read-only mode", lines.some((l) => l === "- line2") && lines.some((l) => l === "+ CHANGED"));
}
{
  const diff = computeFileDiff(null, "brand new file\n");
  const container = renderDiff(diff);
  const lines = lineTexts(container);
  check("a pure insertion (new file) renders only an added line, no removed line", lines.every((l) => !l.startsWith("-")) && lines.some((l) => l === "+ brand new file"));
}
{
  // DIFF_LINE_CAP (300) truncation — a long diff must stop rendering and
  // show a visible marker instead of silently rendering thousands of DOM
  // nodes.
  const oldContent = Array.from({ length: 400 }, (_, i) => `old line ${i}`).join("\n") + "\n";
  const newContent = Array.from({ length: 400 }, (_, i) => `new line ${i}`).join("\n") + "\n";
  const diff = computeFileDiff(oldContent, newContent);
  const container = renderDiff(diff);
  const lines = container.querySelectorAll(".diff-line");
  check("rendering stops at the line cap rather than rendering every line of a huge diff", lines.length <= 301); // cap + the truncation marker itself also has the diff-line class
  check("a visible truncation marker is appended", container.querySelector(".diff-truncated")?.textContent === "… diff truncated …");
}
{
  const diff = computeFileDiff("line1\nline2\n", "line1\nline2\n");
  const container = renderDiff(diff);
  check("a diff with no actual changes renders only context lines, no hunks", container.querySelectorAll(".diff-hunk").length === 0);
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
