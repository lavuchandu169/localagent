# MCP Client Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user configure local (stdio) MCP servers in a new "MCP Servers" panel; their tools become available to the agent, flowing through the app's existing permission-prompt machinery exactly like a built-in tool.

**Architecture:** A pure settings-storage module (`mcpSettings.ts`, mirrors `anthropicSettings.ts`), a thin SDK-wrapping connection module (`mcpClient.ts`), and a pure tool-adapter (`mcpToolAdapter.ts`) that turns a connected server's tools into this app's `Tool` interface. `main.ts` connects every enabled server once at app startup and hands the combined adapted-tool list into every new session via one new parameter on the existing `startSession`/`defaultToolRegistry` call chain. A new renderer panel (list-first, toggled add-form) manages the config.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk` (official MCP client), Electron IPC, the existing `StorageCrypto`/settings-module pattern.

**Spec:** [docs/superpowers/specs/2026-09-04-mcp-client-design.md](../specs/2026-09-04-mcp-client-design.md)

## Global Constraints

- Transport: **stdio (local process) only** — no remote/HTTP servers in this plan.
- Every MCP tool call always shows the permission prompt, in every `PermissionMode` — achieved via `permission: "DANGEROUS"` on every adapted tool. Per `src/permissions.ts`'s `evaluate()`, `DANGEROUS` already means "ASK in every non-PLAN mode, DENY in PLAN mode" with **zero changes to `permissions.ts`**.
- Servers connect **once, at app startup**, shared across every session — never per-session, never lazy-on-first-call.
- A server that crashes mid-session is marked failed and its tools drop out of *future* sessions' registries; every other server and the app itself are unaffected. No auto-retry/backoff.
- Config UX is a **dedicated "MCP Servers" panel** (opened the same way the existing About panel is) — not inline in the Settings panel, not raw JSON editing. List view by default; a "+ Add server" button swaps the list out for the add-server form; a "← Back" returns to the list without saving.
- Tool naming: `` mcp__${sanitize(serverName)}__${mcpToolName} ``, where `sanitize` lowercases and replaces every character outside `[a-z0-9_]` with `_`.
- Server `name` must be unique among saved configs — `agent:add-mcp-server` rejects a duplicate with an error string.
- **Ruling on a spec inconsistency:** the spec's Components section lists `agent:edit-mcp-server` among the new IPC handlers, but its Out-of-scope section separately says editing a saved server is out of scope ("remove and re-add covers the same ground until a real need for partial-edit appears") — and no edit UI appears anywhere in the approved panel design. This plan follows the Out-of-scope section: no `agent:edit-mcp-server` handler, no edit UI, only add/remove. Avoids shipping an IPC endpoint nothing in the app ever calls.
- Env var values are never sent to the renderer.
- Dependency: `@modelcontextprotocol/sdk` (`^1.30.0`). Its `package.json` declares `zod` as a **required peer dependency** at `^3.25 || ^4.0` — this repo currently pins `zod` at `^3.23.8` (confirmed unused by any file under `src/` today, so bumping it is zero-risk to existing code). Task 2 bumps it to `^3.25.0`.
- **File placement correction from the spec:** the spec's Components section names `src/mcpClient.ts` (top-level). This plan places it at **`src/electron/mcpClient.ts`** instead — it spawns local processes as part of Electron app startup (the same category as `updateManager.ts`, `googleAuth.ts`), and every existing top-level `src/*.ts` file today imports *only* from other top-level files, never from `src/electron/` (confirmed via repo grep) — keeping that layering intact avoids introducing the only reverse-direction dependency in the codebase. `mcpSettings.ts` (`src/electron/`) and `mcpToolAdapter.ts` (top-level `src/`, since it only depends on `types.ts` and has zero dependency on Electron or on `mcpClient.ts`) are unchanged from the spec.
- No `Co-Authored-By` trailer in any commit this plan produces — verify with `git log -1 --format="%an <%ae>"` after every commit.
- Use the project's existing `check(name, cond)`-based plain-Node test style (see any file under `src/test/`) — not a test framework; every new test file is compiled by `tsc` and run directly with `node`, then added to `package.json`'s `"test"` script chain in the same append style as every existing entry.

---

### Task 1: MCP server settings storage

**Files:**
- Create: `src/electron/mcpSettings.ts`
- Test: `src/test/mcpSettings.test.ts`
- Modify: `package.json` (append the new test file to the `"test"` script chain)

**Interfaces:**
- Produces: `McpServerConfig` (`{ id: string; name: string; command: string; args: string[]; env: Record<string, string>; enabled: boolean }`), `loadMcpSettings(settingsFilePath: string, storageCrypto?: StorageCrypto): Promise<McpServerConfig[]>`, `saveMcpSettings(settingsFilePath: string, servers: McpServerConfig[], storageCrypto?: StorageCrypto): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `src/test/mcpSettings.test.ts`:

```typescript
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { loadMcpSettings, saveMcpSettings, type McpServerConfig } from "../electron/mcpSettings.js";
import type { StorageCrypto } from "../electron/googleAuth.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

/** Not real encryption — just reversible enough to prove the plumbing actually calls encrypt on write and decrypt on read. */
const fakeStorageCrypto: StorageCrypto = {
  encrypt: (plainText) => Buffer.from(plainText, "utf-8").toString("base64"),
  decrypt: (cipherText) => Buffer.from(cipherText, "base64").toString("utf-8"),
};

const sampleServer: McpServerConfig = {
  id: "srv-1",
  name: "github",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { GITHUB_TOKEN: "fake-token" },
  enabled: true,
};

console.log("mcpSettings storage:");

