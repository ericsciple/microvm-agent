// Build the MCP configuration the guest sees, and the plan for the host-side
// servers — keeping every real credential on the host.
//
// This is the security-critical seam of the harness. The contract is simple and
// absolute: **nothing in `guestConfig` may contain a real secret**, because the
// guest (the sandboxed agent, running as root inside the microVM) can read it.
//
// EVERY MCP server runs host-side and is exposed to the guest as a CLI shim — a
// thin forwarder on the guest PATH that POSTs `{tool, args}` to the host dispatch
// endpoint (172.16.0.1:9000). The real server runs host-side with its declared
// `env` (which may hold secrets); the guest sees only the shim, and NO server is
// written into the guest MCP config. This is uniform: the standalone Copilot CLI
// blocks *custom* MCP servers under its registry policy, so nothing is delivered
// as a native guest MCP entry.
//
//   - User servers (safe outputs + third-party tools) carry their own secrets in
//     their `env` block (e.g. a safe output's `GITHUB_TOKEN: ${{ github.token }}`).
//   - The default read-only `github` server runs the official github-mcp-server
//     image host-side over stdio (docker), with the real token host-side and
//     GITHUB_READ_ONLY=1 — the same "local mode" gh-aw uses. It is NOT special-
//     cased: it flows through the identical host-launch + tools/list shim path.

const DEFAULT_GITHUB_SERVER_NAME = "github";

// Pinned github-mcp-server image (matches gh-aw's DefaultGitHubMCPServerVersion).
// Bump deliberately; keep in sync with a supply-chain-safe pin when productizing.
const GITHUB_MCP_IMAGE = "ghcr.io/github/github-mcp-server:v1.6.0";

/**
 * @param {ReturnType<import("./inputs.js").readInputs>} inputs
 * @returns {{ guestConfig: {mcpServers: object}, hostServers: HostServer[] }}
 *
 * @typedef {Object} HostServer
 * @property {string} name
 * @property {"github"|"custom"} kind - informational label; all servers are shim-dispatched
 * @property {string} [command] - executable to launch host-side
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

  // (1) Default read-only github server.
  //   - "shim" (default): run the official github-mcp-server host-side over docker
  //     stdio with the real token host-side (GITHUB_READ_ONLY=1), discovered like any
  //     server and delivered as `github_*` CLI shims. No guest MCP entry.
  //   - "native" (experimental): rely on the CLI's BUILT-IN github server in the guest
  //     (on by default unless --disable-builtin-mcps). No host server, no shim — the
  //     built-in is a default server, unaffected by the custom-MCP 403 policy block.
  if (inputs.githubMcp && !userDefinedGithub && inputs.githubMode !== "native") {
    hostServers.push({
      name: DEFAULT_GITHUB_SERVER_NAME,
      kind: "github",
      command: "docker",
      // `-e NAME` (no value) forwards NAME from the spawned process env (set below)
      // into the container, so the real token never appears on the command line.
      args: [
        "run", "-i", "--rm",
        "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
        "-e", "GITHUB_READ_ONLY",
        "-e", "GITHUB_TOOLSETS",
        "-e", "GITHUB_HOST",
        GITHUB_MCP_IMAGE,
      ],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: inputs.githubToken,
        GITHUB_READ_ONLY: "1",
        GITHUB_TOOLSETS: "default",
        GITHUB_HOST: inputs.githubServerUrl || "https://github.com",
      },
    });
  }

  // (2) Every user-provided server becomes a host-side server exposed to the guest
  // as a CLI shim. Its env (secrets and all) stays host-side; nothing about it is
  // written into the guest config.
  for (const [name, rawDef] of Object.entries(userServers)) {
    hostServers.push(normalizeCustomServer(name, rawDef));
  }

  // EXPERIMENTAL (test-only): merge extra servers directly into the GUEST config.
  // Used as the negative control to confirm the CLI blocks a custom guest MCP server
  // under registry policy. Must not carry secrets (it reaches the guest verbatim).
  if (inputs.extraGuestMcp) {
    let extra;
    try {
      extra = JSON.parse(inputs.extraGuestMcp);
    } catch (e) {
      throw new Error(`MV_EXTRA_GUEST_MCP is not valid JSON: ${e.message}`);
    }
    for (const [name, def] of Object.entries(extra.mcpServers || extra || {})) {
      guestServers[name] = def;
    }
  }

  return { guestConfig: { mcpServers: guestServers }, hostServers };
}

/**
 * Split a user server definition into the host-side plan, isolating its env
 * (secrets) from everything that could reach the guest.
 * @param {string} name
 * @param {object} rawDef
 * @returns {HostServer}
 */
function normalizeCustomServer(name, rawDef) {
  // The server name is used verbatim as the /__mcp/<name> shim filename (and as a
  // per-instance state-dir segment), so reject anything outside a safe charset before
  // it can escape the directory or break shim generation.
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw new Error(
      `mcp-config server name '${name}' is invalid: use only letters, digits, '.', '_', or '-' (1–64 chars).`
    );
  }
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
