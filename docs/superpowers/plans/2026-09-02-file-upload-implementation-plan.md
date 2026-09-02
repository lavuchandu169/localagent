# File Attachments (Upload) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user attach text and image files, from anywhere on disk, to a task — read for content, folded into the model's context per-provider (real vision for Claude, optimistic `image_url` for custom servers, an honest "can't see images" text note for the embedded local model), and shown as removable chips in the composer before sending.

**Architecture:** Two new optional fields on `ChatMessage` (`images`, `textAttachments`) carry attachments without touching `content`, which stays a plain string everywhere it already is one. A new `src/electron/attachments.ts` reads and classifies a picked file (image vs. text, by real content not extension) with size caps. Each provider's existing message-mapping function grows a branch for the new fields; nothing else in `agent.ts`'s turn loop, checkpoints, corrective nudge, or plan-first needs to know attachments exist at all — they're just extra fields on one message.

**Tech Stack:** TypeScript, Electron IPC, `@anthropic-ai/sdk`, `node-llama-cpp`, Node's built-in `fetch`.

**Spec:** `docs/superpowers/specs/2026-09-02-file-upload-design.md`

## Global Constraints

- `ChatMessage.content` remains a plain `string` in every case — attachments are carried in two new optional fields (`images`, `textAttachments`), never by restructuring `content` into a union type.
- Image size cap: 5MB raw file size, rejected (not truncated) over that.
- Text file size cap: 200KB; content past that is truncated with a trailing `\n…truncated…\n` marker and `truncated: true`, never rejected outright.
- Attachment count cap: 5 per task (enforced in the renderer UI in Task 7 — earlier tasks' reader/provider code has no count limit of its own to enforce, since it operates on whatever list it's given).
- File classification is by real content (magic-number sniffing for images; UTF-8 validity for text), never by file extension alone.
- No changes to `read_file`/`list_directory`/`grep` or to how they work.
- No PDF support, no drag-and-drop, no mid-conversation (follow-up message) attachments — all explicitly out of scope for this plan.
- Every new pure function (attachment reading/classification, each provider's attachment-folding logic) gets real unit tests — no mocked file reads, no mocked HTTP for the parts that don't need it.

---

### Task 1: Core types + the attachment reader

**Files:**
- Modify: `src/types.ts`
- Create: `src/electron/attachments.ts`
- Create: `src/test/attachments.test.ts`
- Modify: `package.json` (`test` script)

**Interfaces:**
- Produces: `AttachedImage { name: string; mediaType: string; dataBase64: string }`, `AttachedText { name: string; content: string }` (both exported from `src/types.ts`), `ChatMessage.images?: AttachedImage[]`, `ChatMessage.textAttachments?: AttachedText[]`.
- Produces: `PickedAttachment { name: string; kind: "image" | "text"; mediaType?: string; dataBase64?: string; content?: string; truncated?: boolean }` and `readAttachment(filePath: string): Promise<PickedAttachment>`, both exported from `src/electron/attachments.ts`. `readAttachment` rejects (throws) for an oversized image or a file that's neither a recognized image nor valid UTF-8 text.

- [ ] **Step 1: Add the two new types and the two new `ChatMessage` fields**

In `src/types.ts`, add right after the `ToolCall` interface (before `ToolContext`):

```typescript
export interface AttachedImage {
  name: string;
  mediaType: string;
  dataBase64: string;
}

export interface AttachedText {
  name: string;
  content: string;
}
```

Then change the existing `ChatMessage` interface to:

```typescript
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

- [ ] **Step 2: Run the build to confirm the type change alone doesn't break anything**

Run: `npm run build`
Expected: succeeds with no errors — these are purely additive optional fields, so every existing `ChatMessage` literal in the codebase (none of which set `images`/`textAttachments`) still type-checks.

- [ ] **Step 3: Write the failing tests for `readAttachment`**

Create `src/test/attachments.test.ts`:

```typescript
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { readAttachment } from "../electron/attachments.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

async function withTempFile(name: string, data: Buffer | string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-attachments-test-"));
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, data);
  return filePath;
}

console.log("readAttachment:");

{
  // Real PNG magic bytes (the 8-byte PNG signature) padded with arbitrary
  // data — readAttachment only sniffs the signature and then base64-encodes
  // the whole file, so this is a faithful fixture without needing a fully
  // valid, decodable image.
  const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 0xab)]);
  const filePath = await withTempFile("photo.png", pngBytes);
  const result = await readAttachment(filePath);
  check("a PNG is classified as an image", result.kind === "image" && result.mediaType === "image/png");
  check("the image content is base64-encoded losslessly", Buffer.from(result.dataBase64!, "base64").equals(pngBytes));
  check("the name is just the basename", result.name === "photo.png");
}

{
  const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50, 0x11)]);
  const filePath = await withTempFile("photo.jpg", jpegBytes);
  const result = await readAttachment(filePath);
  check("a JPEG is classified as an image", result.kind === "image" && result.mediaType === "image/jpeg");
}

{
  const gifBytes = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(50, 0x22)]);
  const filePath = await withTempFile("anim.gif", gifBytes);
  const result = await readAttachment(filePath);
  check("a GIF is classified as an image", result.kind === "image" && result.mediaType === "image/gif");
}

{
  const webpBytes = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP", "ascii"), Buffer.alloc(50, 0x33)]);
  const filePath = await withTempFile("sticker.webp", webpBytes);
  const result = await readAttachment(filePath);
  check("a WebP is classified as an image", result.kind === "image" && result.mediaType === "image/webp");
}

{
  // A RIFF container that ISN'T WebP (e.g. a WAV file) must not be
  // misclassified as an image just because it starts with "RIFF".
  const wavBytes = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.from([0, 0, 0, 0]), Buffer.from("WAVE", "ascii"), Buffer.alloc(50, 0x44)]);
  const filePath = await withTempFile("sound.wav", wavBytes);
  let threw = false;
  try {
    await readAttachment(filePath);
  } catch {
    threw = true;
  }
  check("a non-WebP RIFF file is rejected, not misclassified as an image", threw);
}

{
  const filePath = await withTempFile("notes.txt", "line one\nline two\nline three\n");
  const result = await readAttachment(filePath);
  check("a plain text file is classified as text", result.kind === "text");
  check("its content is read exactly", result.content === "line one\nline two\nline three\n");
  check("a small text file is not marked truncated", !result.truncated);
}

{
  const oversizedText = "x".repeat(200 * 1024 + 500);
  const filePath = await withTempFile("big.log", oversizedText);
  const result = await readAttachment(filePath);
  check("a text file over the 200KB cap is truncated, not rejected", result.kind === "text" && result.truncated === true);
  check("the truncated content ends with the truncation marker", result.content!.endsWith("\n…truncated…\n"));
  check("the truncated content is at or under the cap plus the marker's own length", result.content!.length <= 200 * 1024 + "\n…truncated…\n".length);
}

