# localagent — working prototype

A small, runnable slice of the local-first autonomous coding agent spec:
provider abstraction, tool registry, permission engine, and a working agent
loop. It corresponds to Phases 1–5 of the roadmap (foundation, repository
access, agent loop, editing, terminal + verification).

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
- **Electron desktop app — "Foundation"** (`src/electron/`) — a Mac/Windows
  shell around the same core, zero changes to `agent.ts` (see
  `docs/superpowers/specs/2026-08-25-electron-foundation-design.md`).
  `sessionRegistry.ts` holds the provider/session logic (unit-tested, no
  Electron imports); `main.ts` owns the one `AgentSession` and exposes it to
  the renderer over IPC; `preload.cjs` is a hand-written CommonJS bridge
  (`contextIsolation: true`, `nodeIntegration: false`); `renderer/` is a
  vanilla-TS single-window UI: workspace picker, provider/mode selection,
  task input, and a live event log with inline permission approve/deny.
  One session at a time — multi-session, a diff viewer, and settings
  persistence are follow-on sub-projects, not built here. `googleAuth.ts`
  adds optional Google sign-in (system browser + PKCE + a loopback
  redirect server, see
  `docs/superpowers/specs/2026-08-26-google-apple-signin-design.md`) —
  identity only, nothing is gated by it; Apple sign-in is a disabled UI
  stub pending an Apple Developer account and a registered domain.
- **Tests** (`src/test/agent.test.ts`, `src/test/sessionRegistry.test.ts`) —
  covering command risk classification, permission decisions across all
  modes, a full scripted agent run, and the Electron session-registry logic
  (session start/provider selection, event streaming, permission
  unblocking, cancellation) via `MockProvider`.
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
# model on first run (default: Qwen2.5-Coder-1.5B-Instruct, ~1GB) to
# node-llama-cpp's default models directory, ~/.node-llama-cpp/models —
# delete that folder to clear the cache, or pre-seed it offline before a
# machine goes air-gapped.
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

`--mode PLAN` refuses all writes/exec; `--mode ACCEPT_EDITS` auto-allows
file edits but still asks before running shell commands; `DEFAULT` asks
before both.

`--model` means different things depending on whether `--base-url` is set:
with it, `--model` is the id the server expects (e.g. `qwen2.5-coder:latest`);
without it (embedded mode), `--model` picks `small` (default) / `medium` /
`large` from the curated list in `src/models.ts`.

### Desktop app

```bash
npm run build      # also copies src/electron's static assets into dist/electron/
npm run electron
```

Pick a workspace (e.g. `fixture-repo`), choose embedded or external
provider, pick a mode, type a task, hit Run — the event log renders tool
calls/results live, with inline Approve/Deny buttons for anything the
permission engine asks about.

Optionally, sign in with a Google account from the header control — this is
identity only right now (nothing in the app is gated by it). It needs a
Google Cloud OAuth Client ID, which you create yourself:

1. https://console.cloud.google.com/ → create/select a project.
2. APIs & Services → OAuth consent screen → configure (External or
   Internal) with an app name and support email.
3. APIs & Services → Credentials → Create Credentials → OAuth client ID →
   Application type: **Desktop app**.
4. Copy the generated Client ID.
5. Set it as `GOOGLE_OAUTH_CLIENT_ID` in the environment the Electron app
   launches from — same pattern as `ANTHROPIC_API_KEY`, no UI field,
   nothing committed to the repo:
   ```bash
   GOOGLE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com npm run electron
   ```
6. If sign-in fails with `client_secret is missing`, Google has issued your
   Client ID as a type that requires it even with PKCE. Download the
   client secret JSON from the same Credentials page and also set
   `GOOGLE_OAUTH_CLIENT_SECRET` (it's optional otherwise — omit it and
   nothing sends a `client_secret`):
   ```bash
   GOOGLE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com \
   GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret \
   npm run electron
   ```

Without `GOOGLE_OAUTH_CLIENT_ID` set, "Sign in with Google" shows an inline
error instead of opening a browser. "Sign in with Apple" is a disabled stub
for now — it needs a paid Apple Developer account and a registered web
domain, neither of which exists for this project yet (see
`docs/superpowers/specs/2026-08-26-google-apple-signin-design.md`).

> **If you're running this from inside a sandboxed agent CLI** (e.g. Claude
> Code) rather than a normal terminal: some sandboxes set
> `ELECTRON_RUN_AS_NODE=1` so their own bundled Electron binary can double as
> a plain Node runtime internally. That env var makes *any* Electron binary
> skip its app/window machinery entirely and just run the entry file as
> plain Node — `import ... from "electron"` then fails or resolves to `{}`,
> and no window ever opens. It's not a bug in this app; unset it for the
> `electron` process specifically: `env -u ELECTRON_RUN_AS_NODE npm run
> electron`. A normal user terminal won't have this variable set at all.

## What's deliberately out of scope here

This is a vertical slice proving the harness is real and correct, not the
full spec. Not built: VS Code extension, Tree-sitter/LSP symbol
intelligence, subagents, MCP client, hooks, checkpoints/undo via git
worktrees, sandboxed execution, licensing, and — within the Electron app
itself — packaging/installers, multi-session/tabs, a diff viewer, and
settings persistence.
The architecture (provider interface, tool interface, permission engine,
typed event stream) is intentionally the part designed to extend into those
without rework — see the original build prompt's Section 68 boundary rule:
none of `agent.ts`, `permissions.ts`, `toolRegistry.ts`, or the tools import
any UI-specific code, so a VS Code extension, the CLI, and the Electron app
all sit on top interchangeably — the Electron desktop app now proves that
in practice, with zero changes to `agent.ts`.
