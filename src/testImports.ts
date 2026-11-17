import path from "node:path";

/**
 * The code that a test file tests.
 *
 * A task that names a test file ("the test in test/math.test.js fails")
 * gets that file read before the model's first turn. Two real small
 * models then saw only the test, and "fixed" the test: neither opened
 * the source file that held the bug. So the agent also reads the local
 * files that the test imports.
 */

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[A-Za-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/;
const SOURCE_EXTENSIONS = [".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs"];

/** Reports whether a workspace-relative path is a test file by its name or folder. */
export function isTestFile(relPath: string): boolean {
  return TEST_FILE.test(relPath.split(path.sep).join("/"));
}

/** How many imported files are read with one test file. */
export const MAX_FILES_UNDER_TEST = 2;

/**
 * Workspace-relative paths to try for each local import of a test file,
 * in the order of the imports. One import gives several paths to try
 * (the path as written, then with each source extension, then as a
 * folder with an index file). Imports of packages are ignored, and so
 * are imports that leave the workspace or point at another test file.
 */
export function importCandidates(testRelPath: string, content: string): string[][] {
  const specifiers: string[] = [];
  const patterns = [/\brequire\(\s*["']([^"']+)["']\s*\)/g, /\bfrom\s+["']([^"']+)["']/g, /\bimport\s+["']([^"']+)["']/g, /\bimport\(\s*["']([^"']+)["']\s*\)/g];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1]!;
      if (specifier.startsWith(".") && !specifiers.includes(specifier)) specifiers.push(specifier);
    }
  }
  // The order in the file, not the order of the patterns.
  specifiers.sort((a, b) => content.indexOf(a) - content.indexOf(b));

  const dir = path.posix.dirname(testRelPath.split(path.sep).join("/"));
  const out: string[][] = [];
  for (const specifier of specifiers) {
    const base = path.posix.normalize(path.posix.join(dir, specifier));
    if (base.startsWith("..") || path.posix.isAbsolute(base)) continue;
    const withoutJsExtension = base.replace(/\.(js|mjs|cjs)$/, "");
    const tries = [base, ...SOURCE_EXTENSIONS.map((ext) => withoutJsExtension + ext), ...SOURCE_EXTENSIONS.map((ext) => `${base}/index${ext}`)];
    const unique = [...new Set(tries)].filter((candidate) => !isTestFile(candidate));
    if (unique.length > 0) out.push(unique);
  }
  return out;
}
