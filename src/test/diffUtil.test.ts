import { computeFileDiff } from "../diffUtil.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("computeFileDiff:");

{
  const diff = computeFileDiff(null, "line1\nline2\n");
  check("a new file (null old content) is entirely added", diff.length === 1 && diff[0]?.added === true);
  check("the added chunk's value is the full new content", diff[0]?.value === "line1\nline2\n");
}

{
  const diff = computeFileDiff("line1\nline2\nline3\n", "line1\nline2\nline3\n");
  check("identical content produces no added/removed chunks", diff.every((c) => !c.added && !c.removed));
}

{
  const diff = computeFileDiff("line1\nline2\nline3\n", "line1\nCHANGED\nline3\n");
  const added = diff.filter((c) => c.added);
  const removed = diff.filter((c) => c.removed);
  check("a single changed line produces exactly one added chunk", added.length === 1 && added[0]?.value === "CHANGED\n");
  check("a single changed line produces exactly one removed chunk", removed.length === 1 && removed[0]?.value === "line2\n");
  check("unchanged surrounding lines are preserved as common (non-added, non-removed) chunks", diff.some((c) => !c.added && !c.removed && c.value.includes("line1")));
}

{
  const diff = computeFileDiff("line1\nline2\n", "line1\nline2\nline3\n");
  check("a pure append shows only an added chunk for the new line", diff.filter((c) => c.added).length === 1 && diff.filter((c) => c.removed).length === 0);
}

{
  const diff = computeFileDiff("keep this\n", "");
  check("emptying a file shows it as entirely removed", diff.some((c) => c.removed && c.value === "keep this\n"));
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
