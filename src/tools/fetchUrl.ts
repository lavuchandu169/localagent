import type { Tool, ToolContext } from "../types.js";

interface Input {
  url?: string;
}

interface Output {
  content: string;
  status: number;
  contentType: string | null;
}

const MAX_CHARS = 50_000;

/**
 * Minimal SSRF guard: reject loopback/private/link-local hostnames before
 * ever calling fetch. This is a pre-fetch literal check on the URL's own
 * hostname, not a DNS-rebinding-proof resolver, and `fetch`'s default
 * `redirect: "follow"` below means a public URL that later redirects to
 * one of these ranges is not caught by this check — accepted gap for this
 * first version, matching this engine's existing stance (permissions.ts)
 * that a prefix/lexical check buys most of the real-world protection
 * cheaply, rather than a full resolver up front.
 */
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "0.0.0.0" || h === "::1" || h === "::") return true;
  if (/^127\./.test(h)) return true; // loopback
  if (/^10\./.test(h)) return true; // RFC1918
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true; // RFC1918
  if (/^192\.168\./.test(h)) return true; // RFC1918
  if (/^169\.254\./.test(h)) return true; // link-local, incl. cloud metadata endpoints
  if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return true; // IPv6 unique local (fc00::/7)
  if (/^fe80:/.test(h)) return true; // IPv6 link-local
  return false;
}

/**
 * Deliberately simple regex-based stripper, not a full HTML parser: this
 * project has no HTML-to-text dependency (jsdom is a devDependency used
 * only by renderer tests), and pulling one in for a single tool is more
 * than this needs. Good enough to turn a documentation page into readable
 * text for a model; not meant to preserve structure or handle malformed
 * markup perfectly.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

export const fetchUrlTool: Tool<Input, Output> = {
  name: "fetch_url",
  description:
    "Fetch an http(s) URL and return its content as readable text (HTML is stripped down to text). GET only. Always requires explicit approval before it runs.",
  permission: "NETWORK",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The absolute http:// or https:// URL to fetch." },
    },
    required: ["url"],
  },
  async execute(input, _ctx: ToolContext) {
    const raw = input.url;
    if (!raw || typeof raw !== "string") {
      return { ok: false, output: null, error: "A url is required." };
    }
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return { ok: false, output: null, error: `Not a valid URL: ${raw}` };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, output: null, error: `Unsupported scheme "${parsed.protocol}" — only http:// and https:// are allowed.` };
    }
    if (isBlockedHost(parsed.hostname)) {
      return { ok: false, output: null, error: `Refusing to fetch ${parsed.hostname} — loopback, private, and link-local addresses are blocked.` };
    }

    let res: Response;
    try {
      res = await fetch(parsed.toString(), { method: "GET" });
    } catch (err) {
      return { ok: false, output: null, error: err instanceof Error ? err.message : String(err) };
    }
    if (!res.ok) {
      return { ok: false, output: null, error: `Server responded ${res.status} ${res.statusText}` };
    }

    const contentType = res.headers.get("content-type");
    const bodyText = await res.text();
    const text = contentType && contentType.includes("text/html") ? htmlToText(bodyText) : bodyText;

    const truncated = text.length > MAX_CHARS;
    const content = truncated ? text.slice(0, MAX_CHARS) : text;

    return {
      ok: true,
      output: { content, status: res.status, contentType },
      truncated,
    };
  },
};
