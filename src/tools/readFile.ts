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
  /** Set when the content is only part of the file: says which lines these are and how to get the next ones. */
  note?: string;
}

const MAX_CONTENT_CHARS = 20000;
/** Characters kept free in a result for everything that is not the file content. */
const RESULT_OVERHEAD_CHARS = 400;

/** How many characters of file content, counted as JSON text, one result can hold for this session's model. */
function contentCap(ctx: ToolContext): number {
  return Math.max(500, Math.min(MAX_CONTENT_CHARS, (ctx.maxResultChars ?? Infinity) - RESULT_OVERHEAD_CHARS));
}

/** JSON escapes make text longer in the conversation than it is in the file. */
function jsonLength(text: string): number {
  return JSON.stringify(text).length - 2;
}

/** How many of the lines, from the first, fit in the cap. */
function linesThatFit(lines: string[], cap: number): number {
  let size = 0;
  let count = 0;
  for (const line of lines) {
    const added = jsonLength(line) + (count > 0 ? 2 : 0); // a line break is two characters in JSON
    if (size + added > cap) break;
    size += added;
    count++;
  }
  return count;
}

function partNote(startLine: number, endLine: number, totalLines: number): string {
  return `This is only lines ${startLine} to ${endLine} of ${totalLines}. The file is longer. To read the next part, call read_file with offset ${endLine + 1}.`;
}
const DEFAULT_LINE_LIMIT = 500;
const MAX_LINE_LIMIT = 2000;

// Performance finding (code-review-and-quality pass): every read loaded the
// WHOLE file into memory via fs.readFile before any of the truncation
// logic below ever ran, and offset/limit paging didn't change that — a
// huge file (a multi-GB log, a large data dump accidentally targeted) got
// read in full even though at most MAX_CONTENT_CHARS chars or
// MAX_LINE_LIMIT lines of it could ever be returned. Checked via a cheap
// stat() before the real read; an ordinary source file is always far
// under this, and redactSecrets' own need to see the full content to
// correctly redact a match straddling a truncation boundary (see below)
// means there's no safe way to read only a prefix instead — the only
// remaining lever is refusing outright above a sane size, same posture
// attachments.ts already takes with MAX_IMAGE_BYTES/MAX_TEXT_BYTES.
const MAX_READABLE_BYTES = 10 * 1024 * 1024; // 10MB

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
      const stat = await fs.stat(abs);
      if (stat.size > MAX_READABLE_BYTES) {
        return {
          ok: false,
          output: null,
          error: `File is too large to read in full (${stat.size} bytes, max ${MAX_READABLE_BYTES}) — use grep to search it instead of reading it whole.`,
        };
      }
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
        const cap = contentCap(ctx);
        if (jsonLength(redactedContent) <= cap) return { ok: true, output: { path: rel, content: redactedContent, totalLines }, truncated: false };
        // Cut at the end of a line, and say which lines these are, so the model can ask for the next ones.
        const allLines = redactedContent.split("\n");
        const count = linesThatFit(allLines, cap);
        // One line longer than the whole limit: show the start of it.
        const content = count > 0 ? allLines.slice(0, count).join("\n") : redactedContent.slice(0, Math.floor(cap / 2));
        const endLine = Math.max(1, count);
        return {
          ok: true,
          // The note comes before the content: a small model gives most weight to what it reads first.
          output: { path: rel, note: partNote(1, endLine, totalLines), totalLines, startLine: 1, endLine, content },
          truncated: true,
        };
      }

      const redactedRawLines = redactedContent.split("\n");
      const redactedLines = redactedRawLines.length > 0 && redactedRawLines[redactedRawLines.length - 1] === "" ? redactedRawLines.slice(0, -1) : redactedRawLines;
      const startLine = Math.max(1, input.offset ?? 1);
      const limit = Math.max(1, Math.min(MAX_LINE_LIMIT, input.limit ?? DEFAULT_LINE_LIMIT));
      const wanted = redactedLines.slice(startLine - 1, Math.min(totalLines, startLine + limit - 1));
      // The requested range can be more than this model is shown: return the lines that fit, and say where they stop.
      const count = wanted.length === 0 ? 0 : Math.max(1, linesThatFit(wanted, contentCap(ctx)));
      const endLine = wanted.length === 0 ? Math.min(totalLines, startLine + limit - 1) : startLine + count - 1;
      const cutBySize = count < wanted.length;
      const truncated = endLine < totalLines;
      return {
        ok: true,
        output: { path: rel, ...(cutBySize ? { note: partNote(startLine, endLine, totalLines) } : {}), totalLines, startLine, endLine, content: wanted.slice(0, count).join("\n") },
        truncated,
      };
    } catch (err: any) {
      return { ok: false, output: null, error: `Could not read file: ${err.message}` };
    }
  },
};