async function run() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-mcp-settings-test-"));

  const missing = await loadMcpSettings(path.join(dir, "nope.json"));
  check("loading a nonexistent file returns an empty array", Array.isArray(missing) && missing.length === 0);

  const settingsFile = path.join(dir, "mcpServers.json");
  await saveMcpSettings(settingsFile, [sampleServer]);
  const loaded = await loadMcpSettings(settingsFile);
  check("saved settings round-trip through load (no crypto)", JSON.stringify(loaded) === JSON.stringify([sampleServer]));

  const cryptoFile = path.join(dir, "mcpServersCrypto.json");
  await saveMcpSettings(cryptoFile, [sampleServer], fakeStorageCrypto);
  const onDisk = await fs.readFile(cryptoFile, "utf-8");
  let onDiskIsPlainJson = true;
  try {
    JSON.parse(onDisk);
  } catch {
    onDiskIsPlainJson = false;
  }
  check("with a storageCrypto, the on-disk content is not plain JSON (it was actually transformed)", !onDiskIsPlainJson);
  const loadedWithCrypto = await loadMcpSettings(cryptoFile, fakeStorageCrypto);
  check("saved-with-crypto settings round-trip through load with the same crypto", JSON.stringify(loadedWithCrypto) === JSON.stringify([sampleServer]));
  const loadedWithoutCrypto = await loadMcpSettings(cryptoFile);
  check("an encrypted file read back without a storageCrypto returns an empty array, not a crash", loadedWithoutCrypto.length === 0);

  const corruptFile = path.join(dir, "corrupt.json");
  await fs.writeFile(corruptFile, "{not valid json", "utf-8");
  const loadedCorrupt = await loadMcpSettings(corruptFile);
  check("a corrupted file returns an empty array, not a crash", loadedCorrupt.length === 0);

  const malformedFile = path.join(dir, "malformed.json");
  await fs.writeFile(malformedFile, JSON.stringify([sampleServer, { id: "srv-2", name: "broken" /* missing command/args/env/enabled */ }]), "utf-8");
  const loadedMalformed = await loadMcpSettings(malformedFile);
  check("an entry missing required fields is dropped, valid entries are kept", loadedMalformed.length === 1 && loadedMalformed[0].id === "srv-1");

  const notAnArrayFile = path.join(dir, "not-an-array.json");
  await fs.writeFile(notAnArrayFile, JSON.stringify({ id: "srv-1" }), "utf-8");
  const loadedNotArray = await loadMcpSettings(notAnArrayFile);
  check("a top-level object instead of an array returns an empty array, not a crash", loadedNotArray.length === 0);

  await fs.rm(dir, { recursive: true, force: true });
}

await run();

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build`
Expected: FAIL — `TS2307: Cannot find module '../electron/mcpSettings.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/electron/mcpSettings.ts`:

```typescript
import fs from "node:fs/promises";
import type { StorageCrypto } from "./googleAuth.js";

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
}

function isValidConfig(value: unknown): value is McpServerConfig {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<McpServerConfig>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.command === "string" &&
    Array.isArray(v.args) &&
    v.args.every((a) => typeof a === "string") &&
    typeof v.env === "object" &&
    v.env !== null &&
    Object.values(v.env).every((e) => typeof e === "string") &&
    typeof v.enabled === "boolean"
  );
}

export async function loadMcpSettings(settingsFilePath: string, storageCrypto?: StorageCrypto): Promise<McpServerConfig[]> {
  try {
    const raw = await fs.readFile(settingsFilePath, "utf-8");
    const json = storageCrypto ? storageCrypto.decrypt(raw) : raw;
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidConfig);
  } catch {
    return [];
  }
}

export async function saveMcpSettings(settingsFilePath: string, servers: McpServerConfig[], storageCrypto?: StorageCrypto): Promise<void> {
  const json = JSON.stringify(servers, null, 2);
  const toWrite = storageCrypto ? storageCrypto.encrypt(json) : json;
  await fs.writeFile(settingsFilePath, toWrite, { encoding: "utf-8", mode: 0o600 });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node dist/test/mcpSettings.test.js`
Expected: every `check(...)` line prints `ok`, then `All tests passed.`, exit code 0.

- [ ] **Step 5: Wire into the test script and commit**

In `package.json`, append `&& node dist/test/mcpSettings.test.js` to the end of the existing `"test"` script's chain (immediately after the last entry, `node dist/test/anthropicPricing.test.js`).

```bash
npm run build && npm test
git add src/electron/mcpSettings.ts src/test/mcpSettings.test.ts package.json
git commit -m "feat: add MCP server settings storage"
```

---

### Task 2: MCP dependency + pure tool adapter

**Files:**
- Modify: `package.json` (add `@modelcontextprotocol/sdk`, bump `zod`)
- Create: `src/mcpToolAdapter.ts`
- Test: `src/test/mcpToolAdapter.test.ts`
- Modify: `package.json` (append the new test file to the `"test"` script chain)

**Interfaces:**
- Consumes: `Tool`, `ToolContext`, `ToolResult` from `src/types.ts` (existing).
- Produces: `sanitizeMcpServerName(name: string): string`, `McpToolCaller` (`{ callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<{ content: { type: string; text?: string }[]; isError?: boolean }> }`), `adaptMcpTools(serverName: string, caller: McpToolCaller, mcpTools: { name: string; description?: string; inputSchema: Record<string, unknown> }[]): Tool[]`.

- [ ] **Step 1: Add and install the dependency**

In `package.json`'s `"dependencies"`, add `"@modelcontextprotocol/sdk": "^1.30.0"` (alphabetically after `@fontsource/source-serif-4`, before `diff`) and change `"zod": "^3.23.8"` to `"zod": "^3.25.0"` (required — the SDK's own `package.json` declares `zod` as a required peer dependency at `^3.25 || ^4.0`; `zod` is confirmed unused directly by any file under `src/` today, so this bump is zero-risk to existing code).

```bash
npm install
```

Expected: installs cleanly, no `ERESOLVE`/peer-dependency error. If one appears, it means the pinned SDK or zod version has since changed incompatibly — check `npm view @modelcontextprotocol/sdk peerDependencies` for the current real requirement and adjust the `zod` bump to match before continuing.

- [ ] **Step 2: Write the failing test**

Create `src/test/mcpToolAdapter.test.ts`:

```typescript
import { adaptMcpTools, sanitizeMcpServerName, type McpToolCaller } from "../mcpToolAdapter.js";
import type { ToolContext } from "../types.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

const fakeCtx: ToolContext = { workspaceRoot: "/tmp/fake", log: () => {} };

console.log("sanitizeMcpServerName:");
check("lowercases", sanitizeMcpServerName("GitHub") === "github");
check("replaces spaces and symbols with underscores", sanitizeMcpServerName("my server! v2") === "my_server__v2");
check("leaves already-safe names unchanged", sanitizeMcpServerName("postgres_1") === "postgres_1");

console.log("\nadaptMcpTools:");

function makeCaller(handler: McpToolCaller["callTool"]): McpToolCaller {
  return { callTool: handler };
}

await (async () => {
  {
    const caller = makeCaller(async () => ({ content: [{ type: "text", text: "pong" }] }));
    const [tool] = adaptMcpTools("GitHub", caller, [{ name: "ping", description: "Replies with pong", inputSchema: { type: "object", properties: {} } }]);
    check("tool name is mcp__<sanitized server>__<tool name>", tool.name === "mcp__github__ping");
    check("description is prefixed with the server name", tool.description.startsWith("[MCP: GitHub] "));
    check("description includes the MCP tool's own description", tool.description.includes("Replies with pong"));
    check("permission is always DANGEROUS", tool.permission === "DANGEROUS");
    check("inputSchema passes through unmodified", JSON.stringify(tool.inputSchema) === JSON.stringify({ type: "object", properties: {} }));

    const result = await tool.execute({}, fakeCtx);
    check("a successful call maps to ok:true with joined text content", result.ok === true && (result.output as { content: string }).content === "pong");
  }

  {
    const caller = makeCaller(async () => ({ content: [{ type: "text", text: "not found" }], isError: true }));
    const [tool] = adaptMcpTools("github", caller, [{ name: "search", inputSchema: { type: "object" } }]);
    const result = await tool.execute({ q: "x" }, fakeCtx);
    check("isError:true maps to ok:false with the joined text as the error", result.ok === false && result.error === "not found");
  }

  {
    const caller = makeCaller(async () => {
      throw new Error("connection reset");
    });
    const [tool] = adaptMcpTools("github", caller, [{ name: "search", inputSchema: { type: "object" } }]);
    const result = await tool.execute({}, fakeCtx);
    check("a thrown/rejected callTool maps to ok:false with the error's message", result.ok === false && result.error === "connection reset");
  }

  {
    const caller = makeCaller(async () => ({ content: [{ type: "image", text: undefined }, { type: "text", text: "here's the diagram" }] }));
    const [tool] = adaptMcpTools("github", caller, [{ name: "screenshot", inputSchema: { type: "object" } }]);
    const result = await tool.execute({}, fakeCtx);
    check(
      "a non-text content block is summarized as omitted, joined with any real text",
      result.ok === true && (result.output as { content: string }).content === "[image content omitted]\nhere's the diagram"
    );
  }

  {
    const caller = makeCaller(async () => ({ content: [] }));
    const [toolA, toolB] = adaptMcpTools("github", caller, [
      { name: "toolA", inputSchema: { type: "object" } },
      { name: "toolB", inputSchema: { type: "object" } },
    ]);
    check("adaptMcpTools produces one Tool per listed MCP tool, in order", toolA.name === "mcp__github__toola" && toolB.name === "mcp__github__toolb");
  }
})();

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run build`
Expected: FAIL — `TS2307: Cannot find module '../mcpToolAdapter.js'`

- [ ] **Step 4: Write minimal implementation**

Create `src/mcpToolAdapter.ts`:

```typescript
import type { Tool, ToolContext, ToolResult } from "./types.js";

/** The narrow slice of the MCP SDK's Client this module actually needs — kept structural (not `import type { Client } from "@modelcontextprotocol/sdk/..."`) so a test fake can implement it trivially, same reasoning as this app's other injected-dependency interfaces (e.g. UpdateManagerDeps.openPath). */
export interface McpToolCaller {
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<{
    content: { type: string; text?: string }[];
    isError?: boolean;
  }>;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** Lowercases and replaces every character outside [a-z0-9_] with `_` — used to build each tool's mcp__<name>__<tool> prefix. Server names are already validated unique at save time (mcpSettings.ts's callers), so no collision handling is needed here. */
export function sanitizeMcpServerName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

function joinTextBlocks(content: { type: string; text?: string }[]): string {
  return content.map((block) => (block.type === "text" ? (block.text ?? "") : `[${block.type} content omitted]`)).join("\n");
}

/**
 * Wraps every tool listed by one connected MCP server into this app's Tool
 * interface. Every produced tool is permission: "DANGEROUS" — per
 * permissions.ts's evaluate(), that already means "always ASK, PLAN mode
 * denies outright" in every mode, with zero changes to the permission
 * engine — an MCP tool's real behavior isn't knowable in advance, so it
 * can't honestly claim any lighter permission tier.
 */
export function adaptMcpTools(serverName: string, caller: McpToolCaller, mcpTools: McpToolDescriptor[]): Tool[] {
  const prefix = sanitizeMcpServerName(serverName);
  return mcpTools.map((mcpTool) => ({
    name: `mcp__${prefix}__${mcpTool.name}`,
    description: `[MCP: ${serverName}] ${mcpTool.description ?? mcpTool.name}`,
    permission: "DANGEROUS" as const,
    inputSchema: mcpTool.inputSchema,
    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      ctx.log(`[MCP] Calling ${mcpTool.name} on ${serverName}`);
      let result: { content: { type: string; text?: string }[]; isError?: boolean };
      try {
        result = await caller.callTool({ name: mcpTool.name, arguments: input });
      } catch (err) {
        return { ok: false, output: null, error: err instanceof Error ? err.message : String(err) };
      }
      const text = joinTextBlocks(result.content);
      if (result.isError) {
        return { ok: false, output: null, error: text || "MCP tool call failed with no error message." };
      }
      return { ok: true, output: { content: text } };
    },
  }));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run build && node dist/test/mcpToolAdapter.test.js`
Expected: every `check(...)` line prints `ok`, then `All tests passed.`, exit code 0.

- [ ] **Step 6: Wire into the test script and commit**

In `package.json`, append `&& node dist/test/mcpToolAdapter.test.js` to the `"test"` script chain.

```bash
npm run build && npm test
git add package.json package-lock.json src/mcpToolAdapter.ts src/test/mcpToolAdapter.test.ts
git commit -m "feat: add MCP tool adapter, wrapping MCP tools as this app's Tool interface"
```

---

### Task 3: MCP client connection wrapper

**Files:**
- Create: `src/electron/mcpClient.ts`
- Test: `src/test/mcpClient.test.ts`
- Modify: `package.json` (append the new test file to the `"test"` script chain)

