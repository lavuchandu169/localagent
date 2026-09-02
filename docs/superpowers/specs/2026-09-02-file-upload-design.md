# File attachments (upload) — design spec

Date: 2026-09-02

## Purpose

Let a user attach a file — text or image, from anywhere on disk, not just
the current workspace — to a task, the way Claude.ai and ChatGPT do. Today
the only way to get file content in front of the model is `read_file`,
which requires the model to already know (or guess) a path inside the
workspace root; there's no way to hand it something from outside the
workspace, or a screenshot, without the model asking for it first.

## Scope

Attaching files to a task's first message only — not mid-conversation
follow-up attachments, not a persistent "project files" library. Both text
(code, config, docs, logs, CSV, JSON, markdown, plain text) and images
(vision) are in scope. Each provider decides what it can actually do with
an attachment; none of them are required to support every kind.

## Core type change

`ChatMessage.content` stays exactly what it is today — a plain string,
always just the user's typed task text. Two new **optional** fields carry
attachments, present only on a user message that had any:

```typescript
// src/types.ts
export interface AttachedImage {
  name: string;
  mediaType: string; // e.g. "image/png" — from the file's real content, not just its extension
  dataBase64: string;
}

export interface AttachedText {
  name: string;
  content: string; // already UTF-8 decoded, already truncated to the cap if needed
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: ToolCall[];
  images?: AttachedImage[];
  textAttachments?: AttachedText[];
}
```

This was chosen over restructuring `content` into a `string | ContentPart[]`
union (closer to Claude's actual wire format) because `content` is read as
a plain string in a lot of places today — every provider's message
mapping, and anywhere `content` gets displayed, measured, or truncated.
Two optional fields are purely additive: every existing message (no
`images`/`textAttachments`) round-trips through every one of those places
completely unchanged, and `sessionStore.ts` needs no changes at all — it
already just `JSON.stringify`s the whole record, so the new fields
persist automatically once ChatMessage carries them.

## Reading an attachment (main process)

A new `src/electron/attachments.ts`:

```typescript
export interface PickedAttachment {
  name: string;
  kind: "image" | "text";
  mediaType?: string;   // set when kind === "image"
  dataBase64?: string;  // set when kind === "image"
  content?: string;     // set when kind === "text"
  truncated?: boolean;  // set when kind === "text" and it hit MAX_TEXT_BYTES
}

export async function readAttachment(filePath: string): Promise<PickedAttachment>;
```

Classification is by real content, not just extension: sniff the first
bytes for a known image magic number (PNG/JPEG/GIF/WebP — the four
formats Claude and most OpenAI-compatible vision models all accept) to
classify as `"image"`; anything else is read as UTF-8 text. A file
that's neither valid UTF-8 text nor a recognized image (a binary blob,
an unsupported format) is rejected with a clear error rather than
silently mangled.