{
  // 6MB of PNG-signature-prefixed bytes — over the 5MB image cap.
  const oversizedImage = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(6 * 1024 * 1024, 0x55)]);
  const filePath = await withTempFile("huge.png", oversizedImage);
  let threw = false;
  let message = "";
  try {
    await readAttachment(filePath);
  } catch (err) {
    threw = true;
    message = err instanceof Error ? err.message : String(err);
  }
  check("an oversized image is rejected, not silently truncated", threw);
  check("the rejection message names the file and the limit", message.includes("huge.png") && message.includes("5MB"));
}

{
  // Random binary bytes that are neither a recognized image signature nor
  // valid UTF-8 text (a run of continuation-byte-shaped bytes with no
  // valid lead byte decodes with replacement characters).
  const binaryBytes = Buffer.from([0x80, 0x81, 0x82, 0xff, 0xfe, 0x80, 0x81, 0x82, 0xff, 0xfe]);
  const filePath = await withTempFile("mystery.bin", binaryBytes);
  let threw = false;
  try {
    await readAttachment(filePath);
  } catch {
    threw = true;
  }
  check("a binary file that isn't a recognized image is rejected", threw);
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm run build && node dist/test/attachments.test.js`
Expected: FAIL — `src/electron/attachments.ts` doesn't exist yet, so the build itself fails with "Cannot find module '../electron/attachments.js'".

- [ ] **Step 5: Write `src/electron/attachments.ts`**

```typescript
import fs from "node:fs/promises";
import path from "node:path";

export interface PickedAttachment {
  name: string;
  kind: "image" | "text";
  mediaType?: string;
  dataBase64?: string;
  content?: string;
  truncated?: boolean;
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_TEXT_BYTES = 200 * 1024; // 200KB
const TRUNCATION_MARKER = "\n…truncated…\n";

interface ImageSignature {
  mediaType: string;
  magic: number[];
}

const IMAGE_SIGNATURES: ImageSignature[] = [
  { mediaType: "image/png", magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mediaType: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  { mediaType: "image/gif", magic: [0x47, 0x49, 0x46, 0x38] }, // "GIF8"
  { mediaType: "image/webp", magic: [0x52, 0x49, 0x46, 0x46] }, // "RIFF" — confirmed as WebP separately below
];

/** Classifies by real bytes, never by filename extension. A RIFF container (the WebP signature) isn't exclusively WebP — e.g. WAV also starts with "RIFF" — so that one signature gets a second check for the "WEBP" fourCC at byte 8 before it's accepted. */
function detectImageMediaType(buf: Buffer): string | null {
  for (const sig of IMAGE_SIGNATURES) {
    if (buf.length < sig.magic.length) continue;
    if (!sig.magic.every((byte, i) => buf[i] === byte)) continue;
    if (sig.mediaType === "image/webp") {
      if (buf.length < 12 || buf.subarray(8, 12).toString("ascii") !== "WEBP") continue;
    }
    return sig.mediaType;
  }
  return null;
}

/**
 * Reads and classifies one picked file — an image (by magic-number
 * signature) or text (by UTF-8 validity), never by extension. Throws for
 * an oversized image or a file that's neither: the caller (the
 * agent:pick-attachments IPC handler, Task 6) catches per-file so one bad
 * file in a multi-file pick doesn't lose the others.
 */
export async function readAttachment(filePath: string): Promise<PickedAttachment> {
  const name = path.basename(filePath);
  const buf = await fs.readFile(filePath);

  const imageMediaType = detectImageMediaType(buf);
  if (imageMediaType) {
    if (buf.length > MAX_IMAGE_BYTES) {
      throw new Error(`${name}: image is too large (${(buf.length / 1024 / 1024).toFixed(1)}MB, limit is 5MB).`);
    }
    return { name, kind: "image", mediaType: imageMediaType, dataBase64: buf.toString("base64") };
  }

  // Buffer#toString("utf-8") never throws on invalid bytes — it silently
  // substitutes U+FFFD for anything that isn't valid UTF-8. A binary file
  // decoded this way is riddled with replacement characters; genuine text
  // has none. That's the actual signal a binary/unsupported file gets
  // rejected on, not a try/catch around the decode itself.
  const text = buf.toString("utf-8");
  if (text.includes("�")) {
    throw new Error(`${name}: not a recognized image and not valid UTF-8 text.`);
  }

  if (buf.length > MAX_TEXT_BYTES) {
    const truncatedText = Buffer.from(buf.subarray(0, MAX_TEXT_BYTES)).toString("utf-8");
    return { name, kind: "text", content: `${truncatedText}${TRUNCATION_MARKER}`, truncated: true };
  }

  return { name, kind: "text", content: text };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run build && node dist/test/attachments.test.js`
Expected: PASS — every check above prints `ok`.

- [ ] **Step 7: Wire the new test file into `package.json`'s `test` script**

In `package.json`, the `"test"` script is a single `&&`-chained line ending in
`... && node dist/test/checkpoints.test.js && node dist/test/changesSince.test.js`.
Append ` && node dist/test/attachments.test.js` to the end of that line.

- [ ] **Step 8: Run the full suite to confirm nothing else broke**

Run: `npm test`
Expected: `All tests passed.` at the end, with `attachments.test.js`'s own `ok` lines visible in the output.

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/electron/attachments.ts src/test/attachments.test.ts package.json
git commit -m "feat: attachment types and a content-sniffing file reader"
```

---

### Task 2: `AgentSession.run` accepts attachments

**Files:**
- Modify: `src/agent.ts`
- Modify: `src/test/agent.test.ts`

**Interfaces:**
- Consumes: `AttachedImage`, `AttachedText` from `src/types.ts` (Task 1).
- Produces: `AgentSession.run(task: string, attachments?: { images?: AttachedImage[]; textAttachments?: AttachedText[] }): AsyncGenerator<AgentEvent>` — the new second parameter, consumed by `sessionRegistry.ts` in Task 6.

- [ ] **Step 1: Write the failing test**

In `src/test/agent.test.ts`, add this new section right before the final `console.log("\nAgent loop (scripted debug-fix scenario):");` block (the same insertion point every other section in this file uses):

```typescript
console.log("\nAttachments thread through to the first pushed message:");
await (async () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const workspaceRoot = path.resolve(__dirname, "..", "..", "fixture-repo");

  {
    const script: ChatResponse[] = [{ turn: { type: "final", content: "got it" } }];
    const session = new AgentSession({
      workspaceRoot,
      model: "mock",
      provider: new MockProvider(script),
      tools: defaultToolRegistry(),
      permissionMode: "PLAN",
    });

    for await (const _event of session.run("look at this", {
      images: [{ name: "a.png", mediaType: "image/png", dataBase64: "abc123" }],
      textAttachments: [{ name: "b.txt", content: "hello" }],
    })) {
      // draining the generator is enough — the assertion below reads the session's own history
    }

    const messages = session.getMessages();
    const firstUserMessage = messages.find((m) => m.role === "user");
    check("the first user message carries the images unchanged", firstUserMessage?.images?.[0]?.name === "a.png" && firstUserMessage?.images?.[0]?.dataBase64 === "abc123");
    check("the first user message carries the textAttachments unchanged", firstUserMessage?.textAttachments?.[0]?.content === "hello");
  }

  {
    // No attachments passed at all — the existing zero-argument call
    // shape from every other test in this file must still work exactly
    // as before (images/textAttachments simply absent, not undefined
    // fields sitting on the message).
    const script: ChatResponse[] = [{ turn: { type: "final", content: "ok" } }];
    const session = new AgentSession({
      workspaceRoot,
      model: "mock",
      provider: new MockProvider(script),
      tools: defaultToolRegistry(),
      permissionMode: "PLAN",
    });
    for await (const _event of session.run("no attachments here")) {
      // drain
    }
    const firstUserMessage = session.getMessages().find((m) => m.role === "user");
    check("run() with no second argument still works, with no images field", firstUserMessage?.images === undefined);
    check("run() with no second argument still works, with no textAttachments field", firstUserMessage?.textAttachments === undefined);
  }
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node dist/test/agent.test.js`
Expected: FAIL on the two new checks — `session.run("look at this", {...})` type-checks today (TypeScript won't reject an extra argument to a function... actually it WILL, since `run(task: string)` takes exactly one parameter) — the build itself fails with "Expected 1 arguments, but got 2."

- [ ] **Step 3: Update `AgentSession.run`'s signature**

In `src/agent.ts`, add the import at the top (in the existing `import type { ... } from "./types.js"` block, which currently reads `AgentEvent, AgentState, ChatMessage, ModelProvider, PermissionMode, ProposedPlan, ToolCall`) — add `AttachedImage, AttachedText` to that same import list, alphabetized in:

```typescript
import type {
  AgentEvent,
  AgentState,
  AttachedImage,
  AttachedText,
  ChatMessage,
  ModelProvider,
  PermissionMode,
  ProposedPlan,
  ToolCall,
} from "./types.js";
```

Then change the `run` method's signature and its first line:

```typescript
  async *run(
    task: string,
    attachments?: { images?: AttachedImage[]; textAttachments?: AttachedText[] }
  ): AsyncGenerator<AgentEvent> {
    this.messages.push({ role: "user", content: task, ...attachments });
```

(Every line after that first `this.messages.push(...)` is unchanged — the turn loop, checkpoints, corrective nudge, and plan-first gate all just operate on `this.messages` the same way regardless of what this one message happens to carry.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node dist/test/agent.test.js`
Expected: PASS — all checks in the new section print `ok`, and every pre-existing check in this file (which calls `session.run(task)` with one argument everywhere) still passes unchanged.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `All tests passed.`

- [ ] **Step 6: Commit**

```bash
git add src/agent.ts src/test/agent.test.ts
git commit -m "feat: AgentSession.run accepts optional image/text attachments"
```

---

### Task 3: Claude vision support

**Files:**
- Modify: `src/providers/anthropicProvider.ts`
- Modify: `src/test/anthropicProvider.test.ts`

**Interfaces:**
- Consumes: `AttachedImage`, `AttachedText`, `ChatMessage.images`/`.textAttachments` from Task 1.
- Produces: nothing new consumed elsewhere — `toAnthropicMessages` is already exported and already the function every other task/test calls; only its internal handling of the `user` branch changes.

- [ ] **Step 1: Write the failing tests**

In `src/test/anthropicProvider.test.ts`, add this section right before the final `console.log(failures === 0 ...)` block:

```typescript
console.log("\nAttachments in toAnthropicMessages:");

{
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: "what's in this?",
      images: [{ name: "screenshot.png", mediaType: "image/png", dataBase64: "ZmFrZWRhdGE=" }],
    },
  ];
  const { messages: out } = toAnthropicMessages(messages);
  const userMsg = out[0];
  check("a message with an image becomes a content-block array, not a plain string", Array.isArray(userMsg?.content));
  const blocks = userMsg?.content as any[];
  check(
    "the image becomes a base64 image content block",
    JSON.stringify(blocks[0]) === JSON.stringify({ type: "image", source: { type: "base64", media_type: "image/png", data: "ZmFrZWRhdGE=" } })
  );
  check("the task text becomes a trailing text block", JSON.stringify(blocks[1]) === JSON.stringify({ type: "text", text: "what's in this?" }));
}

{
  // Attachment-only message (empty task text) — no text block at all,
  // not an empty one.
  const messages: ChatMessage[] = [
    { role: "user", content: "", images: [{ name: "a.png", mediaType: "image/png", dataBase64: "AAAA" }] },
  ];
  const { messages: out } = toAnthropicMessages(messages);
  const blocks = out[0]?.content as any[];
  check("an attachment-only message has exactly one block (the image, no empty text block)", blocks.length === 1 && blocks[0].type === "image");
}

{
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: "summarize this",
      textAttachments: [{ name: "notes.txt", content: "the key point is X" }],
    },
  ];
  const { messages: out } = toAnthropicMessages(messages);
  const blocks = out[0]?.content as any[];
  check("a text attachment folds into the trailing text block, not a separate document block", blocks.length === 1 && blocks[0].type === "text");
  check(
    "the folded text contains both the task text and the attachment's labeled content",
    blocks[0].text === "summarize this\n\n--- Attached file: notes.txt ---\nthe key point is X\n---"
  );
}

{
  // No attachments at all — content must stay a plain string exactly as
  // it always has, not become a single-element array (a behavior change
  // for the overwhelmingly common case would be a real regression).
  const messages: ChatMessage[] = [{ role: "user", content: "plain question" }];
  const { messages: out } = toAnthropicMessages(messages);
  check("a message with no attachments still has plain string content", out[0]?.content === "plain question");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node dist/test/anthropicProvider.test.js`
Expected: FAIL — today's `toAnthropicMessages` always does `result.push({ role: "user", content: m.content })`, so every new check that expects an array/blocks fails; the "no attachments" check already passes (it's a regression guard for step 3, not new behavior).

- [ ] **Step 3: Implement the attachment-folding in `toAnthropicMessages`**

In `src/providers/anthropicProvider.ts`, add this new helper function right after the `DEFAULT_MODEL_ID` constant and before `toAnthropicMessages`:

```typescript
/** The four image formats attachments.ts (Task 1) ever classifies as an image — the only ones Anthropic's base64 image source accepts. */
type AnthropicImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/**
 * Builds a user message's `content` — a plain string when there are no
 * attachments (unchanged from before this feature existed), or a
 * ContentBlockParam[] when there are: one image block per attached
 * image, then a single trailing text block combining the task text with
 * every attached text file, formatted the same way every provider folds
 * text attachments in (see openaiCompatible.ts and embeddedLlama.ts).
 * Omits the text block entirely for an attachment-only message with no
 * task text and no text attachments, rather than sending an empty one.
 */
function buildUserContent(m: ChatMessage): string | Anthropic.ContentBlockParam[] {
  if (!m.images?.length && !m.textAttachments?.length) return m.content;

  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const img of m.images ?? []) {
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType as AnthropicImageMediaType, data: img.dataBase64 },
    });
  }

  const textParts = [m.content, ...(m.textAttachments ?? []).map((a) => `\n\n--- Attached file: ${a.name} ---\n${a.content}\n---`)];
  const text = textParts.join("");
  if (text) blocks.push({ type: "text", text });

  return blocks;
}
```

Then change the `user`-role branch inside `toAnthropicMessages` from:

```typescript
    } else if (m.role === "user") {
      result.push({ role: "user", content: m.content });
```

to:

```typescript
    } else if (m.role === "user") {
      result.push({ role: "user", content: buildUserContent(m) });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node dist/test/anthropicProvider.test.js`
Expected: PASS — all new checks print `ok`, and every pre-existing check in this file (none of which set `images`/`textAttachments`) still passes unchanged.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `All tests passed.`

- [ ] **Step 6: Commit**

```bash
git add src/providers/anthropicProvider.ts src/test/anthropicProvider.test.ts
git commit -m "feat: real Claude vision support for attached images"
```

---

### Task 4: Custom-server provider — optimistic `image_url` support

**Files:**
- Modify: `src/providers/openaiCompatible.ts`
- Create: `src/test/openaiCompatible.test.ts`
- Modify: `package.json` (`test` script)

**Interfaces:**
- Consumes: `AttachedImage`, `AttachedText`, `ChatMessage.images`/`.textAttachments` from Task 1.
- Produces: `buildChatBody(request: ChatRequest): Record<string, unknown>` — a new exported pure function extracted from `OpenAICompatibleProvider.chat()`, so the request-building logic is unit-testable without a real HTTP server (mirrors `toAnthropicMessages`/`toLlamaHistory` already being pure, separately-exported, separately-tested functions in the other two providers).

- [ ] **Step 1: Write the failing tests**

Create `src/test/openaiCompatible.test.ts`:

```typescript
import { buildChatBody } from "../providers/openaiCompatible.js";
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

console.log("buildChatBody:");

{
  const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
  const body: any = buildChatBody({ model: "qwen2.5-coder:latest", messages });
  check("a plain message with no attachments keeps plain string content", body.messages[0].content === "hi");
}

{
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: "what's this",
      images: [{ name: "a.png", mediaType: "image/png", dataBase64: "ZmFrZQ==" }],
    },
  ];
  const body: any = buildChatBody({ model: "some-vision-model", messages });
  const parts = body.messages[0].content;
  check("a message with an image becomes a content-part array", Array.isArray(parts));
  check("the text part comes first", parts[0].type === "text" && parts[0].text === "what's this");
  check(
    "the image becomes an image_url part with a data URI",
    JSON.stringify(parts[1]) === JSON.stringify({ type: "image_url", image_url: { url: "data:image/png;base64,ZmFrZQ==" } })
  );
}

