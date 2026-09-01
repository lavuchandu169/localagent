# localagent

**A local-first autonomous coding agent.** Bring your own model — a GGUF
file running entirely in-process, any OpenAI-compatible server (Ollama, LM
Studio, vLLM, llama.cpp server), or Claude — and get a real agent loop with
a permission engine, file/search/edit/shell tools, and a desktop app on top,
with nothing required to leave your machine.

[![Latest release](https://img.shields.io/github/v/release/lavuchandu169/localagent?include_prereleases&label=release)](https://github.com/lavuchandu169/localagent/releases)
[![License](https://img.shields.io/badge/license-proprietary-red)](LICENSE)
![Node](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?logo=typescript&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-arm64-000000?logo=apple&logoColor=white)
![Windows](https://img.shields.io/badge/Windows-x64-0078D6?logo=windows&logoColor=white)
![Runs offline](https://img.shields.io/badge/runs-offline--first-2ea44f)

This is a working vertical slice, not the full spec — see
[What's out of scope](#whats-deliberately-out-of-scope) for the honest list
of what isn't built yet.

## Contents

- [Highlights](#highlights)
- [Quick start](#quick-start)
- [CLI](#cli)
  - [Embedded models](#embedded-models)
- [Desktop app](#desktop-app)
  - [Download the beta](#download-the-beta)
  - [Google sign-in and cloud backup](#google-sign-in-and-cloud-backup)
  - [Using Claude (Anthropic API)](#using-claude-anthropic-api)
  - [Running inside a sandboxed agent CLI](#running-inside-a-sandboxed-agent-cli)
- [Privacy](#privacy)
- [Testing](#testing)
- [Project structure](#project-structure)
- [What's deliberately out of scope](#whats-deliberately-out-of-scope)
- [License](#license)

## Highlights

**Agent core**
- A real loop (`src/agent.ts`): send messages + tool schemas → get a final
  answer or tool calls → permission check → execute → append result →
  repeat, up to a turn budget. Emits a typed event stream (`status`,
  `tool.start`, `tool.result`, `permission.request`, `text`, `done`,
  `error`) that both the CLI and the desktop app render live.
- Runtime-enforced grounding: if a task names a real file, it gets read
  automatically before the model's first turn — small local models proved
  unreliable at doing this on their own from prompt wording alone.

**Providers — swap the backend without touching the agent**
- **`EmbeddedLlamaProvider`** — runs a curated GGUF model entirely
  in-process via `node-llama-cpp`. No server, no other app. Auto-downloads
  and caches on first run. 7 curated models across two purposes — 3 coding
  models (Qwen2.5-Coder 1.5B/3B/7B Instruct, default the 1.5B) and 4
  general daily-chat models (Qwen2.5 3B, Llama 3.2 3B, Phi-3.5 Mini,
  Mistral 7B v0.3 Instruct) — each shown in the desktop app by its real
  name, grouped by purpose, never behind a generic "small/medium/large"
  label.
- **`OpenAICompatibleProvider`** — talks to Ollama, LM Studio, vLLM, or any
  `/v1/chat/completions` server.
- **`AnthropicProvider`** — the real Claude API, when you want frontier
  quality and don't mind code leaving the machine.
- **`MockProvider`** — a scripted provider for zero-network tests and the
  demo.

**Tools & safety, not vibes**
- `read_file`, `list_directory`, `grep` (ripgrep with a pure-JS fallback),
  `edit_file`, `run_command`.
- Every file tool refuses to touch protected paths (`.env*`, `*.pem`,
  `*.key`, `id_rsa*`, `credentials.*`, `secrets.*`, `.ssh/`, `.aws/`,
  `.git/`) and redacts secret-shaped strings before they ever reach the
  model or your terminal.
- `PermissionEngine` is deterministic code, not LLM judgment: four modes
  (`PLAN` / `DEFAULT` / `ACCEPT_EDITS` / `AUTO_SAFE`) plus a command-risk
  classifier (`SAFE_READ` / `NETWORK` / `DESTRUCTIVE` / `UNKNOWN` — unknown
  always asks). A model proposing a whole-file rewrite it never actually
  read gets asked, too, even in auto-approve modes.

**Desktop app**
- A Mac/Windows Electron shell around the same core, with zero changes to
  `agent.ts` — workspace picker, provider/mode selection, task input, and
  a live event log with inline Approve/Deny.
- **Session history** — every completed task autosaves; a sidebar lists
  and full-text-searches past sessions, and resuming one restores full
  model context, not a read-only transcript.
- **Optional Google sign-in**, gating nothing — the app is fully usable
  signed-out. Signed in, it turns on **automatic backup to a hidden
  folder in your Google Drive**, so history survives a reinstall or a
  move to a new machine, filtered per-account like any multi-user app.

## Quick start

```bash
npm install
npm run build

# Offline, no LLM required — proves the whole harness works end-to-end:
npm run demo

# Full test suite:
npm test
```

`npm run demo` runs against `fixture-repo/`, a tiny repo with an
intentionally broken `add()` function and a failing test. A scripted fake
model reads the file, runs the failing test, fixes the bug, reruns it, and
only reports success after seeing a real exit code `0` — proving the loop,
tools, and permission gating all work together without any real LLM.

## CLI

```bash
# Embedded mode — no server, no other app. Downloads and caches a GGUF
# model on first run (default: Qwen2.5-Coder-1.5B-Instruct, ~1GB) into
# node-llama-cpp's default models directory, ~/.node-llama-cpp/models —
# delete that folder to clear the cache, or pre-seed it before going air-gapped.
node dist/cli.js "explain how add() works in math.js" \
  --workspace ./fixture-repo \
  --mode DEFAULT

# Against an external server (e.g. `ollama pull qwen2.5-coder` first):
node dist/cli.js "explain how add() works in math.js" \
  --workspace ./fixture-repo \
  --base-url http://localhost:11434/v1 \
  --model qwen2.5-coder:latest \
  --mode DEFAULT

# The real Claude API instead — sends code over the network, needs ANTHROPIC_API_KEY:
node dist/cli.js "explain how add() works in math.js" \
  --workspace ./fixture-repo \
  --provider anthropic \
  --mode DEFAULT
```

| Flag | Meaning |
|---|---|
| `--workspace <dir>` | Repo root the agent's file tools operate on |
| `--base-url <url>` | Use an OpenAI-compatible server instead of the embedded model |
| `--model <name>` | Server model id with `--base-url`; one of the 7 embedded model ids otherwise (default `qwen-coder-1.5b`) — run with no args to see the full list grouped by coding/chat |
| `--provider anthropic` | Use the real Claude API (needs `ANTHROPIC_API_KEY`) |
| `--mode <mode>` | Permission mode, see below |

| Mode | Reads | Edits | Shell commands |
|---|---|---|---|
| `PLAN` | ✅ free | 🚫 refused | 🚫 refused |
| `DEFAULT` | ✅ free | ⏸ asks | ⏸ asks |
| `ACCEPT_EDITS` | ✅ free | ✅ auto | ⏸ asks |
| `AUTO_SAFE` | ✅ free | ✅ auto | ⏸ asks *(safe-command auto-approval not wired up yet — same as `ACCEPT_EDITS` today)* |

### Embedded models

All GGUF, `Q4_K_M`, resolved via `node-llama-cpp`'s `resolveModelFile()`. The
desktop app shows the **Name** column grouped by **Purpose**; `--model` takes
the id.

| Id | Name | Purpose | Note |
|---|---|---|---|
| `qwen-coder-1.5b` | Qwen2.5-Coder 1.5B Instruct | Coding | fastest, lowest memory — default |
| `qwen-coder-3b` | Qwen2.5-Coder 3B Instruct | Coding | better quality, more memory |
| `qwen-coder-7b` | Qwen2.5-Coder 7B Instruct | Coding | best quality, needs a capable machine |
| `qwen-3b` | Qwen2.5 3B Instruct | Chat | fast, general-purpose |
| `llama-3.2-3b` | Llama 3.2 3B Instruct | Chat | fast, general-purpose |
| `phi-3.5-mini` | Phi-3.5 Mini Instruct | Chat | compact, strong reasoning for its size |
| `mistral-7b` | Mistral 7B Instruct v0.3 | Chat | best quality, needs a capable machine |

Hardware auto-recommendation (the "recommended for this machine" tag in the
desktop app) only picks among the 3 coding models, by RAM: <8GB →
`qwen-coder-1.5b`, 8–16GB → `qwen-coder-3b`, ≥16GB → `qwen-coder-7b`. Chat
models are there to pick manually.

Inference runs on CPU in the prebuilt installers — `node-llama-cpp`'s
optional CUDA/Vulkan GPU backends are deliberately excluded from packaging
(they alone were ~500MB of an otherwise ~40MB install, mostly NVIDIA-only
CUDA binaries most users can't use). It falls back to CPU automatically
either way, so nothing breaks; you just don't get GPU acceleration in the
packaged app. Building from source with those packages present will
include them.

## Desktop app

```bash
npm run build      # also copies src/electron's static assets into dist/electron/
npm run electron
```

Pick a workspace (e.g. `fixture-repo`), choose embedded or external
provider, pick a mode, type a task, hit **Run** — the event log renders
tool calls/results live, with inline Approve/Deny for anything the
permission engine asks about. Past sessions live in the left sidebar,
searchable and resumable with full context.

### Download the beta

Prebuilt installers are attached to each [GitHub Release](https://github.com/lavuchandu169/localagent/releases) — no `npm install`/`npm run build` needed. See [`CHANGELOG.md`](CHANGELOG.md) for what changed in each one.

These are unsigned builds (no Apple Developer or Windows code-signing
certificate behind them yet), so your OS will show a one-time warning
on first launch — normal for a beta, not a sign anything's wrong:

- **macOS**: Gatekeeper blocks it ("cannot be opened because the
  developer cannot be verified"). Right-click the app → **Open** →
  confirm in the dialog. Only needed once.
- **Windows**: SmartScreen shows "Windows protected your PC." Click
  **More info** → **Run anyway**. Only needed once.

This beta's macOS build is Apple Silicon (arm64) only — Intel Mac
(x64) support isn't available yet.

Google sign-in and Drive backup work in the packaged installers out of the
box — official `.dmg`/`.exe` downloads ship with a working Client ID
built in, so sign-in just works with no setup. If you'd rather use your
own Google Cloud project (your own quota, your own consent screen), open
the app's Settings panel (the gear icon next to the "?" About button) and
paste in your own Client ID — the same credentials a from-source
developer would put in `.env` (see below for how to create one).

### Google sign-in and cloud backup

Optional, and it gates nothing — chat, tasks, and session history all work
fully signed-out. Signing in additionally turns on automatic backup of your
session history to a private, hidden folder in your Google Drive
(`drive.appdata` — invisible in your normal Drive UI, scoped to this app),
so it survives a reinstall or a new machine. History itself is filtered
per signed-in account, the same way any multi-user app keeps your chats
yours.

Uses PKCE, no client secret required by Google's own design for desktop
apps — though in practice some "Desktop app" client registrations still
enforce one, so `GOOGLE_OAUTH_CLIENT_SECRET` is supported when Google asks
for it (see troubleshooting below). The signed-in refresh token is
encrypted at rest via your OS's native credential store (Keychain on
macOS, DPAPI on Windows, libsecret on Linux) — never written to disk as
plain text.

Official builds already have a working Client ID baked in — you only need
the steps below if you want to run from source, or want your own Google
Cloud project instead of the built-in one (nothing from your own project
is shared with anyone else's):

1. [console.cloud.google.com](https://console.cloud.google.com/) → create
   or select a project.
2. **APIs & Services → OAuth consent screen** → configure (External or
   Internal) with an app name and support email. While the screen is in
   **Testing**, add your own Google account under **Audience → Test
   users** — otherwise sign-in fails with `access_denied`.
3. **APIs & Services → Library** → search **Google Drive API** → **Enable**.
   Skip this and backup fails silently with a `Google Drive API has not
   been used in project ...` error in the console.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   → Application type: **Desktop app**. Copy the generated Client ID.
5. Put your credentials in a `.env` file in the project root (already
   gitignored — never committed) instead of exporting them every time:
   ```bash
   export GOOGLE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com
   export GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret
   ```
   `npm run electron` loads it automatically; a variable already set in
   your real shell environment always wins over the file.

   Running the packaged app instead of building from source? Use the
   in-app Settings panel (gear icon) instead of `.env` — see
   [Download the beta](#download-the-beta) above.

<details id="troubleshooting">
<summary>Troubleshooting</summary>

| Symptom | Cause | Fix |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID is not set` | No client ID in the environment, `.env`, saved Settings, or (only possible from source / a non-official build) the embedded default | Running from source: see step 5 above. Running an official packaged app: this shouldn't happen — sign-in should just work; if it does, open Settings (gear icon in the header) and paste a Client ID/Secret there as a workaround. |
| `access_denied` at Google's consent screen | OAuth consent screen is in Testing and your account isn't a test user | Add yourself under Audience → Test users (step 2) |
| `client_secret is missing` | Google issued this Client ID as a type that needs it even with PKCE | Set `GOOGLE_OAUTH_CLIENT_SECRET` too |
| `[cloudSync] upload failed ... Google Drive API has not been used` | The Drive API itself isn't enabled for the project | Enable it (step 3), wait ~30s, retry |
| Session history doesn't come back after reinstall | Uploads never actually reached Drive (check the terminal for `[cloudSync]` lines) | Fix whatever the log line says, then sign in again — the next save retries automatically |
| Already signed in, but backup silently isn't happening | The stored token predates the Drive scope | Sign in again once to re-consent |

</details>

"Sign in with Apple" is a disabled stub — it needs a paid Apple Developer
account and a registered web domain, neither of which exists for this
project yet.

### Using Claude (Anthropic API)

Advanced → Claude API sends file contents and task context to Anthropic
over the network — needs an API key from
[console.anthropic.com](https://console.anthropic.com/settings/keys),
pay-as-you-go. This is a separate product from a claude.ai Pro/Max
subscription: Anthropic's terms reserve that subscription's sign-in for
Claude Code and claude.ai itself, so it can't be used from this (or any
other third-party) app — an API key is the only supported way in.

Set `ANTHROPIC_API_KEY` in your environment (or a `.env` file, from
source), or add the key in the app's Settings panel (gear icon) — same
env-var-wins-over-saved-setting precedence as Google's credentials.
Leaving both unset falls back to the Anthropic SDK/CLI's own handling
(`ANTHROPIC_AUTH_TOKEN`, an `ant auth login` profile), unchanged.

### Running inside a sandboxed agent CLI

Some sandboxes (e.g. Claude Code) set `ELECTRON_RUN_AS_NODE=1` so their own
bundled Electron binary can double as a plain Node runtime internally. That
env var makes *any* Electron binary skip its app/window machinery entirely
and just run the entry file as plain Node — `import ... from "electron"`
then fails or resolves to `{}`, and no window ever opens. It's not a bug in
this app; unset it for the `electron` process specifically:

```bash
env -u ELECTRON_RUN_AS_NODE npm run electron
```

A normal user terminal won't have this variable set at all.

## Privacy

There is no backend for this project — no server we operate, no
analytics, no telemetry, nothing phoning home. Everything below happens
directly between your machine and whichever service you've explicitly
configured.

- **Your code and files** stay on your machine unless you choose a
  provider that sends them elsewhere: `--provider anthropic` sends task
  context to Anthropic's API (needs your own `ANTHROPIC_API_KEY`);
  `--base-url` sends it to whatever OpenAI-compatible server you point at
  (typically a local one, e.g. Ollama). The default embedded mode sends
  nothing anywhere — inference runs entirely in-process.
- **Session history** is saved locally (`app.getPath('userData')/sessions`).
  It only leaves your machine if you sign in with Google, in which case
  it's backed up to a hidden, app-private folder in *your own* Google
  Drive (`drive.appdata` — not visible in your normal Drive UI, not
  accessible to any other app or person) — see
  [Google sign-in and cloud backup](#google-sign-in-and-cloud-backup).
- **Google sign-in** is optional and gates nothing. If used, your email,
  name, and profile picture URL are requested from Google's own identity
  endpoint and stored locally so the app can show who's signed in; the
  refresh token needed to keep that session and Drive backup working is
  encrypted at rest via your OS's native credential store (Keychain /
  DPAPI / libsecret), never written to disk as plain text.
- **Nothing is shared between users of this app.** Each Google account's
  backed-up sessions live only in that account's own Drive; local session
  history is filtered to whichever account is currently signed in.
- **Crash and error logs** are written locally
  (`app.getPath('userData')/error.log`) and never uploaded anywhere — no
  external crash-reporting service, no account, no telemetry. Electron's
  native crash reports (`crashReporter`) are configured the same way
  (`uploadToServer: false`). Open the log via About → Open error log if
  you ever need it for a bug report.

This is a local-first prototype, not a hosted product — the source above
is the actual and complete description of what it does with your data.

## Testing

```bash
npm test
```

No test framework — plain Node scripts under `src/test/` with a
hand-rolled `check(name, condition)` assertion, chained together in
`package.json`'s `test` script. Coverage spans command-risk classification,
permission decisions across every mode, a full scripted agent run, Google
OAuth token/PKCE plumbing, the Electron session registry (start/provider
selection/event streaming/cancellation) via `MockProvider`, local session
persistence, and Drive-backed cloud sync (CRUD + reconcile) against a fake
`fetch` — real behavior, not framework mocks.

## Project structure

| Path | What it is |
|---|---|
| `src/agent.ts` | The agent loop itself — provider-, tool-, and UI-agnostic |
| `src/types.ts` | The `ModelProvider` interface everything else depends on |
| `src/providers/` | `EmbeddedLlamaProvider`, `OpenAICompatibleProvider`, `AnthropicProvider`, `MockProvider` |
| `src/tools/` | `read_file`, `list_directory`, `grep`, `edit_file`, `run_command` |
| `src/permissions.ts` | `PermissionEngine` — the deterministic policy layer |
| `src/protected.ts` | Protected-path matching and secret redaction |
| `src/sessionStore.ts` | Explicit-path local session persistence (file-per-session + index) |
| `src/cloudSync.ts` | Electron-free Google Drive backup/restore (CRUD + reconcile) |
| `src/cli.ts` | The terminal entry point |
| `src/electron/` | The desktop app — `main.ts`, `sessionRegistry.ts`, `preload.cjs`, `renderer/`, `googleAuth.ts` |
| `src/demo.ts` + `fixture-repo/` | The scripted, offline, end-to-end proof |
| `src/test/` | The suite `npm test` runs |
| `docs/superpowers/specs/` | Design docs for each feature, written before it was built |

None of `agent.ts`, `permissions.ts`, `toolRegistry.ts`, or the tools
import any UI-specific code — the CLI and the Electron app sit on top of
the exact same core interchangeably, and the desktop app was added with
**zero changes to `agent.ts`**.

## What's deliberately out of scope

This is a vertical slice proving the harness is real and correct, not the
full spec. Not built: a VS Code extension, Tree-sitter/LSP symbol
intelligence, subagents, an MCP client, hooks, sandboxed execution, and —
within the Electron app itself — multi-session/tabs and Drive
delete-propagation (deleting a session while signed out can reappear on
the next sign-in; documented, not yet fixed).

A real diff viewer and one-checkpoint-per-task revert (git repos only,
via `git stash create` against a scratch index — never touches your
actual index, HEAD, or branch) now exist; per-hunk approval and a deeper
multi-checkpoint undo history don't.

The architecture is intentionally the part designed to extend into all of
that without rework — the provider interface, tool interface, permission
engine, and typed event stream are the boundary that makes it possible.

## License

All rights reserved — see [`LICENSE`](LICENSE). The source is public for
viewing, but no license to use, copy, modify, or redistribute it is
granted. Prebuilt installers on the [Releases
page](https://github.com/lavuchandu169/localagent/releases) are provided
for personal use of the app as distributed.