**Interfaces:**
- Consumes: `McpServerConfig` from `src/electron/mcpSettings.ts` (Task 1); `@modelcontextprotocol/sdk`'s `Client`, `StdioClientTransport`, `getDefaultEnvironment` (from `@modelcontextprotocol/sdk/client/stdio.js`), and `Transport` (from `@modelcontextprotocol/sdk/shared/transport.js`).
- Produces: `McpServerStatus` (`{ state: "connecting" } | { state: "connected"; toolCount: number } | { state: "failed"; error: string }`), `McpConnection` (`{ config: McpServerConfig; status: McpServerStatus; client: Client | undefined; tools: McpToolDescriptor[] }`), `connectMcpServer(config: McpServerConfig, onStatusChange: (status: McpServerStatus) => void, deps?: { createTransport?: () => Transport }): Promise<McpConnection>`, `disconnectMcpServer(connection: McpConnection): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `src/test/mcpClient.test.ts`:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { connectMcpServer, disconnectMcpServer, type McpServerStatus } from "../electron/mcpClient.js";
import type { McpServerConfig } from "../electron/mcpSettings.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

function makeConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return { id: "srv-1", name: "test-server", command: "unused-in-these-tests", args: [], env: {}, enabled: true, ...overrides };
}

/** A real in-process MCP server (the SDK's own McpServer, not a fake) with one trivial tool — paired with the client side of InMemoryTransport.createLinkedPair() so connectMcpServer exercises the real SDK handshake with no subprocess spawned. */
async function startTestServer(): Promise<Transport> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  server.registerTool("ping", { description: "Replies with pong" }, async () => ({ content: [{ type: "text" as const, text: "pong" }] }));
  await server.connect(serverTransport);
  return clientTransport;
}

console.log("connectMcpServer:");

await (async () => {
  {
    const statuses: McpServerStatus[] = [];
    const clientTransport = await startTestServer();
    const connection = await connectMcpServer(makeConfig(), (s) => statuses.push(s), { createTransport: () => clientTransport });
    check("resolves with status connected and the real tool count", connection.status.state === "connected" && (connection.status as { toolCount: number }).toolCount === 1);
    check("carries the real client", connection.client !== undefined);
    check("carries the real listed tool", connection.tools.length === 1 && connection.tools[0].name === "ping");
    check("onStatusChange was called with connecting, then connected", statuses.length === 2 && statuses[0].state === "connecting" && statuses[1].state === "connected");
    await disconnectMcpServer(connection);
  }

  {
    const statuses: McpServerStatus[] = [];
    const failingTransport: Transport = {
      start: async () => {
        throw new Error("spawn failed: command not found");
      },
      send: async () => {},
      close: async () => {},
    };
    const connection = await connectMcpServer(makeConfig({ name: "broken-server" }), (s) => statuses.push(s), { createTransport: () => failingTransport });
    check("a failing transport resolves with status failed, never throws", connection.status.state === "failed" && (connection.status as { error: string }).error.includes("spawn failed"));
    check("client is undefined on failure", connection.client === undefined);
    check("tools is empty on failure", connection.tools.length === 0);
    check("onStatusChange's last call reports failed", statuses[statuses.length - 1].state === "failed");
  }

  {
    const statuses: McpServerStatus[] = [];
    const clientTransport = await startTestServer();
    const connection = await connectMcpServer(makeConfig(), (s) => statuses.push(s), { createTransport: () => clientTransport });
    const statusesBeforeClose = statuses.length;
    // Simulates the real child process exiting mid-session — the transport
    // closing is exactly what a crashed subprocess's stdio pipes closing
    // looks like to the SDK.
    await connection.client!.close();
    check("closing the connection mid-session fires onStatusChange again with failed", statuses.length > statusesBeforeClose && statuses[statuses.length - 1].state === "failed");
  }
})();

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build`
Expected: FAIL — `TS2307: Cannot find module '../electron/mcpClient.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/electron/mcpClient.ts`:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "./mcpSettings.js";
import type { McpToolDescriptor } from "../mcpToolAdapter.js";

export type McpServerStatus = { state: "connecting" } | { state: "connected"; toolCount: number } | { state: "failed"; error: string };

export interface McpConnection {
  config: McpServerConfig;
  status: McpServerStatus;
  /** The live SDK Client, only while status is "connected" — undefined otherwise, so a caller can never accidentally call a tool on a dead connection. */
  client: Client | undefined;
  tools: McpToolDescriptor[];
}

const CLIENT_INFO = { name: "localagent-mcp-client", version: "1.0.0" };

/**
 * Connects to one configured MCP server. Never throws — a failure at any
 * stage (spawn, handshake, tool listing) resolves to a "failed" status
 * instead, matching this app's established "background work degrades,
 * never throws at the caller" posture (auto-updater, cloud sync).
 * `deps.createTransport` is only for tests — production callers always
 * get the real StdioClientTransport.
 */
export async function connectMcpServer(
  config: McpServerConfig,
  onStatusChange: (status: McpServerStatus) => void,
  deps: { createTransport?: () => Transport } = {}
): Promise<McpConnection> {
  onStatusChange({ state: "connecting" });

  const transport =
    deps.createTransport?.() ??
    new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...getDefaultEnvironment(), ...config.env },
    });

  // No special capabilities declared — this client only ever calls tools.
  const client = new Client(CLIENT_INFO);
  client.onclose = () => onStatusChange({ state: "failed", error: `${config.name} disconnected unexpectedly.` });
  client.onerror = (err) => onStatusChange({ state: "failed", error: err.message });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const status: McpServerStatus = { state: "connected", toolCount: listed.tools.length };
    onStatusChange(status);
    return { config, status, client, tools: listed.tools };
  } catch (err) {
    const status: McpServerStatus = { state: "failed", error: err instanceof Error ? err.message : String(err) };
    onStatusChange(status);
    return { config, status, client: undefined, tools: [] };
  }
}

