import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { listRemoteSessions, downloadSession, uploadSession, deleteRemoteSession, DriveScopeError, reconcileSessions } from "../cloudSync.js";
import type { SessionRecord } from "../sessionStore.js";
import { loadSessionRecord, saveSession } from "../sessionStore.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

function makeRecord(id: string, updatedAt: number): SessionRecord {
  return { id, title: `title-${id}`, messages: [], events: [], createdAt: updatedAt, updatedAt };
}

console.log("cloudSync (fake fetch):");

console.log("\nlistRemoteSessions:");
{
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (url) => {
    calls.push(url.toString());
    return new Response(
      JSON.stringify({ files: [{ id: "f1", appProperties: { sessionId: "s1" } }, { id: "f2", appProperties: {} }] }),
      { status: 200 }
    );
  };
  const result = await listRemoteSessions("tok", fakeFetch);
  check(
    "maps only files that carry a sessionId property",
    result.length === 1 && result[0]!.sessionId === "s1" && result[0]!.driveFileId === "f1"
  );
  check("requests the appDataFolder space", calls[0]!.includes("spaces=appDataFolder"));
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
    return new Response("{}", { status: 200 });
  };
  await uploadSession("tok", makeRecord("new-session", 100), fakeFetch);
  const createCall = calls.find((c) => c.method === "POST");
  check("issues a multipart create when no existing file is found", !!createCall && createCall.url.includes("uploadType=multipart"));
}

console.log("\nuploadSession — update path (existing file):");
{
  const calls: { url: string; method?: string }[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push({ url: url.toString(), method: init?.method });
    if (!init?.method) {
      return new Response(JSON.stringify({ files: [{ id: "existing-file" }] }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };
  await uploadSession("tok", makeRecord("s1", 100), fakeFetch);
  const patchCall = calls.find((c) => c.method === "PATCH");
  check(
    "issues a media PATCH to the found file id when one exists",
    !!patchCall && patchCall.url.includes("existing-file") && patchCall.url.includes("uploadType=media")
  );
}

console.log("\ndeleteRemoteSession:");
{
  const calls: { url: string; method?: string }[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push({ url: url.toString(), method: init?.method });
    if (!init?.method) return new Response(JSON.stringify({ files: [{ id: "to-delete" }] }), { status: 200 });
    return new Response(null, { status: 204 });
  };
  await deleteRemoteSession("tok", "s1", fakeFetch);
  const deleteCall = calls.find((c) => c.method === "DELETE");
  check("deletes the found file id", !!deleteCall && deleteCall.url.includes("to-delete"));
}
{
  const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({ files: [] }), { status: 200 });
  let threw = false;
  try {
    await deleteRemoteSession("tok", "missing", fakeFetch);
  } catch {
    threw = true;
  }
  check("no-ops without throwing when no remote file exists for this session", !threw);
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
      listRemoteSessions: async () => [{ sessionId: "remote-only", driveFileId: "f1" }],
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
  // Same id both places, remote newer -> pull and overwrite local.
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-reconcile-test-"));
  await saveSession(sessionsDir, makeRecord("both", 100));
  const newerRemote = makeRecord("both", 200);

  await reconcileSessions(sessionsDir, "tok", {
    ops: {
      listRemoteSessions: async () => [{ sessionId: "both", driveFileId: "f1" }],
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
      listRemoteSessions: async () => [{ sessionId: "both", driveFileId: "f1" }],
      downloadSession: async () => olderRemote,
      uploadSession: async (_token, record) => {
        uploaded.push(record);
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
      listRemoteSessions: async () => [{ sessionId: "broken", driveFileId: "f-broken" }],
      downloadSession: async (_token, id) => {
        if (id === "f-broken") throw new Error("simulated network failure");
        throw new Error("unexpected id");
      },
      uploadSession: async (_token, record) => {
        uploaded.push(record);
      },
    },
  });
  check("a failed remote download doesn't abort the rest of the pass", uploaded.some((r) => r.id === "ok"));
  check("the failed session isn't counted as pulled", result.pulled === 0);
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
      listRemoteSessions: async () => [{ sessionId: "crashed", driveFileId: "f1" }],
      downloadSession: async () => olderRemote,
      uploadSession: async (_token, record) => {
        uploaded.push(record);
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

console.log(failures === 0 ? "\nAll cloudSync tests passed." : `\n${failures} cloudSync test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
