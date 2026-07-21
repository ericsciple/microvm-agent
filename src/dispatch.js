// Host-side dispatch endpoint: bridges guest CLI shims to real MCP servers.
//
// Every MCP server (safe outputs, github, third-party) runs on the HOST. The guest
// gets one thin shim per server in a read-only /__mcp mount; each shim POSTs to
// this endpoint (reachable from the guest at the tap gateway IP, e.g.
// 172.16.0.1:9000) one of:
//   { "server": "<name>", "help": true }                 -> list the server's tools
//   { "server": "<name>", "tool": "<t>", "help": true }  -> show a tool's schema
//   { "server": "<name>", "tool": "<t>", "args": [ … ] } -> run a tool
//
// Discovery is LAZY: tools/list is fetched per server on first use and cached; no
// startup manifest. The shim passes positional string args; this endpoint converts
// them to the tool's argument object using the cached schema (host-side), then
// forwards an MCP `tools/call`.
//
// Security: this runs on the HOST. Real secrets live only in the server specs'
// env (never in the guest). The guest can only name a server+tool and pass args;
// the target (issue/PR/repo) is bound by the server from the host's environment.

import http from "node:http";
import { callTool, listTools } from "./mcp-client.js";

/**
 * Discover the tools advertised by each host server (via tools/list). Servers
 * without a command are skipped. Used by tests/probes; the runtime dispatch does
 * lazy per-server discovery instead.
 * @param {import("./mcp-config.js").HostServer[]} hostServers
 * @param {{log?: (msg:string)=>void}} [opts]
 * @returns {Promise<Array<{server: import("./mcp-config.js").HostServer, name: string, description?: string, inputSchema?: object}>>}
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
      found.push({ server, name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
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
 * Create (but do not start) the HTTP dispatch server, keyed by server name.
 * @param {Record<string, import("./mcp-config.js").HostServer>} serverMap
 * @param {{log?: (msg:string)=>void, path?: string}} [opts]
 * @returns {import("node:http").Server}
 */
export function createDispatchServer(serverMap, { log = () => {}, path = "/dispatch" } = {}) {
  // Per-server tools/list cache (lazy: filled on first help/invoke for a server).
  const toolCache = new Map();
  async function getTools(name, server) {
    if (!toolCache.has(name)) toolCache.set(name, await listTools(server));
    return toolCache.get(name);
  }

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

      // Discovery: relay `tools/list` (native MCP shape) for one server or all.
      // `{ discover: true [, server] }` -> { servers: { <name>: { tools: [...] } } }.
      if (payload.discover) {
        try {
          const names = payload.server ? [payload.server] : Object.keys(serverMap);
          const servers = {};
          for (const n of names) {
            const s = serverMap[n];
            if (!s) return send(res, 404, { status: "error", error: `no such MCP server '${n}'` });
            servers[n] = { tools: await getTools(n, s) };
          }
          return send(res, 200, { status: "ok", servers });
        } catch (e) {
          log(`discovery failed: ${e.message}`);
          return send(res, 502, { status: "error", error: e.message });
        }
      }

      // Tool call: `{ server, tool, input }` where input is the JSON arguments object
      // (already matching the tool's inputSchema — the shim is a pure passthrough).
      const name = payload && payload.server;
      const server = name && serverMap[name];
      if (!server) return send(res, 404, { error: `no such MCP server '${name}'` });
      const toolName = payload.tool;
      if (!toolName) return send(res, 400, { status: "error", server: name, text: "no tool specified" });

      try {
        const tools = await getTools(name, server);
        const tool = tools.find((t) => t.name === toolName);
        if (!tool) {
          return send(res, 404, { status: "error", server: name, text: `no tool '${toolName}' on server '${name}'` });
        }
        const args = payload.input && typeof payload.input === "object" ? payload.input : {};
        const result = await callTool(server, toolName, args);
        const text = result?.content?.[0]?.text ?? "";
        if (result?.isError) {
          log(`tool '${name}/${toolName}' error: ${text}`);
          return send(res, 200, { status: "error", server: name, tool: toolName, text });
        }
        log(`tool '${name}/${toolName}' applied: ${text}`);
        return send(res, 200, { status: "ok", server: name, tool: toolName, text });
      } catch (e) {
        log(`server '${name}' failed: ${e.message}`);
        return send(res, 502, { status: "error", server: name, error: e.message });
      }
    });
  });
}

function send(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": buf.length });
  res.end(buf);
}
