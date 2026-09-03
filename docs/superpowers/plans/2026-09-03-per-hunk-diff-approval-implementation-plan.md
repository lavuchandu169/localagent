# Per-Hunk Diff Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user check/uncheck individual hunks in an `edit_file` permission prompt's diff before approving, so only the checked hunks actually get written to disk.

**Architecture:** A pure `diffUtil.ts` addition groups the existing flat `Change[]` diff into hunks and reconstructs file content from a hunk selection. `AgentSession`'s approval callback grows from returning a plain boolean to a small response object carrying an optional hunk-id list; the tool-call loop rewrites the `edit_file` call's arguments to the reconstructed content before executing, only when the selection is genuinely partial. The IPC `respondPermission` channel grows one optional argument, threaded straight through. The renderer's diff view grows a checkbox per hunk, checked by default, read back when Approve is clicked.

**Tech Stack:** TypeScript, Electron IPC, the existing `diff` npm package (`diffLines`) — no new dependencies.

**Spec:** docs/superpowers/specs/2026-09-03-per-hunk-diff-approval-design.md

## Global Constraints

- Only `edit_file` calls with a diff attached and decision `ASK` ever show hunk checkboxes — every other permission-request type (no diff, or decision `ALLOW`/`DENY`) is visually and behaviorally unchanged.
- A full approval (no `approvedHunkIds`, or one covering every hunk in the diff) must write byte-for-byte the same content as today — zero behavior change for the common case.
- The model's own conversation history (the `assistant` message with its original `tool_calls`) is never rewritten — only the arguments actually handed to `tool.execute` change, for a genuinely partial approval.
- `respondPermission`'s existing 4-argument callers (tests and any future code) must keep compiling unchanged — the new 5th argument is optional and appended at the end, never replacing the existing `approved: boolean` parameter.

---

### Task 1: Hunk grouping and reconstruction in diffUtil.ts

**Files:**
- Modify: `src/diffUtil.ts`
- Modify: `src/test/diffUtil.test.ts`

**Interfaces:**
- Produces: `DiffSegment` (a discriminated union), `groupDiffIntoSegments(diff: Change[]): DiffSegment[]`, `applyHunkSelection(segments: DiffSegment[], approvedHunkIds: Set<number>): string`, all exported from `src/diffUtil.ts`.

- [ ] **Step 1: Write the failing tests**

Append to the end of `src/test/diffUtil.test.ts` (it already exists with `computeFileDiff` tests above — add these after them, and add the new import at the top):

Change the top of the file from:
```typescript
import { computeFileDiff } from "../diffUtil.js";
```
to:
```typescript
import { computeFileDiff, groupDiffIntoSegments, applyHunkSelection } from "../diffUtil.js";
```

Then, right before the final `console.log(failures === 0 ...` line, insert:

