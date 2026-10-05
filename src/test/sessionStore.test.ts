import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  listSessions,
  searchSessions,
  loadSessionRecord,
  saveSession,
  deleteSession,
  rebuildIndex,
  claimUnownedSessions,
  SEARCH_RESULT_CAP,
  type SessionRecord,
} from "../sessionStore.js";
import type { ChatMessage, AgentEvent } from "../types.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

function makeRecord(id: string, title: string, updatedAt: number, extra: Partial<SessionRecord> = {}): SessionRecord {
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: title },
  ];
  const events: AgentEvent[] = [{ type: "text", text: `response mentioning ${title}` }];
  return {
    id,
    title,
    messages,
    events,
    createdAt: updatedAt,
    updatedAt,
    ownerEmail: null,
    provider: null,
    mode: null,
    planFirst: false,
    checkpointHash: null,
    checkpointWorkspaceRoot: null,
    lastSyncCheckpoint: null,
    ...extra,
  };
}

console.log("Session store (explicit path):");

async function runTests() {
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-sessions-test-"));

  console.log("\nEmpty history:");
  check("listSessions on a nonexistent dir returns []", (await listSessions(path.join(sessionsDir, "nope"))).length === 0);

  console.log("\nSave/load round trip:");
  const record = makeRecord("s1", "first session", 1000);
  await saveSession(sessionsDir, record);
  const loaded = await loadSessionRecord(sessionsDir, "s1");
  check("saved record round-trips through load", JSON.stringify(loaded) === JSON.stringify(record));

  const indexAfterSave = await listSessions(sessionsDir);
  check("listSessions shows the saved session", indexAfterSave.some((e) => e.id === "s1" && e.title === "first session"));

  console.log("\nUpsert on repeated saves:");
  const updated = makeRecord("s1", "first session", 2000, { createdAt: 1000 });
  await saveSession(sessionsDir, updated);
  const indexAfterUpdate = await listSessions(sessionsDir);
  check("repeated save does not duplicate the index entry", indexAfterUpdate.filter((e) => e.id === "s1").length === 1);
  check("repeated save refreshes updatedAt in the index", indexAfterUpdate.find((e) => e.id === "s1")?.updatedAt === 2000);

  console.log("\nMissing/corrupted records:");
  check("loadSessionRecord on a missing id returns null", (await loadSessionRecord(sessionsDir, "nonexistent")) === null);

  await fs.writeFile(path.join(sessionsDir, "corrupt.json"), "{not valid json", "utf-8");
  check("loadSessionRecord on corrupted JSON returns null", (await loadSessionRecord(sessionsDir, "corrupt")) === null);

  await fs.writeFile(path.join(sessionsDir, "wrongshape.json"), JSON.stringify({ foo: "bar" }), "utf-8");
  check("loadSessionRecord on wrong-shape JSON returns null", (await loadSessionRecord(sessionsDir, "wrongshape")) === null);

  console.log("\nSearch (full transcript text):");
  await saveSession(sessionsDir, makeRecord("s2", "second session", 1500));
  const searchByTitle = await searchSessions(sessionsDir, "second");
  check("search matches on title", searchByTitle.some((e) => e.id === "s2") && !searchByTitle.some((e) => e.id === "s1"));

  const searchByBody = await searchSessions(sessionsDir, "mentioning first session");
  check("search matches on message/event content, not just title", searchByBody.some((e) => e.id === "s1"));

  const searchEmpty = await searchSessions(sessionsDir, "");
  const currentList = await listSessions(sessionsDir);
  check("empty query returns everything", searchEmpty.length === currentList.length);

  console.log("\nSearch result cap (performance finding — code-review-and-quality pass):");
  {
    const capSessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-search-cap-test-"));
    const TOTAL = SEARCH_RESULT_CAP + 50;
    for (let i = 0; i < TOTAL; i++) {
      await saveSession(capSessionsDir, makeRecord(`cap-${i}`, `matchme session ${i}`, i));
    }
    const results = await searchSessions(capSessionsDir, "matchme");
    check(`a query matching every one of ${TOTAL} sessions is capped at SEARCH_RESULT_CAP (${SEARCH_RESULT_CAP})`, results.length === SEARCH_RESULT_CAP);
    // Entries are sorted most-recently-updated first, so the capped result
    // must be the TOP SEARCH_RESULT_CAP by updatedAt (ids TOTAL-1 down to
    // TOTAL-SEARCH_RESULT_CAP), not an arbitrary subset from scan order.
    const expectedNewestId = `cap-${TOTAL - 1}`;
    const expectedOldestIncludedId = `cap-${TOTAL - SEARCH_RESULT_CAP}`;
    check("the capped set is the MOST RECENT matches, not an arbitrary subset", results[0]?.id === expectedNewestId);
    check(
      "the oldest session outside the cap is correctly excluded",
      !results.some((e) => e.id === `cap-${TOTAL - SEARCH_RESULT_CAP - 1}`) && results.some((e) => e.id === expectedOldestIncludedId)
    );
  }

  console.log("\nDelete:");
  await deleteSession(sessionsDir, "s2");
  check("deleteSession removes the record file", (await loadSessionRecord(sessionsDir, "s2")) === null);
  const indexAfterDelete = await listSessions(sessionsDir);
  check("deleteSession removes the index entry", !indexAfterDelete.some((e) => e.id === "s2"));

  console.log("\nRebuild from a corrupted index:");
  await fs.writeFile(path.join(sessionsDir, "index.json"), "{not valid json", "utf-8");
  const rebuilt = await rebuildIndex(sessionsDir);
  check(
    "rebuildIndex reconstructs from the directory listing, skipping unparseable files",
    rebuilt.some((e) => e.id === "s1") && !rebuilt.some((e) => e.id === "corrupt" || e.id === "wrongshape")
  );
  const listAfterRebuild = await listSessions(sessionsDir);
  check("listSessions recovers via rebuildIndex when index.json is corrupted", listAfterRebuild.some((e) => e.id === "s1"));

  console.log("\nOwnership filtering:");
  const ownershipDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-sessions-owner-test-"));
  await saveSession(ownershipDir, makeRecord("owned-a", "a's session", 100, { ownerEmail: "a@example.com" }));
  await saveSession(ownershipDir, makeRecord("owned-b", "b's session", 200, { ownerEmail: "b@example.com" }));
  await saveSession(ownershipDir, makeRecord("unowned", "nobody's session", 300, { ownerEmail: null }));

  const allSessions = await listSessions(ownershipDir);
  check("omitting the owner filter returns every session regardless of owner", allSessions.length === 3);

  const aSessions = await listSessions(ownershipDir, "a@example.com");
  check("listSessions(dir, email) returns only that owner's sessions", aSessions.length === 1 && aSessions[0]?.id === "owned-a");

  const noneSessions = await listSessions(ownershipDir, "nobody-signed-in@example.com");
  check("a non-matching owner filter returns an empty list", noneSessions.length === 0);

  const nullOwnerSessions = await listSessions(ownershipDir, null);
  check("listSessions(dir, null) returns only unowned sessions", nullOwnerSessions.length === 1 && nullOwnerSessions[0]?.id === "unowned");

  const searchScopedToA = await searchSessions(ownershipDir, "session", "a@example.com");
  check("searchSessions honors the owner filter too", searchScopedToA.length === 1 && searchScopedToA[0]?.id === "owned-a");

  console.log("\nclaimUnownedSessions:");
  const claimed = await claimUnownedSessions(ownershipDir, "a@example.com");
  check("claims exactly the unowned sessions", claimed === 1);
  const afterClaim = await loadSessionRecord(ownershipDir, "unowned");
  check("the claimed session now has the claiming owner", afterClaim?.ownerEmail === "a@example.com");
  const bUntouched = await loadSessionRecord(ownershipDir, "owned-b");
  check("an already-owned session is left untouched by a different claim", bUntouched?.ownerEmail === "b@example.com");
  const reclaim = await claimUnownedSessions(ownershipDir, "c@example.com");
  check("claiming again with nothing left unowned claims zero", reclaim === 0);

  console.log("\nBackward compatibility (pre-ownership data):");
  await fs.mkdir(path.join(ownershipDir, "legacy"), { recursive: true });
  const legacyDir = path.join(ownershipDir, "legacy");
  const legacyRecord = { id: "legacy1", title: "legacy session", messages: [], events: [], createdAt: 1, updatedAt: 1 };
  await fs.writeFile(path.join(legacyDir, "legacy1.json"), JSON.stringify(legacyRecord), "utf-8");
  await fs.writeFile(
    path.join(legacyDir, "index.json"),
    JSON.stringify([{ id: "legacy1", title: "legacy session", updatedAt: 1 }]),
    "utf-8"
  );
  const legacyLoaded = await loadSessionRecord(legacyDir, "legacy1");
  check("a record file with no ownerEmail field loads with ownerEmail defaulted to null", legacyLoaded?.ownerEmail === null);
  const legacyIndexed = await listSessions(legacyDir);
  check(
    "an index.json with no ownerEmail field on its entries is accepted as-is (not treated as corrupt) and defaults to null",
    legacyIndexed.length === 1 && legacyIndexed[0]?.ownerEmail === null
  );

  await fs.rm(sessionsDir, { recursive: true, force: true });
  await fs.rm(ownershipDir, { recursive: true, force: true });
}

