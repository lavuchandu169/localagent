import crypto from "node:crypto";
import {
  listSessions,
  loadSessionRecord,
  writeSessionRecordFile,
  removeSessionRecordFile,
  applyIndexMutations,
  readPendingDeletes,
  removePendingDelete,
  type SessionRecord,
  type SessionIndexEntry,
} from "./sessionStore.js";
import { redactSecrets } from "./protected.js";

export interface RemoteSessionMeta {
  sessionId: string;
  driveFileId: string;
  /** Drive's own server-assigned last-modified time for this file — see SessionRecord.lastSyncCheckpoint for why reconcile uses this instead of trusting either device's own wall clock. */
  modifiedTime: string;
}

/**
 * Correctness audit finding (session High #3): a deleted session's Drive
 * file used to be removed outright — a second device that hadn't synced
 * since the delete would see "my local copy is still here, the remote
 * copy is just gone" during its own reconcile pass and treat that as a
 * local-only session needing to be pushed, silently resurrecting
 * something the user deliberately deleted. A tombstone keeps the file (so
 * it's still discoverable via the exact same sessionId-keyed query every
 * device already uses) but replaces its content with this marker, so a
 * reconcile pass can tell "deleted elsewhere" apart from "never synced".
 */
export interface SessionTombstone {
  tombstone: true;
  sessionId: string;
  deletedAt: string;
}

function isTombstone(data: SessionRecord | SessionTombstone): data is SessionTombstone {
  return (data as SessionTombstone).tombstone === true;
}

type FetchImpl = typeof fetch;

const DRIVE_FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/drive/v3/files";

/**
 * Thrown when a Drive call fails because the stored access token doesn't
 * carry the drive.appdata scope — distinct from other failures because it
 * needs the user to sign in again, not just a retry.
 */
export class DriveScopeError extends Error {
  constructor(action: string) {
    super(`Drive ${action} failed: missing drive.appdata scope — sign in again to re-enable backup.`);
    this.name = "DriveScopeError";
  }
}

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

/** Throws DriveScopeError for an insufficient-scope 403, a plain Error for any other non-OK response, and returns normally for a 2xx. */
async function checkDriveResponse(response: Response, action: string): Promise<void> {
  if (response.ok) return;
  const bodyText = await response.text();
  if (response.status === 403 && /insufficient/i.test(bodyText)) {
    throw new DriveScopeError(action);
  }
  throw new Error(`Drive ${action} failed: ${response.status} ${bodyText.slice(0, 200)}`);
}

/** Lists every session file in this app's Drive appDataFolder, mapping each to its sessionId via appProperties. A file with no sessionId property (shouldn't happen — defensive only) is skipped. */
export async function listRemoteSessions(accessToken: string, fetchImpl: FetchImpl = fetch): Promise<RemoteSessionMeta[]> {
  const url = new URL(DRIVE_FILES_ENDPOINT);
  url.searchParams.set("spaces", "appDataFolder");
  url.searchParams.set("fields", "files(id,appProperties,modifiedTime)");
  url.searchParams.set("pageSize", "1000");

  const response = await fetchImpl(url.toString(), { headers: authHeaders(accessToken), signal: AbortSignal.timeout(10_000) });
  await checkDriveResponse(response, "list");
  const body = (await response.json()) as { files?: { id: string; appProperties?: { sessionId?: string }; modifiedTime: string }[] };

  const result: RemoteSessionMeta[] = [];
  for (const file of body.files ?? []) {
    const sessionId = file.appProperties?.sessionId;
    if (sessionId) result.push({ sessionId, driveFileId: file.id, modifiedTime: file.modifiedTime });
  }
  return result;
}

/** Finds the Drive file id for one session by its sessionId, or null if it hasn't been uploaded yet. */
async function findRemoteFile(accessToken: string, sessionId: string, fetchImpl: FetchImpl): Promise<string | null> {
  const url = new URL(DRIVE_FILES_ENDPOINT);
  url.searchParams.set("spaces", "appDataFolder");
  url.searchParams.set("q", `appProperties has { key='sessionId' and value='${sessionId}' }`);
  url.searchParams.set("fields", "files(id)");

  const response = await fetchImpl(url.toString(), { headers: authHeaders(accessToken), signal: AbortSignal.timeout(10_000) });
  await checkDriveResponse(response, "lookup");
  const body = (await response.json()) as { files?: { id: string }[] };
  return body.files?.[0]?.id ?? null;
}

