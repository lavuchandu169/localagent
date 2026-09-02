import crypto from "node:crypto";
import { listSessions, loadSessionRecord, saveSession, type SessionRecord } from "./sessionStore.js";

export interface RemoteSessionMeta {
  sessionId: string;
  driveFileId: string;
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
  url.searchParams.set("fields", "files(id,appProperties)");
  url.searchParams.set("pageSize", "1000");

  const response = await fetchImpl(url.toString(), { headers: authHeaders(accessToken), signal: AbortSignal.timeout(10_000) });
  await checkDriveResponse(response, "list");
  const body = (await response.json()) as { files?: { id: string; appProperties?: { sessionId?: string } }[] };

  const result: RemoteSessionMeta[] = [];
  for (const file of body.files ?? []) {
    const sessionId = file.appProperties?.sessionId;
    if (sessionId) result.push({ sessionId, driveFileId: file.id });
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

/** Downloads and parses one session's full record by its Drive file id. */
export async function downloadSession(accessToken: string, driveFileId: string, fetchImpl: FetchImpl = fetch): Promise<SessionRecord> {
  const url = `${DRIVE_FILES_ENDPOINT}/${driveFileId}?alt=media`;
  const response = await fetchImpl(url, { headers: authHeaders(accessToken), signal: AbortSignal.timeout(10_000) });
  await checkDriveResponse(response, "download");
  return (await response.json()) as SessionRecord;
}

/**
 * Strips the heavyweight attachment payloads (`images`, with base64 image
 * data, and `textAttachments`) from every message before a record is
 * serialized for Drive upload. A handful of multi-MB images base64-encoded
 * can easily blow past this file's fixed 10s request timeout, and the
 * caller treats upload as best-effort and swallows any failure — so without
 * this, an image-heavy session's cloud sync silently degrades. Only the
 * Drive-synced copy loses the attachment payload: this returns a new
 * object/array (never mutates `record` or `record.messages`), since the
 * same `record` reference is also used by the caller's own local
 * persistence (sessionRegistry.ts's persistSession), which must keep full
 * attachment content for local resume.
 */
function stripAttachmentsForUpload(record: SessionRecord): SessionRecord {
  return {
    ...record,
    messages: record.messages.map((message) => {
      const { images, textAttachments, ...rest } = message;
      return rest;
    }),
  };
}

/** Creates or updates (by sessionId lookup) the Drive file for this session record. */
export async function uploadSession(accessToken: string, record: SessionRecord, fetchImpl: FetchImpl = fetch): Promise<void> {
  const existingFileId = await findRemoteFile(accessToken, record.id, fetchImpl);
  const content = JSON.stringify(stripAttachmentsForUpload(record));

  if (existingFileId) {
    const response = await fetchImpl(`${DRIVE_UPLOAD_ENDPOINT}/${existingFileId}?uploadType=media`, {
      method: "PATCH",
      headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
      body: content,
      signal: AbortSignal.timeout(10_000),
    });
    await checkDriveResponse(response, "update");
    return;
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

  const response = await fetchImpl(`${DRIVE_UPLOAD_ENDPOINT}?uploadType=multipart`, {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  await checkDriveResponse(response, "create");
}

/** Best-effort delete of a session's Drive file, if one exists. No-op if there is none. */
export async function deleteRemoteSession(accessToken: string, sessionId: string, fetchImpl: FetchImpl = fetch): Promise<void> {
  const fileId = await findRemoteFile(accessToken, sessionId, fetchImpl);
  if (!fileId) return;
  const response = await fetchImpl(`${DRIVE_FILES_ENDPOINT}/${fileId}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return;
  await checkDriveResponse(response, "delete");
}

export interface ReconcileResult {
  pulled: number;
  pushed: number;
}

export interface ReconcileOps {
  listRemoteSessions: (accessToken: string) => Promise<RemoteSessionMeta[]>;
  downloadSession: (accessToken: string, driveFileId: string) => Promise<SessionRecord>;
  uploadSession: (accessToken: string, record: SessionRecord) => Promise<void>;
}

function defaultReconcileOps(fetchImpl: FetchImpl): ReconcileOps {
  return {
    listRemoteSessions: (token) => listRemoteSessions(token, fetchImpl),
    downloadSession: (token, id) => downloadSession(token, id, fetchImpl),
    uploadSession: (token, record) => uploadSession(token, record, fetchImpl),
  };
}

/**
 * Runs once per successful sign-in. Diffs local sessionsDir against the
 * Drive appDataFolder: pulls anything remote-only, pushes anything
 * local-only, and for a session present in both keeps whichever has the
 * newer updatedAt (last-writer-wins), overwriting the other. Each
 * session's sync is caught individually so one bad file can't block the
 * rest of the pass.
 */
type ReconcileOutcome = "pulled" | "pushed" | "skipped";

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
          await saveSession(sessionsDir, record);
          return "pulled";
        }
        const remoteRecord = await ops.downloadSession(accessToken, remote.driveFileId);
        if (remoteRecord.updatedAt > localRecord.updatedAt) {
          await saveSession(sessionsDir, remoteRecord);
          return "pulled";
        }
        if (localRecord.updatedAt > remoteRecord.updatedAt) {
          await ops.uploadSession(accessToken, localRecord);
          return "pushed";
        }
        return "skipped";
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
          await ops.uploadSession(accessToken, record);
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
  };
}
