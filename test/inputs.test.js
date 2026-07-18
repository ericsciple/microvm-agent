import { test } from "node:test";
import assert from "node:assert/strict";
import { readInputs } from "../src/inputs.js";

// Read inputs against a controlled env by temporarily swapping process.env keys.
function withEnv(vars, fn) {
  const saved = {};
  const keys = Object.keys(vars);
  // Clear any INPUT_* / GITHUB_TOKEN that could bleed into the test.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("INPUT_") || k === "GITHUB_TOKEN") {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  for (const k of keys) {
    saved[k] = k in process.env ? process.env[k] : undefined;
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("reads defaults when nothing is set", () => {
  const inputs = withEnv({ INPUT_PROMPT: "do it" }, readInputs);
  assert.equal(inputs.prompt, "do it");
  assert.equal(inputs.model, "auto");
  assert.equal(inputs.mcpConfig, "");
  assert.equal(inputs.githubMcp, true);
  assert.deepEqual(inputs.firewallAllow, []);
  assert.equal(inputs.timeoutMinutes, 15);
});

test("github-mcp=false disables the default github server", () => {
  const inputs = withEnv({ "INPUT_GITHUB-MCP": "false" }, readInputs);
  assert.equal(inputs.githubMcp, false);
});

test("firewall-allow is split, trimmed, and emptied lines dropped", () => {
  const inputs = withEnv({ "INPUT_FIREWALL-ALLOW": "  a.com \n\n b.com \n" }, readInputs);
  assert.deepEqual(inputs.firewallAllow, ["a.com", "b.com"]);
});

test("github-token falls back to GITHUB_TOKEN in the environment", () => {
  const inputs = withEnv({ GITHUB_TOKEN: "ghs_env" }, readInputs);
  assert.equal(inputs.githubToken, "ghs_env");
});

test("explicit github-token input wins over GITHUB_TOKEN", () => {
  const inputs = withEnv({ "INPUT_GITHUB-TOKEN": "ghs_input", GITHUB_TOKEN: "ghs_env" }, readInputs);
  assert.equal(inputs.githubToken, "ghs_input");
});

test("timeout-minutes is parsed as an integer", () => {
  const inputs = withEnv({ "INPUT_TIMEOUT-MINUTES": "30" }, readInputs);
  assert.equal(inputs.timeoutMinutes, 30);
});

test("mounts defaults to 'workspace'", () => {
  const inputs = withEnv({ INPUT_PROMPT: "x" }, readInputs);
  assert.equal(inputs.mounts, "workspace");
});

test("mounts accepts the cumulative enum values", () => {
  for (const v of ["none", "workspace", "workspace+toolcache"]) {
    const inputs = withEnv({ INPUT_MOUNTS: v }, readInputs);
    assert.equal(inputs.mounts, v);
  }
});

test("an invalid mounts value is rejected", () => {
  assert.throws(() => withEnv({ INPUT_MOUNTS: "everything" }, readInputs), /Invalid 'mounts'/);
});

test("copy-event defaults on and can be disabled", () => {
  assert.equal(withEnv({ INPUT_PROMPT: "x" }, readInputs).copyEvent, true);
  assert.equal(withEnv({ "INPUT_COPY-EVENT": "false" }, readInputs).copyEvent, false);
});

test("ambient host paths are surfaced for mounts + event", () => {
  const inputs = withEnv(
    { GITHUB_WORKSPACE: "/home/runner/work/r/r", RUNNER_TOOL_CACHE: "/opt/hostedtoolcache", GITHUB_EVENT_PATH: "/e.json" },
    readInputs
  );
  assert.equal(inputs.workspace, "/home/runner/work/r/r");
  assert.equal(inputs.toolCache, "/opt/hostedtoolcache");
  assert.equal(inputs.eventPath, "/e.json");
});
