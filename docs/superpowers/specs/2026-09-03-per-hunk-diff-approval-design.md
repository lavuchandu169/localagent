# Per-hunk diff approval — design spec

Date: 2026-09-03

## Purpose

Today, approving an `edit_file` permission request is all-or-nothing: the
model's proposed full-file rewrite either gets written verbatim or gets
rejected entirely. For a bigger AI-driven change touching several distinct
parts of a file, a user who agrees with most of it but not one specific
change has no way to say so — they either accept a change they didn't
want, or reject the whole edit and lose the parts they did want. This lets
a user check/uncheck individual hunks in the diff before approving, and
only those hunks actually get written.

## Scope

Applies only where a diff is already shown today: an `edit_file` call whose
permission decision is `ASK` (`DEFAULT` mode's normal write-gating, or the
existing "model rewrote a file it never read" auto-escalation to `ASK`
even in auto-approve modes). Every other call type (`run_command`,
`read_file`, etc.) is unaffected — they have no diff and nothing to select.
`ACCEPT_EDITS`/`AUTO_SAFE` auto-approved edits (decision `ALLOW`) still
show a read-only diff exactly as today, no checkboxes — there's no prompt
to attach them to.

## Core idea: hunks, not lines

`diffLines` (already used by `computeFileDiff`) returns a flat `Change[]`
— alternating blocks of unchanged/removed/added lines. A **hunk** is one
unit of actual change: a `removed` block immediately followed by an
`added` block (a replacement), a standalone `added` block (a pure
insertion), or a standalone `removed` block (a pure deletion). Unchanged
blocks are **context** — always included, never selectable.

```typescript
// src/diffUtil.ts
export type DiffSegment =
  | { kind: "context"; value: string }
  | { kind: "hunk"; id: number; removedValue?: string; addedValue?: string };

export function groupDiffIntoSegments(diff: Change[]): DiffSegment[];

/**
 * Reconstructs a full file content string from a diff's segments and a set
 * of approved hunk ids: context passes through unchanged; an approved hunk
 * contributes its addedValue (or nothing, for an approved deletion); a
 * rejected hunk contributes its removedValue instead (or nothing, for a
 * rejected pure insertion) — i.e. a rejected hunk's lines simply stay as
 * they were before the edit.
 */
export function applyHunkSelection(segments: DiffSegment[], approvedHunkIds: Set<number>): string;
```

Two properties make this easy to trust and easy to test: approving every
hunk id reconstructs `newContent` exactly; approving no hunk ids
reconstructs `oldContent` exactly. Both are round-trip tests, not just
spot checks.

## The approval response grows a hunk selection

```typescript
// src/types.ts
export interface PermissionResponse {
  approved: boolean;
  /** Only meaningful for an edit_file call with a diff — the DiffSegment hunk ids to actually apply. Omitted, or covering every hunk id in the diff, behaves exactly like today's "approve everything unmodified." Ignored when approved is false. */
  approvedHunkIds?: number[];
}
```

`AgentSession.opts.onApprovalNeeded` changes from
`(call: ToolCall) => Promise<boolean>` to
`(call: ToolCall) => Promise<PermissionResponse>`. In the tool-call loop,
when `decision === "ASK"`:

```typescript
const response = this.opts.onApprovalNeeded ? await this.opts.onApprovalNeeded(call) : { approved: false };
if (!response.approved) { /* same DENY-message path as today */ continue; }

let effectiveCall = call;
if (call.name === "edit_file" && diff && response.approvedHunkIds) {
  const segments = groupDiffIntoSegments(diff);
  const allHunkIds = new Set(segments.filter((s) => s.kind === "hunk").map((s) => s.id));
  const approvedSet = new Set(response.approvedHunkIds);
  const isPartial = [...allHunkIds].some((id) => !approvedSet.has(id));
  if (isPartial) {
    const mergedContent = applyHunkSelection(segments, approvedSet);
    effectiveCall = { ...call, arguments: { ...call.arguments, content: mergedContent } };
    yield { type: "status", message: `Applying ${approvedSet.size} of ${allHunkIds.size} proposed changes to ${call.arguments.path} — the rest were left as-is.` };
  }
}
// tool.execute(effectiveCall.arguments, ctx) below, using effectiveCall instead of call
```

