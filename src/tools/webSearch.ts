import type { Tool, ToolContext } from "../types.js";

interface Input {
  query?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const SEARCH_URL = "https://html.duckduckgo.com/html/";
const MAX_RESULTS = 8;
const MAX_QUERY_CHARS = 300;
const MAX_BYTES = 500_000;
const FETCH_TIMEOUT_MS = 15_000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function plainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/** The search page links each result through its own redirect: ".../l/?uddg=<the real address>". Return the real address, or null when it is not an http(s) link. */
function realUrl(href: string): string | null {
  const decoded = decodeEntities(href);
  let url: URL;
  try {
    url = new URL(decoded, "https://duckduckgo.com");
  } catch {
    return null;
  }
  const target = url.searchParams.get("uddg") ?? (url.hostname.endsWith("duckduckgo.com") ? null : url.toString());
  if (!target) return null;
  try {
    const parsed = new URL(target);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Reads the result list from the HTML of a DuckDuckGo results page. Ads are skipped: their links have no real target address. */
export function parseSearchResults(html: string, max = MAX_RESULTS): SearchResult[] {
  const results: SearchResult[] = [];
  const links = html.matchAll(/<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi);
  const all = [...links];
  for (const [i, link] of all.entries()) {
    const tag = link[0];
    const href = /href="([^"]*)"/i.exec(tag)?.[1];
    if (!href) continue;
    const url = realUrl(href);
    if (!url) continue;
    const start = (link.index ?? 0) + tag.length;
    const end = all[i + 1]?.index ?? html.length;
    const snippetHtml = /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(html.slice(start, end))?.[1] ?? "";
    results.push({ title: plainText(link[1] ?? ""), url, snippet: plainText(snippetHtml) });
    if (results.length >= max) break;
  }
  return results;
}

/**
 * Searches the web and returns titles, addresses and short snippets. It
 * sends the query to DuckDuckGo's HTML page, which needs no account or
 * key. The address is fixed, so the tool cannot be pointed at another
 * host. Each call needs approval (permission NETWORK) and shows the
 * query. Results are text from the web: the model reads them as data.
 */
export const webSearchTool: Tool<Input, { query: string; results: SearchResult[]; note?: string }> = {
  name: "web_search",
  description:
    "Search the web and return up to 8 results (title, url, short snippet). Use it for current facts or documentation that are not in the workspace. To read a result in full, call fetch_url with its url. Each search requires explicit approval.",
  permission: "NETWORK",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "The search words, as you would type them in a search box." } },
    required: ["query"],
  },
  async execute(input, _ctx: ToolContext) {
    const query = typeof input?.query === "string" ? input.query.trim().replace(/\s+/g, " ") : "";
    if (!query) return { ok: false, output: null, error: "A query is required." };
    if (query.length > MAX_QUERY_CHARS) return { ok: false, output: null, error: `The query is too long (max ${MAX_QUERY_CHARS} characters).` };

    let res: Response;
    try {
      res = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(query)}`, {
        method: "GET",
        headers: { "user-agent": "Mozilla/5.0 (compatible; LocalAgent)", accept: "text/html" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      return { ok: false, output: null, error: `The search could not be reached: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!res.ok) return { ok: false, output: null, error: `The search service answered ${res.status}. Try again in a moment.` };

    const html = (await res.text()).slice(0, MAX_BYTES);
    const results = parseSearchResults(html);
    if (results.length === 0) {
      return { ok: true, output: { query, results: [], note: "No results. Try different words." } };
    }
    return { ok: true, output: { query, results } };
  },
};
