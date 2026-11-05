import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { resolveRoleProviderConfig, startInitiativeSession, keyedProviderFactory, runOrganizationInitiative } from "../../electron/organizationSession.js";
import { createSessionRegistry, type ProviderConfig } from "../../electron/sessionRegistry.js";
import { MockProvider } from "../../providers/mockProvider.js";
import type { AgentEvent } from "../../types.js";
import type { Organization, Role, Initiative } from "../../organization.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

function role(model: string, overrides: Partial<Role> = {}): Role {
  return { id: "r-1", title: "Engineer", responsibilities: "Implements features", reportsTo: null, model, ...overrides };
}

function initiative(assignedRoleId: string | null, overrides: Partial<Initiative> = {}): Initiative {
  return { id: "i-1", title: "Add dark-mode toggle", assignedRoleId, status: "todo", notes: "", ...overrides };
}

const sampleOrgFor = (r: Role): Organization => ({ goal: "Ship v1.0", roles: [r], initiatives: [] });

console.log("resolveRoleProviderConfig:");
{
  const anthropic = resolveRoleProviderConfig(role("claude-sonnet-5"));
  check("resolves a known Anthropic model id", anthropic.ok === true && anthropic.config.kind === "anthropic" && (anthropic.config as any).model === "claude-sonnet-5");

  const openai = resolveRoleProviderConfig(role("gpt-5.5"));
  check("resolves a known OpenAI model id", openai.ok === true && openai.config.kind === "openai" && (openai.config as any).model === "gpt-5.5");

  const gemini = resolveRoleProviderConfig(role("gemini-3.8-flash"));
  check("resolves a known Gemini model id", gemini.ok === true && gemini.config.kind === "gemini" && (gemini.config as any).model === "gemini-3.8-flash");

  const free = resolveRoleProviderConfig(role("freellmapi-auto"));
  check("resolves the free-tier router", free.ok === true && free.config.kind === "freellmapi");

  const embedded = resolveRoleProviderConfig(role("qwen-coder-7b"));
  check("resolves a known embedded model id", embedded.ok === true && embedded.config.kind === "embedded" && (embedded.config as any).size === "qwen-coder-7b");

  const unknown = resolveRoleProviderConfig(role("some-made-up-model"));
  check("an unrecognized model id is a clean error, not a throw or a silent wrong guess", unknown.ok === false);
  check("the error names the role and the bad model id", unknown.ok === false && unknown.error.includes("Engineer") && unknown.error.includes("some-made-up-model"));

  const customServer = resolveRoleProviderConfig(role("custom-server"));
  check(
    "custom-server is explicitly unsupported for roles (no baseUrl/model fields on Role to resolve it with) rather than silently guessed",
    customServer.ok === false
  );

  const customEmbedded = resolveRoleProviderConfig(role("custom-embedded"));
  check("custom-embedded is explicitly unsupported for roles for the same reason", customEmbedded.ok === false);
}

