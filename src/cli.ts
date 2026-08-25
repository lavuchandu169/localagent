import readline from "node:readline/promises";
import path from "node:path";
import { AgentSession } from "./agent.js";
import { defaultToolRegistry } from "./toolRegistry.js";
import { OpenAICompatibleProvider } from "./providers/openaiCompatible.js";
import { EmbeddedLlamaProvider } from "./providers/embeddedLlama.js";
import { isEmbeddedModelSize } from "./models.js";
import type { ModelProvider, PermissionMode, ToolCall } from "./types.js";

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const val = next && !next.startsWith("--") ? (i++, next) : "true";
      args[key] = val;
    } else {
      positional.push(a);
    }
  }
  return { args, positional };
}

async function main() {
  const { args, positional } = parseArgs(process.argv.slice(2));
  const task = positional.join(" ");
  if (!task) {
    console.error(
      'Usage: localagent "<task description>" [--workspace <dir>] [--base-url <url>] [--model <name>] [--mode DEFAULT|PLAN|ACCEPT_EDITS|AUTO_SAFE]\n' +
        "  --base-url given    → talk to that OpenAI-compatible server (Ollama/LM Studio/etc), --model is its model id.\n" +
        "  --base-url omitted  → run a model in-process, no server needed. --model selects small|medium|large (default small)."
    );
    process.exit(1);
  }

  const workspaceRoot = path.resolve(args.workspace ?? process.cwd());
  const baseUrl = args["base-url"];
  const mode = (args.mode as PermissionMode) ?? "DEFAULT";

  let provider: ModelProvider;
  let model: string;

  if (baseUrl) {
    model = args.model ?? "qwen2.5-coder:latest";
    provider = new OpenAICompatibleProvider({ baseUrl, local: true });
    const healthy = await provider.healthCheck();
    if (!healthy) {
      console.error(`\nCould not reach a local model server at ${baseUrl}.`);
      console.error("Start Ollama (or LM Studio / any OpenAI-compatible server) and pass --base-url, or run `npm run demo` for an offline mock-provider walkthrough.\n");
      process.exit(1);
    }
  } else {
    const size = args.model ?? "small";
    if (!isEmbeddedModelSize(size)) {
      console.error(`\n--model must be one of small|medium|large in embedded mode (got "${size}").\n`);
      process.exit(1);
    }
    model = size;
    provider = new EmbeddedLlamaProvider({ size });
    console.log(`\n[localagent] no --base-url given, running "${size}" in-process (downloads and caches on first run)…`);
    const healthy = await provider.healthCheck();
    if (!healthy) {
      console.error(`\nFailed to download or load the "${size}" embedded model.`);
      console.error("Check your network connection, or pass --base-url to use an external server instead.\n");
      process.exit(1);
    }
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const session = new AgentSession({
    workspaceRoot,
    model,
    provider,
    tools: defaultToolRegistry(),
    permissionMode: mode,
    onApprovalNeeded: async (call: ToolCall) => {
      const answer = await rl.question(`\nApprove ${call.name}(${JSON.stringify(call.arguments)})? [y/N] `);
      return answer.trim().toLowerCase() === "y";
    },
  });

  console.log(`\n[localagent] workspace=${workspaceRoot} model=${model} mode=${mode}\n`);

  for await (const event of session.run(task)) {
    switch (event.type) {
      case "status":
        console.log(`… ${event.message}`);
        break;
      case "tool.start":
        console.log(`▶ ${event.call.name}(${JSON.stringify(event.call.arguments)})`);
        break;
      case "tool.result":
        console.log(`  → ${event.result.ok ? "ok" : "error"}${event.result.error ? ": " + event.result.error : ""}`);
        break;
      case "text":
        console.log(`\n${event.text}\n`);
        break;
      case "error":
        console.error(`✗ ${event.message}`);
        break;
      case "done":
        console.log(`\n[done] success=${event.success}`);
        break;
    }
  }

  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
