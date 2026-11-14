import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { createSessionRegistry, startSession, runTask, respondPermission, updateLiveSessionSettings, reloadCommandRules, type SessionRegistry } from "../../electron/sessionRegistry.js";
import { MockProvider } from "../../providers/mockProvider.js";
import { addAllowedCommand, listAllowedCommands, removeAllowedCommand } from "../../commandRules.js";
import type { AgentEvent, ChatResponse, PermissionMode } from "../../types.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

function echoTwice(): ChatResponse[] {
  return [
    { turn: { type: "tool_calls", toolCalls: [{ id: "c1", name: "run_command", arguments: { command: "echo hi" } }] } },
    { turn: { type: "tool_calls", toolCalls: [{ id: "c2", name: "run_command", arguments: { command: "echo hi" } }] } },
    { turn: { type: "final", content: "ran it" } },
  ];
}

async function start(registry: SessionRegistry, workspaceRoot: string, script: ChatResponse[], mode: PermissionMode = "DEFAULT") {
  const { sessionId } = await startSession(
    registry,
    { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode },
    { providerFactory: () => new MockProvider(script) }
  );
  return sessionId;
}

/** Runs one task, answering every ASK with the given remember flag, and returns the ids that asked. */
async function run(registry: SessionRegistry, sessionId: string, remember: boolean): Promise<string[]> {
  const asked: string[] = [];
  await runTask(registry, sessionId, "run echo", (e: AgentEvent) => {
    if (e.type === "permission.request" && e.decision === "ASK") {
      asked.push(e.call.id);
      setImmediate(() => respondPermission(registry, sessionId, e.call.id, true, undefined, remember));
    }
  });
  return asked;
}

const base = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-command-rules-registry-"));
try {
  const sessionsDir = path.join(base, "sessions");
  const rulesFile = path.join(base, "command-rules.json");
  const workspaceA = path.join(base, "a");
  const workspaceB = path.join(base, "b");
  await fs.mkdir(workspaceA);
  await fs.mkdir(workspaceB);

  console.log("Session registry and remembered commands:");
  {
    const registry = createSessionRegistry(sessionsDir, undefined, undefined, rulesFile);
    const sessionId = await start(registry, workspaceA, echoTwice());
    const asked = await run(registry, sessionId, true);
    check("'always allow' from the approval prompt asks once, then not again", JSON.stringify(asked) === JSON.stringify(["c1"]));
    check("the rule is written to the rules file for that workspace", (await listAllowedCommands(rulesFile, workspaceA)).includes("echo hi"));
    check("no rules file is written inside the workspace", (await fs.readdir(workspaceA)).length === 0);
  }
  {
    const registry = createSessionRegistry(sessionsDir, undefined, undefined, rulesFile);
    const sessionId = await start(registry, workspaceA, echoTwice());
    check("a new session in the same workspace starts with the stored rule", (await run(registry, sessionId, false)).length === 0);
  }
  {
    const registry = createSessionRegistry(sessionsDir, undefined, undefined, rulesFile);
    const sessionId = await start(registry, workspaceB, echoTwice());
    check("a session in a different workspace still asks", (await run(registry, sessionId, false)).length === 2);
  }
  {
    const registry = createSessionRegistry(sessionsDir);
    const sessionId = await start(registry, workspaceA, echoTwice());
    check("a registry with no rules file asks every time and stores nothing", (await run(registry, sessionId, true)).length === 1);
  }
  {
    const registry = createSessionRegistry(sessionsDir, undefined, undefined, rulesFile);
    const sessionId = await start(registry, workspaceB, echoTwice());
    updateLiveSessionSettings(registry, sessionId, { workspaceRoot: workspaceA });
    await reloadCommandRules(registry);
    check("moving a live session to another workspace picks up that workspace's rules", (await run(registry, sessionId, false)).length === 0);
  }
  {
    const registry = createSessionRegistry(sessionsDir, undefined, undefined, rulesFile);
    const sessionId = await start(registry, workspaceA, echoTwice());
    await removeAllowedCommand(rulesFile, workspaceA, "echo hi");
    await reloadCommandRules(registry);
    check("removing a rule takes effect in a live session after a reload", (await run(registry, sessionId, false)).length === 2);
    await addAllowedCommand(rulesFile, workspaceA, "echo hi");
  }
  {
    const workspaceC = path.join(base, "c");
    await fs.mkdir(workspaceC);
    await fs.writeFile(path.join(workspaceC, "package.json"), "{}\n");
    await addAllowedCommand(rulesFile, workspaceC, "echo hi");
    await addAllowedCommand(rulesFile, workspaceA, "echo hi");
    const registry = createSessionRegistry(sessionsDir, undefined, undefined, rulesFile);
    const asking = await start(registry, workspaceC, echoTwice());
    const autoEditing = await start(
      registry,
      workspaceC,
      [
        { turn: { type: "tool_calls", toolCalls: [{ id: "r1", name: "read_file", arguments: { path: "package.json" } }] } },
        { turn: { type: "tool_calls", toolCalls: [{ id: "e1", name: "edit_file", arguments: { path: "package.json", content: "{\"scripts\":{}}\n" } }] } },
        { turn: { type: "final", content: "edited" } },
      ],
      "ACCEPT_EDITS"
    );
    check("an auto-edit session changes a file with no prompt", (await run(registry, autoEditing, false)).length === 0);
    check("that clears the workspace's stored rules", (await listAllowedCommands(rulesFile, workspaceC)).length === 0);
    check("another workspace's rules are untouched", (await listAllowedCommands(rulesFile, workspaceA)).includes("echo hi"));
    check("a second live session on the same workspace asks again", (await run(registry, asking, false)).length === 2);
    const later = await start(registry, workspaceC, echoTwice());
    check("and so does a session started afterwards", (await run(registry, later, false)).length === 2);
  }
} finally {
  await fs.rm(base, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
