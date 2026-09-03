# MCP client support — design spec

Date: 2026-09-04

## Purpose

Today the agent's tool surface is fixed and built into the app: `read_file`,
`list_directory`, `grep`, `edit_file`, `run_command`
([toolRegistry.ts](../../../src/toolRegistry.ts)). This adds the ability to
configure local [MCP](https://modelcontextprotocol.io) servers — e.g. a
GitHub server, a Postgres server, any of the growing community ecosystem —
whose tools then become available to the agent, without writing custom tool
code per server. Every MCP tool call flows through the app's existing
permission-prompt machinery exactly like a built-in tool.

## Scope

- **Transport:** local (stdio) servers only — a configured command + args,
  spawned as a child process. Remote (HTTP/SSE) servers are out of scope for
  this spec; a real design decision on its own (remote auth storage,
  network-failure handling), left for a follow-up.
- **Connect once, at app startup**, shared across every session — not
  per-session, not lazy-on-first-call. All enabled servers spawn together in
  `main.ts`'s `app.whenReady()`, alongside the existing autoUpdater wiring.
  One process per server total, regardless of how many sessions/tabs are
  open — relevant now that multi-session/tabs is next on the roadmap.
- **Permission:** every MCP tool call always asks for approval, in every
  `PermissionMode` — no per-server trust setting, no auto-allow tier.
- **Config UX:** a structured form in a new, dedicated **MCP Servers**
  panel (opened the same way the existing About panel is), not raw JSON
  editing and not squeezed into the existing Settings panel. The panel
  shows the server list first; a "+ Add server" button swaps the list out
  for the add-server form (a "← Back" returns to the list) — one thing on
  screen at a time, confirmed via the visual companion during brainstorming.
- **Crash handling:** if a connected server's process exits unexpectedly,
  it's marked failed and its tools quietly disappear from what the model
  can call — every other server and the app itself are unaffected. No
  auto-retry/backoff; the user can edit-and-resave (or just re-launch the
  app) to reconnect.

## Dependency

The official **`@modelcontextprotocol/sdk`** (npm, latest `1.30.0` as of
this spec) — `Client` + `StdioClientTransport`. Verified directly against
the published package's real `.d.ts` files (not recalled/guessed):

```typescript
// src/client/index.ts
export class Client<...> extends Protocol<...> {
  constructor(clientInfo: Implementation, options?: ClientOptions);
  connect(transport: Transport, options?: RequestOptions): Promise<void>;
  listTools(params?, options?): Promise<{ tools: { name: string; description?: string; inputSchema: {...} }[]; nextCursor?: string }>;
  callTool(params: CallToolRequest["params"], resultSchema?, options?): Promise<{
    content: ({ type: "text"; text: string } | { type: "image"; ... } | ...)[];
    isError?: boolean;
  }>;
  // inherited from Protocol:
  onclose?: () => void;
  onerror?: (error: Error) => void;
  close(): Promise<void>;
}

// src/client/stdio.ts
export type StdioServerParameters = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  stderr?: IOType | Stream | number; // default "inherit"
  cwd?: string;
};
export class StdioClientTransport implements Transport {
  constructor(server: StdioServerParameters);
  get pid(): number | null;
}
```

`client.onclose` is the real hook the crash-handling requirement above is
built on — `Protocol` (which `Client` extends) fires it whenever the
transport closes, including the child process exiting.

Hand-rolling the JSON-RPC handshake/capability-negotiation ourselves
instead of taking this dependency was considered and rejected — it's the
same implementation Claude Code and Claude Desktop use for MCP, and
protocol correctness here has zero benefit to reinventing.

## Components

### `src/electron/mcpSettings.ts` (new)

Load/save the configured server list — same shape as
[anthropicSettings.ts](../../../src/electron/anthropicSettings.ts): a JSON
file, encrypted via the existing `StorageCrypto` (env vars can hold
secrets like `GITHUB_TOKEN`).

```typescript
export interface McpServerConfig {
  id: string; // crypto.randomUUID(), generated on add — stable identity across renames
  name: string; // user-facing + used to build each tool's mcp__<name>__<tool> prefix; must be unique — `agent:add-mcp-server`/`agent:edit-mcp-server` reject a duplicate name with an error string, shown in the form the same way `#settings-error`/`#anthropic-settings-error` already render save failures
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
}

