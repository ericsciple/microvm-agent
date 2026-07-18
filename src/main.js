// microVM agent harness — entrypoint (SCAFFOLD).
//
// This action runs on the runner HOST (the trusted side). It provisions a
// Firecracker microVM, stands up the host-side gateway + firewall + MCP servers,
// runs the Copilot CLI inside the guest wired to talk only through the gateway,
// and tears everything down. The guest holds only fake tokens; all real
// credentials stay host-side.
//
// The low-level provisioning (KVM, tap/NAT, iptables, firecracker, mitmproxy,
// rootfs build) is already proven in github/ericsciple-planning under
// .github/workflows/agent-sandbox-phase{0..6}-*.yml. This file is where that gets
// ported into a reusable action: the Node entrypoint owns the LOGIC (inputs, MCP
// config merge, safe-output server wiring) and shells out to bash scripts for the
// host provisioning.
//
// STATUS: scaffold only. See TODO.md for the build checklist.

import { readInputs } from "./inputs.js";
import { buildGuestMcpConfig } from "./mcp-config.js";

async function main() {
  const inputs = readInputs();

  // 1. PROVISION (host, trusted) — TODO: port from phase0/phase1 scripts
  //    - check /dev/kvm (setfacl), fetch kernel + build/prepare base rootfs
  //    - set up tap + NAT; start host-enforced firewall (phase3)
  //    - start the credential gateway (phase2): real inference/GitHub tokens live
  //      here; guest gets fake sentinels
  //    - mount GITHUB_WORKSPACE + RUNNER_TOOL_CACHE read-only; overlay for writes
  //      (phase6)
  //
  // 2. MCP SERVERS (host, trusted) — TODO
  //    - default read-only github MCP server (unless github-mcp=false or overridden
  //      by a user 'github' entry)
  //    - user servers from mcp-config
  //    - safe-output servers (github/ericsciple safe-outputs): launch host-side with
  //      GITHUB_TOKEN + GITHUB_EVENT_PATH in *their* env; expose to the guest via the
  //      CLI-shim path (phase4). NEVER put the token in the guest config.
  const guestMcpConfig = buildGuestMcpConfig(inputs); // TODO: real merge + shims

  // 3. RUN (guest) — TODO: launch Copilot CLI in the microVM
  //    - COPILOT_GITHUB_TOKEN=<fake> in guest; real token swapped at the gateway
  //    - inference + github MCP go through the gateway (phase1/phase2)
  //    - --allow-all-tools; prompt via -p
  void guestMcpConfig;

  // 4. TEARDOWN — TODO: stop VM, gateway, firewall, servers; surface status
  throw new Error("microvm-agent is a scaffold; see TODO.md");
}

main().catch((err) => {
  process.stderr.write(`microvm-agent failed: ${err.message}\n`);
  process.exit(1);
});