{
  const messages: ChatMessage[] = [
    { role: "user", content: "", images: [{ name: "a.png", mediaType: "image/png", dataBase64: "AAAA" }] },
  ];
  const body: any = buildChatBody({ model: "m", messages });
  const parts = body.messages[0].content;
  check("an attachment-only message has no leading empty text part", parts.length === 1 && parts[0].type === "image_url");
}

{
  const messages: ChatMessage[] = [
    { role: "user", content: "summarize", textAttachments: [{ name: "notes.txt", content: "key point: X" }] },
  ];
  const body: any = buildChatBody({ model: "m", messages });
  check(
    "a text attachment folds into the message's plain string content (no attachment array needed for text)",
    body.messages[0].content === "summarize\n\n--- Attached file: notes.txt ---\nkey point: X\n---"
  );
}

{
  // Existing behavior this task must not disturb: tool_calls / tool_call_id
  // / name still map through exactly as before.
  const messages: ChatMessage[] = [
    { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "read_file", arguments: { path: "a.js" } }] },
    { role: "tool", tool_call_id: "c1", name: "read_file", content: "file contents" },
  ];
  const body: any = buildChatBody({ model: "m", messages });
  check(
    "assistant tool_calls still map to the OpenAI function-call shape",
    JSON.stringify(body.messages[0].tool_calls) === JSON.stringify([{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.js"}' } }])
  );
  check("tool_call_id and name still pass through on a tool message", body.messages[1].tool_call_id === "c1" && body.messages[1].name === "read_file");
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node dist/test/openaiCompatible.test.js`
Expected: FAIL — the build fails first, since `buildChatBody` isn't exported (or doesn't exist) yet.

- [ ] **Step 3: Extract and update `buildChatBody` in `openaiCompatible.ts`**

In `src/providers/openaiCompatible.ts`, add this import and helper right after the existing `import type { ... } from "../types.js"` line:

```typescript
import type { ChatMessage } from "../types.js";
```

(add `ChatMessage` to the existing named-import list from `"../types.js"` rather than a second import line — the file's current import is `import type { ChatRequest, ChatResponse, ModelInfo, ModelProvider, ToolCall } from "../types.js";`, so the full updated line is:)

```typescript
import type { ChatMessage, ChatRequest, ChatResponse, ModelInfo, ModelProvider, ToolCall } from "../types.js";
```

Then add this helper function right after that import (before the `Options` interface):

```typescript
/**
 * Builds one message's `content` for the wire request — a plain string
 * when there are no attachments (unchanged from before this feature
 * existed), or a content-part array when there are: a leading text part
 * (task text plus every attached text file folded in, the same format
 * every provider uses), then one image_url part per attached image, sent
 * optimistically in the standard OpenAI vision format. Whether the
 * server/loaded model actually supports it is between it and the
 * request — an unsupported image surfaces as this provider's existing
 * `Provider error ${status}` path, nothing new needed for that.
 */
function buildMessageContent(m: ChatMessage): string | Array<Record<string, unknown>> {
  if (!m.images?.length && !m.textAttachments?.length) return m.content;

  const textParts = [m.content, ...(m.textAttachments ?? []).map((a) => `\n\n--- Attached file: ${a.name} ---\n${a.content}\n---`)];
  const text = textParts.join("");

  if (!m.images?.length) return text;

  const parts: Array<Record<string, unknown>> = [];
  if (text) parts.push({ type: "text", text });
  for (const img of m.images) {
    parts.push({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.dataBase64}` } });
  }
  return parts;
}

/** The request-body-building half of `chat()`, pulled out as its own pure, exported function so it's unit-testable without a real HTTP server — mirrors toAnthropicMessages/toLlamaHistory in the other two providers. */
export function buildChatBody(request: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map((m) => ({
      role: m.role,
      content: buildMessageContent(m),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.name ? { name: m.name } : {}),
      ...(m.tool_calls
        ? {
            tool_calls: m.tool_calls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            })),
          }
        : {}),
    })),
    max_tokens: request.maxTokens ?? 2048,
  };

  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }

  return body;
}
```

Finally, in `chat()`, replace this exact existing block:

```typescript
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.name ? { name: m.name } : {}),
        ...(m.tool_calls
          ? {
              tool_calls: m.tool_calls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
              })),
            }
          : {}),
      })),
      max_tokens: request.maxTokens ?? 2048,
    };

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }

    const res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
```

with:

```typescript
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body = buildChatBody(request);

    const res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
```

(Everything from `const res = await fetch(...)` to the end of `chat()` — headers, error handling, response parsing — is unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node dist/test/openaiCompatible.test.js`
Expected: PASS — all checks print `ok`.

- [ ] **Step 5: Wire the new test file into `package.json`'s `test` script**

Append ` && node dist/test/openaiCompatible.test.js` to the end of the `"test"` script line (after the `attachments.test.js` entry Task 1 added).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: `All tests passed.`

- [ ] **Step 7: Commit**

```bash
git add src/providers/openaiCompatible.ts src/test/openaiCompatible.test.ts package.json
git commit -m "feat: custom-server provider sends attachments in the standard OpenAI vision format"
```

---

### Task 5: Embedded local provider — honest "can't see images" fallback

**Files:**
- Modify: `src/providers/embeddedLlama.ts`
- Modify: `src/test/agent.test.ts`

**Interfaces:**
- Consumes: `AttachedImage`, `AttachedText`, `ChatMessage.images`/`.textAttachments` from Task 1.
- Produces: nothing new consumed elsewhere — `toLlamaHistory` is already exported and already the function `src/test/agent.test.ts`'s "Embedded llama provider conversion" section calls; only its `user` branch changes.

- [ ] **Step 1: Write the failing tests**

In `src/test/agent.test.ts`, find the existing `"\nEmbedded llama provider conversion:"` section (it starts with `check("toLlamaHistory converts plain system/user/assistant turns", ...)`). Add these new checks immediately after the last check in that section, still inside the same `{ ... }` block structure the section already uses (i.e., as new standalone `{ ... }` blocks right after it, before the next `console.log("\n...")` line):

```typescript
{
  const history = toLlamaHistory([
    { role: "user", content: "what's this", images: [{ name: "photo.png", mediaType: "image/png", dataBase64: "AAAA" }] },
  ]);
  check(
    "an attached image folds into the user turn's text as an honest can't-see-images note, not silently dropped",
    history[0]?.type === "user" && (history[0] as any).text === "what's this\n\n[Attached image: photo.png — this local model can't see images.]"
  );
}

{
  const history = toLlamaHistory([
    { role: "user", content: "summarize", textAttachments: [{ name: "notes.txt", content: "key point: X" }] },
  ]);
  check(
    "a text attachment folds in exactly like the other two providers",
    history[0]?.type === "user" && (history[0] as any).text === "summarize\n\n--- Attached file: notes.txt ---\nkey point: X\n---"
  );
}

{
  const history = toLlamaHistory([{ role: "user", content: "plain question" }]);
  check("a message with no attachments is unaffected", history[0]?.type === "user" && (history[0] as any).text === "plain question");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node dist/test/agent.test.js`
Expected: FAIL on the first two new checks — today's `toLlamaHistory` always does `history.push({ type: "user", text: m.content })`, ignoring `images`/`textAttachments` entirely, so the image note and the text-attachment fold-in are both missing from the actual text.

- [ ] **Step 3: Implement the fold-in in `toLlamaHistory`**

In `src/providers/embeddedLlama.ts`, add this helper function right after the imports and before `toLlamaHistory`:

```typescript
/**
 * Builds a user turn's text — the task text plus, for each attachment,
 * an honest note folded in as plain text. Images specifically: this app
 * never loads a vision-projector model alongside the text GGUF, so a
 * locally-running model genuinely cannot see an attached image — saying
 * so directly (rather than silently dropping it, or pretending it was
 * seen) is what lets the model itself tell the user it can't help with
 * that part, instead of confusingly ignoring the request. Text
 * attachments have no such limitation and fold in exactly like the
 * other two providers.
 */
function buildUserText(m: ChatMessage): string {
  let text = m.content;
  for (const img of m.images ?? []) {
    text += `\n\n[Attached image: ${img.name} — this local model can't see images.]`;
  }
  for (const att of m.textAttachments ?? []) {
    text += `\n\n--- Attached file: ${att.name} ---\n${att.content}\n---`;
  }
  return text;
}
```

Then change the `user`-role branch inside `toLlamaHistory` from:

```typescript
    } else if (m.role === "user") {
      history.push({ type: "user", text: m.content });
```

to:

```typescript
    } else if (m.role === "user") {
      history.push({ type: "user", text: buildUserText(m) });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node dist/test/agent.test.js`
Expected: PASS — all new checks print `ok`, and every other check in this file's much larger test suite (checkpoints, plan-first, corrective nudge, etc. — none of which touch `toLlamaHistory`'s user-message text directly) still passes unchanged.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `All tests passed.`

- [ ] **Step 6: Commit**

```bash
git add src/providers/embeddedLlama.ts src/test/agent.test.ts
git commit -m "feat: embedded provider folds in attachments honestly (text works, images get an explicit can't-see note)"
```

---

### Task 6: sessionRegistry + IPC wiring

**Files:**
- Modify: `src/electron/sessionRegistry.ts`
- Modify: `src/electron/main.ts`
- Modify: `src/electron/preload.cjs`
- Modify: `src/test/sessionRegistry.test.ts`

**Interfaces:**
- Consumes: `AttachedImage`, `AttachedText` (Task 1), `AgentSession.run(task, attachments?)` (Task 2), `readAttachment` (Task 1).
- Produces: `runTask(registry, sessionId, task, onEvent, attachments?)` (new optional 5th param, `sessionRegistry.ts`), IPC channel `agent:pick-attachments` → `{ attachments: PickedAttachment[]; errors: { name: string; error: string }[] }`, `agent:run-task` IPC handler accepts an optional 4th argument, `window.agent.pickAttachments()` and `window.agent.runTask(sessionId, task, attachments?)` (renderer bridge, consumed by Task 7).

- [ ] **Step 1: Write the failing test**

In `src/test/sessionRegistry.test.ts`, add this new block right after the existing `respondPlan`/`updateLiveSessionSettings` blocks added for the plan-first feature (i.e., right before the section that removes `sessionsDir` at the very end of the file — find the exact insertion point by locating the last `{ ... }` block before `await fs.rm(sessionsDir, { recursive: true, force: true });`):

```typescript
  {
    // Real end-to-end: attachments passed to runTask actually reach the
    // first pushed message, proving the plumbing through doRunTask ->
    // AgentSession.run is wired, not just type-compatible.
    const registry = createSessionRegistry(sessionsDir);
    const script: ChatResponse[] = [{ turn: { type: "final", content: "got it" } }];
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider(script) }
    );

    await runTask(registry, sessionId, "look at this", () => {}, {
      images: [{ name: "a.png", mediaType: "image/png", dataBase64: "AAAA" }],
    });

    const snapshot = getLiveSessionSnapshot(registry, sessionId);
    const firstUserMessage = snapshot?.messages.find((m) => m.role === "user");
    check("runTask's attachments argument reaches the session's actual message history", firstUserMessage?.images?.[0]?.name === "a.png");
  }
```

(This uses `getLiveSessionSnapshot`, `startSession`, `runTask`, `createSessionRegistry`, `MockProvider`, and `check` — all already imported/defined earlier in this test file; no new imports needed for this block itself.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node dist/test/sessionRegistry.test.js`
Expected: FAIL — the build fails first, since `runTask` doesn't accept a 5th argument yet ("Expected 4 arguments, but got 5").

- [ ] **Step 3: Add the attachments parameter to `runTask`/`doRunTask`**

In `src/electron/sessionRegistry.ts`, add `AttachedImage, AttachedText` to the existing `import type { AgentEvent, ChatMessage, ModelProvider, PermissionMode } from "../types.js";` line, making it:

```typescript
import type { AgentEvent, AttachedImage, AttachedText, ChatMessage, ModelProvider, PermissionMode } from "../types.js";
```

Then change `doRunTask`'s signature and its call into `entry.session.run`:

```typescript
async function doRunTask(
  registry: SessionRegistry,
  sessionId: string,
  entry: SessionEntry,
  task: string,
  onEvent: (event: AgentEvent) => void,
  attachments?: { images?: AttachedImage[]; textAttachments?: AttachedText[] }
): Promise<void> {
  if (entry.title === null) {
    entry.title = task.length > 60 ? `${task.slice(0, 60)}…` : task;
  }

  try {
    for await (const event of entry.session.run(task, attachments)) {
      entry.events.push(event);
      onEvent(event);
      if (event.type === "done") {
        await persistSession(registry, sessionId, entry).catch(() => {});
      }
    }
  } catch (err: any) {
    const errorEvent: AgentEvent = { type: "error", message: `Unexpected session error: ${err.message}` };
    const doneEvent: AgentEvent = { type: "done", success: false, summary: "Unexpected error." };
    entry.events.push(errorEvent, doneEvent);
    onEvent(errorEvent);
    onEvent(doneEvent);
    await persistSession(registry, sessionId, entry).catch(() => {});
  }
}
```

(Only the signature and the `entry.session.run(task)` → `entry.session.run(task, attachments)` call change — the rest of the function body, including the persisting-on-"done" comment above it, is unchanged.)

Then change `runTask`'s signature and its call into `doRunTask`:

```typescript
export async function runTask(
  registry: SessionRegistry,
  sessionId: string,
  task: string,
  onEvent: (event: AgentEvent) => void,
  attachments?: { images?: AttachedImage[]; textAttachments?: AttachedText[] }
): Promise<void> {
  const entry = registry.sessions.get(sessionId);
  if (!entry) throw new Error(`Unknown session: ${sessionId}`);

  const runPromise = doRunTask(registry, sessionId, entry, task, onEvent, attachments);
  entry.running = runPromise;
  try {
    await runPromise;
  } finally {
    if (entry.running === runPromise) entry.running = null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node dist/test/sessionRegistry.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `All tests passed.`

- [ ] **Step 6: Add the IPC wiring (no automated test — Electron-only, matches this project's established treatment; verified live in Task 7)**

In `src/electron/main.ts`:

Add `readAttachment` and the `PickedAttachment` type to imports — right after the existing block of `./` imports near the top of the file, add:

```typescript
import { readAttachment, type PickedAttachment } from "./attachments.js";
```

Change the existing `agent:run-task` handler from:

```typescript
  ipcMain.handle("agent:run-task", (event, sessionId: string, task: string) =>
    runTask(registry, sessionId, task, (agentEvent) => {
      event.sender.send("agent:event", sessionId, agentEvent);
    })
  );
```

to:

```typescript
  ipcMain.handle(
    "agent:run-task",
    (event, sessionId: string, task: string, attachments?: { images?: AttachedImage[]; textAttachments?: AttachedText[] }) =>
      runTask(
        registry,
        sessionId,
        task,
        (agentEvent) => {
          event.sender.send("agent:event", sessionId, agentEvent);
        },
        attachments
      )
  );
```

(Add `AttachedImage, AttachedText` to whatever existing `import type { ... } from "../types.js"` — or wherever `PermissionMode` is already imported from in this file — line already exists in `main.ts`, the same way Task 6's Step 3 did in `sessionRegistry.ts`.)

Add a new handler right after it, for picking attachments — following the exact same `dialog.showOpenDialog` pattern the existing `agent:pick-workspace` handler already uses (elsewhere in this same file):

```typescript
  ipcMain.handle("agent:pick-attachments", async () => {
    const result = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"] });
    if (result.canceled) return { attachments: [], errors: [] };

    const attachments: PickedAttachment[] = [];
    const errors: { name: string; error: string }[] = [];
    for (const filePath of result.filePaths) {
      try {
        attachments.push(await readAttachment(filePath));
      } catch (err) {
        errors.push({ name: path.basename(filePath), error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { attachments, errors };
  });
```

(`path` is already imported in `main.ts` at the top of the file — `import path from "node:path";` — confirmed; no new import needed for `path.basename`.)

In `src/electron/preload.cjs`, change the existing `runTask` bridge entry from:

```javascript
  runTask: (sessionId, task) => ipcRenderer.invoke("agent:run-task", sessionId, task),
```

to:

```javascript
  runTask: (sessionId, task, attachments) => ipcRenderer.invoke("agent:run-task", sessionId, task, attachments),
```

Add a new bridge entry right after `pickWorkspace`:

```javascript
  pickAttachments: () => ipcRenderer.invoke("agent:pick-attachments"),
```

- [ ] **Step 7: Run the build**

Run: `npm run build`
Expected: succeeds with no errors.

- [ ] **Step 8: Commit**

```bash
git add src/electron/sessionRegistry.ts src/electron/main.ts src/electron/preload.cjs src/test/sessionRegistry.test.ts
git commit -m "feat: thread attachments through runTask and add the pick-attachments IPC channel"
```

---

### Task 7: Composer UI — attach button, chips, and wiring

**Files:**
- Modify: `src/electron/renderer/index.html`
- Modify: `src/electron/renderer/renderer.ts`
- Modify: `src/electron/renderer/styles.css`

**Interfaces:**
- Consumes: `window.agent.pickAttachments()`, `window.agent.runTask(sessionId, task, attachments?)` (Task 6).

- [ ] **Step 1: Add the attach button and chip row to `index.html`**

In `src/electron/renderer/index.html`, the composer currently reads:

```html
          <div class="row" id="composer-row">
            <textarea id="task-input" placeholder="Describe the task…" disabled></textarea>
            <button id="run-task" class="primary" disabled>Run</button>
          </div>
          <div id="task-input-hint" class="hint-text">Enter to run · Shift+Enter for a new line</div>
```

Change it to:

```html
          <div id="attachment-chips" hidden></div>
          <div class="row" id="composer-row">
            <button id="attach-file" type="button" disabled title="Attach a file (text or image)" aria-label="Attach a file">📎</button>
            <textarea id="task-input" placeholder="Describe the task…" disabled></textarea>
            <button id="run-task" class="primary" disabled>Run</button>
          </div>
          <div id="task-input-hint" class="hint-text">Enter to run · Shift+Enter for a new line · up to 5 attachments per task</div>
```

- [ ] **Step 2: Add the byId references and `AgentBridge` interface entries in `renderer.ts`**

In `src/electron/renderer/renderer.ts`, add `AttachedImage, AttachedText` to the existing `import type { AgentEvent, ChatMessage, PermissionMode, ProposedPlan, ToolCall } from "../../types.js";` line:

```typescript
import type { AgentEvent, AttachedImage, AttachedText, ChatMessage, PermissionMode, ProposedPlan, ToolCall } from "../../types.js";
```

Add a second type-only import right after it, reusing `PickedAttachment` from Task 1/6 rather than redefining its shape here (the same "import a type-only from a main-process file" pattern the file already uses for `import type { ProviderConfig, SessionConfig } from "../sessionRegistry.js";`):

```typescript
import type { PickedAttachment } from "../attachments.js";
```

In the `AgentBridge` interface, add these two entries (right after the existing `runTask(sessionId: string, task: string): Promise<void>;` entry, which itself needs its signature updated):

```typescript
  runTask(sessionId: string, task: string, attachments?: { images?: AttachedImage[]; textAttachments?: AttachedText[] }): Promise<void>;
  pickAttachments(): Promise<{ attachments: PickedAttachment[]; errors: { name: string; error: string }[] }>;
```

Add these `byId` references right after the existing `const runTaskBtn = byId<HTMLButtonElement>("run-task");` line:

```typescript
const attachFileBtn = byId<HTMLButtonElement>("attach-file");
const attachmentChipsRow = byId<HTMLDivElement>("attachment-chips");
```

- [ ] **Step 3: Add pending-attachments state and chip rendering**

Add this block right after the `const toolCards = new Map<string, HTMLElement>();` line (the same place other module-level mutable state like `editingSession` already lives):

```typescript
const MAX_ATTACHMENTS_PER_TASK = 5;

let pendingAttachments: PickedAttachment[] = [];

/**
 * Builds one chip — shared by the composer's removable row (Step 3 below)
 * and the read-only copy shown under a sent task's `.log-task` bubble
 * (Step 5), so what a chip looks like is defined in exactly one place.
 * `onRemove` omitted means read-only: no × button.
 */
function buildAttachmentChip(attachment: PickedAttachment, onRemove?: () => void): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "attachment-chip";
  const icon = document.createElement("span");
  icon.className = "attachment-chip-icon";
  icon.textContent = attachment.kind === "image" ? "🖼" : "📄";
  chip.appendChild(icon);
  const label = document.createElement("span");
  label.textContent = attachment.name;
  chip.appendChild(label);
  if (attachment.truncated) {
    const badge = document.createElement("span");
    badge.className = "attachment-chip-truncated";
    badge.textContent = "truncated";
    chip.appendChild(badge);
  }
  if (onRemove) {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "attachment-chip-remove";
    removeBtn.textContent = "×";
    removeBtn.setAttribute("aria-label", `Remove ${attachment.name}`);
    removeBtn.addEventListener("click", onRemove);
    chip.appendChild(removeBtn);
  }
  return chip;
}

/** Rebuilds the composer's chip row from `pendingAttachments` — called after every add/remove, same "just re-render from state" pattern renderSessionList already uses for the sidebar. */
function renderAttachmentChips(): void {
  attachmentChipsRow.innerHTML = "";
  attachmentChipsRow.hidden = pendingAttachments.length === 0;
  for (const [index, attachment] of pendingAttachments.entries()) {
    attachmentChipsRow.appendChild(
      buildAttachmentChip(attachment, () => {
        pendingAttachments = pendingAttachments.filter((_, i) => i !== index);
        renderAttachmentChips();
      })
    );
  }
}
```

- [ ] **Step 4: Wire the attach button**

Add this event listener right after `renderAttachmentChips`'s definition:

```typescript
attachFileBtn.addEventListener("click", () => {
  void withBusyLabel(attachFileBtn, "…", async () => {
    const remaining = MAX_ATTACHMENTS_PER_TASK - pendingAttachments.length;
    if (remaining <= 0) {
      logLine(`[attachments] Already at the ${MAX_ATTACHMENTS_PER_TASK}-attachment limit for this task — remove one before adding another.`, "log-error");
      return;
    }
    const { attachments, errors } = await window.agent.pickAttachments();
    for (const err of errors) {
      logLine(`[attachments] Couldn't attach ${err.name}: ${err.error}`, "log-error");
    }
    const accepted = attachments.slice(0, remaining);
    if (attachments.length > accepted.length) {
      logLine(`[attachments] Only added ${accepted.length} of ${attachments.length} picked files — the ${MAX_ATTACHMENTS_PER_TASK}-attachment limit was reached.`, "log-error");
    }
    pendingAttachments = [...pendingAttachments, ...accepted];
    renderAttachmentChips();
  });
});
```

- [ ] **Step 5: Enable/disable the attach button alongside the rest of the composer, and pass attachments through on Run**

The attach button starts `disabled` in `index.html` (matching `task-input`/`run-task`, which only unlock once a session starts). Find every place `taskInput.disabled` is set in `renderer.ts` (in `beginSession`'s success path, `resetToSetup`, and anywhere else it's toggled) and add the identical line for `attachFileBtn.disabled` right next to each one — e.g. wherever the file currently has `taskInput.disabled = false;`, add `attachFileBtn.disabled = false;` immediately after it, and wherever it has `taskInput.disabled = true;`, add `attachFileBtn.disabled = true;` immediately after it.

Then change `runTaskBtn`'s click handler from:

```typescript
runTaskBtn.addEventListener("click", async () => {
  if (!sessionId || !taskInput.value.trim()) return;
  toolCards.clear();
  runTaskBtn.disabled = true;
  const task = taskInput.value;
  logLine(task, "log-task");
  await window.agent.runTask(sessionId, task);
  await refreshSessionList(sessionSearchInput.value.trim());
});
```

to:

```typescript
runTaskBtn.addEventListener("click", async () => {
  if (!sessionId || !taskInput.value.trim()) return;
  toolCards.clear();
  runTaskBtn.disabled = true;
  const task = taskInput.value;
  const sentAttachments = pendingAttachments;

  logLine(task, "log-task");
  // A read-only copy of the same chips shown under the sent task bubble,
  // so the log reflects exactly what went out — same chip look as the
  // composer's removable row, just without the × (buildAttachmentChip
  // with no onRemove argument), and appended as the log-task line's next
  // sibling rather than inside it.
  if (sentAttachments.length > 0) {
    const sentChipsRow = document.createElement("div");
    sentChipsRow.className = "attachment-chips sent";
    for (const attachment of sentAttachments) {
      sentChipsRow.appendChild(buildAttachmentChip(attachment));
    }
    eventLog.appendChild(sentChipsRow);
    eventLog.scrollTop = eventLog.scrollHeight;
  }

  const images = sentAttachments.filter((a) => a.kind === "image");
  const textAttachments = sentAttachments.filter((a) => a.kind === "text");
  const attachments = sentAttachments.length > 0
    ? {
        images: images.map((img) => ({ name: img.name, mediaType: img.mediaType!, dataBase64: img.dataBase64! })),
        textAttachments: textAttachments.map((t) => ({ name: t.name, content: t.content! })),
      }
    : undefined;

  pendingAttachments = [];
  renderAttachmentChips();
  await window.agent.runTask(sessionId, task, attachments);
  await refreshSessionList(sessionSearchInput.value.trim());
});
```

- [ ] **Step 6: Clear pending attachments on session reset**

In `resetToSetup()`, add these two lines anywhere alongside the other UI-reset lines (e.g. right next to where `taskInput.value = "";` already is):

```typescript
  pendingAttachments = [];
  renderAttachmentChips();
```

- [ ] **Step 7: Add the CSS**

In `src/electron/renderer/styles.css`, add this block right after the existing `#composer-row { ... }` rule:

```css
#attach-file {
  width: 34px;
  height: 34px;
  border-radius: 6px;
  padding: 0;
  font-size: 16px;
  line-height: 1;
  flex-shrink: 0;
  align-self: flex-end;
}

#attachment-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 16px 0;
}

#attachment-chips[hidden] {
  display: none;
}

/* The read-only copy shown under a sent task's .log-task bubble in the
   event log (a plain class, not the #attachment-chips id — a separate
   element in a separate part of the page) — same chip look, just without
   the composer row's outer padding, since .log-task already sits inside
   #event-log's own padded flex column. */
.attachment-chips.sent {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-left: 12px;
}

.attachment-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 3px 8px;
  font-size: 11px;
  color: var(--text);
}

.attachment-chip-icon {
  font-size: 11px;
}

.attachment-chip-truncated {
  color: var(--warn);
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.attachment-chip-remove {
  background: transparent;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  padding: 0;
  font-size: 13px;
  line-height: 1;
}

.attachment-chip-remove:hover {
  color: var(--danger);
}
```

- [ ] **Step 8: Build**

Run: `npm run build`
Expected: succeeds with no errors.

- [ ] **Step 9: Live-verify with Playwright**

This project verifies every Electron/renderer change live rather than with an automated test (established pattern — see e.g. the changes-panel and plan-first features). Follow that same process:

1. `npm install --no-save playwright-core`
2. Write a throwaway script (same shape as the plan-first live-verification script) that: launches the real dev Electron app, stubs `dialog.showOpenDialog` via `electronApp.evaluate` to return one real temp text file and one real temp PNG (two calls — `agent:pick-workspace` returns a directory, `agent:pick-attachments` returns files, so the stub needs to branch on `properties` or be swapped between the two calls), starts a session against a scripted stub OpenAI-compatible HTTP server, clicks `#attach-file`, confirms two chips render in `#attachment-chips` with the right icons, removes one chip and confirms it's gone, runs a task and confirms `window.agent.runTask` was called with the remaining attachment (assert via the stub server's received request body — the image should show up as an `image_url` part per Task 4), confirms the composer's chip row clears after sending, and confirms a read-only chip (`.attachment-chips.sent .attachment-chip`, no `.attachment-chip-remove` button inside it) appears in the event log under the sent task bubble.
3. Take a screenshot of the composer with chips visible; read it back to confirm the visual result.
4. Clean up: delete the throwaway script, `npm uninstall playwright-core`, and check `~/Library/Application Support/localagent/sessions/` for a stray test session record the same way every prior live-verification pass in this project has (delete it and its `index.json` entry if one was created).

- [ ] **Step 10: Run the full test suite one more time**

Run: `npm test`
Expected: `All tests passed.` — this task added no new automated tests of its own (Electron/UI code, per this project's consistent pattern), so this just confirms nothing from Tasks 1-6 regressed.

- [ ] **Step 11: Commit**

```bash
git add src/electron/renderer/index.html src/electron/renderer/renderer.ts src/electron/renderer/styles.css
git commit -m "feat: attach-file button, removable chips, and wiring into runTask"
```

---

## After all tasks

Update `CHANGELOG.md` with a new entry (following the exact format every prior beta entry in that file already uses) describing the feature: attach text and image files to a task, from anywhere on disk; Claude sees images for real, custom servers get them optimistically, the embedded local model gets an honest text note instead of silently ignoring them. Bump `package.json`'s version, tag, and ship a new beta release — following this project's own established release process (build, full test suite, merge to main, push, tag `vX.Y.Z-beta.N`, watch the GitHub Actions release run to completion, confirm all 6 assets present on the release).
