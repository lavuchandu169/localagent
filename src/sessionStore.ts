import fs from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, AgentEvent } from "./types.js";

export interface SessionIndexEntry {
  id: string;
  title: string;
  updatedAt: number;
  /** The Google account email that owns this session, or null for a session saved before ownership existed (or one that's never been signed-in-tagged). */
  ownerEmail: string | null;
}

export interface SessionRecord {
  id: string;
  title: string;
  messages: ChatMessage[];
  events: AgentEvent[];
  createdAt: number;
  updatedAt: number;
  /** The Google account email that owns this session, or null. See SessionIndexEntry. */
  ownerEmail: string | null;
}

function indexPath(sessionsDir: string): string {
  return path.join(sessionsDir, "index.json");
}

/** Session ids are always internally generated (crypto.randomUUID()) and never user-typed text, but this guards the file-path construction defensively in case a malformed id ever reaches here from the IPC boundary — a `/`, `\`, or `..` segment could otherwise escape sessionsDir. */
function recordPath(sessionsDir: string, id: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(id)) {
    throw new Error(`Invalid session id: ${id}`);
  }
  return path.join(sessionsDir, `${id}.json`);
}

async function writeIndex(sessionsDir: string, entries: SessionIndexEntry[]): Promise<void> {
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(indexPath(sessionsDir), JSON.stringify(entries, null, 2), "utf-8");
}

/** Reconstructs index.json from the directory listing — used when the index is missing or corrupted. Any individual record file that also fails to parse is skipped, not fatal. */
export async function rebuildIndex(sessionsDir: string): Promise<SessionIndexEntry[]> {
  let files: string[];
  try {
    files = await fs.readdir(sessionsDir);
  } catch {
    return [];
  }

  const entries: SessionIndexEntry[] = [];
  for (const file of files) {
    if (file === "index.json" || !file.endsWith(".json")) continue;
    const id = file.slice(0, -".json".length);
    const record = await loadSessionRecord(sessionsDir, id);
    if (record) entries.push({ id: record.id, title: record.title, updatedAt: record.updatedAt, ownerEmail: record.ownerEmail });
  }
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  await writeIndex(sessionsDir, entries);
  return entries;
}

/**
 * Lists every session, or only those owned by `ownerEmail` when it's
 * passed (including `null`, to list only pre-ownership/untagged
 * sessions). Omit the second argument entirely for internal callers that
 * need every local session regardless of owner (cloud sync's reconcile
 * pass, `claimUnownedSessions`) — the UI-facing IPC handlers are the only
 * callers that should pass it.
 */
export async function listSessions(sessionsDir: string, ownerEmail?: string | null): Promise<SessionIndexEntry[]> {
  const entries = await listAllSessions(sessionsDir);
  if (ownerEmail === undefined) return entries;
  return entries.filter((e) => e.ownerEmail === ownerEmail);
}

async function listAllSessions(sessionsDir: string): Promise<SessionIndexEntry[]> {
  try {
    const raw = await fs.readFile(indexPath(sessionsDir), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return rebuildIndex(sessionsDir);
    const isValid = parsed.every(
      (e) =>
        !!e &&
        typeof e === "object" &&
        typeof (e as SessionIndexEntry).id === "string" &&
        typeof (e as SessionIndexEntry).title === "string" &&
        typeof (e as SessionIndexEntry).updatedAt === "number"
    );
    if (!isValid) return rebuildIndex(sessionsDir);
    // ownerEmail is normalized here rather than folded into the validity
    // check above so an index.json written before ownership existed isn't
    // treated as corrupt and rebuilt unnecessarily — it's just missing a
    // field that defaults to null.
    return (parsed as SessionIndexEntry[]).map((e) => ({ ...e, ownerEmail: e.ownerEmail ?? null }));
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    return rebuildIndex(sessionsDir);
  }
}

export async function loadSessionRecord(sessionsDir: string, id: string): Promise<SessionRecord | null> {
  try {
    const raw = await fs.readFile(recordPath(sessionsDir, id), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const r = parsed as Partial<SessionRecord>;
    if (
      typeof r.id !== "string" ||
      typeof r.title !== "string" ||
      !Array.isArray(r.messages) ||
      !Array.isArray(r.events) ||
      typeof r.createdAt !== "number" ||
      typeof r.updatedAt !== "number"
    ) {
      return null;
    }
    return {
      id: r.id,
      title: r.title,
      messages: r.messages,
      events: r.events,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      ownerEmail: r.ownerEmail ?? null,
    };
  } catch {
    return null;
  }
}

export async function saveSession(sessionsDir: string, record: SessionRecord): Promise<void> {
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(recordPath(sessionsDir, record.id), JSON.stringify(record, null, 2), "utf-8");

  const entries = await listAllSessions(sessionsDir);
  const withoutThis = entries.filter((e) => e.id !== record.id);
  withoutThis.push({ id: record.id, title: record.title, updatedAt: record.updatedAt, ownerEmail: record.ownerEmail });
  withoutThis.sort((a, b) => b.updatedAt - a.updatedAt);
  await writeIndex(sessionsDir, withoutThis);
}

export async function deleteSession(sessionsDir: string, id: string): Promise<void> {
  await fs.rm(recordPath(sessionsDir, id), { force: true });
  const entries = await listAllSessions(sessionsDir);
  await writeIndex(
    sessionsDir,
    entries.filter((e) => e.id !== id)
  );
}

/**
 * Full-transcript search: title, every message's content, and every
 * text/status event's text — not just the title. See `listSessions` for
 * the `ownerEmail` filtering contract.
 */
export async function searchSessions(sessionsDir: string, query: string, ownerEmail?: string | null): Promise<SessionIndexEntry[]> {
  const entries = await listSessions(sessionsDir, ownerEmail);
  const trimmed = query.trim();
  if (!trimmed) return entries;

  const lower = trimmed.toLowerCase();
  const matches: SessionIndexEntry[] = [];
  for (const entry of entries) {
    const record = await loadSessionRecord(sessionsDir, entry.id);
    if (!record) continue;
    const haystackParts = [record.title, ...record.messages.map((m) => m.content)];
    for (const event of record.events) {
      if (event.type === "text") haystackParts.push(event.text);
      else if (event.type === "status") haystackParts.push(event.message);
    }
    if (haystackParts.join("\n").toLowerCase().includes(lower)) matches.push(entry);
  }
  return matches;
}

/**
 * Claims every local session with no owner (created before this concept
 * existed, or never tagged) for `email` — called once per sign-in so a
 * user's pre-existing local history becomes visible under their account
 * instead of permanently orphaned. Idempotent: once claimed, a session is
 * never reassigned by this function again. Returns the number claimed.
 */
export async function claimUnownedSessions(sessionsDir: string, email: string): Promise<number> {
  const all = await listAllSessions(sessionsDir);
  let claimed = 0;
  for (const entry of all) {
    if (entry.ownerEmail !== null) continue;
    const record = await loadSessionRecord(sessionsDir, entry.id);
    if (!record) continue;
    await saveSession(sessionsDir, { ...record, ownerEmail: email });
    claimed++;
  }
  return claimed;
}
