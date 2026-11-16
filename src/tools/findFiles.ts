import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool, ToolContext } from "../types.js";
import { resolveWithinWorkspace } from "../workspacePath.js";

const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "venv", ".venv", "target", "vendor"]);

export const MAX_FIND_RESULTS = 300;
/** Stops a walk of a very large tree: past this many entries the result is reported as truncated. */
const MAX_VISITED_ENTRIES = 50_000;
const MAX_PATTERN_LENGTH = 500;

interface Input {
  pattern: string;
  path?: string;
}

const MAX_BRACE_ALTERNATIVES = 32;

/** Expands {a,b} groups into plain patterns. Throws when the result would be too many patterns. */
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  const close = open === -1 ? -1 : pattern.indexOf("}", open);
  if (open === -1 || close === -1) return [pattern];
  const head = pattern.slice(0, open);
  const rest = expandBraces(pattern.slice(close + 1));
  const out: string[] = [];
  for (const option of pattern.slice(open + 1, close).split(",")) {
    for (const tail of rest) {
      out.push(head + option + tail);
      if (out.length > MAX_BRACE_ALTERNATIVES) throw new Error(`too many {a,b} combinations (max ${MAX_BRACE_ALTERNATIVES}).`);
    }
  }
  return out;
}

/** Matches one path segment against a segment pattern with * and ?. Iterative, so its cost is at most pattern length times name length. */
function matchSegment(pattern: string, name: string): boolean {
  let p = 0;
  let n = 0;
  let starAt = -1;
  let retryFrom = 0;
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === name[n])) {
      p++;
      n++;
    } else if (p < pattern.length && pattern[p] === "*") {
      starAt = p++;
      retryFrom = n;
    } else if (starAt !== -1) {
      p = starAt + 1;
      n = ++retryFrom;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/** Matches path segments against pattern segments, where a "**" segment stands for any number of folders. Each (pattern, path) position is visited once. */
function matchSegments(patternSegments: string[], pathSegments: string[]): boolean {
  const failed = new Set<number>();
  const visit = (pi: number, si: number): boolean => {
    const key = pi * (pathSegments.length + 1) + si;
    if (failed.has(key)) return false;
    let ok: boolean;
    if (pi === patternSegments.length) {
      ok = si === pathSegments.length;
    } else if (patternSegments[pi] === "**") {
      // A trailing "**" takes everything that is left; otherwise it takes zero folders or one more.
      ok = pi === patternSegments.length - 1 ? si < pathSegments.length : visit(pi + 1, si) || (si < pathSegments.length && visit(pi, si + 1));
    } else {
      ok = si < pathSegments.length && matchSegment(patternSegments[pi]!, pathSegments[si]!) && visit(pi + 1, si + 1);
    }
    if (!ok) failed.add(key);
    return ok;
  };
  return visit(0, 0);
}

/**
 * Compiles a glob into a matcher over a forward-slash relative path.
 * Supports `*`, `**`, `?` and `{a,b}`; every other character is literal.
 * A pattern with no slash matches the file name in any folder, which is
 * what a model nearly always means by "*.ts".
 *
 * This is a hand-written matcher, not a regular expression, on purpose:
 * a regex built from a pattern with several wildcards can take seconds
 * or longer to reject one path, and the pattern comes from the model.
 */
export function compileGlob(glob: string): { test(relPath: string): boolean } {
  const alternatives = expandBraces(glob).map((alternative) => {
    const withFolder = alternative.includes("/") ? alternative : `**/${alternative}`;
    // Repeated "**" segments mean the same as one.
    return withFolder.split("/").filter((segment, i, all) => !(segment === "**" && all[i - 1] === "**"));
  });
  return {
    test(relPath: string): boolean {
      const pathSegments = relPath.split("/");
      return alternatives.some((patternSegments) => matchSegments(patternSegments, pathSegments));
    },
  };
}

const MAX_SIMILAR_RESULTS = 20;

/**
 * Wider patterns to try when a pattern matched nothing: the same name
 * with any extension, then any file whose name holds the first word of
 * the pattern. All of them match in any folder.
 */
export function looserPatterns(pattern: string): string[] {
  const name = (expandBraces(pattern)[0] ?? pattern).split("/").pop() ?? "";
  const out: string[] = [];
  const extension = /\.[A-Za-z0-9]+$/.exec(name);
  const stem = extension ? name.slice(0, extension.index) : name;
  if (extension && /[A-Za-z0-9]/.test(stem)) out.push(`${stem}.*`);
  const word = stem.split(/[^A-Za-z0-9]+/).find((part) => part.length >= 3);
  if (word) out.push(`*${word}*`);
  return out.filter((looser) => looser !== pattern);
}

export const findFilesTool: Tool<Input, { files: string[]; similar?: string[]; note?: string }> = {
  name: "find_files",
  description:
    "Find files by name pattern anywhere in the workspace, at any depth. Examples: \"*.test.ts\", \"src/**/*.tsx\", \"**/package.json\". Returns paths only; use grep to search file contents.",
  permission: "READ",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern. Supports *, **, ? and {a,b}." },
      path: { type: "string", description: "Subdirectory to search in, default '.'" },
    },
    required: ["pattern"],
  },
  async execute(input, ctx: ToolContext) {
    const pattern = typeof input?.pattern === "string" ? input.pattern.trim() : "";
    if (!pattern) return { ok: false, output: null, error: "pattern is required, for example \"*.ts\" or \"src/**/*.tsx\"." };
    if (pattern.length > MAX_PATTERN_LENGTH) return { ok: false, output: null, error: `pattern is too long (max ${MAX_PATTERN_LENGTH} characters).` };

    const resolvedRoot = await resolveWithinWorkspace(ctx.workspaceRoot, ".");
    if (!resolvedRoot.ok) return { ok: false, output: null, error: resolvedRoot.error };
    const resolved = await resolveWithinWorkspace(ctx.workspaceRoot, input.path ?? ".");
    if (!resolved.ok) return { ok: false, output: null, error: resolved.error };

    let matcher: { test(relPath: string): boolean };
    try {
      matcher = compileGlob(pattern);
    } catch (err: any) {
      return { ok: false, output: null, error: `Invalid pattern: ${err.message}` };
    }

    // Paths are matched relative to the starting folder and reported
    // relative to the workspace, the same convention list_directory uses.
    let visited = 0;
    let truncated = false;
    const collect = async (test: (relPath: string) => boolean, limit: number): Promise<string[]> => {
      const found: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return; // an unreadable folder is skipped, not fatal
        }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const e of entries) {
          if (truncated) return;
          if (++visited > MAX_VISITED_ENTRIES) {
            truncated = true;
            return;
          }
          const abs = path.join(dir, e.name);
          // A symlink is neither descended into nor reported: it can point outside the workspace.
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) {
            if (!IGNORE.has(e.name)) await walk(abs);
          } else if (e.isFile()) {
            const relToStart = path.relative(resolved.abs, abs).split(path.sep).join("/");
            if (!test(relToStart)) continue;
            if (found.length >= limit) {
              truncated = true;
              return;
            }
            found.push(path.relative(resolvedRoot.abs, abs).split(path.sep).join("/"));
          }
        }
      };
      await walk(resolved.abs);
      return found.sort();
    };

    const files = await collect((rel) => matcher.test(rel), MAX_FIND_RESULTS);
    if (files.length === 0 && !truncated) {
      // A model often guesses the wrong extension or the wrong naming
      // style ("*.test.ts" in a JavaScript project). An empty list alone
      // made real models stop or invent a path, so name the near matches.
      const similar: string[] = [];
      for (const looser of looserPatterns(pattern)) {
        const loose = compileGlob(looser);
        visited = 0;
        const more = await collect((rel) => loose.test(rel), MAX_SIMILAR_RESULTS);
        truncated = false;
        for (const file of more) if (!similar.includes(file) && similar.length < MAX_SIMILAR_RESULTS) similar.push(file);
        if (similar.length > 0) break;
      }
      const note =
        similar.length > 0
          ? `No file matches "${pattern}". The files in "similar" have names that are close.`
          : `No file matches "${pattern}". Try a shorter pattern, or use list_directory to see the files.`;
      return { ok: true, output: { files, ...(similar.length > 0 ? { similar } : {}), note } };
    }
    return { ok: true, output: { files }, ...(truncated ? { truncated: true } : {}) };
  },
};
