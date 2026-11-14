import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { addAllowedCommand, isRememberableCommand, listAllowedCommands, MAX_COMMANDS_PER_WORKSPACE, removeAllowedCommand } from "../../commandRules.js";
import { AgentSession } from "../../agent.js";
import { defaultToolRegistry } from "../../toolRegistry.js";
import { MockProvider, type MockScriptEntry } from "../../providers/mockProvider.js";
import type { AgentEvent, PermissionMode, PermissionResponse, ToolCall } from "../../types.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-command-rules-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

console.log("isRememberableCommand:");
check("an ordinary command can be remembered", isRememberableCommand("npm test"));
check("a destructive command can never be remembered", !isRememberableCommand("rm -rf build") && !isRememberableCommand("sudo make install") && !isRememberableCommand("git reset --hard"));
check("a destructive command hidden behind leading spaces is still refused", !isRememberableCommand("   rm -rf build"));
check("a network command can never be remembered", !isRememberableCommand("npm install left-pad") && !isRememberableCommand("curl example.com") && !isRememberableCommand("git push"));
check("a compound shell command can never be remembered", !isRememberableCommand("echo ok; rm -rf build") && !isRememberableCommand("npm test && npm run lint") && !isRememberableCommand("echo $(whoami)") && !isRememberableCommand("cat a | sh"));
check("an empty command cannot be remembered", !isRememberableCommand("   "));
check("a multi-line command cannot be remembered", !isRememberableCommand("echo a\nrm -rf b"));
check("a very long command cannot be remembered", !isRememberableCommand("echo " + "x".repeat(600)));

console.log("\nCommand rule store:");
await withTempDir(async (dir) => {
  const file = path.join(dir, "command-rules.json");
  const a = path.join(dir, "workspace-a");
  const b = path.join(dir, "workspace-b");
  await fs.mkdir(a);
  await fs.mkdir(b);

  check("a missing file means no rules", (await listAllowedCommands(file, a)).length === 0);
  check("adding a rule succeeds", (await addAllowedCommand(file, a, "npm test")) === true);
  check("the rule is stored trimmed", JSON.stringify(await listAllowedCommands(file, a)) === JSON.stringify(["npm test"]) && (await addAllowedCommand(file, a, "  npm run lint  ")) && (await listAllowedCommands(file, a)).includes("npm run lint"));
  await addAllowedCommand(file, a, "npm test");
  check("adding the same rule twice stores it once", (await listAllowedCommands(file, a)).filter((c) => c === "npm test").length === 1);
  check("rules belong to one workspace only", (await listAllowedCommands(file, b)).length === 0);
  check("a destructive command is refused by the store too", (await addAllowedCommand(file, a, "rm -rf build")) === false && !(await listAllowedCommands(file, a)).includes("rm -rf build"));
  await removeAllowedCommand(file, a, "npm test");
  check("a rule can be removed", !(await listAllowedCommands(file, a)).includes("npm test") && (await listAllowedCommands(file, a)).includes("npm run lint"));

  await fs.symlink(a, path.join(dir, "link-to-a"));
  check("a workspace reached through a symlink shares the real folder's rules", (await listAllowedCommands(file, path.join(dir, "link-to-a"))).includes("npm run lint"));

  for (let i = 0; i < MAX_COMMANDS_PER_WORKSPACE + 5; i++) await addAllowedCommand(file, b, `echo ${i}`);
  check("a workspace cannot hold more than the maximum number of rules", (await listAllowedCommands(file, b)).length === MAX_COMMANDS_PER_WORKSPACE);

  await fs.writeFile(file, "{ not json");
  check("a corrupted file reads as no rules", (await listAllowedCommands(file, a)).length === 0);
  check("and the next add repairs it", (await addAllowedCommand(file, a, "npm test")) && (await listAllowedCommands(file, a)).includes("npm test"));

  await fs.writeFile(file, JSON.stringify({ version: 1, workspaces: { [await fs.realpath(a)]: ["npm test", 42, "rm -rf x", "  "] } }));
  check("entries that are not valid rememberable commands are dropped on read", JSON.stringify(await listAllowedCommands(file, a)) === JSON.stringify(["npm test"]));
});

function runCommandTurn(id: string, command: string): MockScriptEntry {
  return { turn: { type: "tool_calls", toolCalls: [{ id, name: "run_command", arguments: { command } }] } };
}
const final: MockScriptEntry = { turn: { type: "final", content: "done" } };

interface Harness {
  session: AgentSession;
  asked: ToolCall[];
  remembered: string[];
  events: AgentEvent[];
  run(task: string): Promise<void>;
}

