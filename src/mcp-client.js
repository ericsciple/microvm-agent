// Host-side stdio MCP client, backed by the official @modelcontextprotocol/sdk.
//
// Each custom/safe-output server is an ordinary stdio MCP server. The harness runs
// them on the host and needs to (a) discover the tool each advertises and (b) invoke
// it on behalf of a guest CLI shim. The SDK's Client + StdioClientTransport handle
// the JSON-RPC framing and the initialize/initialized handshake real servers require.
//
// Servers are spawned per call (stateless — matches the nature of a safe output):
// connect, do the one op, close.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CLIENT_INFO = { name: "microvm-agent", version: "0" };

/**
 * @typedef {Object} ServerSpec
 * @property {string} command
 * @property {string[]} [args]
 * @property {Record<string,string>} [env] - merged over process.env for the child
 */

// Open a transport + client, run `fn(client)`, and always tear down. The transport
// spawns the server and connect() performs the MCP handshake. We pass an explicit env
// (process.env + the server's own env, e.g. its token) so the child still finds PATH —
// the SDK otherwise uses a minimal default environment.
async function withClient(server, timeoutMs, fn) {
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args || [],
    env: { ...process.env, ...(server.env || {}) },
  });
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  try {
    await client.connect(transport);
    return await fn(client, { timeout: timeoutMs });
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * List the tools a server advertises.
 * @param {ServerSpec} server
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<Array<{name:string, description?:string, inputSchema?:object}>>}
 */
export async function listTools(server, { timeoutMs = 20000 } = {}) {
  return withClient(server, timeoutMs, async (client, options) => {
    const result = await client.listTools({}, options);
    return result.tools || [];
  });
}

/**
 * Call one tool on a server.
 * @param {ServerSpec} server
 * @param {string} toolName
 * @param {object} args
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{content?: Array<{type:string,text?:string}>, isError?: boolean}>}
 */
export async function callTool(server, toolName, args, { timeoutMs = 20000 } = {}) {
  return withClient(server, timeoutMs, (client, options) =>
    client.callTool({ name: toolName, arguments: args }, undefined, options)
  );
}
