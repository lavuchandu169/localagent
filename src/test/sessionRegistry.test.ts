import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createSessionRegistry,
  startSession,
  runTask,
  respondPermission,
  cancelSession,
  removeSession,
  buildProvider,
  getLiveSessionSnapshot,
  updateLiveSessionSettings,
  getCheckpointHash,
  revertSessionCheckpoint,
  getSessionChanges,
  respondPlan,
} from "../electron/sessionRegistry.js";
import { MockProvider } from "../providers/mockProvider.js";
import { loadSessionRecord } from "../sessionStore.js";
import { DriveScopeError } from "../cloudSync.js";
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
  {
    const registry = createSessionRegistry(sessionsDir);
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider([]) }
    );
    check("startSession returns a sessionId and registers it", registry.sessions.has(sessionId));
  }

  {
    const registry = createSessionRegistry(sessionsDir);
    const { workspaceRoot: resolved } = await startSession(
      registry,
      { provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider([]) }
    );
    check("startSession defaults workspaceRoot to the home directory when none is given", resolved === os.homedir());
  }

  {
    const registry = createSessionRegistry(sessionsDir);
    let threw = false;
    try {
      await startSession(
        registry,
        { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
        { providerFactory: () => ({ id: "unhealthy", listModels: async () => [], healthCheck: async () => false, chat: async () => { throw new Error("should not be called"); } }) }
      );
    } catch {
      threw = true;
    }
    check("startSession rejects when the provider's health check fails", threw);
  }

  {
    const registry = createSessionRegistry(sessionsDir);
    let receivedCallback: unknown;
    await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      {
        providerFactory: (_config, onDownloadProgress) => {
          receivedCallback = onDownloadProgress;
          return new MockProvider([]);
        },
        onDownloadProgress: () => {},
      }
    );
    check("startSession forwards onDownloadProgress through to the provider factory", typeof receivedCallback === "function");
  }

  {
    const registry = createSessionRegistry(sessionsDir);
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      {
        providerFactory: (_config, _onDownloadProgress, signal) => {
          receivedSignal = signal;
          return new MockProvider([]);
        },
        signal: controller.signal,
      }
    );
    check("startSession forwards its signal through to the provider factory", receivedSignal === controller.signal);
  }

  {
    check("buildProvider throws on an invalid embedded model size", (() => {
      try {
        buildProvider({ kind: "embedded", size: "huge" });
        return false;
      } catch {
        return true;
      }
    })());
  }

  {
    const registry = createSessionRegistry(sessionsDir);
    const script: ChatResponse[] = [{ turn: { type: "final", content: "all done" } }];
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider(script) }
    );

    const events: AgentEvent[] = [];
    await runTask(registry, sessionId, "do a thing", (e: AgentEvent) => events.push(e));

    check("runTask streams events ending in done", events.length > 0 && events[events.length - 1]?.type === "done");
  }

  {
    const registry = createSessionRegistry(sessionsDir);
    let threw = false;
    try {
      await runTask(registry, "not-a-real-session", "task", () => {});
    } catch {
      threw = true;
    }
    check("runTask rejects for an unknown sessionId", threw);
  }

  {
    const registry = createSessionRegistry(sessionsDir);
    check(
      "respondPermission on an unknown session/callId is a silent no-op",
      (() => {
        try {
          respondPermission(registry, "nope", "nope", true);
          return true;
        } catch {
          return false;
        }
      })()
    );
  }

  {
    const registry = createSessionRegistry(sessionsDir);
    const script: ChatResponse[] = [
      { turn: { type: "tool_calls", toolCalls: [{ id: "c1", name: "run_command", arguments: { command: "echo hi" } }] } },
      { turn: { type: "final", content: "ran it" } },
    ];
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "DEFAULT" },
      { providerFactory: () => new MockProvider(script) }
    );

    const events: AgentEvent[] = [];
    const runPromise = runTask(registry, sessionId, "run echo", (e: AgentEvent) => {
      events.push(e);
      if (e.type === "permission.request" && e.decision === "ASK") {
        // Real IPC always takes at least one more turn than the generator's own resume-and-register
        // step, so defer here to match that ordering rather than racing it.
        setImmediate(() => respondPermission(registry, sessionId, e.call.id, true));
      }
    });
    await runPromise;

    check(
      "respondPermission unblocks a pending ASK and the run completes",
      events.some((e) => e.type === "tool.result" && e.result.ok) && events[events.length - 1]?.type === "done"
    );
  }

  {
    const registry = createSessionRegistry(sessionsDir);
    check(
      "respondPlan on an unknown session is a silent no-op",
      (() => {
        try {
          respondPlan(registry, "nope", true);
          return true;
        } catch {
          return false;
        }
      })()
    );
  }

  {
    // Real end-to-end through the registry API: planFirst set at
    // startSession, the resulting plan.proposed event carries a real
    // pending approval, and respondPlan unblocks it exactly like
    // respondPermission does for a per-edit ASK.
    const registry = createSessionRegistry(sessionsDir);
    // "pwd" classifies as SAFE_READ (permissions.ts), so once the plan
    // itself is approved it auto-executes with no second ASK to handle —
    // an UNKNOWN-classified command here would hang this test forever on
    // an unhandled permission.request, the exact same class of gap
    // documented on the checkpoint tests elsewhere in this file.
    const script: ChatResponse[] = [
      { turn: { type: "tool_calls", toolCalls: [{ id: "c1", name: "run_command", arguments: { command: "pwd" } }] } },
      { turn: { type: "final", content: "done" } },
    ];
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "AUTO_SAFE", planFirst: true },
      { providerFactory: () => new MockProvider(script) }
    );

    const events: AgentEvent[] = [];
    const runPromise = runTask(registry, sessionId, "run echo", (e: AgentEvent) => {
      events.push(e);
      if (e.type === "plan.proposed") {
        setImmediate(() => respondPlan(registry, sessionId, true));
      }
    });
    await runPromise;

    check("a plan.proposed event fired for the planFirst session", events.some((e) => e.type === "plan.proposed"));
    check(
      "respondPlan(true) let the proposed command actually execute",
      events.some((e) => e.type === "tool.result" && e.result.ok) && events[events.length - 1]?.type === "done"
    );
  }

  {
    const registry = createSessionRegistry(sessionsDir);
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "DEFAULT" },
      { providerFactory: () => new MockProvider([]) }
    );
    const updated = updateLiveSessionSettings(registry, sessionId, { planFirst: true });
    check("updateLiveSessionSettings accepts a planFirst change for a live session", updated);
  }

  {
    const registry = createSessionRegistry(sessionsDir);
    const script: ChatResponse[] = [
      { turn: { type: "final", content: "first turn done (unused, cancelled first)" } },
    ];
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider(script) }
    );

    cancelSession(registry, sessionId);
    const events: AgentEvent[] = [];
    await runTask(registry, sessionId, "do a thing", (e: AgentEvent) => events.push(e));

    const done = events.find((e) => e.type === "done");
    check(
      "cancelSession ends the run with success:false",
      done?.type === "done" && done.success === false && done.summary === "Cancelled by user."
    );
  }

  {
    // Regression: cancelling a session and immediately starting a NEW one
    // under the SAME id (resume, mid-conversation, same sessionId — exactly
    // what applying edited settings does) must not hang or redundantly
    // re-finalize the already-torn-down old entry. Awaited fully this time,
    // unlike the test above, to actually exercise cancelSession's cleanup.
    const registry = createSessionRegistry(sessionsDir);
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider([]) }
    );
    await cancelSession(registry, sessionId);
    check("cancelSession removes the entry from the registry once finalized", !registry.sessions.has(sessionId));

    const restarted = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "ACCEPT_EDITS" },
      {
        providerFactory: () => new MockProvider([]),
        resume: { sessionId, initialMessages: [{ role: "system", content: "sys" }], priorEvents: [], title: "t", createdAt: Date.now(), ownerEmail: null },
      }
    );
    check("starting a new session under the same just-cancelled id succeeds", restarted.sessionId === sessionId);
    check("the registry now holds exactly the new entry, not a stale one", registry.sessions.has(sessionId));
  }

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
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
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
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      {
        providerFactory: () => new MockProvider(script),
        resume: {
          sessionId: fixedId,
          initialMessages: [{ role: "system", content: "sys" }, { role: "user", content: "earlier" }],
          priorEvents: [{ type: "text", text: "earlier response" }],
          title: "earlier task title",
          createdAt: 12345,
          ownerEmail: null,
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
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider(script) }
    );
    await runTask(registry, sessionId, "first task", () => {});
    check("a record exists before deletion", (await loadSessionRecord(sessionsDir, sessionId)) !== null);

    // Race: delete while a second task is still in flight.
    const runPromise = runTask(registry, sessionId, "second task", () => {});
    await removeSession(registry, sessionId);
    await runPromise;

    const record = await loadSessionRecord(sessionsDir, sessionId);
    check("an in-flight task's terminal event does not resurrect a deleted record", record === null);
  })();

  console.log("\nDelete/cancel resolve pending approvals instead of hanging:");
  await (async () => {
    const registry = createSessionRegistry(sessionsDir);
    // A tool_calls turn with no matching final turn queued after it — the
    // task stays parked awaiting permission approval until something resolves it.
    const script: ChatResponse[] = [
      { turn: { type: "tool_calls", toolCalls: [{ id: "t1", name: "edit_file", arguments: { path: "x.txt", content: "y" } }] } },
    ];
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "DEFAULT" },
      { providerFactory: () => new MockProvider(script) }
    );

    const events: AgentEvent[] = [];
    const runPromise = runTask(registry, sessionId, "edit a file", (e) => events.push(e));
    // Give the loop a tick to reach the ASK permission prompt and start awaiting it.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // removeSession must resolve the pending approval (with false) rather than
    // leaving runTask hanging forever.
    await Promise.race([
      removeSession(registry, sessionId),
      new Promise((_, reject) => setTimeout(() => reject(new Error("removeSession did not resolve in time")), 5000)),
    ]);
    await Promise.race([
      runPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("runTask hung after removeSession — pending approval was never resolved")), 5000)),
    ]);

    check("runTask completes instead of hanging after its session is deleted mid-approval", true);
  })();

  console.log("\nCloud sync integration:");
  {
    const registry = createSessionRegistry(sessionsDir);
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider([{ turn: { type: "final", content: "done" } }]) }
    );
    await runTask(registry, sessionId, "a task", () => {});
    check("runTask completes without a cloudSync config and doesn't throw", true);
  }

  {
    // Two separate primitives rather than one nullable object: TypeScript's
    // control-flow narrowing doesn't track reassignment of a captured
    // variable that happens only inside a nested callback, so it keeps
    // treating the outer variable as its literal `null` initializer at the
    // check() call below — property access via optional chaining on that
    // stale narrowing fails to compile. Plain equality checks against a
    // `string | null` aren't affected by that narrowing quirk.
    let uploadedToken: string | null = null;
    let uploadedRecordId: string | null = null;
    const registry = createSessionRegistry(sessionsDir, {
      getAccessToken: async () => "fake-token",
      onScopeError: () => {
        throw new Error("should not be called");
      },
      uploadSession: async (token, record) => {
        uploadedToken = token;
        uploadedRecordId = record.id;
      },
      getOwnerEmail: async () => null,
    });
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider([{ turn: { type: "final", content: "done" } }]) }
    );
    await runTask(registry, sessionId, "sync me", () => {});
    check(
      "a completed task uploads the session record when signed in",
      uploadedToken === "fake-token" && uploadedRecordId === sessionId
    );
  }

  {
    let uploadCalled = false;
    const registry = createSessionRegistry(sessionsDir, {
      getAccessToken: async () => null,
      onScopeError: () => {},
      uploadSession: async () => {
        uploadCalled = true;
      },
      getOwnerEmail: async () => null,
    });
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider([{ turn: { type: "final", content: "done" } }]) }
    );
    await runTask(registry, sessionId, "not signed in", () => {});
    check("no upload is attempted when getAccessToken resolves null (signed out)", !uploadCalled);
  }

  {
    let scopeErrorCalled = false;
    const registry = createSessionRegistry(sessionsDir, {
      getAccessToken: async () => "fake-token",
      onScopeError: () => {
        scopeErrorCalled = true;
      },
      uploadSession: async () => {
        throw new DriveScopeError("upload");
      },
      getOwnerEmail: async () => null,
    });
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider([{ turn: { type: "final", content: "done" } }]) }
    );
    await runTask(registry, sessionId, "bad scope", () => {});
    check("a DriveScopeError from upload invokes onScopeError", scopeErrorCalled);
  }

  {
    let scopeErrorCalled = false;
    const registry = createSessionRegistry(sessionsDir, {
      getAccessToken: async () => "fake-token",
      onScopeError: () => {
        scopeErrorCalled = true;
      },
      uploadSession: async () => {
        throw new Error("network blip");
      },
      getOwnerEmail: async () => null,
    });
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider([{ turn: { type: "final", content: "done" } }]) }
    );
    let threw = false;
    try {
      await runTask(registry, sessionId, "transient failure", () => {});
    } catch {
      threw = true;
    }
    check("a non-scope upload failure is swallowed, not thrown, and doesn't call onScopeError", !threw && !scopeErrorCalled);
  }

  {
    let deletedSessionId: string | null = null;
    const registry = createSessionRegistry(sessionsDir, {
      getAccessToken: async () => "fake-token",
      onScopeError: () => {},
      deleteRemoteSession: async (_token, id) => {
        deletedSessionId = id;
      },
      getOwnerEmail: async () => null,
    });
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider([]) }
    );
    await removeSession(registry, sessionId);
    check("removeSession best-effort deletes the remote copy when signed in", deletedSessionId === sessionId);
  }

  console.log("\nSession ownership:");
  {
    const registry = createSessionRegistry(sessionsDir, {
      getAccessToken: async () => "fake-token",
      onScopeError: () => {},
      uploadSession: async () => {},
      getOwnerEmail: async () => "owner@example.com",
    });
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider([{ turn: { type: "final", content: "done" } }]) }
    );
    await runTask(registry, sessionId, "a new session", () => {});
    const saved = await loadSessionRecord(sessionsDir, sessionId);
    check("a new session is stamped with the currently signed-in owner", saved?.ownerEmail === "owner@example.com");
  }

  {
    // getOwnerEmail resolves to a DIFFERENT value than the resumed
    // session's original owner (simulating a sign-out or account switch
    // mid-conversation) — the original owner must survive unchanged.
    const registry = createSessionRegistry(sessionsDir, {
      getAccessToken: async () => "fake-token",
      onScopeError: () => {},
      uploadSession: async () => {},
      getOwnerEmail: async () => "someone-else@example.com",
    });
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      {
        providerFactory: () => new MockProvider([{ turn: { type: "final", content: "done" } }]),
        resume: {
          sessionId: "resumed-owned-session",
          initialMessages: [{ role: "system", content: "sys" }],
          priorEvents: [],
          title: "resumed",
          createdAt: Date.now(),
          ownerEmail: "original-owner@example.com",
        },
      }
    );
    await runTask(registry, sessionId, "continue the resumed session", () => {});
    const saved = await loadSessionRecord(sessionsDir, sessionId);
    check("a resumed session keeps its original owner regardless of who's currently signed in", saved?.ownerEmail === "original-owner@example.com");
  }

  {
    // The exact scenario a disk-record-based read (loadSessionRecord) can't
    // handle: a session that has started but never run a task yet, so
    // persistSession has never fired — nothing has ever hit disk.
    const registry = createSessionRegistry(sessionsDir);
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider([]) }
    );
    const onDisk = await loadSessionRecord(sessionsDir, sessionId).catch(() => null);
    check("sanity check: a session with no completed task has no disk record yet", onDisk === null);

    const snapshot = getLiveSessionSnapshot(registry, sessionId);
    check("getLiveSessionSnapshot still finds it — reads the live entry, not disk", snapshot !== null);
    check("its messages start with just the seeded system prompt, matching a freshly-started session", snapshot?.messages.length === 1 && snapshot.messages[0]?.role === "system");
  }

  {
    const registry = createSessionRegistry(sessionsDir);
    const script: ChatResponse[] = [{ turn: { type: "final", content: "hi there" } }];
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider(script) }
    );
    await runTask(registry, sessionId, "say hi", () => {});
    const snapshot = getLiveSessionSnapshot(registry, sessionId);
    check("after a completed task, the live snapshot's events are non-empty", (snapshot?.events.length ?? 0) > 0);
    check("after a completed task, the live snapshot's messages include the user's task", snapshot?.messages.some((m) => m.role === "user" && m.content === "say hi") === true);
  }

  {
    const registry = createSessionRegistry(sessionsDir);
    check("getLiveSessionSnapshot returns null for an unknown session id", getLiveSessionSnapshot(registry, "nope-not-real") === null);
  }

  {
    // The actual setWorkspaceRoot/setPermissionMode behavior is proven at
    // the AgentSession level in agent.test.ts (a real read/edit against the
    // changed workspace and mode) — this just confirms the registry-level
    // wiring finds the right entry and reports success/failure correctly.
    const registry = createSessionRegistry(sessionsDir);
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider([]) }
    );
    const updated = updateLiveSessionSettings(registry, sessionId, { workspaceRoot: "/some/other/path", mode: "ACCEPT_EDITS" });
    check("updateLiveSessionSettings returns true for a live session", updated);
    const notFound = updateLiveSessionSettings(registry, "nope-not-real", { mode: "PLAN" });
    check("updateLiveSessionSettings returns false for an unknown session id", !notFound);
  }

  {
    const registry = createSessionRegistry(sessionsDir);
    check("getCheckpointHash returns null for an unknown session id", getCheckpointHash(registry, "nope") === null);
    const noCheckpointResult = await revertSessionCheckpoint(registry, "nope");
    check("revertSessionCheckpoint returns ok:false for an unknown session id", noCheckpointResult.ok === false && !!noCheckpointResult.error);
  }

  {
    // Real end-to-end through the registry API specifically (checkpoints.ts
    // and AgentSession's own checkpoint wiring are already thoroughly
    // tested elsewhere) — this just proves getCheckpointHash/
    // revertSessionCheckpoint correctly read through to the live session
    // and use ITS OWN getWorkspaceRoot(), not some other stored value.
    const execFileAsync = promisify(execFile);
    const git = async (cwd: string, args: string[]) => (await execFileAsync("git", args, { cwd })).stdout.trim();
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-registry-checkpoint-test-"));
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "test@example.com"]);
    await git(repo, ["config", "user.name", "Test"]);
    await fs.writeFile(path.join(repo, "app.js"), "v1\n", "utf-8");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);

    const registry = createSessionRegistry(sessionsDir);
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot: repo, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "ACCEPT_EDITS" },
      {
        providerFactory: () =>
          new MockProvider([
            // A read before the edit — otherwise the read-before-write
            // safety override forces an ASK even in ACCEPT_EDITS, and
            // sessionRegistry's real approval flow (unlike a raw
            // AgentSession test) waits on an actual respondPermission()
            // call that nothing in this test would ever send, hanging
            // runTask forever instead of failing fast.
            { turn: { type: "tool_calls", toolCalls: [{ id: "r1", name: "read_file", arguments: { path: "app.js" } }] } },
            { turn: { type: "tool_calls", toolCalls: [{ id: "e1", name: "edit_file", arguments: { path: "app.js", content: "v2\n" } }] } },
            { turn: { type: "final", content: "done" } },
          ]),
      }
    );

    check("no checkpoint exists before any task runs", getCheckpointHash(registry, sessionId) === null);
    const noCheckpointYet = await revertSessionCheckpoint(registry, sessionId);
    check("reverting before any checkpoint exists fails with a clear error, not a crash", noCheckpointYet.ok === false && noCheckpointYet.error === "No checkpoint available for this session.");

    await runTask(registry, sessionId, "bump the version", () => {});
    const hash = getCheckpointHash(registry, sessionId);
    check("a checkpoint exists after a task that wrote something", typeof hash === "string" && hash.length > 0);
    const afterEdit = await fs.readFile(path.join(repo, "app.js"), "utf-8");
    check("the edit actually applied", afterEdit === "v2\n");

    const result = await revertSessionCheckpoint(registry, sessionId);
    check("revertSessionCheckpoint reports ok:true for a real revert", result.ok === true);
    const afterRevert = await fs.readFile(path.join(repo, "app.js"), "utf-8");
    check("the workspace is actually back to its pre-task content", afterRevert === "v1\n");

    await fs.rm(repo, { recursive: true, force: true });
  }

  {
    const registry = createSessionRegistry(sessionsDir);
    const noSession = await getSessionChanges(registry, "nope");
    check("getSessionChanges returns ok:false for an unknown session id", noSession.ok === false && !!noSession.error);
  }

  {
    // Real end-to-end through the registry API — changesSince.ts's own
    // git-plumbing correctness is already covered in its own test file;
    // this just proves getSessionChanges reads through to the live
    // session's real checkpoint and workspace.
    const execFileAsync = promisify(execFile);
    const git = async (cwd: string, args: string[]) => (await execFileAsync("git", args, { cwd })).stdout.trim();
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-registry-changes-test-"));
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "test@example.com"]);
    await git(repo, ["config", "user.name", "Test"]);
    await fs.writeFile(path.join(repo, "app.js"), "v1\n", "utf-8");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);

    const registry = createSessionRegistry(sessionsDir);
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot: repo, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "ACCEPT_EDITS" },
      {
        providerFactory: () =>
          new MockProvider([
            { turn: { type: "tool_calls", toolCalls: [{ id: "r1", name: "read_file", arguments: { path: "app.js" } }] } },
            { turn: { type: "tool_calls", toolCalls: [{ id: "e1", name: "edit_file", arguments: { path: "app.js", content: "v2\n" } }] } },
            { turn: { type: "final", content: "done" } },
          ]),
      }
    );

    const beforeCheckpoint = await getSessionChanges(registry, sessionId);
    check("no checkpoint yet reports ok:false with a clear error", beforeCheckpoint.ok === false && beforeCheckpoint.error === "No checkpoint available for this session.");

    await runTask(registry, sessionId, "bump the version", () => {});

    const changesResult = await getSessionChanges(registry, sessionId);
    if (!changesResult.ok) throw new Error(`expected ok:true, got error: ${changesResult.error}`);
    check("reports exactly the 1 changed file", changesResult.changes.length === 1);
    check("the changed file is app.js, reported as modified", changesResult.changes[0]?.path === "app.js" && changesResult.changes[0]?.status === "modified");
    check("its diff shows the old content removed", !!changesResult.changes[0]?.diff.some((c) => c.removed && c.value === "v1\n"));
    check("its diff shows the new content added", !!changesResult.changes[0]?.diff.some((c) => c.added && c.value === "v2\n"));

    await fs.rm(repo, { recursive: true, force: true });
  }

  {
    // The running-guard: revertSessionCheckpoint must refuse while a task
    // is actively in flight, not race a write against the revert.
    const registry = createSessionRegistry(sessionsDir);
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider([{ turn: { type: "final", content: "done" } }]) }
    );
    const runPromise = runTask(registry, sessionId, "do something", () => {});
    // entry.running is set synchronously inside runTask before its first
    // await, so this check — made before awaiting runPromise — reliably
    // lands while the task is still "running" from the registry's view,
    // regardless of how fast MockProvider itself resolves.
    const whileRunning = await revertSessionCheckpoint(registry, sessionId);
    check("revertSessionCheckpoint refuses while a task is running", whileRunning.ok === false && whileRunning.error === "Can't revert while a task is running.");
    await runPromise;
  }

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

  await fs.rm(sessionsDir, { recursive: true, force: true });

  console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})();
