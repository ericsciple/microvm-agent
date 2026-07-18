// Build the MCP config the guest sees (SCAFFOLD).
//
// Responsibilities (TODO):
//  - Parse inputs.mcpConfig (Copilot MCP JSON: { "mcpServers": { ... } }).
//  - Add the default read-only `github` server unless disabled (github-mcp=false)
//    or overridden by a user entry named `github`.
//  - Identify safe-output servers (the `safe-outputs` app) and user servers.
//  - Produce a guest-facing config that reaches every server through the gateway /
//    CLI-shim, WITHOUT any real secret. Real tokens (job token, safe-output token,
//    user server secrets) are injected host-side where each server actually runs.
//
// This is the security-critical seam: nothing returned here may contain a real
// credential, because the guest can read it.

const DEFAULT_GITHUB_SERVER_NAME = "github";

export function buildGuestMcpConfig(inputs) {
  const user = parse(inputs.mcpConfig);
  const servers = { ...(user.mcpServers || {}) };

  // Default read-only github server, unless disabled or user-overridden by name.
  if (inputs.githubMcp && !servers[DEFAULT_GITHUB_SERVER_NAME]) {
    servers[DEFAULT_GITHUB_SERVER_NAME] = {
      // TODO: real read-only github MCP wiring (GITHUB_READ_ONLY=1), host-side
      // token, reached via the gateway. Placeholder shape only.
      __todo: "read-only github MCP server",
    };
  }

  // TODO: for each server, decide host-side placement + shim, strip secrets,
  // and give safe-output servers the job token + GITHUB_EVENT_PATH host-side.
  return { mcpServers: servers };
}

function parse(json) {
  if (!json) return {};
  try {
    return JSON.parse(json);
  } catch (e) {
    throw new Error(`mcp-config is not valid JSON: ${e.message}`);
  }
}
