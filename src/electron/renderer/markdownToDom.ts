/**
 * Parses a small, deliberately limited markdown subset into real DOM
 * nodes — headers, bold/italic, inline code, fenced code blocks, lists,
 * tables, and links — never via innerHTML. This app's CSP (main.ts) and
 * the project's own repeated documented norm (mcpServersPanel.ts,
 * renderer.ts, onboarding.ts's own tiny code-span parser) are explicit:
 * untrusted/model-generated text must never be parsed as HTML. Anything
 * outside this subset (blockquotes, images, nested inline formatting)
 * just renders as plain text — never throws, never breaks.
 */

export interface MarkdownRenderOptions {
  /** Called when the user clicks a rendered link, with its real href —
   * wired by the caller to window.agent.openExternal (same pattern
   * freellmapiPanel.ts already uses), never a real in-window
   * navigation. */
  onLinkClick: (url: string) => void;
  /** Overridable for testing; defaults to navigator.clipboard.writeText. */
  writeToClipboard?: (text: string) => Promise<void>;
}

type Alignment = "left" | "center" | "right" | null;

type Block =
  | { type: "heading"; level: number; content: string }
  | { type: "code"; lang: string; content: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; header: string[]; alignments: Alignment[]; rows: string[][] }
  | { type: "paragraph"; content: string };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^```(\S*)\s*$/;
const UL_ITEM_RE = /^[-*]\s+(.*)$/;
const OL_ITEM_RE = /^\d+\.\s+(.*)$/;
// A GFM-style table needs a header row followed immediately by a
// delimiter row of dash/colon groups, one per column (e.g. `|---|:--:|`
// or without the outer pipes) — the delimiter row is what distinguishes
// a real table from a paragraph that merely happens to contain a "|".
const TABLE_DELIMITER_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Splits one table row line into its raw (untrimmed-formatting, still
 * inline-markdown) cell strings — drops a single leading/trailing `|`
 * (outer pipes are optional in GFM) but doesn't handle a `|` escaped
 * inside a cell's own content, consistent with this module's "small,
 * deliberately limited" scope. */
function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
}

/** Whether `lines[i]` begins a table — the same look-ahead (current line
 * has a "|", next line is a valid delimiter row) used both to start
 * parsing one, and to stop a paragraph from swallowing it: without the
 * second use, a paragraph immediately followed by a table (no blank line
 * between them, both completely valid) would consume the table's own
 * lines as more paragraph text and join them with spaces — reproducing
 * the exact "table squashed into one line" regression this feature
 * exists to fix, just one line later than intro text. */
function isTableStart(lines: string[], i: number): boolean {
  return i + 1 < lines.length && lines[i]!.includes("|") && TABLE_DELIMITER_RE.test(lines[i + 1]!);
}

function delimiterCellToAlignment(cell: string): Alignment {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

function splitIntoBlocks(text: string): Block[] {
  const lines = text.split(/\r?\n/);
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      i++;
      continue;
    }

    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const lang = fenceMatch[1] ?? "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i]!)) {
        codeLines.push(lines[i]!);
        i++;
      }
      // Whether the fence was ever closed or we just ran out of input
      // (an unterminated fence), either way what's accumulated so far
      // is rendered as code rather than losing it or throwing.
      if (i < lines.length) i++; // consume the closing ``` line, if any
      blocks.push({ type: "code", lang, content: codeLines.join("\n") });
      continue;
    }

    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      blocks.push({ type: "heading", level: headingMatch[1]!.length, content: headingMatch[2]! });
      i++;
      continue;
    }

    const ulMatch = UL_ITEM_RE.exec(line);
    if (ulMatch) {
      const items = [ulMatch[1]!];
      i++;
      while (i < lines.length) {
        const next = UL_ITEM_RE.exec(lines[i]!);
        if (!next) break;
        items.push(next[1]!);
        i++;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }

    const olMatch = OL_ITEM_RE.exec(line);
    if (olMatch) {
      const items = [olMatch[1]!];
      i++;
      while (i < lines.length) {
        const next = OL_ITEM_RE.exec(lines[i]!);
        if (!next) break;
        items.push(next[1]!);
        i++;
      }
      blocks.push({ type: "list", ordered: true, items });
      continue;
    }

    // Table: the current line plus the NEXT line (a delimiter row) are
    // what commit to treating this as a table rather than a paragraph
    // that merely contains a "|" — ordinary prose is never immediately
    // followed by a dash/colon delimiter row like this.
    if (isTableStart(lines, i)) {
      const header = splitTableRow(line);
      const alignments = splitTableRow(lines[i + 1]!).map(delimiterCellToAlignment);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim() !== "" && lines[i]!.includes("|")) {
        rows.push(splitTableRow(lines[i]!));
        i++;
      }
      blocks.push({ type: "table", header, alignments, rows });
      continue;
    }

    // Paragraph: consume consecutive plain lines until a blank line or
    // the start of a different block type.
    const paragraphLines = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i]!;
      if (next.trim() === "" || FENCE_RE.test(next) || HEADING_RE.test(next) || UL_ITEM_RE.test(next) || OL_ITEM_RE.test(next) || isTableStart(lines, i)) break;
      paragraphLines.push(next);
      i++;
    }
    blocks.push({ type: "paragraph", content: paragraphLines.join(" ") });
  }

  return blocks;
}

