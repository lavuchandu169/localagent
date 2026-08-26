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
  {
    const registry = createSessionRegistry();
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "small" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider([]) }
    );
    check("startSession returns a sessionId and registers it", registry.sessions.has(sessionId));
  }

  {
    const registry = createSessionRegistry();
    const { workspaceRoot: resolved } = await startSession(
      registry,
      { provider: { kind: "embedded", size: "small" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider([]) }
    );
    check("startSession defaults workspaceRoot to the home directory when none is given", resolved === os.homedir());
  }

  {
    const registry = createSessionRegistry();
    let threw = false;
    try {
      await startSession(
        registry,
        { workspaceRoot, provider: { kind: "embedded", size: "small" }, mode: "PLAN" },
        { providerFactory: () => ({ id: "unhealthy", listModels: async () => [], healthCheck: async () => false, chat: async () => { throw new Error("should not be called"); } }) }
      );
    } catch {
      threw = true;
    }
    check("startSession rejects when the provider's health check fails", threw);
  }

  {
    const registry = createSessionRegistry();
    let receivedCallback: unknown;
    await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "small" }, mode: "PLAN" },
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
    const registry = createSessionRegistry();
    const script: ChatResponse[] = [{ turn: { type: "final", content: "all done" } }];
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "small" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider(script) }
    );

    const events: AgentEvent[] = [];
    await runTask(registry, sessionId, "do a thing", (e: AgentEvent) => events.push(e));

    check("runTask streams events ending in done", events.length > 0 && events[events.length - 1]?.type === "done");
  }

  {
    const registry = createSessionRegistry();
    let threw = false;
    try {
      await runTask(registry, "not-a-real-session", "task", () => {});
    } catch {
      threw = true;
    }
    check("runTask rejects for an unknown sessionId", threw);
  }

  {
    const registry = createSessionRegistry();
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
    const registry = createSessionRegistry();
    const script: ChatResponse[] = [
      { turn: { type: "tool_calls", toolCalls: [{ id: "c1", name: "run_command", arguments: { command: "echo hi" } }] } },
      { turn: { type: "final", content: "ran it" } },
    ];
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "small" }, mode: "DEFAULT" },
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
    const registry = createSessionRegistry();
    const script: ChatResponse[] = [
      { turn: { type: "final", content: "first turn done (unused, cancelled first)" } },
    ];
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "small" }, mode: "PLAN" },
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

  console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})();
