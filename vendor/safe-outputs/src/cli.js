#!/usr/bin/env node
// safe-outputs <operation>
//
// Starts an MCP (stdio) server for a single safe output. Each safe output is an
// ordinary MCP server; a workflow adds it to its MCP config like any other:
//
//   { "mcpServers": { "labeler": { "command": "safe-outputs", "args": ["add-labels"] } } }
//
// The server runs host-side (never in the sandbox), reads GITHUB_EVENT_PATH to
// bind the triggering issue/PR, and applies exactly one narrow write with the
// job token when the agent calls the tool.

import { getOperation, operationIds } from "./operations/index.js";
import { createMcpServer } from "./mcp.js";
import { serve } from "./serve.js";
import { loadContext, requireIssueContext } from "./context.js";
import { createGitHubClient } from "./github.js";
import { parseConfig } from "./config.js";
import { claimCall } from "./limits.js";
import { resolveRepo, resolveIssueNumber, augmentSchemaForTarget } from "./targets.js";

function usage(stream) {
  stream.write(
    `Usage: safe-outputs <operation>\n\n` +
      `Runs an MCP (stdio) server for one safe output.\n\n` +
      `Operations:\n` +
      operationIds()
        .map((id) => `  ${id}`)
        .join("\n") +
      `\n`
  );
}

function main(argv = process.argv) {
  const opId = argv[2];

  if (!opId || opId === "--help" || opId === "-h") {
    usage(process.stderr);
    process.exit(opId ? 0 : 1);
  }

  const operation = getOperation(opId);
  if (!operation) {
    process.stderr.write(`Unknown operation: ${opId}\n\n`);
    usage(process.stderr);
    process.exit(1);
  }

  // Scope-widening flags (e.g. --allowed-labels, --max) come after the operation
  // id. The harness places them on the command line; the agent never sees them.
  let config;
  try {
    config = parseConfig(argv.slice(3));
  } catch (e) {
    process.stderr.write(`${e.message}\n\n`);
    usage(process.stderr);
    process.exit(1);
  }

  // Bind context + GitHub client lazily, at call time, so the server can start
  // (and advertise its schema) even before an event/token is needed, and so a
  // missing-context error surfaces as an actionable tool error to the model.
  async function apply(args) {
    const raw = loadContext();
    const ctx = resolveContext(operation, raw, config, args);
    const github = createGitHubClient();
    // Enforce the run-wide call-count cap right before the write (validation already
    // passed; a validation reject never reaches here, so it burns no budget).
    claimCall(operation.id, config, operation.defaultMax);
    return operation.apply(args, ctx, github, config);
  }

  // For object-acting ops, `--target *` lets the agent name the item; augment the
  // advertised schema so `item_number` is accepted (and required) in that mode.
  const schema =
    operation.targetKind === "issue" ? augmentSchemaForTarget(operation.inputSchema, config) : operation.inputSchema;

  const server = createMcpServer({
    operation,
    apply,
    schema,
    log: (msg) => process.stderr.write(`[safe-outputs/${operation.id}] ${msg}\n`),
  });

  serve(server);
}

/**
 * Resolve the effective target (owner/repo + issue number, or PR branches) from the
 * event context, the author's flags, and the agent's args. The safe default is the
 * triggering object in the current repo; widening (`--target`, `--target-repo`) is
 * author-supplied only.
 */
function resolveContext(operation, raw, config, args) {
  if (operation.targetKind === "create") {
    // Creation ops (create-issue, create-discussion, create-pull-request, dispatch-*)
    // need a repo but no triggering object. Default = the current repo; --target-repo
    // widens it (allow-listed).
    const { owner, repo } = resolveRepo(raw, config);
    return { ...raw, owner, repo };
  }
  // Object-acting ("issue") ops: resolve repo + issue/PR number.
  const { owner, repo } = resolveRepo(raw, config);
  const issueNumber = resolveIssueNumber(raw, config, args);
  return { ...raw, owner, repo, issueNumber };
}

main();
