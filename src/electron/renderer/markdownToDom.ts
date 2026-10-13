/**
 * Parses a small, deliberately limited markdown subset into real DOM
 * nodes — headers, bold/italic, inline code, fenced code blocks, lists,
 * and links — never via innerHTML. This app's CSP (main.ts) and the
 * project's own repeated documented norm (mcpServersPanel.ts,
 * renderer.ts, onboarding.ts's own tiny code-span parser) are explicit:
 * untrusted/model-generated text must never be parsed as HTML. Anything
 * outside this subset (tables, blockquotes, images, nested inline
 * formatting) just renders as plain text — never throws, never breaks.
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

type Block =
  | { type: "heading"; level: number; content: string }
  | { type: "code"; lang: string; content: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "paragraph"; content: string };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^```(\S*)\s*$/;
const UL_ITEM_RE = /^[-*]\s+(.*)$/;
const OL_ITEM_RE = /^\d+\.\s+(.*)$/;

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

    // Paragraph: consume consecutive plain lines until a blank line or
    // the start of a different block type.
    const paragraphLines = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i]!;
      if (next.trim() === "" || FENCE_RE.test(next) || HEADING_RE.test(next) || UL_ITEM_RE.test(next) || OL_ITEM_RE.test(next)) break;
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
      const a = document.createElement("a");
      a.textContent = linkText;
      a.href = linkUrl;
      a.addEventListener("click", (event) => {
        event.preventDefault();
        options.onLinkClick(linkUrl);
      });
      fragment.appendChild(a);
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