/** Downloads and parses one session's Drive file by its file id — either a
 * real SessionRecord, or a SessionTombstone if it was deleted on another
 * device. Callers must check isTombstone() before treating the result as
 * a SessionRecord. */
export async function downloadSession(accessToken: string, driveFileId: string, fetchImpl: FetchImpl = fetch): Promise<SessionRecord | SessionTombstone> {
  const url = `${DRIVE_FILES_ENDPOINT}/${driveFileId}?alt=media`;
  const response = await fetchImpl(url, { headers: authHeaders(accessToken), signal: AbortSignal.timeout(10_000) });
  await checkDriveResponse(response, "download");
  return (await response.json()) as SessionRecord | SessionTombstone;
}

/**
 * Strips fields that must never leave this device before a record is
 * serialized for Drive upload:
 *
 * - The heavyweight attachment payloads (`images`, with base64 image data,
 *   and `textAttachments`) on every message. A handful of multi-MB images
 *   base64-encoded can easily blow past this file's fixed 10s request
 *   timeout, and the caller treats upload as best-effort and swallows any
 *   failure — so without this, an image-heavy session's cloud sync
 *   silently degrades.
 * - `lastSyncCheckpoint` (correctness audit finding, session Medium #1):
 *   this device's own bookkeeping about ITS OWN last successful sync —
 *   uploading it would let it silently overwrite another device's
 *   identical bookkeeping about ITS OWN last sync the next time that
 *   device pulls this record, corrupting the very mechanism meant to keep
 *   merges clock-skew-safe.
 *
 * Only the Drive-synced copy loses these fields: this returns a new
 * object/array (never mutates `record` or `record.messages`), since the
 * same `record` reference is also used by the caller's own local
 * persistence (sessionRegistry.ts's persistSession), which must keep both
 * full attachment content and its own checkpoint for local resume/sync.
 */
function prepareRecordForUpload(record: SessionRecord): Omit<SessionRecord, "lastSyncCheckpoint"> {
  const { lastSyncCheckpoint: _lastSyncCheckpoint, ...rest } = record;
  return {
    ...rest,
    messages: record.messages.map((message) => {
      const { images, textAttachments, ...messageRest } = message;
      return messageRest;
    }),
  };
}

/**
 * Security audit finding (confirmed, medium): unvalidated-remote-provider-
 * config. provider.baseUrl (for the "openai-compatible" kind) determines
 * where real conversation content is sent on every resumed turn —
 * sessionRegistry.ts's buildProvider constructs a live network client
 * from it with no allowlist, and startSession fires a health-check fetch
 * before the UI ever shows the user which baseUrl is in play. A record
 * downloaded from Drive is never trusted provenance (an attacker who
 * compromises the user's Google account, or a second device signed into
 * it, could write a crafted record with an attacker-controlled baseUrl),
 * the same "device-local, never trust it from the remote side"
 * principle prepareRecordForUpload above already applies OUTBOUND
 * (stripping lastSyncCheckpoint) — this is that guard's inbound
 * counterpart. A resumed session with provider: null simply falls back
 * to whatever this device's own Settings already configure for that
 * provider kind (sessionStore.ts's own doc comment on this field
 * confirms that's the existing, intended fallback for a record that
 * never had a provider at all). Local-disk tampering is a separate,
 * already-accepted trust boundary elsewhere in this app's model — it
 * requires local write access to the sessions directory, the same
 * precondition several other audit findings already treat as out of
 * scope.
 */
function stripUntrustedRemoteProvider(record: SessionRecord): SessionRecord {
  return { ...record, provider: null };
}

