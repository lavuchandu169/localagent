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

/**
 * Turns a glob into an anchored regular expression over a forward-slash
 * relative path. Supports `*`, `**`, `?` and `{a,b}`; every other
 * character is literal. A pattern with no slash matches the file name
 * in any folder, which is what a model nearly always means by "*.ts".
 */
export function globToRegExp(glob: string): RegExp {
  const pattern = glob.includes("/") ? glob : `**/${glob}`;
  let out = "";
  let inBraces = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          out += "(?:[^/]+/)*"; // "**/" : zero or more folders
        } else {
          out += ".*"; // trailing "**" : everything below
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "{") {
      inBraces = true;
      out += "(?:";
    } else if (ch === "}" && inBraces) {
      inBraces = false;
      out += ")";
    } else if (ch === "," && inBraces) {
      out += "|";
    } else {
      out += ch.replace(/[.+^$()|[\]\\{}]/g, "\\$&");
    }
  }
  if (inBraces) out += ")";
  return new RegExp(`^${out}$`);
}

export const findFilesTool: Tool<Input, { files: string[] }> = {
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

    let matcher: RegExp;
    try {
      matcher = globToRegExp(pattern);
    } catch (err: any) {
      return { ok: false, output: null, error: `Invalid pattern: ${err.message}` };
    }

    const files: string[] = [];
    let visited = 0;
    let truncated = false;
    // Paths are matched relative to the starting folder and reported
    // relative to the workspace, the same convention list_directory uses.
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
          if (!matcher.test(relToStart)) continue;
          if (files.length >= MAX_FIND_RESULTS) {
            truncated = true;
            return;
          }
          files.push(path.relative(resolvedRoot.abs, abs).split(path.sep).join("/"));
        }
      }
    };
    await walk(resolved.abs);
    files.sort();
    return { ok: true, output: { files }, ...(truncated ? { truncated: true } : {}) };
  },
};
