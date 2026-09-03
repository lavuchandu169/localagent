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
