// Per-(step, instance) MCP scratch dirs.
//
// Every host MCP server gets a private directory exported as MCP_STATE_DIR. This is a
// generic primitive (any server may use it); safe-outputs uses it for run-wide op-count
// limits (`claimCall`), keyed by op inside the dir. Other servers ignore it.
//
// Path layout: ${RUNNER_TEMP}/mcp-state/${stepGuid}/${serverName}
//   - stepGuid is minted once per run -> two agent steps in one job get independent
//     dirs even though RUNNER_TEMP is shared per job.
//   - the serverName segment isolates instances -> the same op declared twice
//     (add_labels1 / add_labels2) counts against separate budgets.
// MCP_STATE_DIR is a path, never a secret, so it never lands in the guest config.

import os from "node:os";
import path from "node:path";

/** Root that may hold many concurrent steps' state dirs (never bulk-deleted). */
export function mcpStateRoot(runnerTemp) {
  return path.join(runnerTemp || os.tmpdir(), "mcp-state");
}

/** This run's GUID-scoped dir — the only thing safe to remove in teardown. */
export function stepStateDir(runnerTemp, stepGuid) {
  return path.join(mcpStateRoot(runnerTemp), stepGuid);
}

/**
 * Assign each server a private MCP_STATE_DIR (mutates `server.env`) and return the
 * run's GUID-scoped dir so the caller can remove it in teardown.
 * @param {Record<string, {env?: Record<string,string>}>} serverMap keyed by server name
 * @param {{runnerTemp?: string, stepGuid: string}} opts
 * @returns {string} the GUID-scoped state dir
 */
export function assignMcpStateDirs(serverMap, { runnerTemp, stepGuid }) {
  const base = stepStateDir(runnerTemp, stepGuid);
  for (const [name, server] of Object.entries(serverMap)) {
    server.env = { ...(server.env || {}), MCP_STATE_DIR: path.join(base, name) };
  }
  return base;
}
