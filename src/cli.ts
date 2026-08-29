import readline from "node:readline/promises";
import path from "node:path";
import { AgentSession } from "./agent.js";
import { defaultToolRegistry } from "./toolRegistry.js";
import { OpenAICompatibleProvider } from "./providers/openaiCompatible.js";
import { EmbeddedLlamaProvider } from "./providers/embeddedLlama.js";
import { AnthropicProvider } from "./providers/anthropicProvider.js";
import { isEmbeddedModelId, describeEmbeddedModel, EMBEDDED_MODELS, DEFAULT_EMBEDDED_MODEL, type EmbeddedModelId } from "./models.js";
import type { ModelProvider, PermissionMode, ToolCall } from "./types.js";

function embeddedModelIdsByCategory(category: "coding" | "chat"): string {
  return (Object.keys(EMBEDDED_MODELS) as EmbeddedModelId[])
    .filter((id) => EMBEDDED_MODELS[id].category === category)
    .join(" | ");
}

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
      'Usage: localagent "<task description>" [--workspace <dir>] [--base-url <url>] [--model <name>] [--mode DEFAULT|PLAN|ACCEPT_EDITS|AUTO_SAFE] [--provider anthropic]\n' +
        "  --base-url given     → talk to that OpenAI-compatible server (Ollama/LM Studio/etc), --model is its model id.\n" +
        `  --base-url omitted   → run a model in-process, no server needed. --model selects an id, default "${DEFAULT_EMBEDDED_MODEL}":\n` +
        `      coding: ${embeddedModelIdsByCategory("coding")}\n` +
        `      chat:   ${embeddedModelIdsByCategory("chat")}\n` +
        "  --provider anthropic → use the real Claude Sonnet 5 API instead — sends code over the network, needs ANTHROPIC_API_KEY."
    );
    process.exit(1);
  }

  const workspaceRoot = path.resolve(args.workspace ?? process.cwd());
  const baseUrl = args["base-url"];
  const mode = (args.mode as PermissionMode) ?? "DEFAULT";

  let provider: ModelProvider;
  let model: string;

  if (args.provider === "anthropic") {
    model = "claude-sonnet-5";
    provider = new AnthropicProvider();
    console.log("\n[localagent] using the Claude Sonnet 5 API — code and task context will be sent to Anthropic over the network…");
    const healthy = await provider.healthCheck();
    if (!healthy) {
      console.error("\nCould not reach the Anthropic API with the current credentials.");
      console.error("Set ANTHROPIC_API_KEY, or run `ant auth login`, then try again.\n");
      process.exit(1);
    }
  } else if (baseUrl) {
    model = args.model ?? "qwen2.5-coder:latest";
    provider = new OpenAICompatibleProvider({ baseUrl, local: true });
    const healthy = await provider.healthCheck();
    if (!healthy) {
      console.error(`\nCould not reach a local model server at ${baseUrl}.`);
      console.error("Start Ollama (or LM Studio / any OpenAI-compatible server) and pass --base-url, or run `npm run demo` for an offline mock-provider walkthrough.\n");
      process.exit(1);
    }
  } else {
    const size = args.model ?? DEFAULT_EMBEDDED_MODEL;
    if (!isEmbeddedModelId(size)) {
      console.error(
        `\n--model "${size}" isn't a known embedded model id. Choices:\n` +
          `  coding: ${embeddedModelIdsByCategory("coding")}\n` +
          `  chat:   ${embeddedModelIdsByCategory("chat")}\n`
      );
      process.exit(1);
    }
    model = size;
    provider = new EmbeddedLlamaProvider({ size });
    console.log(`\n[localagent] no --base-url given, running ${describeEmbeddedModel(size)} in-process (downloads and caches on first run)…`);
    const healthy = await provider.healthCheck();
    if (!healthy) {
      console.error(`\nFailed to download or load ${EMBEDDED_MODELS[size].name}.`);
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
