import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Tool, ToolContext } from "../types.js";
import { redactSecrets, isProtectedPath } from "../protected.js";
import { resolveWithinWorkspace } from "../workspacePath.js";

interface Input {
  pattern: string;
  path?: string;
}

const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "venv", ".venv", "target", "vendor"]);

/**
 * Security audit finding C2, confirmed live: without a `--` separator,
 * a pattern starting with "-" is read by ripgrep as a FLAG, not a search
 * string — `--pre=sh` makes rg run `sh <file>` on every file it scans,
 * executing arbitrary shell code even though `grep` is a READ-permission
 * tool that's auto-allowed in every mode, including PLAN. `--` is
 * ripgrep's own documented end-of-options marker: everything after it
 * (the pattern, then the search path) is always positional, never parsed
 * as a flag, however it's spelled. Exported so a test can pin this
 * directly without depending on a real `rg` binary being on PATH.
 */
export function buildRipgrepArgs(pattern: string): string[] {
  return ["--line-number", "--no-heading", "-m", "200", "--", pattern, "."];
}

function tryRipgrep(pattern: string, cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("rg", buildRipgrepArgs(pattern), { cwd });
    let out = "";
    let failed = false;
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("error", () => {
      failed = true;
      resolve(null);
    });
    proc.on("close", (code) => {
      if (failed) return;
      if (code === null || code > 1) resolve(null);
      else resolve(out);
    });
  });
}

/**
 * Security audit final-review Important #5, confirmed live: this is the
 * COMMON path for most users (ripgrep is rarely pre-installed), and it
 * previously followed any symlink it happened to walk into — Dirent's
 * own isDirectory()/isFile() reflect the LINK itself (lstat semantics),
 * not its target, so a symlink to a file fell into the `else` branch
 * below and fs.readFile happily followed it straight outside the
 * workspace. It also never skipped protected paths at all, unlike
 * read_file's isProtectedPath check — searching ".env"/"id_rsa"/etc. and
 * handing a match's surrounding text into model context.
 */
async function jsFallbackGrep(pattern: string, root: string): Promise<string> {
  const re = new RegExp(pattern);
  const lines: string[] = [];
  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue;
      if (e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (isProtectedPath(rel)) continue;
      if (e.isDirectory()) {
        await walk(abs);
      } else {
        try {
          const content = await fs.readFile(abs, "utf8");
          content.split("\n").forEach((line, i) => {
            if (lines.length < 200 && re.test(line)) {
              lines.push(`${rel}:${i + 1}:${line}`);
            }
          });
        } catch {
          /* binary or unreadable, skip */
        }
      }
    }
  }
  await walk(root);
  return lines.join("\n");
}

export const grepTool: Tool<Input, { matches: string }> = {
  name: "grep",
  description: "Search file contents for a regex pattern within the workspace.",
  permission: "READ",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: { type: "string", description: "Subdirectory to restrict search to, default '.'" },
    },
    required: ["pattern"],
  },
  async execute(input, ctx: ToolContext) {
    // Security audit finding H1: grep previously had no workspace
    // containment check at all (unlike read_file/edit_file) — a path like
    // "/Users/<you>/.ssh" searched anywhere on disk, always allowed.
    const resolved = await resolveWithinWorkspace(ctx.workspaceRoot, input.path ?? ".");
    if (!resolved.ok) {
      return { ok: false, output: null, error: resolved.error };
    }
    const root = resolved.abs;
    let result = await tryRipgrep(input.pattern, root);
    if (result === null) {
      result = await jsFallbackGrep(input.pattern, root);
    }
    // Security audit finding H1: grep never redacted secrets in its
    // output, unlike read_file — a pattern matching a real credential's
    // surrounding text (e.g. searching for "API_KEY") handed the raw
    // secret straight into model context.
    return { ok: true, output: { matches: redactSecrets(result) || "(no matches)" } };
  },
};
