import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { listRemoteSessions, downloadSession, uploadSession, deleteRemoteSession, DriveScopeError, reconcileSessions } from "../cloudSync.js";
import type { SessionRecord } from "../sessionStore.js";
import { loadSessionRecord, saveSession, listSessions } from "../sessionStore.js";
import type { ChatMessage } from "../types.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

function makeRecord(id: string, updatedAt: number, lastSyncCheckpoint: SessionRecord["lastSyncCheckpoint"] = null): SessionRecord {
  return {
    id,
    title: `title-${id}`,
    messages: [],
    events: [],
    createdAt: updatedAt,
    updatedAt,
    ownerEmail: null,
    provider: null,
    mode: null,
    planFirst: false,
    checkpointHash: null,
    checkpointWorkspaceRoot: null,
    lastSyncCheckpoint,
  };
}

console.log("cloudSync (fake fetch):");

console.log("\nlistRemoteSessions:");
{
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (url) => {
    calls.push(url.toString());
    return new Response(
      JSON.stringify({
        files: [
          { id: "f1", appProperties: { sessionId: "s1" }, modifiedTime: "2024-01-01T00:00:00.000Z" },
          { id: "f2", appProperties: {} },
        ],
      }),
      { status: 200 }
    );
  };
  const result = await listRemoteSessions("tok", fakeFetch);
  check(
    "maps only files that carry a sessionId property",
    result.length === 1 && result[0]!.sessionId === "s1" && result[0]!.driveFileId === "f1"
  );
  check("requests the appDataFolder space", calls[0]!.includes("spaces=appDataFolder"));
  // Correctness audit finding (session Medium #1): reconcile needs Drive's
  // own server-assigned modifiedTime to merge without trusting either
  // device's own wall clock directly against the other's.
  check("requests modifiedTime in the fields param", decodeURIComponent(calls[0]!).includes("modifiedTime"));
  check("carries the real modifiedTime through", result[0]!.modifiedTime === "2024-01-01T00:00:00.000Z");
}

console.log("\ndownloadSession:");
{
  const record = makeRecord("s1", 123);
  const fakeFetch: typeof fetch = async (url) => {
    const u = url.toString();
    check("downloads by file id with alt=media", u.includes("/files/file-id") && u.includes("alt=media"));
    return new Response(JSON.stringify(record), { status: 200 });
  };
  const result = await downloadSession("tok", "file-id", fakeFetch);
  check("returns the parsed record", JSON.stringify(result) === JSON.stringify(record));
}

console.log("\nuploadSession — create path (no existing file):");
{
  const calls: { url: string; method?: string }[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push({ url: url.toString(), method: init?.method });
    if (!init?.method) {
      // findRemoteFile lookup: nothing exists yet
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ modifiedTime: "2024-02-02T00:00:00.000Z" }), { status: 200 });
  };
  const result = await uploadSession("tok", makeRecord("new-session", 100), fakeFetch);
  const createCall = calls.find((c) => c.method === "POST");
  check("issues a multipart create when no existing file is found", !!createCall && createCall.url.includes("uploadType=multipart"));
  check("requests modifiedTime back in the response fields", decodeURIComponent(createCall!.url).includes("modifiedTime"));
  // Correctness audit finding (session Medium #1): reconcile uses this to
  // seed a clock-skew-immune sync checkpoint immediately after an upload.
  check("returns Drive's real modifiedTime for the new file", result.modifiedTime === "2024-02-02T00:00:00.000Z");
}

