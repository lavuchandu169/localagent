import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { createSessionRegistry, startSession, runTask, type ProviderConfig } from "../../electron/sessionRegistry.js";
import { MockProvider } from "../../providers/mockProvider.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

const base = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-task-list-registration-"));
try {
  const offered = async (provider: ProviderConfig): Promise<string[]> => {
    const mock = new MockProvider([{ turn: { type: "final", content: "ok" } }]);
    const registry = createSessionRegistry(path.join(base, "sessions"));
    const { sessionId } = await startSession(registry, { workspaceRoot: base, provider, mode: "DEFAULT" }, { providerFactory: () => mock });
    await runTask(registry, sessionId, "hello", () => {});
    return (mock.receivedRequests[0]?.tools ?? []).map((t) => t.name);
  };

  console.log("Which sessions get the task list tool:");
  check("an embedded local model is not offered update_todos", !(await offered({ kind: "embedded", size: "qwen-coder-1.5b" })).includes("update_todos"));
  check("a custom server model is offered update_todos", (await offered({ kind: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", model: "m" })).includes("update_todos"));
  check("a cloud model is offered update_todos", (await offered({ kind: "anthropic", apiKey: "k" })).includes("update_todos"));
  check("an embedded local model is not offered delegate_task", !(await offered({ kind: "embedded", size: "qwen-coder-1.5b" })).includes("delegate_task"));
  check("a custom server model and a cloud model are offered delegate_task", (await offered({ kind: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", model: "m" })).includes("delegate_task") && (await offered({ kind: "anthropic", apiKey: "k" })).includes("delegate_task"));
  check("every session still gets the file tools", (await offered({ kind: "embedded", size: "qwen-coder-1.5b" })).includes("find_files"));
} finally {
  await fs.rm(base, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
