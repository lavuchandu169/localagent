import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, AgentEvent, PermissionMode } from "./types.js";

export interface SessionIndexEntry {
  id: string;
  title: string;
  updatedAt: number;
  /** The Google account email that owns this session, or null for a session saved before ownership existed (or one that's never been signed-in-tagged). */
  ownerEmail: string | null;
}

/**
 * Just enough to rebuild a ModelProvider config on resume — deliberately
 * NEVER includes an API key. Every cloud-provider API key is re-resolved
 * fresh from its own encrypted settings file at session-start time
 * regardless of what's in this config (see main.ts's "agent:start-session"
 * handler, which the renderer's own provider config never carries a key
 * for either) — persisting one here would duplicate a secret into every
 * session record and cloud-synced copy for no benefit.
 */
export interface PersistedProviderConfig {
  kind: "openai-compatible" | "embedded" | "anthropic" | "openai" | "gemini" | "freellmapi";
  model?: string;
  baseUrl?: string;
  size?: string;
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
  /** Correctness audit finding (session High #1): without these, resuming a session after an app restart silently fell back to whatever the setup form currently showed — including a PLAN-mode/no-planFirst session silently resuming in DEFAULT mode with no plan gating. Null on a record saved before these fields existed; the resume caller falls back to its own default in that case, same as ownerEmail's existing `?? null` pattern. */
  provider: PersistedProviderConfig | null;
  mode: PermissionMode | null;
  planFirst: boolean;
  /** Correctness audit finding (session High #2): without this, a checkpoint never survives an app restart — "Revert this task" silently becomes unavailable the moment the app is closed and reopened, with no indication to the user that the capability (and the now-or-never window to use it) just disappeared. */
  checkpointHash: string | null;
  /**
   * Correctness audit finding (session Medium #1): cloud sync's merge used
   * to compare `updatedAt` directly across devices — two wall clocks that
   * can disagree (clock skew), which can make an actually-older edit look
   * newer and silently overwrite a genuinely newer one. This checkpoint
   * captures, as of the last successful push or pull for this session on
   * THIS device, Drive's own server-assigned modifiedTime for the remote
   * copy and this device's own updatedAt at that moment — comparing a
   * CURRENT value against this device's own PRIOR observation of itself
   * never compares two different devices' clocks against each other.
   * Null for a record never reconciled under this scheme yet (a
   * pre-migration record, or one that's never touched cloud sync at all);
   * cloudSync.ts's reconcileSessions falls back to the previous
   * updatedAt-vs-updatedAt comparison for exactly one pass in that case,
   * then seeds this field so every subsequent pass uses the robust path.
   * Deliberately NOT uploaded to Drive (see cloudSync.ts's
   * stripLocalOnlyFieldsForUpload) — it's this device's own bookkeeping
   * about ITS OWN last sync, and would corrupt another device's identical
   * bookkeeping about its own if it were ever pulled down.
   */
  lastSyncCheckpoint: { remoteModifiedTime: string; localUpdatedAt: number } | null;
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

/**
 * Correctness audit finding (session Medium #1 fallout): a plain
 * fs.writeFile() truncates the destination before writing its new
 * content, leaving a real window where a concurrent reader can see an
 * empty or partial file. That stopped being a purely theoretical risk
 * once cloudSync.ts's syncUploadToCloud started doing a SECOND
 * saveSession() for the same session shortly after the first — a
 * concurrent loadSessionRecord() for that same id could intermittently
 * read mid-write and come back null even though the record had just been
 * saved correctly. Writing to a temp file in the SAME directory (so the
 * later rename stays on one filesystem, where POSIX guarantees it's
 * atomic) and renaming it into place means a reader only ever sees the
 * complete old file or the complete new one, never a partial write.
 */
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp-${crypto.randomUUID()}`;
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, filePath);
}

async function writeIndex(sessionsDir: string, entries: SessionIndexEntry[]): Promise<void> {
  await fs.mkdir(sessionsDir, { recursive: true });
  await writeFileAtomic(indexPath(sessionsDir), JSON.stringify(entries, null, 2));
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
      provider: r.provider ?? null,
      mode: r.mode ?? null,
      planFirst: r.planFirst ?? false,
      checkpointHash: r.checkpointHash ?? null,
      lastSyncCheckpoint: r.lastSyncCheckpoint ?? null,
    };
  } catch {
    return null;
  }
}

export async function saveSession(sessionsDir: string, record: SessionRecord): Promise<void> {
  await fs.mkdir(sessionsDir, { recursive: true });
  await writeFileAtomic(recordPath(sessionsDir, record.id), JSON.stringify(record, null, 2));

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
