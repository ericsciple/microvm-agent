import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { listTools, callTool } from "../src/mcp-client.js";
import { buildToolRegistry, createDispatchServer, convertArgs } from "../src/dispatch.js";

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

// --- convertArgs (host-side positional -> argument object) ---

test("convertArgs maps positional args to a single array-of-strings property", () => {
  const schema = { type: "object", properties: { labels: { type: "array", items: { type: "string" } } } };
  assert.deepEqual(convertArgs(schema, ["bug", "triage"]), { labels: ["bug", "triage"] });
});

test("convertArgs joins positional args for a single string property", () => {
  const schema = { type: "object", properties: { body: { type: "string" } } };
  assert.deepEqual(convertArgs(schema, ["hello", "there"]), { body: "hello there" });
});

test("convertArgs parses a single JSON arg for multi-property tools", () => {
  const schema = { type: "object", properties: { a: { type: "string" }, b: { type: "string" } } };
  assert.deepEqual(convertArgs(schema, ['{"a":"x","b":"y"}']), { a: "x", b: "y" });
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

test("dispatch --help lists a server's tools", async () => {
  await withDispatch({ fixture: server({ FIXTURE_TOOL: "add_labels" }) }, async (port) => {
    const res = await post(port, { server: "fixture", help: true });
    assert.equal(res.status, 200);
    assert.match(res.body.text, /add_labels/);
  });
});

test("dispatch tool --help shows a CLI usage synopsis", async () => {
  await withDispatch({ fixture: server() }, async (port) => {
    const res = await post(port, { server: "fixture", tool: "echo_tool", help: true });
    assert.equal(res.status, 200);
    assert.match(res.body.text, /Usage: echo_tool/);
  });
});

test("dispatch invokes a tool with converted args", async () => {
  await withDispatch({ fixture: server() }, async (port) => {
    // fixture tool has schema {type:object} (no properties) -> generic JSON arg.
    const res = await post(port, { server: "fixture", tool: "echo_tool", args: ['{"labels":["triage"]}'] });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
    assert.equal(res.body.text, 'echo:{"labels":["triage"]}');
  });
});

test("dispatch infers the single tool when the tool name is omitted", async () => {
  await withDispatch({ fixture: server() }, async (port) => {
    // No `tool` field: the fixture server exposes exactly one tool (echo_tool), so
    // dispatch infers it (single-tool safe-output servers invoked as /__mcp/<server> --flags).
    const res = await post(port, { server: "fixture", tool: "", args: ['{"a":1}'] });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
    assert.equal(res.body.text, 'echo:{"a":1}');
  });
});

test("dispatch returns 404 for an unknown server", async () => {
  await withDispatch({}, async (port) => {
    const res = await post(port, { server: "nope", help: true });
    assert.equal(res.status, 404);
  });
});

test("dispatch returns 404 for an unknown tool on a known server", async () => {
  await withDispatch({ fixture: server() }, async (port) => {
    const res = await post(port, { server: "fixture", tool: "missing", args: [] });
    assert.equal(res.status, 404);
  });
});

test("dispatch reports a tool error without failing the request", async () => {
  await withDispatch({ fixture: server({ FIXTURE_ERROR: "1" }) }, async (port) => {
    const res = await post(port, { server: "fixture", tool: "echo_tool", args: [] });
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

// --- renderToolUsage (self-describing discovery) ---

test("renderToolUsage: single string-array prop -> positional usage", async () => {
  const { renderToolUsage } = await import("../src/dispatch.js");
  const tool = { name: "add_labels", description: "Add labels.", inputSchema: { type: "object", properties: { labels: { type: "array", items: { type: "string" } } } } };
  const u = renderToolUsage(tool);
  assert.match(u, /Usage: add_labels <labels>\.\.\./);
  assert.ok(!u.includes("--labels"));
});

test("renderToolUsage: file-change tool renders --add/--delete, not base64 schema", async () => {
  const { renderToolUsage } = await import("../src/dispatch.js");
  const tool = {
    name: "create_pull_request",
    description: "Open a PR.",
    inputSchema: {
      type: "object",
      required: ["title", "body"],
      properties: {
        title: { type: "string", description: "Title." },
        body: { type: "string", description: "Body." },
        draft: { type: ["boolean", "string"], description: "Draft." },
        additions: { type: "array", items: { type: "object", properties: { path: { type: "string" }, contents: { type: "string" } } } },
        deletions: { type: "array", items: { type: "object", properties: { path: { type: "string" } } } },
      },
    },
  };
  const u = renderToolUsage(tool);
  assert.match(u, /--title <string>/);
  assert.match(u, /--add <path>/);
  assert.match(u, /--delete <path>/);
  assert.match(u, /contents read from your workspace/);
  // The base64 wire detail is hidden from the agent-facing usage.
  assert.ok(!/base64/.test(u));
});

test("renderToolUsage: multi-field string-array prop is a repeatable flag", async () => {
  const { renderToolUsage } = await import("../src/dispatch.js");
  const tool = { name: "create_issue", description: "", inputSchema: { type: "object", required: ["title"], properties: { title: { type: "string" }, labels: { type: "array", items: { type: "string" }, description: "Labels." } } } };
  const u = renderToolUsage(tool);
  assert.match(u, /\[--labels <value>\.\.\.\]/);
  assert.match(u, /\(repeatable\)/);
});

test("convertArgs coerces a scalar to a 1-element array when the schema wants an array", async () => {
  const { convertArgs } = await import("../src/dispatch.js");
  const schema = { type: "object", properties: { title: { type: "string" }, labels: { type: "array", items: { type: "string" } } } };
  assert.deepEqual(convertArgs(schema, ['{"title":"t","labels":"bug"}']), { title: "t", labels: ["bug"] });
  assert.deepEqual(convertArgs(schema, ['{"title":"t","labels":["a","b"]}']), { title: "t", labels: ["a", "b"] });
});
