/**
 * Pulls filename-shaped tokens out of free-text task descriptions (e.g. "fix the
 * bug in app.py" -> ["app.py"]). Deliberately loose — a false positive (like
 * "e.g." or a version number) just results in a failed read_file attempt that
 * gets silently skipped by the caller, so precision matters less than recall here.
 */
export function extractFilenameCandidates(task: string): string[] {
  const matches = task.match(/[\w][\w./-]*\.[A-Za-z]{1,10}\b/g) ?? [];
  return [...new Set(matches)];
}