console.log("\nuploadSession — update path (existing file):");
{
  const calls: { url: string; method?: string }[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push({ url: url.toString(), method: init?.method });
    if (!init?.method) {
      return new Response(JSON.stringify({ files: [{ id: "existing-file" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ modifiedTime: "2024-02-03T00:00:00.000Z" }), { status: 200 });
  };
  const result = await uploadSession("tok", makeRecord("s1", 100), fakeFetch);
  const patchCall = calls.find((c) => c.method === "PATCH");
  check(
    "issues a media PATCH to the found file id when one exists",
    !!patchCall && patchCall.url.includes("existing-file") && patchCall.url.includes("uploadType=media")
  );
  check("requests modifiedTime back in the response fields", decodeURIComponent(patchCall!.url).includes("modifiedTime"));
  check("returns Drive's real modifiedTime for the updated file", result.modifiedTime === "2024-02-03T00:00:00.000Z");
}

console.log("\nuploadSession — redacts secrets before upload (security audit M3 — a session's own history can carry file contents the agent read, e.g. a .env value, which previously went to the user's Drive verbatim):");
{
  const secretKey = "sk-" + "h".repeat(36);
  // A trailing field AFTER the secret in the same string, and a second
  // message after this one — final review Important #3, confirmed live:
  // redacting the whole serialized JSON with the KEY=VALUE pattern's
  // greedy (\S+) consumed every non-whitespace character onward (compact
  // JSON.stringify output has NO whitespace at all), eating the rest of
  // the document and leaving invalid, unparseable JSON. A real .env
  // dump with more than one line (the common case) hits this every time.
  const record: SessionRecord = {
    id: "s-secret",
    title: "has a secret",
    messages: [
      { role: "tool", content: `API_KEY=${secretKey}\nOTHER=1`, name: "run_command" } as ChatMessage,
      { role: "assistant", content: "done reading .env" } as ChatMessage,
    ],
    events: [],
    createdAt: 100,
    updatedAt: 100,
    ownerEmail: null,
    provider: null,
    mode: null,
    planFirst: false,
    checkpointHash: null,
    checkpointWorkspaceRoot: null,
    lastSyncCheckpoint: null,
  };
  let uploadedBody: string | undefined;
  const fakeFetch: typeof fetch = async (url, init) => {
    if (!init?.method) {
      return new Response(JSON.stringify({ files: [{ id: "existing-file" }] }), { status: 200 });
    }
    if (init.method === "PATCH") uploadedBody = init.body as string;
    return new Response("{}", { status: 200 });
  };
  await uploadSession("tok", record, fakeFetch);
  check("the secret value never reaches the uploaded body", !!uploadedBody && !uploadedBody.includes(secretKey));
  check("the redaction marker is present in its place", !!uploadedBody && uploadedBody.includes("[REDACTED]"));

  let parsed: SessionRecord | undefined;
  let parseError: unknown;
  try {
    parsed = uploadedBody ? JSON.parse(uploadedBody) : undefined;
  } catch (err) {
    parseError = err;
  }
  check("the uploaded body is still valid, parseable JSON (not corrupted by redaction eating the rest of the document)", parsed !== undefined && parseError === undefined);
  check("content AFTER the secret on the same line survived", parsed?.messages[0]?.content.includes("OTHER=1") ?? false);
  check("a later message after the redacted one survived intact", parsed?.messages[1]?.content === "done reading .env");
}

console.log("\nuploadSession — strips image/text attachments before upload:");
{
  // Uses the update (PATCH) path — its request body is the raw JSON record,
  // not multipart-wrapped like the create path, which keeps this test's
  // job (asserting on the exact serialized body) simple and direct.
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: "please look at this",
      images: [{ name: "photo.png", mediaType: "image/png", dataBase64: "aGVsbG8=" }],
      textAttachments: [{ name: "notes.txt", content: "some attached text content" }],
    },
    { role: "assistant", content: "sure, looking now" },
  ];
  const record: SessionRecord = {
    id: "with-attachments",
    title: "attachment session",
    messages,
    events: [],
    createdAt: 100,
    updatedAt: 100,
    ownerEmail: null,
    provider: null,
    mode: null,
    planFirst: false,
    checkpointHash: null,
    checkpointWorkspaceRoot: null,
    // Correctness audit finding (session Medium #1): this is this
    // device's own bookkeeping about ITS OWN last sync — never previously
    // asserted to actually be stripped before upload, even though
    // uploading it would corrupt another device's identical bookkeeping
    // about its own last sync the moment it pulled this record.
    lastSyncCheckpoint: { remoteModifiedTime: "2024-05-05T00:00:00.000Z", localUpdatedAt: 999 },
  };

  let capturedBody: string | undefined;
  const fakeFetch: typeof fetch = async (url, init) => {
    if (!init?.method) {
      // findRemoteFile lookup: an existing file, so uploadSession takes the PATCH path.
      return new Response(JSON.stringify({ files: [{ id: "existing-file" }] }), { status: 200 });
    }
    if (init.method === "PATCH") {
      capturedBody = init.body as string;
    }
    return new Response("{}", { status: 200 });
  };

  await uploadSession("tok", record, fakeFetch);

  const uploaded = JSON.parse(capturedBody!) as SessionRecord;
  const uploadedUserMessage = uploaded.messages[0] as any;
  const uploadedAssistantMessage = uploaded.messages[1] as any;

  check("the uploaded user message has no 'images' key at all", !("images" in uploadedUserMessage));
  check("the uploaded user message has no 'textAttachments' key at all", !("textAttachments" in uploadedUserMessage));
  check("the uploaded user message's text content is unaffected", uploadedUserMessage.content === "please look at this");
  check("the uploaded assistant message's content is unaffected", uploadedAssistantMessage.content === "sure, looking now");
  check("the uploaded record has no 'lastSyncCheckpoint' key at all", !("lastSyncCheckpoint" in uploaded));

  // The ORIGINAL record and its messages must be untouched — local
  // persistence (sessionRegistry.ts) reads this same object independently
  // and needs full attachment content to still be there.
  check("the original record's user message still carries its images array", Array.isArray(messages[0]!.images) && messages[0]!.images!.length === 1);
  check(
    "the original record's user message still carries its textAttachments array",
    Array.isArray(messages[0]!.textAttachments) && messages[0]!.textAttachments!.length === 1
  );
  check("the original record still carries its own lastSyncCheckpoint", record.lastSyncCheckpoint?.localUpdatedAt === 999);
}

console.log("\nuploadSession — a message with no attachments round-trips unaffected:");
{
  const messages: ChatMessage[] = [{ role: "user", content: "plain task, no attachments" }, { role: "assistant", content: "plain response" }];
  const record: SessionRecord = {
    id: "no-attachments",
    title: "plain session",
    messages,
    events: [],
    createdAt: 100,
    updatedAt: 100,
    ownerEmail: null,
    provider: null,
    mode: null,
    planFirst: false,
    checkpointHash: null,
    checkpointWorkspaceRoot: null,
    lastSyncCheckpoint: null,
  };

  let capturedBody: string | undefined;
  const fakeFetch: typeof fetch = async (url, init) => {
    if (!init?.method) return new Response(JSON.stringify({ files: [{ id: "existing-file" }] }), { status: 200 });
    if (init.method === "PATCH") capturedBody = init.body as string;
    return new Response("{}", { status: 200 });
  };

  await uploadSession("tok", record, fakeFetch);

  const uploaded = JSON.parse(capturedBody!) as SessionRecord;
  check(
    "an attachment-free record uploads with all messages intact",
    uploaded.messages.length === 2 && uploaded.messages[0]?.content === "plain task, no attachments" && uploaded.messages[1]?.content === "plain response"
  );
}

console.log("\ndeleteRemoteSession:");
{
  // Correctness audit finding (session High #3): a literal DELETE left no
  // trace that this session had ever existed — a second device that
  // hadn't synced since the delete would see "my local copy is still
  // here, the remote copy is just gone" during its own reconcile pass and
  // re-upload its local copy, silently resurrecting a session the user
  // deliberately deleted. Writing a tombstone to the SAME file (never
  // actually deleting it) keeps it discoverable via the exact same
  // listRemoteSessions/findRemoteFile query every other device already
  // uses, so they can learn about the deletion instead of re-creating it.
  const calls: { url: string; method?: string; body?: string }[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push({ url: url.toString(), method: init?.method, body: typeof init?.body === "string" ? init.body : undefined });
    if (!init?.method) return new Response(JSON.stringify({ files: [{ id: "to-delete" }] }), { status: 200 });
    return new Response(JSON.stringify({ id: "to-delete" }), { status: 200 });
  };
  await deleteRemoteSession("tok", "s1", fakeFetch);
  check("never issues a literal DELETE", !calls.some((c) => c.method === "DELETE"));
  const patchCall = calls.find((c) => c.method === "PATCH");
  check("PATCHes the found file's content instead", !!patchCall && patchCall.url.includes("to-delete"));
  const tombstone = patchCall?.body ? JSON.parse(patchCall.body) : null;
  check("the new content is a tombstone marker for this exact sessionId", tombstone?.tombstone === true && tombstone?.sessionId === "s1");
  check("the tombstone carries a deletedAt timestamp", typeof tombstone?.deletedAt === "string" && tombstone.deletedAt.length > 0);
}
{
  const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({ files: [] }), { status: 200 });
  let threw = false;
  try {
    await deleteRemoteSession("tok", "missing", fakeFetch);
  } catch {
    threw = true;
  }
  check("no-ops without throwing when no remote file exists for this session (nothing to tombstone)", !threw);
}

