import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { createSessionRegistry, startSession, runTask, respondPermission } from "../../electron/sessionRegistry.js";
import { MockProvider } from "../../providers/mockProvider.js";
import type { AgentEvent, ChatResponse } from "../../types.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

const base = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-hooks-registry-"));
try {
  const workspace = path.join(base, "ws");
  await fs.mkdir(workspace);
  const hooksFile = path.join(base, "hooks.json");
  const blocker = path.join(base, "block.cjs");
  await fs.writeFile(blocker, 'console.error("blocked by test hook"); process.exit(1)');

  const run = async (hooksFilePath: string | undefined) => {
    await fs.writeFile(path.join(workspace, "a.txt"), "old\n");
    const script: ChatResponse[] = [
      { turn: { type: "tool_calls", toolCalls: [{ id: "e1", name: "edit_file", arguments: { path: "a.txt", content: "new\n" } }] } },
      { turn: { type: "final", content: "done" } },
    ];
    const registry = createSessionRegistry(path.join(base, "sessions"), undefined, undefined, undefined, undefined, hooksFilePath);
    const { sessionId } = await startSession(registry, { workspaceRoot: workspace, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "DEFAULT" }, { providerFactory: () => new MockProvider(script) });
    const events: AgentEvent[] = [];
    await runTask(registry, sessionId, "edit a.txt", (e) => {
      events.push(e);
      if (e.type === "permission.request" && e.decision === "ASK") setImmediate(() => respondPermission(registry, sessionId, e.call.id, true));
    });
    return { events, content: await fs.readFile(path.join(workspace, "a.txt"), "utf8") };
  };

  console.log("Hooks in a desktop session:");
  await fs.writeFile(hooksFile, JSON.stringify({ hooks: [{ event: "before_tool", tool: "edit_file", command: `"${process.execPath}" "${blocker}"` }] }));
  {
    const r = await run(hooksFile);
    check("a hook from the hook file blocks the edit even after the user approved it", r.content === "old\n" && r.events.some((e) => e.type === "status" && e.message.includes("blocked by test hook")));
  }
  {
    const r = await run(undefined);
    check("a registry with no hook file runs no hooks", r.content === "new\n");
  }
  await fs.writeFile(hooksFile, "{ broken");
  {
    const r = await run(hooksFile);
    check("a broken hook file stops the task instead of running without the guard", r.content === "old\n" && r.events.some((e) => e.type === "error" && /hooks/i.test(e.message)) && r.events[r.events.length - 1]?.type === "done");
  }
  await fs.rm(hooksFile);
  {
    const r = await run(hooksFile);
    check("a hook file that does not exist means no hooks", r.content === "new\n");
  }
} finally {
  await fs.rm(base, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
