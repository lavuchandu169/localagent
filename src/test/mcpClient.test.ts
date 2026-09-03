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
    check("carries the real listed tool", connection.tools.length === 1 && connection.tools[0]!.name === "ping");
    check("onStatusChange was called with connecting, then connected", statuses.length === 2 && statuses[0]!.state === "connecting" && statuses[1]!.state === "connected");
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
    check("onStatusChange's last call reports failed", statuses[statuses.length - 1]!.state === "failed");
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
    check("closing the connection mid-session fires onStatusChange again with failed", statuses.length > statusesBeforeClose && statuses[statuses.length - 1]!.state === "failed");
  }

  {
    // The SDK's onclose fires on ANY close, intentional or not — it can't
    // tell "we asked it to shut down" apart from "it crashed". So an
    // intentional disconnectMcpServer() must not broadcast a spurious
    // "failed" status the way the mid-session-crash block above does.
    const statuses: McpServerStatus[] = [];
    const clientTransport = await startTestServer();
    const connection = await connectMcpServer(makeConfig(), (s) => statuses.push(s), { createTransport: () => clientTransport });
    const statusesBeforeDisconnect = statuses.length;
    await disconnectMcpServer(connection);
    check(
      "disconnectMcpServer does not fire onStatusChange again (no spurious failed status on an intentional disconnect)",
      statuses.length === statusesBeforeDisconnect
    );
  }

  {
    // A handshake can succeed (spawn + initialize both OK, child process
    // now running) while a later step — here, listTools() — still fails.
    // Simulated by wrapping the real linked transport so it throws only on
    // the outgoing "tools/list" request, after the real handshake already
    // completed through it normally.
    const statuses: McpServerStatus[] = [];
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: "test-server", version: "1.0.0" });
    server.registerTool("ping", { description: "Replies with pong" }, async () => ({ content: [{ type: "text" as const, text: "pong" }] }));
    await server.connect(serverTransport);

    let transportClosed = false;
    const wrapper: Transport = {
      async start() {
        clientTransport.onmessage = (message, extra) => wrapper.onmessage?.(message, extra);
        clientTransport.onclose = () => wrapper.onclose?.();
        clientTransport.onerror = (err) => wrapper.onerror?.(err);
        await clientTransport.start();
      },
      async send(message, options) {
        const isToolsListRequest = typeof message === "object" && message !== null && "method" in message && (message as { method?: unknown }).method === "tools/list";
        if (isToolsListRequest) {
          throw new Error("tools/list failed: simulated post-handshake failure");
        }
        await clientTransport.send(message, options);
      },
      async close() {
        transportClosed = true;
        await clientTransport.close();
      },
    };

    const connection = await connectMcpServer(makeConfig({ name: "listtools-fails-post-handshake" }), (s) => statuses.push(s), { createTransport: () => wrapper });
    check("a listTools() failure after a successful handshake still resolves failed, never throws", connection.status.state === "failed");
    check("client is undefined when listTools fails post-handshake", connection.client === undefined);
    check("the transport was closed so the connected client/child process doesn't leak", transportClosed);
  }
})();

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
