import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { assignMcpStateDirs, mcpStateRoot, stepStateDir } from "../src/mcp-state.js";

// The harness gives each host MCP server a private MCP_STATE_DIR so run-wide op-count
// limits (safe-outputs' claimCall) are scoped per-(step, instance): two agent steps in
// one job must not share a budget, and the same op declared twice must count separately.

const RT = "/tmp/runner";
const GUID = "1111-2222";

test("assigns a distinct MCP_STATE_DIR per server instance", () => {
  const map = {
    add_labels1: { command: "safe-outputs", env: { GITHUB_TOKEN: "x" } },
    add_labels2: { command: "safe-outputs" },
  };
  const base = assignMcpStateDirs(map, { runnerTemp: RT, stepGuid: GUID });

  assert.equal(base, path.join(RT, "mcp-state", GUID));
  assert.equal(map.add_labels1.env.MCP_STATE_DIR, path.join(base, "add_labels1"));
  assert.equal(map.add_labels2.env.MCP_STATE_DIR, path.join(base, "add_labels2"));
  assert.notEqual(map.add_labels1.env.MCP_STATE_DIR, map.add_labels2.env.MCP_STATE_DIR);
  // Existing env is preserved, not clobbered.
  assert.equal(map.add_labels1.env.GITHUB_TOKEN, "x");
});

test("two runs (different GUIDs) get independent state dirs under a shared root", () => {
  const a = stepStateDir(RT, "guid-a");
  const b = stepStateDir(RT, "guid-b");
  assert.notEqual(a, b);
  // Both live under the shared root that teardown must NOT bulk-delete (a sibling
  // background step may own another GUID dir concurrently).
  assert.equal(path.dirname(a), mcpStateRoot(RT));
  assert.equal(path.dirname(b), mcpStateRoot(RT));
});

test("falls back to os tmpdir when RUNNER_TEMP is unset", () => {
  const base = stepStateDir(undefined, GUID);
  assert.ok(base.endsWith(path.join("mcp-state", GUID)));
  assert.ok(path.isAbsolute(base));
});
