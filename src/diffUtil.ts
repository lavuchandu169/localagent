import { diffLines, type Change } from "diff";

/**
 * Computes a line-level diff for the edit_file permission-request UI —
 * reused directly as the `diff` npm package's own Change[] shape
 * ({value, added, removed, count}) rather than inventing a new one, since
 * it's already JSON-serializable and exactly what a diff-rendering UI needs.
 *
 * `oldContent` is `null` for a file that doesn't exist yet — diffed against
 * an empty string, so the whole thing renders as added.
 */
export function computeFileDiff(oldContent: string | null, newContent: string): Change[] {
  return diffLines(oldContent ?? "", newContent);
}

export type DiffSegment =
  | { kind: "context"; value: string }
  | { kind: "hunk"; id: number; removedValue?: string; addedValue?: string };

/**
 * Groups a flat Change[] diff into context (always included, never
 * selectable) and hunks (one unit of actual change a user can approve or
 * reject independently) — a `removed` Change immediately followed by an
 * `added` Change is one replacement hunk; a standalone `removed` or
 * `added` Change (nothing of the opposite kind adjacent) is a pure
 * deletion or insertion hunk. Hunk ids are assigned in the order they
 * appear, starting at 0, stable for the lifetime of one diff.
 */
export function groupDiffIntoSegments(diff: Change[]): DiffSegment[] {
  const segments: DiffSegment[] = [];
  let nextHunkId = 0;
  let i = 0;
  while (i < diff.length) {
    const chunk = diff[i]!;
    if (!chunk.added && !chunk.removed) {
      segments.push({ kind: "context", value: chunk.value });
      i++;
      continue;
    }
    if (chunk.removed) {
      const next = diff[i + 1];
      if (next && next.added) {
        segments.push({ kind: "hunk", id: nextHunkId++, removedValue: chunk.value, addedValue: next.value });
        i += 2;
        continue;
      }
      segments.push({ kind: "hunk", id: nextHunkId++, removedValue: chunk.value });
      i++;
      continue;
    }
    // chunk.added, with no preceding removed — a pure insertion.
    segments.push({ kind: "hunk", id: nextHunkId++, addedValue: chunk.value });
    i++;
  }
  return segments;
}

/**
 * Reconstructs a full file content string from a diff's segments and a set
 * of approved hunk ids: context passes through unchanged; an approved hunk
 * contributes its addedValue (or nothing, for an approved pure deletion);
 * a rejected hunk contributes its removedValue instead (or nothing, for a
 * rejected pure insertion) — i.e. a rejected hunk's lines simply stay as
 * they were before the edit. Approving every hunk id reconstructs the
 * original newContent exactly; approving no hunk ids reconstructs the
 * original oldContent exactly.
 */
export function applyHunkSelection(segments: DiffSegment[], approvedHunkIds: Set<number>): string {
  let result = "";
  for (const seg of segments) {
    if (seg.kind === "context") {
      result += seg.value;
    } else if (approvedHunkIds.has(seg.id)) {
      result += seg.addedValue ?? "";
    } else {
      result += seg.removedValue ?? "";
    }
  }
  return result;
}