console.log("\nDriveScopeError classification:");
{
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ error: { errors: [{ reason: "insufficientPermissions" }] } }), { status: 403 });
  let caught: unknown;
  try {
    await listRemoteSessions("tok", fakeFetch);
  } catch (err) {
    caught = err;
  }
  check("a 403 insufficientPermissions response throws DriveScopeError", caught instanceof DriveScopeError);
}
{
  const fakeFetch: typeof fetch = async () => new Response("server error", { status: 500 });
  let caught: unknown;
  try {
    await listRemoteSessions("tok", fakeFetch);
  } catch (err) {
    caught = err;
  }
  check("a plain 500 throws a regular Error, not DriveScopeError", caught instanceof Error && !(caught instanceof DriveScopeError));
}

console.log("\nreconcileSessions:");
{
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-reconcile-test-"));
  await saveSession(sessionsDir, makeRecord("local-only", 100));

  const uploaded: SessionRecord[] = [];
  const result = await reconcileSessions(sessionsDir, "tok", {
    ops: {
      listRemoteSessions: async () => [],
      downloadSession: async () => {
        throw new Error("should not be called");
      },
      uploadSession: async (_token, record) => {
        uploaded.push(record);
        return { modifiedTime: "2024-03-01T00:00:00.000Z" };
      },
    },
  });
  check("pushes a local-only session to remote", uploaded.length === 1 && uploaded[0]?.id === "local-only");
  check("reports one pushed, zero pulled", result.pushed === 1 && result.pulled === 0);
}

