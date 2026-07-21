// Minimal MCP server core (JSON-RPC 2.0 over a message object).
//
// Each safe-output process runs ONE tool (the selected operation), so the
// server advertises exactly one tool via tools/list and handles tools/call for
// it. Transport-agnostic: `handle(message)` takes a parsed JSON-RPC request and
// returns a JSON-RPC response object (or null for notifications). The stdio loop
// lives in serve.js so this stays easy to unit test.

import { validate } from "./validate.js";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_VERSION = "0.1.0";

/**
 * @param {Object} params
 * @param {{name: string, description: string, inputSchema: object}} params.operation
 * @param {(args: object) => Promise<string>} params.apply - performs the effect and
 *        returns a human-readable summary. Kept separate from the operation so tests
 *        (and the CLI) can inject context + a GitHub client at call time.
 * @param {object} [params.schema] - effective input schema (defaults to
 *        operation.inputSchema); the CLI may augment it based on config (e.g. --target *).
 * @param {(msg: string) => void} [params.log]
 */
export function createMcpServer({ operation, apply, schema = operation.inputSchema, log = () => {} }) {
  const tool = {
    name: operation.name,
    description: operation.description,
    inputSchema: schema,
  };

  async function handle(message) {
    if (!message || message.jsonrpc !== "2.0") {
      return null;
    }
    const { id, method, params } = message;

    // Notifications (no id) get no response.
    if (id === undefined || id === null) {
      return null;
    }

    try {
      switch (method) {
        case "initialize":
          return ok(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: `safe-outputs/${operation.name}`, version: SERVER_VERSION },
          });
        case "ping":
          return ok(id, {});
        case "tools/list":
          return ok(id, { tools: [tool] });
        case "tools/call":
          return await handleToolCall(id, params);
        default:
          return err(id, -32601, `Method not found: ${method}`);
      }
    } catch (e) {
      log(`error handling ${method}: ${e.message}`);
      return err(id, -32603, e.message);
    }
  }

  async function handleToolCall(id, params) {
    const name = params && params.name;
    const args = (params && params.arguments) || {};

    if (name !== operation.name) {
      // Wrong tool name is a protocol-level mistake.
      return err(id, -32602, `Unknown tool: ${name}. This server provides '${operation.name}'.`);
    }

    // Validation failures come back as a tool error (isError) rather than a
    // JSON-RPC error, so the model sees the message and can self-correct.
    const errors = validate(tool.inputSchema, args);
    if (errors.length) {
      return ok(id, toolError(`Invalid arguments for ${operation.name}:\n- ${errors.join("\n- ")}`));
    }

    try {
      const summary = await apply(args);
      return ok(id, toolText(summary));
    } catch (e) {
      return ok(id, toolError(e.message));
    }
  }

  return { handle, tool };
}

function ok(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function err(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolText(text) {
  return { content: [{ type: "text", text: String(text) }] };
}

function toolError(text) {
  return { content: [{ type: "text", text: String(text) }], isError: true };
}
