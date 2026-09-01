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
