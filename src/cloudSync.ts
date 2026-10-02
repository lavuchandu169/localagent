import crypto from "node:crypto";
import { listSessions, loadSessionRecord, saveSession, deleteSession, type SessionRecord } from "./sessionStore.js";

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

/** Creates or updates (by sessionId lookup) the Drive file for this session
 * record. Returns Drive's own server-assigned modifiedTime for the result —
 * reconcileSessions uses it to seed/refresh a clock-skew-safe sync
 * checkpoint immediately after a successful push (see
 * SessionRecord.lastSyncCheckpoint). */
export async function uploadSession(accessToken: string, record: SessionRecord, fetchImpl: FetchImpl = fetch): Promise<{ modifiedTime: string }> {
  const existingFileId = await findRemoteFile(accessToken, record.id, fetchImpl);
  const content = JSON.stringify(prepareRecordForUpload(record));

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
}

export interface ReconcileOps {
  listRemoteSessions: (accessToken: string) => Promise<RemoteSessionMeta[]>;
  downloadSession: (accessToken: string, driveFileId: string) => Promise<SessionRecord | SessionTombstone>;
  uploadSession: (accessToken: string, record: SessionRecord) => Promise<{ modifiedTime: string }>;
}

function defaultReconcileOps(fetchImpl: FetchImpl): ReconcileOps {
  return {
    listRemoteSessions: (token) => listRemoteSessions(token, fetchImpl),
    downloadSession: (token, id) => downloadSession(token, id, fetchImpl),
    uploadSession: (token, record) => uploadSession(token, record, fetchImpl),
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

export async function reconcileSessions(
  sessionsDir: string,
  accessToken: string,
  deps: { fetchImpl?: FetchImpl; ops?: ReconcileOps } = {}
): Promise<ReconcileResult> {
  const ops = deps.ops ?? defaultReconcileOps(deps.fetchImpl ?? fetch);

  const [localEntries, remoteEntries] = await Promise.all([listSessions(sessionsDir), ops.listRemoteSessions(accessToken)]);
  const remoteIds = new Set(remoteEntries.map((e) => e.sessionId));

  // Every session is reconciled independently and concurrently (Promise.all,
  // not a sequential loop) — with N sessions this costs roughly the slowest
  // single round-trip instead of N round-trips back to back, which is what
  // made sign-in feel unresponsive with more than a couple of sessions.
  // Each session's own failure is still caught individually (returning
  // "skipped" rather than throwing) so one bad file can't block the rest.
  const remoteOutcomes = await Promise.all(
    remoteEntries.map(async (remote): Promise<ReconcileOutcome> => {
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
          await saveSession(sessionsDir, withCheckpoint(record, remote.modifiedTime, record.updatedAt));
          return "pulled";
        }
        const remoteData = await ops.downloadSession(accessToken, remote.driveFileId);
        if (isTombstone(remoteData)) {
          // Deleted on another device since this local copy was last
          // synced — delete it here too instead of treating "present
          // locally, present remotely" as license to push/pull like a
          // normal record, which would silently resurrect it.
          await deleteSession(sessionsDir, remote.sessionId);
          return "deletedLocal";
        }
        const remoteRecord = remoteData;
        const checkpoint = localRecord.lastSyncCheckpoint;

        if (checkpoint === null) {
          // No robust history yet — fall back to the previous behavior for
          // exactly this one pass, then seed the checkpoint either way so
          // every subsequent pass uses the robust comparison instead.
          if (remoteRecord.updatedAt > localRecord.updatedAt) {
            await saveSession(sessionsDir, withCheckpoint(remoteRecord, remote.modifiedTime, remoteRecord.updatedAt));
            return "pulled";
          }
          if (localRecord.updatedAt > remoteRecord.updatedAt) {
            const { modifiedTime } = await ops.uploadSession(accessToken, localRecord);
            await saveSession(sessionsDir, withCheckpoint(localRecord, modifiedTime, localRecord.updatedAt));
            return "pushed";
          }
          await saveSession(sessionsDir, withCheckpoint(localRecord, remote.modifiedTime, localRecord.updatedAt));
          return "skipped";
        }

        const remoteUnchanged = checkpoint.remoteModifiedTime === remote.modifiedTime;
        const localUnchanged = checkpoint.localUpdatedAt === localRecord.updatedAt;

        if (remoteUnchanged && localUnchanged) return "skipped";

        if (remoteUnchanged && !localUnchanged) {
          const { modifiedTime } = await ops.uploadSession(accessToken, localRecord);
          await saveSession(sessionsDir, withCheckpoint(localRecord, modifiedTime, localRecord.updatedAt));
          return "pushed";
        }

        if (!remoteUnchanged && localUnchanged) {
          await saveSession(sessionsDir, withCheckpoint(remoteRecord, remote.modifiedTime, remoteRecord.updatedAt));
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
        await saveSession(sessionsDir, { ...localRecord, id: conflictId, title: `${localRecord.title} (conflict copy)`, lastSyncCheckpoint: null });
        await saveSession(sessionsDir, withCheckpoint(remoteRecord, remote.modifiedTime, remoteRecord.updatedAt));
        return "conflict";
      } catch (err) {
        // Logged, not rethrown — one session's sync failure must not block
        // the rest of the pass.
        console.warn(`[cloudSync] reconcile failed for session ${remote.sessionId}:`, err);
        return "skipped";
      }
    })
  );

  const localOnlyOutcomes = await Promise.all(
    localEntries
      .filter((local) => !remoteIds.has(local.id))
      .map(async (local): Promise<ReconcileOutcome> => {
        try {
          const record = await loadSessionRecord(sessionsDir, local.id);
          if (!record) return "skipped";
          const { modifiedTime } = await ops.uploadSession(accessToken, record);
          await saveSession(sessionsDir, withCheckpoint(record, modifiedTime, record.updatedAt));
          return "pushed";
        } catch (err) {
          console.warn(`[cloudSync] reconcile push failed for session ${local.id}:`, err);
          return "skipped";
        }
      })
  );

  const outcomes = [...remoteOutcomes, ...localOnlyOutcomes];
  return {
    pulled: outcomes.filter((o) => o === "pulled").length,
    pushed: outcomes.filter((o) => o === "pushed").length,
    deletedLocal: outcomes.filter((o) => o === "deletedLocal").length,
    conflicts: outcomes.filter((o) => o === "conflict").length,
  };
}
