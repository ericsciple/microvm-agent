// Minimal stdio MCP client (host-side).
//
// Each custom/safe-output server is an ordinary stdio MCP server. The harness
// runs them on the host and needs to (a) discover the tool each one advertises,
// and (b) invoke that tool on behalf of a guest CLI shim. This is that client:
// it spawns the server, speaks newline-delimited JSON-RPC, and returns the
// result. Servers are one-shot and cheap, so we spawn per call — simple, and it
// matches the stateless "apply exactly one write" nature of a safe output.
//
// Zero dependencies (node:child_process only).

import { spawn } from "node:child_process";

/**
 * @typedef {Object} ServerSpec
 * @property {string} command
 * @property {string[]} [args]
 * @property {Record<string,string>} [env] - merged over process.env for the child
 */

/**
 * List the tools a server advertises (via initialize + tools/list).
 * @param {ServerSpec} server
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<Array<{name:string, description?:string, inputSchema?:object}>>}
 */
export async function listTools(server, { timeoutMs = 15000 } = {}) {
  const result = await rpc(
    server,
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ],
    2,
    timeoutMs
  );
  return result.tools || [];
}

/**
 * Call one tool on a server (via initialize + tools/call).
 * @param {ServerSpec} server
 * @param {string} toolName
 * @param {object} args
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{content?: Array<{type:string,text?:string}>, isError?: boolean}>}
 */
export async function callTool(server, toolName, args, { timeoutMs = 15000 } = {}) {
  return rpc(
    server,
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: toolName, arguments: args } },
    ],
    2,
    timeoutMs
  );
}

/**
 * Spawn the server, send the given JSON-RPC messages, and resolve with the
 * `result` of the response whose id === wantId. Rejects on protocol error,
 * spawn error, or timeout.
 */
function rpc(server, messages, wantId, timeoutMs) {
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

    let out = "";
    let err = "";
    let settled = false;
    const done = (fn) => (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    const ok = done(resolve);
    const fail = done(reject);

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`MCP server '${server.command}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => fail(e));
    child.on("close", () => {
      const msgs = out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const msg = msgs.find((m) => m.id === wantId);
      if (!msg) {
        return fail(
          new Error(
            `no JSON-RPC response (id ${wantId}) from '${server.command}'` +
              (err ? ` — stderr: ${err.slice(0, 300)}` : "")
          )
        );
      }
      if (msg.error) return fail(new Error(msg.error.message || "MCP error"));
      ok(msg.result || {});
    });

    for (const m of messages) child.stdin.write(JSON.stringify(m) + "\n");
    child.stdin.end();
  });
}
