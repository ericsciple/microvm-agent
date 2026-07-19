// Generate the guest-side assets: the per-server CLI shims, the MCP preamble, the
// mount setup, the init script, and the Dockerfile.
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
 * - workspace: mount the RO image as an overlay lowerdir, with a tmpfs upper, at
 *   the identical host path — so writes are captured in memory and discarded, and
 *   GITHUB_WORKSPACE/PATH need no translation. The RO lower is hypervisor-enforced.
 * - toolcache: mount the RO image directly at its identical host path.
 * @param {{workspace?: {dev:string,path:string}|null, toolcache?: {dev:string,path:string}|null}} [mounts]
 * @returns {string}
 */
export function generateMountSetup({ harness = null, workspace = null, toolcache = null } = {}) {
  let out = "";
  if (harness) {
    out +=
      `\n# --- harness config (shims + event.json): hypervisor read-only ---\n` +
      `mkdir -p ${shq(harness.path)}\n` +
      `mount -o ro ${shq(harness.dev)} ${shq(harness.path)}\n`;
  }
  if (workspace) {
    out +=
      `\n# --- workspace: hypervisor read-only lower + throwaway tmpfs overlay ---\n` +
      `mkdir -p /mnt/mv-ws-lower /mnt/mv-ws-rw ${shq(workspace.path)}\n` +
      `mount -o ro ${shq(workspace.dev)} /mnt/mv-ws-lower\n` +
      `mount -t tmpfs tmpfs /mnt/mv-ws-rw\n` +
      `mkdir -p /mnt/mv-ws-rw/upper /mnt/mv-ws-rw/work\n` +
      `mount -t overlay overlay -o lowerdir=/mnt/mv-ws-lower,upperdir=/mnt/mv-ws-rw/upper,workdir=/mnt/mv-ws-rw/work ${shq(workspace.path)}\n`;
  }
  if (toolcache) {
    out +=
      `\n# --- toolcache: hypervisor read-only mount at its identical path ---\n` +
      `mkdir -p ${shq(toolcache.path)}\n` +
      `mount -o ro ${shq(toolcache.dev)} ${shq(toolcache.path)}\n`;
  }
  return out;
}

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * The guest init script: bring up networking, trust the gateway CA, set up any
 * requested mounts, export the Copilot CLI auth env, and run the agent with the
 * prompt. Ported from the proven phase1/phase4/phase6 init.
 * @param {Object} [opts]
 * @param {string} [opts.guestIp]
 * @param {string} [opts.hostIp]
 * @param {string} [opts.dns]
 * @param {{harness?: {dev:string,path:string}|null, workspace?: {dev:string,path:string}|null, toolcache?: {dev:string,path:string}|null}} [opts.mounts]
 * @returns {string}
 */
export function generateInitScript({
  guestIp = "172.16.0.2",
  hostIp = "172.16.0.1",
  dns = "8.8.8.8",
  mounts = {},
} = {}) {
  const mountSetup = generateMountSetup(mounts);
  const addDirs = ["/root"];
  if (mounts.workspace) addDirs.push(mounts.workspace.path);
  const addDirFlags = addDirs.map((d) => `--add-dir ${shq(d)}`).join(" ");
  // Run the agent from the workspace when it's mounted (like Actions container jobs,
  // whose working directory is the workspace); otherwise fall back to /root.
  const workDir = mounts.workspace ? mounts.workspace.path : "/root";

  return `#!/bin/bash
set -x
mount -t proc proc /proc 2>/dev/null || true
mount -t sysfs sys /sys 2>/dev/null || true
mount -t devtmpfs dev /dev 2>/dev/null || true
ip link set lo up
ip addr add ${guestIp}/30 dev eth0
ip link set eth0 up
ip route add default via ${hostIp}
echo 'nameserver ${dns}' > /etc/resolv.conf
update-ca-certificates 2>/dev/null || true
${mountSetup}
export HOME=/root
export XDG_CONFIG_HOME=/root
export COPILOT_AGENT_RUNNER_TYPE=STANDALONE
export S2STOKENS=true
export GITHUB_COPILOT_INTEGRATION_ID=agentic-workflows
export NODE_EXTRA_CA_CERTS=/etc/mitmproxy-ca.pem
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
[ -f /etc/agent.env ] && . /etc/agent.env
cd ${shq(workDir)} 2>/dev/null || cd /root

echo "=== GUEST: starting copilot ==="
copilot --no-ask-user --allow-all-tools \\
  ${addDirFlags} --log-level all --log-dir /tmp/cplogs \\
  -p "$(cat /etc/prompt.txt)" 2>&1 | tee /dev/console
echo "=== GUEST: AGENT_EXIT=\${PIPESTATUS[0]} ==="

sync
echo 1 > /proc/sys/kernel/sysrq
echo b > /proc/sysrq-trigger
sleep infinity
`;
}

/**
 * Dockerfile for the guest rootfs: Debian slim + the standalone Copilot CLI +
 * device nodes. Ported from phase4. `util-linux` provides `mount` for the
 * virtio-block mounts (phase6); `jq`/`curl` are used by the /__mcp shims. Shims
 * are NOT baked in — they are delivered per-run via the read-only /__mcp mount.
 * @returns {string}
 */
export function generateDockerfile() {
  return `FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \\
      ca-certificates curl iproute2 iptables procps jq util-linux \\
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL --retry 3 -o /tmp/copilot.tgz \\
      https://github.com/github/copilot-cli/releases/latest/download/copilot-linux-x64.tar.gz \\
    && tar -xz -C /usr/local/bin -f /tmp/copilot.tgz \\
    && chmod +x /usr/local/bin/copilot \\
    && rm /tmp/copilot.tgz
RUN mknod -m 622 /dev/console c 5 1 || true; \\
    mknod -m 666 /dev/null c 1 3 || true; \\
    mknod -m 666 /dev/zero c 1 5 || true; \\
    mknod -m 444 /dev/random c 1 8 || true; \\
    mknod -m 444 /dev/urandom c 1 9 || true; \\
    mknod -m 620 /dev/ttyS0 c 4 64 || true
COPY init.sh /init
RUN chmod +x /init
`;
}
