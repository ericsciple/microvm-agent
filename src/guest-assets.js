// Generate the guest-side assets: the per-server CLI shims, the MCP preamble, the
// mount setup, and the init script.
//
// The guest rootfs is a prebuilt BARE image (from ericsciple/microvm-images) that
// carries no per-run content. Everything run-specific is delivered via mounts:
//   - the runtime config drive (vdb, /__rt): init.sh + prompt + agent.env + gateway CA
//   - the Copilot CLI (its own drive, mounted with a discard overlay)
//   - the /__mcp shims + event.json (read-only)
//   - the workspace / tool cache (read-only lower + discard overlay)
//
// Shims are the guest's only view of an MCP server. There is ONE shim per server
// (not per tool), delivered off-PATH in a read-only /__mcp mount. A shim is a thin
// forwarder that POSTs to the host dispatch endpoint (see dispatch.js):
//   /__mcp/<server>                 -> list the server's tools        (lazy tools/list)
//   /__mcp/<server> <tool> --help   -> show a tool's input schema
//   /__mcp/<server> <tool> <args>   -> run a tool
// The shim carries NO schema — discovery is lazy and host-side (dispatch caches
// tools/list per server), so the guest rootfs/base image needs no per-run baking.

export const DEFAULT_DISPATCH_ENDPOINT = "http://172.16.0.1:9000/dispatch";
export const DEFAULT_MCP_DIR = "/__mcp";
// The per-run runtime config drive is ALWAYS the first extra drive (vdb); the bare
// rootfs's baked /init stub mounts it here and execs /__rt/init.sh (see microvm-images).
export const DEFAULT_RUNTIME_DIR = "/__rt";
// Where the Copilot CLI binary is mounted (its own drive, with a discard overlay so
// anything it writes next to itself is captured in tmpfs and discarded).
export const DEFAULT_COPILOT_DIR = "/opt/copilot";

/**
 * One shim per server. POSIX sh; needs jq + curl in the guest.
 * @param {string} serverName
 * @param {{endpoint?: string}} [opts]
 * @returns {string} shell script contents for the shim
 */
export function generateServerShim(serverName, { endpoint = DEFAULT_DISPATCH_ENDPOINT } = {}) {
  return `#!/bin/sh
# MCP shim for server '${serverName}'.
#   ${serverName}                 list this server's tools
#   ${serverName} <tool> --help   show a tool's input schema
#   ${serverName} <tool> [args]   run a tool
S=${shq(serverName)}
EP=${shq(endpoint)}
post() { curl -s -X POST "$EP" -H 'Content-Type: application/json' --data-binary @-; echo; }
if [ $# -eq 0 ] || [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  jq -nc --arg s "$S" '{server:$s,help:true}' | post
  exit 0
fi
tool=$1; shift
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  jq -nc --arg s "$S" --arg t "$tool" '{server:$s,tool:$t,help:true}' | post
  exit 0
fi
jq -nc --arg s "$S" --arg t "$tool" '{server:$s,tool:$t,args:$ARGS.positional}' --args "$@" | post
`;
}

/**
 * The preamble prepended to the user prompt: tells the agent it's in an isolated
 * microVM, where the event payload is, and how to discover + run MCP tools.
 * @param {string[]} serverNames
 * @param {{mcpDir?: string}} [opts]
 * @returns {string}
 */