console.log("\nstartInitiativeSession:");
await (async () => {
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-org-session-test-"));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-org-workspace-test-"));

  {
    const r = role("qwen-coder-1.5b");
    const init = initiative("r-1");
    const org = sampleOrgFor(r);
    const provider = new MockProvider([{ turn: { type: "final", content: "Added the toggle." } }]);
    const registry = createSessionRegistry(sessionsDir);
    const events: AgentEvent[] = [];
    let earlySessionId: string | undefined;
    let eventCountWhenStarted: number | undefined;
    const result = await startInitiativeSession(
      registry,
      org,
      init,
      r,
      workspaceRoot,
      (e) => events.push(e),
      { providerFactory: () => provider },
      (sid) => {
        earlySessionId = sid;
        eventCountWhenStarted = events.length;
      }
    );
    check("reports ok with a real sessionId", result.ok === true && typeof (result as any).sessionId === "string");
    check("the session is actually registered", result.ok === true && registry.sessions.has((result as any).sessionId));
    check("onSessionStarted fires with the SAME sessionId the final result reports", result.ok === true && earlySessionId === (result as any).sessionId);
    check("onSessionStarted fires BEFORE the task runs, not after — a caller gets the id early enough to open the tab while the task is still in flight", eventCountWhenStarted === 0);
    check("the composed task — not just the bare initiative title — is what the model received", provider.receivedRequests[0]?.messages.some((m) => typeof m.content === "string" && m.content.includes("Engineer") && m.content.includes("Add dark-mode toggle")) === true);
    check("the session actually ran to completion", events.some((e) => e.type === "done" && e.success === true));
  }

  {
    // DEFAULT mode, not ACCEPT_EDITS/AUTO_SAFE — a role carries no special
    // authority; every edit a role's turn makes still waits for approval,
    // exactly like a human-started session in the same mode would.
    const r = role("qwen-coder-1.5b");
    const init = initiative("r-1");
    const org = sampleOrgFor(r);
    const provider = new MockProvider([{ turn: { type: "final", content: "done" } }]);
    const registry = createSessionRegistry(sessionsDir);
    const result = await startInitiativeSession(registry, org, init, r, workspaceRoot, () => {}, { providerFactory: () => provider });
    check("ran in DEFAULT mode — no bypass of the normal approval flow", result.ok === true && registry.sessions.get((result as any).sessionId)?.session.getPermissionMode() === "DEFAULT");
  }

  {
    const r = role("some-made-up-model");
    const init = initiative("r-1");
    const org = sampleOrgFor(r);
    const registry = createSessionRegistry(sessionsDir);
    const result = await startInitiativeSession(registry, org, init, r, workspaceRoot, () => {}, { providerFactory: () => new MockProvider([]) });
    check("an unresolvable role model id is a clean error — no session ever starts", result.ok === false);
    check("the registry stays empty — nothing half-started", registry.sessions.size === 0);
  }

  {
    const r = role("qwen-coder-1.5b");
    const init = initiative("some-other-role-id"); // mismatched on purpose
    const org = sampleOrgFor(r);
    const registry = createSessionRegistry(sessionsDir);
    const result = await startInitiativeSession(registry, org, init, r, workspaceRoot, () => {}, { providerFactory: () => new MockProvider([]) });
    check("refuses to run a role against an initiative assigned to someone else", result.ok === false);
    check("names the mismatch in the error", result.ok === false && (result as any).error.includes(r.title));
  }

  {
    const r = role("qwen-coder-1.5b");
    const init = initiative("r-1");
    const org = sampleOrgFor(r);
    const registry = createSessionRegistry(sessionsDir);
    const result = await startInitiativeSession(registry, org, init, r, workspaceRoot, () => {
      throw new Error("should never be called — the provider itself must fail first");
    }, { providerFactory: () => ({ id: "unhealthy", listModels: async () => [], healthCheck: async () => ({ ok: false, error: "fake provider failure" }), chat: async () => { throw new Error("should not be called"); } }) });
    check("a provider health-check failure is a clean error, not a thrown exception escaping", result.ok === false);
  }

  await fs.rm(sessionsDir, { recursive: true, force: true });
  await fs.rm(workspaceRoot, { recursive: true, force: true });
})();

console.log("\nkeyedProviderFactory:");
{
  check("returns undefined when there's no resolved (keyed) config to substitute", keyedProviderFactory(undefined) === undefined);

  const resolved: ProviderConfig = { kind: "anthropic", apiKey: "sk-real-key", model: "claude-sonnet-5" };
  const calls: { config: ProviderConfig; onDownloadProgress: unknown; signal: unknown }[] = [];
  const fakeBuildProvider = ((config: ProviderConfig, onDownloadProgress?: unknown, signal?: unknown) => {
    calls.push({ config, onDownloadProgress, signal });
    return { id: "fake" } as any;
  }) as any;
  const factory = keyedProviderFactory(resolved, fakeBuildProvider);
  check("returns a providerFactory function when given a resolved config", typeof factory === "function");

  const onDownloadProgress = () => {};
  const signal = new AbortController().signal;
  // The first argument mirrors what startSession actually passes in: the
  // session's own UNKEYED provider config — it must be ignored in favor
  // of the keyed one this factory was built to substitute.
  factory!({ kind: "anthropic", model: "claude-sonnet-5" }, onDownloadProgress, signal);
  check("substitutes the keyed config, not the unkeyed one startSession passed in", calls[0]?.config === resolved);
  check(
    "forwards onDownloadProgress through to the real provider builder — a prior version of this closure silently dropped it, leaving embedded-model downloads with no progress reporting",
    calls[0]?.onDownloadProgress === onDownloadProgress
  );
  check(
    "forwards the AbortSignal through too — dropping it would leave an in-progress embedded-model download with no way to cancel",
    calls[0]?.signal === signal
  );
}

