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

// --- dispatch registry ---

test("buildToolRegistry maps each tool to its server and skips servers with no command", async () => {
  const registry = await buildToolRegistry([
    server({ FIXTURE_TOOL: "add_labels" }),
    { name: "no-command", kind: "custom", env: { GITHUB_TOKEN: "x" } },
  ]);
  assert.deepEqual(Object.keys(registry), ["add_labels"]);
  assert.equal(registry.add_labels.name, "fixture");
});

test("buildToolRegistry rejects a tool-name collision", async () => {
  const a = { ...server({ FIXTURE_TOOL: "dup" }), name: "a" };
  const b = { ...server({ FIXTURE_TOOL: "dup" }), name: "b" };
  await assert.rejects(() => buildToolRegistry([a, b]), /collision/);
});

// --- dispatch HTTP endpoint ---

async function withDispatch(registry, fn) {
  const srv = createDispatchServer(registry);
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

test("dispatch forwards a shim call to the mapped server", async () => {
  const registry = await buildToolRegistry([server({ FIXTURE_TOOL: "add_labels" })]);
  await withDispatch(registry, async (port) => {
    const res = await post(port, { tool: "add_labels", args: { labels: ["triage"] } });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
    assert.equal(res.body.text, 'echo:{"labels":["triage"]}');
  });
});

test("dispatch returns 404 for an unknown tool", async () => {
  await withDispatch({}, async (port) => {
    const res = await post(port, { tool: "nope", args: {} });
    assert.equal(res.status, 404);
  });
});

test("dispatch reports a tool error without failing the request", async () => {
  const registry = await buildToolRegistry([server({ FIXTURE_TOOL: "add_labels", FIXTURE_ERROR: "1" })]);
  await withDispatch(registry, async (port) => {
    const res = await post(port, { tool: "add_labels", args: {} });
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