await runTests();

console.log("\nSessionRecord persists provider/mode/planFirst/checkpointHash, so resuming a session can restore them instead of silently falling back to defaults (correctness audit: session High #1, #2):");
{
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-sessions-persist-test-"));
  const record = makeRecord("persist-1", "has real config", 100, {
    provider: { kind: "anthropic", model: "claude-opus-4" },
    mode: "PLAN",
    planFirst: true,
    checkpointHash: "abc123def456",
    checkpointWorkspaceRoot: "/repo/a",
  });
  await saveSession(sessionsDir, record);
  const loaded = await loadSessionRecord(sessionsDir, "persist-1");
  check("provider round-trips", loaded?.provider?.kind === "anthropic" && (loaded?.provider as any).model === "claude-opus-4");
  check("mode round-trips", loaded?.mode === "PLAN");
  check("planFirst round-trips", loaded?.planFirst === true);
  check("checkpointHash round-trips", loaded?.checkpointHash === "abc123def456");
  // Final-review finding C3: checkpointWorkspaceRoot must round-trip
  // alongside checkpointHash — a lone checkpointHash with no paired
  // workspace is exactly the gap that let a resume/restart apply it in
  // the wrong repo.
  check("checkpointWorkspaceRoot round-trips alongside checkpointHash", loaded?.checkpointWorkspaceRoot === "/repo/a");
  await fs.rm(sessionsDir, { recursive: true, force: true });
}
{
  // A session saved before these fields existed (or one missing them for
  // any other reason) must still load cleanly, with sane defaults rather
  // than being treated as corrupt.
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-sessions-legacy-test-"));
  const legacyRaw = {
    id: "legacy-1",
    title: "old session",
    messages: [],
    events: [],
    createdAt: 1,
    updatedAt: 1,
    ownerEmail: null,
    // no provider/mode/planFirst/checkpointHash at all
  };
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(path.join(sessionsDir, "legacy-1.json"), JSON.stringify(legacyRaw), "utf-8");
  const loaded = await loadSessionRecord(sessionsDir, "legacy-1");
  check("a legacy record with no provider field still loads (not treated as corrupt)", loaded !== null);
  check("provider defaults to null (caller falls back to its own default) rather than throwing", loaded?.provider === null);
  check("mode defaults to null", loaded?.mode === null);
  check("planFirst defaults to false", loaded?.planFirst === false);
  check("checkpointHash defaults to null", loaded?.checkpointHash === null);
  check("checkpointWorkspaceRoot defaults to null", loaded?.checkpointWorkspaceRoot === null);
  await fs.rm(sessionsDir, { recursive: true, force: true });
}

