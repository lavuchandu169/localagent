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
  getSessionIdsWithPendingApproval,
  withPendingApprovalEntries,
  getSessionOwnerEmail,
  isOwnerMatch,
  stopTask,
} from "../../electron/sessionRegistry.js";
import { MockProvider } from "../../providers/mockProvider.js";
import { loadSessionRecord, listSessions, searchSessions, readPendingDeletes } from "../../sessionStore.js";
import { DriveScopeError } from "../../cloudSync.js";
import { groupDiffIntoSegments } from "../../diffUtil.js";
import type { AgentEvent, ChatRequest, ChatResponse, HealthCheckResult, ModelProvider } from "../../types.js";
import { ProviderChatError } from "../../types.js";
import { saveOpenAISettings } from "../../electron/openaiSettings.js";
import { saveAnthropicSettings } from "../../electron/anthropicSettings.js";

// A fixed sleep-then-check ("wait 50ms, assume the ASK prompt arrived by
// now") is exactly how the partial-hunk-approval test above flaked: a
// two-tool-call script (read_file then edit_file) genuinely needs more
// than one round trip to reach its edit_file permission.request, so the
// fixed budget sometimes checked too early, found no matching event, and
// approved a call id that hadn't been requested yet — leaving the real,
// later request with no one left to answer it. Polling for the actual
// condition removes the guess entirely.
async function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 5): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met within timeout");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Same polling contract as waitFor, for a condition that itself requires an async check (e.g. reading a file) — waitFor's own predicate type is synchronous only, and a Promise object is always truthy, so passing an async predicate there would silently "pass" on the very first check instead of actually waiting. */
async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 2000, intervalMs = 5): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("waitForAsync: condition not met within timeout");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

