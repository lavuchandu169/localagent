# Session Save/Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sessions in the Electron app survive restarts — automatically saved, listed/searchable in a sidebar, and resumable with full model context (not a read-only transcript).

**Architecture:** A new pure, explicit-path storage module (`src/sessionStore.ts`, no Electron imports) persists one JSON file per session plus a lightweight index for fast listing. `AgentSession` gains an `initialMessages` seed and a `getMessages()` accessor. `sessionRegistry.ts` buffers each running session's events in memory and upserts the full record on every task's terminal `done` event; resuming reuses the original session's id rather than minting a new one, so revisiting never forks a duplicate sidebar entry. `main.ts`/`preload.cjs` expose four new IPC channels; the renderer gains a persistent left sidebar.

**Tech Stack:** `node:fs/promises` only — zero new npm dependencies. Existing `MockProvider`-based test patterns from `agent.test.ts`/`sessionRegistry.test.ts`.

**Spec:** `docs/superpowers/specs/2026-08-27-session-persistence-design.md`

## Global Constraints

- Zero new npm dependencies — `node:fs/promises` and `node:path` only for storage.
- `sessionStore.ts` takes `sessionsDir` as an explicit parameter to every function — never reads `app.getPath` internally — so it's unit-testable without a running Electron instance.
- Missing `sessionsDir`/`index.json` is never an error — treated as empty history (`mkdir -p` on write, `[]` on read).
- A corrupted individual session file makes `loadSessionRecord` return `null`, never throw. No thrown exception may cross the IPC boundary to the renderer for a load failure.
- A session with zero completed tasks is never persisted (no empty entries cluttering the sidebar).
- Title is set once, from the first task (truncated to 60 chars + `…` if longer), and never overwritten by later saves.
- Resuming a session reuses its original id — `startSession` accepts an optional override instead of always minting a fresh UUID.
- Search covers full transcript text (title + message content + status/text event content), not just titles — this fills a gap between the spec's Testing section (which requires search-across-files coverage) and its literal function list, which didn't name a search function; `searchSessions` is added to `sessionStore.ts` to close that gap.

---

### Task 1: `sessionStore.ts` — pure, explicit-path session storage

**Files:**
- Create: `src/sessionStore.ts`
- Test: `src/test/sessionStore.test.ts`
- Modify: `package.json:14` (test script)

**Interfaces:**
- Produces:
  - `interface SessionIndexEntry { id: string; title: string; updatedAt: number; }`
  - `interface SessionRecord { id: string; title: string; messages: ChatMessage[]; events: AgentEvent[]; createdAt: number; updatedAt: number; }`
  - `function listSessions(sessionsDir: string): Promise<SessionIndexEntry[]>`
  - `function searchSessions(sessionsDir: string, query: string): Promise<SessionIndexEntry[]>`
  - `function loadSessionRecord(sessionsDir: string, id: string): Promise<SessionRecord | null>`
  - `function saveSession(sessionsDir: string, record: SessionRecord): Promise<void>`
  - `function deleteSession(sessionsDir: string, id: string): Promise<void>`
  - `function rebuildIndex(sessionsDir: string): Promise<SessionIndexEntry[]>`

- [ ] **Step 1: Write the failing tests**

Create `src/test/sessionStore.test.ts`:

```typescript
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
  check("empty query returns everything", searchEmpty.length === indexAfterUpdate.length);

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc -p tsconfig.json && node dist/test/sessionStore.test.js`
Expected: FAIL (module `../sessionStore.js` does not exist / compile error)

- [ ] **Step 3: Write minimal implementation**

Create `src/sessionStore.ts`:

```typescript
import fs from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, AgentEvent } from "./types.js";

export interface SessionIndexEntry {
  id: string;
  title: string;
  updatedAt: number;
}

export interface SessionRecord {
  id: string;
  title: string;
  messages: ChatMessage[];
  events: AgentEvent[];
  createdAt: number;
  updatedAt: number;
}

function indexPath(sessionsDir: string): string {
  return path.join(sessionsDir, "index.json");
}

function recordPath(sessionsDir: string, id: string): string {
  return path.join(sessionsDir, `${id}.json`);
}

async function writeIndex(sessionsDir: string, entries: SessionIndexEntry[]): Promise<void> {
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(indexPath(sessionsDir), JSON.stringify(entries, null, 2), "utf-8");
}

/** Reconstructs index.json from the directory listing — used when the index is missing or corrupted. Any individual record file that also fails to parse is skipped, not fatal. */
export async function rebuildIndex(sessionsDir: string): Promise<SessionIndexEntry[]> {
  let files: string[];
  try {
    files = await fs.readdir(sessionsDir);
  } catch {
    return [];
  }

  const entries: SessionIndexEntry[] = [];
  for (const file of files) {
    if (file === "index.json" || !file.endsWith(".json")) continue;
    const id = file.slice(0, -".json".length);
    const record = await loadSessionRecord(sessionsDir, id);
    if (record) entries.push({ id: record.id, title: record.title, updatedAt: record.updatedAt });
  }
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  await writeIndex(sessionsDir, entries);
  return entries;
}

export async function listSessions(sessionsDir: string): Promise<SessionIndexEntry[]> {
  try {
    const raw = await fs.readFile(indexPath(sessionsDir), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return rebuildIndex(sessionsDir);
    const isValid = parsed.every(
      (e) =>
        !!e &&
        typeof e === "object" &&
        typeof (e as SessionIndexEntry).id === "string" &&
        typeof (e as SessionIndexEntry).title === "string" &&
        typeof (e as SessionIndexEntry).updatedAt === "number"
    );
    if (!isValid) return rebuildIndex(sessionsDir);
    return parsed as SessionIndexEntry[];
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    return rebuildIndex(sessionsDir);
  }
}

export async function loadSessionRecord(sessionsDir: string, id: string): Promise<SessionRecord | null> {
  try {
    const raw = await fs.readFile(recordPath(sessionsDir, id), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const r = parsed as Partial<SessionRecord>;
    if (
      typeof r.id !== "string" ||
      typeof r.title !== "string" ||
      !Array.isArray(r.messages) ||
      !Array.isArray(r.events) ||
      typeof r.createdAt !== "number" ||
      typeof r.updatedAt !== "number"
    ) {
      return null;
    }
    return { id: r.id, title: r.title, messages: r.messages, events: r.events, createdAt: r.createdAt, updatedAt: r.updatedAt };
  } catch {
    return null;
  }
}

export async function saveSession(sessionsDir: string, record: SessionRecord): Promise<void> {
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(recordPath(sessionsDir, record.id), JSON.stringify(record, null, 2), "utf-8");

  const entries = await listSessions(sessionsDir);
  const withoutThis = entries.filter((e) => e.id !== record.id);
  withoutThis.push({ id: record.id, title: record.title, updatedAt: record.updatedAt });
  withoutThis.sort((a, b) => b.updatedAt - a.updatedAt);
  await writeIndex(sessionsDir, withoutThis);
}

export async function deleteSession(sessionsDir: string, id: string): Promise<void> {
  await fs.rm(recordPath(sessionsDir, id), { force: true });
  const entries = await listSessions(sessionsDir);
  await writeIndex(
    sessionsDir,
    entries.filter((e) => e.id !== id)
  );
}

/** Full-transcript search: title, every message's content, and every text/status event's text — not just the title. */
export async function searchSessions(sessionsDir: string, query: string): Promise<SessionIndexEntry[]> {
  const entries = await listSessions(sessionsDir);
  const trimmed = query.trim();
  if (!trimmed) return entries;

  const lower = trimmed.toLowerCase();
  const matches: SessionIndexEntry[] = [];
  for (const entry of entries) {
    const record = await loadSessionRecord(sessionsDir, entry.id);
    if (!record) continue;
    const haystackParts = [record.title, ...record.messages.map((m) => m.content)];
    for (const event of record.events) {
      if (event.type === "text") haystackParts.push(event.text);
      else if (event.type === "status") haystackParts.push(event.message);
    }
    if (haystackParts.join("\n").toLowerCase().includes(lower)) matches.push(entry);
  }
  return matches;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc -p tsconfig.json && node dist/test/sessionStore.test.js`
Expected: PASS, all `check` lines print `ok`

- [ ] **Step 5: Wire the new test into `package.json`**

Current `test` script (`package.json:14`):

```json
    "test": "node dist/test/agent.test.js && node dist/test/sessionRegistry.test.js && node dist/test/modeLabels.test.js && node dist/test/hardwareInfo.test.js && node dist/test/filenameCandidates.test.js && node dist/test/anthropicProvider.test.js && node dist/test/googleAuth.test.js",
```

Change to:

```json
    "test": "node dist/test/agent.test.js && node dist/test/sessionRegistry.test.js && node dist/test/modeLabels.test.js && node dist/test/hardwareInfo.test.js && node dist/test/filenameCandidates.test.js && node dist/test/anthropicProvider.test.js && node dist/test/googleAuth.test.js && node dist/test/sessionStore.test.js",
```

- [ ] **Step 6: Run the full suite to confirm nothing else broke**

Run: `npm run build && npm test`
Expected: all 8 suites print `All tests passed.`

- [ ] **Step 7: Commit**

```bash
git add src/sessionStore.ts src/test/sessionStore.test.ts package.json
git commit -m "feat: add explicit-path session storage (save/load/list/search/delete)"
```

---

### Task 2: `AgentSession` — resumable message history

**Files:**
- Modify: `src/agent.ts:13-22` (interface), `src/agent.ts:41-53` (class fields/constructor)
- Test: `src/test/agent.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces:
  - `AgentSessionOptions` gains `initialMessages?: ChatMessage[]`
  - `AgentSession.getMessages(): ChatMessage[]` (returns a copy, not the live array)

- [ ] **Step 1: Write the failing test**

Add to `src/test/agent.test.ts`, after the existing "Auto-read named files before the first turn" block (after line 227's closing `})();`) and before "Read-before-write safety override:" (line 229):

```typescript
console.log("\nResumable message history:");
await (async () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const workspaceRoot = path.resolve(__dirname, "..", "..", "fixture-repo");

  const seeded: import("../types.js").ChatMessage[] = [
    { role: "system", content: "custom system prompt from a prior session" },
    { role: "user", content: "earlier task" },
    { role: "assistant", content: "earlier response" },
  ];

  const script: ChatResponse[] = [{ turn: { type: "final", content: "new answer" } }];
  const session = new AgentSession({
    workspaceRoot,
    model: "mock",
    provider: new MockProvider(script),
    tools: defaultToolRegistry(),
    permissionMode: "PLAN",
    initialMessages: seeded,
  });

  check(
    "getMessages returns the seeded initial messages before any run",
    JSON.stringify(session.getMessages()) === JSON.stringify(seeded)
  );

  const before = session.getMessages();
  for await (const _event of session.run("new task")) {
    // drain
  }
  const after = session.getMessages();

  check("getMessages grows from the seeded history, not from scratch", after.length > seeded.length);
  check(
    "the seeded turns are preserved in order at the start of the history",
    JSON.stringify(after.slice(0, seeded.length)) === JSON.stringify(seeded)
  );
  check("getMessages returns a copy, not the live array", before !== session.getMessages());

  const freshSession = new AgentSession({
    workspaceRoot,
    model: "mock",
    provider: new MockProvider([{ turn: { type: "final", content: "x" } }]),
    tools: defaultToolRegistry(),
    permissionMode: "PLAN",
  });
  check(
    "without initialMessages, a session still starts with just the system prompt",
    freshSession.getMessages().length === 1 && freshSession.getMessages()[0]?.role === "system"
  );
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc -p tsconfig.json && node dist/test/agent.test.js`
Expected: FAIL (`initialMessages` not a valid option / `getMessages` is not a function)

- [ ] **Step 3: Write minimal implementation**

In `src/agent.ts`, the current `AgentSessionOptions` interface (lines 13-22) reads:

```typescript
export interface AgentSessionOptions {
  workspaceRoot: string;
  model: string;
  provider: ModelProvider;
  tools: ToolRegistry;
  permissionMode: PermissionMode;
  maxTurns?: number;
  systemPrompt?: string;
  /** Called when a tool call needs ASK approval. Return true to allow. */
  onApprovalNeeded?: (call: ToolCall) => Promise<boolean>;
}
```

Change to:

```typescript
export interface AgentSessionOptions {
  workspaceRoot: string;
  model: string;
  provider: ModelProvider;
  tools: ToolRegistry;
  permissionMode: PermissionMode;
  maxTurns?: number;
  systemPrompt?: string;
  /** Seeds the conversation from a prior session's history instead of starting fresh with just the system prompt — used to resume a saved session. */
  initialMessages?: ChatMessage[];
  /** Called when a tool call needs ASK approval. Return true to allow. */
  onApprovalNeeded?: (call: ToolCall) => Promise<boolean>;
}
```

The current constructor (lines 50-53) reads:

```typescript
  constructor(private opts: AgentSessionOptions) {
    this.permissions = new PermissionEngine(opts.permissionMode);
    this.messages.push({ role: "system", content: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT });
  }
```

Change to:

```typescript
  constructor(private opts: AgentSessionOptions) {
    this.permissions = new PermissionEngine(opts.permissionMode);
    if (opts.initialMessages && opts.initialMessages.length > 0) {
      this.messages = [...opts.initialMessages];
    } else {
      this.messages.push({ role: "system", content: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT });
    }
  }

  /** A copy of the current conversation history, safe to persist or inspect without risking mutation of the live session. */
  getMessages(): ChatMessage[] {
    return [...this.messages];
  }
```

Add `getMessages()` directly after the constructor, before `cancel()` (current line 55).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc -p tsconfig.json && node dist/test/agent.test.js`
Expected: PASS, all `check` lines print `ok`

- [ ] **Step 5: Run the full suite**

Run: `npm run build && npm test`
Expected: all 8 suites print `All tests passed.`

- [ ] **Step 6: Commit**

```bash
git add src/agent.ts src/test/agent.test.ts
git commit -m "feat: allow AgentSession to resume from a prior message history"
```

---

### Task 3: `sessionRegistry.ts` — event buffering, persistence hook, resume-by-id

**Files:**
- Modify: `src/electron/sessionRegistry.ts` (full file — see below for exact current content and required changes)
- Modify: `src/test/sessionRegistry.test.ts`

**Interfaces:**
- Consumes: `saveSession`, `loadSessionRecord`, `deleteSession`, `type SessionRecord` (Task 1, from `../sessionStore.js`); `AgentSession`'s `initialMessages` option and `getMessages()` (Task 2)
- Produces:
  - `interface SessionRegistry { sessions: Map<string, SessionEntry>; sessionsDir: string; }`
  - `function createSessionRegistry(sessionsDir: string): SessionRegistry` (signature changed — now requires `sessionsDir`)
  - `interface ResumePayload { sessionId: string; initialMessages: ChatMessage[]; priorEvents: AgentEvent[]; title: string; createdAt: number; }`
  - `startSession`'s `deps` gains `resume?: ResumePayload`
  - `function removeSession(registry: SessionRegistry, sessionId: string): Promise<void>` (deletes the persisted record; if the session is currently live, cancels it and prevents it from resurrecting the record on its next terminal event)

The current full content of `src/electron/sessionRegistry.ts` is:

```typescript
import crypto from "node:crypto";
import os from "node:os";
import { AgentSession } from "../agent.js";
import { defaultToolRegistry } from "../toolRegistry.js";
import { OpenAICompatibleProvider } from "../providers/openaiCompatible.js";
import { EmbeddedLlamaProvider } from "../providers/embeddedLlama.js";
import { AnthropicProvider } from "../providers/anthropicProvider.js";
import { isEmbeddedModelSize } from "../models.js";
import type { AgentEvent, ModelProvider, PermissionMode } from "../types.js";

export type ProviderConfig =
  | { kind: "openai-compatible"; baseUrl: string; model: string }
  | { kind: "embedded"; size: string }
  | { kind: "anthropic" };

export interface SessionConfig {
  /** Omit to chat without file access — defaults to the home directory. */
  workspaceRoot?: string;
  provider: ProviderConfig;
  mode: PermissionMode;
}

export type ModelDownloadProgress = { totalSize: number; downloadedSize: number };

interface SessionEntry {
  session: AgentSession;
  pendingApprovals: Map<string, (approved: boolean) => void>;
}

export interface SessionRegistry {
  sessions: Map<string, SessionEntry>;
}

export function createSessionRegistry(): SessionRegistry {
  return { sessions: new Map() };
}

/** Mirrors the provider construction in cli.ts's --base-url branch. */
export function buildProvider(config: ProviderConfig, onDownloadProgress?: (status: ModelDownloadProgress) => void): ModelProvider {
  if (config.kind === "openai-compatible") {
    return new OpenAICompatibleProvider({ baseUrl: config.baseUrl, local: true });
  }
  if (config.kind === "anthropic") {
    return new AnthropicProvider();
  }
  if (!isEmbeddedModelSize(config.size)) {
    throw new Error(`Invalid embedded model size: ${config.size}`);
  }
  return new EmbeddedLlamaProvider({ size: config.size, onDownloadProgress });
}

export async function startSession(
  registry: SessionRegistry,
  config: SessionConfig,
  deps: {
    providerFactory?: (c: ProviderConfig, onDownloadProgress?: (status: ModelDownloadProgress) => void) => ModelProvider;
    onDownloadProgress?: (status: ModelDownloadProgress) => void;
  } = {}
): Promise<{ sessionId: string; workspaceRoot: string }> {
  const provider = (deps.providerFactory ?? buildProvider)(config.provider, deps.onDownloadProgress);
  const healthy = await provider.healthCheck();
  if (!healthy) {
    throw new Error(`Could not start provider "${provider.id}" — health check failed.`);
  }

  const sessionId = crypto.randomUUID();
  const pendingApprovals = new Map<string, (approved: boolean) => void>();
  const workspaceRoot = config.workspaceRoot ?? os.homedir();

  const session = new AgentSession({
    workspaceRoot,
    model:
      config.provider.kind === "openai-compatible"
        ? config.provider.model
        : config.provider.kind === "anthropic"
          ? "claude-sonnet-5"
          : config.provider.size,
    provider,
    tools: defaultToolRegistry(),
    permissionMode: config.mode,
    onApprovalNeeded: (call) =>
      new Promise<boolean>((resolve) => {
        pendingApprovals.set(call.id, resolve);
      }),
  });

  registry.sessions.set(sessionId, { session, pendingApprovals });
  return { sessionId, workspaceRoot };
}

export async function runTask(
  registry: SessionRegistry,
  sessionId: string,
  task: string,
  onEvent: (event: AgentEvent) => void
): Promise<void> {
  const entry = registry.sessions.get(sessionId);
  if (!entry) throw new Error(`Unknown session: ${sessionId}`);

  try {
    for await (const event of entry.session.run(task)) {
      onEvent(event);
    }
  } catch (err: any) {
    onEvent({ type: "error", message: `Unexpected session error: ${err.message}` });
    onEvent({ type: "done", success: false, summary: "Unexpected error." });
  }
}

/** No-op on an unknown session/callId — the renderer may race a stale click against a session that already moved on. */
export function respondPermission(registry: SessionRegistry, sessionId: string, callId: string, approved: boolean): void {
  const entry = registry.sessions.get(sessionId);
  if (!entry) return;
  const resolve = entry.pendingApprovals.get(callId);
  if (!resolve) return;
  entry.pendingApprovals.delete(callId);
  resolve(approved);
}

/** Cooperative: agent.ts checks the cancelled flag at loop boundaries, not mid-await. */
export function cancelSession(registry: SessionRegistry, sessionId: string): void {
  registry.sessions.get(sessionId)?.session.cancel();
}
```

- [ ] **Step 1: Write the failing tests**

The existing `src/test/sessionRegistry.test.ts` calls `createSessionRegistry()` with no arguments 9 times. Since its signature is changing to require `sessionsDir`, first add a shared temp directory at the top of the file and update every call site.

The current top of the file reads:

```typescript
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  createSessionRegistry,
  startSession,
  runTask,
  respondPermission,
  cancelSession,
  buildProvider,
} from "../electron/sessionRegistry.js";
import { MockProvider } from "../providers/mockProvider.js";
import type { AgentEvent, ChatResponse } from "../types.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, "..", "..", "fixture-repo");

console.log("Session registry:");

await (async () => {
```

Change to:

```typescript
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createSessionRegistry,
  startSession,
  runTask,
  respondPermission,
  cancelSession,
  removeSession,
  buildProvider,
} from "../electron/sessionRegistry.js";
import { MockProvider } from "../providers/mockProvider.js";
import { loadSessionRecord } from "../sessionStore.js";
import type { AgentEvent, ChatResponse } from "../types.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, "..", "..", "fixture-repo");
const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-registry-test-"));

console.log("Session registry:");

await (async () => {
```

Then, throughout the rest of the file, replace every `createSessionRegistry()` call with `createSessionRegistry(sessionsDir)` (9 occurrences — a plain find-and-replace, the argument is identical at every call site since they all share the one temp directory).

At the very end of the file, immediately before the existing final lines:

```typescript
console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
```

Insert a new block (after the last existing test block, before those two lines):

```typescript
console.log("\nEvent buffering and persistence:");
await (async () => {
  const registry = createSessionRegistry(sessionsDir);
  // Multi-turn: a tool_calls turn (list_directory) followed by a final turn —
  // exercises that events accumulate across every turn of one task, not just
  // the last one.
  const script: ChatResponse[] = [
    { turn: { type: "tool_calls", toolCalls: [{ id: "t1", name: "list_directory", arguments: { path: "." } }] } },
    { turn: { type: "final", content: "the answer" } },
  ];
  const { sessionId } = await startSession(
    registry,
    { workspaceRoot, provider: { kind: "embedded", size: "small" }, mode: "PLAN" },
    { providerFactory: () => new MockProvider(script) }
  );

  const streamed: AgentEvent[] = [];
  await runTask(registry, sessionId, "what does math.js do", (e) => streamed.push(e));

  check("the multi-turn task produced more than one event", streamed.length > 1);
  check("a tool.start event was emitted for the tool_calls turn", streamed.some((e) => e.type === "tool.start"));
  check("a tool.result event was emitted for the tool_calls turn", streamed.some((e) => e.type === "tool.result"));

  const entry = registry.sessions.get(sessionId);
  check("events accumulate in the registry entry across every turn of the run", (entry?.events.length ?? 0) === streamed.length);

  const record = await loadSessionRecord(sessionsDir, sessionId);
  check("a completed task persists a session record", record !== null);
  check("the persisted title is the truncated first task", record?.title === "what does math.js do");
  check("the persisted events match what streamed to the renderer", JSON.stringify(record?.events) === JSON.stringify(streamed));

  await runTask(registry, sessionId, "a second task", () => {});
  const recordAfterSecond = await loadSessionRecord(sessionsDir, sessionId);
  check("title is set once and not overwritten by a later task", recordAfterSecond?.title === "what does math.js do");
  check(
    "events keep accumulating across multiple tasks",
    (recordAfterSecond?.events.length ?? 0) > (record?.events.length ?? 0)
  );
})();

console.log("\nResume reuses the original session id:");
await (async () => {
  const registry = createSessionRegistry(sessionsDir);
  const script: ChatResponse[] = [{ turn: { type: "final", content: "continuing" } }];
  const fixedId = "resume-test-fixed-id";
  const { sessionId } = await startSession(
    registry,
    { workspaceRoot, provider: { kind: "embedded", size: "small" }, mode: "PLAN" },
    {
      providerFactory: () => new MockProvider(script),
      resume: {
        sessionId: fixedId,
        initialMessages: [{ role: "system", content: "sys" }, { role: "user", content: "earlier" }],
        priorEvents: [{ type: "text", text: "earlier response" }],
        title: "earlier task title",
        createdAt: 12345,
      },
    }
  );

  check("resume reuses the provided sessionId instead of minting a new one", sessionId === fixedId);
  check("the registry entry starts seeded with the prior events", registry.sessions.get(fixedId)?.events.length === 1);

  await runTask(registry, fixedId, "continued task", () => {});
  const record = await loadSessionRecord(sessionsDir, fixedId);
  check("resumed session's persisted record keeps the original title", record?.title === "earlier task title");
  check("resumed session's persisted record keeps the original createdAt", record?.createdAt === 12345);
  check(
    "resumed session's persisted events include both the prior transcript and the new task's events",
    (record?.events.length ?? 0) > 1
  );
})();

console.log("\nDelete prevents resurrection of an active session:");
await (async () => {
  const registry = createSessionRegistry(sessionsDir);
  const script: ChatResponse[] = [{ turn: { type: "final", content: "first" } }, { turn: { type: "final", content: "second" } }];
  const { sessionId } = await startSession(
    registry,
    { workspaceRoot, provider: { kind: "embedded", size: "small" }, mode: "PLAN" },
    { providerFactory: () => new MockProvider(script) }
  );
  await runTask(registry, sessionId, "first task", () => {});
  check("a record exists before deletion", (await loadSessionRecord(sessionsDir, sessionId)) !== null);

  // Race: delete while a second task is still in flight.
  const runPromise = runTask(registry, sessionId, "second task", () => {});
  await removeSession(registry, sessionId);
  await runPromise;

  const record = await loadSessionRecord(sessionsDir, sessionId);
  check("deleting an active session removes its record", record === null);
  check(
    "an in-flight task's terminal event does not resurrect a deleted record",
    (await loadSessionRecord(sessionsDir, sessionId)) === null
  );
})();

await fs.rm(sessionsDir, { recursive: true, force: true });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc -p tsconfig.json && node dist/test/sessionRegistry.test.js`
Expected: FAIL (`createSessionRegistry` requires an argument / `removeSession` not exported / `entry.events` doesn't exist)

- [ ] **Step 3: Write minimal implementation**

Replace the full content of `src/electron/sessionRegistry.ts` with:

```typescript
import crypto from "node:crypto";
import os from "node:os";
import { AgentSession } from "../agent.js";
import { defaultToolRegistry } from "../toolRegistry.js";
import { OpenAICompatibleProvider } from "../providers/openaiCompatible.js";
import { EmbeddedLlamaProvider } from "../providers/embeddedLlama.js";
import { AnthropicProvider } from "../providers/anthropicProvider.js";
import { isEmbeddedModelSize } from "../models.js";
import { saveSession, deleteSession } from "../sessionStore.js";
import type { AgentEvent, ChatMessage, ModelProvider, PermissionMode } from "../types.js";

export type ProviderConfig =
  | { kind: "openai-compatible"; baseUrl: string; model: string }
  | { kind: "embedded"; size: string }
  | { kind: "anthropic" };

export interface SessionConfig {
  /** Omit to chat without file access — defaults to the home directory. */
  workspaceRoot?: string;
  provider: ProviderConfig;
  mode: PermissionMode;
}

export type ModelDownloadProgress = { totalSize: number; downloadedSize: number };

/** Everything needed to resume a previously-saved session with full context, reusing its original id. */
export interface ResumePayload {
  sessionId: string;
  initialMessages: ChatMessage[];
  priorEvents: AgentEvent[];
  title: string;
  createdAt: number;
}

interface SessionEntry {
  session: AgentSession;
  pendingApprovals: Map<string, (approved: boolean) => void>;
  events: AgentEvent[];
  title: string | null;
  createdAt: number;
  deleted: boolean;
}

export interface SessionRegistry {
  sessions: Map<string, SessionEntry>;
  sessionsDir: string;
}

export function createSessionRegistry(sessionsDir: string): SessionRegistry {
  return { sessions: new Map(), sessionsDir };
}

/** Mirrors the provider construction in cli.ts's --base-url branch. */
export function buildProvider(config: ProviderConfig, onDownloadProgress?: (status: ModelDownloadProgress) => void): ModelProvider {
  if (config.kind === "openai-compatible") {
    return new OpenAICompatibleProvider({ baseUrl: config.baseUrl, local: true });
  }
  if (config.kind === "anthropic") {
    return new AnthropicProvider();
  }
  if (!isEmbeddedModelSize(config.size)) {
    throw new Error(`Invalid embedded model size: ${config.size}`);
  }
  return new EmbeddedLlamaProvider({ size: config.size, onDownloadProgress });
}

export async function startSession(
  registry: SessionRegistry,
  config: SessionConfig,
  deps: {
    providerFactory?: (c: ProviderConfig, onDownloadProgress?: (status: ModelDownloadProgress) => void) => ModelProvider;
    onDownloadProgress?: (status: ModelDownloadProgress) => void;
    resume?: ResumePayload;
  } = {}
): Promise<{ sessionId: string; workspaceRoot: string }> {
  const provider = (deps.providerFactory ?? buildProvider)(config.provider, deps.onDownloadProgress);
  const healthy = await provider.healthCheck();
  if (!healthy) {
    throw new Error(`Could not start provider "${provider.id}" — health check failed.`);
  }

  const sessionId = deps.resume?.sessionId ?? crypto.randomUUID();
  const pendingApprovals = new Map<string, (approved: boolean) => void>();
  const workspaceRoot = config.workspaceRoot ?? os.homedir();

  const session = new AgentSession({
    workspaceRoot,
    model:
      config.provider.kind === "openai-compatible"
        ? config.provider.model
        : config.provider.kind === "anthropic"
          ? "claude-sonnet-5"
          : config.provider.size,
    provider,
    tools: defaultToolRegistry(),
    permissionMode: config.mode,
    initialMessages: deps.resume?.initialMessages,
    onApprovalNeeded: (call) =>
      new Promise<boolean>((resolve) => {
        pendingApprovals.set(call.id, resolve);
      }),
  });

  registry.sessions.set(sessionId, {
    session,
    pendingApprovals,
    events: deps.resume ? [...deps.resume.priorEvents] : [],
    title: deps.resume?.title ?? null,
    createdAt: deps.resume?.createdAt ?? Date.now(),
    deleted: false,
  });
  return { sessionId, workspaceRoot };
}

async function persistSession(registry: SessionRegistry, sessionId: string, entry: SessionEntry): Promise<void> {
  if (entry.deleted) return;
  await saveSession(registry.sessionsDir, {
    id: sessionId,
    title: entry.title ?? "(untitled)",
    messages: entry.session.getMessages(),
    events: entry.events,
    createdAt: entry.createdAt,
    updatedAt: Date.now(),
  });
}

export async function runTask(
  registry: SessionRegistry,
  sessionId: string,
  task: string,
  onEvent: (event: AgentEvent) => void
): Promise<void> {
  const entry = registry.sessions.get(sessionId);
  if (!entry) throw new Error(`Unknown session: ${sessionId}`);

  if (entry.title === null) {
    entry.title = task.length > 60 ? `${task.slice(0, 60)}…` : task;
  }

  try {
    // Persisting on "done" alone (not "error") is deliberate, not a gap:
    // every exit path in agent.ts's run() — success, turn-budget exceeded,
    // or a provider error — always yields "done" as its final event, with
    // "error" (when present) yielded immediately before it. Persisting on
    // both would just save the same final state twice.
    for await (const event of entry.session.run(task)) {
      entry.events.push(event);
      onEvent(event);
      if (event.type === "done") {
        await persistSession(registry, sessionId, entry);
      }
    }
  } catch (err: any) {
    const errorEvent: AgentEvent = { type: "error", message: `Unexpected session error: ${err.message}` };
    const doneEvent: AgentEvent = { type: "done", success: false, summary: "Unexpected error." };
    entry.events.push(errorEvent, doneEvent);
    onEvent(errorEvent);
    onEvent(doneEvent);
    await persistSession(registry, sessionId, entry);
  }
}

/** No-op on an unknown session/callId — the renderer may race a stale click against a session that already moved on. */
export function respondPermission(registry: SessionRegistry, sessionId: string, callId: string, approved: boolean): void {
  const entry = registry.sessions.get(sessionId);
  if (!entry) return;
  const resolve = entry.pendingApprovals.get(callId);
  if (!resolve) return;
  entry.pendingApprovals.delete(callId);
  resolve(approved);
}

/** Cooperative: agent.ts checks the cancelled flag at loop boundaries, not mid-await. */
export function cancelSession(registry: SessionRegistry, sessionId: string): void {
  registry.sessions.get(sessionId)?.session.cancel();
}

/**
 * Deletes the persisted record and, if the session is currently live, cancels
 * it and marks it deleted so an in-flight task's terminal event can't
 * resurrect the record by saving right after this delete completes.
 */
export async function removeSession(registry: SessionRegistry, sessionId: string): Promise<void> {
  const entry = registry.sessions.get(sessionId);
  if (entry) {
    entry.deleted = true;
    entry.session.cancel();
  }
  await deleteSession(registry.sessionsDir, sessionId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc -p tsconfig.json && node dist/test/sessionRegistry.test.js`
Expected: PASS, all `check` lines print `ok`

- [ ] **Step 5: Run the full suite**

Run: `npm run build && npm test`
Expected: all 8 suites print `All tests passed.`

- [ ] **Step 6: Commit**

```bash
git add src/electron/sessionRegistry.ts src/test/sessionRegistry.test.ts
git commit -m "feat: buffer session events, persist on completion, support resume-by-id"
```

---

### Task 4: IPC wiring — `main.ts` and `preload.cjs`

**Files:**
- Modify: `src/electron/main.ts` (full file — see below)
- Modify: `src/electron/preload.cjs` (full file — see below)

**Interfaces:**
- Consumes: `listSessions`, `searchSessions`, `loadSessionRecord` (Task 1, from `../sessionStore.js`); `createSessionRegistry(sessionsDir)`, `removeSession`, `type ResumePayload` (Task 3, from `./sessionRegistry.js`)
- Produces: IPC channels `agent:list-sessions`, `agent:search-sessions`, `agent:load-session`, `agent:delete-session`; extended `agent:start-session` (now accepts an optional second argument); matching `preload.cjs` bridge methods `listSessions()`, `searchSessions(query)`, `loadSession(id)`, `deleteSession(id)`, and an updated `startSession(config, resume)` — consumed by Task 5.

- [ ] **Step 1: Replace `src/electron/main.ts`**

The current full content is:

```typescript
import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionRegistry, startSession, runTask, respondPermission, cancelSession } from "./sessionRegistry.js";
import type { SessionConfig } from "./sessionRegistry.js";
import { checkCachedModels } from "./modelCache.js";
import { detectHardware, recommendModelSize } from "./hardwareInfo.js";
import { signInWithGoogle, signOut, getAuthStatus } from "./googleAuth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const registry = createSessionRegistry();

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1000,
    height: 720,
    backgroundColor: "#14181c",
    icon: path.join(__dirname, "renderer", "icon-512.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  return win;
}

app.whenReady().then(() => {
  const authFilePath = path.join(app.getPath("userData"), "auth.json");
  const win = createWindow();

  ipcMain.handle("agent:start-session", (event, config: SessionConfig) =>
    startSession(registry, config, {
      onDownloadProgress: (status) => event.sender.send("agent:model-progress", status),
    })
  );

  ipcMain.handle("agent:run-task", (event, sessionId: string, task: string) =>
    runTask(registry, sessionId, task, (agentEvent) => {
      event.sender.send("agent:event", sessionId, agentEvent);
    })
  );

  ipcMain.handle("agent:respond-permission", (_event, sessionId: string, callId: string, approved: boolean) =>
    respondPermission(registry, sessionId, callId, approved)
  );

  ipcMain.handle("agent:cancel-session", (_event, sessionId: string) => cancelSession(registry, sessionId));

  ipcMain.handle("agent:list-cached-models", () => checkCachedModels());

  ipcMain.handle("agent:hardware-info", async () => {
    const info = await detectHardware();
    return { ...info, recommended: recommendModelSize(info) };
  });

  ipcMain.handle("agent:pick-workspace", async () => {
    const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });
  ipcMain.handle("agent:google-sign-in", () =>
    signInWithGoogle(process.env.GOOGLE_OAUTH_CLIENT_ID ?? "", authFilePath, process.env.GOOGLE_OAUTH_CLIENT_SECRET)
  );
  ipcMain.handle("agent:sign-out", () => signOut(authFilePath));
  ipcMain.handle("agent:auth-status", () =>
    getAuthStatus(authFilePath, process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET)
  );
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
```

Replace it with:

```typescript
import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionRegistry, startSession, runTask, respondPermission, cancelSession, removeSession } from "./sessionRegistry.js";
import type { SessionConfig, ResumePayload } from "./sessionRegistry.js";
import { checkCachedModels } from "./modelCache.js";
import { detectHardware, recommendModelSize } from "./hardwareInfo.js";
import { signInWithGoogle, signOut, getAuthStatus } from "./googleAuth.js";
import { listSessions, searchSessions, loadSessionRecord } from "../sessionStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1000,
    height: 720,
    backgroundColor: "#14181c",
    icon: path.join(__dirname, "renderer", "icon-512.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  return win;
}

app.whenReady().then(() => {
  const authFilePath = path.join(app.getPath("userData"), "auth.json");
  const sessionsDir = path.join(app.getPath("userData"), "sessions");
  const registry = createSessionRegistry(sessionsDir);
  const win = createWindow();

  ipcMain.handle("agent:start-session", (event, config: SessionConfig, resume?: ResumePayload) =>
    startSession(registry, config, {
      onDownloadProgress: (status) => event.sender.send("agent:model-progress", status),
      resume,
    })
  );

  ipcMain.handle("agent:run-task", (event, sessionId: string, task: string) =>
    runTask(registry, sessionId, task, (agentEvent) => {
      event.sender.send("agent:event", sessionId, agentEvent);
    })
  );

  ipcMain.handle("agent:respond-permission", (_event, sessionId: string, callId: string, approved: boolean) =>
    respondPermission(registry, sessionId, callId, approved)
  );

  ipcMain.handle("agent:cancel-session", (_event, sessionId: string) => cancelSession(registry, sessionId));

  ipcMain.handle("agent:list-cached-models", () => checkCachedModels());

  ipcMain.handle("agent:hardware-info", async () => {
    const info = await detectHardware();
    return { ...info, recommended: recommendModelSize(info) };
  });

  ipcMain.handle("agent:pick-workspace", async () => {
    const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });
  ipcMain.handle("agent:google-sign-in", () =>
    signInWithGoogle(process.env.GOOGLE_OAUTH_CLIENT_ID ?? "", authFilePath, process.env.GOOGLE_OAUTH_CLIENT_SECRET)
  );
  ipcMain.handle("agent:sign-out", () => signOut(authFilePath));
  ipcMain.handle("agent:auth-status", () =>
    getAuthStatus(authFilePath, process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET)
  );
  ipcMain.handle("agent:list-sessions", () => listSessions(sessionsDir));
  ipcMain.handle("agent:search-sessions", (_event, query: string) => searchSessions(sessionsDir, query));
  ipcMain.handle("agent:load-session", (_event, id: string) => loadSessionRecord(sessionsDir, id));
  ipcMain.handle("agent:delete-session", (_event, id: string) => removeSession(registry, id));
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
```

- [ ] **Step 2: Replace `src/electron/preload.cjs`**

The current full content is:

```javascript
// Hand-written CommonJS, not compiled from TypeScript: Electron's sandboxed
// preload context is the one place ESM support is still inconsistent, and
// this file is small enough that hand-authoring sidesteps the issue
// entirely. Exposes a narrow bridge — the renderer never gets raw
// ipcRenderer or require (contextIsolation: true, nodeIntegration: false).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agent", {
  startSession: (config) => ipcRenderer.invoke("agent:start-session", config),
  runTask: (sessionId, task) => ipcRenderer.invoke("agent:run-task", sessionId, task),
  respondPermission: (sessionId, callId, approved) =>
    ipcRenderer.invoke("agent:respond-permission", sessionId, callId, approved),
  cancelSession: (sessionId) => ipcRenderer.invoke("agent:cancel-session", sessionId),
  pickWorkspace: () => ipcRenderer.invoke("agent:pick-workspace"),
  listCachedModels: () => ipcRenderer.invoke("agent:list-cached-models"),
  getHardwareInfo: () => ipcRenderer.invoke("agent:hardware-info"),
  onEvent: (callback) => {
    const listener = (_event, sessionId, agentEvent) => callback(sessionId, agentEvent);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
  onDownloadProgress: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("agent:model-progress", listener);
    return () => ipcRenderer.removeListener("agent:model-progress", listener);
  },
  googleSignIn: () => ipcRenderer.invoke("agent:google-sign-in"),
  signOut: () => ipcRenderer.invoke("agent:sign-out"),
  getAuthStatus: () => ipcRenderer.invoke("agent:auth-status"),
});
```

Replace it with:

```javascript
// Hand-written CommonJS, not compiled from TypeScript: Electron's sandboxed
// preload context is the one place ESM support is still inconsistent, and
// this file is small enough that hand-authoring sidesteps the issue
// entirely. Exposes a narrow bridge — the renderer never gets raw
// ipcRenderer or require (contextIsolation: true, nodeIntegration: false).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agent", {
  startSession: (config, resume) => ipcRenderer.invoke("agent:start-session", config, resume),
  runTask: (sessionId, task) => ipcRenderer.invoke("agent:run-task", sessionId, task),
  respondPermission: (sessionId, callId, approved) =>
    ipcRenderer.invoke("agent:respond-permission", sessionId, callId, approved),
  cancelSession: (sessionId) => ipcRenderer.invoke("agent:cancel-session", sessionId),
  pickWorkspace: () => ipcRenderer.invoke("agent:pick-workspace"),
  listCachedModels: () => ipcRenderer.invoke("agent:list-cached-models"),
  getHardwareInfo: () => ipcRenderer.invoke("agent:hardware-info"),
  onEvent: (callback) => {
    const listener = (_event, sessionId, agentEvent) => callback(sessionId, agentEvent);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
  onDownloadProgress: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("agent:model-progress", listener);
    return () => ipcRenderer.removeListener("agent:model-progress", listener);
  },
  googleSignIn: () => ipcRenderer.invoke("agent:google-sign-in"),
  signOut: () => ipcRenderer.invoke("agent:sign-out"),
  getAuthStatus: () => ipcRenderer.invoke("agent:auth-status"),
  listSessions: () => ipcRenderer.invoke("agent:list-sessions"),
  searchSessions: (query) => ipcRenderer.invoke("agent:search-sessions", query),
  loadSession: (id) => ipcRenderer.invoke("agent:load-session", id),
  deleteSession: (id) => ipcRenderer.invoke("agent:delete-session", id),
});
```

- [ ] **Step 3: Compile to verify no type errors**

Run: `npx tsc -p tsconfig.json`
Expected: compiles cleanly, no errors. (No automated test for this task — Electron IPC wiring isn't unit-testable without a running Electron instance, same documented gap as the rest of the app's IPC layer.)

- [ ] **Step 4: Commit**

```bash
git add src/electron/main.ts src/electron/preload.cjs
git commit -m "feat: wire session list/search/load/delete and resume over IPC"
```

---

### Task 5: Renderer — sidebar UI, resume flow, README

**Files:**
- Modify: `src/electron/renderer/index.html` (full file — see below)
- Modify: `src/electron/renderer/styles.css:86-96` (the `body` rule) plus a new insertion after it
- Modify: `src/electron/renderer/renderer.ts` (full file — see below)
- Modify: `README.md`

**Interfaces:**
- Consumes: `window.agent.listSessions()`, `window.agent.searchSessions(query)`, `window.agent.loadSession(id)`, `window.agent.deleteSession(id)`, updated `window.agent.startSession(config, resume?)` (Task 4)
- Produces: no new exports (leaf UI task)

- [ ] **Step 1: Replace `src/electron/renderer/index.html`**

The current full content is:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>localagent</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <header id="app-header">
      <div id="brand">
        <svg id="brand-mark" viewBox="0 0 100 100" aria-hidden="true">
          <rect x="2" y="2" width="96" height="96" rx="22" fill="#F5F3EC" stroke="#E4E0D3" stroke-width="2" />
          <rect x="24" y="24" width="52" height="52" rx="12" fill="none" stroke="#C15F3C" stroke-width="3" opacity="0.55" />
          <circle cx="50" cy="50" r="11" fill="#C15F3C" />
        </svg>
        <span id="brand-name">localagent</span>
      </div>
      <div id="header-right">
        <div id="auth-control">
          <div id="auth-signed-out" class="row">
            <button id="google-sign-in">Sign in with Google</button>
            <button id="apple-sign-in" disabled title="Coming soon — needs an Apple Developer account and a registered domain">Sign in with Apple</button>
          </div>
          <div id="auth-signed-in" class="row" hidden>
            <span id="auth-avatar"></span>
            <span id="auth-name"></span>
            <button id="sign-out-btn">Sign out</button>
          </div>
          <div id="auth-error" class="error-text"></div>
        </div>
        <button id="about-toggle" aria-expanded="false" title="About">?</button>
      </div>
    </header>

    <div id="about-panel" hidden>
      <p>A local-first coding agent. Everything — the model, the file access, the shell commands — runs on this machine. Nothing is sent anywhere else, except an optional Google sign-in, which talks to Google's servers to confirm who you are.</p>
      <dl>
        <dt>Embedded model cache</dt>
        <dd>~/.node-llama-cpp/models</dd>
        <dt>Workspace</dt>
        <dd id="about-workspace">(none selected)</dd>
        <dt>Your machine</dt>
        <dd id="about-hardware">Detecting…</dd>
      </dl>
      <button id="about-close">Close</button>
    </div>

    <section id="setup">
      <div class="row">
        <button id="choose-workspace">Choose workspace…</button>
        <span id="workspace-path">No workspace selected — optional, you can just chat</span>
      </div>

      <div id="embedded-fields" class="row">
        <label>
          Model size
          <select id="embedded-size">
            <option value="small">Small — fastest, lowest memory</option>
            <option value="medium">Medium — better quality</option>
            <option value="large">Large — best quality, needs a capable machine</option>
          </select>
        </label>
      </div>

      <details id="advanced-disclosure">
        <summary>Advanced: use a different provider</summary>
        <div class="row">
          <label class="radio-label">
            <input type="radio" name="advanced-provider" id="advanced-provider-external" value="external" checked />
            External server
          </label>
          <label class="radio-label">
            <input type="radio" name="advanced-provider" id="advanced-provider-anthropic" value="anthropic" />
            Claude API (Sonnet 5)
          </label>
        </div>
        <div id="external-fields" class="row">
          <label>
            Base URL
            <input id="base-url" type="text" placeholder="http://localhost:11434/v1" />
          </label>
          <label>
            Model
            <input id="external-model" type="text" placeholder="qwen2.5-coder:latest" />
          </label>
        </div>
        <div id="anthropic-fields" class="row" hidden>
          <span class="hint-text">Sends file contents and task context to Anthropic over the network. Needs <code>ANTHROPIC_API_KEY</code> set in your environment (or <code>ant auth login</code>) — no key is entered here.</span>
        </div>
      </details>

      <div class="row">
        <label>
          Mode
          <select id="mode"></select>
        </label>
        <span id="mode-description" class="hint-text"></span>
      </div>

      <div class="row">
        <button id="start-session" class="primary">Start session</button>
        <div id="start-error" class="error-text"></div>
      </div>

      <div id="download-progress" class="row" hidden>
        <div id="download-bar-track">
          <div id="download-bar-fill"></div>
        </div>
        <span id="download-label"></span>
      </div>
    </section>

    <section id="run">
      <div id="active-model-badge" hidden></div>
      <div class="row">
        <textarea id="task-input" placeholder="Describe the task…" disabled></textarea>
        <button id="run-task" class="primary" disabled>Run</button>
      </div>
      <div id="task-input-hint" class="hint-text">Enter to run · Shift+Enter for a new line</div>
    </section>

    <section id="log-section">
      <div id="event-log">
        <div id="empty-state">Start a session, then describe a task — every read, edit, and command the agent runs will show up here.</div>
      </div>
    </section>

    <script type="module" src="./renderer.js"></script>
  </body>
</html>
```

Replace it with (the only change is wrapping everything from `<header id="app-header">` through `</section>` for `#log-section` in a new `#app-main` div, itself alongside a new `#sidebar` inside a new `#app-shell` wrapper):

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>localagent</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <div id="app-shell">
      <aside id="sidebar">
        <div id="sidebar-header">
          <span id="sidebar-title">History</span>
          <button id="new-session-btn" title="New session">+</button>
        </div>
        <input id="session-search" type="search" placeholder="Search sessions…" />
        <div id="session-list">
          <div id="session-list-empty" class="hint-text">No saved sessions yet</div>
        </div>
      </aside>

      <div id="app-main">
        <header id="app-header">
          <div id="brand">
            <svg id="brand-mark" viewBox="0 0 100 100" aria-hidden="true">
              <rect x="2" y="2" width="96" height="96" rx="22" fill="#F5F3EC" stroke="#E4E0D3" stroke-width="2" />
              <rect x="24" y="24" width="52" height="52" rx="12" fill="none" stroke="#C15F3C" stroke-width="3" opacity="0.55" />
              <circle cx="50" cy="50" r="11" fill="#C15F3C" />
            </svg>
            <span id="brand-name">localagent</span>
          </div>
          <div id="header-right">
            <div id="auth-control">
              <div id="auth-signed-out" class="row">
                <button id="google-sign-in">Sign in with Google</button>
                <button id="apple-sign-in" disabled title="Coming soon — needs an Apple Developer account and a registered domain">Sign in with Apple</button>
              </div>
              <div id="auth-signed-in" class="row" hidden>
                <span id="auth-avatar"></span>
                <span id="auth-name"></span>
                <button id="sign-out-btn">Sign out</button>
              </div>
              <div id="auth-error" class="error-text"></div>
            </div>
            <button id="about-toggle" aria-expanded="false" title="About">?</button>
          </div>
        </header>

        <div id="about-panel" hidden>
          <p>A local-first coding agent. Everything — the model, the file access, the shell commands — runs on this machine. Nothing is sent anywhere else, except an optional Google sign-in, which talks to Google's servers to confirm who you are.</p>
          <dl>
            <dt>Embedded model cache</dt>
            <dd>~/.node-llama-cpp/models</dd>
            <dt>Workspace</dt>
            <dd id="about-workspace">(none selected)</dd>
            <dt>Your machine</dt>
            <dd id="about-hardware">Detecting…</dd>
          </dl>
          <button id="about-close">Close</button>
        </div>

        <section id="setup">
          <div class="row">
            <button id="choose-workspace">Choose workspace…</button>
            <span id="workspace-path">No workspace selected — optional, you can just chat</span>
          </div>

          <div id="embedded-fields" class="row">
            <label>
              Model size
              <select id="embedded-size">
                <option value="small">Small — fastest, lowest memory</option>
                <option value="medium">Medium — better quality</option>
                <option value="large">Large — best quality, needs a capable machine</option>
              </select>
            </label>
          </div>

          <details id="advanced-disclosure">
            <summary>Advanced: use a different provider</summary>
            <div class="row">
              <label class="radio-label">
                <input type="radio" name="advanced-provider" id="advanced-provider-external" value="external" checked />
                External server
              </label>
              <label class="radio-label">
                <input type="radio" name="advanced-provider" id="advanced-provider-anthropic" value="anthropic" />
                Claude API (Sonnet 5)
              </label>
            </div>
            <div id="external-fields" class="row">
              <label>
                Base URL
                <input id="base-url" type="text" placeholder="http://localhost:11434/v1" />
              </label>
              <label>
                Model
                <input id="external-model" type="text" placeholder="qwen2.5-coder:latest" />
              </label>
            </div>
            <div id="anthropic-fields" class="row" hidden>
              <span class="hint-text">Sends file contents and task context to Anthropic over the network. Needs <code>ANTHROPIC_API_KEY</code> set in your environment (or <code>ant auth login</code>) — no key is entered here.</span>
            </div>
          </details>

          <div class="row">
            <label>
              Mode
              <select id="mode"></select>
            </label>
            <span id="mode-description" class="hint-text"></span>
          </div>

          <div class="row">
            <button id="start-session" class="primary">Start session</button>
            <div id="start-error" class="error-text"></div>
          </div>

          <div id="download-progress" class="row" hidden>
            <div id="download-bar-track">
              <div id="download-bar-fill"></div>
            </div>
            <span id="download-label"></span>
          </div>
        </section>

        <section id="run">
          <div id="active-model-badge" hidden></div>
          <div class="row">
            <textarea id="task-input" placeholder="Describe the task…" disabled></textarea>
            <button id="run-task" class="primary" disabled>Run</button>
          </div>
          <div id="task-input-hint" class="hint-text">Enter to run · Shift+Enter for a new line</div>
        </section>

        <section id="log-section">
          <div id="event-log">
            <div id="empty-state">Start a session, then describe a task — every read, edit, and command the agent runs will show up here.</div>
          </div>
        </section>
      </div>
    </div>

    <script type="module" src="./renderer.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Update `src/electron/renderer/styles.css`**

The current `body` rule (lines 86-96) reads:

```css
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--font-sans);
  font-size: 13px;
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}
```

Change it to (the row/column flex responsibility moves to the new `#app-shell`/`#app-main` wrappers):

```css
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--font-sans);
  font-size: 13px;
  height: 100vh;
  overflow: hidden;
}
```

(No change in properties — `display`/`flex-direction` move out — see the new rules below, inserted directly after this block and before the existing `button:focus-visible, ...` rule.)

Insert these new rules immediately after the `body { ... }` block:

```css
#app-shell {
  display: flex;
  flex-direction: row;
  height: 100vh;
}

#sidebar {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-right: 1px solid var(--line);
  background: var(--surface-2);
  overflow-y: auto;
}

#sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

#sidebar-title {
  font-family: var(--font-serif);
  font-weight: 600;
  font-size: 13px;
  color: var(--ink);
}

#new-session-btn {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  padding: 0;
  background: transparent;
  color: var(--ink-dim);
  border: 1px solid var(--line);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}

#new-session-btn:hover {
  color: var(--ink);
  border-color: var(--ink-dim);
}

#session-search {
  font-size: 12px;
  padding: 5px 8px;
}

#session-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

#session-list-empty {
  font-size: 11px;
  padding: 8px 4px;
}

.session-item {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 4px 4px 4px 9px;
}

.session-item:hover {
  border-color: var(--ink-dim);
}

.session-item.active {
  border-color: var(--accent-strong);
  background: var(--surface-2);
}

.session-item-label {
  flex: 1;
  min-width: 0;
  text-align: left;
  background: transparent;
  border: none;
  padding: 3px 0;
  font-size: 12px;
  color: var(--ink);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-item-delete {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--ink-dim);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
}

.session-item-delete:hover {
  color: var(--danger);
}

#app-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
```

- [ ] **Step 3: Replace `src/electron/renderer/renderer.ts`**

The current full content is 392 lines (already shown in full earlier in this plan's context — see Task descriptions above for the exact current file; it is reproduced here as the base for the diff below since it's the longest file in this task).

Make these changes to `src/electron/renderer/renderer.ts`:

**3a.** Change the type imports at the top (line 1) from:

```typescript
import type { AgentEvent, PermissionMode, ToolCall } from "../../types.js";
```

to:

```typescript
import type { AgentEvent, ChatMessage, PermissionMode, ToolCall } from "../../types.js";
```

**3b.** After the existing `type AuthStatus = ...` line (line 24) and before `interface AgentBridge {` (line 26), insert:

```typescript
interface SessionIndexEntry {
  id: string;
  title: string;
  updatedAt: number;
}

interface SessionRecord {
  id: string;
  title: string;
  messages: ChatMessage[];
  events: AgentEvent[];
  createdAt: number;
  updatedAt: number;
}

interface ResumePayload {
  sessionId: string;
  initialMessages: ChatMessage[];
  priorEvents: AgentEvent[];
  title: string;
  createdAt: number;
}
```

**3c.** Change the `AgentBridge` interface (lines 26-39) from:

```typescript
interface AgentBridge {
  startSession(config: SessionConfig): Promise<{ sessionId: string; workspaceRoot: string }>;
  runTask(sessionId: string, task: string): Promise<void>;
  respondPermission(sessionId: string, callId: string, approved: boolean): Promise<void>;
  cancelSession(sessionId: string): Promise<void>;
  pickWorkspace(): Promise<string | null>;
  onEvent(callback: (sessionId: string, event: AgentEvent) => void): () => void;
  onDownloadProgress(callback: (status: DownloadProgress) => void): () => void;
  listCachedModels(): Promise<Record<string, boolean>>;
  getHardwareInfo(): Promise<HardwareInfo>;
  googleSignIn(): Promise<SignInResult>;
  signOut(): Promise<void>;
  getAuthStatus(): Promise<AuthStatus>;
}
```

to:

```typescript
interface AgentBridge {
  startSession(config: SessionConfig, resume?: ResumePayload): Promise<{ sessionId: string; workspaceRoot: string }>;
  runTask(sessionId: string, task: string): Promise<void>;
  respondPermission(sessionId: string, callId: string, approved: boolean): Promise<void>;
  cancelSession(sessionId: string): Promise<void>;
  pickWorkspace(): Promise<string | null>;
  onEvent(callback: (sessionId: string, event: AgentEvent) => void): () => void;
  onDownloadProgress(callback: (status: DownloadProgress) => void): () => void;
  listCachedModels(): Promise<Record<string, boolean>>;
  getHardwareInfo(): Promise<HardwareInfo>;
  googleSignIn(): Promise<SignInResult>;
  signOut(): Promise<void>;
  getAuthStatus(): Promise<AuthStatus>;
  listSessions(): Promise<SessionIndexEntry[]>;
  searchSessions(query: string): Promise<SessionIndexEntry[]>;
  loadSession(id: string): Promise<SessionRecord | null>;
  deleteSession(id: string): Promise<void>;
}
```

**3d.** After the existing `const activeModelBadge = byId<HTMLDivElement>("active-model-badge");` line (line 86), insert:

```typescript
const sidebarSessionList = byId<HTMLDivElement>("session-list");
const sessionListEmpty = byId<HTMLDivElement>("session-list-empty");
const sessionSearchInput = byId<HTMLInputElement>("session-search");
const newSessionBtn = byId<HTMLButtonElement>("new-session-btn");
```

**3e.** Replace the entire `startSessionBtn.addEventListener("click", async () => { ... });` block (lines 267-326 of the original file) with a shared `beginSession` function plus a thin listener, and add the sidebar/resume/new-session logic. Specifically, replace:

```typescript
startSessionBtn.addEventListener("click", async () => {
  startError.textContent = "";

  const useAnthropic = advancedDisclosure.open && advancedProviderAnthropic.checked;
  const useExternal = advancedDisclosure.open && advancedProviderExternal.checked && baseUrlInput.value.trim().length > 0;
  const provider: ProviderConfig = useAnthropic
    ? { kind: "anthropic" }
    : useExternal
      ? { kind: "openai-compatible", baseUrl: baseUrlInput.value.trim(), model: externalModelInput.value.trim() }
      : { kind: "embedded", size: embeddedSizeSelect.value };

  // workspaceRoot omitted entirely when none was picked — startSession defaults
  // it to the home directory and hands back whichever path it actually used.
  const config: SessionConfig = { ...(workspaceRoot ? { workspaceRoot } : {}), provider, mode: modeSelect.value as PermissionMode };

  startSessionBtn.disabled = true;
  try {
    const result = await window.agent.startSession(config);
    sessionId = result.sessionId;
    if (!workspaceRoot) {
      workspaceRoot = result.workspaceRoot;
      workspacePathEl.textContent = `${result.workspaceRoot} (default — no folder chosen)`;
      aboutWorkspace.textContent = result.workspaceRoot;
    }
    taskInput.disabled = false;
    runTaskBtn.disabled = false;
    logLine(`Session started (${provider.kind}, mode=${config.mode})`, "log-status");
    // All setup controls lock here, not just Start: Foundation has no way to
    // apply a changed workspace/provider/mode to an already-running session,
    // so leaving them interactive would let the displayed value silently
    // drift from what the session actually started with.
    chooseWorkspaceBtn.disabled = true;
    embeddedSizeSelect.disabled = true;
    modeSelect.disabled = true;
    baseUrlInput.disabled = true;
    externalModelInput.disabled = true;
    advancedProviderExternal.disabled = true;
    advancedProviderAnthropic.disabled = true;

    const modelText =
      provider.kind === "embedded"
        ? EMBEDDED_MODELS[provider.size as keyof typeof EMBEDDED_MODELS]?.description ?? provider.size
        : provider.kind === "anthropic"
          ? "Claude Sonnet 5 (Anthropic API)"
          : `${provider.model} (${provider.baseUrl})`;
    const gpuText = provider.kind === "embedded" && hardwareInfo?.gpu ? ` · ${hardwareInfo.gpu} GPU` : "";
    activeModelBadge.innerHTML = "";
    const dot = document.createElement("span");
    dot.className = "signal-dot";
    activeModelBadge.appendChild(dot);
    activeModelBadge.appendChild(document.createTextNode(`${modelText}${gpuText}`));
    activeModelBadge.hidden = false;
  } catch (err: any) {
    startError.textContent = err?.message ?? String(err);
    startSessionBtn.disabled = false;
  } finally {
    downloadProgressRow.hidden = true;
    progressLastTime = 0;
  }
});
```

with:

```typescript
async function beginSession(resume?: ResumePayload): Promise<void> {
  startError.textContent = "";

  const useAnthropic = advancedDisclosure.open && advancedProviderAnthropic.checked;
  const useExternal = advancedDisclosure.open && advancedProviderExternal.checked && baseUrlInput.value.trim().length > 0;
  const provider: ProviderConfig = useAnthropic
    ? { kind: "anthropic" }
    : useExternal
      ? { kind: "openai-compatible", baseUrl: baseUrlInput.value.trim(), model: externalModelInput.value.trim() }
      : { kind: "embedded", size: embeddedSizeSelect.value };

  // workspaceRoot omitted entirely when none was picked — startSession defaults
  // it to the home directory and hands back whichever path it actually used.
  const config: SessionConfig = { ...(workspaceRoot ? { workspaceRoot } : {}), provider, mode: modeSelect.value as PermissionMode };

  startSessionBtn.disabled = true;
  try {
    const result = await window.agent.startSession(config, resume);
    sessionId = result.sessionId;
    if (!workspaceRoot) {
      workspaceRoot = result.workspaceRoot;
      workspacePathEl.textContent = `${result.workspaceRoot} (default — no folder chosen)`;
      aboutWorkspace.textContent = result.workspaceRoot;
    }
    taskInput.disabled = false;
    runTaskBtn.disabled = false;
    logLine(
      resume ? `Resumed session (${provider.kind}, mode=${config.mode})` : `Session started (${provider.kind}, mode=${config.mode})`,
      "log-status"
    );
    // All setup controls lock here, not just Start: Foundation has no way to
    // apply a changed workspace/provider/mode to an already-running session,
    // so leaving them interactive would let the displayed value silently
    // drift from what the session actually started with.
    chooseWorkspaceBtn.disabled = true;
    embeddedSizeSelect.disabled = true;
    modeSelect.disabled = true;
    baseUrlInput.disabled = true;
    externalModelInput.disabled = true;
    advancedProviderExternal.disabled = true;
    advancedProviderAnthropic.disabled = true;

    const modelText =
      provider.kind === "embedded"
        ? EMBEDDED_MODELS[provider.size as keyof typeof EMBEDDED_MODELS]?.description ?? provider.size
        : provider.kind === "anthropic"
          ? "Claude Sonnet 5 (Anthropic API)"
          : `${provider.model} (${provider.baseUrl})`;
    const gpuText = provider.kind === "embedded" && hardwareInfo?.gpu ? ` · ${hardwareInfo.gpu} GPU` : "";
    activeModelBadge.innerHTML = "";
    const dot = document.createElement("span");
    dot.className = "signal-dot";
    activeModelBadge.appendChild(dot);
    activeModelBadge.appendChild(document.createTextNode(`${modelText}${gpuText}`));
    activeModelBadge.hidden = false;
    await refreshSessionList(sessionSearchInput.value.trim());
  } catch (err: any) {
    startError.textContent = err?.message ?? String(err);
    startSessionBtn.disabled = false;
  } finally {
    downloadProgressRow.hidden = true;
    progressLastTime = 0;
  }
}

startSessionBtn.addEventListener("click", () => void beginSession());

function clearEventLog(): void {
  toolCards.clear();
  eventLog.innerHTML = "";
  emptyState.hidden = false;
  eventLog.appendChild(emptyState);
}

function resetToSetup(): void {
  if (sessionId) void window.agent.cancelSession(sessionId);
  sessionId = null;
  workspaceRoot = null;
  clearEventLog();
  taskInput.value = "";
  taskInput.disabled = true;
  runTaskBtn.disabled = true;
  activeModelBadge.hidden = true;
  startError.textContent = "";
  workspacePathEl.textContent = "No workspace selected — optional, you can just chat";
  aboutWorkspace.textContent = "(none selected)";
  chooseWorkspaceBtn.disabled = false;
  embeddedSizeSelect.disabled = false;
  modeSelect.disabled = false;
  baseUrlInput.disabled = false;
  externalModelInput.disabled = false;
  advancedProviderExternal.disabled = false;
  advancedProviderAnthropic.disabled = false;
  startSessionBtn.disabled = false;
  void refreshSessionList(sessionSearchInput.value.trim());
}

newSessionBtn.addEventListener("click", resetToSetup);

async function resumeSession(id: string): Promise<void> {
  const record = await window.agent.loadSession(id);
  if (!record) {
    startError.textContent = "Couldn't load this session — the saved file looks corrupted.";
    return;
  }

  if (sessionId) {
    await window.agent.cancelSession(sessionId);
  }

  clearEventLog();
  for (const event of record.events) {
    renderEvent(event);
  }

  await beginSession({
    sessionId: record.id,
    initialMessages: record.messages,
    priorEvents: record.events,
    title: record.title,
    createdAt: record.createdAt,
  });
}

function renderSessionList(entries: SessionIndexEntry[]): void {
  for (const el of Array.from(sidebarSessionList.querySelectorAll(".session-item"))) {
    el.remove();
  }
  sessionListEmpty.hidden = entries.length > 0;
  for (const entry of entries) {
    const item = document.createElement("div");
    item.className = "session-item";
    if (entry.id === sessionId) item.classList.add("active");

    const label = document.createElement("button");
    label.type = "button";
    label.className = "session-item-label";
    label.textContent = entry.title;
    label.title = entry.title;
    label.addEventListener("click", () => void resumeSession(entry.id));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "session-item-delete";
    deleteBtn.title = "Delete session";
    deleteBtn.textContent = "×";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void (async () => {
        await window.agent.deleteSession(entry.id);
        if (entry.id === sessionId) {
          resetToSetup();
        } else {
          await refreshSessionList(sessionSearchInput.value.trim());
        }
      })();
    });

    item.appendChild(label);
    item.appendChild(deleteBtn);
    sidebarSessionList.appendChild(item);
  }
}

async function refreshSessionList(query: string): Promise<void> {
  const entries = query ? await window.agent.searchSessions(query) : await window.agent.listSessions();
  renderSessionList(entries);
}

sessionSearchInput.addEventListener("input", () => {
  void refreshSessionList(sessionSearchInput.value.trim());
});

void refreshSessionList("");
```

- [ ] **Step 4: Build and manually verify the sidebar renders**

Run: `npm run build`
Expected: compiles and copies assets with no errors.

Run: `env -u ELECTRON_RUN_AS_NODE npm run electron` (or `npm run electron` in a normal terminal)
Expected: app window opens with a left sidebar ("History" header, a `+` new-session button, a search input, "No saved sessions yet"). Pick a workspace, start a session with the embedded provider, run a task, wait for it to complete — the sidebar should now show one entry titled after the task. Click "+", confirm the setup form resets and the sidebar entry is still there. Click the sidebar entry — confirm the transcript replays and the task input re-enables. Quit and relaunch the app (`env -u ELECTRON_RUN_AS_NODE npm run electron` again) — confirm the sidebar entry is still there after a full restart, and clicking it still resumes correctly. Type a few characters into the search box that don't match the session's title or content — confirm the list empties; clear the search — confirm it reappears.

- [ ] **Step 5: Update `README.md`**

In the "What's actually implemented" list, the Electron bullet point currently ends with (after the Google sign-in addition from a prior change):

```markdown
  identity only, nothing is gated by it; Apple sign-in is a disabled UI
  stub pending an Apple Developer account and a registered domain.
```

Change that ending to:

```markdown
  identity only, nothing is gated by it; Apple sign-in is a disabled UI
  stub pending an Apple Developer account and a registered domain.
  `sessionStore.ts` adds persistent session history — every completed task
  autosaves to `app.getPath('userData')/sessions/`, a left sidebar lists
  and full-text-searches past sessions, and clicking one resumes it with
  full model context (not just a read-only transcript) — see
  `docs/superpowers/specs/2026-08-27-session-persistence-design.md`.
```

- [ ] **Step 6: Commit**

```bash
git add src/electron/renderer/index.html src/electron/renderer/styles.css src/electron/renderer/renderer.ts README.md
git commit -m "feat: add session history sidebar with search and resume"
```