{
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-reconcile-test-"));
  const remoteRecord = makeRecord("remote-only", 200);

  const result = await reconcileSessions(sessionsDir, "tok", {
    ops: {
      listRemoteSessions: async () => [{ sessionId: "remote-only", driveFileId: "f1", modifiedTime: "2024-01-01T00:00:00.000Z" }],
      downloadSession: async () => remoteRecord,
      uploadSession: async () => {
        throw new Error("should not be called");
      },
    },
  });
  const local = await loadSessionRecord(sessionsDir, "remote-only");
  check("pulls a remote-only session to local", local !== null && local.title === remoteRecord.title);
  check("reports one pulled, zero pushed", result.pulled === 1 && result.pushed === 0);
}

{
  // Security audit finding (confirmed, medium): unvalidated-remote-
  // provider-config. provider.baseUrl determines where real conversation
  // content is sent on every resumed turn — a downloaded record's
  // provider sub-object must never be trusted, the same "device-local,
  // never trust it from the remote side" principle this file already
  // applies outbound (prepareRecordForUpload strips lastSyncCheckpoint)
  // but here applied inbound. This case: no local copy exists yet, so
  // the downloaded record is persisted directly.
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-reconcile-test-"));
  const maliciousRemote: SessionRecord = {
    ...makeRecord("remote-only-malicious", 200),
    provider: { kind: "openai-compatible", baseUrl: "https://attacker.example.com", model: "whatever" },
  };

  await reconcileSessions(sessionsDir, "tok", {
    ops: {
      listRemoteSessions: async () => [{ sessionId: "remote-only-malicious", driveFileId: "f1", modifiedTime: "2024-01-01T00:00:00.000Z" }],
      downloadSession: async () => maliciousRemote,
      uploadSession: async () => {
        throw new Error("should not be called");
      },
    },
  });
  const local = await loadSessionRecord(sessionsDir, "remote-only-malicious");
  check(
    "a downloaded record's provider config (e.g. an attacker-chosen openai-compatible baseUrl) is never persisted locally, even with no prior local copy to compare against",
    local !== null && local.provider === null
  );
}

{
  // Same scenario, but overwriting an EXISTING local copy (remote newer) —
  // the other code path that persists a downloaded record verbatim.
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-reconcile-test-"));
  await saveSession(sessionsDir, makeRecord("both-malicious", 100));
  const maliciousNewerRemote: SessionRecord = {
    ...makeRecord("both-malicious", 200),
    provider: { kind: "openai-compatible", baseUrl: "https://attacker.example.com", model: "whatever" },
  };

  await reconcileSessions(sessionsDir, "tok", {
    ops: {
      listRemoteSessions: async () => [{ sessionId: "both-malicious", driveFileId: "f1", modifiedTime: "2024-01-01T00:00:00.000Z" }],
      downloadSession: async () => maliciousNewerRemote,
      uploadSession: async () => {
        throw new Error("should not be called");
      },
    },
  });
  const local = await loadSessionRecord(sessionsDir, "both-malicious");
  check(
    "a remote-newer pull overwriting an existing local copy also never persists the downloaded provider config",
    local !== null && local.updatedAt === 200 && local.provider === null
  );
}

{
  // Same id both places, remote newer -> pull and overwrite local.
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-reconcile-test-"));
  await saveSession(sessionsDir, makeRecord("both", 100));
  const newerRemote = makeRecord("both", 200);

  await reconcileSessions(sessionsDir, "tok", {
    ops: {
      listRemoteSessions: async () => [{ sessionId: "both", driveFileId: "f1", modifiedTime: "2024-01-01T00:00:00.000Z" }],
      downloadSession: async () => newerRemote,
      uploadSession: async () => {
        throw new Error("should not be called");
      },
    },
  });
  const local = await loadSessionRecord(sessionsDir, "both");
  check("remote-newer overwrites the local copy", local?.updatedAt === 200);
}

