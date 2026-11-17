import readline from "node:readline/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AgentSession } from "./agent.js";
import { defaultToolRegistry } from "./toolRegistry.js";
import { resolveSlashCommand } from "./slashCommands.js";
import { loadHooks } from "./hooks.js";
import { OpenAICompatibleProvider } from "./providers/openaiCompatible.js";
import { EmbeddedLlamaProvider, isDownloadHttpFailure } from "./providers/embeddedLlama.js";
import { AnthropicProvider } from "./providers/anthropicProvider.js";
import { isEmbeddedModelId, describeEmbeddedModel, EMBEDDED_MODELS, DEFAULT_EMBEDDED_MODEL, type EmbeddedModelId } from "./models.js";
import type { AgentEvent, ModelProvider, PermissionMode, ToolCall } from "./types.js";

function embeddedModelIdsByCategory(category: "coding" | "chat"): string {
  return (Object.keys(EMBEDDED_MODELS) as EmbeddedModelId[])
    .filter((id) => EMBEDDED_MODELS[id].category === category)
    .join(" | ");
}

/** Flags that take no value: the word after one is part of the task, not the flag's value. */
const SWITCHES = new Set(["json"]);

/** Events that only drive live rendering in the app. They would be noise in a script's output. */
const JSON_SKIPPED_EVENTS = new Set(["text.delta", "tool_call.start", "tool_call.delta", "stream.reset", "perf"]);

/**
 * Prints a run's events and returns whether it succeeded. In JSON mode
 * every line on `out` is one JSON object, and the last line is
 * {"type":"result","success":…,"text":…} with the final answer, so a
 * script can read stdout line by line. Exported for testing.
 */
export async function reportRun(events: AsyncIterable<AgentEvent>, opts: { json: boolean; out: (line: string) => void; err: (line: string) => void }): Promise<boolean> {
  let success = false;
  let finalText = "";
  for await (const event of events) {
    if (event.type === "text") finalText = event.text;
    if (event.type === "done") success = event.success;
    if (opts.json) {
      if (!JSON_SKIPPED_EVENTS.has(event.type)) opts.out(JSON.stringify(event));
      continue;
    }
    switch (event.type) {
      case "status":
        opts.out(`… ${event.message}`);
        break;
      case "tool.start":
        opts.out(`▶ ${event.call.name}(${JSON.stringify(event.call.arguments)})`);
        break;
      case "tool.result":
        opts.out(`  → ${event.result.ok ? "ok" : "error"}${event.result.error ? ": " + event.result.error : ""}`);
        break;
      case "text":
        opts.out(`\n${event.text}\n`);
        break;
      case "error":
        opts.err(`✗ ${event.message}`);
        break;
      case "done":
        opts.out(`\n[done] success=${event.success}`);
        break;
    }
  }
  if (opts.json) opts.out(JSON.stringify({ type: "result", success, text: finalText }));
  return success;
}

/** The message for a failure that nothing in the CLI caught. A failed download has a URL and an HTTP status. */
export function describeUnhandledFailure(reason: unknown): string {
  const err = reason as { message?: string; statusCode?: number; url?: string } | null;
  const message = err?.message ?? String(reason);
  if (typeof err?.url === "string" && typeof err?.statusCode === "number") {
    return `The model download stopped (HTTP ${err.statusCode}). The part that was downloaded is kept. Run the same command again to continue.`;
  }
  return `localagent stopped with an error: ${message.split("\n")[0]}`;
}

/** Exported for direct unit testing (test-engineer finding, full-project audit: this file had no coverage at all) — pure and side-effect-free, so no entry-point guard is needed around the export itself, only around main()'s auto-invocation below. */
export function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const val = !SWITCHES.has(key) && next && !next.startsWith("--") ? (i++, next) : "true";
      args[key] = val;
    } else {
      positional.push(a);
    }
  }
  return { args, positional };
}