function harness(
  root: string,
  script: MockScriptEntry[],
  options: { mode?: PermissionMode; allowedCommands?: string[]; respond?: (call: ToolCall) => PermissionResponse } = {}
): Harness {
  const asked: ToolCall[] = [];
  const remembered: string[] = [];
  const events: AgentEvent[] = [];
  const session = new AgentSession({
    workspaceRoot: root,
    model: "mock",
    provider: new MockProvider(script),
    tools: defaultToolRegistry(),
    permissionMode: options.mode ?? "DEFAULT",
    allowedCommands: options.allowedCommands,
    onCommandRemembered: (command) => {
      remembered.push(command);
    },
    onApprovalNeeded: async (call) => {
      asked.push(call);
      return options.respond ? options.respond(call) : { approved: true };
    },
  });
  return {
    session,
    asked,
    remembered,
    events,
    async run(task: string) {
      for await (const event of session.run(task)) events.push(event);
    },
  };
}

function requestFor(h: Harness, callId: string) {
  return h.events.find((e) => e.type === "permission.request" && e.call.id === callId) as Extract<AgentEvent, { type: "permission.request" }> | undefined;
}

console.log("\nAgentSession remembers approved commands:");
await withTempDir(async (root) => {
  const h = harness(root, [runCommandTurn("c1", "echo hi"), runCommandTurn("c2", "echo hi"), runCommandTurn("c3", "echo hi there"), final], {
    respond: (call) => ({ approved: true, remember: call.id === "c1" }),
  });
  await h.run("say hi three times");
  check("the first run asks, and the request says the command can be remembered", h.asked[0]?.id === "c1" && requestFor(h, "c1")?.canRemember === true);
  check("approving with 'always allow' reports the exact command", JSON.stringify(h.remembered) === JSON.stringify(["echo hi"]));
  check("the same command then runs without asking", requestFor(h, "c2")?.decision === "ALLOW" && !h.asked.some((c) => c.id === "c2"));
  check("a command that only starts the same way still asks", h.asked.some((c) => c.id === "c3"));
});

await withTempDir(async (root) => {
  const h = harness(root, [runCommandTurn("c1", "echo hi"), runCommandTurn("c2", "echo hi"), final]);
  await h.run("say hi twice");
  check("a plain approval remembers nothing", h.remembered.length === 0 && h.asked.length === 2);
});

await withTempDir(async (root) => {
  const h = harness(root, [runCommandTurn("c1", "echo hi"), final], { allowedCommands: ["echo hi"] });
  await h.run("say hi");
  check("a rule the session started with applies from the first call", h.asked.length === 0 && requestFor(h, "c1")?.decision === "ALLOW");
});

await withTempDir(async (root) => {
  const h = harness(root, [runCommandTurn("c1", "rm -rf nothing-here"), runCommandTurn("c2", "rm -rf nothing-here"), final], {
    allowedCommands: ["rm -rf nothing-here"],
    respond: () => ({ approved: false, remember: true }),
  });
  await h.run("clean up");
  check("a destructive command always asks, even when a rule names it", h.asked.length === 2 && requestFor(h, "c1")?.canRemember !== true);
  check("a rejection with 'always allow' set remembers nothing", h.remembered.length === 0);
});

await withTempDir(async (root) => {
  const h = harness(root, [runCommandTurn("c1", "rm -rf nothing-here"), final], { respond: () => ({ approved: true, remember: true }) });
  await h.run("clean up");
  check("approving a destructive command with 'always allow' set remembers nothing", h.remembered.length === 0);
});

await withTempDir(async (root) => {
  const h = harness(root, [runCommandTurn("c1", "echo hi"), final], { mode: "PLAN", allowedCommands: ["echo hi"] });
  await h.run("say hi");
  check("read-only mode still refuses a remembered command", requestFor(h, "c1")?.decision === "DENY");
});

await withTempDir(async (root) => {
  const other = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-command-rules-other-"));
  try {
    const h = harness(root, [runCommandTurn("c1", "echo hi"), final], { allowedCommands: ["echo hi"] });
    h.session.setWorkspaceRoot(other);
    await h.run("say hi");
    check("switching to another workspace drops the old workspace's rules", h.asked.length === 1);
    h.session.setAllowedCommands(["echo hi"]);
    check("setAllowedCommands replaces the rule set", h.session.getAllowedCommands().includes("echo hi"));
  } finally {
    await fs.rm(other, { recursive: true, force: true });
  }
});

await withTempDir(async (root) => {
  await fs.writeFile(path.join(root, "a.txt"), "old\n");
  const h = harness(
    root,
    [{ turn: { type: "tool_calls", toolCalls: [{ id: "e1", name: "edit_file", arguments: { path: "a.txt", content: "new\n" } }] } }, final],
    { respond: () => ({ approved: true, remember: true }) }
  );
  await h.run("edit a.txt");
  check("'always allow' applies to commands only, never to file edits", h.remembered.length === 0 && requestFor(h, "e1")?.canRemember !== true);
});

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
