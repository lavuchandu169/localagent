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
  return { id, title, messages, events, createdAt: updatedAt, updatedAt, ownerEmail: null, ...extra };
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

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