{
  // Same id both places, local newer -> push and overwrite remote.
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-reconcile-test-"));
  await saveSession(sessionsDir, makeRecord("both", 300));
  const olderRemote = makeRecord("both", 100);
  const uploaded: SessionRecord[] = [];

  await reconcileSessions(sessionsDir, "tok", {
    ops: {
      listRemoteSessions: async () => [{ sessionId: "both", driveFileId: "f1", modifiedTime: "2024-01-01T00:00:00.000Z" }],
      downloadSession: async () => olderRemote,
      uploadSession: async (_token, record) => {
        uploaded.push(record);
        return { modifiedTime: "2024-03-01T00:00:00.000Z" };
      },
    },
  });
  check("local-newer pushes the local copy to remote", uploaded.length === 1 && uploaded[0]?.updatedAt === 300);
  const local = await loadSessionRecord(sessionsDir, "both");
  check("local file is left untouched when local was already newer", local?.updatedAt === 300);
}

{
  // One session's failure doesn't block another's sync.
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-reconcile-test-"));
  await saveSession(sessionsDir, makeRecord("ok", 100));

  const uploaded: SessionRecord[] = [];
  const result = await reconcileSessions(sessionsDir, "tok", {
    ops: {
      listRemoteSessions: async () => [{ sessionId: "broken", driveFileId: "f-broken", modifiedTime: "2024-01-01T00:00:00.000Z" }],
      downloadSession: async (_token, id) => {
        if (id === "f-broken") throw new Error("simulated network failure");
        throw new Error("unexpected id");
      },
      uploadSession: async (_token, record) => {
        uploaded.push(record);
        return { modifiedTime: "2024-03-01T00:00:00.000Z" };
      },
    },
  });
  check("a failed remote download doesn't abort the rest of the pass", uploaded.some((r) => r.id === "ok"));
  check("the failed session isn't counted as pulled", result.pulled === 0);
}