// Order matters: code spans and bold are checked before a lone "*" would
// otherwise be read as the start of an (incorrect) italic span.
const INLINE_RE = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\)/g;

/** Parses inline formatting within a single block's text (a heading,
 * paragraph, or list item) into real DOM nodes. Deliberately does NOT
 * recurse into a match's own captured text — "**bold `code`**" renders
 * bold's content as plain literal text, not a nested <code> — simpler
 * and covers the overwhelming majority of real model output without the
 * ambiguity a fully general nested inline grammar would introduce. */
function renderInline(text: string, options: MarkdownRenderOptions): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    if (match.index! > lastIndex) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index!)));
    }
    const [, code, bold, italic, linkText, linkUrl] = match;
    if (code !== undefined) {
      const el = document.createElement("code");
      el.textContent = code;
      fragment.appendChild(el);
    } else if (bold !== undefined) {
      const el = document.createElement("strong");
      el.textContent = bold;
      fragment.appendChild(el);
    } else if (italic !== undefined) {
      const el = document.createElement("em");
      el.textContent = italic;
      fragment.appendChild(el);
    } else if (linkText !== undefined && linkUrl !== undefined) {
      // Only http/https ever become a real <a> — same allowlist main.ts's
      // openExternal IPC handler enforces (externalUrl.ts), applied here
      // too so an unsafe scheme (javascript:, file:, a custom app's own
      // registered URI scheme) never even reaches a real href, rather than
      // relying solely on that second layer to catch it.
      let isSafe = false;
      try {
        isSafe = ["http:", "https:"].includes(new URL(linkUrl).protocol);
      } catch {
        isSafe = false;
      }
      if (isSafe) {
        const a = document.createElement("a");
        a.textContent = linkText;
        a.href = linkUrl;
        a.addEventListener("click", (event) => {
          event.preventDefault();
          options.onLinkClick(linkUrl);
        });
        fragment.appendChild(a);
      } else {
        fragment.appendChild(document.createTextNode(linkText));
      }
    }
    lastIndex = match.index! + match[0].length;
  }
  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
  return fragment;
}

function renderCodeBlock(block: { lang: string; content: string }, options: MarkdownRenderOptions): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "markdown-code-block";

  const header = document.createElement("div");
  header.className = "markdown-code-block-header";
  if (block.lang) {
    const langLabel = document.createElement("span");
    langLabel.className = "markdown-code-lang";
    langLabel.textContent = block.lang;
    header.appendChild(langLabel);
  }

  const button = document.createElement("button");
  button.className = "markdown-copy-button";
  button.textContent = "Copy";
  button.addEventListener("click", () => {
    const writeToClipboard = options.writeToClipboard ?? ((text: string) => navigator.clipboard.writeText(text));
    writeToClipboard(block.content)
      .then(() => {
        button.textContent = "Copied!";
      })
      .catch(() => {
        button.textContent = "Copy failed";
      });
  });
  header.appendChild(button);
  wrapper.appendChild(header);

  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = block.content;
  pre.appendChild(code);
  wrapper.appendChild(pre);

  return wrapper;
}

/** Entry point: parses `text` as the markdown subset this module
 * supports and returns a DocumentFragment of real DOM nodes, ready to
 * append in place of a plain-text node. Never throws — unsupported or
 * malformed input degrades to a plain paragraph rather than an error. */
export function renderMarkdown(text: string, options: MarkdownRenderOptions): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const block of splitIntoBlocks(text)) {
    switch (block.type) {
      case "heading": {
        const el = document.createElement(`h${Math.min(block.level, 6)}`);
        el.appendChild(renderInline(block.content, options));
        fragment.appendChild(el);
        break;
      }
      case "code": {
        fragment.appendChild(renderCodeBlock(block, options));
        break;
      }
      case "list": {
        const el = document.createElement(block.ordered ? "ol" : "ul");
        for (const item of block.items) {
          const li = document.createElement("li");
          li.appendChild(renderInline(item, options));
          el.appendChild(li);
        }
        fragment.appendChild(el);
        break;
      }
      case "table": {
        fragment.appendChild(renderTable(block, options));
        break;
      }
      case "paragraph": {
        const el = document.createElement("p");
        el.appendChild(renderInline(block.content, options));
        fragment.appendChild(el);
        break;
      }
    }
  }
  return fragment;
}

function renderTable(block: { header: string[]; alignments: Alignment[]; rows: string[][] }, options: MarkdownRenderOptions): HTMLElement {
  const table = document.createElement("table");

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  block.header.forEach((cell, i) => {
    const th = document.createElement("th");
    const alignment = block.alignments[i];
    if (alignment) th.style.textAlign = alignment;
    th.appendChild(renderInline(cell, options));
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of block.rows) {
    const tr = document.createElement("tr");
    row.forEach((cell, i) => {
      const td = document.createElement("td");
      const alignment = block.alignments[i];
      if (alignment) td.style.textAlign = alignment;
      td.appendChild(renderInline(cell, options));
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  return table;
}
