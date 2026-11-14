import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { addAllowedCommand, clearAllowedCommands, isRememberableCommand, listAllowedCommands, MAX_COMMANDS_PER_WORKSPACE, removeAllowedCommand } from "../../commandRules.js";
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

  await addAllowedCommand(file, b, "echo keep");
  await addAllowedCommand(file, a, "echo one");
  await clearAllowedCommands(file, a);
  check("clearing removes every rule of one workspace and leaves the others", (await listAllowedCommands(file, a)).length === 0 && (await listAllowedCommands(file, b)).includes("echo keep"));
  await removeAllowedCommand(file, b, "echo keep");
  await addAllowedCommand(file, a, "npm run lint");

  await fs.symlink(a, path.join(dir, "link-to-a"));
  check("a workspace reached through a symlink shares the real folder's rules", (await listAllowedCommands(file, path.join(dir, "link-to-a"))).includes("npm run lint"));

  const c = path.join(dir, "workspace-c");
  await fs.mkdir(c);
  await Promise.all(Array.from({ length: 25 }, (_, i) => addAllowedCommand(file, c, `echo parallel ${i}`)));
  check("rules added at the same time are all kept", (await listAllowedCommands(file, c)).length === 25);
  await Promise.all([clearAllowedCommands(file, c), addAllowedCommand(file, a, "echo during clear")]);
  check("a clear and an add that overlap both take effect", (await listAllowedCommands(file, c)).length === 0 && (await listAllowedCommands(file, a)).includes("echo during clear"));
  await removeAllowedCommand(file, a, "echo during clear");

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
  options: { mode?: PermissionMode; allowedCommands?: string[]; hasWorkspace?: boolean; onUnpromptedWrite?: () => void; respond?: (call: ToolCall) => PermissionResponse } = {}
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
    hasWorkspace: options.hasWorkspace,
    onUnpromptedWrite: options.onUnpromptedWrite,
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

function editTurn(id: string, file: string): MockScriptEntry {
  return { turn: { type: "tool_calls", toolCalls: [{ id, name: "edit_file", arguments: { path: file, content: "changed\n" } }] } };
}
function readTurn(id: string, file: string): MockScriptEntry {
  return { turn: { type: "tool_calls", toolCalls: [{ id, name: "read_file", arguments: { path: file } }] } };
}

console.log("\nA remembered command and files the agent changed without a prompt:");
await withTempDir(async (root) => {
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  const h = harness(root, [readTurn("r1", "package.json"), editTurn("e1", "package.json"), runCommandTurn("c1", "echo hi"), final, runCommandTurn("c2", "echo hi"), final], {
    mode: "ACCEPT_EDITS",
    allowedCommands: ["echo hi"],
  });
  await h.run("change the file then run");
  check("in an auto-edit mode, the edit itself is applied without a prompt", !h.asked.some((c) => c.id === "e1"));
  check("after an edit that the user never saw, a remembered command asks again", h.asked.some((c) => c.id === "c1"));
  await h.run("run again");
  check("and it keeps asking for the rest of the session", h.asked.some((c) => c.id === "c2"));
});

await withTempDir(async (root) => {
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  const h = harness(root, [readTurn("r1", "package.json"), editTurn("e1", "package.json"), runCommandTurn("c1", "echo hi"), final], { allowedCommands: ["echo hi"] });
  await h.run("change the file then run");
  check("when the user approved the edit in a prompt, a remembered command still runs without asking", h.asked.some((c) => c.id === "e1") && !h.asked.some((c) => c.id === "c1"));
});

await withTempDir(async (root) => {
  await fs.writeFile(path.join(root, "a.txt"), "1\n");
  await fs.writeFile(path.join(root, "b.txt"), "1\n");
  let calls = 0;
  const h = harness(root, [readTurn("r1", "a.txt"), editTurn("e1", "a.txt"), readTurn("r2", "b.txt"), editTurn("e2", "b.txt"), final], {
    mode: "ACCEPT_EDITS",
    onUnpromptedWrite: () => {
      calls++;
    },
  });
  await h.run("edit two files");
  check("every unprompted edit is reported, not only the first", calls === 2);
});

await withTempDir(async (root) => {
  await fs.writeFile(path.join(root, "a.txt"), "1\n");
  const h = harness(root, [readTurn("r1", "a.txt"), editTurn("e1", "a.txt"), final], {
    mode: "ACCEPT_EDITS",
    onUnpromptedWrite: () => {
      throw new Error("disk full");
    },
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await h.run("edit a file");
  } finally {
    console.warn = originalWarn;
  }
  check("if the rules cannot be cleared, the edit asks for approval instead of applying silently", h.asked.some((c) => c.id === "e1") && requestFor(h, "e1")?.decision === "ASK");
});

await withTempDir(async (root) => {
  const second = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-command-rules-second-"));
  try {
    await fs.writeFile(path.join(root, "a.txt"), "1\n");
    const h = harness(root, [readTurn("r1", "a.txt"), editTurn("e1", "a.txt"), final, runCommandTurn("c1", "echo hi"), final], { mode: "ACCEPT_EDITS" });
    await h.run("edit a file");
    h.session.setWorkspaceRoot(second);
    h.session.setAllowedCommands(["echo hi"]);
    await h.run("say hi");
    check("an unprompted edit in one workspace does not switch off the rules of the next workspace", !h.asked.some((c) => c.id === "c1"));
  } finally {
    await fs.rm(second, { recursive: true, force: true });
  }
});

await withTempDir(async (root) => {
  const h = harness(root, [runCommandTurn("c1", "echo hi"), final], { allowedCommands: ["echo hi"], hasWorkspace: false, respond: () => ({ approved: true, remember: true }) });
  await h.run("say hi");
  check("with no workspace chosen, no rule applies and nothing can be remembered", h.session.getAllowedCommands().length === 0 && h.remembered.length === 0 && requestFor(h, "c1")?.canRemember !== true);
  h.session.setAllowedCommands(["echo hi"]);
  check("rules cannot be set on a session that has no chosen workspace", h.session.getAllowedCommands().length === 0);
});

{
  const h = harness(os.homedir(), [final], { allowedCommands: ["echo hi"] });
  check("the home directory is never treated as a workspace for rules", h.session.getAllowedCommands().length === 0);
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
