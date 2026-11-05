import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { resolveRoleProviderConfig, startInitiativeSession } from "../../electron/organizationSession.js";
import { createSessionRegistry } from "../../electron/sessionRegistry.js";
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
    const result = await startInitiativeSession(registry, org, init, r, workspaceRoot, (e) => events.push(e), { providerFactory: () => provider });
    check("reports ok with a real sessionId", result.ok === true && typeof (result as any).sessionId === "string");
    check("the session is actually registered", result.ok === true && registry.sessions.has((result as any).sessionId));
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

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