export async function loadMcpSettings(settingsFilePath: string, storageCrypto?: StorageCrypto): Promise<McpServerConfig[]>;
export async function saveMcpSettings(settingsFilePath: string, servers: McpServerConfig[], storageCrypto?: StorageCrypto): Promise<void>;
```

Mirrors `loadAnthropicSettings`/`saveAnthropicSettings` exactly: malformed
or missing file → `[]`, never throws.

### `src/mcpClient.ts` (new)

One connection to one configured server.

```typescript
export type McpServerStatus =
  | { state: "connecting" }
  | { state: "connected"; toolCount: number }
  | { state: "failed"; error: string };

export interface McpConnection {
  config: McpServerConfig;
  status: McpServerStatus;
  /** The live SDK Client, only while status is "connected" — undefined otherwise. */
  client: Client | undefined;
}

export async function connectMcpServer(
  config: McpServerConfig,
  onStatusChange: (status: McpServerStatus) => void
): Promise<McpConnection>;
```

`connectMcpServer` never throws — a failed `client.connect()` (bad
command, server rejects the handshake) resolves to `{ status: { state:
"failed", error } }` instead, matching this app's established "background
work degrades, never throws at the caller" posture (auto-updater,
cloud sync). `client.onclose`/`client.onerror` are wired before `connect()`
to call `onStatusChange({ state: "failed", error })` if the process dies
later, mid-session.

### `src/mcpToolAdapter.ts` (new)

Wraps every tool listed by one connected server into this app's `Tool`
interface ([types.ts](../../../src/types.ts)).

```typescript
export function adaptMcpTools(serverName: string, client: Client, mcpTools: { name: string; description?: string; inputSchema: object }[]): Tool[]
```

For each MCP tool:

- `name`: `` mcp__${sanitize(serverName)}__${mcpTool.name} `` — the same
  `mcp__<server>__<tool>` convention Claude Code itself uses for MCP tools.
  `sanitize` lowercases and replaces any character outside `[a-z0-9_]`
  with `_`. Config save already enforces unique server names, so no
  further collision handling is needed here.
- `description`: the MCP tool's own description, prefixed with `[MCP:
  <serverName>]` so it's unambiguous in the model's tool list and in the
  permission prompt which server a call is coming from.
- `permission: "DANGEROUS"` — per [permissions.ts](../../../src/permissions.ts),
  this already means "always ASK, and PLAN mode denies outright" in every
  mode, with **zero changes to the permission engine**.
- `inputSchema`: passed through from the MCP tool's own declared schema
  unmodified — it's already JSON Schema, the same shape `Tool.inputSchema`
  expects.
- `execute(input, ctx)`: calls `client.callTool({ name: mcpTool.name,
  arguments: input })` and maps the result:
  - `isError: true` → `{ ok: false, output: null, error: <joined text of every "text" content block> }`
  - otherwise → `{ ok: true, output: { content: <joined text of every "text" content block> } }`
    Non-text content blocks (image/audio/resource) are summarized as
    `[<type> content omitted]` within that joined text rather than passed
    through structurally — this app's tool-result channel back to the
    model is plain text (`JSON.stringify(result)`, see
    [agent.ts:221](../../../src/agent.ts#L221)), the same treatment every
    existing tool's output already gets.
  - A thrown/rejected `callTool` (the connection itself just died) is
    caught and returned as `{ ok: false, output: null, error: err.message }`
    — a tool failure the model sees and can react to, not a crash.

### `src/electron/main.ts`

At `app.whenReady()`, alongside the existing autoUpdater block:

```typescript
// Unlike autoUpdater, this connects in dev runs too — there's no
// packaged-only reason to gate it, and testing MCP servers from source is
// exactly when a developer most needs it to actually run.
let mcpConnections: McpConnection[] = [];
const configs = await loadMcpSettings(mcpSettingsPath, storageCrypto);
mcpConnections = await Promise.all(
  configs.filter((c) => c.enabled).map((c) =>
    connectMcpServer(c, (status) => {
      const conn = mcpConnections.find((existing) => existing.config.id === c.id);
      if (conn) conn.status = status;
      broadcastToAllWindows("agent:mcp-server-status-changed", { id: c.id, status });
    })
  )
);

