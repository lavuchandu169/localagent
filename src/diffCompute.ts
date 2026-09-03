import { diffLines, type Change } from "diff";

/**
 * Computes a line-level diff for the edit_file permission-request UI —
 * reused directly as the `diff` npm package's own Change[] shape
 * ({value, added, removed, count}) rather than inventing a new one, since
 * it's already JSON-serializable and exactly what a diff-rendering UI needs.
 *
 * `oldContent` is `null` for a file that doesn't exist yet — diffed against
 * an empty string, so the whole thing renders as added.
 *
 * Deliberately kept out of diffUtil.ts: this is the only diff-related piece
 * that needs the `diff` npm package at runtime (`diffLines`), and
 * diffUtil.ts's groupDiffIntoSegments/applyHunkSelection are imported
 * directly by the renderer's unbundled `<script type="module">` — loaded by
 * Chromium's native ES module loader with no Node resolution
 * (contextIsolation: true, nodeIntegration: false), which cannot resolve a
 * bare "diff" specifier. A module-level `import ... from "diff"` anywhere
 * in a file the renderer imports aborts that file's entire evaluation
 * (confirmed live — it takes the whole renderer.js entry module down with
 * it, not just the diff feature, since ES modules link every static import
 * before running any top-level code). computeFileDiff is only ever called
 * from main-process code (agent.ts, changesSince.ts), so it's fine for it
 * to depend on the npm package directly.
 */
export function computeFileDiff(oldContent: string | null, newContent: string): Change[] {
  return diffLines(oldContent ?? "", newContent);
}
