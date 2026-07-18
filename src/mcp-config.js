// Build the MCP configuration the guest sees, and the plan for the host-side
// servers — keeping every real credential on the host.
//
// This is the security-critical seam of the harness. The contract is simple and
// absolute: **nothing in `guestConfig` may contain a real secret**, because the
// guest (the sandboxed agent, running as root inside the microVM) can read it.
//
// The proven model (docs/proven-prototype/phase4) splits servers two ways:
//
//   1. The default read-only `github` server is the ONE server the standalone
//      Copilot CLI allows under its MCP registry policy, so it stays a real MCP
//      server in the guest config. It reaches api.github.com through the host
//      gateway, which swaps the guest's *fake* token for the real one — so no real
//      token is ever written into the guest config.
//
//   2. Every other server (safe outputs and third-party tools alike) is a *custom*
//      MCP server, which the CLI blocks under policy. These are delivered as CLI
//      shims on the guest PATH: thin forwarders that POST `{tool, args}` to a host
//      dispatch endpoint (172.16.0.1:9000 in the prototype). The real server runs
//      host-side with its declared `env` (which may hold secrets, e.g. a safe
//      output's `GITHUB_TOKEN: ${{ github.token }}`); the guest sees only the shim.
//      Safe outputs are NOT special-cased — every custom server is handled this way.

const DEFAULT_GITHUB_SERVER_NAME = "github";

/**
 * @param {ReturnType<import("./inputs.js").readInputs>} inputs
 * @returns {{ guestConfig: {mcpServers: object}, hostServers: HostServer[] }}
 *
 * @typedef {Object} HostServer
 * @property {string} name
 * @property {"github"|"custom"} kind - how it's exposed to the guest
 * @property {string} [command] - executable to launch host-side (custom servers)
 * @property {string[]} [args]
 * @property {Record<string,string>} env - the server's environment; may hold secrets
 * @property {object} [def] - the remaining original server definition (custom servers)
 */
export function buildGuestMcpConfig(inputs) {
  const user = parse(inputs.mcpConfig);
  const userServers = user.mcpServers || {};

  const guestServers = {};
  const hostServers = [];

  const userDefinedGithub = Object.prototype.hasOwnProperty.call(
    userServers,
    DEFAULT_GITHUB_SERVER_NAME
  );

  // (1) Default read-only github server — a guest-visible MCP entry with a fake
  // token sentinel (swapped to the real one at the gateway), never the real token.
  if (inputs.githubMcp && !userDefinedGithub) {
    guestServers[DEFAULT_GITHUB_SERVER_NAME] = githubReadOnlyGuestEntry();
    hostServers.push({
      name: DEFAULT_GITHUB_SERVER_NAME,
      kind: "github",
      // The harness token is used host-side (gateway swap for the read-only github
      // server); it is deliberately NOT part of any guest-visible config.
      env: { GITHUB_TOKEN: inputs.githubToken },
    });
  }

  // (2) Every user-provided server becomes a host-side server exposed to the guest
  // as a CLI shim. Its env (secrets and all) stays host-side; nothing about it is
  // written into the guest config.
  for (const [name, rawDef] of Object.entries(userServers)) {
    hostServers.push(normalizeCustomServer(name, rawDef));
  }

  return { guestConfig: { mcpServers: guestServers }, hostServers };
}

/**
 * Guest-facing entry for the default read-only github MCP server. Carries a FAKE
 * token sentinel that the host gateway rewrites to the real token; the real token
 * never appears here.
 *
 * NOTE: the exact transport/URL of the CLI's github server through the gateway is
 * an OPEN QUESTION (see TODO.md "Default `github` server transport — HOW TO WIRE IT").
 * This shape is a non-functional placeholder — the github READ lane is not wired yet;
 * only the no-secret invariant is guaranteed here. The write lane (safe outputs) works.
 */
function githubReadOnlyGuestEntry() {
  return {
    readOnly: true,
    tokenEnv: "COPILOT_GITHUB_TOKEN", // fake sentinel in the guest; swapped at the gateway
  };
}

/**
 * Split a user server definition into the host-side plan, isolating its env
 * (secrets) from everything that could reach the guest.
 * @param {string} name
 * @param {object} rawDef
 * @returns {HostServer}
 */
function normalizeCustomServer(name, rawDef) {
  const def = rawDef && typeof rawDef === "object" ? rawDef : {};
  const { env = {}, command, args = [], ...rest } = def;
  if (env && typeof env !== "object") {
    throw new Error(`mcp-config server '${name}': 'env' must be an object.`);
  }
  return {
    name,
    kind: "custom",
    command,
    args: Array.isArray(args) ? args : [],
    env: { ...env },
    def: rest,
  };
}

/**
 * Defensive guard: assert that no non-empty value from any host server's env
 * appears anywhere in the guest config. Intended to run at provision time before
 * the guest config is written into the VM — a leak here is a security failure.
 * @param {{ guestConfig: object, hostServers: HostServer[] }} plan
 */
export function assertNoSecretsInGuestConfig({ guestConfig, hostServers }) {
  const serialized = JSON.stringify(guestConfig);
  for (const server of hostServers) {
    for (const [key, value] of Object.entries(server.env || {})) {
      if (typeof value === "string" && value !== "" && serialized.includes(value)) {
        throw new Error(
          `Secret leak: value of ${server.name}.env.${key} appears in the guest MCP config.`
        );
      }
    }
  }
}

function parse(json) {
  if (!json) return {};
  let value;
  try {
    value = JSON.parse(json);
  } catch (e) {
    throw new Error(`mcp-config is not valid JSON: ${e.message}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error('mcp-config must be a JSON object like { "mcpServers": { ... } }.');
  }
  return value;
}