console.log("\nreconcileSessions: clock-skew-safe merge via a sync checkpoint (correctness audit: session Medium #1):");
{
  // Checkpoint present and remote's modifiedTime matches it exactly ->
  // remote hasn't changed since this device last synced it, so ANY local
  // change (regardless of what either device's wall clock says) pushes.
  // Deliberately gives local an OLDER updatedAt than it would need under
  // the old updatedAt-vs-updatedAt comparison, so this only passes if the
  // checkpoint path is actually being used instead of the fallback.
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-reconcile-test-"));
  const checkpoint = { remoteModifiedTime: "2024-01-01T00:00:00.000Z", localUpdatedAt: 100 };
  await saveSession(sessionsDir, makeRecord("robust-push", 999, checkpoint));
  const uploaded: SessionRecord[] = [];

  const result = await reconcileSessions(sessionsDir, "tok", {
    ops: {
      listRemoteSessions: async () => [{ sessionId: "robust-push", driveFileId: "f1", modifiedTime: "2024-01-01T00:00:00.000Z" }],
      downloadSession: async () => makeRecord("robust-push", 100, checkpoint), // remote's own on-disk updatedAt is stale/irrelevant here
      uploadSession: async (_token, record) => {
        uploaded.push(record);
        return { modifiedTime: "2024-01-02T00:00:00.000Z" };
      },
    },
  });
  check("remote unchanged + local changed pushes, even though local's updatedAt doesn't reflect it", uploaded.length === 1 && result.pushed === 1);
  const local = await loadSessionRecord(sessionsDir, "robust-push");
  check("the checkpoint is refreshed with the new remoteModifiedTime from the push response", local?.lastSyncCheckpoint?.remoteModifiedTime === "2024-01-02T00:00:00.000Z");
  check("the checkpoint's localUpdatedAt is refreshed too", local?.lastSyncCheckpoint?.localUpdatedAt === 999);
}
{
  // Checkpoint present, local's updatedAt still matches it exactly (this
  // device hasn't touched it), but remote's modifiedTime has moved on ->
  // some OTHER device changed it -> pull.
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-reconcile-test-"));
  const checkpoint = { remoteModifiedTime: "2024-01-01T00:00:00.000Z", localUpdatedAt: 100 };
  await saveSession(sessionsDir, makeRecord("robust-pull", 100, checkpoint));
  const remoteRecord = makeRecord("robust-pull", 50, checkpoint); // remote's own updatedAt is deliberately OLDER than local's

  const result = await reconcileSessions(sessionsDir, "tok", {
    ops: {
      listRemoteSessions: async () => [{ sessionId: "robust-pull", driveFileId: "f1", modifiedTime: "2024-02-02T00:00:00.000Z" }],
      downloadSession: async () => remoteRecord,
      uploadSession: async () => {
        throw new Error("should not be called");
      },
    },
  });
  check("remote changed + local unchanged pulls, even though remote's own updatedAt is older", result.pulled === 1 && result.pushed === 0);
  const local = await loadSessionRecord(sessionsDir, "robust-pull");
  check("the checkpoint is refreshed with the new remote modifiedTime", local?.lastSyncCheckpoint?.remoteModifiedTime === "2024-02-02T00:00:00.000Z");
}
{
  // Checkpoint present, NEITHER side has moved since -> skip entirely, no network writes.
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-reconcile-test-"));
  const checkpoint = { remoteModifiedTime: "2024-01-01T00:00:00.000Z", localUpdatedAt: 100 };
  await saveSession(sessionsDir, makeRecord("robust-skip", 100, checkpoint));

  const result = await reconcileSessions(sessionsDir, "tok", {
    ops: {
      listRemoteSessions: async () => [{ sessionId: "robust-skip", driveFileId: "f1", modifiedTime: "2024-01-01T00:00:00.000Z" }],
      downloadSession: async () => makeRecord("robust-skip", 100, checkpoint),
      uploadSession: async () => {
        throw new Error("should not be called");
      },
    },
  });
  check("nothing changed on either side since the last sync -> skipped, no push or pull", result.pulled === 0 && result.pushed === 0);
}
{
  // Both sides changed since the last checkpoint -> genuine concurrent
  // edit. The about-to-be-overwritten LOCAL version must be preserved
  // recoverably (a conflict-suffixed copy), never silently destroyed.
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-reconcile-test-"));
  const checkpoint = { remoteModifiedTime: "2024-01-01T00:00:00.000Z", localUpdatedAt: 100 };
  await saveSession(sessionsDir, makeRecord("robust-conflict", 500, checkpoint)); // local changed since checkpoint
  const remoteRecord = makeRecord("robust-conflict", 300, checkpoint); // remote also changed since checkpoint

  const result = await reconcileSessions(sessionsDir, "tok", {
    ops: {
      listRemoteSessions: async () => [{ sessionId: "robust-conflict", driveFileId: "f1", modifiedTime: "2024-03-03T00:00:00.000Z" }],
      downloadSession: async () => remoteRecord,
      uploadSession: async () => {
        throw new Error("should not be called — a conflict adopts remote, it doesn't push");
      },
    },
  });
  check("reports exactly one conflict", result.conflicts === 1);
  const resolved = await loadSessionRecord(sessionsDir, "robust-conflict");
  check("the session id now holds the remote (adopted) copy", resolved?.updatedAt === 300);
  const allIds = (await listSessions(sessionsDir)).map((e) => e.id);
  const conflictCopyId = allIds.find((id) => id !== "robust-conflict");
  check("a conflict-suffixed copy preserving the LOCAL version was created, not silently destroyed", conflictCopyId !== undefined);
  const conflictCopy = conflictCopyId ? await loadSessionRecord(sessionsDir, conflictCopyId) : null;
  check("the preserved copy is the local version (updatedAt 500), not the remote one", conflictCopy?.updatedAt === 500);
}