console.log("\nsaveSession writes atomically (correctness audit: session Medium #1 fallout):");
{
  // A real race was found via cloudSync.ts's syncUploadToCloud, which does
  // a SECOND saveSession() for the same id shortly after the first (to
  // refresh lastSyncCheckpoint after a background upload): while that
  // second write was in flight, a concurrent loadSessionRecord() for the
  // very same id intermittently read a truncated/empty file and came back
  // null, even though the record had just been saved correctly moments
  // earlier. A plain fs.writeFile() truncates the destination before
  // writing its content, so a reader racing the write can observe that
  // empty window — reproduced reliably via sessionRegistry.test.ts's own
  // "Session ownership" tests (many concurrent persistSession/
  // syncUploadToCloud calls sharing one sessionsDir), which is this fix's
  // real regression guard; the timing window is too fast and filesystem-
  // dependent to reproduce deterministically in a narrow unit test here.
  // What IS deterministic and worth pinning directly: the atomic
  // write-then-rename strategy must never leak its temp file.
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-sessions-atomic-test-"));
  const id = "atomic-test";
  await saveSession(sessionsDir, makeRecord(id, "v1", 100));
  await saveSession(sessionsDir, makeRecord(id, "v2", 200));
  const filesAfter = await fs.readdir(sessionsDir);
  check("no leftover temp file from the atomic write remains", filesAfter.every((f) => f === `${id}.json` || f === "index.json"));
  const loaded = await loadSessionRecord(sessionsDir, id);
  check("the final record is the last write, fully intact", loaded?.title === "v2");
  await fs.rm(sessionsDir, { recursive: true, force: true });
}

