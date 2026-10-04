import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool, ToolContext } from "../types.js";
import { isProtectedPath, redactSecrets } from "../protected.js";
import { resolveWithinWorkspace } from "../workspacePath.js";

interface Input {
  path: string;
  /** 1-indexed line number to start reading from — for a file too large to read in full in one call (past MAX_CONTENT_CHARS below). Omit for an ordinary small-file read. */
  offset?: number;
  /** How many lines to return starting at offset. Capped at MAX_LINE_LIMIT even if a larger value is requested, so one call can't defeat the whole point of paging through a large file. */
  limit?: number;
}

interface Output {
  path: string;
  content: string;
  /** The file's real total line count — reported even on an ordinary (non-ranged) read, so the model can tell a character-truncated read is incomplete and knows to page through the rest with offset/limit. */
  totalLines: number;
  /** Only set when offset/limit was used — the actual 1-indexed line range `content` covers (limit may have been clamped to the file's real length). */
  startLine?: number;
  endLine?: number;
}

const MAX_CONTENT_CHARS = 20000;
const DEFAULT_LINE_LIMIT = 500;
const MAX_LINE_LIMIT = 2000;

export const readFileTool: Tool<Input, Output> = {
  name: "read_file",
  description:
    "Read a text file relative to the workspace root. By default returns the whole file (up to a character cap). For a file too large to see in full that way, pass offset (1-indexed line number) and/or limit (line count, capped) to read a specific range instead — the result's totalLines tells you how big the file really is.",
  permission: "READ",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to workspace root" },
      offset: { type: "number", description: "1-indexed line number to start reading from, for a large file" },
      limit: { type: "number", description: "Number of lines to return starting at offset (capped at 2000)" },
    },
    required: ["path"],
  },
  async execute(input, ctx: ToolContext) {
    const rel = input.path;
    if (isProtectedPath(rel)) {
      return { ok: false, output: null, error: `Refusing to read protected path: ${rel}` };
    }
    const resolved = await resolveWithinWorkspace(ctx.workspaceRoot, rel);
    if (!resolved.ok) {
      return { ok: false, output: null, error: resolved.error };
    }
    const abs = resolved.abs;
    // Final review Important #4, confirmed live: a symlink whose own NAME
    // ("cfg") looks innocent but RESOLVES inside .git (or any other
    // protected pattern) bypassed the check above entirely, since it only
    // ever looked at the requested string, never where the path actually
    // points. Re-check isProtectedPath against the resolved, workspace-
    // relative target too, normalized to forward slashes so the `.git/`
    // pattern still matches on Windows (path.relative there uses `\`).
    const resolvedRoot = await resolveWithinWorkspace(ctx.workspaceRoot, ".");
    if (resolvedRoot.ok) {
      const resolvedRel = path.relative(resolvedRoot.abs, abs).split(path.sep).join("/");
      if (isProtectedPath(resolvedRel)) {
        return { ok: false, output: null, error: `Refusing to read protected path: ${rel}` };
      }
    }
    try {
      const content = await fs.readFile(abs, "utf8");
      // split("\n") on content ending with a trailing newline (the normal
      // case for almost every real text file) produces one extra empty
      // element after the real last line — "a\nb\n".split("\n") is
      // ["a","b",""], not ["a","b"]. Conventional line-count tools (wc -l)
      // count newline CHARACTERS, not split segments, so that trailing
      // artifact must be dropped to avoid reporting one line too many —
      // but only ever the LAST one: a genuine blank line elsewhere (or a
      // genuine blank line at the very end, from TWO trailing newlines)
      // must still count for real. totalLines is always computed from
      // the ORIGINAL content, never the redacted one below — pagination
      // math (startLine/endLine/totalLines) must stay tied to the real
      // file structure regardless of how many lines a redacted secret
      // collapses into.
      const rawLines = content.split("\n");
      const lines = rawLines.length > 0 && rawLines[rawLines.length - 1] === "" ? rawLines.slice(0, -1) : rawLines;
      const totalLines = lines.length;

      // Security audit finding: truncate-before-redact-order. Redacting
      // against the FULL original content, before either branch below
      // truncates for display, is what both of them share — a secret
      // whose required shape (closing PEM "-----END...-----" marker, or
      // a bare token's own minimum length) straddles either truncation
      // boundary previously survived as an unmatchable partial fragment,
      // returned completely unredacted. A multi-line match (the PEM
      // pattern) collapsing into a single "[REDACTED]" line can shift
      // which exact lines the ranged branch below returns relative to
      // the original file's own numbering — an accepted, display-only
      // side effect; the content returned is never a partial, unredacted
      // secret either way.
      const redactedContent = redactSecrets(content);

      if (input.offset === undefined && input.limit === undefined) {
        const truncated = redactedContent.length > MAX_CONTENT_CHARS;
        return {
          ok: true,
          output: { path: rel, content: truncated ? redactedContent.slice(0, MAX_CONTENT_CHARS) : redactedContent, totalLines },
          truncated,
        };
      }

      const redactedRawLines = redactedContent.split("\n");
      const redactedLines = redactedRawLines.length > 0 && redactedRawLines[redactedRawLines.length - 1] === "" ? redactedRawLines.slice(0, -1) : redactedRawLines;
      const startLine = Math.max(1, input.offset ?? 1);
      const limit = Math.max(1, Math.min(MAX_LINE_LIMIT, input.limit ?? DEFAULT_LINE_LIMIT));
      const endLine = Math.min(totalLines, startLine + limit - 1);
      const selected = redactedLines.slice(startLine - 1, endLine).join("\n");
      const truncated = endLine < totalLines;
      return {
        ok: true,
        output: { path: rel, content: selected, totalLines, startLine, endLine },
        truncated,
      };
    } catch (err: any) {
      return { ok: false, output: null, error: `Could not read file: ${err.message}` };
    }
  },
};