async function main() {
  const { args, positional } = parseArgs(process.argv.slice(2));
  const typed = positional.join(" ");
  // A task that starts with "/name" is a command. Custom commands come
  // from the user's own folder, the same one the desktop app reads.
  const resolved = typed ? await resolveSlashCommand(typed, path.join(os.homedir(), ".localagent", "commands")) : null;
  if (resolved?.kind === "message") {
    console.log(resolved.text);
    return;
  }
  if (resolved?.kind === "compact") {
    console.log("/compact works on a running session in the desktop app. The CLI runs one task and exits, so there is nothing to compact.");
    return;
  }
  const task = resolved?.task ?? "";
  if (!task) {
    console.error(
      'Usage: localagent "<task description>" [--workspace <dir>] [--base-url <url>] [--model <name>] [--mode DEFAULT|PLAN|ACCEPT_EDITS|AUTO_SAFE] [--provider anthropic] [--json]\n' +
        "  --base-url given     → talk to that OpenAI-compatible server (Ollama/LM Studio/etc), --model is its model id.\n" +
        `  --base-url omitted   → run a model in-process, no server needed. --model selects an id, default "${DEFAULT_EMBEDDED_MODEL}":\n` +
        `      coding: ${embeddedModelIdsByCategory("coding")}\n` +
        `      chat:   ${embeddedModelIdsByCategory("chat")}\n` +
        "  --provider anthropic → use the real Claude Sonnet 5 API instead — sends code over the network, needs ANTHROPIC_API_KEY.\n" +
        "  --json               → for scripts: one JSON object per line on stdout, no prompts (anything that needs approval is refused), exit code 1 on failure."
    );
    process.exit(1);
  }

  const json = args.json === "true";
  // Progress notes go to stderr in JSON mode, so stdout holds only JSON lines.
  const info = json ? (line: string) => console.error(line) : (line: string) => console.log(line);
  const workspaceRoot = path.resolve(args.workspace ?? process.cwd());
  const baseUrl = args["base-url"];
  const mode = (args.mode as PermissionMode) ?? "DEFAULT";

  let provider: ModelProvider;
  let model: string;

  if (args.provider === "anthropic") {
    model = "claude-sonnet-5";
    provider = new AnthropicProvider();
    info("\n[localagent] using the Claude Sonnet 5 API — code and task context will be sent to Anthropic over the network…");
    const health = await provider.healthCheck();
    if (!health.ok) {
      console.error(`\nCould not reach the Anthropic API with the current credentials: ${health.error}`);
      console.error("Set ANTHROPIC_API_KEY, or run `ant auth login`, then try again.\n");
      process.exit(1);
    }
  } else if (baseUrl) {
    model = args.model ?? "qwen2.5-coder:latest";
    provider = new OpenAICompatibleProvider({ baseUrl, local: true });
    const health = await provider.healthCheck();
    if (!health.ok) {
      console.error(`\nCould not reach a local model server at ${baseUrl}: ${health.error}`);
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
    info(`\n[localagent] no --base-url given, running ${describeEmbeddedModel(size)} in-process (downloads and caches on first run)…`);
    const health = await provider.healthCheck();
    if (!health.ok) {
      console.error(`\nFailed to download or load ${EMBEDDED_MODELS[size].name}: ${health.error}`);
      console.error("Check your network connection, or pass --base-url to use an external server instead.\n");
      process.exit(1);
    }
  }

  // In JSON mode nobody is there to answer a prompt, and stdout must stay pure JSON.
  const rl = json ? null : readline.createInterface({ input: process.stdin, output: process.stdout });

  const session = new AgentSession({
    workspaceRoot,
    model,
    provider,
    tools: defaultToolRegistry(undefined, { taskList: !(provider instanceof EmbeddedLlamaProvider), delegate: !(provider instanceof EmbeddedLlamaProvider), webSearch: !(provider instanceof EmbeddedLlamaProvider) }),
    permissionMode: mode,
    getHooks: () => loadHooks(path.join(os.homedir(), ".localagent", "hooks.json")),
    onApprovalNeeded: async (call: ToolCall) => {
      if (!rl) {
        console.error(`[localagent] refused ${call.name}: it needs approval, and --json mode cannot ask. Use --mode ACCEPT_EDITS or AUTO_SAFE to allow more.`);
        return { approved: false };
      }
      const answer = await rl.question(`\nApprove ${call.name}(${JSON.stringify(call.arguments)})? [y/N] `);
      return { approved: answer.trim().toLowerCase() === "y" };
    },
  });

  info(`\n[localagent] workspace=${workspaceRoot} model=${model} mode=${mode}\n`);

  const success = await reportRun(session.run(task), { json, out: (line) => console.log(line), err: (line) => console.error(line) });

  rl?.close();
  // A script must be able to tell a failed run from a good one.
  process.exitCode = success ? 0 : 1;
}

// Guarded so importing this module (e.g. to unit test parseArgs above)
// doesn't also run the whole CLI — main() used to fire unconditionally at
// import time. pathToFileURL does the same platform-correct path-to-URL
// conversion Node itself uses (see scripts/generate-whats-new.mjs's own
// doc comment for why a naive string comparison is wrong on Windows), so
// this only runs true when cli.ts is actually the invoked entry point.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // A model download can fail in the download library with nothing
  // waiting for the result (seen live: the download link of a 4 GB file
  // expired at 94%, HTTP 403). Node then stops the process with a long
  // stack trace.
  process.on("unhandledRejection", (reason) => {
    // One part of a download that failed: the download call itself also
    // fails, and the provider tries again or reports it. Do not stop here.
    if (isDownloadHttpFailure(reason)) return;
    console.error(`\n${describeUnhandledFailure(reason)}\n`);
    process.exit(1);
  });
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
