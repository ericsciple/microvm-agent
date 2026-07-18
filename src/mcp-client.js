// Minimal stdio MCP client (host-side).
//
// Each custom/safe-output server is an ordinary stdio MCP server. The harness
// runs them on the host and needs to (a) discover the tool each one advertises,
// and (b) invoke that tool on behalf of a guest CLI shim. This is that client.
//
// It speaks the MCP handshake real servers require: a full `initialize` request
// (with protocolVersion/capabilities/clientInfo), then the `notifications/
// initialized` notification, and only then the actual request (tools/list or
// tools/call). Messages are newline-delimited JSON-RPC over the child's stdio.
// Servers are spawned per call — simple, and it matches the stateless nature of a
// safe output.
//
// Zero dependencies (node:child_process only).

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "microvm-agent", version: "0" };

/**
 * @typedef {Object} ServerSpec
 * @property {string} command
 * @property {string[]} [args]
 * @property {Record<string,string>} [env] - merged over process.env for the child
 */

/**
 * List the tools a server advertises.
 * @param {ServerSpec} server
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<Array<{name:string, description?:string, inputSchema?:object}>>}
 */
export async function listTools(server, { timeoutMs = 20000 } = {}) {
  const result = await rpc(server, { method: "tools/list", params: {} }, timeoutMs);
  return result.tools || [];
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
  return rpc(server, { method: "tools/call", params: { name: toolName, arguments: args } }, timeoutMs);
}

/**
 * Spawn the server, perform the MCP handshake, send one request, and resolve with
 * its `result`. Rejects on protocol error, spawn error, or timeout.
 * @param {ServerSpec} server
 * @param {{method: string, params: object}} request
 * @param {number} timeoutMs
 */
function rpc(server, request, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(server.command, server.args || [], {
        env: { ...process.env, ...(server.env || {}) },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      return reject(e);
    }

    let stderr = "";
    let settled = false;
    const finish = (fn) => (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      fn(v);
    };
    const ok = finish(resolve);
    const fail = finish(reject);

    const timer = setTimeout(
      () => fail(new Error(`MCP server '${server.command}' timed out after ${timeoutMs}ms`)),
      timeoutMs
    );

    const INIT_ID = 1;
    const REQ_ID = 2;
    const send = (msg) => {
      try {
        child.stdin.write(JSON.stringify(msg) + "\n");
      } catch {
        /* pipe may close as the child exits */
      }
    };

    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => fail(e));
    child.on("close", () => {
      if (!settled) {
        fail(
          new Error(
            `MCP server '${server.command}' exited before responding` +
              (stderr ? ` — stderr: ${stderr.slice(0, 300)}` : "")
          )
        );
      }
    });

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return; // ignore non-JSON log lines on stdout
      }
      if (msg.id === INIT_ID) {
        // initialize acknowledged -> send initialized notification, then the request.
        if (msg.error) return fail(new Error(msg.error.message || "initialize failed"));
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: REQ_ID, method: request.method, params: request.params });
        return;
      }
      if (msg.id === REQ_ID) {
        if (msg.error) return fail(new Error(msg.error.message || "MCP error"));
        ok(msg.result || {});
      }
    });

    // Kick off the handshake.
    send({
      jsonrpc: "2.0",
      id: INIT_ID,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
    });
  });
}