// Promise.race's losing side keeps its timer running for the full delay
// even after the race settles — with two 5s timeouts near the end of this
// file, those dangling timers were still pending when the file's very last
// line called process.exit(), which Node's "unsettled top-level await"
// diagnostic treats as a bug: it overrides the explicit exit code with 13
// instead. clearTimeout in a finally block once the race settles avoids it.
async function raceWithTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, "..", "..", "..", "fixture-repo");
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
    const extraTool = {
      name: "mcp__github__ping",
      description: "[MCP: github] Replies with pong",
      permission: "DANGEROUS" as const,
      inputSchema: { type: "object", properties: {} },
      async execute() {
        return { ok: true, output: { content: "pong" } };
      },
    };
    const provider = new MockProvider([{ turn: { type: "final", content: "done" } }]);
    await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => provider, getExtraTools: () => [extraTool] }
    );
    const sessionId = [...registry.sessions.keys()][0]!;
    await runTask(registry, sessionId, "anything", () => {});
    const toolNames = provider.receivedRequests[0]?.tools?.map((t) => t.name) ?? [];
    check("extraTools passed to startSession reach the model's tool list", toolNames.includes("mcp__github__ping"));
  }

  {
    // Correctness audit finding (MCP Medium): an already-started session
    // previously kept whatever extraTools snapshot existed at
    // agent:start-session time for its entire life — an MCP server
    // disconnected or removed afterward stayed fully callable (and a newly
    // added one stayed invisible) until the session was restarted. A live
    // getExtraTools() closure, re-called on every turn rather than
    // snapshotted once, fixes that: this session starts with the tool
    // present, the test then removes it from the SAME live source the
    // registry was given, and the session's very next task must no longer
    // see it — with no restart in between.
    const registry = createSessionRegistry(sessionsDir);
    const extraTool = {
      name: "mcp__github__ping",
      description: "[MCP: github] Replies with pong",
      permission: "DANGEROUS" as const,
      inputSchema: { type: "object", properties: {} },
      async execute() {
        return { ok: true, output: { content: "pong" } };
      },
    };
    let liveTools = [extraTool];
    const provider = new MockProvider([
      { turn: { type: "final", content: "first" } },
      { turn: { type: "final", content: "second" } },
    ]);
    await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => provider, getExtraTools: () => liveTools }
    );
    const sessionId = [...registry.sessions.keys()][0]!;
    await runTask(registry, sessionId, "first task", () => {});
    const firstToolNames = provider.receivedRequests[0]?.tools?.map((t) => t.name) ?? [];
    check("the tool is visible on the first task, before anything changes", firstToolNames.includes("mcp__github__ping"));

    liveTools = []; // simulates the MCP server being disconnected/removed mid-session, with no restart
    await runTask(registry, sessionId, "second task", () => {});
    const secondToolNames = provider.receivedRequests[1]?.tools?.map((t) => t.name) ?? [];
    check(
      "the already-started session's NEXT task no longer sees the removed tool, with no restart",
      !secondToolNames.includes("mcp__github__ping")
    );
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
    let message = "";
    try {
      await startSession(
        registry,
        { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
        { providerFactory: () => ({ id: "unhealthy", listModels: async () => [], healthCheck: async () => ({ ok: false, error: "fake failure" }), chat: async () => { throw new Error("should not be called"); } }) }
      );
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    check("startSession rejects when the provider's health check fails", threw);
    check("the thrown error carries the real failure reason, not a generic message", message.includes("fake failure"));
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
    check("buildProvider accepts a custom hf: path not in the curated list", (() => {
      try {
        buildProvider({ kind: "embedded", size: "hf:IFM/K2-Horizon-7B-GGUF:Q4_K_M" });
        return true;
      } catch {
        return false;
      }
    })());
  }

  console.log("\nbuildProvider handles the new openai/gemini kinds:");
  {
    const openai = buildProvider({ kind: "openai", apiKey: "sk-test" });
    check("buildProvider returns an OpenAIProvider for kind 'openai'", openai.id === "openai");
    const gemini = buildProvider({ kind: "gemini", apiKey: "gk-test" });
    check("buildProvider returns a GeminiProvider for kind 'gemini'", gemini.id === "gemini");
  }

  console.log("\nbuildProvider handles the freellmapi kind:");
  {
    const freellmapi = buildProvider({ kind: "freellmapi", userDataDir: "/tmp/does-not-matter" });
    check("buildProvider returns a FreellmapiProxyProvider for kind 'freellmapi'", freellmapi.id === "freellmapi");
  }
  {
    check("buildProvider throws a clear error if userDataDir was never resolved", (() => {
      try {
        buildProvider({ kind: "freellmapi" });
        return false;
      } catch (err) {
        return err instanceof Error && err.message.includes("userDataDir");
      }
    })());
  }

  console.log("\nstartSession builds fallbackProviders from saved settings when the primary is a cloud provider:");
  await (async () => {
    const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-session-fallback-test-"));
    await saveOpenAISettings(path.join(settingsDir, "openaiSettings.json"), { apiKey: "sk-fallback" });

    const registry = createSessionRegistry(sessionsDir);
    const failingScript = [{ throws: new ProviderChatError("rate limited", { status: 429, retryable: true }) }];
    const fallbackScript: ChatResponse[] = [{ turn: { type: "final", content: "done via fallback" } }];
    // Config-aware, so the primary (anthropic) gets the failing script and
    // the fallback candidate built from the saved OpenAI key gets a fresh,
    // succeeding one — proving the real fallback provider (not a copy of
    // the failing one) is what actually answers the retried turn.
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "anthropic", apiKey: "ak-primary" }, mode: "DEFAULT" },
      {
        providerFactory: (c) => (c.kind === "anthropic" ? new MockProvider(failingScript as any) : new MockProvider(fallbackScript)),
        settingsDir,
      }
    );
    const events: AgentEvent[] = [];
    await runTask(registry, sessionId, "say hi", (e) => events.push(e));
    check(
      "a session started with Anthropic as primary falls back to the saved OpenAI key on a retryable error",
      events.some((e) => e.type === "status" && e.message.includes("hit a rate limit"))
    );
    check("the task completes successfully via the fallback", events.some((e) => e.type === "done" && e.success === true));
  })();

  console.log("\nstartSession builds fallbackProviders from saved cloud settings when the primary is freellmapi (router exhausted):");
  await (async () => {
    // Spec requirement: when the free-tier router itself comes back
    // rate-limit-exhausted (every one of its ~34 upstream providers out of
    // quota), the app must fall back to a configured cloud provider — same
    // mechanism as cloud-primary fallback above, but freellmapi is never a
    // CloudProviderKind (no per-provider settings file, never a valid
    // fallback TARGET), so this exercises the excludeKind:undefined path.
    const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-session-fallback-test-"));
    await saveOpenAISettings(path.join(settingsDir, "openaiSettings.json"), { apiKey: "sk-fallback" });

    const registry = createSessionRegistry(sessionsDir);
    const failingScript = [{ throws: new ProviderChatError("router exhausted", { status: 429, retryable: true }) }];
    const fallbackScript: ChatResponse[] = [{ turn: { type: "final", content: "done via fallback" } }];
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "freellmapi", userDataDir: "/tmp/does-not-matter" }, mode: "DEFAULT" },
      {
        providerFactory: (c) => (c.kind === "freellmapi" ? new MockProvider(failingScript as any) : new MockProvider(fallbackScript)),
        settingsDir,
      }
    );
    const events: AgentEvent[] = [];
    await runTask(registry, sessionId, "say hi", (e) => events.push(e));
    check(
      "a session started with freellmapi as primary falls back to the saved OpenAI key when the router is exhausted",
      events.some((e) => e.type === "status" && e.message.includes("hit a rate limit"))
    );
    check("the task completes successfully via the fallback", events.some((e) => e.type === "done" && e.success === true));
  })();

  console.log("\nstartSession does NOT build fallbackProviders when the primary is embedded or a custom server:");
  await (async () => {
    // Config-aware, deliberately the mirror image of the "builds
    // fallbackProviders" test above: if the exclusion guard were ever
    // removed or narrowed, this factory would hand back a SUCCEEDING
    // provider for the would-be fallback candidates, so the task would
    // complete successfully via the fallback — the same false-negative
    // this test exists to catch. A factory that returns a fresh throwing
    // mock for every kind (the bug this replaced) can't tell "the guard
    // held" apart from "the guard failed but the fallback also happened to
    // fail" — this one can.
    const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-session-fallback-test-"));
    await saveOpenAISettings(path.join(settingsDir, "openaiSettings.json"), { apiKey: "sk-fallback" });
    await saveAnthropicSettings(path.join(settingsDir, "anthropicSettings.json"), { apiKey: "ak-fallback" });

    const wouldBeFallback = new MockProvider([{ turn: { type: "final", content: "should never run" } }]);
    const registry = createSessionRegistry(sessionsDir);
    const script = [{ throws: new ProviderChatError("simulated crash", { retryable: true }) }];
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "openai-compatible", baseUrl: "http://localhost:1234/v1", model: "local-model" }, mode: "DEFAULT" },
      {
        providerFactory: (c) => (c.kind === "openai-compatible" ? new MockProvider(script as any) : wouldBeFallback),
        settingsDir,
      }
    );
    const events: AgentEvent[] = [];
    await runTask(registry, sessionId, "say hi", (e) => events.push(e));
    check(
      "a custom-server primary's error fails the task instead of falling back to a cloud provider it never asked for",
      events.some((e) => e.type === "done" && e.success === false)
    );
    check(
      "no fallback switch was ever attempted",
      !events.some((e) => e.type === "status" && e.message.includes("hit a rate limit"))
    );
    check("the would-be fallback provider was never even constructed/called", wouldBeFallback.receivedRequests.length === 0);
  })();

  console.log("\nstartSession does NOT build fallbackProviders when the primary is the embedded local model:");
  await (async () => {
    const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-session-fallback-test-"));
    await saveOpenAISettings(path.join(settingsDir, "openaiSettings.json"), { apiKey: "sk-fallback" });
    await saveAnthropicSettings(path.join(settingsDir, "anthropicSettings.json"), { apiKey: "ak-fallback" });

    const wouldBeFallback = new MockProvider([{ turn: { type: "final", content: "should never run" } }]);
    const registry = createSessionRegistry(sessionsDir);
    const script = [{ throws: new ProviderChatError("simulated crash", { retryable: true }) }];
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "DEFAULT" },
      {
        providerFactory: (c) => (c.kind === "embedded" ? new MockProvider(script as any) : wouldBeFallback),
        settingsDir,
      }
    );
    const events: AgentEvent[] = [];
    await runTask(registry, sessionId, "say hi", (e) => events.push(e));
    check(
      "an embedded-model primary's error fails the task instead of silently switching to a cloud provider",
      events.some((e) => e.type === "done" && e.success === false)
    );
    check(
      "no fallback switch was ever attempted",
      !events.some((e) => e.type === "status" && e.message.includes("hit a rate limit"))
    );
    check("the would-be fallback provider was never even constructed/called", wouldBeFallback.receivedRequests.length === 0);
  })();

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

  console.log("\ngetSessionIdsWithPendingApproval (correctness audit: session Medium #4):");
  {
    // Closing a tab for a session with an in-flight permission ASK never
    // cancels that approval — the task just sits there forever, waiting
    // for a click nothing can send it again. This is the mechanism a
    // sidebar "waiting for approval" indicator reads from, independent of
    // whether any tab is currently open for the session.
    let changeNotifications = 0;
    const registry = createSessionRegistry(sessionsDir, undefined, () => {
      changeNotifications++;
    });
    const script: ChatResponse[] = [
      { turn: { type: "tool_calls", toolCalls: [{ id: "c1", name: "run_command", arguments: { command: "echo hi" } }] } },
      { turn: { type: "final", content: "ran it" } },
    ];
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "DEFAULT" },
      { providerFactory: () => new MockProvider(script) }
    );

    check("before the task starts, nothing is pending", !getSessionIdsWithPendingApproval(registry).has(sessionId));

    let sawPendingDuringRun = false;
    const events: AgentEvent[] = [];
    const runPromise = runTask(registry, sessionId, "run echo", (e: AgentEvent) => {
      events.push(e);
      if (e.type === "permission.request" && e.decision === "ASK") {
        // The generator yields this event BEFORE it actually calls
        // onApprovalNeeded() and registers the pending resolve function —
        // same ordering subtlety as every other deferred-respond test in
        // this file — so the pending-check must be deferred too, not read
        // synchronously in this same tick.
        setImmediate(() => {
          sawPendingDuringRun = getSessionIdsWithPendingApproval(registry).has(sessionId);
          respondPermission(registry, sessionId, e.call.id, true);
        });
      }
    });
    await runPromise;

    check("the session id is reported as pending while the ASK is unanswered", sawPendingDuringRun);
    check("once answered, it's no longer reported as pending", !getSessionIdsWithPendingApproval(registry).has(sessionId));
    check("onPendingApprovalsChanged fired at least once for the start and once for the answer", changeNotifications >= 2);
  }
  {
    // The abandoned-tab scenario itself: a task is left hanging on an
    // unanswered ASK (no respondPermission ever called, simulating the
    // tab that would have sent it being closed), and the session is then
    // cancelled (closeFreellmapiFallbackPanel's "Can't revert while a task
    // is running" guard aside, this mirrors what closing a session's tab
    // actually invokes server-side). The pending approval must be swept
    // and the indicator cleared, not left dangling forever.
    const registry = createSessionRegistry(sessionsDir);
    const script: ChatResponse[] = [{ turn: { type: "tool_calls", toolCalls: [{ id: "c1", name: "run_command", arguments: { command: "echo hi" } }] } }];
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "DEFAULT" },
      { providerFactory: () => new MockProvider(script) }
    );

    const runPromise = runTask(registry, sessionId, "run echo", () => {});
    await waitFor(() => getSessionIdsWithPendingApproval(registry).has(sessionId));
    check("the abandoned task is reported as pending before cleanup", getSessionIdsWithPendingApproval(registry).has(sessionId));

    await cancelSession(registry, sessionId);
    await runPromise.catch(() => {});
    check("cancelSession sweeps the dangling approval — no longer reported as pending", !getSessionIdsWithPendingApproval(registry).has(sessionId));
  }

  console.log("\nwithPendingApprovalEntries synthesizes a row for a brand-new, never-persisted session (final-review finding I4):");
  {
    // A session's disk record is only ever written once a task completes
    // (persistSession) — a session whose very FIRST task is still waiting
    // on an approval has no disk record at all yet, so flagging only
    // entries the disk-backed list already returned left it invisible no
    // matter what. agent:list-sessions must synthesize a row for it.
    const registry = createSessionRegistry(sessionsDir);
    const script: ChatResponse[] = [{ turn: { type: "tool_calls", toolCalls: [{ id: "c1", name: "run_command", arguments: { command: "echo hi" } }] } }];
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "DEFAULT" },
      { providerFactory: () => new MockProvider(script) }
    );
    const runPromise = runTask(registry, sessionId, "a brand new session's first task", () => {});
    await waitFor(() => getSessionIdsWithPendingApproval(registry).has(sessionId));

    check("this session genuinely has no disk record yet", (await loadSessionRecord(sessionsDir, sessionId)) === null);

    const entries = withPendingApprovalEntries(registry, await listSessions(sessionsDir, null), null);
    const synthesized = entries.find((e) => e.id === sessionId);
    check("a synthetic row is included even though nothing is on disk", synthesized !== undefined);
    check("its waitingForApproval flag is true", synthesized?.waitingForApproval === true);
    check("its title comes from the live entry (derived from the task text)", synthesized?.title === "a brand new session's first task");

    // A DIFFERENT account's view must never see another account's pending session.
    const otherAccountEntries = withPendingApprovalEntries(registry, await listSessions(sessionsDir, "someone-else@example.com"), "someone-else@example.com");
    check("a different signed-in account never sees it", otherAccountEntries.every((e) => e.id !== sessionId));

    // A search for unrelated text must not surface it either.
    const searchMiss = withPendingApprovalEntries(registry, await searchSessions(sessionsDir, "unrelated query", null), null, "unrelated query");
    check("an unrelated search query doesn't surface it", searchMiss.every((e) => e.id !== sessionId));

    await cancelSession(registry, sessionId);
    await runPromise.catch(() => {});
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
        resume: { sessionId, initialMessages: [{ role: "system", content: "sys" }], priorEvents: [], title: "t", createdAt: Date.now(), ownerEmail: null, checkpointHash: null, checkpointWorkspaceRoot: null },
      }
    );
    check("starting a new session under the same just-cancelled id succeeds", restarted.sessionId === sessionId);
    check("the registry now holds exactly the new entry, not a stale one", registry.sessions.has(sessionId));
  }

  console.log("stopTask (session-level): stops only the running task, leaves the session usable for a next one:");

  {
    // No task running at all — must be a safe no-op, not a throw, and must
    // not touch the entry (unlike cancelSession, which always tears down).
    const registry = createSessionRegistry(sessionsDir);
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "DEFAULT" },
      { providerFactory: () => new MockProvider([]) }
    );
    stopTask(registry, sessionId);
    check("stopTask on a session with nothing running is a safe no-op", registry.sessions.has(sessionId));
  }

  {
    // Hangs on its first chat() call until aborted (simulating a real
    // in-flight provider call), then answers normally — lets this test
    // verify stopTask aborts a call ACTUALLY in flight, not just a
    // pre-cancelled one, and that the session survives to run a second task.
    class HangingThenRespondingProvider implements ModelProvider {
      id = "test-hanging";
      calls = 0;
      chatCalled = false;
      async listModels() {
        return [];
      }
      async healthCheck(): Promise<HealthCheckResult> {
        return { ok: true };
      }
      async chat(request: ChatRequest): Promise<ChatResponse> {
        this.calls++;
        this.chatCalled = true;
        if (this.calls === 1) {
          return new Promise((_resolve, reject) => {
            request.signal?.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })));
          });
        }
        return { turn: { type: "final", content: "second task done" } };
      }
    }

    const registry = createSessionRegistry(sessionsDir);
    const provider = new HangingThenRespondingProvider();
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "DEFAULT" },
      { providerFactory: () => provider }
    );

    const events: AgentEvent[] = [];
    const runPromise = runTask(registry, sessionId, "do something slow", (e) => events.push(e));
    await waitFor(() => provider.chatCalled);

    stopTask(registry, sessionId);
    await runPromise;

    const done = events.find((e) => e.type === "done");
    check(
      "stopTask ends the in-flight run with 'Cancelled by user', not a provider-error",
      done?.type === "done" && done.success === false && done.summary === "Cancelled by user."
    );
    check("stopTask does NOT remove the entry from the registry (unlike cancelSession)", registry.sessions.has(sessionId));

    const secondEvents: AgentEvent[] = [];
    await runTask(registry, sessionId, "a second task after the stop", (e) => secondEvents.push(e));
    const secondDone = secondEvents.find((e) => e.type === "done");
    check(
      "the session accepts and completes a new task right after stopTask, with no 'already in progress' error",
      secondDone?.type === "done" && secondDone.success === true
    );
  }

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
    // Wait for the actual edit_file ASK prompt — the read_file turn before it
    // needs its own round trip first, so a fixed sleep can't reliably outlast it.
    await waitFor(() => events.some((e) => e.type === "permission.request" && e.call.name === "edit_file"));

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
          checkpointHash: null,
          checkpointWorkspaceRoot: null,
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
    // Wait for the actual ASK prompt rather than assuming a fixed delay covers it.
    await waitFor(() => events.some((e) => e.type === "permission.request" && e.call.name === "edit_file"));

    // removeSession must resolve the pending approval (with false) rather than
    // leaving runTask hanging forever.
    await raceWithTimeout(removeSession(registry, sessionId), 5000, "removeSession did not resolve in time");
    await raceWithTimeout(runPromise, 5000, "runTask hung after removeSession — pending approval was never resolved");

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
        return { modifiedTime: "2024-01-01T00:00:00.000Z" };
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
        return { modifiedTime: "2024-01-01T00:00:00.000Z" };
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

  {
    // Drive delete-propagation edge case (README's own "What's not built
    // yet"): deleting a session while signed out used to just silently
    // drop the delete intent — the local record was already gone, but
    // nothing ever told Drive, so the next reconcile pulled the "still
    // there" remote copy right back down. syncDeleteFromCloud now records
    // the id as a pending delete instead of giving up outright.
    const registry = createSessionRegistry(sessionsDir, {
      getAccessToken: async () => null, // signed out
      onScopeError: () => {
        throw new Error("should not be called");
      },
      getOwnerEmail: async () => null,
    });
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider([]) }
    );
    await removeSession(registry, sessionId);
    check("the session is actually gone locally", (await loadSessionRecord(sessionsDir, sessionId)) === null);
    // syncDeleteFromCloud is deliberately fire-and-forget (removeSession
    // doesn't await it, so a real delete never blocks on a network call) —
    // its own addPendingDelete write (real disk I/O: read+write+rename)
    // hasn't necessarily finished the instant removeSession's own promise
    // resolves. Poll instead of a fixed sleep, same reasoning as this
    // file's own waitFor doc comment above.
    await waitForAsync(async () => (await readPendingDeletes(sessionsDir)).includes(sessionId));
    check("deleting while signed out records a pending delete instead of silently dropping it", (await readPendingDeletes(sessionsDir)).includes(sessionId));
  }

  {
    // Same edge case, the other failure shape: signed in, but the delete
    // call itself fails (network blip, token rejected mid-request, etc.) —
    // not just "no token at all".
    const registry = createSessionRegistry(sessionsDir, {
      getAccessToken: async () => "fake-token",
      onScopeError: () => {
        throw new Error("should not be called — this is a transient failure, not a scope error");
      },
      deleteRemoteSession: async () => {
        throw new Error("simulated transient network failure");
      },
      getOwnerEmail: async () => null,
    });
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider([]) }
    );
    await removeSession(registry, sessionId);
    await waitForAsync(async () => (await readPendingDeletes(sessionsDir)).includes(sessionId));
    check("a failed (not just un-attemptable) remote delete also records a pending delete", (await readPendingDeletes(sessionsDir)).includes(sessionId));
  }

  console.log("\nsyncUploadToCloud doesn't overwrite newer local state with a stale snapshot (final-review finding C1):");
  {
    // Reproduces the exact race: task 1 finishes and starts a SLOW upload
    // of its own record. Before that upload's post-upload checkpoint save
    // completes, task 2 finishes and saves ITS OWN newer record. The slow
    // upload's checkpoint save must not then overwrite task 2's record
    // with the stale snapshot it captured when it started.
    let uploadCalls = 0;
    const registry = createSessionRegistry(sessionsDir, {
      getAccessToken: async () => "fake-token",
      onScopeError: () => {
        throw new Error("should not be called");
      },
      uploadSession: async () => {
        uploadCalls++;
        if (uploadCalls === 1) {
          // Task 1's upload is slow — long enough for task 2 to finish and
          // save first.
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        return { modifiedTime: `modified-${uploadCalls}` };
      },
      getOwnerEmail: async () => null,
    });
    const provider = new MockProvider([{ turn: { type: "final", content: "first" } }, { turn: { type: "final", content: "second" } }]);
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => provider }
    );

    // Deliberately not awaited — task 1's own persistSession/saveSession
    // completes synchronously as part of runTask, but its fire-and-forget
    // upload (the slow one) is still in flight when this call returns.
    await runTask(registry, sessionId, "task one", () => {});
    await runTask(registry, sessionId, "task two", () => {});
    const afterTaskTwo = await loadSessionRecord(sessionsDir, sessionId);
    check("task two's record is on disk right after it completes", afterTaskTwo?.messages.some((m) => m.content === "task two") ?? false);

    // Give task 1's slow upload (and its post-upload checkpoint save) time
    // to actually finish.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const afterSlowUpload = await loadSessionRecord(sessionsDir, sessionId);
    check(
      "task two's content survives task one's slow, late-finishing upload — not rolled back to a stale snapshot",
      afterSlowUpload?.messages.some((m) => m.content === "task two") ?? false
    );
  }
  {
    // The deleted-session-resurrection variant: removeSession's file
    // delete doesn't wait for an in-flight upload from an earlier task to
    // finish, so a slow upload completing AFTER the delete must not bring
    // the file back.
    const registry = createSessionRegistry(sessionsDir, {
      getAccessToken: async () => "fake-token",
      onScopeError: () => {},
      uploadSession: async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { modifiedTime: "modified-late" };
      },
      deleteRemoteSession: async () => {},
      getOwnerEmail: async () => null,
    });
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider([{ turn: { type: "final", content: "done" } }]) }
    );
    await runTask(registry, sessionId, "a task", () => {});
    await removeSession(registry, sessionId);
    const rightAfterDelete = await loadSessionRecord(sessionsDir, sessionId);
    check("the session is gone right after removeSession", rightAfterDelete === null);

    await new Promise((resolve) => setTimeout(resolve, 250));
    const afterSlowUpload = await loadSessionRecord(sessionsDir, sessionId);
    check("the deleted session does NOT come back once the slow upload finally finishes", afterSlowUpload === null);
  }

  console.log("\nSession ownership:");
  {
    const registry = createSessionRegistry(sessionsDir, {
      getAccessToken: async () => "fake-token",
      onScopeError: () => {},
      uploadSession: async () => ({ modifiedTime: "2024-01-01T00:00:00.000Z" }),
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
      uploadSession: async () => ({ modifiedTime: "2024-01-01T00:00:00.000Z" }),
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
          checkpointHash: null,
          checkpointWorkspaceRoot: null,
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
    check("its workspaceRoot matches what the session was actually started with", snapshot?.workspaceRoot === workspaceRoot);
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
    check(
      "getLiveSessionSnapshot's workspaceRoot reflects the mid-session edit, not the original — a tab reattaching to this live session (see resumeSession in renderer.ts) has no other source for it",
      getLiveSessionSnapshot(registry, sessionId)?.workspaceRoot === "/some/other/path"
    );
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
    // Correctness audit finding (session Medium #3): revertSessionCheckpoint
    // had no try/catch around revertToCheckpoint, unlike getSessionChanges'
    // own identical-shaped call a few lines below it — any real failure
    // (not just the workspace-switch case setWorkspaceRoot now prevents by
    // clearing checkpointHash) propagated as an unhandled rejection
    // instead of the clear {ok:false, error} this function's own return
    // type promises. Reproduced with a REAL failure mode, not a mock: a
    // checkpoint is a deliberately dangling, unreferenced git commit (see
    // checkpoints.ts's own doc comment — "eventually GC'd"), so an
    // aggressive gc can genuinely prune it out from under a later revert.
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-sessionregistry-checkpoint-gc-test-"));
    const execFileAsync2 = promisify(execFile);
    const git2 = async (args: string[]) => (await execFileAsync2("git", args, { cwd: repo })).stdout.trim();
    await git2(["init", "-q"]);
    await git2(["config", "user.email", "t@t.com"]);
    await git2(["config", "user.name", "T"]);
    await fs.writeFile(path.join(repo, "a.txt"), "v1\n", "utf-8");
    await git2(["add", "-A"]);
    await git2(["commit", "-q", "-m", "initial"]);

    const registry = createSessionRegistry(sessionsDir);
    // read_file first, matching this file's established pattern — edit_file
    // on a path never read this session gets ASKed even in ACCEPT_EDITS
    // (the read-before-write override), and nothing here answers that ask.
    const script: ChatResponse[] = [
      {
        turn: {
          type: "tool_calls",
          toolCalls: [
            { id: "r1", name: "read_file", arguments: { path: "a.txt" } },
            { id: "e1", name: "edit_file", arguments: { path: "a.txt", content: "v2\n" } },
          ],
        },
      },
      { turn: { type: "final", content: "done" } },
    ];
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot: repo, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "ACCEPT_EDITS" },
      { providerFactory: () => new MockProvider(script) }
    );
    await runTask(registry, sessionId, "bump the file", () => {});
    check("a real checkpoint exists", typeof getCheckpointHash(registry, sessionId) === "string");

    // Prune the dangling checkpoint commit out from under the session —
    // a real, reproducible way revertToCheckpoint can genuinely fail
    // without any test-only hook or mock.
    await git2(["reflog", "expire", "--expire=now", "--all"]);
    await git2(["gc", "--prune=now"]);

    let threw = false;
    let revertResult: { ok: boolean; error?: string } | undefined;
    try {
      revertResult = await revertSessionCheckpoint(registry, sessionId);
    } catch {
      threw = true;
    }
    check("revertSessionCheckpoint never throws uncaught — it returns {ok:false, error} like getSessionChanges already does", !threw);
    check("the failure is reported with a real error message, not silently swallowed either", revertResult?.ok === false && !!revertResult.error);

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
    // entry.inFlightOperation is set synchronously inside runTask before
    // its first await, so this check — made before awaiting runPromise —
    // reliably lands while the task is still in flight from the
    // registry's view, regardless of how fast MockProvider itself resolves.
    const whileRunning = await revertSessionCheckpoint(registry, sessionId);
    check("revertSessionCheckpoint refuses while a task is running", whileRunning.ok === false && whileRunning.error === "Can't revert while a task is running.");
    await runPromise;
  }

  {
    // Correctness audit finding (session Medium #2): the OPPOSITE
    // direction of the guard above — a runTask call started WHILE a
    // revert is still mid-flight must be refused too, not race a live
    // agent write against the revert's own checkout+cleanup. Before this
    // fix, revertSessionCheckpoint only checked entry.inFlightOperation
    // ONCE (synchronously) then ran several awaited git subprocess calls with
    // no lock held across that window — nothing stopped a runTask call
    // issued during that window from starting a real task concurrently.
    const registry = createSessionRegistry(sessionsDir);
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-sessionregistry-revertrace-test-"));
    const execFileAsync2 = promisify(execFile);
    const git2 = async (args: string[]) => (await execFileAsync2("git", args, { cwd: repo })).stdout.trim();
    await git2(["init", "-q"]);
    await git2(["config", "user.email", "t@t.com"]);
    await git2(["config", "user.name", "T"]);
    await fs.writeFile(path.join(repo, "a.txt"), "v1\n", "utf-8");
    await git2(["add", "-A"]);
    await git2(["commit", "-q", "-m", "initial"]);

    const script: ChatResponse[] = [
      {
        turn: {
          type: "tool_calls",
          toolCalls: [
            { id: "r1", name: "read_file", arguments: { path: "a.txt" } },
            { id: "e1", name: "edit_file", arguments: { path: "a.txt", content: "v2\n" } },
          ],
        },
      },
      { turn: { type: "final", content: "done" } },
    ];
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot: repo, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "ACCEPT_EDITS" },
      { providerFactory: () => new MockProvider(script) }
    );
    await runTask(registry, sessionId, "bump the file", () => {});
    check("a real checkpoint exists before the race", typeof getCheckpointHash(registry, sessionId) === "string");

    // entry.inFlightOperation is set synchronously inside
    // revertSessionCheckpoint too (this fix), before its first await — so
    // a runTask call made immediately after, without awaiting the revert
    // first, reliably lands while the revert is still in flight from the
    // registry's view, same reliability guarantee the existing test above
    // already relies on for the opposite direction.
    const revertPromise = revertSessionCheckpoint(registry, sessionId);
    let rejected = false;
    try {
      await runTask(registry, sessionId, "a second task racing the revert", () => {});
    } catch {
      rejected = true;
    }
    check("runTask refuses to start while a revert is mid-flight for this session", rejected);

    // Code-review finding (Optional, type-design clarity): the lock's
    // `kind` lets revertSessionCheckpoint tell "a task is running" apart
    // from "a revert is already running" instead of reporting the same
    // generic message either way — exercised here by calling revert a
    // second time while the first is still mid-flight.
    const secondRevertWhileFirstStillRunning = await revertSessionCheckpoint(registry, sessionId);
    check(
      "a second concurrent revert call gets its own distinct error message, not the task-specific one",
      secondRevertWhileFirstStillRunning.ok === false && secondRevertWhileFirstStillRunning.error === "A revert is already in progress for this session."
    );

    const revertResult = await revertPromise;
    check("the revert itself still completed successfully, undisturbed", revertResult.ok === true);

    await fs.rm(repo, { recursive: true, force: true });
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

  console.log("\ngetSessionOwnerEmail (security audit finding: session-ipc-missing-owner-authorization):");
  {
    // Live session, never yet persisted to disk — ownership must come
    // from the in-memory entry, not a disk read (there's nothing on disk
    // yet to read).
    const registry = createSessionRegistry(sessionsDir, {
      getAccessToken: async () => "fake-token",
      onScopeError: () => {},
      uploadSession: async () => ({ modifiedTime: "2024-01-01T00:00:00.000Z" }),
      getOwnerEmail: async () => "live-owner@example.com",
    });
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => new MockProvider([]) }
    );
    check("resolves the live entry's owner for a session never yet persisted to disk", (await getSessionOwnerEmail(registry, sessionId)) === "live-owner@example.com");
  }
  {
    // Persisted to disk, then the in-memory registry forgotten (simulates
    // an app restart) — ownership must fall back to the on-disk record.
    const registry = createSessionRegistry(sessionsDir);
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      {
        providerFactory: () => new MockProvider([{ turn: { type: "final", content: "done" } }]),
        resume: {
          sessionId: "disk-only-owned-session",
          initialMessages: [{ role: "system", content: "sys" }],
          priorEvents: [],
          title: "t",
          createdAt: Date.now(),
          ownerEmail: "disk-owner@example.com",
          checkpointHash: null,
          checkpointWorkspaceRoot: null,
        },
      }
    );
    await runTask(registry, sessionId, "persist it", () => {});
    registry.sessions.delete(sessionId); // simulate the live entry being gone (app restart)
    check("falls back to the on-disk record's owner once the live entry is gone", (await getSessionOwnerEmail(registry, sessionId)) === "disk-owner@example.com");
  }
  {
    const registry = createSessionRegistry(sessionsDir);
    check("returns undefined for a session id that exists nowhere at all — distinct from a real null owner", (await getSessionOwnerEmail(registry, "no-such-session-anywhere")) === undefined);
  }

  console.log("\nisOwnerMatch (the actual authorization decision main.ts's IPC handlers rely on):");
  {
    check("a session that exists nowhere (owner undefined) is allowed through even for a signed-out caller", isOwnerMatch(null, undefined) === true);
    check("a session that exists nowhere (owner undefined) is allowed through for any signed-in caller too", isOwnerMatch("someone@example.com", undefined) === true);
    check("the caller's own session (matching emails) is allowed", isOwnerMatch("owner@example.com", "owner@example.com") === true);
    check("a different account's session is denied — this is the exact cross-account leak the audit finding described", isOwnerMatch("attacker@example.com", "owner@example.com") === false);
    check("a signed-out caller (null) is denied access to a real session owned by someone", isOwnerMatch(null, "owner@example.com") === false);
    check("a legacy session with a real null owner is allowed only for a signed-out (null) caller", isOwnerMatch(null, null) === true);
    check("a legacy session with a real null owner is denied to a signed-in caller", isOwnerMatch("owner@example.com", null) === false);
  }

  console.log("\ndoRunTask does not persist/replay ephemeral streaming deltas (final review I4):");
  {
    // A streaming provider's text.delta/tool_call.start/tool_call.delta
    // events are a UI-only side channel — persisting every token would
    // double a long answer's footprint in entry.events (saved to disk and
    // uploaded via cloudSync, see persistSession).
    const registry = createSessionRegistry(sessionsDir);
    const fakeStreamingProvider = {
      id: "fake-streaming",
      async listModels() {
        return [{ id: "fake-model", local: false }];
      },
      async healthCheck(): Promise<{ ok: true }> {
        return { ok: true };
      },
      async chat(): Promise<ChatResponse> {
        throw new Error("chat() should not be called when chatStream is present");
      },
      async *chatStream(): AsyncGenerator<{ type: "text"; text: string } | { type: "done"; response: ChatResponse }> {
        yield { type: "text", text: "Hel" };
        yield { type: "text", text: "lo" };
        yield { type: "done", response: { turn: { type: "final", content: "Hello" } } };
      },
    };
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => fakeStreamingProvider }
    );
    await runTask(registry, sessionId, "say hello", () => {});

    const snapshot = getLiveSessionSnapshot(registry, sessionId);
    check("no text.delta events are persisted into the session's event history", !snapshot?.events.some((e) => e.type === "text.delta"));
    check("the terminal, non-ephemeral text event is still persisted normally", !!snapshot?.events.some((e) => e.type === "text" && e.text === "Hello"));
  }

  console.log("\npersistSession writes real provider/mode/planFirst/checkpointHash to disk, and resuming restores them (correctness audit: session High #1, #2):");
  {
    const registry = createSessionRegistry(sessionsDir);
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-sessionregistry-checkpoint-test-"));
    const execFileAsync2 = promisify(execFile);
    const git2 = async (args: string[]) => (await execFileAsync2("git", args, { cwd: repo })).stdout.trim();
    await git2(["init", "-q"]);
    await git2(["config", "user.email", "t@t.com"]);
    await git2(["config", "user.name", "T"]);
    await fs.writeFile(path.join(repo, "a.txt"), "v1\n", "utf-8");
    await git2(["add", "-A"]);
    await git2(["commit", "-q", "-m", "initial"]);

    // read_file first, matching the pattern this file's other tests use —
    // edit_file on a path never read this session gets ASKed even in
    // ACCEPT_EDITS (the read-before-write override), and this test has no
    // onApprovalNeeded wired up to ever answer that ask.
    const script: ChatResponse[] = [
      {
        turn: {
          type: "tool_calls",
          toolCalls: [
            { id: "r1", name: "read_file", arguments: { path: "a.txt" } },
            { id: "e1", name: "edit_file", arguments: { path: "a.txt", content: "v2\n" } },
          ],
        },
      },
      { turn: { type: "final", content: "done" } },
    ];
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot: repo, provider: { kind: "anthropic", model: "claude-opus-4" }, mode: "DEFAULT", planFirst: true },
      { providerFactory: () => new MockProvider(script) }
    );
    // A live mode change before the task runs, to prove persistSession
    // reads mode LIVE (entry.session.getPermissionMode()) rather than
    // whatever mode the session originally started with.
    updateLiveSessionSettings(registry, sessionId, { mode: "ACCEPT_EDITS" });
    // planFirst holds the task's first turn for approval — respond to it
    // so this task can actually reach completion (and take its
    // checkpoint) rather than hanging indefinitely. setImmediate (not a
    // synchronous call here) matches this file's own established pattern
    // elsewhere: respondPlan is called from the SAME onEvent callback
    // that's still synchronously processing the just-yielded
    // "plan.proposed" event, before agent.ts's generator has resumed
    // past the yield to actually register pendingPlanApproval.resolve —
    // calling it synchronously here is a no-op race that hangs forever.
    await runTask(registry, sessionId, "bump the file", (event) => {
      if (event.type === "plan.proposed") setImmediate(() => respondPlan(registry, sessionId, true));
    });

    const saved = await loadSessionRecord(sessionsDir, sessionId);
    check("the persisted record's provider.kind matches what the session was started with", saved?.provider?.kind === "anthropic");
    check("the persisted record's provider.model matches what the session was started with", (saved?.provider as any)?.model === "claude-opus-4");
    check("the persisted record's mode reflects the LIVE mode (after updateLiveSessionSettings), not the original DEFAULT", saved?.mode === "ACCEPT_EDITS");
    check("the persisted record's planFirst matches what the session was started with", saved?.planFirst === true);
    check("the persisted record's checkpointHash matches the live session's real checkpoint", typeof saved?.checkpointHash === "string" && saved.checkpointHash === registry.sessions.get(sessionId)?.session.getCheckpointHash());

    // Full round trip: resume a NEW registry (simulating an app restart)
    // from the persisted record and confirm settings/checkpoint restore.
    const registry2 = createSessionRegistry(sessionsDir);
    const resumeResult = await startSession(
      registry2,
      { workspaceRoot: repo, provider: saved!.provider as any, mode: saved!.mode as any, planFirst: saved!.planFirst },
      {
        providerFactory: () => new MockProvider([{ turn: { type: "final", content: "resumed" } }]),
        resume: {
          sessionId,
          initialMessages: saved!.messages,
          priorEvents: saved!.events,
          title: saved!.title,
          createdAt: saved!.createdAt,
          ownerEmail: saved!.ownerEmail,
          checkpointHash: saved!.checkpointHash,
          checkpointWorkspaceRoot: saved!.checkpointWorkspaceRoot,
        },
      }
    );
    check(
      "resuming from the persisted record restores getCheckpointHash() to the real checkpoint, not null",
      registry2.sessions.get(sessionId)?.session.getCheckpointHash() === saved?.checkpointHash
    );
    check(
      "startSession's own return value also carries the restored checkpointHash (final-review finding I3) — the renderer uses this to show Revert immediately on resume, not just after a later tab-switch replay",
      resumeResult.checkpointHash === saved?.checkpointHash && resumeResult.checkpointHash !== null
    );
    check(
      "the persisted record's checkpointWorkspaceRoot matches the workspace the checkpoint was actually made in (final-review finding C3)",
      saved?.checkpointWorkspaceRoot === repo
    );

    await fs.rm(repo, { recursive: true, force: true });
  }

  console.log("\nstartSession refuses to restore a checkpoint into a DIFFERENT workspace than it was made in (final-review finding C3):");
  {
    // The exact bug this closes: a checkpoint hash is a commit inside a
    // SPECIFIC git repo. Resuming (or a provider-change mid-session
    // restart) into some OTHER workspace with the old hash still attached
    // must not carry it over — usually that just makes a later revert
    // fail with "unknown revision", but git worktrees of the same
    // repository share one object database, where the hash can resolve
    // successfully in the WRONG worktree and overwrite its files.
    const execFileAsync = promisify(execFile);
    const repoA = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-checkpoint-workspace-a-"));
    const repoB = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-checkpoint-workspace-b-"));
    for (const repo of [repoA, repoB]) {
      await execFileAsync("git", ["init", "-q"], { cwd: repo });
      await execFileAsync("git", ["config", "user.email", "t@t.com"], { cwd: repo });
      await execFileAsync("git", ["config", "user.name", "T"], { cwd: repo });
      // createCheckpoint needs at least one real commit (it diffs against
      // HEAD) — an empty repo with zero commits always returns null.
      await fs.writeFile(path.join(repo, "seed.txt"), "seed\n", "utf-8");
      await execFileAsync("git", ["add", "-A"], { cwd: repo });
      await execFileAsync("git", ["commit", "-q", "-m", "seed"], { cwd: repo });
    }

    const registry = createSessionRegistry(sessionsDir);
    // read_file first, matching this file's own established pattern —
    // edit_file on a path never read this session gets ASKed even in
    // ACCEPT_EDITS (the read-before-write override), and this test has no
    // onApprovalNeeded wired up to ever answer that ask.
    const script: ChatResponse[] = [
      { turn: { type: "tool_calls", toolCalls: [{ id: "r1", name: "read_file", arguments: { path: "a.txt" } }, { id: "e1", name: "edit_file", arguments: { path: "a.txt", content: "v1\n" } }] } },
      { turn: { type: "final", content: "done" } },
    ];
    const { sessionId } = await startSession(
      registry,
      { workspaceRoot: repoA, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "ACCEPT_EDITS" },
      { providerFactory: () => new MockProvider(script) }
    );
    await runTask(registry, sessionId, "make a.txt", () => {});
    const saved = await loadSessionRecord(sessionsDir, sessionId);
    check("a real checkpoint was persisted, paired with repoA as its workspace", typeof saved?.checkpointHash === "string" && saved.checkpointWorkspaceRoot === repoA);

    // Resume the SAME session id, but into repoB this time.
    const registry2 = createSessionRegistry(sessionsDir);
    await startSession(
      registry2,
      { workspaceRoot: repoB, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "ACCEPT_EDITS" },
      {
        providerFactory: () => new MockProvider([]),
        resume: {
          sessionId,
          initialMessages: saved!.messages,
          priorEvents: saved!.events,
          title: saved!.title,
          createdAt: saved!.createdAt,
          ownerEmail: saved!.ownerEmail,
          checkpointHash: saved!.checkpointHash,
          checkpointWorkspaceRoot: saved!.checkpointWorkspaceRoot,
        },
      }
    );
    check(
      "the checkpoint is NOT restored into the mismatched workspace — getCheckpointHash() is null, not the old repoA hash",
      registry2.sessions.get(sessionId)?.session.getCheckpointHash() === null
    );

    await fs.rm(repoA, { recursive: true, force: true });
    await fs.rm(repoB, { recursive: true, force: true });
  }

  await fs.rm(sessionsDir, { recursive: true, force: true });

  console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})();
