import { listRemoteSessions, downloadSession, uploadSession, deleteRemoteSession, DriveScopeError } from "../cloudSync.js";
import type { SessionRecord } from "../sessionStore.js";

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

console.log(failures === 0 ? "\nAll cloudSync tests passed." : `\n${failures} cloudSync test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
