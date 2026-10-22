import { promises as dns } from "node:dns";
import net, { BlockList } from "node:net";
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

/**
 * All actual range-membership checks go through node:net's own BlockList
 * rather than hand-written prefix regexes. This replaces a real,
 * now-twice-repeated bug class: a text prefix like `/^fe80:/` only matches
 * the single literal "fe80:" opening, but fe80::/10 as a CIDR actually
 * covers fe80:: through febf:: (any value with the right two leading
 * bits) — fe90::1 or feb0::1 would have silently sailed past a regex that
 * narrow. BlockList.check() parses the address into bytes and tests the
 * real numeric prefix instead, so this bug class can't recur here.
 *
 * Deliberately NOT added as entries here: ::ffff:0:0/96 (IPv4-mapped),
 * 64:ff9b::/96 and 64:ff9b:1::/48 (NAT64), or the deprecated ::/96
 * (IPv4-compatible). Each of those prefixes is used to carry an arbitrary
 * IPv4 address inside an IPv6 literal — including entirely public ones —
 * so blocking the prefix itself would wrongly block every public address
 * reachable through it. (Confirmed empirically: adding ::ffff:0:0/96 as a
 * blocked IPv6 subnet made BlockList also report an ordinary public IPv4
 * address as blocked when checked under the "ipv4" family — Node's
 * family-aware matching treats the two as the same underlying address.)
 * Those three prefixes are handled instead by extractEmbeddedIPv4 below,
 * which decodes the carried address and re-checks THAT against this same
 * list under the "ipv4" family.
 */
const BLOCKED_RANGES = new BlockList();
BLOCKED_RANGES.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
BLOCKED_RANGES.addSubnet("10.0.0.0", 8, "ipv4"); // RFC1918
BLOCKED_RANGES.addSubnet("172.16.0.0", 12, "ipv4"); // RFC1918
BLOCKED_RANGES.addSubnet("192.168.0.0", 16, "ipv4"); // RFC1918
BLOCKED_RANGES.addSubnet("169.254.0.0", 16, "ipv4"); // link-local, incl. cloud metadata endpoints
BLOCKED_RANGES.addSubnet("100.64.0.0", 10, "ipv4"); // shared address space (CGNAT)
BLOCKED_RANGES.addSubnet("198.18.0.0", 15, "ipv4"); // benchmarking
BLOCKED_RANGES.addSubnet("224.0.0.0", 4, "ipv4"); // multicast (224.0.0.0/4)
BLOCKED_RANGES.addSubnet("240.0.0.0", 4, "ipv4"); // reserved, incl. 255.255.255.255 (240.0.0.0/4)
BLOCKED_RANGES.addSubnet("0.0.0.0", 8, "ipv4"); // "this network"
BLOCKED_RANGES.addSubnet("::1", 128, "ipv6"); // loopback
BLOCKED_RANGES.addSubnet("::", 128, "ipv6"); // unspecified
BLOCKED_RANGES.addSubnet("fc00::", 7, "ipv6"); // unique local
BLOCKED_RANGES.addSubnet("fe80::", 10, "ipv6"); // link-local
BLOCKED_RANGES.addSubnet("fec0::", 10, "ipv6"); // deprecated site-local

function isBlockedAddress(address: string): boolean {
  if (net.isIPv4(address)) return BLOCKED_RANGES.check(address, "ipv4");
  if (!net.isIPv6(address)) return false; // not a literal IP at all — nothing to range-check
  const mapped = extractEmbeddedIPv4(address.toLowerCase());
  if (mapped) return BLOCKED_RANGES.check(mapped, "ipv4");
  return BLOCKED_RANGES.check(address, "ipv6");
}

/** Three IPv6 notations embed a literal IPv4 address in their trailing 32
 * bits, and `new URL()` normalizes each to its shortest hex-compressed
 * form, so the trailing groups must be decoded (not pattern-matched as
 * text) to recover the address they actually mean:
 *  - `::ffff:a.b.c.d` / `::ffff:7f00:1` — IPv4-mapped (RFC4291 2.5.5.2)
 *  - `64:ff9b::a.b.c.d` / `64:ff9b::7f00:1` — NAT64 (RFC6052)
 *  - `::a.b.c.d` / `::7f00:1` — deprecated IPv4-compatible (RFC4291 2.5.5.1)
 * Checked in this order so the two more specific prefixes aren't mistaken
 * for a bare `::`-compressed address (which the last pattern alone would
 * never match anyway, since it requires exactly two trailing groups with
 * nothing else after "::").
 *
 * Not handled: 6to4 (2002::/16), which embeds an IPv4 address in bits
 * 16-48 rather than the trailing 32 bits, needing different extraction
 * math entirely. Accepted gap — 6to4 has been disabled by default in
 * every mainstream OS for close to a decade, and every fetch still only
 * happens after a human approves the exact URL shown.
 */
function extractEmbeddedIPv4(hostname: string): string | null {
  for (const re of [/^::ffff:([0-9a-f:.]+)$/i, /^64:ff9b::([0-9a-f:.]+)$/i, /^::([0-9a-f]{1,4}:[0-9a-f]{1,4})$/i]) {
    const rest = hostname.match(re)?.[1];
    if (!rest) continue;
    if (net.isIPv4(rest)) return rest;
    const hex = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (!hex || !hex[1] || !hex[2]) continue;
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
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