/** Unlike sampleOrgFor (used by startInitiativeSession's own tests, which
 * take an Initiative directly as a parameter), runOrganizationInitiative
 * looks the initiative up BY ID inside org.initiatives — so the test
 * organization actually needs to contain it. */
function orgWith(r: Role, init: Initiative): Organization {
  return { goal: "Ship v1.0", roles: [r], initiatives: [init] };
}

console.log("\nrunOrganizationInitiative:");
await (async () => {
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-org-run-test-"));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-org-run-workspace-test-"));

  {
    // The happy path: a cloud-model role resolves, the API key gets
    // injected (via resolveApiKey, not baked into resolveRoleProviderConfig
    // itself), and the session runs to completion — mirroring exactly what
    // main.ts's organization:run-initiative handler does, minus the real
    // Electron/settings-file plumbing.
    const r = role("claude-sonnet-5");
    const init = initiative("r-1");
    const org = orgWith(r, init);
    const provider = new MockProvider([{ turn: { type: "final", content: "Done." } }]);
    const registry = createSessionRegistry(sessionsDir);
    let resolveApiKeyCalledWith: string | undefined;
    let builtWithKeyedConfig: ProviderConfig | undefined;
    const result = await runOrganizationInitiative(registry, org, init.id, workspaceRoot, () => {}, undefined, {
      resolveApiKey: async (kind) => {
        resolveApiKeyCalledWith = kind;
        return "sk-resolved-key";
      },
      buildProviderFn: ((config: ProviderConfig) => {
        builtWithKeyedConfig = config;
        return provider;
      }) as any,
    });
    check("resolves the API key for the role's actual cloud kind", resolveApiKeyCalledWith === "anthropic");
    check(
      "the provider actually gets built from the KEYED config (apiKey included), not the bare unkeyed one",
      builtWithKeyedConfig?.kind === "anthropic" && (builtWithKeyedConfig as any).apiKey === "sk-resolved-key"
    );
    check("reports ok with a real sessionId when everything resolves", result.ok === true && typeof (result as any).sessionId === "string");
  }

  {
    // Unknown initiative id: main.ts's IPC handler now returns this result
    // directly (no more `throw new Error(...)` around it) — a clean { ok:
    // false } here is exactly what it's relying on.
    const registry = createSessionRegistry(sessionsDir);
    const org = sampleOrgFor(role("claude-sonnet-5"));
    const result = await runOrganizationInitiative(registry, org, "no-such-initiative", workspaceRoot, () => {}, undefined, {});
    check("an unknown initiative id is a clean { ok: false } result, not a throw", result.ok === false);
    check("names the unknown id in the error", result.ok === false && (result as any).error.includes("no-such-initiative"));
  }

  {
    // An initiative with no assigned role: same clean-result contract.
    const r = role("claude-sonnet-5");
    const init = initiative(null);
    const org: Organization = { goal: "", roles: [r], initiatives: [init] };
    const registry = createSessionRegistry(sessionsDir);
    const result = await runOrganizationInitiative(registry, org, init.id, workspaceRoot, () => {}, undefined, {});
    check("an initiative with no assigned role is a clean { ok: false } result, not a throw", result.ok === false);
  }

  {
    // An unresolvable role model id: still a clean result — resolveApiKey
    // must never even be called, since there's no cloud kind to key.
    const r = role("some-made-up-model");
    const init = initiative("r-1");
    const org = orgWith(r, init);
    const registry = createSessionRegistry(sessionsDir);
    let resolveApiKeyCalled = false;
    const result = await runOrganizationInitiative(registry, org, init.id, workspaceRoot, () => {}, undefined, {
      resolveApiKey: async () => {
        resolveApiKeyCalled = true;
        return "unused";
      },
    });
    check("an unresolvable role model id is a clean { ok: false } result", result.ok === false);
    check("resolveApiKey is never called for a model id that didn't resolve to a cloud kind", resolveApiKeyCalled === false);
  }

  await fs.rm(sessionsDir, { recursive: true, force: true });
  await fs.rm(workspaceRoot, { recursive: true, force: true });
})();

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
