import { promises as dns } from "node:dns";
import net from "node:net";
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
// Independent of MAX_CHARS: a hard ceiling on RAW bytes ever pulled into
// memory, enforced by cancelling the stream early (see readCapped) rather
// than by truncating after `res.text()` has already buffered the whole
// body — a server (or a redirect target) that returns gigabytes would
// otherwise exhaust memory before MAX_CHARS ever gets a chance to apply.
const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 15_000;

/**
 * SSRF guard, applied to every redirect hop (see fetchFollowingRedirects),
 * not just the originally-requested URL. Two layers:
 *
 * 1. A literal check on the hostname/IP as written — catches every shape
 *    the WHATWG URL parser itself doesn't already normalize away (decimal/
 *    hex/octal IPv4 forms ARE normalized by `new URL()` into plain dotted
 *    decimal before this ever runs — verified empirically, not assumed),
 *    plus IPv4-mapped IPv6 literals and a trailing dot on "localhost".
 * 2. A DNS resolution check — a hostname that reads as perfectly public
 *    (including real-world tricks like a wildcard-DNS service that
 *    resolves `<ip>.example.com` to the embedded IP) can still answer with
 *    a loopback/private/link-local address. Every address `dns.lookup`
 *    returns is checked; a resolution failure is treated as "not blocked
 *    here" and left for the real `fetch` to fail naturally on.
 *
 * What this deliberately does NOT do: pin the TCP connection to the exact
 * IP that was checked. A classic DNS-rebinding attack (the name resolves
 * differently a few hundred milliseconds later, at actual connect time)
 * is a narrower, timing-dependent variant this check doesn't close — doing
 * so needs a custom low-level connect hook (e.g. undici's Agent connect
 * option) pinning the socket to the already-checked address, which is a
 * meaningfully larger change than this tool's narrow v1 scope. Every
 * fetch still only happens after a human approves the exact URL shown
 * (permission: "NETWORK" — see permissions.ts), which bounds the blast
 * radius of this specific residual gap.
 */
async function isBlockedHost(hostname: string): Promise<boolean> {
  const h = stripTrailingDot(hostname.toLowerCase().replace(/^\[|\]$/g, ""));
  if (h === "localhost") return true;
  if (isBlockedAddress(h)) return true;
  if (net.isIP(h)) return false; // already a literal IP, and not blocked above — no DNS step needed

  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.lookup(h, { all: true, verbatim: true });
  } catch {
    return false; // unresolvable — nothing to block; let fetch's own error surface
  }
  return records.some((r) => isBlockedAddress(r.address));
}

function stripTrailingDot(h: string): string {
  return h.endsWith(".") ? h.slice(0, -1) : h;
}

function isBlockedAddress(address: string): boolean {
  if (net.isIPv4(address)) return isBlockedIPv4(address);
  const h = address.toLowerCase();
  if (h === "::1" || h === "::" || h === "0:0:0:0:0:0:0:1" || h === "0:0:0:0:0:0:0:0") return true;
  if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return true; // IPv6 unique local (fc00::/7)
  if (/^fe80:/.test(h)) return true; // IPv6 link-local
  const mapped = extractIPv4MappedAddress(h);
  if (mapped) return isBlockedIPv4(mapped);
  return false;
}

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  const a = parts[0] ?? -1;
  const b = parts[1] ?? -1;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata endpoints
  if (ip === "0.0.0.0") return true;
  return false;
}

/** `::ffff:127.0.0.1` and its compressed-hex form `::ffff:7f00:1` both mean
 * the same IPv4-mapped address; `new URL()` normalizes the former into the
 * latter, so both shapes must be recognized. */
function extractIPv4MappedAddress(hostname: string): string | null {
  const m = hostname.match(/^::ffff:([0-9a-f:.]+)$/i);
  const rest = m?.[1];
  if (!rest) return null;
  if (net.isIPv4(rest)) return rest;
  const hex = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex || !hex[1] || !hex[2]) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
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

/**
 * Reads the response body as a stream and stops — cancelling the
 * underlying stream rather than letting it keep arriving — the moment
 * MAX_BYTES raw bytes have been read. This is what makes MAX_BYTES an
 * actual memory ceiling instead of a cap applied only after `res.text()`
 * has already buffered an arbitrarily large body in full.
 */
async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) {
    return { text: await res.text(), truncated: false };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        const allowed = maxBytes - (total - value.byteLength);
        if (allowed > 0) chunks.push(value.subarray(0, allowed));
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
  return { text, truncated };
}

/**
 * Follows redirects manually (fetch's own `redirect: "follow"` would not
 * let a public starting URL's 3xx hop be re-checked against isBlockedHost
 * at all) so every hop — not just the one the human approved — passes the
 * same SSRF guard before anything is actually requested.
 */
async function fetchFollowingRedirects(start: URL): Promise<{ res: Response; blockedAt?: string }> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (await isBlockedHost(current.hostname)) {
      return { res: undefined as unknown as Response, blockedAt: current.hostname };
    }
    const res = await fetch(current.toString(), {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const isRedirect = res.status >= 300 && res.status < 400;
    const location = res.headers.get("location");
    if (!isRedirect || !location) return { res };
    current = new URL(location, current);
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      return { res: undefined as unknown as Response, blockedAt: current.hostname };
    }
  }
  throw new Error("Too many redirects.");
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

    let res: Response;
    try {
      const result = await fetchFollowingRedirects(parsed);
      if (result.blockedAt !== undefined) {
        return { ok: false, output: null, error: `Refusing to fetch ${result.blockedAt} — loopback, private, and link-local addresses are blocked.` };
      }
      res = result.res;
    } catch (err) {
      return { ok: false, output: null, error: err instanceof Error ? err.message : String(err) };
    }
    if (!res.ok) {
      return { ok: false, output: null, error: `Server responded ${res.status} ${res.statusText}` };
    }

    const contentType = res.headers.get("content-type");
    const { text: bodyText, truncated: byteTruncated } = await readCapped(res, MAX_BYTES);
    const text = contentType && contentType.includes("text/html") ? htmlToText(bodyText) : bodyText;

    const charTruncated = text.length > MAX_CHARS;
    const content = charTruncated ? text.slice(0, MAX_CHARS) : text;

    return {
      ok: true,
      output: { content, status: res.status, contentType },
      truncated: byteTruncated || charTruncated,
    };
  },
};
