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
   * Final-review finding C3: a checkpoint hash is a commit inside a
   * SPECIFIC git repo — nothing paired it with WHICH workspace that was,
   * so a resumed session (which runs in whatever workspace the tab
   * currently shows, since SessionRecord never persisted workspaceRoot
   * itself) or a provider-change mid-session restart could carry an old
   * checkpoint hash into an unrelated current workspace. Usually that
   * just makes `git checkout <hash>` fail ("unknown revision"), but git
   * worktrees of the same repository share one object database — there,
   * the hash can resolve successfully in a DIFFERENT worktree than the
   * one it was made in, and reverting would overwrite that worktree's
   * files (including deleting untracked ones) instead of refusing
   * outright. sessionRegistry.ts's startSession only restores
   * checkpointHash when this matches the workspace the session is
   * actually about to run in; null (a legacy record saved before this
   * field existed) is treated as "unknown" and never matches, same safe
   * default as discarding the checkpoint outright.
   */
  checkpointWorkspaceRoot: string | null;
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
   * prepareRecordForUpload) — it's this device's own bookkeeping
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
 *
 * Security audit finding M3: a session's own history can contain file
 * contents the agent read mid-task (which may include secrets) — every
 * settings file holding an API key already uses 0600 (see
 * anthropicSettings.ts etc.); the temp file is created with the same
 * mode so the final renamed-into-place file keeps it (rename doesn't
 * change a file's own permissions).
 */
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp-${crypto.randomUUID()}`;
  await fs.writeFile(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
  await fs.rename(tmpPath, filePath);
}

async function writeIndexRaw(sessionsDir: string, entries: SessionIndexEntry[]): Promise<void> {
  await fs.mkdir(sessionsDir, { recursive: true });
  await writeFileAtomic(indexPath(sessionsDir), JSON.stringify(entries, null, 2));
}

/**
 * Final-review finding C2: every index mutation used to do its own
 * unsynchronized read-modify-write of the WHOLE index.json — atomic
 * rename (writeFileAtomic) makes any SINGLE write safe, but does nothing
 * for two overlapping read-modify-write sequences for DIFFERENT session
 * ids: both read the same starting index, both independently add/remove
 * their own entry, and whichever writes last wins, silently dropping the
 * other's change. cloudSync.ts's reconcileSessions deliberately runs every
 * session's sync concurrently (Promise.all) for speed, so this was a real,
 * frequently-hit path (confirmed via a live repro: 8 concurrent
 * saveSession calls for different ids left only 1 in the index), not a
 * hypothetical one. A simple per-directory promise-chain lock serializes
 * just the index's own read-modify-write sequence — record files
 * themselves stay fully concurrent, so this doesn't undo the performance
 * win reconcileSessions' concurrency was built for.
 */
const indexLocks = new Map<string, Promise<void>>();

function withIndexLock<T>(sessionsDir: string, fn: () => Promise<T>): Promise<T> {
  const prior = indexLocks.get(sessionsDir) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  indexLocks.set(
    sessionsDir,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

/** Scans the directory and rebuilds index entries from each record file directly — the self-healing path for a missing/corrupted index.json. Never acquires the index lock or writes anything itself; every caller (both below) does both within its own single lock acquisition, so this can be safely called from inside an already-locked section without deadlocking. */
async function buildIndexFromDisk(sessionsDir: string): Promise<SessionIndexEntry[]> {
  let files: string[];
  try {
    files = await fs.readdir(sessionsDir);
  } catch {
    return [];
  }

  const entries: SessionIndexEntry[] = [];
  for (const file of files) {
    if (file === "index.json" || !file.endsWith(".json") || file.includes(".tmp-")) continue;
    const id = file.slice(0, -".json".length);
    const record = await loadSessionRecord(sessionsDir, id);
    if (record) entries.push({ id: record.id, title: record.title, updatedAt: record.updatedAt, ownerEmail: record.ownerEmail });
  }
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  return entries;
}

/** Reconstructs index.json from the directory listing — used when the index is missing or corrupted. Any individual record file that also fails to parse is skipped, not fatal. Acquires the index lock for its own read+write, so it's safe to call concurrently with saveSession/deleteSession for the same directory. */
export async function rebuildIndex(sessionsDir: string): Promise<SessionIndexEntry[]> {
  return withIndexLock(sessionsDir, async () => {
    const entries = await buildIndexFromDisk(sessionsDir);
    await writeIndexRaw(sessionsDir, entries);
    return entries;
  });
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

function isValidIndexArray(parsed: unknown): parsed is SessionIndexEntry[] {
  return (
    Array.isArray(parsed) &&
    parsed.every(
      (e) =>
        !!e &&
        typeof e === "object" &&
        typeof (e as SessionIndexEntry).id === "string" &&
        typeof (e as SessionIndexEntry).title === "string" &&
        typeof (e as SessionIndexEntry).updatedAt === "number"
    )
  );
}

/** Reads index.json WITHOUT acquiring the index lock or persisting any self-heal — used by saveSession/deleteSession, which already hold the lock for their own read-modify-write and are about to write their own complete, corrected snapshot anyway. Calling the lock-acquiring rebuildIndex()/listAllSessions() from inside an already-locked section would deadlock against itself. */
async function readIndexRaw(sessionsDir: string): Promise<SessionIndexEntry[]> {
  try {
    const raw = await fs.readFile(indexPath(sessionsDir), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidIndexArray(parsed)) return buildIndexFromDisk(sessionsDir);
    // ownerEmail is normalized here rather than folded into the validity
    // check above so an index.json written before ownership existed isn't
    // treated as corrupt and rebuilt unnecessarily — it's just missing a
    // field that defaults to null.
    return parsed.map((e) => ({ ...e, ownerEmail: e.ownerEmail ?? null }));
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    return buildIndexFromDisk(sessionsDir);
  }
}

async function listAllSessions(sessionsDir: string): Promise<SessionIndexEntry[]> {
  try {
    const raw = await fs.readFile(indexPath(sessionsDir), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidIndexArray(parsed)) return rebuildIndex(sessionsDir);
    // ownerEmail is normalized here rather than folded into the validity
    // check above so an index.json written before ownership existed isn't
    // treated as corrupt and rebuilt unnecessarily — it's just missing a
    // field that defaults to null.
    return parsed.map((e) => ({ ...e, ownerEmail: e.ownerEmail ?? null }));
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
      checkpointWorkspaceRoot: r.checkpointWorkspaceRoot ?? null,
      lastSyncCheckpoint: r.lastSyncCheckpoint ?? null,
    };
  } catch {
    return null;
  }
}

/** Writes just the record file — no index work at all. Exported for
 * callers that need to persist MANY records in one logical batch (cloudSync's
 * reconcileSessions) and apply a single combined index update afterward via
 * applyIndexMutations, instead of paying for N separate index read-modify-
 * writes (see applyIndexMutations' doc comment, performance finding below). */
export async function writeSessionRecordFile(sessionsDir: string, record: SessionRecord): Promise<void> {
  await fs.mkdir(sessionsDir, { recursive: true });
  await writeFileAtomic(recordPath(sessionsDir, record.id), JSON.stringify(record, null, 2));
}

/** Removes just the record file — no index work. See writeSessionRecordFile. */
export async function removeSessionRecordFile(sessionsDir: string, id: string): Promise<void> {
  await fs.rm(recordPath(sessionsDir, id), { force: true });
}

/**
 * Performance finding (code-review-and-quality pass): cloudSync's
 * reconcileSessions used to call saveSession/deleteSession once per
 * reconciled session, each paying its own full index.json read + sort +
 * write under withIndexLock — correct (the lock prevents the two-concurrent-
 * writers corruption from finding C2), but O(N) work serialized N times is
 * O(N²) for one reconcile pass across N sessions. Collecting every
 * session's index change into one upsert/remove batch and applying them
 * here in a SINGLE read-modify-write turns that into O(N) for the whole
 * pass: one read, one sort, one write, regardless of how many sessions
 * were reconciled. A no-op (no lock acquired, no write) when both lists
 * are empty, so a reconcile pass with nothing to change touches the index
 * file at all.
 */
export async function applyIndexMutations(
  sessionsDir: string,
  mutation: { upsert: SessionIndexEntry[]; remove: string[] }
): Promise<void> {
  if (mutation.upsert.length === 0 && mutation.remove.length === 0) return;
  await withIndexLock(sessionsDir, async () => {
    const entries = await readIndexRaw(sessionsDir);
    const removeIds = new Set(mutation.remove);
    const upsertIds = new Set(mutation.upsert.map((e) => e.id));
    const kept = entries.filter((e) => !removeIds.has(e.id) && !upsertIds.has(e.id));
    const next = [...kept, ...mutation.upsert];
    next.sort((a, b) => b.updatedAt - a.updatedAt);
    await writeIndexRaw(sessionsDir, next);
  });
}

export async function saveSession(sessionsDir: string, record: SessionRecord): Promise<void> {
  await writeSessionRecordFile(sessionsDir, record);
  // The index's own read-modify-write is the one part of this function
  // that genuinely races against other concurrent callers (see
  // withIndexLock's doc comment, final-review finding C2) — the record
  // file write above does not, so it stays outside the lock.
  await applyIndexMutations(sessionsDir, {
    upsert: [{ id: record.id, title: record.title, updatedAt: record.updatedAt, ownerEmail: record.ownerEmail }],
    remove: [],
  });
}

export async function deleteSession(sessionsDir: string, id: string): Promise<void> {
  await removeSessionRecordFile(sessionsDir, id);
  await applyIndexMutations(sessionsDir, { upsert: [], remove: [id] });
}

/**
 * Full-transcript search: title, every message's content, and every
 * text/status event's text — not just the title. See `listSessions` for
 * the `ownerEmail` filtering contract.
 */
/** searchSessions never returns more than this many matches — the sidebar
 * list renders every result it gets back, and a broad query against a long
 * history has no natural upper bound otherwise. Exported for tests. */
export const SEARCH_RESULT_CAP = 200;

/** How many record files searchSessions reads at once per batch — turns N
 * sequential disk round trips into N/this many, while still bounding how
 * many file descriptors are open simultaneously for a very large history. */
const SEARCH_READ_CONCURRENCY = 16;

/**
 * Performance finding (code-review-and-quality pass): this used to read
 * every session's record file one at a time in a sequential loop (N
 * round trips back to back) and had no cap on how many matches it could
 * return — a broad query against a long history read and held the ENTIRE
 * matching set in memory before the sidebar ever got to render any of it.
 * Reading in concurrent batches (not a single unbounded Promise.all —
 * this still bounds simultaneous open file descriptors) turns that into
 * N/SEARCH_READ_CONCURRENCY round trips, and the loop exits as soon as
 * SEARCH_RESULT_CAP matches are found instead of scanning the rest of a
 * long history for matches nobody will ever see. `entries` is already
 * sorted most-recently-updated first (see writeIndexRaw's callers), so
 * capping here means "the N most recent matches", not an arbitrary
 * subset.
 */
export async function searchSessions(sessionsDir: string, query: string, ownerEmail?: string | null): Promise<SessionIndexEntry[]> {
  const entries = await listSessions(sessionsDir, ownerEmail);
  const trimmed = query.trim();
  if (!trimmed) return entries;

  const lower = trimmed.toLowerCase();
  const matches: SessionIndexEntry[] = [];
  for (let i = 0; i < entries.length && matches.length < SEARCH_RESULT_CAP; i += SEARCH_READ_CONCURRENCY) {
    const batch = entries.slice(i, i + SEARCH_READ_CONCURRENCY);
    const records = await Promise.all(batch.map((entry) => loadSessionRecord(sessionsDir, entry.id)));
    for (let j = 0; j < batch.length; j++) {
      const record = records[j];
      if (!record) continue;
      const haystackParts = [record.title, ...record.messages.map((m) => m.content)];
      for (const event of record.events) {
        if (event.type === "text") haystackParts.push(event.text);
        else if (event.type === "status") haystackParts.push(event.message);
      }
      if (haystackParts.join("\n").toLowerCase().includes(lower)) {
        matches.push(batch[j]!);
        if (matches.length >= SEARCH_RESULT_CAP) break;
      }
    }
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
