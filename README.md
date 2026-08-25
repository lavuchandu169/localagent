# localagent — working prototype

A small but *real*, runnable slice of the local-first autonomous coding agent
spec: provider abstraction, tool registry, permission engine, and an actual
agent loop — not a mockup. It corresponds to Phases 1–5 of the roadmap
(foundation, repository access, agent loop, editing, terminal + verification).

## What's actually implemented

- **`ModelProvider` abstraction** (`src/types.ts`) — nothing above this layer
  knows which backend is in use.
- **`OpenAICompatibleProvider`** (`src/providers/openaiCompatible.ts`) — talks
  to any OpenAI-compatible `/v1/chat/completions` server: Ollama, LM Studio,
  llama.cpp server, vLLM, etc. Normalizes their tool-call format into the
  internal `ToolCall` type.
- **`EmbeddedLlamaProvider`** (`src/providers/embeddedLlama.ts`) — runs a GGUF
  model in-process via `node-llama-cpp`, no server or other app required. Used
  automatically when `--base-url` is omitted. Auto-downloads and caches a
  curated model (`src/models.ts`: `small`/`medium`/`large`, default
  `small` — Qwen2.5-Coder GGUF) on first run. Uses `node-llama-cpp`'s
  low-level `LlamaChat.generateResponse()` rather than `LlamaChatSession` so
  requested tool calls come back to `AgentSession` instead of being
  auto-executed by the library — `PermissionEngine` still gates every call,
  same as the `OpenAICompatibleProvider` path.
- **`MockProvider`** (`src/providers/mockProvider.ts`) — a scripted provider
  so the harness can be verified with zero network dependency (used by the
  demo and the tests).
- **Tools** (`src/tools/*.ts`): `read_file`, `list_directory`, `grep`
  (ripgrep with a pure-JS fallback), `edit_file`, `run_command`. All file
  tools refuse to touch protected paths (`.env`, `*.pem`, `.ssh/`, etc.) and
  redact secret-shaped strings before they ever reach the model or your
  terminal.
- **`PermissionEngine`** (`src/permissions.ts`) — deterministic rules, not
  LLM judgment: `PLAN` (read-only), `DEFAULT` (asks before writes/exec),
  `ACCEPT_EDITS` (auto-allows safe file writes, still asks for shell), plus
  a command-risk classifier (`SAFE_READ` / `NETWORK` / `DESTRUCTIVE` /
  `UNKNOWN`, unknown defaults to asking).
- **`AgentSession`** (`src/agent.ts`) — the real loop: send messages + tool
  schemas → get a final answer or tool calls → run permission check → execute
  tool → append result → repeat, up to a turn budget. Emits a typed event
  stream (`status`, `tool.start`, `tool.result`, `permission.request`,
  `text`, `done`, `error`).
- **CLI** (`src/cli.ts`) — connects the above to a real local model server.
- **Tests** (`src/test/agent.test.ts`) — 11 assertions covering command risk
  classification, permission decisions across all modes, and a full scripted
  agent run.
- **Working end-to-end demo** (`src/demo.ts` + `fixture-repo/`) — a tiny repo
  with an intentionally broken `add()` function and a failing test. The demo
  scripts a fake model that reads the file, runs the failing test, fixes the
  bug, reruns the test, and only reports success after seeing a real exit
  code 0 — proving the loop, tools, and permission gating all work together
  without needing any LLM running.

## Run it

```bash
npm install
npm run build

# Offline, no LLM required — proves the whole harness works:
npm run demo

# Unit tests:
npm test

# Embedded mode — no server, no other app. Downloads and caches a GGUF
# model on first run (default: Qwen2.5-Coder-1.5B-Instruct, ~1GB):
node dist/cli.js "explain how add() works in math.js" \
  --workspace ./fixture-repo \
  --mode DEFAULT

# Or against an external server (e.g. `ollama pull qwen2.5-coder` first):
node dist/cli.js "explain how add() works in math.js" \
  --workspace ./fixture-repo \
  --base-url http://localhost:11434/v1 \
  --model qwen2.5-coder:latest \
  --mode DEFAULT
```

`--mode PLAN` will refuse all writes/exec; `--mode ACCEPT_EDITS` auto-allows
file edits but still asks before running shell commands; `DEFAULT` asks
before both.

`--model` means different things depending on whether `--base-url` is set:
with it, `--model` is the id the server expects (e.g. `qwen2.5-coder:latest`);
without it (embedded mode), `--model` picks `small` (default) / `medium` /
`large` from the curated list in `src/models.ts`.

## What's deliberately out of scope here

This is a vertical slice proving the harness is real and correct, not the
full spec. Not built: VS Code extension/UI, Tree-sitter/LSP symbol
intelligence, subagents, MCP client, hooks, model router / hardware
detection, checkpoints/undo via git worktrees, sandboxed execution, licensing.
The architecture (provider interface, tool interface, permission engine,
typed event stream) is intentionally the part designed to extend into those
without rework — see the original build prompt's Section 68 boundary rule:
none of `agent.ts`, `permissions.ts`, `toolRegistry.ts`, or the tools import
any UI-specific code, so a VS Code extension or CLI can sit on top
interchangeably.
