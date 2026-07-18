// Read and normalize action inputs (SCAFFOLD).
//
// GitHub Actions passes inputs as INPUT_<NAME> env vars (uppercased, spaces->_).
// TODO: consider @actions/core for parsing/typing; kept dependency-free here.

function input(name, fallback = "") {
  const key = "INPUT_" + name.replace(/ /g, "_").toUpperCase();
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
}

export function readInputs() {
  return {
    prompt: input("prompt"),
    model: input("model", "auto"),
    mcpConfig: input("mcp-config", ""),
    githubMcp: input("github-mcp", "true") !== "false",
    firewallAllow: input("firewall-allow", "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    timeoutMinutes: parseInt(input("timeout-minutes", "15"), 10),
    // Host-side only. Never written into the guest MCP config.
    githubToken: input("github-token") || process.env.GITHUB_TOKEN || "",
  };
}
