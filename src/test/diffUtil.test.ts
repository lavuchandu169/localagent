import { computeFileDiff, groupDiffIntoSegments, applyHunkSelection } from "../diffUtil.js";

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

console.log("\ngroupDiffIntoSegments:");

{
  const diff = computeFileDiff("line1\nline2\nline3\n", "line1\nCHANGED\nline3\n");
  const segments = groupDiffIntoSegments(diff);
  const hunks = segments.filter((s) => s.kind === "hunk");
  check("a single-line replacement produces exactly one hunk", hunks.length === 1);
  check("the hunk's removedValue is the real old line", hunks[0]?.kind === "hunk" && hunks[0].removedValue === "line2\n");
  check("the hunk's addedValue is the real new line", hunks[0]?.kind === "hunk" && hunks[0].addedValue === "CHANGED\n");
  check("surrounding unchanged lines become context segments, not hunks", segments.some((s) => s.kind === "context" && s.value.includes("line1")));
}

{
  const diff = computeFileDiff("line1\nline2\n", "line1\nline2\nline3\n");
  const segments = groupDiffIntoSegments(diff);
  const hunks = segments.filter((s) => s.kind === "hunk");
  check("a pure append produces one hunk with no removedValue", hunks.length === 1 && hunks[0]?.kind === "hunk" && hunks[0].removedValue === undefined);
  check("the pure-append hunk's addedValue is the new line", hunks[0]?.kind === "hunk" && hunks[0].addedValue === "line3\n");
}

{
  const diff = computeFileDiff("keep this\ndrop this\n", "keep this\n");
  const segments = groupDiffIntoSegments(diff);
  const hunks = segments.filter((s) => s.kind === "hunk");
  check("a pure deletion produces one hunk with no addedValue", hunks.length === 1 && hunks[0]?.kind === "hunk" && hunks[0].addedValue === undefined);
  check("the pure-deletion hunk's removedValue is the dropped line", hunks[0]?.kind === "hunk" && hunks[0].removedValue === "drop this\n");
}

{
  // Two separate changes in one file — each gets its own hunk with a distinct id.
  const diff = computeFileDiff("a\nb\nc\nd\ne\n", "A\nb\nc\nD\ne\n");
  const segments = groupDiffIntoSegments(diff);
  const hunks = segments.filter((s) => s.kind === "hunk");
  check("two separate changes produce two distinct hunks", hunks.length === 2);
  const ids = hunks.map((h) => (h.kind === "hunk" ? h.id : -1));
  check("the two hunks have distinct ids", ids[0] !== ids[1]);
}

console.log("\napplyHunkSelection:");

{
  const oldContent = "line1\nline2\nline3\n";
  const newContent = "line1\nCHANGED\nline3\n";
  const diff = computeFileDiff(oldContent, newContent);
  const segments = groupDiffIntoSegments(diff);
  const allHunkIds = new Set(segments.filter((s) => s.kind === "hunk").map((s) => (s.kind === "hunk" ? s.id : -1)));

  check("approving every hunk id reconstructs the new content exactly", applyHunkSelection(segments, allHunkIds) === newContent);
  check("approving no hunk ids reconstructs the old content exactly", applyHunkSelection(segments, new Set()) === oldContent);
}

{
  // Two independent hunks — approve only the first, reject the second, and
  // confirm the reconstructed content mixes them correctly, not just
  // reproducing one whole side or the other.
  const oldContent = "a\nb\nc\nd\ne\n";
  const newContent = "A\nb\nc\nD\ne\n";
  const diff = computeFileDiff(oldContent, newContent);
  const segments = groupDiffIntoSegments(diff);
  const hunks = segments.filter((s) => s.kind === "hunk");
  const firstHunkId = hunks[0]?.kind === "hunk" ? hunks[0].id : -1;

  const merged = applyHunkSelection(segments, new Set([firstHunkId]));
  check("approving only the first hunk applies just that change, leaving the second hunk's line as it was", merged === "A\nb\nc\nd\ne\n");
}

{
  // A pure-insertion hunk that's rejected contributes nothing (not undefined-as-text).
  const oldContent = "line1\nline2\n";
  const newContent = "line1\nline2\nline3\n";
  const diff = computeFileDiff(oldContent, newContent);
  const segments = groupDiffIntoSegments(diff);
  check("rejecting a pure-insertion hunk reconstructs exactly the old content", applyHunkSelection(segments, new Set()) === oldContent);
}

{
  // A pure-deletion hunk that's approved contributes nothing.
  const oldContent = "keep this\ndrop this\n";
  const newContent = "keep this\n";
  const diff = computeFileDiff(oldContent, newContent);
  const segments = groupDiffIntoSegments(diff);
  const hunks = segments.filter((s) => s.kind === "hunk");
  const hunkId = hunks[0]?.kind === "hunk" ? hunks[0].id : -1;
  check("approving a pure-deletion hunk reconstructs exactly the new (shorter) content", applyHunkSelection(segments, new Set([hunkId])) === newContent);
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