console.log("\nconcurrent saveSession calls don't lose each other's index entries (final-review finding C2):");
{
  // Each saveSession/deleteSession does a read-modify-write of the WHOLE
  // index.json (read current entries, add/remove this one, write back).
  // Atomic rename makes any SINGLE write safe, but it does nothing for two
  // overlapping read-modify-write sequences for DIFFERENT session ids:
  // both read the same starting index, both independently add their own
  // entry, and whichever writes last wins — silently dropping the other's
  // entry. cloudSync.ts's reconcileSessions runs every session's sync
  // concurrently (Promise.all, by design, for speed), so this is a real,
  // frequently-hit path, not a hypothetical one.
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-sessions-concurrent-test-"));
  const COUNT = 8;
  const records = Array.from({ length: COUNT }, (_, i) => makeRecord(`concurrent-${i}`, `title ${i}`, 100 + i));
  await Promise.all(records.map((r) => saveSession(sessionsDir, r)));

  const indexed = await listSessions(sessionsDir);
  check(`all ${COUNT} concurrently-saved sessions are present in the index (got ${indexed.length})`, indexed.length === COUNT);
  for (const r of records) {
    check(`index includes ${r.id}`, indexed.some((e) => e.id === r.id));
  }
  // Every record file itself still exists on disk even if the index
  // temporarily disagreed — confirms this is purely an index-bookkeeping
  // race, not data loss of the records themselves.
  const filesOnDisk = (await fs.readdir(sessionsDir)).filter((f) => f.endsWith(".json") && f !== "index.json");
  check(`all ${COUNT} record files exist on disk regardless`, filesOnDisk.length === COUNT);
  await fs.rm(sessionsDir, { recursive: true, force: true });
}
{
  // Mirrors the "conflict copies become invisible" scenario from the
  // review: several conflict-preserving saves (reconcileSessions' own
  // conflict branch does two saveSession calls per conflicting session)
  // firing concurrently must not drop each other from the index either.
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-sessions-concurrent-conflict-test-"));
  const COUNT = 5;
  await Promise.all(
    Array.from({ length: COUNT }, (_, i) => async () => {
      await saveSession(sessionsDir, makeRecord(`original-${i}`, `original ${i}`, 100));
      await saveSession(sessionsDir, makeRecord(`original-${i}-conflict-${i}`, `conflict copy ${i}`, 100));
    }).map((fn) => fn())
  );
  const indexed = await listSessions(sessionsDir);
  check(`all ${COUNT * 2} sessions (originals + conflict copies) are present in the index (got ${indexed.length})`, indexed.length === COUNT * 2);
  await fs.rm(sessionsDir, { recursive: true, force: true });
}
{
  // Concurrent deletes must not lose each other's removals either — a
  // delete racing a save for a DIFFERENT session is the same class of bug.
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-sessions-concurrent-delete-test-"));
  const COUNT = 6;
  for (let i = 0; i < COUNT; i++) {
    await saveSession(sessionsDir, makeRecord(`todelete-${i}`, `title ${i}`, 100 + i));
  }
  await Promise.all(Array.from({ length: COUNT }, (_, i) => deleteSession(sessionsDir, `todelete-${i}`)));
  const indexed = await listSessions(sessionsDir);
  check("every concurrently-deleted session is actually gone from the index", indexed.length === 0);
  await fs.rm(sessionsDir, { recursive: true, force: true });
}

console.log("\nSession files are written with restrictive permissions (security audit M3 — a session's history can contain file contents the agent read, which may include secrets):");
if (process.platform !== "win32") {
  const modeTestDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-sessionstore-mode-test-"));
  await saveSession(modeTestDir, makeRecord("mode-test-1", "mode test", Date.now()));
  const recordStat = await fs.stat(path.join(modeTestDir, "mode-test-1.json"));
  const indexStat = await fs.stat(path.join(modeTestDir, "index.json"));
  check("the session record file is owner-only readable/writable (0600)", (recordStat.mode & 0o777) === 0o600);
  check("index.json is also owner-only readable/writable (0600)", (indexStat.mode & 0o777) === 0o600);
  await fs.rm(modeTestDir, { recursive: true, force: true });
} else {
  console.log("  (skipped: POSIX file-mode bits aren't meaningful on Windows)");
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