export async function disconnectMcpServer(connection: McpConnection): Promise<void> {
  if (!connection.client) return;
  await connection.client.close().catch(() => {});
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node dist/test/mcpClient.test.js`
Expected: every `check(...)` line prints `ok`, then `All tests passed.`, exit code 0. If the third test block ("closing the connection mid-session fires onStatusChange again with failed") fails because `client.onclose` isn't invoked the way expected, inspect the installed SDK's real `Protocol.connect()`/`Protocol._onclose` behavior (`node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js`) and adjust the assertion or the wiring in `mcpClient.ts` to match its real, verified behavior — never weaken the test to something that no longer proves the crash-detection path works.

- [ ] **Step 5: Wire into the test script and commit**

In `package.json`, append `&& node dist/test/mcpClient.test.js` to the `"test"` script chain.

```bash
npm run build && npm test
git add package.json src/electron/mcpClient.ts src/test/mcpClient.test.ts
git commit -m "feat: add MCP server connection wrapper over the MCP SDK client"
```

---

### Task 4: Wire MCP tools into the tool registry and session startup

**Files:**
- Modify: `src/toolRegistry.ts`
- Test: `src/test/toolRegistry.test.ts` (new)
- Modify: `src/providers/mockProvider.ts`
- Modify: `src/electron/sessionRegistry.ts`
- Modify: `src/test/sessionRegistry.test.ts`
- Modify: `package.json` (append the new test file to the `"test"` script chain)

**Interfaces:**
- Consumes: `Tool` from `src/types.ts`; `defaultToolRegistry` (existing, being extended).
- Produces: `defaultToolRegistry(extraTools?: Tool[]): ToolRegistry` (extended signature); `startSession`'s `deps` gains `extraTools?: Tool[]` (existing function, being extended — every other existing caller/test is unaffected since it's optional and defaults to `[]`).

- [ ] **Step 1: Write the failing test for `defaultToolRegistry`**

Create `src/test/toolRegistry.test.ts`:

```typescript
import { defaultToolRegistry } from "../toolRegistry.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

const fakeTool: Tool = {
  name: "mcp__github__ping",
  description: "[MCP: github] Replies with pong",
  permission: "DANGEROUS",
  inputSchema: { type: "object", properties: {} },
  async execute(): Promise<ToolResult> {
    return { ok: true, output: { content: "pong" } };
  },
};

console.log("defaultToolRegistry:");

const withoutExtras = defaultToolRegistry();
check("with no extraTools, only the 5 built-in tools are registered", withoutExtras.availableTools().length === 5);
check("with no extraTools, an unregistered tool name is undefined", withoutExtras.get("mcp__github__ping") === undefined);

const withExtras = defaultToolRegistry([fakeTool]);
check("with extraTools, the built-ins are still all present", withExtras.availableTools().length === 6);
check("with extraTools, the extra tool is retrievable by name", withExtras.get("mcp__github__ping") === fakeTool);
check("with extraTools, a built-in tool is still retrievable by name", withExtras.get("read_file") !== undefined);

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node dist/test/toolRegistry.test.js`
Expected: FAIL — `defaultToolRegistry([fakeTool])` is a type error (`Expected 0 arguments, but got 1`) until Step 3.

- [ ] **Step 3: Implement `defaultToolRegistry`'s new parameter**

In `src/toolRegistry.ts`, replace:

```typescript
export function defaultToolRegistry(): ToolRegistry {
  return new ToolRegistry([readFileTool, listDirectoryTool, grepTool, editFileTool, runCommandTool]);
}
```

with:

```typescript
export function defaultToolRegistry(extraTools: Tool[] = []): ToolRegistry {
  return new ToolRegistry([readFileTool, listDirectoryTool, grepTool, editFileTool, runCommandTool, ...extraTools]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node dist/test/toolRegistry.test.js`
Expected: every `check(...)` line prints `ok`, then `All tests passed.`, exit code 0.

- [ ] **Step 5: Add request-capturing to MockProvider**

This is needed by Step 6's `sessionRegistry` test, to prove `extraTools` really reaches the model's tool list end-to-end, not just that `defaultToolRegistry` itself merges arrays correctly.

In `src/providers/mockProvider.ts`, replace:

```typescript
export class MockProvider implements ModelProvider {
  id = "mock";
  private step = 0;
  constructor(private script: ChatResponse[]) {}

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "mock-model", local: true }];
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async chat(_request: ChatRequest): Promise<ChatResponse> {
    const response = this.script[this.step];
    if (!response) {
      return { turn: { type: "final", content: "(mock provider script exhausted)" } };
    }
    this.step++;
    return response;
  }
}
```

with:

```typescript
export class MockProvider implements ModelProvider {
  id = "mock";
  private step = 0;
  /** Every request this provider has received, in order — lets a test verify what was actually sent (e.g. which tools were offered), not just what came back. */
  receivedRequests: ChatRequest[] = [];
  constructor(private script: ChatResponse[]) {}

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "mock-model", local: true }];
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.receivedRequests.push(request);
    const response = this.script[this.step];
    if (!response) {
      return { turn: { type: "final", content: "(mock provider script exhausted)" } };
    }
    this.step++;
    return response;
  }
}
```

(No existing test inspects `chat`'s parameter or `receivedRequests`, so every current `MockProvider` usage is unaffected.)

- [ ] **Step 6: Write the failing test for `startSession`'s `extraTools`**

In `src/test/sessionRegistry.test.ts`, find the first test block (the one checking `"startSession returns a sessionId and registers it"`, using `MockProvider([])`) and add a new block immediately after it:

```typescript
  {
    const registry = createSessionRegistry(sessionsDir);
    const extraTool = {
      name: "mcp__github__ping",
      description: "[MCP: github] Replies with pong",
      permission: "DANGEROUS" as const,
      inputSchema: { type: "object", properties: {} },
      async execute() {
        return { ok: true, output: { content: "pong" } };
      },
    };
    const provider = new MockProvider([{ turn: { type: "final", content: "done" } }]);
    await startSession(
      registry,
      { workspaceRoot, provider: { kind: "embedded", size: "qwen-coder-1.5b" }, mode: "PLAN" },
      { providerFactory: () => provider, extraTools: [extraTool] }
    );
    const { runTask } = await import("../electron/sessionRegistry.js");
    const sessionId = [...registry.sessions.keys()][0];
    await runTask(registry, sessionId, "anything", () => {});
    const toolNames = provider.receivedRequests[0]?.tools?.map((t) => t.name) ?? [];
    check("extraTools passed to startSession reach the model's tool list", toolNames.includes("mcp__github__ping"));
  }
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npm run build`
Expected: FAIL — `TS2353: Object literal may only specify known properties, and 'extraTools' does not exist in type` on the `startSession` call's `deps` argument.

- [ ] **Step 8: Implement `extraTools` in `startSession`**

In `src/electron/sessionRegistry.ts`, in `startSession`'s `deps` parameter type (around line 98-104), add one field:

```typescript
  deps: {
    providerFactory?: (c: ProviderConfig, onDownloadProgress?: (status: ModelDownloadProgress) => void, signal?: AbortSignal) => ModelProvider;
    onDownloadProgress?: (status: ModelDownloadProgress) => void;
    /** Lets the caller cancel an in-progress embedded-model download — see buildProvider. */
    signal?: AbortSignal;
    resume?: ResumePayload;
    /** Currently-connected MCP servers' tools, supplied by main.ts — see mcpClient.ts/mcpToolAdapter.ts. Defaults to none, so every existing caller/test is unaffected. */
    extraTools?: Tool[];
  } = {}