The model's own turn history (the `assistant` message with its original
`tool_calls`) is never rewritten — that stays what the model actually
said. Only the arguments actually handed to `tool.execute` change, and
the emitted `status` event is how the human-visible log (and the model's
own next-turn context, via the existing tool-result message) reflects
that only part of the proposal landed. A full approval (every hunk
approved, or no `approvedHunkIds` at all — the common case) behaves
byte-for-byte like today: no status line, no content rewrite.

## IPC

`respondPermission` grows an optional 4th argument, carried straight
through the existing chain (preload → `agent:respond-permission` handler →
`sessionRegistry.respondPermission` → the pending approval's `resolve`):

```typescript
// preload.cjs
respondPermission: (sessionId, callId, approved, approvedHunkIds) =>
  ipcRenderer.invoke("agent:respond-permission", sessionId, callId, approved, approvedHunkIds),
```

```typescript
// sessionRegistry.ts
export function respondPermission(registry: SessionRegistry, sessionId: string, callId: string, approved: boolean, approvedHunkIds?: number[]): void {
  ...
  resolve({ approved, approvedHunkIds });
}
```

`pendingApprovals: Map<string, (response: PermissionResponse) => void>`
(was `(approved: boolean) => void`) — `finalizeEntry`'s cleanup resolves
with `{ approved: false }` instead of `false`.

## UI

`renderDiff` is rebuilt on top of `groupDiffIntoSegments` instead of the
raw flat `Change[]`: context segments render exactly as today (no
checkbox); a hunk segment gets one checkbox above its removed/added
lines, **checked by default** (matches today's implicit "approve
everything"), with a stable `data-hunk-id` so the click handler can read
back which ones are still checked when Approve is clicked. The
Approve/Deny buttons and their labels don't change — Approve always means
"apply whatever's currently checked," which is everything unless the user
unchecked something.

```typescript
const respond = (approved: boolean) => {
  approve.disabled = true;
  deny.disabled = true;
  prompt.classList.add("permission-resolved");
  const approvedHunkIds = approved
    ? Array.from(card.querySelectorAll<HTMLInputElement>(".diff-hunk-toggle input:checked")).map((el) => Number(el.dataset.hunkId))
    : undefined;
  if (sessionId) void window.agent.respondPermission(sessionId, event.call.id, approved, approvedHunkIds);
};
```

A non-`edit_file` permission request (no diff) renders exactly as today —
`groupDiffIntoSegments` is only ever called when `event.diff` exists, so
`renderDiff`'s no-diff callers are entirely unaffected.

## Error handling

- `applyHunkSelection` never throws — every segment either has a value to
  contribute or contributes nothing (a pure-insertion hunk rejected, or a
  pure-deletion hunk approved, both correctly contribute the empty
  string). No new failure mode versus today's whole-file write.
- If `response.approvedHunkIds` names an id that doesn't exist in the
  current diff (stale click, race against a session that moved on) —
  `approvedSet.has(id)` for a real hunk simply won't match anything odd;
  extra unknown ids in the set are harmless no-ops, never an error.

## Testing

`groupDiffIntoSegments`/`applyHunkSelection` get real unit tests in
`src/test/diffUtil.test.ts`: a pure replacement (one hunk), a pure
insertion, a pure deletion, multiple hunks in one diff (confirming
distinct, stable ids), and the two round-trip properties (approve-all
reconstructs `newContent` exactly, approve-none reconstructs `oldContent`
exactly) plus one hand-picked mixed-selection case with an explicit
expected string.

`AgentSession`'s tool-call loop gets `MockProvider`-driven tests in
`src/test/agent.test.ts`: a full-approval response (no `approvedHunkIds`,
or one covering every hunk) writes the model's original content
unmodified and emits no extra status line; a partial-approval response
writes the correctly-merged content and does emit the status line; a
deny response is completely unaffected by any of this (no hunk-selection
logic runs at all).

Electron IPC/main.ts/renderer UI changes get no automated test — this
project's consistent treatment of Electron-only code — verified live via
the same real-app-plus-CDP technique used for the last two features:
render a real multi-hunk diff, uncheck one hunk, click Approve, confirm
the file on disk only has the checked hunks' changes applied.

## Out of scope

- Per-line (rather than per-hunk) selection — a hunk is already the
  smallest unit a real diff naturally groups into; going finer would need
  synthesizing new hunk boundaries mid-block, not just reading the ones
  `diffLines` already produces.
- Any change to `run_command`'s approval flow, or to `PLAN` mode (which
  refuses all edits regardless).
- Editing the diff's content directly in the UI before approving — this
  is selection of the model's own proposed hunks, not a text editor.