```typescript
console.log("\ngroupDiffIntoSegments:");

{
  const diff = computeFileDiff("line1\nline2\nline3\n", "line1\nCHANGED\nline3\n");
  const segments = groupDiffIntoSegments(diff);
  const hunks = segments.filter((s) => s.kind === "hunk");
  check("a single-line replacement produces exactly one hunk", hunks.length === 1);
  check("the hunk's removedValue is the real old line", hunks[0]?.kind === "hunk" && hunks[0].removedValue === "line2\n");
  check("the hunk's addedValue is the real new line", hunks[0]?.kind === "hunk" && hunks[0].addedValue === "CHANGED\n");
  check("surrounding unchanged lines become context segments, not hunks", segments.some((s) => s.kind === "context" && s.value.includes("line1")));
}

{
  const diff = computeFileDiff("line1\nline2\n", "line1\nline2\nline3\n");
  const segments = groupDiffIntoSegments(diff);
  const hunks = segments.filter((s) => s.kind === "hunk");
  check("a pure append produces one hunk with no removedValue", hunks.length === 1 && hunks[0]?.kind === "hunk" && hunks[0].removedValue === undefined);
  check("the pure-append hunk's addedValue is the new line", hunks[0]?.kind === "hunk" && hunks[0].addedValue === "line3\n");
}

{
  const diff = computeFileDiff("keep this\ndrop this\n", "keep this\n");
  const segments = groupDiffIntoSegments(diff);
  const hunks = segments.filter((s) => s.kind === "hunk");
  check("a pure deletion produces one hunk with no addedValue", hunks.length === 1 && hunks[0]?.kind === "hunk" && hunks[0].addedValue === undefined);
  check("the pure-deletion hunk's removedValue is the dropped line", hunks[0]?.kind === "hunk" && hunks[0].removedValue === "drop this\n");
}

{
  // Two separate changes in one file — each gets its own hunk with a distinct id.
  const diff = computeFileDiff("a\nb\nc\nd\ne\n", "A\nb\nc\nD\ne\n");
  const segments = groupDiffIntoSegments(diff);
  const hunks = segments.filter((s) => s.kind === "hunk");
  check("two separate changes produce two distinct hunks", hunks.length === 2);
  const ids = hunks.map((h) => (h.kind === "hunk" ? h.id : -1));
  check("the two hunks have distinct ids", ids[0] !== ids[1]);
}

console.log("\napplyHunkSelection:");

{
  const oldContent = "line1\nline2\nline3\n";
  const newContent = "line1\nCHANGED\nline3\n";
  const diff = computeFileDiff(oldContent, newContent);
  const segments = groupDiffIntoSegments(diff);
  const allHunkIds = new Set(segments.filter((s) => s.kind === "hunk").map((s) => (s.kind === "hunk" ? s.id : -1)));

  check("approving every hunk id reconstructs the new content exactly", applyHunkSelection(segments, allHunkIds) === newContent);
  check("approving no hunk ids reconstructs the old content exactly", applyHunkSelection(segments, new Set()) === oldContent);
}

{
  // Two independent hunks — approve only the first, reject the second, and
  // confirm the reconstructed content mixes them correctly, not just
  // reproducing one whole side or the other.
  const oldContent = "a\nb\nc\nd\ne\n";
  const newContent = "A\nb\nc\nD\ne\n";
  const diff = computeFileDiff(oldContent, newContent);
  const segments = groupDiffIntoSegments(diff);
  const hunks = segments.filter((s) => s.kind === "hunk");
  const firstHunkId = hunks[0]?.kind === "hunk" ? hunks[0].id : -1;

  const merged = applyHunkSelection(segments, new Set([firstHunkId]));
  check("approving only the first hunk applies just that change, leaving the second hunk's line as it was", merged === "A\nb\nc\nd\ne\n");
}

{
  // A pure-insertion hunk that's rejected contributes nothing (not undefined-as-text).
  const oldContent = "line1\nline2\n";
  const newContent = "line1\nline2\nline3\n";
  const diff = computeFileDiff(oldContent, newContent);
  const segments = groupDiffIntoSegments(diff);
  check("rejecting a pure-insertion hunk reconstructs exactly the old content", applyHunkSelection(segments, new Set()) === oldContent);
}

{
  // A pure-deletion hunk that's approved contributes nothing.
  const oldContent = "keep this\ndrop this\n";
  const newContent = "keep this\n";
  const diff = computeFileDiff(oldContent, newContent);
  const segments = groupDiffIntoSegments(diff);
  const hunks = segments.filter((s) => s.kind === "hunk");
  const hunkId = hunks[0]?.kind === "hunk" ? hunks[0].id : -1;
  check("approving a pure-deletion hunk reconstructs exactly the new (shorter) content", applyHunkSelection(segments, new Set([hunkId])) === newContent);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node dist/test/diffUtil.test.js`
Expected: FAIL to build — `error TS2305: Module '"../diffUtil.js"' has no exported member 'groupDiffIntoSegments'` (and `applyHunkSelection`).

- [ ] **Step 3: Implement `groupDiffIntoSegments` and `applyHunkSelection`**

`src/diffUtil.ts` currently reads:

```typescript
import { diffLines, type Change } from "diff";

/**
 * Computes a line-level diff for the edit_file permission-request UI —
 * reused directly as the `diff` npm package's own Change[] shape
 * ({value, added, removed, count}) rather than inventing a new one, since
 * it's already JSON-serializable and exactly what a diff-rendering UI needs.
 *
 * `oldContent` is `null` for a file that doesn't exist yet — diffed against
 * an empty string, so the whole thing renders as added.
 */
export function computeFileDiff(oldContent: string | null, newContent: string): Change[] {
  return diffLines(oldContent ?? "", newContent);
}
```

Replace it with:

```typescript
import { diffLines, type Change } from "diff";

/**
 * Computes a line-level diff for the edit_file permission-request UI —
 * reused directly as the `diff` npm package's own Change[] shape
 * ({value, added, removed, count}) rather than inventing a new one, since
 * it's already JSON-serializable and exactly what a diff-rendering UI needs.
 *
 * `oldContent` is `null` for a file that doesn't exist yet — diffed against
 * an empty string, so the whole thing renders as added.
 */
export function computeFileDiff(oldContent: string | null, newContent: string): Change[] {
  return diffLines(oldContent ?? "", newContent);
}

export type DiffSegment =
  | { kind: "context"; value: string }
  | { kind: "hunk"; id: number; removedValue?: string; addedValue?: string };

/**
 * Groups a flat Change[] diff into context (always included, never
 * selectable) and hunks (one unit of actual change a user can approve or
 * reject independently) — a `removed` Change immediately followed by an
 * `added` Change is one replacement hunk; a standalone `removed` or
 * `added` Change (nothing of the opposite kind adjacent) is a pure
 * deletion or insertion hunk. Hunk ids are assigned in the order they
 * appear, starting at 0, stable for the lifetime of one diff.
 */
export function groupDiffIntoSegments(diff: Change[]): DiffSegment[] {
  const segments: DiffSegment[] = [];
  let nextHunkId = 0;
  let i = 0;
  while (i < diff.length) {
    const chunk = diff[i]!;
    if (!chunk.added && !chunk.removed) {
      segments.push({ kind: "context", value: chunk.value });
      i++;
      continue;
    }
    if (chunk.removed) {
      const next = diff[i + 1];
      if (next && next.added) {
        segments.push({ kind: "hunk", id: nextHunkId++, removedValue: chunk.value, addedValue: next.value });
        i += 2;
        continue;
      }
      segments.push({ kind: "hunk", id: nextHunkId++, removedValue: chunk.value });
      i++;
      continue;
    }
    // chunk.added, with no preceding removed — a pure insertion.
    segments.push({ kind: "hunk", id: nextHunkId++, addedValue: chunk.value });
    i++;
  }
  return segments;
}

/**
 * Reconstructs a full file content string from a diff's segments and a set
 * of approved hunk ids: context passes through unchanged; an approved hunk
 * contributes its addedValue (or nothing, for an approved pure deletion);
 * a rejected hunk contributes its removedValue instead (or nothing, for a
 * rejected pure insertion) — i.e. a rejected hunk's lines simply stay as
 * they were before the edit. Approving every hunk id reconstructs the
 * original newContent exactly; approving no hunk ids reconstructs the
 * original oldContent exactly.
 */
export function applyHunkSelection(segments: DiffSegment[], approvedHunkIds: Set<number>): string {
  let result = "";
  for (const seg of segments) {
    if (seg.kind === "context") {
      result += seg.value;
    } else if (approvedHunkIds.has(seg.id)) {
      result += seg.addedValue ?? "";
    } else {
      result += seg.removedValue ?? "";
    }
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node dist/test/diffUtil.test.js`
Expected: PASS — every check prints `ok`.