```

Add `Tool` to the existing `import type { ... } from "../types.js";` line at the top of the file.

Then change the `tools: defaultToolRegistry(),` line (inside the `new AgentSession({...})` call) to:

```typescript
    tools: defaultToolRegistry(deps.extraTools ?? []),
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npm run build && npm test`
Expected: every `check(...)` line across the whole suite prints `ok` (including the new one), then `All tests passed.`, exit code 0.

- [ ] **Step 10: Wire into the test script and commit**

In `package.json`, append `&& node dist/test/toolRegistry.test.js` to the `"test"` script chain.

```bash
npm run build && npm test
git add package.json src/toolRegistry.ts src/test/toolRegistry.test.ts src/providers/mockProvider.ts src/electron/sessionRegistry.ts src/test/sessionRegistry.test.ts
git commit -m "feat: let startSession accept extra tools, for MCP-provided tools"
```

---

### Task 5: Connect servers at app startup and expose them over IPC

**Files:**
- Modify: `src/electron/main.ts`
- Modify: `src/electron/preload.cjs`

This task is Electron-app orchestration glue (spawning real processes, wiring real IPC) — the same category as the auto-updater's `main.ts` wiring earlier this project, which also has no dedicated automated test of `main.ts` itself (the pure logic underneath it — here, `mcpSettings.ts`/`mcpClient.ts`/`mcpToolAdapter.ts` — already has full coverage from Tasks 1-3). Verification for this task is a manual/live check, folded into Task 6's live UI verification once the panel exists to observe it through.

**Interfaces:**
- Consumes: `loadMcpSettings`, `saveMcpSettings`, `McpServerConfig` (Task 1); `connectMcpServer`, `disconnectMcpServer`, `McpConnection`, `McpServerStatus` (Task 3); `adaptMcpTools` (Task 2); `startSession`'s new `extraTools` (Task 4).
- Produces: IPC handlers `agent:list-mcp-servers`, `agent:add-mcp-server`, `agent:remove-mcp-server`; broadcast `agent:mcp-server-status-changed`; preload bridge methods `listMcpServers`, `addMcpServer`, `removeMcpServer`, `onMcpServerStatusChanged`.

- [ ] **Step 1: Add imports and the settings file path**

In `src/electron/main.ts`, add to the existing imports:

```typescript
import { loadMcpSettings, saveMcpSettings, type McpServerConfig } from "./mcpSettings.js";
import { connectMcpServer, disconnectMcpServer, type McpConnection, type McpServerStatus } from "./mcpClient.js";
import { adaptMcpTools, type McpToolCaller } from "../mcpToolAdapter.js";
import crypto from "node:crypto";
```

(`crypto` may already be imported elsewhere in the file for session ids — check first and only add if it's not already present.)

Next to the existing `const anthropicSettingsFilePath = path.join(app.getPath("userData"), "anthropicSettings.json");` line, add:

```typescript
  const mcpSettingsFilePath = path.join(app.getPath("userData"), "mcpServers.json");
```

- [ ] **Step 2: Connect every enabled server at startup**

Inside `app.whenReady().then(() => { ... })`, near the existing `autoUpdater`/`updateManager` block, add:

```typescript
  let mcpConnections: McpConnection[] = [];

  function currentMcpTools() {
    return mcpConnections
      .filter((c) => c.status.state === "connected" && c.client)
      .flatMap((c) => {
        // adaptMcpTools's McpToolCaller is deliberately narrower than the SDK's
        // real Client.callTool (whose return type also covers task-based tool
        // results, {toolResult: unknown} — a feature this app doesn't use).
        // This one-line wrapper is the single place that narrowing happens,
        // rather than widening McpToolCaller itself and making every adapter
        // consumer handle a shape it never actually receives.
        const caller = { callTool: (params: { name: string; arguments: Record<string, unknown> }) => c.client!.callTool(params) as ReturnType<McpToolCaller["callTool"]> };
        return adaptMcpTools(c.config.name, caller, c.tools);
      });
  }

  async function connectAndTrack(config: McpServerConfig): Promise<McpConnection> {
    const connection = await connectMcpServer(config, (status: McpServerStatus) => {
      const existing = mcpConnections.find((c) => c.config.id === config.id);
      if (existing) existing.status = status;
      broadcastToAllWindows("agent:mcp-server-status-changed", { id: config.id, status });
    });
    mcpConnections = mcpConnections.filter((c) => c.config.id !== config.id).concat(connection);
    return connection;
  }

  // Connects in dev runs too, unlike the packaged-only autoUpdater — there's
  // no reason to gate this, and testing MCP servers from source is exactly
  // when a developer most needs it to actually run.
  const mcpConfigs = await loadMcpSettings(mcpSettingsFilePath, storageCrypto);
  await Promise.all(mcpConfigs.filter((c) => c.enabled).map(connectAndTrack));
```

- [ ] **Step 3: Add the IPC handlers**

Near the existing `ipcMain.handle("agent:install-update", ...)` block, add:

```typescript
  ipcMain.handle("agent:list-mcp-servers", () => {
    return mcpConnections.map((c) => ({
      id: c.config.id,
      name: c.config.name,
      command: c.config.command,
      args: c.config.args,
      status: c.status,
    }));
  });

  ipcMain.handle("agent:add-mcp-server", async (_event, input: { name: string; command: string; args: string[]; env: Record<string, string> }) => {
    const existingConfigs = await loadMcpSettings(mcpSettingsFilePath, storageCrypto);
    if (existingConfigs.some((c) => c.name === input.name)) {
      throw new Error(`A server named "${input.name}" already exists.`);
    }
    const config: McpServerConfig = { id: crypto.randomUUID(), name: input.name, command: input.command, args: input.args, env: input.env, enabled: true };
    await saveMcpSettings(mcpSettingsFilePath, [...existingConfigs, config], storageCrypto);
    const connection = await connectAndTrack(config);
    return { id: config.id, name: config.name, command: config.command, args: config.args, status: connection.status };
  });

  ipcMain.handle("agent:remove-mcp-server", async (_event, id: string) => {
    const oldConnection = mcpConnections.find((c) => c.config.id === id);
    if (oldConnection) await disconnectMcpServer(oldConnection);
    mcpConnections = mcpConnections.filter((c) => c.config.id !== id);
    const existingConfigs = await loadMcpSettings(mcpSettingsFilePath, storageCrypto);
    await saveMcpSettings(mcpSettingsFilePath, existingConfigs.filter((c) => c.id !== id), storageCrypto);
  });
```

- [ ] **Step 4: Pass MCP tools into every new session**

Find the existing `return await startSession(registry, resolvedConfig, { onDownloadProgress: ..., signal: controller.signal, resume, });` call (inside the `agent:start-session` handler) and add one field:

```typescript
      return await startSession(registry, resolvedConfig, {
        onDownloadProgress: (status) => event.sender.send("agent:model-progress", status),
        signal: controller.signal,
        resume,
        extraTools: currentMcpTools(),
      });
```

- [ ] **Step 5: Add the preload bridge**

In `src/electron/preload.cjs`, immediately after the existing `openUpdateFile: () => ipcRenderer.invoke("agent:open-update-file"),` line, add:

```javascript
  listMcpServers: () => ipcRenderer.invoke("agent:list-mcp-servers"),
  addMcpServer: (input) => ipcRenderer.invoke("agent:add-mcp-server", input),
  removeMcpServer: (id) => ipcRenderer.invoke("agent:remove-mcp-server", id),
  onMcpServerStatusChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("agent:mcp-server-status-changed", listener);
    return () => ipcRenderer.removeListener("agent:mcp-server-status-changed", listener);
  },