/** Creates or updates the Drive file for this session record, by sessionId
 * lookup when the caller doesn't already know whether a remote file
 * exists. Returns Drive's own server-assigned modifiedTime for the
 * result — reconcileSessions uses it to seed/refresh a clock-skew-safe
 * sync checkpoint immediately after a successful push (see
 * SessionRecord.lastSyncCheckpoint).
 *
 * Performance finding (code-review-and-quality pass): reconcileSessions
 * already knows the answer for every session it pushes — either the
 * driveFileId from its own listRemoteSessions call (a push/conflict-
 * resolve for a session present on both sides), or that no remote file
 * exists at all (a local-only session, by construction of how
 * reconcileSessions partitions its work) — so it always had to pay for
 * this exact same Drive lookup a second time, immediately before every
 * upload. `knownFileId` lets a caller that already knows skip it: pass
 * the real id, or `null` to assert "known not to exist yet" (a create,
 * not an update). Omitting it (undefined) preserves the original
 * lookup-based behavior for the one caller that genuinely doesn't know —
 * sessionRegistry.ts's post-task best-effort sync. */
export async function uploadSession(
  accessToken: string,
  record: SessionRecord,
  fetchImpl: FetchImpl = fetch,
  knownFileId?: string | null
): Promise<{ modifiedTime: string }> {
  const existingFileId = knownFileId !== undefined ? knownFileId : await findRemoteFile(accessToken, record.id, fetchImpl);
  // Security audit finding M3: a session's own history can carry file
  // contents the agent read mid-task (e.g. a .env value quoted in a
  // run_command/read_file tool result) — redact the same way
  // runCommand.ts/readFile.ts already do for their own output.
  //
  // Final review Important #3, confirmed live: redacting the FINAL,
  // already-JSON-escaped text (the earlier version of this line) is
  // unsafe — the KEY=VALUE pattern's greedy `(\S+)` only stops at real
  // whitespace, but compact JSON.stringify output has none at all, so a
  // real newline inside the ORIGINAL string becomes the literal two
  // characters `\n` in the escaped text (themselves non-whitespace),
  // and the match silently runs on through every following field and
  // even subsequent message objects — producing either invalid JSON or,
  // worse, syntactically VALID JSON with later content silently deleted.
  // A `JSON.stringify` replacer redacts each string value in isolation,
  // on its raw (not yet escaped) text — where a real newline IS
  // whitespace to `\S`, so the match correctly stops at the end of the
  // actual secret — before JSON.stringify ever escapes or assembles the
  // surrounding structure. prepareRecordForUpload (correctness audit,
  // session Medium #1) additionally strips lastSyncCheckpoint — this
  // device's own sync bookkeeping, never meant to leave it — on top of
  // the attachment payloads it already stripped.
  const content = JSON.stringify(prepareRecordForUpload(record), (_key, value) => (typeof value === "string" ? redactSecrets(value) : value));

  if (existingFileId) {
    const response = await fetchImpl(`${DRIVE_UPLOAD_ENDPOINT}/${existingFileId}?uploadType=media&fields=modifiedTime`, {
      method: "PATCH",
      headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
      body: content,
      signal: AbortSignal.timeout(10_000),
    });
    await checkDriveResponse(response, "update");
    return (await response.json()) as { modifiedTime: string };
  }

  const boundary = `localagent-${crypto.randomUUID()}`;
  const metadata = { name: `${record.id}.json`, parents: ["appDataFolder"], appProperties: { sessionId: record.id } };
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--`;

  const response = await fetchImpl(`${DRIVE_UPLOAD_ENDPOINT}?uploadType=multipart&fields=modifiedTime`, {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  await checkDriveResponse(response, "create");
  return (await response.json()) as { modifiedTime: string };
}

/**
 * Marks a session deleted on Drive, if a remote file exists for it — see
 * SessionTombstone's doc comment for why this writes a tombstone instead
 * of literally deleting the file. No-op if there is no remote file yet:
 * nothing else could possibly know about a session that was never
 * uploaded anywhere, so there's nothing to warn anyone away from
 * resurrecting.
 */
export async function deleteRemoteSession(accessToken: string, sessionId: string, fetchImpl: FetchImpl = fetch): Promise<void> {
  const fileId = await findRemoteFile(accessToken, sessionId, fetchImpl);
  if (!fileId) return;
  const tombstone: SessionTombstone = { tombstone: true, sessionId, deletedAt: new Date().toISOString() };
  const response = await fetchImpl(`${DRIVE_UPLOAD_ENDPOINT}/${fileId}?uploadType=media`, {
    method: "PATCH",
    headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify(tombstone),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return; // the file vanished between findRemoteFile and here — already gone either way
  await checkDriveResponse(response, "delete");
}

export interface ReconcileResult {
  pulled: number;
  pushed: number;
  /** Correctness audit finding (session High #3): a local copy removed because its remote counterpart was a tombstone (deleted on another device), not pulled or pushed. */
  deletedLocal: number;
  /** Correctness audit finding (session Medium #1): both sides changed since the last successful sync, with no logical ordering between them — the losing (local) version was preserved under a conflict-suffixed id rather than silently overwritten; see reconcileSessions' doc comment. */
  conflicts: number;
  /** Drive delete-propagation edge case: a session deleted while signed out/offline had its remote tombstone push recorded as pending (sessionStore.ts's addPendingDelete) instead of lost outright. This counts how many of those this pass successfully flushed — i.e. how many previously-undelivered deletes just got pushed to Drive for real, before anything else in this pass ran. */
  pendingDeletesFlushed: number;
}

export interface ReconcileOps {
  listRemoteSessions: (accessToken: string) => Promise<RemoteSessionMeta[]>;
  downloadSession: (accessToken: string, driveFileId: string) => Promise<SessionRecord | SessionTombstone>;
  /** `knownFileId`: pass the id when the caller already knows a remote file
   * exists for this record, `null` when it already knows one doesn't —
   * see uploadSession's doc comment. Omit it only when genuinely unknown. */
  uploadSession: (accessToken: string, record: SessionRecord, knownFileId?: string | null) => Promise<{ modifiedTime: string }>;
  deleteRemoteSession: (accessToken: string, sessionId: string) => Promise<void>;
}

function defaultReconcileOps(fetchImpl: FetchImpl): ReconcileOps {
  return {
    listRemoteSessions: (token) => listRemoteSessions(token, fetchImpl),
    downloadSession: (token, id) => downloadSession(token, id, fetchImpl),
    uploadSession: (token, record, knownFileId) => uploadSession(token, record, fetchImpl, knownFileId),
    deleteRemoteSession: (token, id) => deleteRemoteSession(token, id, fetchImpl),
  };
}

function withCheckpoint(record: SessionRecord, remoteModifiedTime: string, localUpdatedAt: number): SessionRecord {
  return { ...record, lastSyncCheckpoint: { remoteModifiedTime, localUpdatedAt } };
}

/**
 * Runs once per successful sign-in. Diffs local sessionsDir against the
 * Drive appDataFolder: pulls anything remote-only, pushes anything
 * local-only, and for a session present in both merges via a
 * clock-skew-safe sync checkpoint (correctness audit finding, session
 * Medium #1) instead of comparing `updatedAt` across devices directly —
 * two wall clocks that can disagree (clock skew) could otherwise make an
 * actually-older edit look newer and silently overwrite a genuinely
 * newer one. See SessionRecord.lastSyncCheckpoint for the full mechanism;
 * in short, each side is compared against this device's own PRIOR
 * observation of it (never one device's clock against another's):
 *
 * - Neither side moved since the last checkpoint -> skip.
 * - Only remote moved -> pull.
 * - Only local moved -> push.
 * - BOTH moved -> genuine concurrent edit with no ordering between them.
 *   Remote is adopted as the resolved copy, but the local version that
 *   would otherwise be silently destroyed is preserved under a new
 *   `<id>-conflict-<timestamp>` session id instead — picked up and
 *   pushed as an ordinary local-only session on the NEXT reconcile pass.
 *
 * A record with no checkpoint yet (never reconciled under this scheme —
 * a pre-migration record, or a session present on both sides without
 * either ever having gone through a push/pull here) falls back to the
 * previous updatedAt-vs-updatedAt comparison for exactly one pass, then
 * seeds the checkpoint so every subsequent pass uses the robust path.
 *
 * Each session's sync is caught individually so one bad file can't block
 * the rest of the pass.
 */
type ReconcileOutcome = "pulled" | "pushed" | "skipped" | "deletedLocal" | "conflict";

// Performance finding (code-review-and-quality pass): reconciling every
// session fully concurrently (plain Promise.all) means an account with
// hundreds of sessions fires hundreds of simultaneous Drive API round
// trips the moment sign-in completes — exactly the kind of burst Drive's
// own rate limiting is designed to reject. Capping how many run at once
// keeps the "roughly one round-trip, not N back to back" win the
// unbounded version was built for (see the comment below) while staying
// well under any reasonable per-second quota. Chosen well above the
// existing "sessions reconcile concurrently" test's fixture size (5) so
// that test keeps proving true concurrency, not accidentally degrading to
// one batch of exactly its own size.
const RECONCILE_CONCURRENCY = 8;

/** Runs `fn` over `items` with at most `limit` in flight at once, preserving
 * each item's own result position in the returned array. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function toIndexEntry(record: SessionRecord): SessionIndexEntry {
  return { id: record.id, title: record.title, updatedAt: record.updatedAt, ownerEmail: record.ownerEmail };
}

export async function reconcileSessions(
  sessionsDir: string,
  accessToken: string,
  deps: { fetchImpl?: FetchImpl; ops?: ReconcileOps } = {}
): Promise<ReconcileResult> {
  const ops = deps.ops ?? defaultReconcileOps(deps.fetchImpl ?? fetch);

  // Drive delete-propagation edge case: flush BEFORE doing anything else in
  // this pass, including the listRemoteSessions call right below — a
  // pending delete's tombstone has to actually be written first, or the
  // normal pull logic that follows could still see the stale (pre-
  // tombstone) remote content and resurrect exactly what this is trying to
  // finally get rid of. A failure here (still offline, token rejected,
  // etc.) just leaves that id in the pending list for the next attempt —
  // never fatal to the rest of this reconcile pass.
  const pendingDeletes = await readPendingDeletes(sessionsDir);
  let pendingDeletesFlushed = 0;
  if (pendingDeletes.length > 0) {
    await mapWithConcurrency(pendingDeletes, RECONCILE_CONCURRENCY, async (id) => {
      try {
        await ops.deleteRemoteSession(accessToken, id);
        await removePendingDelete(sessionsDir, id);
        pendingDeletesFlushed++;
      } catch (err) {
        console.warn(`[cloudSync] retrying pending delete for session ${id} failed, will retry on next reconcile:`, err);
      }
    });
  }

  const [localEntries, remoteEntries] = await Promise.all([listSessions(sessionsDir), ops.listRemoteSessions(accessToken)]);
  const remoteIds = new Set(remoteEntries.map((e) => e.sessionId));

  // Performance finding (code-review-and-quality pass): every session used
  // to persist its own index change via saveSession/deleteSession, each
  // paying for a full index.json read + sort + write under the shared
  // index lock — correct, but O(N) work serialized N times is O(N²) for
  // one reconcile pass across N sessions. Writing record files directly
  // (writeSessionRecordFile/removeSessionRecordFile, no index side
  // effects) and collecting every session's index change into these two
  // lists turns that into a single O(N) batch via applyIndexMutations
  // once the whole pass is done, below.
  const indexUpserts: SessionIndexEntry[] = [];
  const indexRemoves: string[] = [];

  // Every session is reconciled independently and concurrently, up to
  // RECONCILE_CONCURRENCY at once (mapWithConcurrency, not a sequential
  // loop or an unbounded Promise.all) — with N sessions this costs roughly
  // N/RECONCILE_CONCURRENCY round-trips instead of N back to back, which
  // is what made sign-in feel unresponsive with more than a couple of
  // sessions, without firing them all at Drive simultaneously. Each
  // session's own failure is still caught individually (returning
  // "skipped" rather than throwing) so one bad file can't block the rest.
  const remoteOutcomes = await mapWithConcurrency(remoteEntries, RECONCILE_CONCURRENCY, async (remote): Promise<ReconcileOutcome> => {
      try {
        // Always read the record file straight off disk here, rather than
        // trusting the `localEntries` snapshot captured at the top of this
        // function: if the app crashed between sessionStore.ts's two writes
        // (record file written, index.json not yet updated), or index.json
        // itself is missing/corrupted, the snapshot can be stale relative to
        // what's actually on disk. Deciding pull-vs-compare from a stale
        // snapshot risks silently overwriting a newer local record with an
        // older remote one.
        const localRecord = await loadSessionRecord(sessionsDir, remote.sessionId);
        if (!localRecord) {
          const record = await ops.downloadSession(accessToken, remote.driveFileId);
          // A tombstone with no local copy anywhere means nothing here ever
          // knew about this session in the first place — nothing to delete.
          if (isTombstone(record)) return "skipped";
          const pulled = withCheckpoint(stripUntrustedRemoteProvider(record), remote.modifiedTime, record.updatedAt);
          await writeSessionRecordFile(sessionsDir, pulled);
          indexUpserts.push(toIndexEntry(pulled));
          return "pulled";
        }
        const checkpoint = localRecord.lastSyncCheckpoint;

        // Performance finding (code-review-and-quality pass): with a
        // checkpoint already established, whether remote changed is fully
        // decidable from remote.modifiedTime (already in hand from the
        // listRemoteSessions call above) with no network round trip at
        // all. The old code downloaded the full remote body unconditionally
        // here, before this comparison ever ran — on the common steady-
        // state pass (most sessions touch neither side between syncs),
        // that's one wasted full-session download per session, every time.
        // Checked BEFORE downloading so the no-op and push-only paths below
        // never pay for content they don't use; pull/conflict (remote
        // actually changed) still need the real body and fall through to
        // the download after this block, same as before.
        if (checkpoint !== null) {
          const remoteUnchangedPreDownload = checkpoint.remoteModifiedTime === remote.modifiedTime;
          const localUnchangedPreDownload = checkpoint.localUpdatedAt === localRecord.updatedAt;
          if (remoteUnchangedPreDownload && localUnchangedPreDownload) return "skipped";
          if (remoteUnchangedPreDownload && !localUnchangedPreDownload) {
            const { modifiedTime } = await ops.uploadSession(accessToken, localRecord, remote.driveFileId);
            const pushed = withCheckpoint(localRecord, modifiedTime, localRecord.updatedAt);
            await writeSessionRecordFile(sessionsDir, pushed);
            indexUpserts.push(toIndexEntry(pushed));
            return "pushed";
          }
        }

        const remoteData = await ops.downloadSession(accessToken, remote.driveFileId);
        if (isTombstone(remoteData)) {
          // Deleted on another device since this local copy was last
          // synced — delete it here too instead of treating "present
          // locally, present remotely" as license to push/pull like a
          // normal record, which would silently resurrect it.
          //
          // Final-review finding I7: but only ever a PLAIN delete when
          // local hasn't itself changed since the last sync. A local edit
          // made after that point (or a checkpoint that was never
          // established at all) means this device was genuinely still
          // using the session when it was deleted elsewhere — deleting it
          // outright would silently destroy that work. Preserve it under
          // a conflict-suffixed id instead, same mechanism as a genuine
          // concurrent-edit conflict below.
          const localChangedSinceSync = checkpoint === null || checkpoint.localUpdatedAt !== localRecord.updatedAt;
          if (localChangedSinceSync) {
            const conflictId = `${localRecord.id}-conflict-${Date.now()}`;
            const conflictCopy = { ...localRecord, id: conflictId, title: `${localRecord.title} (conflict copy)`, lastSyncCheckpoint: null };
            await writeSessionRecordFile(sessionsDir, conflictCopy);
            indexUpserts.push(toIndexEntry(conflictCopy));
          }
          await removeSessionRecordFile(sessionsDir, remote.sessionId);
          indexRemoves.push(remote.sessionId);
          return localChangedSinceSync ? "conflict" : "deletedLocal";
        }
        const remoteRecord = stripUntrustedRemoteProvider(remoteData);

        if (checkpoint === null) {
          // No robust history yet — fall back to the previous behavior for
          // exactly this one pass, then seed the checkpoint either way so
          // every subsequent pass uses the robust comparison instead.
          if (remoteRecord.updatedAt > localRecord.updatedAt) {
            const pulled = withCheckpoint(remoteRecord, remote.modifiedTime, remoteRecord.updatedAt);
            await writeSessionRecordFile(sessionsDir, pulled);
            indexUpserts.push(toIndexEntry(pulled));
            return "pulled";
          }
          if (localRecord.updatedAt > remoteRecord.updatedAt) {
            // Performance finding (code-review-and-quality pass): this
            // session's remote.driveFileId is already known from the
            // listRemoteSessions call at the top of this pass — passing it
            // through skips uploadSession's own redundant lookup of the
            // exact same thing.
            const { modifiedTime } = await ops.uploadSession(accessToken, localRecord, remote.driveFileId);
            const pushed = withCheckpoint(localRecord, modifiedTime, localRecord.updatedAt);
            await writeSessionRecordFile(sessionsDir, pushed);
            indexUpserts.push(toIndexEntry(pushed));
            return "pushed";
          }
          const seeded = withCheckpoint(localRecord, remote.modifiedTime, localRecord.updatedAt);
          await writeSessionRecordFile(sessionsDir, seeded);
          indexUpserts.push(toIndexEntry(seeded));
          return "skipped";
        }

        // Reaching here with checkpoint !== null means the pre-download
        // check above already ruled out "remote unchanged" (both
        // remote-unchanged outcomes returned before any download) — so
        // remote is known to have changed, and only local's own state
        // still needs checking to pick pull vs. conflict.
        const localUnchanged = checkpoint.localUpdatedAt === localRecord.updatedAt;

        if (localUnchanged) {
          const pulled = withCheckpoint(remoteRecord, remote.modifiedTime, remoteRecord.updatedAt);
          await writeSessionRecordFile(sessionsDir, pulled);
          indexUpserts.push(toIndexEntry(pulled));
          return "pulled";
        }

        // Both changed since the last checkpoint — no logical ordering
        // between them. Preserve the about-to-be-overwritten LOCAL version
        // under a conflict-suffixed id (its own lastSyncCheckpoint cleared:
        // it has never itself been synced under that new id) instead of
        // destroying it, then adopt remote as the resolved copy for this
        // session's real id. The conflict copy has no remote counterpart,
        // so it's picked up and pushed like any other local-only session
        // on the NEXT reconcile pass.
        const conflictId = `${localRecord.id}-conflict-${Date.now()}`;
        const conflictCopy = { ...localRecord, id: conflictId, title: `${localRecord.title} (conflict copy)`, lastSyncCheckpoint: null };
        await writeSessionRecordFile(sessionsDir, conflictCopy);
        indexUpserts.push(toIndexEntry(conflictCopy));
        const resolved = withCheckpoint(remoteRecord, remote.modifiedTime, remoteRecord.updatedAt);
        await writeSessionRecordFile(sessionsDir, resolved);
        indexUpserts.push(toIndexEntry(resolved));
        return "conflict";
      } catch (err) {
        // Logged, not rethrown — one session's sync failure must not block
        // the rest of the pass.
        console.warn(`[cloudSync] reconcile failed for session ${remote.sessionId}:`, err);
        return "skipped";
      }
  });

  const localOnlyOutcomes = await mapWithConcurrency(
    localEntries.filter((local) => !remoteIds.has(local.id)),
    RECONCILE_CONCURRENCY,
    async (local): Promise<ReconcileOutcome> => {
      try {
        const record = await loadSessionRecord(sessionsDir, local.id);
        if (!record) return "skipped";
        // This session's id was filtered OUT of remoteIds just above (that's
        // what makes it "local-only") — there is provably no remote file for
        // it yet, so `null` here skips uploadSession's lookup entirely
        // instead of re-confirming something already known.
        const { modifiedTime } = await ops.uploadSession(accessToken, record, null);
        const pushed = withCheckpoint(record, modifiedTime, record.updatedAt);
        await writeSessionRecordFile(sessionsDir, pushed);
        indexUpserts.push(toIndexEntry(pushed));
        return "pushed";
      } catch (err) {
        console.warn(`[cloudSync] reconcile push failed for session ${local.id}:`, err);
        return "skipped";
      }
    }
  );

  // Single batched index update for the ENTIRE pass (see indexUpserts'
  // doc comment above) instead of one per session.
  await applyIndexMutations(sessionsDir, { upsert: indexUpserts, remove: indexRemoves });

  const outcomes = [...remoteOutcomes, ...localOnlyOutcomes];
  return {
    pulled: outcomes.filter((o) => o === "pulled").length,
    pushed: outcomes.filter((o) => o === "pushed").length,
    deletedLocal: outcomes.filter((o) => o === "deletedLocal").length,
    conflicts: outcomes.filter((o) => o === "conflict").length,
    pendingDeletesFlushed,
  };
}
