# Electron Foundation — design spec

Date: 2026-08-25

## Purpose

Wrap the existing Node/TypeScript agent core (`agent.ts`, `permissions.ts`,
`toolRegistry.ts`, the providers) in an Electron desktop shell (Mac/Windows),
proving the Section 68 boundary rule holds: a UI can sit on top of the core
with zero changes to `agent.ts`. This is the "Foundation" sub-project — the
first of four (Foundation → diff viewer → multi-session/tabs → settings
persistence), each with its own spec/plan/implementation cycle.

Foundation scope: one window, one active session at a time, workspace
picker, provider/mode selection, task input, live event log with inline
permission approve/deny. No packaging/installers, no settings persistence,
no diff viewer, no multiple sessions — those are later sub-projects.

## Architecture

Approach A (main-process-owns-everything), chosen over renderer-owns-session
(rejected — Electron's own security guidance warns against `nodeIntegration`
in the renderer, and it would couple the renderer irreversibly to Node,
foreclosing a future web client) and a local HTTP/WS server in main
(rejected for Foundation — more machinery than needed right now, though
main-owns-session is a superset so this remains a possible later evolution
without an architecture change, only a transport change).

- Main process holds `AgentSession`, `ToolRegistry`, `PermissionEngine`,
  provider instances — unchanged from the CLI path.
- Renderer is pure presentation, vanilla TypeScript + DOM (no framework —
  matches the repo's near-zero-dependency ethos).
- `contextIsolation: true`, `nodeIntegration: false`; a hand-written
  CommonJS preload (`preload.cjs`) exposes a narrow typed bridge
  (`window.agent.*`); the renderer never gets raw `ipcRenderer` or `require`.

## IPC contract

Renderer → main (`ipcRenderer.invoke` / `ipcMain.handle`):

- `agent:start-session(config)` → `{sessionId}`. `config: {workspaceRoot,
  provider: {kind:"openai-compatible", baseUrl, model} | {kind:"embedded",
  size}, mode}`. Builds the same provider + `healthCheck()` sequence
  `cli.ts` already does; rejects with a clear message on health-check
  failure (surfaced inline in the UI, not a crash).
- `agent:run-task(sessionId, task)` → resolves once `session.run()`
  finishes. UI updates come from the pushed event stream, not this
  return value.
- `agent:respond-permission(sessionId, callId, approved)` — resolves the
  pending Promise inside `onApprovalNeeded`. This is the piece that
  requires zero changes to `agent.ts`: `onApprovalNeeded` already awaits a
  Promise; main just resolves it from an IPC handler instead of
  `readline`. A stale/unknown `callId` is a silent no-op, not a throw.
- `agent:cancel-session(sessionId)` — calls `session.cancel()`. Cooperative
  only: `agent.ts` checks the cancelled flag at loop boundaries, not
  mid-await, so this won't interrupt an in-flight model call or running
  shell command.
- `agent:pick-workspace()` → `string | null`, wraps
  `dialog.showOpenDialog`.

Main → renderer (push, `webContents.send` / `ipcRenderer.on`):

- `agent:event(sessionId, event)` — the existing `AgentEvent` union from
  `types.ts`, serialized as-is (plain data, no functions/class instances —
  structured-clone-safe).

## Project layout

```
src/electron/
  sessionRegistry.ts   # testable core: provider building, session map,
                        # start/run/respond/cancel — no Electron imports
  main.ts               # app lifecycle, BrowserWindow, thin IPC handlers
                         # wrapping sessionRegistry
  preload.cjs            # hand-written CommonJS (not compiled — Electron's
                         # sandboxed preload context is the one place ESM
                         # support is still inconsistent)
  renderer/
    index.html
    renderer.ts
    styles.css
scripts/
  copy-electron-assets.mjs   # fs.cpSync, no new dependency — copies
                              # index.html/styles.css/preload.cjs into
                              # dist/electron/ after tsc
```

`main.ts`/`renderer.ts` compile via the existing `tsc` (already includes
all of `src/**/*.ts`); `__dirname` is derived via
`fileURLToPath(import.meta.url)`, the same pattern `agent.test.ts` already
uses, since the whole project is ESM (`"type": "module"`).

`package.json` gains a `devDependency` on `electron` (confirmed installs
cleanly on this machine despite its `engines: {node: >=22.12}` field —
that's Electron's own dev requirement, not a runtime constraint on the
host, since it bundles its own Node/V8) and scripts:
`"build"` chains `tsc` with the asset-copy script; `"electron"` runs
`electron dist/electron/main.js`.

## Testing

`sessionRegistry.ts` has zero Electron imports and takes a
`providerFactory` injection seam, so it's unit-testable with
`MockProvider` exactly like `agent.test.ts` already does: session-start
picks the right provider kind and surfaces health-check failure,
`run-task` streams events ending in `done`, `respond-permission` unblocks
a pending `ASK` (and no-ops on an unknown id), `cancel-session` ends the
run with `success:false`/"Cancelled by user.". `main.ts`'s IPC handlers
are thin wrappers around these — not separately tested.

The window/preload/DOM wiring is not unit-testable and is verified by
manually running `npm run build && npm run electron` and exercising the
UI against `fixture-repo` (the same scenario `demo.ts` scripts), including
deliberately checking PLAN mode (never prompts, everything denied) and
ACCEPT_EDITS (file edits skip the prompt, shell commands still ask).

## Known limitations (accepted for Foundation)

- One session at a time; starting a new one in embedded mode reloads the
  GGUF model fresh (no provider-instance caching across sessions).
- No packaging/installers — run via `npm run electron` from source only.