```

- [ ] **Step 6: Build and run the full test suite**

Run: `npm run build && npm test`
Expected: builds clean, every existing test still prints `ok`/`All tests passed.`, exit code 0. (No new automated tests in this task — see this task's header note.)

- [ ] **Step 7: Commit**

```bash
git add src/electron/main.ts src/electron/preload.cjs
git commit -m "feat: connect configured MCP servers at startup, expose them over IPC"
```

---

### Task 6: MCP Servers panel (renderer)

**Files:**
- Modify: `src/electron/renderer/index.html`
- Modify: `src/electron/renderer/renderer.ts`
- Modify: `src/electron/renderer/styles.css`

This is renderer-only UI code, which — matching this app's established pattern (e.g. the auto-update fallback banner) — has no automated test coverage; verification is a live check against the real running app via Chrome DevTools Protocol (the same technique used for the update-fallback banner: an isolated `--user-data-dir`, `Runtime.evaluate`/`Page.captureScreenshot` over the real WebSocket debugger, real `.click()` dispatch, then teardown), confirming the panel opens, the list renders, the add-form toggles, save/error states work, and a saved server round-trips through `agent:list-mcp-servers`.

**Interfaces:**
- Consumes: `listMcpServers`, `addMcpServer`, `removeMcpServer`, `onMcpServerStatusChanged` (Task 5's preload bridge).

- [ ] **Step 1: Add the activity-bar icon and panel markup**

In `src/electron/renderer/index.html`, in `<nav id="activity-bar">`, immediately after the existing `about-toggle` button, add:

```html
        <button id="mcp-servers-toggle" class="activity-icon" aria-expanded="false" aria-haspopup="true" title="MCP Servers" aria-label="MCP Servers">🔌</button>
```

Immediately after the existing `<div id="about-panel" hidden>...</div>` block, add the new panel — list view and add-form view both present in the markup, toggled via `hidden` (matching the approved design: list first, "+ Add server" swaps in the form, "← Back" returns):

```html
        <div id="mcp-servers-panel" hidden>
          <h2>MCP Servers</h2>
          <p class="hint-text">Give the agent tools from local MCP servers. Every call still asks for your approval, like a run_command call.</p>

          <div id="mcp-servers-list-view">
            <div id="mcp-servers-list"></div>
            <div id="mcp-servers-empty" class="hint-text">No MCP servers configured yet.</div>
            <button id="mcp-servers-add-toggle" type="button">+ Add server</button>
          </div>

          <div id="mcp-servers-form-view" hidden>
            <button id="mcp-servers-form-back" type="button">&larr; Back</button>
            <label>
              Name
              <input id="mcp-server-name" type="text" placeholder="github" />
            </label>
            <label>
              Command
              <input id="mcp-server-command" type="text" placeholder="npx" />
            </label>
            <label>
              Args <span class="hint-text">(space-separated)</span>
              <input id="mcp-server-args" type="text" placeholder="-y @modelcontextprotocol/server-github" />
            </label>
            <label>
              Env vars <span class="hint-text">(one KEY=value per line)</span>
              <textarea id="mcp-server-env" rows="3" placeholder="GITHUB_TOKEN=..."></textarea>
            </label>
            <div id="mcp-server-form-error" class="error-text"></div>
            <button id="mcp-server-form-save" type="button" class="primary">Save</button>
          </div>

          <button id="mcp-servers-close" type="button">Close</button>
        </div>
```

- [ ] **Step 2: Add styles**

In `src/electron/renderer/styles.css`, find the existing rule (around line 530):

```css
#about-panel,
#settings-panel {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  font-size: 12px;
  color: var(--text-dim);
  flex-shrink: 0;
  overflow-y: auto;
  font-family: var(--font-sans);
}
```

and add `#mcp-servers-panel` to its selector list, matching this codebase's established pattern for visually-identical sibling panels (e.g. `updateManager`'s fallback button reusing `#update-banner-restart`'s rule):

```css
#about-panel,
#settings-panel,
#mcp-servers-panel {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  font-size: 12px;
  color: var(--text-dim);
  flex-shrink: 0;
  overflow-y: auto;
  font-family: var(--font-sans);
}
```

Also find `#about-panel p, #settings-panel p { ... }` (around line 642) and add `#mcp-servers-panel p` to that selector list the same way, so the panel's `<p class="hint-text">` renders with the same spacing/color as every other panel's body text.

Then add the new rules this panel needs beyond what it now shares with `#about-panel`/`#settings-panel`:

```css
.mcp-server-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  margin-bottom: 4px;
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 12px;
}

.mcp-server-row .mcp-server-status-dot {
  font-size: 10px;
}

.mcp-server-row .mcp-server-name {
  font-weight: 600;
  flex: 1;
}

.mcp-server-row .mcp-server-detail {
  color: var(--text-dim);
}
```

- [ ] **Step 3: Wire up the panel in `renderer.ts`**

In `src/electron/renderer/renderer.ts`, add to the `AgentBridge` interface (near the existing `openUpdateFile(): Promise<void>;` line):

```typescript
  listMcpServers(): Promise<{ id: string; name: string; command: string; args: string[]; status: McpServerStatus }[]>;
  addMcpServer(input: { name: string; command: string; args: string[]; env: Record<string, string> }): Promise<{ id: string; name: string; command: string; args: string[]; status: McpServerStatus }>;
  removeMcpServer(id: string): Promise<void>;
  onMcpServerStatusChanged(callback: (payload: { id: string; status: McpServerStatus }) => void): () => void;
```

Add the type it references, near the top of the file alongside the other imported/declared shared types:

```typescript
type McpServerStatus = { state: "connecting" } | { state: "connected"; toolCount: number } | { state: "failed"; error: string };
type McpServerView = { id: string; name: string; command: string; args: string[]; status: McpServerStatus };
```

Add `byId` lookups near the existing `aboutToggle`/`aboutPanel`/`aboutClose` declarations:

```typescript
const mcpServersToggle = byId<HTMLButtonElement>("mcp-servers-toggle");
const mcpServersPanel = byId<HTMLDivElement>("mcp-servers-panel");
const mcpServersListView = byId<HTMLDivElement>("mcp-servers-list-view");
const mcpServersList = byId<HTMLDivElement>("mcp-servers-list");
const mcpServersEmpty = byId<HTMLDivElement>("mcp-servers-empty");
const mcpServersAddToggle = byId<HTMLButtonElement>("mcp-servers-add-toggle");
const mcpServersFormView = byId<HTMLDivElement>("mcp-servers-form-view");
const mcpServersFormBack = byId<HTMLButtonElement>("mcp-servers-form-back");
const mcpServerNameInput = byId<HTMLInputElement>("mcp-server-name");
const mcpServerCommandInput = byId<HTMLInputElement>("mcp-server-command");
const mcpServerArgsInput = byId<HTMLInputElement>("mcp-server-args");
const mcpServerEnvInput = byId<HTMLTextAreaElement>("mcp-server-env");
const mcpServerFormError = byId<HTMLDivElement>("mcp-server-form-error");
const mcpServerFormSave = byId<HTMLButtonElement>("mcp-server-form-save");
const mcpServersClose = byId<HTMLButtonElement>("mcp-servers-close");
```

