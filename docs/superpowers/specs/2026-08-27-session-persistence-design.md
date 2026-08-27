# Session save/resume — design spec

Date: 2026-08-27

## Purpose

Add persistent chat history to the Electron app: sessions survive app
restarts, are listed in a sidebar, can be searched, and can be resumed
with full model context (not just a read-only transcript). This is the
first of seven sub-projects decomposed from a broader request to add
Claude.ai-style conversation features to localagent, reinterpreted for
this app's identity as a local-first *coding agent* rather than a
general chat product (see Decomposition below). It is foundational —
Projects and Memory, two of the other six sub-projects, both need a
durable session store to exist before they can be designed.

Today, nothing in this app survives a restart: no settings persistence,
no saved sessions, nothing. This closes that gap for conversation
history specifically.

## Decomposition

The original request bundled seven independent features (chat history,
file upload, projects, artifacts, memory, web search, extended
thinking). Several of these need this sub-project's storage layer to
exist first (Projects, Memory); others are architecturally independent
(web search fits the existing tool registry; file upload is a separate
concern); one (extended thinking) is Anthropic-API-specific and doesn't
map onto the embedded/OpenAI-compatible providers this app also
supports. Each gets its own spec → plan → implementation cycle,
starting with this one.

## Architecture: file-per-session JSON + lightweight index

Three approaches were considered:

- **Chosen: one JSON file per session, plus a lightweight index file.**
  `sessionsDir/index.json` maps session id → `{ id, title, updatedAt }`
  for fast sidebar rendering without reading every transcript.
  `sessionsDir/<id>.json` holds the full record. Zero new npm
  dependencies (`node:fs/promises` only), consistent with the
  `googleAuth.ts` storage precedent. Per-session files mean a bad write
  corrupts one session, not all of history.
- **Rejected: one big `sessions.json`.** Every save rewrites the entire
  growing blob; gets slower as history accumulates, and a single bad
  write risks corrupting *all* sessions instead of one.
- **Rejected: SQLite.** Real indexing/search, but needs either a native
  dependency (`better-sqlite3`) or Node 22+ for `node:sqlite` (this
  project currently runs on Node 20). Overkill for what will realistically
  be dozens-to-low-hundreds of sessions for a single local user —
  YAGNI.

### Data shapes

```typescript
interface SessionIndexEntry {
  id: string;
  title: string;
  updatedAt: number;
}

interface SessionRecord {
  id: string;
  title: string;
  messages: ChatMessage[];   // full provider-format history, for true resume
  events: AgentEvent[];      // full event log, for transcript display/search
  createdAt: number;
  updatedAt: number;
}
```

`sessionsDir` is passed explicitly into every `sessionStore.ts`
function (not read from `app.getPath` internally) — the module has no
Electron imports and is unit-testable standalone against a real temp
directory, same principle as `googleAuth.ts`'s storage layer. The
call site (`main.ts`) defaults it to
`app.getPath('userData')/sessions`.

## Flow

**Save (automatic, no user action):**
1. `startSession` creates a registry entry with an empty in-memory
   `events: []` buffer — nothing hits disk yet.
2. Each task's `AgentEvent`s append to that buffer as they stream to
   the renderer (same callback that already does
   `event.sender.send(...)`).
3. When a task's terminal event (`done` or `error`) fires,
   `sessionRegistry` upserts the record via `sessionStore.saveSession()`:
   `title` is set once from the first task (truncated to ~60 chars) and
   never overwritten after; `messages` (pulled via `AgentSession`'s new
   `getMessages()`), `events`, and `updatedAt` refresh on every save.
   A session with zero completed tasks is never persisted — an empty
   conversation isn't a conversation yet, and the sidebar shouldn't
   fill with abandoned starts.

**Resume:**
1. Sidebar click → `agent:load-session(id)` → returns the full record,
   or `null` if the file is missing/corrupted.
