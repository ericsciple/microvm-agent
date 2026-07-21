// stdio transport for the MCP server: newline-delimited JSON-RPC messages in on
// stdin, responses out on stdout. This is the transport the Copilot CLI and
// other MCP clients speak for a local/stdio server.

import { createInterface } from "node:readline";

/**
 * @param {{handle: (msg: object) => Promise<object|null>}} server
 * @param {Object} [io]
 * @param {NodeJS.ReadableStream} [io.input]
 * @param {NodeJS.WritableStream} [io.output]
 * @returns {import("node:readline").Interface}
 */
export function serve(server, { input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, crlfDelay: Infinity });

  // Process messages strictly in order, even though handle() is async.
  let queue = Promise.resolve();

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      // Ignore non-JSON lines rather than crashing the server.
      return;
    }

    queue = queue.then(async () => {
      const response = await server.handle(message);
      if (response) output.write(JSON.stringify(response) + "\n");
    });
  });

  return rl;
}