Add the panel logic (near the existing `aboutToggle`/`closeAboutPanel` wiring, following that exact open/close/focus pattern):

```typescript
function closeMcpServersPanel() {
  mcpServersPanel.hidden = true;
  mcpServersToggle.setAttribute("aria-expanded", "false");
  mcpServersToggle.focus();
}

function showMcpServersListView() {
  mcpServersFormView.hidden = true;
  mcpServersListView.hidden = false;
  mcpServerFormError.textContent = "";
}

function renderMcpServerRow(server: McpServerView): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "mcp-server-row";
  const dot = server.status.state === "connected" ? "🟢" : server.status.state === "connecting" ? "🟡" : "🔴";
  const detail =
    server.status.state === "connected"
      ? `${server.status.toolCount} tool${server.status.toolCount === 1 ? "" : "s"} available`
      : server.status.state === "connecting"
        ? "Connecting…"
        : server.status.error;
  row.innerHTML = `
    <span class="mcp-server-status-dot">${dot}</span>
    <span class="mcp-server-name">${server.name}</span>
    <span class="mcp-server-detail">${server.command} ${server.args.join(" ")}</span>
    <span class="mcp-server-detail">${detail}</span>
  `;
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", () => {
    void window.agent.removeMcpServer(server.id).then(refreshMcpServersList);
  });
  row.appendChild(removeBtn);
  return row;
}

async function refreshMcpServersList() {
  const servers = await window.agent.listMcpServers();
  mcpServersList.innerHTML = "";
  mcpServersEmpty.hidden = servers.length > 0;
  for (const server of servers) mcpServersList.appendChild(renderMcpServerRow(server));
}

mcpServersToggle.addEventListener("click", () => {
  const opening = mcpServersPanel.hidden;
  mcpServersPanel.hidden = !opening;
  mcpServersToggle.setAttribute("aria-expanded", String(opening));
  if (opening) {
    showMcpServersListView();
    void refreshMcpServersList();
  }
});

mcpServersClose.addEventListener("click", closeMcpServersPanel);

mcpServersAddToggle.addEventListener("click", () => {
  mcpServerNameInput.value = "";
  mcpServerCommandInput.value = "";
  mcpServerArgsInput.value = "";
  mcpServerEnvInput.value = "";
  mcpServerFormError.textContent = "";
  mcpServersListView.hidden = true;
  mcpServersFormView.hidden = false;
  mcpServerNameInput.focus();
});

mcpServersFormBack.addEventListener("click", showMcpServersListView);

/** One KEY=value per line; blank lines and lines with no '=' are ignored. */
function parseEnvVarsText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

mcpServerFormSave.addEventListener("click", () => {
  mcpServerFormError.textContent = "";
  const name = mcpServerNameInput.value.trim();
  const command = mcpServerCommandInput.value.trim();
  if (!name || !command) {
    mcpServerFormError.textContent = "Name and command are required.";
    return;
  }
  const args = mcpServerArgsInput.value.trim().split(/\s+/).filter(Boolean);
  const env = parseEnvVarsText(mcpServerEnvInput.value);
  void withBusyLabel(mcpServerFormSave, "Saving…", async () => {
    try {
      await window.agent.addMcpServer({ name, command, args, env });
      showMcpServersListView();
      await refreshMcpServersList();
    } catch (err) {
      mcpServerFormError.textContent = err instanceof Error ? err.message : String(err);
    }
  });
});

window.agent.onMcpServerStatusChanged(() => {
  if (!mcpServersPanel.hidden && !mcpServersListView.hidden) void refreshMcpServersList();
});
```

Find the existing top-level key-handling logic that closes whichever panel is open on Escape (the block containing `else if (!aboutPanel.hidden) closeAboutPanel();`) and add one more branch:

```typescript
  else if (!mcpServersPanel.hidden) closeMcpServersPanel();
```

(Confirm `withBusyLabel` is already defined/imported in this file — it's used by the existing `anthropicSettingsSaveBtn` handler — and reuse it as-is; do not redefine it.)

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: exit code 0, no TypeScript errors.

- [ ] **Step 5: Live-verify against the running app**

Launch the packaged dev build with an isolated `--user-data-dir` and `--remote-debugging-port`, following the exact technique already used and documented for the update-fallback banner (real Electron binary directly — not `npx electron`, which downloads an unrelated copy — with `ELECTRON_RUN_AS_NODE` unset):

```bash
mkdir -p /tmp/localagent-mcp-verify-udata
unset ELECTRON_RUN_AS_NODE
nohup node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --remote-debugging-port=9333 --user-data-dir=/tmp/localagent-mcp-verify-udata > /tmp/localagent-mcp-verify.log 2>&1 &
```

Then, via a small Node script using CDP (`fetch('http://localhost:9333/json')` for the target, then `Runtime.evaluate` over its `webSocketDebuggerUrl`, as in the update-fallback verification):

1. Click `#mcp-servers-toggle`; confirm `#mcp-servers-panel` becomes visible and `#mcp-servers-empty` reads "No MCP servers configured yet."
2. Click `#mcp-servers-add-toggle`; confirm the list view hides and the form view shows.
3. Fill in a real, trivial local server — e.g. name `test`, command `node`, args `-e "console.log('not a real MCP server')"` — click Save; confirm either a connection-failure row appears in the list (expected — that one-liner isn't a real MCP server, so it should fail the handshake and show 🔴 with an error) or, if a real MCP server package is available in the environment (e.g. `npx -y @modelcontextprotocol/server-everything`), use that instead to confirm a 🟢 connected row with a real tool count.
4. Click "Remove" on that row; confirm the list returns to empty.
5. Confirm the real `window.agent.addMcpServer` call resolves with no thrown exception (proving the full IPC round-trip — preload → `main.ts`'s handler — same style of proof used for `openUpdateFile` in the update-fallback verification).
6. Capture a screenshot (`Page.captureScreenshot`) of the panel in both the list and form states for visual confirmation.

Then tear down: kill the Electron process, remove `/tmp/localagent-mcp-verify-udata`, confirm the real production `userData` sessions/settings are untouched.

- [ ] **Step 6: Commit**

```bash
git add src/electron/renderer/index.html src/electron/renderer/renderer.ts src/electron/renderer/styles.css
git commit -m "feat: add the MCP Servers panel"
```

---

## Final Verification

After Task 6:

```bash
npm run build && npm test
```

Expected: exit code 0, every test across the whole suite prints `ok`/`All tests passed.`.

Then follow this project's established finishing flow: merge the feature branch/worktree via `superpowers:finishing-a-development-branch`, and ship the next beta release following the same CHANGELOG/version-bump/tag/CI-poll/asset-verification process used for every prior feature this session.