2. On `null`: renderer shows "Couldn't load this session — the saved
   file looks corrupted." No thrown exception crosses the IPC boundary.
3. On success: renderer clears the log (`toolCards.clear()`, same as
   the existing new-task path) and replays `record.events` through the
   existing `renderEvent()` function — the same rendering path used for
   live streaming, not a second renderer.
4. Renderer calls `agent:start-session` with the record's `id` passed
   through as an explicit `sessionId` override and the record's
   `messages` as `initialMessages`. `sessionRegistry.startSession`
   reuses that id instead of minting a fresh UUID — **resuming a
   session never forks a duplicate sidebar entry**; further tasks keep
   updating the same history entry. A session started fresh (not
   resumed) still gets a random UUID as today.
5. `AgentSession`'s constructor seeds `this.messages` from
   `initialMessages` when provided, instead of pushing just the system
   prompt.

**Delete:**
Deleting the record for the *currently active* session also cancels
that live session (via the existing cancel path) — otherwise a later
task on that still-running session would resave the record and
silently resurrect it right after deletion.

**Known limitation — `readPaths` isn't persisted.** `AgentSession`
tracks which file paths have been read this session, to skip a
redundant permission prompt on `ACCEPT_EDITS` writes to already-read
files. A resumed session starts that set empty, so the first edit to a
file read *before* the restart will prompt once more than strictly
necessary. This fails safe (an extra prompt, never a skipped one) and
is accepted rather than persisting yet more state for this pass.

## IPC contract

- `agent:list-sessions()` → `SessionIndexEntry[]`, for the sidebar.
- `agent:load-session(id)` → `SessionRecord | null`.
- `agent:delete-session(id)` → `void`; cancels the live session first
  if `id` is currently active.
- `agent:start-session` (existing handler, extended) → accepts an
  optional `sessionId` (resume) and `initialMessages` (resume) on top
  of its current `SessionConfig` parameter.

## Storage

`app.getPath('userData')/sessions/` — `index.json` plus one file per
session id. Main-process-only file access, same boundary as everything
else in this app (the renderer never gets raw `fs`).

## Error handling

- Missing `sessionsDir`/`index.json` → treated as empty history:
  `mkdir -p` on write, `[]` on read. Never throws for "doesn't exist
  yet."
- Corrupt `index.json` → `rebuildIndex()` reconstructs it from the
  directory listing; any individual session file that also fails to
  parse is skipped, not fatal.
- Corrupt individual session file → `loadSessionRecord` returns `null`,
  never throws. The IPC handler propagates `null` straight through to
  the renderer.

## Testing

- `src/sessionStore.ts` is pure, explicit-path I/O — real unit tests
  against a temp directory: round-trip save/load, index upsert on
  repeated saves, rebuild-from-corrupt-index, listing across multiple
  files, delete removing both the record and its index entry.
- `agent.ts`'s `initialMessages` seeding and `getMessages()` accessor,
  and `sessionRegistry.ts`'s event-buffering and sessionId-reuse-on-resume,
  are unit-testable via the existing `MockProvider` pattern already
  used in `agent.test.ts` / `sessionRegistry.test.ts`.
- IPC wiring (`main.ts`) and the sidebar UI are not unit-tested — same
  documented gap as the rest of the app's Electron/DOM layers. Verified
  manually: build, launch, save a session, restart the app, resume it,
  confirm history and continued conversation work — screenshotted via
  the existing Playwright verification pattern if useful.

## Known limitations (accepted for this pass)

- `readPaths` (read-before-write safety tracking) isn't persisted
  across a resume — fails safe, see Flow above.
- Search/listing scans full transcript files at query time — fine into
  the hundreds of sessions for one local user, not designed for
  thousands.
- No rename/retitle affordance — title is fixed from the first task
  once set.
- No project grouping yet — that's the next sub-project in the
  decomposition, and builds directly on this storage layer.