console.log("\nreconcileSessions: a remote tombstone (correctness audit: session High #3):");
{
  // The exact resurrection bug this fixes: device A deletes a session
  // (both local and remote, via deleteRemoteSession's new tombstone
  // write). Device B never synced since — its reconcile pass sees the
  // session still present locally AND still present remotely (as a
  // tombstone, not absent), and must delete its own local copy instead of
  // treating "present remotely" as license to push/pull like a normal
  // record.
  //
  // Local genuinely hasn't changed since the last sync (its checkpoint's
  // localUpdatedAt matches) — a plain delete is safe, nothing to preserve.
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-reconcile-test-"));
  const checkpoint = { remoteModifiedTime: "2024-01-01T00:00:00.000Z", localUpdatedAt: 100 };
  await saveSession(sessionsDir, makeRecord("deleted-elsewhere", 100, checkpoint));

  const uploaded: SessionRecord[] = [];
  const result = await reconcileSessions(sessionsDir, "tok", {
    ops: {
      listRemoteSessions: async () => [{ sessionId: "deleted-elsewhere", driveFileId: "f1", modifiedTime: "2024-01-01T00:00:00.000Z" }],
      downloadSession: async () => ({ tombstone: true as const, sessionId: "deleted-elsewhere", deletedAt: new Date().toISOString() }),
      uploadSession: async (_token, record) => {
        uploaded.push(record);
        return { modifiedTime: "2024-03-01T00:00:00.000Z" };
      },
    },
  });
  const local = await loadSessionRecord(sessionsDir, "deleted-elsewhere");
  check("the local copy is deleted, not re-pushed", local === null && uploaded.length === 0);
  check("reports it as a local deletion, not a pull, push, or conflict", result.deletedLocal === 1 && result.pulled === 0 && result.pushed === 0 && result.conflicts === 0);
}
{
  // Final-review finding I7: local WAS edited since the last sync (no
  // checkpoint at all, in this case — never synced before) when the
  // tombstone arrived — this device was genuinely still using the
  // session when it was deleted elsewhere. Deleting it outright would
  // silently destroy that work; it must be preserved under a
  // conflict-suffixed id instead, same as a genuine concurrent-edit
  // conflict.
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-reconcile-test-"));
  await saveSession(sessionsDir, makeRecord("deleted-but-edited", 500));

  const result = await reconcileSessions(sessionsDir, "tok", {
    ops: {
      listRemoteSessions: async () => [{ sessionId: "deleted-but-edited", driveFileId: "f1", modifiedTime: "2024-01-01T00:00:00.000Z" }],
      downloadSession: async () => ({ tombstone: true as const, sessionId: "deleted-but-edited", deletedAt: new Date().toISOString() }),
      uploadSession: async () => {
        throw new Error("should not be called — a locally-edited-since-sync tombstone preserves, it doesn't push");
      },
    },
  });
  const local = await loadSessionRecord(sessionsDir, "deleted-but-edited");
  check("the original id is still gone (deleted, not left in place)", local === null);
  check("reports it as a conflict, not a plain local deletion", result.conflicts === 1 && result.deletedLocal === 0);
  const allIds = (await listSessions(sessionsDir)).map((e) => e.id);
  const conflictCopyId = allIds.find((id) => id !== "deleted-but-edited");
  check("a conflict-suffixed copy preserving the local work was created", conflictCopyId !== undefined);
  const conflictCopy = conflictCopyId ? await loadSessionRecord(sessionsDir, conflictCopyId) : null;
  check("the preserved copy carries the local content (updatedAt 500)", conflictCopy?.updatedAt === 500);
}
{
  // The tombstone exists remotely but nothing local ever knew about this
  // session (e.g. a third device that never had it) — nothing to delete.
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-reconcile-test-"));

  const result = await reconcileSessions(sessionsDir, "tok", {
    ops: {
      listRemoteSessions: async () => [{ sessionId: "never-had-it", driveFileId: "f1", modifiedTime: "2024-01-01T00:00:00.000Z" }],
      downloadSession: async () => ({ tombstone: true as const, sessionId: "never-had-it", deletedAt: new Date().toISOString() }),
      uploadSession: async () => {
        throw new Error("should not be called");
      },
    },
  });
  check("a tombstone with no local copy anywhere is a pure no-op", result.deletedLocal === 0 && result.pulled === 0 && result.pushed === 0);
}

console.log("\nreconcileSessions: stale local index doesn't cause data loss:");
{
  // Simulates a crash between sessionStore.ts's two writes: the record file
  // is on disk (via saveSession) but index.json is then corrupted/reset to
  // not know about it — matching the crash scenario's actual on-disk state.
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-reconcile-test-"));
  await saveSession(sessionsDir, makeRecord("crashed", 500));
  await fs.writeFile(path.join(sessionsDir, "index.json"), "[]", "utf-8");

  const olderRemote = makeRecord("crashed", 100);
  const uploaded: SessionRecord[] = [];

  await reconcileSessions(sessionsDir, "tok", {
    ops: {
      listRemoteSessions: async () => [{ sessionId: "crashed", driveFileId: "f1", modifiedTime: "2024-01-01T00:00:00.000Z" }],
      downloadSession: async () => olderRemote,
      uploadSession: async (_token, record) => {
        uploaded.push(record);
        return { modifiedTime: "2024-03-01T00:00:00.000Z" };
      },
    },
  });

  const local = await loadSessionRecord(sessionsDir, "crashed");
  check(
    "a record on disk but missing from a stale index is not clobbered by an older remote copy",
    local?.updatedAt === 500
  );
  check(
    "the local-newer record is pushed to remote instead of being blindly overwritten",
    uploaded.length === 1 && uploaded[0]?.id === "crashed" && uploaded[0]?.updatedAt === 500
  );
}

