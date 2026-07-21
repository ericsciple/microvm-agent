import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { listTools, callTool } from "../src/mcp-client.js";
import { buildToolRegistry, createDispatchServer } from "../src/dispatch.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));

function server(env = {}) {
  return { name: "fixture", kind: "custom", command: process.execPath, args: [FIXTURE], env };
}

// --- mcp-client ---

test("listTools discovers the advertised tool", async () => {
  const tools = await listTools(server({ FIXTURE_TOOL: "do_thing" }));
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "do_thing");
});

test("callTool invokes the tool and returns its result", async () => {
  const result = await callTool(server(), "echo_tool", { a: 1 });
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'echo:{"a":1}');
});

test("callTool surfaces a tool error (isError)", async () => {
  const result = await callTool(server({ FIXTURE_ERROR: "1" }), "echo_tool", {});
  assert.equal(result.isError, true);
});

test("callTool rejects when the command cannot be spawned", async () => {
  await assert.rejects(
    () => callTool({ command: "definitely-not-a-real-command-xyz", args: [] }, "x", {}),
    /ENOENT|spawn/
  );
});


// --- buildToolRegistry (used by probes/tests) ---

test("buildToolRegistry maps each tool to its server and skips servers with no command", async () => {
  const registry = await buildToolRegistry([
    server({ FIXTURE_TOOL: "add_labels" }),
    { name: "no-command", kind: "custom", env: { GITHUB_TOKEN: "x" } },
  ]);
  assert.deepEqual(Object.keys(registry), ["add_labels"]);
  assert.equal(registry.add_labels.name, "fixture");
});

// --- dispatch HTTP endpoint (server-keyed, lazy) ---

async function withDispatch(serverMap, fn) {
  const srv = createDispatchServer(serverMap);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  try {
    return await fn(port);
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

function post(port, obj, path = "/dispatch") {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(obj));
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "Content-Length": body.length } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("dispatch discovery lists a server's tools (native tools/list shape)", async () => {
  await withDispatch({ fixture: server({ FIXTURE_TOOL: "add_labels" }) }, async (port) => {
    const res = await post(port, { discover: true, server: "fixture" });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
    assert.ok(res.body.servers.fixture);
    assert.equal(res.body.servers.fixture.tools[0].name, "add_labels");
  });
});

test("dispatch discovery with no server lists ALL registered servers", async () => {
  await withDispatch(
    { a: server({ FIXTURE_TOOL: "tool_a" }), b: server({ FIXTURE_TOOL: "tool_b" }) },
    async (port) => {
      const res = await post(port, { discover: true });
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(res.body.servers).sort(), ["a", "b"]);
      assert.equal(res.body.servers.a.tools[0].name, "tool_a");
      assert.equal(res.body.servers.b.tools[0].name, "tool_b");
    }
  );
});

test("dispatch invokes a tool with the JSON input object (passthrough)", async () => {
  await withDispatch({ fixture: server() }, async (port) => {
    const res = await post(port, { server: "fixture", tool: "echo_tool", input: { labels: ["triage"] } });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
    assert.equal(res.body.text, 'echo:{"labels":["triage"]}');
  });
});

test("dispatch requires a tool name (no inference)", async () => {
  await withDispatch({ fixture: server() }, async (port) => {
    const res = await post(port, { server: "fixture", input: { a: 1 } });
    assert.equal(res.status, 400);
    assert.equal(res.body.status, "error");
  });
});

test("dispatch returns 404 for an unknown server", async () => {
  await withDispatch({}, async (port) => {
    const res = await post(port, { server: "nope", tool: "x", input: {} });
    assert.equal(res.status, 404);
  });
});

test("dispatch returns 404 for an unknown tool on a known server", async () => {
  await withDispatch({ fixture: server() }, async (port) => {
    const res = await post(port, { server: "fixture", tool: "missing", input: {} });
    assert.equal(res.status, 404);
  });
});

test("dispatch reports a tool error without failing the request", async () => {
  await withDispatch({ fixture: server({ FIXTURE_ERROR: "1" }) }, async (port) => {
    const res = await post(port, { server: "fixture", tool: "echo_tool", input: {} });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "error");
  });
});

test("dispatch rejects invalid JSON", async () => {
  await withDispatch({}, async (port) => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/dispatch", method: "POST" },
        (r) => {
          let d = "";
          r.on("data", (c) => (d += c));
          r.on("end", () => resolve({ status: r.statusCode }));
        }
      );
      req.on("error", reject);
      req.end("{ not json");
    });
    assert.equal(res.status, 400);
  });
});