function currentMcpTools(): Tool[] {
  return mcpConnections
    .filter((c) => c.status.state === "connected" && c.client)
    .flatMap((c) => adaptMcpTools(c.config.name, c.client!, /* cached listTools() result */));
}
```

`currentMcpTools()` is read fresh on every `startSession` call (not cached
at app-startup time) so a server that fails mid-session correctly drops
out of every *new* session's tool list — already-running sessions keep
whatever `ToolRegistry` they were built with, matching how this app
already treats a session's config as fixed at start.

### `src/toolRegistry.ts`

```typescript
export function defaultToolRegistry(extraTools: Tool[] = []): ToolRegistry {
  return new ToolRegistry([readFileTool, listDirectoryTool, grepTool, editFileTool, runCommandTool, ...extraTools]);
}
```

### `src/electron/sessionRegistry.ts`

`startSession`'s existing `tools: defaultToolRegistry()`
([sessionRegistry.ts:134](../../../src/electron/sessionRegistry.ts#L134))
becomes `tools: defaultToolRegistry(deps.currentMcpTools())` — one call
site change, `currentMcpTools` passed down the same way other `main.ts`-
owned dependencies already reach `sessionRegistry.ts`.

### IPC / preload / renderer

New handlers, mirroring the existing Google/Anthropic settings pattern:

- `agent:list-mcp-servers` → `McpServerConfig[]` merged with each one's
  live `McpServerStatus` (name/command/args are not secret; env values
  are never sent to the renderer — same posture as how the Anthropic key
  itself is never echoed back, only a `hasSecret`-style boolean per env
  var).
- `agent:add-mcp-server` / `agent:edit-mcp-server` (config) → saves,
  disconnects the old connection for that id if editing, connects the new
  one, returns its resulting status.
- `agent:remove-mcp-server` (id) → disconnects (if connected) and removes
  from saved config.
- `agent:mcp-server-status-changed` (broadcast) → so the panel updates
  live if a connected server crashes while the panel is open.

**Renderer:** a new "MCP Servers" panel (`#mcp-servers-panel`, `#mcp-servers-toggle`
in the activity bar next to the existing Settings/About icons), built to
the approved layout: list view by default (each row: name, 🟢/🔴 status
dot, command summary, tool count or error text, Edit/Remove), a
"+ Add server" button that swaps the list for the add-server form (name,
command, args, env vars, a "← Back" to return without saving).

## Error handling

- A server that fails to start (bad command, handshake rejected):
  recorded with its error message; its tools are simply never in any
  session's registry. The model never sees them — no special-casing
  needed anywhere else in the agent loop.
- A server that crashes mid-session: `client.onclose`/`onerror` flips its
  status to failed; a call already in flight rejects and is mapped to a
  normal failed `ToolResult` (see `mcpToolAdapter.ts` above) — the model
  sees a failed tool call, not a crash. New sessions started after the
  crash simply won't have that server's tools; the currently-running
  session's already-issued tool list may still name tools that now fail
  every call — an accepted, called-out tradeoff (same "config fixed at
  session start" behavior the rest of this app already has, e.g. a model
  swap needs a new session too).
- Every MCP tool call always shows the permission prompt, exactly the
  same as an existing DANGEROUS-tier call — no new UI state needed there,
  though the prompt's tool name should read clearly (the `[MCP:
  <server>]`-prefixed description handles this).

## Testing

- `mcpSettings.ts`: load/save/encrypt round-trip, malformed-file
  recovery — same style as `anthropicSettings.test.ts`.
- `mcpToolAdapter.ts`: given a fake `Client` (a plain object implementing
  just `callTool`), verify the `isError`/content-block-joining/thrown-
  rejection mappings above, and the `mcp__<server>__<tool>` naming +
  sanitization. Pure and fully testable with fakes, no real process
  involved — same style as `updateManager.test.ts`'s fake `autoUpdater`.
- `mcpClient.ts`: its actual stdio spawn+handshake is thin glue over the
  SDK. Covered with one real integration test using the SDK's own
  `InMemoryTransport.createLinkedPair()` (verified real API, in
  `src/inMemory.ts`) paired with a minimal real `McpServer` from the same
  SDK registering one trivial tool — exercises the real `Client` and real
  protocol handshake without spawning an actual subprocess, and without
  mocking the SDK's internals.
- `toolRegistry.ts`/`sessionRegistry.ts` changes: existing tests updated
  for the new `extraTools` parameter (default `[]` preserves all current
  behavior/tests unchanged).

## Out of scope

- Remote (HTTP/SSE) MCP servers — a separate follow-up.
- Per-server trust / auto-allow permission tiers.
- Auto-retry/backoff on a crashed server.
- Resources and prompts (MCP's other two primitives beyond tools) — only
  tools are wired into this app's agent loop today.
- Editing env vars' individual values after they're saved (the add form
  covers create; edit is out of scope for this spec — remove and re-add
  covers the same ground until a real need for partial-edit appears).