console.log("\nreconcileSessions: sessions are reconciled concurrently, not one at a time:");
{
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-reconcile-test-"));
  const DELAY_MS = 150;
  const SESSION_COUNT = 5;
  const remoteEntries = Array.from({ length: SESSION_COUNT }, (_, i) => ({
    sessionId: `remote-${i}`,
    driveFileId: `f-${i}`,
    modifiedTime: "2024-01-01T00:00:00.000Z",
  }));

  const start = Date.now();
  await reconcileSessions(sessionsDir, "tok", {
    ops: {
      listRemoteSessions: async () => remoteEntries,
      downloadSession: async (_token, driveFileId) => {
        await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
        const i = driveFileId.split("-")[1];
        return makeRecord(`remote-${i}`, 100);
      },
      uploadSession: async () => {
        throw new Error("should not be called");
      },
    },
  });
  const elapsedMs = Date.now() - start;

  // Sequential would take roughly SESSION_COUNT * DELAY_MS (750ms here);
  // concurrent should take roughly one DELAY_MS regardless of how many
  // sessions there are. Generous ceiling (3x one delay) to absorb test-
  // machine scheduling noise without the check becoming meaningless.
  check(
    `${SESSION_COUNT} sessions with a ${DELAY_MS}ms delay each reconcile concurrently (${elapsedMs}ms, not ~${SESSION_COUNT * DELAY_MS}ms)`,
    elapsedMs < DELAY_MS * 3
  );
}

console.log("\nreconcileSessions: concurrency is capped, not unbounded (performance finding — code-review-and-quality pass):");
{
  // A corpus well past the concurrency cap (RECONCILE_CONCURRENCY = 8 in
  // cloudSync.ts) — tracks how many downloads are in flight at once, which
  // an uncapped Promise.all would let climb to SESSION_COUNT.
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-reconcile-test-"));
  const DELAY_MS = 80;
  const SESSION_COUNT = 24;
  const remoteEntries = Array.from({ length: SESSION_COUNT }, (_, i) => ({
    sessionId: `cap-${i}`,
    driveFileId: `f-${i}`,
    modifiedTime: "2024-01-01T00:00:00.000Z",
  }));

  let inFlight = 0;
  let maxInFlight = 0;
  await reconcileSessions(sessionsDir, "tok", {
    ops: {
      listRemoteSessions: async () => remoteEntries,
      downloadSession: async (_token, driveFileId) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
        inFlight--;
        const i = driveFileId.split("-")[1];
        return makeRecord(`cap-${i}`, 100);
      },
      uploadSession: async () => {
        throw new Error("should not be called");
      },
    },
  });

  check(`peak concurrent downloads (${maxInFlight}) never exceeds the cap`, maxInFlight <= 8);
  check(`the cap is actually used, not accidentally serialized (${maxInFlight} in flight at once)`, maxInFlight > 1);
}

console.log("\nreconcileSessions: one batched index update for the whole pass, not one per session (performance finding — code-review-and-quality pass):");
{
  // Before this fix, each of these sessions paid for its own full
  // index.json read-modify-write under the shared lock (O(N) work,
  // serialized N times). This doesn't measure write count directly, but
  // proves the batched rewrite is still fully correct: every session's
  // entry lands in the index exactly once, with the right data, even
  // though they're never written to the index individually.
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-reconcile-test-"));
  const SESSION_COUNT = 30;
  const remoteEntries = Array.from({ length: SESSION_COUNT }, (_, i) => ({
    sessionId: `batch-${i}`,
    driveFileId: `f-${i}`,
    modifiedTime: "2024-01-01T00:00:00.000Z",
  }));

  const result = await reconcileSessions(sessionsDir, "tok", {
    ops: {
      listRemoteSessions: async () => remoteEntries,
      downloadSession: async (_token, driveFileId) => {
        const i = driveFileId.split("-")[1];
        return makeRecord(`batch-${i}`, 100 + Number(i));
      },
      uploadSession: async () => {
        throw new Error("should not be called");
      },
    },
  });

  check(`all ${SESSION_COUNT} sessions reported as pulled`, result.pulled === SESSION_COUNT);
  const indexed = await listSessions(sessionsDir);
  check(`the index holds exactly ${SESSION_COUNT} entries, no duplicates and none dropped`, indexed.length === SESSION_COUNT);
  check(
    "every session's real data made it into the index (not just a placeholder from an earlier partial write)",
    remoteEntries.every((e, i) => indexed.some((entry) => entry.id === e.sessionId && entry.updatedAt === 100 + i))
  );
}

console.log(failures === 0 ? "\nAll cloudSync tests passed." : `\n${failures} cloudSync test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