- [ ] **Step 5: Run the full suite to confirm nothing else broke**

Run: `npm test`
Expected: `All tests passed.`

- [ ] **Step 6: Commit**

```bash
git add src/diffUtil.ts src/test/diffUtil.test.ts
git commit -m "feat: group a file diff into approvable hunks, and reconstruct content from a hunk selection"
```

---

### Task 2: The approval response grows a hunk selection (agent.ts + types.ts)

**Files:**
- Modify: `src/types.ts`
- Modify: `src/agent.ts`
- Modify: `src/test/agent.test.ts`

**Interfaces:**
- Consumes: `groupDiffIntoSegments`, `applyHunkSelection` from `src/diffUtil.js` (Task 1).
- Produces: `PermissionResponse` (exported from `src/types.ts`); `AgentSessionOptions.onApprovalNeeded` changes from `(call: ToolCall) => Promise<boolean>` to `(call: ToolCall) => Promise<PermissionResponse>`.

- [ ] **Step 1: Add the `PermissionResponse` type**

In `src/types.ts`, find `export type PermissionMode = "PLAN" | "DEFAULT" | "ACCEPT_EDITS" | "AUTO_SAFE";` and add right after it:

```typescript
export interface PermissionResponse {
  approved: boolean;
  /** Only meaningful for an edit_file call with a diff — the DiffSegment hunk ids (see diffUtil.ts) to actually apply. Omitted, or covering every hunk id in the diff, behaves exactly like approving the whole call unmodified. Ignored when approved is false. */
  approvedHunkIds?: number[];
}
```

- [ ] **Step 2: Run the build to confirm the type addition alone doesn't break anything**

Run: `npm run build`
Expected: succeeds — this is a new, unused-so-far type.

- [ ] **Step 3: Write the failing tests**

In `src/test/agent.test.ts`, find the import line:
```typescript
import type { AgentEvent, ChatResponse, Tool, ToolCall } from "../types.js";
```
Change it to:
```typescript
import type { AgentEvent, ChatResponse, PermissionResponse, Tool, ToolCall } from "../types.js";
```