export function generateMcpPreamble(serverNames, { mcpDir = DEFAULT_MCP_DIR } = {}) {
  const lines = [
    "You are an autonomous agent inside an isolated, ephemeral Firecracker microVM.",
    "The triggering event payload (issue/PR JSON) is at the path in $GITHUB_EVENT_PATH.",
  ];
  if (serverNames.length) {
    lines.push("Tools are provided by MCP servers, exposed as commands (use the absolute path):");
    for (const s of serverNames) lines.push(`  ${mcpDir}/${s}`);
    lines.push(
      `List a server's tools: \`${mcpDir}/<server>\`. Show a tool's inputs: \`${mcpDir}/<server> <tool> --help\`.`,
      `Run a tool: \`${mcpDir}/<server> <tool> <args>\`.`
    );
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

/**
 * Generate the bash that mounts the requested host images inside the guest.
 * Install-type mounts (copilot, workspace, tool cache) use a read-only lower + a
 * throwaway tmpfs overlay, so tools that write into their own directory don't fail,
 * yet nothing persists and the underlying image stays pristine (hypervisor RO). The
 * /__mcp harness is a pure read-only mount (tamper-proof shims + event.json).
 * @param {{copilot?: {dev:string,path:string}|null, harness?: {dev:string,path:string}|null, workspace?: {dev:string,path:string}|null, toolcache?: {dev:string,path:string}|null}} [mounts]
 * @returns {string}
 */
export function generateMountSetup({ copilot = null, harness = null, workspace = null, toolcache = null } = {}) {
  // A read-only image + throwaway tmpfs overlay at `path`. `tag` namespaces the temp
  // dirs so multiple overlays don't collide.
  const overlay = (tag, dev, mountPath) =>
    `\n# --- ${tag}: hypervisor read-only lower + throwaway tmpfs overlay ---\n` +
    `mkdir -p /mnt/mv-${tag}-lower /mnt/mv-${tag}-rw ${shq(mountPath)}\n` +
    `mount -o ro ${shq(dev)} /mnt/mv-${tag}-lower\n` +
    `mount -t tmpfs tmpfs /mnt/mv-${tag}-rw\n` +
    `mkdir -p /mnt/mv-${tag}-rw/upper /mnt/mv-${tag}-rw/work\n` +
    `mount -t overlay overlay -o lowerdir=/mnt/mv-${tag}-lower,upperdir=/mnt/mv-${tag}-rw/upper,workdir=/mnt/mv-${tag}-rw/work ${shq(mountPath)}\n`;

  let out = "";
  if (copilot) out += overlay("cp", copilot.dev, copilot.path);
  if (harness) {
    out +=
      `\n# --- harness config (shims + event.json): hypervisor read-only ---\n` +
      `mkdir -p ${shq(harness.path)}\n` +
      `mount -o ro ${shq(harness.dev)} ${shq(harness.path)}\n`;
  }
  if (workspace) out += overlay("ws", workspace.dev, workspace.path);
  if (toolcache) out += overlay("tc", toolcache.dev, toolcache.path);
  return out;
}

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * The per-run init script, delivered on the runtime config drive and run as
 * /__rt/init.sh by the bare rootfs's baked /init stub (which has already mounted
 * proc/sys/dev and /__rt). It brings up networking, trusts the gateway CA, sets up
 * the mounts (Copilot + /__mcp + workspace + tool cache), exports the Copilot auth
 * env, and runs the agent. All run-specific files are read from /__rt.
 * @param {Object} [opts]
 * @param {string} [opts.guestIp]
 * @param {string} [opts.hostIp]
 * @param {string} [opts.dns]
 * @param {{copilot?: {dev:string,path:string}|null, harness?: {dev:string,path:string}|null, workspace?: {dev:string,path:string}|null, toolcache?: {dev:string,path:string}|null}} [opts.mounts]
 * @param {string} [opts.runtimeDir]
 * @returns {string}
 */
export function generateInitScript({
  guestIp = "172.16.0.2",
  hostIp = "172.16.0.1",
  dns = "8.8.8.8",
  mounts = {},
  runtimeDir = DEFAULT_RUNTIME_DIR,
} = {}) {
  const mountSetup = generateMountSetup(mounts);
  const copilotDir = mounts.copilot ? mounts.copilot.path : DEFAULT_COPILOT_DIR;
  const addDirs = ["/root"];
  // The MCP shims live in the harness mount (/__mcp); the CLI can only execute files
  // under directories it's been granted, so add it (and the workspace when mounted).
  if (mounts.harness) addDirs.push(mounts.harness.path);
  if (mounts.workspace) addDirs.push(mounts.workspace.path);
  const addDirFlags = addDirs.map((d) => `--add-dir ${shq(d)}`).join(" ");
  // Run the agent from the workspace when it's mounted (like Actions container jobs,
  // whose working directory is the workspace); otherwise fall back to /root.
  const workDir = mounts.workspace ? mounts.workspace.path : "/root";

  return `#!/bin/sh
set -x
RT=${shq(runtimeDir)}
ip link set lo up
ip addr add ${guestIp}/30 dev eth0
ip link set eth0 up
ip route add default via ${hostIp}
echo 'nameserver ${dns}' > /etc/resolv.conf
# Trust the per-run gateway CA (delivered on the runtime drive; rootfs is writable).
cp "$RT/mitmproxy-ca.pem" /usr/local/share/ca-certificates/mitmproxy.crt 2>/dev/null || true
update-ca-certificates 2>/dev/null || true
# Guest MCP config (no secrets) — the CLI reads it from HOME/.copilot.
mkdir -p /root/.copilot
cp "$RT/mcp-config.json" /root/.copilot/mcp-config.json 2>/dev/null || true
${mountSetup}
export HOME=/root
export XDG_CONFIG_HOME=/root
export PATH=${shq(copilotDir)}:$PATH
export COPILOT_AGENT_RUNNER_TYPE=STANDALONE
export S2STOKENS=true
export GITHUB_COPILOT_INTEGRATION_ID=agentic-workflows
export NODE_EXTRA_CA_CERTS="$RT/mitmproxy-ca.pem"
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
[ -f "$RT/agent.env" ] && . "$RT/agent.env"
cd ${shq(workDir)} 2>/dev/null || cd /root

echo "=== GUEST: starting copilot ==="
copilot --no-ask-user --allow-all-tools \\
  ${addDirFlags} --log-level all --log-dir /tmp/cplogs \\
  -p "$(cat "$RT/prompt.txt")" 2>&1
echo "=== GUEST: AGENT_EXIT=$? ==="

sync
echo 1 > /proc/sys/kernel/sysrq
echo b > /proc/sysrq-trigger
sleep infinity
`;
}
