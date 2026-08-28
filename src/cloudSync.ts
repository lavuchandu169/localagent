import crypto from "node:crypto";
import type { SessionRecord } from "./sessionStore.js";

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

  const response = await fetchImpl(url.toString(), { headers: authHeaders(accessToken) });
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

  const response = await fetchImpl(url.toString(), { headers: authHeaders(accessToken) });
  await checkDriveResponse(response, "lookup");
  const body = (await response.json()) as { files?: { id: string }[] };
  return body.files?.[0]?.id ?? null;
}

/** Downloads and parses one session's full record by its Drive file id. */
export async function downloadSession(accessToken: string, driveFileId: string, fetchImpl: FetchImpl = fetch): Promise<SessionRecord> {
  const url = `${DRIVE_FILES_ENDPOINT}/${driveFileId}?alt=media`;
  const response = await fetchImpl(url, { headers: authHeaders(accessToken) });
  await checkDriveResponse(response, "download");
  return (await response.json()) as SessionRecord;
}

/** Creates or updates (by sessionId lookup) the Drive file for this session record. */
export async function uploadSession(accessToken: string, record: SessionRecord, fetchImpl: FetchImpl = fetch): Promise<void> {
  const existingFileId = await findRemoteFile(accessToken, record.id, fetchImpl);
  const content = JSON.stringify(record);

  if (existingFileId) {
    const response = await fetchImpl(`${DRIVE_UPLOAD_ENDPOINT}/${existingFileId}?uploadType=media`, {
      method: "PATCH",
      headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
      body: content,
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
  });
  if (response.status === 404) return;
  await checkDriveResponse(response, "delete");
}