Also change the file's `import { computeFileDiff } from "../diffUtil.js";`... — **first check whether `agent.test.ts` already imports from `diffUtil.js`**. It doesn't today (the existing diff tests in this file only read `event.diff` from emitted events, they don't call `diffUtil.ts` directly). Add this new import line right after the `import type { AgentEvent, ...}` line above:
```typescript
import { groupDiffIntoSegments } from "../diffUtil.js";
```

Now fix the three existing `onApprovalNeeded` call sites, which currently return a bare boolean and will no longer type-check once Step 1 (below) changes `AgentSessionOptions`. Find each of these three (they are the only three `onApprovalNeeded:` lines in the file):

```typescript
      onApprovalNeeded: async () => false,
```
(appears at two different points in the file, in two different test blocks) — change **both** to:
```typescript
      onApprovalNeeded: async () => ({ approved: false }),
```

And:
```typescript
      onApprovalNeeded: async () => true,
```
change to:
```typescript
      onApprovalNeeded: async () => ({ approved: true }),
```

Then find the section `console.log("\nA permission.request for edit_file carries a real diff:");` (search for that exact string) and add a new section immediately after its closing `})();` and before the next `console.log("\nCheckpoints ...` section — a new top-level section:

```typescript
console.log("\nPartial hunk approval only rewrites the edit_file call's content, never the model's own turn history:");
await (async () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const workspaceRoot = path.resolve(__dirname, "..", "..", "fixture-repo");
  // math.js's real content: "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n"

  {
    // Full approval (approvedHunkIds covers every hunk) writes the model's
    // original content completely unmodified, and emits no extra status line.
    const newContent = "function add(a, b) {\n  return a + b + 1;\n}\nmodule.exports = { add };\n";
    const script: ChatResponse[] = [
      { turn: { type: "tool_calls", toolCalls: [{ id: "r1", name: "read_file", arguments: { path: "math.js" } }] } },
      { turn: { type: "tool_calls", toolCalls: [{ id: "e1", name: "edit_file", arguments: { path: "math.js", content: newContent } }] } },
      { turn: { type: "final", content: "done" } },
    ];
    const session = new AgentSession({
      workspaceRoot,
      model: "mock",
      provider: new MockProvider(script),
      tools: defaultToolRegistry(),
      permissionMode: "DEFAULT",
      onApprovalNeeded: async (call): Promise<PermissionResponse> => {
        if (call.name !== "edit_file") return { approved: true };
        return { approved: true }; // no approvedHunkIds — the common "approve everything" case
      },
    });

    const events: AgentEvent[] = [];
    for await (const event of session.run("fix the bug")) events.push(event);
    check("a full approval writes the exact content the model proposed", (await fs.readFile(path.join(workspaceRoot, "math.js"), "utf-8")) === newContent);
    check("a full approval emits no partial-application status line", !events.some((e) => e.type === "status" && e.message.includes("Applying")));

    // Restore the fixture file for the next block/other test files.
    await fs.writeFile(path.join(workspaceRoot, "math.js"), "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n", "utf-8");
  }

  {
    // Partial approval (only some hunks) writes the correctly-merged
    // content, not the model's original full rewrite, and does emit the
    // status line naming how many of how many hunks were applied.
    const proposedContent = "function add(a, b) {\n  return a - b;\n}\nmodule.exports = { subtractNotAdd };\n";
    const script: ChatResponse[] = [
      { turn: { type: "tool_calls", toolCalls: [{ id: "r1", name: "read_file", arguments: { path: "math.js" } }] } },
      { turn: { type: "tool_calls", toolCalls: [{ id: "e1", name: "edit_file", arguments: { path: "math.js", content: proposedContent } }] } },
      { turn: { type: "final", content: "done" } },
    ];
    const session = new AgentSession({
      workspaceRoot,
      model: "mock",
      provider: new MockProvider(script),
      tools: defaultToolRegistry(),
      permissionMode: "DEFAULT",
      onApprovalNeeded: async (call): Promise<PermissionResponse> => {
        if (call.name !== "edit_file" || typeof call.arguments.path !== "string" || typeof call.arguments.content !== "string") {
          return { approved: true };
        }
        // Approve only the FIRST hunk (the body-logic change), reject the
        // second (the exports-name change) — simulates a user unchecking
        // one box in the real UI.
        const oldContent = "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n";
        const diff = (await import("../diffUtil.js")).computeFileDiff(oldContent, call.arguments.content);
        const segments = groupDiffIntoSegments(diff);
        const firstHunk = segments.find((s) => s.kind === "hunk");
        return { approved: true, approvedHunkIds: firstHunk?.kind === "hunk" ? [firstHunk.id] : [] };
      },
    });

    const events: AgentEvent[] = [];
    for await (const event of session.run("fix the bug")) events.push(event);
    const written = await fs.readFile(path.join(workspaceRoot, "math.js"), "utf-8");
    check(
      "a partial approval writes the merged content — the approved hunk applied, the rejected hunk left as it was",
      written === "function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n"
    );
    check("a partial approval emits a status line naming how many of how many hunks were applied", events.some((e) => e.type === "status" && e.message.includes("Applying 1 of 2")));

    // Restore the fixture file.
    await fs.writeFile(path.join(workspaceRoot, "math.js"), "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n", "utf-8");
  }

  {
    // A deny response is completely unaffected — no hunk-selection logic
    // runs at all, the file is untouched.
    const script: ChatResponse[] = [
      { turn: { type: "tool_calls", toolCalls: [{ id: "e1", name: "edit_file", arguments: { path: "math.js", content: "anything" } }] } },
      { turn: { type: "final", content: "done" } },
    ];
    const before = await fs.readFile(path.join(workspaceRoot, "math.js"), "utf-8");
    const session = new AgentSession({
      workspaceRoot,
      model: "mock",
      provider: new MockProvider(script),
      tools: defaultToolRegistry(),
      permissionMode: "DEFAULT",
      onApprovalNeeded: async (): Promise<PermissionResponse> => ({ approved: false }),
    });

    for await (const _event of session.run("fix the bug")) {
      // drain
    }
    const after = await fs.readFile(path.join(workspaceRoot, "math.js"), "utf-8");
    check("a deny response leaves the file completely untouched", after === before);
  }
})();
```

This uses a dynamic `import("../diffUtil.js")` inside one test block purely to reach `computeFileDiff` without adding a second static import line right next to the one already added above (either is fine — the static import already covers `groupDiffIntoSegments`; this shows both are usable). If you'd rather use a single static import for both, change the top-of-file import to:
```typescript
import { computeFileDiff, groupDiffIntoSegments } from "../diffUtil.js";
```
and replace `(await import("../diffUtil.js")).computeFileDiff(...)` with a plain `computeFileDiff(...)` call — either version is correct; use the static-import form, it's simpler.

- [ ] **Step 4: Run test to verify it fails**

Run: `npm run build`
Expected: FAIL — `AgentSessionOptions.onApprovalNeeded` doesn't return `Promise<PermissionResponse>` yet (still `Promise<boolean>`), so the new test callbacks' return types don't match, and the existing three fixed-up call sites now don't match the (unchanged) old signature either. Multiple `tsc` errors.

- [ ] **Step 5: Update `agent.ts`**

Find:
```typescript
  onApprovalNeeded?: (call: ToolCall) => Promise<boolean>;
```
Replace with:
```typescript
  onApprovalNeeded?: (call: ToolCall) => Promise<PermissionResponse>;
```

Add `PermissionResponse` to `agent.ts`'s existing type-only import from `./types.js` (find the current import line for `types.js` at the top of the file and add `PermissionResponse` to its named imports).

Add this import (`diffUtil.ts`'s new functions) near `agent.ts`'s existing `import { computeFileDiff } from "./diffUtil.js";` line — change it to:
```typescript
import { computeFileDiff, groupDiffIntoSegments, applyHunkSelection } from "./diffUtil.js";
```

Find:
```typescript
        if (decision === "ASK") {
          const approved = this.opts.onApprovalNeeded ? await this.opts.onApprovalNeeded(call) : false;
          if (!approved) {
            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: call.name,
              content: JSON.stringify({ ok: false, error: "User rejected this action." }),
            });
            continue;
          }
        }

        this.state = "EXECUTING_TOOL";
        yield { type: "tool.start", call };
        const result = await tool.execute(call.arguments, {
          workspaceRoot: this.opts.workspaceRoot,
          log: (msg) => {
            /* forwarded via tool.result event below */
            void msg;
          },
        });
        yield { type: "tool.result", call, result };

        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: JSON.stringify(result).slice(0, 6000),
```

Replace with:
```typescript
        let effectiveCall = call;
        if (decision === "ASK") {
          const response = this.opts.onApprovalNeeded ? await this.opts.onApprovalNeeded(call) : { approved: false };
          if (!response.approved) {
            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: call.name,
              content: JSON.stringify({ ok: false, error: "User rejected this action." }),
            });
            continue;
          }
          // A genuinely PARTIAL hunk selection rewrites the arguments actually
          // handed to tool.execute below — the model's own turn history (the
          // assistant message with its original tool_calls, already pushed
          // above the per-call loop) is never touched. A full approval (no
          // approvedHunkIds, or one covering every hunk) leaves effectiveCall
          // exactly equal to call — byte-for-byte today's existing behavior.
          if (call.name === "edit_file" && diff && response.approvedHunkIds) {
            const segments = groupDiffIntoSegments(diff);
            const allHunkIds = new Set(segments.filter((s) => s.kind === "hunk").map((s) => (s.kind === "hunk" ? s.id : -1)));
            const approvedSet = new Set(response.approvedHunkIds);
            const isPartial = [...allHunkIds].some((id) => !approvedSet.has(id));
            if (isPartial && typeof call.arguments.path === "string") {
              const mergedContent = applyHunkSelection(segments, approvedSet);
              effectiveCall = { ...call, arguments: { ...call.arguments, content: mergedContent } };
              yield {
                type: "status",
                message: `Applying ${approvedSet.size} of ${allHunkIds.size} proposed changes to ${call.arguments.path} — the rest were left as-is.`,
              };
            }
          }
        }

        this.state = "EXECUTING_TOOL";
        yield { type: "tool.start", call };
        const result = await tool.execute(effectiveCall.arguments, {
          workspaceRoot: this.opts.workspaceRoot,
          log: (msg) => {
            /* forwarded via tool.result event below */
            void msg;
          },
        });
        yield { type: "tool.result", call, result };

        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: JSON.stringify(result).slice(0, 6000),
```

(`diff` here refers to the existing `const diff = await this.computeEditDiffForCall(call);` a few lines above this block, already in scope — unchanged from today.)

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run build && node dist/test/agent.test.js`
Expected: PASS — every check prints `ok`, including the new "Partial hunk approval" section.

- [ ] **Step 7: Run the full suite to confirm nothing else broke**

Run: `npm test`
Expected: `All tests passed.`

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/agent.ts src/test/agent.test.ts
git commit -m "feat: apply only the approved hunks of an edit_file call, not the whole proposed rewrite"
```

---

### Task 3: IPC plumbing — sessionRegistry.ts, main.ts, preload.cjs

**Files:**
- Modify: `src/electron/sessionRegistry.ts`
- Modify: `src/electron/main.ts`
- Modify: `src/electron/preload.cjs`
- Modify: `src/test/sessionRegistry.test.ts`

**Interfaces:**
- Consumes: `PermissionResponse` from `../types.js` (Task 2).
- Produces: `respondPermission(registry, sessionId, callId, approved, approvedHunkIds?)` — grows one optional 5th parameter, threaded through to the `AgentSession`'s pending approval resolver.

- [ ] **Step 1: Update `sessionRegistry.ts`**

Find:
```typescript
  pendingApprovals: Map<string, (approved: boolean) => void>;
```
Replace with:
```typescript
  pendingApprovals: Map<string, (response: PermissionResponse) => void>;
```

Add `PermissionResponse` to this file's existing type-only import from `../types.js` (find the current import line and add it to the named imports).

Find:
```typescript
  const pendingApprovals = new Map<string, (approved: boolean) => void>();
```
Replace with:
```typescript
  const pendingApprovals = new Map<string, (response: PermissionResponse) => void>();
```

Find:
```typescript
    onApprovalNeeded: (call) =>
      new Promise<boolean>((resolve) => {
        pendingApprovals.set(call.id, resolve);
      }),
```
Replace with:
```typescript
    onApprovalNeeded: (call) =>
      new Promise<PermissionResponse>((resolve) => {
        pendingApprovals.set(call.id, resolve);
      }),
```

Find:
```typescript
/** No-op on an unknown session/callId — the renderer may race a stale click against a session that already moved on. */
export function respondPermission(registry: SessionRegistry, sessionId: string, callId: string, approved: boolean): void {
  const entry = registry.sessions.get(sessionId);
  if (!entry) return;
  const resolve = entry.pendingApprovals.get(callId);
  if (!resolve) return;
  entry.pendingApprovals.delete(callId);
  resolve(approved);
}
```
Replace with:
```typescript
/** No-op on an unknown session/callId — the renderer may race a stale click against a session that already moved on. approvedHunkIds is only ever meaningful for a real edit_file partial approval; every other caller simply omits it. */
export function respondPermission(registry: SessionRegistry, sessionId: string, callId: string, approved: boolean, approvedHunkIds?: number[]): void {
  const entry = registry.sessions.get(sessionId);
  if (!entry) return;
  const resolve = entry.pendingApprovals.get(callId);
  if (!resolve) return;
  entry.pendingApprovals.delete(callId);
  resolve({ approved, approvedHunkIds });
}
```

Find (inside `finalizeEntry`):
```typescript
  for (const resolve of entry.pendingApprovals.values()) resolve(false);
```
Replace with:
```typescript
  for (const resolve of entry.pendingApprovals.values()) resolve({ approved: false });
```

- [ ] **Step 2: Update `main.ts`**

Find:
```typescript
  ipcMain.handle("agent:respond-permission", (_event, sessionId: string, callId: string, approved: boolean) =>
    respondPermission(registry, sessionId, callId, approved)
  );
```
Replace with:
```typescript
  ipcMain.handle("agent:respond-permission", (_event, sessionId: string, callId: string, approved: boolean, approvedHunkIds?: number[]) =>
    respondPermission(registry, sessionId, callId, approved, approvedHunkIds)
  );
```

- [ ] **Step 3: Update `preload.cjs`**

Find:
```javascript
  respondPermission: (sessionId, callId, approved) =>
    ipcRenderer.invoke("agent:respond-permission", sessionId, callId, approved),
```
Replace with:
```javascript
  respondPermission: (sessionId, callId, approved, approvedHunkIds) =>
    ipcRenderer.invoke("agent:respond-permission", sessionId, callId, approved, approvedHunkIds),
```

- [ ] **Step 4: Run the build to confirm everything type-checks**

Run: `npm run build`
Expected: succeeds with no errors. (The two existing `respondPermission(registry, ..., true)` calls in `src/test/sessionRegistry.test.ts` still compile unchanged — the new 5th parameter is optional and appended at the end, not replacing the existing 4-argument shape.)

- [ ] **Step 5: Write one new test proving a partial approval reaches all the way through the registry**

In `src/test/sessionRegistry.test.ts`, find the section containing this comment (search for it):
```typescript
    // respondPermission does for a per-edit ASK.
```
Read a few lines around it to see the existing test block's structure, then add a new block right after that section's closing (find the next `console.log("\n` after this point, and insert the new block immediately before it). The new block:

```typescript
{
  // A partial hunk approval reaches all the way through respondPermission
  // into the running AgentSession and actually changes what gets written
  // to disk — not just that the IPC call is accepted.
  const oldContent = "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n";
  await fs.writeFile(path.join(workspaceRoot, "math.js"), oldContent, "utf-8");
  const proposedContent = "function add(a, b) {\n  return a - b;\n}\nmodule.exports = { subtractNotAdd };\n";
  const script: ChatResponse[] = [
    { turn: { type: "tool_calls", toolCalls: [{ id: "r1", name: "read_file", arguments: { path: "math.js" } }] } },
    { turn: { type: "tool_calls", toolCalls: [{ id: "e1", name: "edit_file", arguments: { path: "math.js", content: proposedContent } }] } },
    { turn: { type: "final", content: "done" } },
  ];
  const registry = createSessionRegistry(sessionsDir);
  const { sessionId } = await startSession(
    registry,
    { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "DEFAULT" },
    { providerFactory: () => new MockProvider(script) }
  );

  const events: AgentEvent[] = [];
  const runPromise = runTask(registry, sessionId, "fix the bug", (e) => events.push(e));
  // Give the loop a tick to reach the edit_file ASK prompt and start awaiting it.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const editEvent = events.find((e) => e.type === "permission.request" && e.call.name === "edit_file");
  const diff = editEvent?.type === "permission.request" ? editEvent.diff : undefined;
  const segments = diff ? groupDiffIntoSegments(diff) : [];
  const firstHunk = segments.find((s) => s.kind === "hunk");
  const approvedHunkIds = firstHunk?.kind === "hunk" ? [firstHunk.id] : [];

  respondPermission(registry, sessionId, "e1", true, approvedHunkIds);
  await runPromise;

  const written = await fs.readFile(path.join(workspaceRoot, "math.js"), "utf-8");
  check(
    "a partial hunk approval sent through respondPermission actually writes the merged content, not the model's full proposed rewrite",
    written === "function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n"
  );

  await fs.writeFile(path.join(workspaceRoot, "math.js"), oldContent, "utf-8");
}
```

This uses `groupDiffIntoSegments` — check the top of `src/test/sessionRegistry.test.ts` for its existing imports; if `groupDiffIntoSegments` isn't already imported, add it:
```typescript
import { groupDiffIntoSegments } from "../diffUtil.js";
```
Match wherever this file's other local imports are grouped.

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run build && node dist/test/sessionRegistry.test.js`
Expected: PASS.

- [ ] **Step 7: Run the full suite to confirm nothing else broke**

Run: `npm test`
Expected: `All tests passed.`

- [ ] **Step 8: Commit**

```bash
git add src/electron/sessionRegistry.ts src/electron/main.ts src/electron/preload.cjs src/test/sessionRegistry.test.ts
git commit -m "feat: thread a partial hunk approval through the respond-permission IPC channel"
```

---

### Task 4: Renderer UI — checkboxes on the diff view

**Files:**
- Modify: `src/electron/renderer/renderer.ts`
- Modify: `src/electron/renderer/styles.css`

**Interfaces:**
- Consumes: `groupDiffIntoSegments`, `type DiffSegment` from `../../diffUtil.js` (Task 1); `window.agent.respondPermission(sessionId, callId, approved, approvedHunkIds?)` (Task 3).

- [ ] **Step 1: Add the type import and rebuild `renderDiff` on segments**

Find the existing `import type { Change } from "diff";` line in `renderer.ts` and add right after it:
```typescript
import { groupDiffIntoSegments } from "../../diffUtil.js";
```

Find:
```typescript
function renderDiff(diff: Change[]): HTMLElement {
  const container = document.createElement("div");
  container.className = "diff-view";
  let linesShown = 0;
  outer: for (const chunk of diff) {
    const lines = chunk.value.split("\n");
    if (lines[lines.length - 1] === "") lines.pop(); // split("\n") on a trailing-newline string leaves one empty entry
    for (const line of lines) {
      if (linesShown >= DIFF_LINE_CAP) {
        const truncated = document.createElement("div");
        truncated.className = "diff-line diff-truncated";
        truncated.textContent = "… diff truncated …";
        container.appendChild(truncated);
        break outer;
      }
      const lineEl = document.createElement("div");
      lineEl.className = `diff-line ${chunk.added ? "diff-added" : chunk.removed ? "diff-removed" : "diff-context"}`;
      lineEl.textContent = `${chunk.added ? "+" : chunk.removed ? "-" : " "} ${line}`;
      container.appendChild(lineEl);
      linesShown++;
    }
  }
  return container;
}
```

Replace with:
```typescript
/** Splits a segment's value into its individual lines the same way the old flat renderer did — split("\n") on a trailing-newline string leaves one empty trailing entry, popped off. */
function linesOf(value: string): string[] {
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Renders a diff as context lines interleaved with per-hunk blocks, each
 * hunk carrying its own checkbox (checked by default, matching today's
 * implicit "approve everything") so an Approve click can read back exactly
 * which hunks are still checked. `readOnly` is used for a diff shown
 * alongside a decision that isn't ASK (already-decided ALLOW/DENY, or the
 * read-only copy under a sent task) — no checkboxes there, since there's
 * no prompt to attach a selection to.
 */
function renderDiff(diff: Change[], readOnly = false): HTMLElement {
  const container = document.createElement("div");
  container.className = "diff-view";
  const segments = groupDiffIntoSegments(diff);
  let linesShown = 0;

  outer: for (const segment of segments) {
    let hunkWrapper: HTMLElement | null = null;
    if (segment.kind === "hunk" && !readOnly) {
      hunkWrapper = document.createElement("div");
      hunkWrapper.className = "diff-hunk";
      const toggle = document.createElement("label");
      toggle.className = "diff-hunk-toggle";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.dataset.hunkId = String(segment.id);
      toggle.appendChild(checkbox);
      toggle.appendChild(document.createTextNode("Apply this change"));
      hunkWrapper.appendChild(toggle);
      container.appendChild(hunkWrapper);
    }
    const target = hunkWrapper ?? container;

    const parts: { value: string; added?: boolean; removed?: boolean }[] =
      segment.kind === "context"
        ? [{ value: segment.value }]
        : [
            ...(segment.removedValue !== undefined ? [{ value: segment.removedValue, removed: true }] : []),
            ...(segment.addedValue !== undefined ? [{ value: segment.addedValue, added: true }] : []),
          ];

    for (const part of parts) {
      for (const line of linesOf(part.value)) {
        if (linesShown >= DIFF_LINE_CAP) {
          const truncated = document.createElement("div");
          truncated.className = "diff-line diff-truncated";
          truncated.textContent = "… diff truncated …";
          container.appendChild(truncated);
          break outer;
        }
        const lineEl = document.createElement("div");
        lineEl.className = `diff-line ${part.added ? "diff-added" : part.removed ? "diff-removed" : "diff-context"}`;
        lineEl.textContent = `${part.added ? "+" : part.removed ? "-" : " "} ${line}`;
        target.appendChild(lineEl);
        linesShown++;
      }
    }
  }
  return container;
}
```

- [ ] **Step 2: Read back the checked hunks when Approve is clicked**

Find:
```typescript
      const card = toolCards.get(event.call.id) ?? toolCard(event.call);
      if (hasDiff) card.appendChild(renderDiff(event.diff!));
      if (event.decision !== "ASK") {
```
Replace with:
```typescript
      const card = toolCards.get(event.call.id) ?? toolCard(event.call);
      if (hasDiff) card.appendChild(renderDiff(event.diff!, event.decision !== "ASK"));
      if (event.decision !== "ASK") {
```

Find:
```typescript
      const respond = (approved: boolean) => {
        approve.disabled = true;
        deny.disabled = true;
        prompt.classList.add("permission-resolved");
        if (sessionId) void window.agent.respondPermission(sessionId, event.call.id, approved);
      };
```
Replace with:
```typescript
      const respond = (approved: boolean) => {
        approve.disabled = true;
        deny.disabled = true;
        prompt.classList.add("permission-resolved");
        // Only meaningful for an edit_file approval — every hunk checkbox
        // that's still checked at click time. Undefined for a deny (never
        // read) and harmless-but-unused for a call with no diff at all
        // (the querySelectorAll below just finds nothing).
        const approvedHunkIds = approved
          ? Array.from(card.querySelectorAll<HTMLInputElement>(".diff-hunk-toggle input:checked")).map((el) => Number(el.dataset.hunkId))
          : undefined;
        if (sessionId) void window.agent.respondPermission(sessionId, event.call.id, approved, approvedHunkIds);
      };
```

- [ ] **Step 3: Style the hunk toggle**

Find the existing `.diff-truncated { ... }` rule in `styles.css` (it's the last of the `.diff-*` rules) and add right after it:
```css
.diff-hunk {
  border-top: 1px solid var(--border);
}

.diff-hunk:first-child {
  border-top: none;
}

.diff-hunk-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: var(--bg-raised);
  color: var(--text-dim);
  font-size: 10px;
  cursor: pointer;
}

.diff-hunk-toggle input {
  cursor: pointer;
}
```

- [ ] **Step 4: Run the build to confirm everything type-checks**

Run: `npm run build`
Expected: succeeds with no errors.

- [ ] **Step 5: Run the full suite to confirm nothing broke**

Run: `npm test`
Expected: `All tests passed.` (renderer UI changes get no automated test of their own — this project's consistent treatment of Electron renderer code.)

- [ ] **Step 6: Live-verify against the real running app**

Run the real dev Electron app (`npm run build && npm run electron`, or the CDP-driven technique used for the last few features if a real window can't be interacted with directly in this environment) with a scripted/mock scenario that produces a multi-hunk `edit_file` ASK prompt (DEFAULT mode, a task that edits a file with at least two separate changes). Confirm: each hunk shows its own checkbox, checked by default; unchecking one hunk and clicking Approve writes a file to disk that has the checked hunk's change applied and the unchecked hunk's original content preserved (read the actual file after the click, don't just trust the UI); a read-only diff (ACCEPT_EDITS auto-approved, or the sent-task log's copy) shows no checkboxes at all, matching today's exact appearance for that case. Clean up any stray session records this creates in the real userData sessions folder afterward, and kill the launched Electron process — same discipline as every prior live verification this session.

- [ ] **Step 7: Commit**

```bash
git add src/electron/renderer/renderer.ts src/electron/renderer/styles.css
git commit -m "feat: per-hunk checkboxes on the edit_file diff view"
```

---

## Post-implementation note for the human

This plan's `applyHunkSelection` round-trip guarantee (approve-all reconstructs `newContent` exactly, approve-none reconstructs `oldContent` exactly) is what makes the reconstruction trustworthy without needing to trust `diffLines`'s internal chunking beyond "it round-trips." Verify this holds for the fixture file's real content once, live, as part of Task 4's verification — not just the synthetic strings the unit tests use.