Limits (mirroring this app's existing "cap and truncate, don't silently
fail or blow the request" pattern already used for diffs and logs):
- **Images**: 5MB raw file size cap (base64 inflates ~33% on the wire —
  still comfortably inside every provider's actual per-image limit).
  Oversized → rejected with a clear error, nothing picked.
- **Text files**: 200KB cap; content past that is truncated with a
  trailing `\n…truncated…\n` marker (`truncated: true` on the result, so
  the UI can say so) rather than rejecting the whole file outright — a
  large log file is still useful truncated.
- **Count**: up to 5 attachments per task (mixed images/text, any
  combination) — enough for a real multi-file question, small enough to
  keep the picker and the chip row simple.

## IPC

One new channel, following this app's existing `agent:*` /
main-process-owns-file-access pattern:

- `agent:pick-attachments()` → `PickedAttachment[]`. Opens a native
  multi-select file dialog (`dialog.showOpenDialog` with
  `properties: ["openFile", "multiSelections"]`, no path filter — same
  dialog primitive `pickWorkspace` already uses, just multi-select and
  files instead of a directory), then calls `readAttachment` on every
  selected path. A selection that mixes some good files with one
  oversized/binary one returns the good ones plus a per-file error list
  (`{ name, error }[]` alongside the successes) rather than failing the
  whole batch — one bad file in a 3-file pick shouldn't lose the other 2.

`agent:run-task` grows an optional third argument:

```typescript
// preload.cjs
runTask: (sessionId, task, attachments) =>
  ipcRenderer.invoke("agent:run-task", sessionId, task, attachments),
```

```typescript
// main.ts
ipcMain.handle(
  "agent:run-task",
  (event, sessionId: string, task: string, attachments?: { images?: AttachedImage[]; textAttachments?: AttachedText[] }) => ...
);
```

## Agent loop

`AgentSession.run` and `sessionRegistry.runTask`/`doRunTask` each grow an
optional attachments parameter, threaded straight through to the very
first message `run()` pushes:

```typescript
// agent.ts
async *run(
  task: string,
  attachments?: { images?: AttachedImage[]; textAttachments?: AttachedText[] }
): AsyncGenerator<AgentEvent> {
  this.messages.push({ role: "user", content: task, ...attachments });
  ...
}
```

Everything after that first push is completely unaffected — the turn
loop, checkpoints, the corrective nudge, plan-first, all operate on
`this.messages` the same way regardless of whether this particular user
message happens to carry attachments.

## Per-provider handling

Each provider's message-mapping function is the one place that has to
know about `images`/`textAttachments` at all:

- **`anthropicProvider.ts`** (`toAnthropicMessages`): real vision. A user
  message with `images` becomes a `content: ContentBlockParam[]` array —
  one `{type: "image", source: {type: "base64", media_type, data}}`
  block per image, followed by a `{type: "text", text: content}` block
  (skipped if `content` is empty, e.g. an attachment-only message).
  `textAttachments` fold into the text block instead, each wrapped as
  `\n\n--- Attached file: ${name} ---\n${content}\n---` appended after
  the task text — plain text, no special Anthropic feature needed.

- **`openaiCompatible.ts`**: sent optimistically in the standard
  `image_url` content-part format
  (`{type: "image_url", image_url: {url: "data:" + mediaType + ";base64," + dataBase64}}`)
  alongside a text part — this is what LM Studio/Ollama/vLLM all expect
  for a vision-capable loaded model. If the loaded model doesn't support
  vision, the server's own error response surfaces through this
  provider's existing `Provider error ${res.status}: ${text}` path —
  no new error handling needed, that path already exists.
  `textAttachments` fold into the text part the same way as Anthropic.

- **`embeddedLlama.ts`** (`toLlamaHistory`): **not vision-capable** in
  this app today — no vision-projector model is loaded alongside the
  text GGUF, so an image attachment cannot actually be seen. Rather than
  silently drop it (the model would just never mention needing an image
  it doesn't know exists) or pretend to send it (node-llama-cpp's
  `LlamaChat.generateResponse` has no image-input path in how this app
  drives it), `images` fold into the text history as an honest note:
  `\n\n[Attached image: ${name} — this local model can't see images.]`.
  `textAttachments` fold in exactly like the other two providers — pure
  text has no such limitation locally.

## UI

A paperclip button (`#attach-file`) next to `#task-input` in the
composer row. Clicking calls `agent:pick-attachments`; results populate
a small in-memory `pendingAttachments` array in `renderer.ts` and render
as removable chips in a new row above the textarea (`#attachment-chips`)
— filename, a kind icon (image vs. text), and an `×` to remove one
before sending. A truncated text file's chip shows a small "truncated"
badge. Any per-file pick errors (oversized, unreadable) show as a brief
inline message, not a blocking dialog.

`runTaskBtn`'s click handler passes `pendingAttachments` through to
`window.agent.runTask`, then clears both the chip row and the
in-memory array — matching how the task textarea itself already clears
after sending. The rendered task bubble (`.log-task`) shows the typed
text plus the same chips (read-only, no `×`) underneath, so the log
reflects what was actually sent without dumping raw file content inline
— consistent with `renderDiff`'s existing "cap what's shown, keep the
full data in the event/message, not the DOM" precedent.

## Error handling

- A rejected pick (oversized image, unreadable/binary file) never
  becomes a pending attachment — reported inline, picking can be retried
  immediately with a different file.
- A provider that can't actually use an attachment (embedded model +
  image) never fails the task — it degrades to the honest text note
  above rather than erroring out, since the rest of the task might still
  be fully answerable from the task text and any text attachments.
- No re-validation at `run()` time — everything reaching `run()` already
  passed `readAttachment`'s checks when it was picked.

## Testing

`attachments.ts` is Electron-free apart from the dialog call itself
(mirrors `googleSettings.ts`'s pure-core-logic-vs-thin-IPC-wrapper
split) — `readAttachment` gets real-file unit tests: a real PNG (magic-
number classification), a real UTF-8 text file under/over the 200KB cap
(truncation marker, `truncated: true`), an oversized image (rejected,
clear error), a binary non-image file (rejected, clear error).

Each provider's message-mapping function gets unit tests for the new
`images`/`textAttachments` branches: `toAnthropicMessages` produces the
right `ContentBlockParam[]` shape for an image + text combination;
`openaiCompatible`'s body-building produces the right `image_url` part;
`toLlamaHistory` produces the honest can't-see-images text note and
folds `textAttachments` in identically to the other two.

`AgentSession.run`'s new parameter gets a MockProvider test proving the
first pushed message actually carries `images`/`textAttachments`
unchanged, and that a task with attachments but empty task text still
runs (an attachment-only message).

Electron IPC/main.ts/renderer UI changes get no automated test (this
project's consistent treatment of Electron-only code) — verified live
via Playwright: pick real attachments (stubbing the native dialog the
same way checkpoint/changes-panel verification already does), confirm
chips render, confirm a run actually carries the attachment through to
whichever provider is under test, confirm the chip row clears after
sending.

## Out of scope

- Mid-conversation attachments (attaching a file to a *follow-up*
  message in an already-running task) — v1 is task-start only.
- Drag-and-drop onto the composer — the paperclip picker only, for now.
- PDFs specifically (Anthropic's real `document` content-block type,
  with citations) — a real future enhancement, but out of scope here;
  a PDF today either gets rejected (not valid UTF-8 text, not a
  recognized image) or would need its own classification branch, which
  this spec doesn't add.
- Any change to how `read_file`/`list_directory`/`grep` work — those
  remain the model's own in-workspace exploration tools, entirely
  separate from user-initiated attachments.
