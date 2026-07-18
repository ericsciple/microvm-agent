import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGuestMcpConfig, assertNoSecretsInGuestConfig } from "../src/mcp-config.js";

const base = {
  githubMcp: true,
  githubToken: "ghs_REAL_HARNESS_TOKEN",
  githubServerUrl: "https://github.com",
  mcpConfig: "",
};

test("adds the default read-only github server host-side (docker), not in the guest config", () => {
  const { guestConfig, hostServers } = buildGuestMcpConfig(base);
  // No github entry is written into the guest MCP config.
  assert.equal(guestConfig.mcpServers.github, undefined);
  const gh = hostServers.find((s) => s.name === "github");
  assert.ok(gh, "github host server present");
  assert.equal(gh.command, "docker");
  assert.ok(gh.args.some((a) => a.startsWith("ghcr.io/github/github-mcp-server:")));
  // Read-only, real token host-side, host-aware.
  assert.equal(gh.env.GITHUB_READ_ONLY, "1");
  assert.equal(gh.env.GITHUB_PERSONAL_ACCESS_TOKEN, "ghs_REAL_HARNESS_TOKEN");
  assert.equal(gh.env.GITHUB_HOST, "https://github.com");
});

test("omits the default github server when github-mcp is false", () => {
  const { guestConfig, hostServers } = buildGuestMcpConfig({ ...base, githubMcp: false });
  assert.equal(guestConfig.mcpServers.github, undefined);
  assert.ok(!hostServers.some((s) => s.name === "github"));
});

test("a user-defined 'github' server overrides the default (no docker default injected)", () => {
  const mcpConfig = JSON.stringify({
    mcpServers: { github: { command: "my-github", env: { TOKEN: "secret" } } },
  });
  const { guestConfig, hostServers } = buildGuestMcpConfig({ ...base, mcpConfig });
  assert.equal(guestConfig.mcpServers.github, undefined);
  const gh = hostServers.find((s) => s.name === "github");
  assert.equal(gh.command, "my-github"); // the user's, not the docker default
  assert.equal(gh.kind, "custom");
  assert.equal(gh.env.TOKEN, "secret");
});

test("never writes the harness token into the guest config", () => {
  const { guestConfig } = buildGuestMcpConfig(base);
  assert.ok(!JSON.stringify(guestConfig).includes("ghs_REAL_HARNESS_TOKEN"));
});

test("custom servers go host-side with their env; nothing about them reaches the guest", () => {
  const mcpConfig = JSON.stringify({
    mcpServers: {
      labeler: {
        command: "safe-outputs",
        args: ["add-labels"],
        env: { GITHUB_TOKEN: "ghs_USER_SECRET" },
      },
    },
  });
  const { guestConfig, hostServers } = buildGuestMcpConfig({ ...base, mcpConfig });
  assert.equal(guestConfig.mcpServers.labeler, undefined);
  const labeler = hostServers.find((s) => s.name === "labeler");
  assert.deepEqual(labeler.args, ["add-labels"]);
  assert.equal(labeler.env.GITHUB_TOKEN, "ghs_USER_SECRET");
  assert.ok(!JSON.stringify(guestConfig).includes("ghs_USER_SECRET"));
});

test("assertNoSecretsInGuestConfig passes for a clean plan", () => {
  const plan = buildGuestMcpConfig({
    ...base,
    mcpConfig: JSON.stringify({
      mcpServers: { labeler: { command: "safe-outputs", env: { GITHUB_TOKEN: "ghs_x" } } },
    }),
  });
  assert.doesNotThrow(() => assertNoSecretsInGuestConfig(plan));
});

test("assertNoSecretsInGuestConfig throws if a secret leaks into the guest config", () => {
  const plan = {
    guestConfig: { mcpServers: { evil: { token: "ghs_LEAKED" } } },
    hostServers: [{ name: "evil", kind: "custom", env: { GITHUB_TOKEN: "ghs_LEAKED" } }],
  };
  assert.throws(() => assertNoSecretsInGuestConfig(plan), /Secret leak/);
});

test("empty env values do not trigger a false leak", () => {
  const plan = {
    guestConfig: { mcpServers: { github: { readOnly: true } } },
    hostServers: [{ name: "github", kind: "github", env: { GITHUB_TOKEN: "" } }],
  };
  assert.doesNotThrow(() => assertNoSecretsInGuestConfig(plan));
});

test("rejects invalid JSON in mcp-config", () => {
  assert.throws(() => buildGuestMcpConfig({ ...base, mcpConfig: "{ not json" }), /not valid JSON/);
});

test("rejects a non-object mcp-config", () => {
  assert.throws(() => buildGuestMcpConfig({ ...base, mcpConfig: "[]" }), /must be a JSON object/);
});
