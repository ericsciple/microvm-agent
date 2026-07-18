// Host-side dispatch endpoint: bridges guest CLI shims to real MCP servers.
//
// The standalone Copilot CLI blocks custom MCP servers under registry policy, so
// custom/safe-output servers are exposed to the guest as thin CLI shims on PATH.
// Each shim POSTs `{ "tool": "<name>", "args": {...} }` to this endpoint on the
// host (reachable from the guest at the tap gateway IP, e.g. 172.16.0.1:9000).
// The endpoint looks up which host-side MCP server advertises that tool and
// forwards the call as an MCP `tools/call`, returning the result text.
//
// The tool -> server registry is discovered at startup via `tools/list`, so this
// is generic: any stdio MCP server works, and safe outputs are not special-cased.
//
// Security: this runs on the HOST. Real secrets live only in the server specs'
// env (never in the guest). The guest can only name a tool and pass args; the
// target (issue/PR/repo) is bound by the safe-output server from the host's
// GITHUB_EVENT_PATH, exactly as it is for a directly-invoked safe output.

import http from "node:http";
import { callTool, listTools } from "./mcp-client.js";

/**
 * Discover the tools advertised by each host server (via tools/list). Servers
 * without a command are skipped. All servers are shim-dispatched now, including
 * the default `github` server (run host-side over docker/stdio).
 * @param {import("./mcp-config.js").HostServer[]} hostServers
 * @param {{log?: (msg:string)=>void}} [opts]
 * @returns {Promise<Array<{server: import("./mcp-config.js").HostServer, name: string, inputSchema?: object}>>}
 */
export async function discoverTools(hostServers, { log = () => {} } = {}) {
  const found = [];
  for (const server of hostServers) {
    if (!server.command) {
      log(`skipping server '${server.name}': no command to launch`);
      continue;
    }
    const tools = await listTools(server);
    for (const tool of tools) {
      found.push({ server, name: tool.name, inputSchema: tool.inputSchema });
    }
  }
  return found;
}

/**
 * Discover which tool each host server advertises and build a tool -> server map.
 * @param {import("./mcp-config.js").HostServer[]} hostServers
 * @param {{log?: (msg:string)=>void}} [opts]
 * @returns {Promise<Record<string, import("./mcp-config.js").HostServer>>}
 */
export async function buildToolRegistry(hostServers, { log = () => {} } = {}) {
  const registry = {};
  for (const { server, name } of await discoverTools(hostServers, { log })) {
    if (registry[name]) {
      throw new Error(
        `Tool name collision: '${name}' is advertised by both '${registry[name].name}' and '${server.name}'.`
      );
    }
    registry[name] = server;
    log(`registered tool '${name}' -> server '${server.name}'`);
  }
  return registry;
}

/**
 * Create (but do not start) the HTTP dispatch server.
 * @param {Record<string, import("./mcp-config.js").HostServer>} registry
 * @param {{log?: (msg:string)=>void, path?: string}} [opts]
 * @returns {import("node:http").Server}
 */
export function createDispatchServer(registry, { log = () => {}, path = "/dispatch" } = {}) {
  return http.createServer((req, res) => {
    if (req.method !== "POST" || (req.url || "").split("?")[0] !== path) {
      return send(res, 404, { error: "not found" });
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return send(res, 400, { error: "request body is not valid JSON" });
      }
      const tool = payload && payload.tool;
      const args = (payload && payload.args) || {};
      const server = registry[tool];
      if (!server) {
        return send(res, 404, { error: `no server provides tool '${tool}'` });
      }
      try {
        const result = await callTool(server, tool, args);
        const text = result?.content?.[0]?.text ?? "";
        if (result?.isError) {
          log(`tool '${tool}' returned an error: ${text}`);
          return send(res, 200, { status: "error", tool, text });
        }
        log(`tool '${tool}' applied: ${text}`);
        return send(res, 200, { status: "ok", tool, text });
      } catch (e) {
        log(`tool '${tool}' failed: ${e.message}`);
        return send(res, 502, { status: "error", tool, error: e.message });
      }
    });
  });
}

function send(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": buf.length });
  res.end(buf);
}
