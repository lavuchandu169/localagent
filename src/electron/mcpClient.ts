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

// Both connect() (spawn + handshake) and listTools() otherwise fall back to
// the SDK's own DEFAULT_REQUEST_TIMEOUT_MSEC (60s) — long enough that one
// misconfigured/hanging server noticeably stalls both app startup (finding
// #1) and the "add a new server" form's Save button. 10s is generous for a
// well-behaved local stdio server while still failing fast on a hang.
const CONNECT_TIMEOUT_MSEC = 10_000;

/**
 * Connects to one configured MCP server. Never throws — a failure at any
 * stage (spawn, handshake, tool listing, or a timeout) resolves to a
 * "failed" status instead, matching this app's established "background
 * work degrades, never throws at the caller" posture (auto-updater, cloud
 * sync). `deps.createTransport` and `deps.timeoutMs` are only for tests —
 * production callers always get the real StdioClientTransport and the
 * real timeout.
 */
export async function connectMcpServer(
  config: McpServerConfig,
  onStatusChange: (status: McpServerStatus) => void,
  deps: { createTransport?: () => Transport; timeoutMs?: number } = {}
): Promise<McpConnection> {
  onStatusChange({ state: "connecting" });

  const transport =
    deps.createTransport?.() ??
    new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...getDefaultEnvironment(), ...config.env },
    });
  const timeout = deps.timeoutMs ?? CONNECT_TIMEOUT_MSEC;

  // No special capabilities declared — this client only ever calls tools.
  const client = new Client(CLIENT_INFO);
  client.onclose = () => onStatusChange({ state: "failed", error: `${config.name} disconnected unexpectedly.` });
  client.onerror = (err) => onStatusChange({ state: "failed", error: err.message });

  try {
    await client.connect(transport, { timeout });
    const listed = await client.listTools(undefined, { timeout });
    const status: McpServerStatus = { state: "connected", toolCount: listed.tools.length };
    onStatusChange(status);
    return { config, status, client, tools: listed.tools };
  } catch (err) {
    // connect() may have already spawned the child process and completed
    // the handshake before a later step (e.g. listTools()) failed — close
    // here so that partially-established connection doesn't leak.
    await client.close().catch(() => {});
    const status: McpServerStatus = { state: "failed", error: err instanceof Error ? err.message : String(err) };
    onStatusChange(status);
    return { config, status, client: undefined, tools: [] };
  }
}

export async function disconnectMcpServer(connection: McpConnection): Promise<void> {
  if (!connection.client) return;
  // An intentional close still fires the SDK's onclose callback (it can't
  // distinguish "asked to shut down" from "crashed"), so clear our
  // crash-reporting handlers first — otherwise a deliberate disconnect
  // would spuriously broadcast a "failed" status.
  connection.client.onclose = undefined;
  connection.client.onerror = undefined;
  await connection.client.close().catch(() => {});
}
