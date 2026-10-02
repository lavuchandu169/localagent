import { promises as fs } from "node:fs";
import path from "node:path";

export type WorkspacePathResult = { ok: true; abs: string } | { ok: false; error: string };

/**
 * Resolves a tool-supplied relative path against workspaceRoot, refusing
 * anything that escapes it — including two ways the naive
 * `path.resolve(root, rel).startsWith(path.resolve(root))` check used
 * across this codebase's file tools got wrong (security audit findings
 * H2/M2):
 *
 * 1. No trailing separator on the prefix check means a SIBLING directory
 *    whose name happens to start with the workspace root's own name
 *    passes (root "/a/x" vs "/a/x-evil/secret" — "x-evil" starts with
 *    "x" as a raw string).
 * 2. No symlink resolution at all — a cloned repo can ship a symlink
 *    INSIDE the workspace that points OUTSIDE it, and the naive check
 *    never notices because it never follows the link.
 *
 * For a path that doesn't exist yet (edit_file creating a brand-new
 * file), `fs.realpath` on the full path fails — this falls back to
 * resolving the PARENT directory's real path instead, so a symlinked
 * parent directory is still caught even though the leaf file itself has
 * no real path yet. If the parent doesn't exist either (a new nested
 * directory about to be mkdir -p'd), there is no symlink to resolve yet
 * either way, so the naive (already containment-checked) path is used.
 */
export async function resolveWithinWorkspace(workspaceRoot: string, relPath: string): Promise<WorkspacePathResult> {
  const syntacticRoot = path.resolve(workspaceRoot);
  const naive = path.resolve(syntacticRoot, relPath);
  if (!isWithin(naive, syntacticRoot)) {
    return { ok: false, error: "Path escapes workspace root." };
  }

  // The comparison baseline must be symlink-resolved too, not just the
  // candidate path — on macOS, os.tmpdir() (and some real project
  // directories) live under a path whose own ancestor is itself a symlink
  // (/tmp -> /private/tmp, /var -> /private/var), so comparing a resolved
  // candidate against an unresolved root would reject everything,
  // including the root itself. The workspace root is assumed to actually
  // exist (the app is already running against it), so this always
  // resolves on the first attempt in practice.
  const resolvedRoot = await realOrFallback(syntacticRoot);
  if (resolvedRoot === null) {
    return { ok: false, error: "Could not resolve workspace root." };
  }
  const real = await realOrFallback(naive);
  if (real === null) {
    // Final-review Critical #1, confirmed live: a DANGLING symlink (the
    // link itself exists; its target doesn't) made fs.realpath throw for
    // a reason indistinguishable, by that error alone, from "this path
    // segment just doesn't exist yet" — the old fallback treated both
    // cases identically and silently let edit_file write straight through
    // the link to wherever it pointed, outside the workspace. There is no
    // safe way to know where a dangling link resolves to once its target
    // is eventually created, so it's rejected outright rather than
    // guessed at.
    return { ok: false, error: "Path escapes workspace root (dangling symlink)." };
  }
  if (!isWithin(real, resolvedRoot)) {
    return { ok: false, error: "Path escapes workspace root (symlink)." };
  }
  return { ok: true, abs: real };
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * Resolves symlinks as far as the filesystem allows. Walks up from the
 * full candidate path until it finds an ancestor that actually exists
 * (e.g. edit_file creating "new/nested/file.txt" inside an existing
 * workspace — neither the file nor "new"/"new/nested" exist yet), resolves
 * THAT ancestor's real path, then rejoins the not-yet-existing trailing
 * segments on top of it. This keeps the result on the same symlink-
 * resolved basis as resolvedRoot above, however deep the not-yet-existing
 * part goes — falling back to the first existing ancestor's realpath
 * only (an earlier version's bug) would still mismatch a multi-level new
 * path against an already-resolved root.
 *
 * Returns null (reject) rather than falling through to "not yet
 * created" when a failing segment turns out to actually exist as a
 * symlink (lstat succeeds where realpath didn't) — that's a DANGLING
 * symlink, not an absent path, and it can't be safely treated as either
 * "resolve its target" (there is none yet) or "ignore it" (the caller
 * would write straight through it once a target does appear). Any lstat
 * failure OTHER than ENOENT (EACCES, ELOOP, ENOTDIR — a real but
 * unusual filesystem condition) also rejects rather than silently
 * treating it as absent.
 */
async function realOrFallback(naive: string): Promise<string | null> {
  let current = naive;
  const notYetExisting: string[] = [];
  while (true) {
    try {
      const resolved = await fs.realpath(current);
      return notYetExisting.length > 0 ? path.join(resolved, ...notYetExisting.reverse()) : resolved;
    } catch {
      if (!(await isTrulyAbsent(current))) return null; // dangling symlink, or some other real error — reject rather than guess
      const parent = path.dirname(current);
      if (parent === current) return naive; // hit the filesystem root with nothing resolvable at all
      notYetExisting.push(path.basename(current));
      current = parent;
    }
  }
}

/** True only when `p` genuinely doesn't exist at all (lstat itself throws
 * ENOENT) — the one case it's safe to treat as "not yet created" and keep
 * walking up. Anything lstat can actually see at this path — a dangling
 * symlink, or a file/directory realpath otherwise failed on for some
 * other reason (EACCES, ELOOP) — is a real, inspectable thing on disk
 * that the caller must not silently skip past. */
async function isTrulyAbsent(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return false;
  } catch (err: any) {
    return err?.code === "ENOENT";
  }
}
