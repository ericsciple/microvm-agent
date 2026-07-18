// Minimal stdio MCP server used as a test fixture. Exposes one tool whose name
// is taken from FIXTURE_TOOL (default "echo_tool"). It echoes its arguments back
// as text, or returns a tool error when FIXTURE_ERROR is set. No dependencies.
import { createInterface } from "node:readline";

const TOOL = process.env.FIXTURE_TOOL || "echo_tool";
const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch {
    return;
  }
  if (msg.id === undefined || msg.id === null) return;

  if (msg.method === "initialize") {
    return write(msg.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "0" },
    });
  }
  if (msg.method === "tools/list") {
    return write(msg.id, {
      tools: [{ name: TOOL, description: "fixture tool", inputSchema: { type: "object" } }],
    });
  }
  if (msg.method === "tools/call") {
    if (process.env.FIXTURE_ERROR) {
      return write(msg.id, { content: [{ type: "text", text: "fixture error" }], isError: true });
    }
    const args = (msg.params && msg.params.arguments) || {};
    return write(msg.id, { content: [{ type: "text", text: `echo:${JSON.stringify(args)}` }] });
  }
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not found" } }) + "\n"
  );
});

function write(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
