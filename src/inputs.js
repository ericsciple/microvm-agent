// Read and normalize action inputs.
//
// GitHub Actions passes inputs as INPUT_<NAME> env vars (uppercased, spaces->_).
// Kept dependency-free (no @actions/core).

const MOUNT_MODES = ["none", "workspace", "workspace+toolcache"];

function input(name, fallback = "") {
  const key = "INPUT_" + name.replace(/ /g, "_").toUpperCase();
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
}

export function readInputs() {
  const mounts = input("mounts", "workspace");
  if (!MOUNT_MODES.includes(mounts)) {
    throw new Error(
      `Invalid 'mounts' value '${mounts}'. Expected one of: ${MOUNT_MODES.join(", ")}.`
    );
  }

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
    // Which host paths to expose in the guest (cumulative enum). Default mounts
    // GITHUB_WORKSPACE read-only with a throwaway write overlay; 'workspace+toolcache'
    // also mounts RUNNER_TOOL_CACHE read-only (opt-in due to a glibc/ABI caveat).
    mounts,
    // Copy the event payload into the guest by default (agent context only). Only
    // event.json is ever copied — never RUNNER_TEMP (checkout persists a token there).
    copyEvent: input("copy-event", "true") !== "false",
    // Ambient host paths (provided by the Actions runner), used for mounts + event.
    workspace: process.env.GITHUB_WORKSPACE || "",
    toolCache: process.env.RUNNER_TOOL_CACHE || "",
    eventPath: process.env.GITHUB_EVENT_PATH || "",
    // Base URL for the default github MCP server (GHES-aware); host-side only.
    githubServerUrl: process.env.GITHUB_SERVER_URL || "https://github.com",
    // Optional custom rootfs ext4 (advanced). Default = the fetched bare rootfs (the
    // images repo + tag are hardcoded in main.js, not user inputs). A custom rootfs must
    // satisfy the contract: x86_64 + glibc >= 2.28 + libstdc++.so.6 (no musl).
    rootfs: input("rootfs", ""),
    // Optional override for the Copilot CLI tarball URL (else provision.sh's default).
    copilotUrl: process.env.MV_COPILOT_URL || "",
    // EXPERIMENTAL (test-only) knobs for resolving the github-MCP shape:
    //   MV_GITHUB_MODE=native  -> rely on the CLI's built-in github server (no host docker shim)
    //   MV_GITHUB_MODE=shim    -> host-side github-mcp-server via docker + CLI shim (default)
    githubMode: process.env.MV_GITHUB_MODE || "shim",
    //   MV_EXTRA_GUEST_MCP=<json> -> extra mcpServers merged into the GUEST config (negative control)
    extraGuestMcp: process.env.MV_EXTRA_GUEST_MCP || "",
    // Host-side only. Never written into the guest MCP config.
    githubToken: input("github-token") || process.env.GITHUB_TOKEN || "",
  };
}

