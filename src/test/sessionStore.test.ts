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
  return { id, title, messages, events, createdAt: updatedAt, updatedAt, ...extra };
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

  await fs.rm(sessionsDir, { recursive: true, force: true });
}

await runTests();

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
