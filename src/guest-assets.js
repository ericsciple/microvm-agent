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
// Guest-side helper scripts (report-error/warning/notice/incomplete) live here,
// colocated on the runtime drive and OFF-PATH (like the /__mcp shims). Surfaced to
// the agent via $MV_HELPERS_DIR so nothing hardcodes the path.
export const DEFAULT_HELPERS_DIR = `${DEFAULT_RUNTIME_DIR}/helpers`;
// Where the Copilot CLI binary is mounted (its own drive, with a discard overlay so
// anything it writes next to itself is captured in tmpfs and discarded).
export const DEFAULT_COPILOT_DIR = "/opt/copilot";

// A plain-text (NOT a ::workflow-command::) sentinel that report-incomplete prints so
// the host console grader can detect an agent-declared failure. It must NOT be a
// `::...::` line, or the stdout allowlist filter would neutralize it before grading.
export const REPORT_INCOMPLETE_SENTINEL = "__MICROVM_AGENT_REPORT_INCOMPLETE__";

// Reserved namespace for harness-provided built-in commands under /__mcp. Customer
// MCP server names may not start with this prefix (see mcp-config.js validation), so
// built-ins like `__tools_list` never collide with a registered server.
export const RESERVED_MCP_PREFIX = "__";
// The MCP discovery command (relays `tools/list` to the gateway). Lives in /__mcp
// alongside the call shims — discovery is tools-stuff, so one dir + one env var
// ($MV_MCP_DIR) covers both discovery and calls.
export const TOOLS_LIST_COMMAND = "__tools_list";

/**
 * One call shim per registered MCP server — a PURE passthrough (POSIX sh; needs jq +
 * curl). It carries NO schema and NO application logic: it forwards a JSON arguments
 * object to the host gateway, which routes it to the server's `tools/call`.
 *
 *   <server> <tool> --input '<JSON>'   invoke <tool> with the given JSON arguments
 *   <server> <tool> --stdin            invoke <tool> with JSON arguments read from stdin
 *
 * Discovery is NOT here — run `$MV_MCP_DIR/__tools_list` (see generateToolsListShim).
 * Arguments always match the tool's advertised inputSchema; the shim never translates,
 * inspects, or synthesizes them (no positional/flag modes, no file handling).
 * @param {string} serverName
 * @param {{endpoint?: string}} [opts]
 * @returns {string} shell script contents for the shim
 */
export function generateServerShim(serverName, { endpoint = DEFAULT_DISPATCH_ENDPOINT } = {}) {
  return `#!/bin/sh
# MCP call shim for server '${serverName}'. Pure passthrough to the host gateway.
#   ${serverName} <tool> --input '<JSON>'   invoke a tool with JSON arguments
#   ${serverName} <tool> --stdin            invoke a tool with JSON arguments from stdin
# Discover tools with: "$MV_MCP_DIR/${TOOLS_LIST_COMMAND}"
S=${shq(serverName)}
EP=${shq(endpoint)}
usage() { echo "usage: ${serverName} <tool> --input '<JSON>' | --stdin" >&2; exit 2; }

[ $# -ge 1 ] || usage
tool=$1; shift
[ $# -ge 1 ] || usage

case "$1" in
  --input) [ $# -ge 2 ] || usage; INPUT=$2 ;;
  --stdin) INPUT=$(cat) ;;
  *) usage ;;
esac

# --argjson validates that INPUT is well-formed JSON before we send it.
echo "$INPUT" | jq empty 2>/dev/null || { echo "arguments are not valid JSON" >&2; exit 2; }
jq -nc --arg s "$S" --arg t "$tool" --argjson input "$INPUT" '{server:$s,tool:$t,input:$input}' \\
  | curl -s -X POST "$EP" -H 'Content-Type: application/json' --data-binary @-
echo
`;
}

/**
 * The MCP discovery command (`$MV_MCP_DIR/__tools_list`). A thin relay that defers to
 * the host gateway exactly like the call shims — it asks the gateway to run `tools/list`
 * across the registered servers and prints the aggregated result (native `tools/list`
 * shape: each tool's name, description, inputSchema), minified JSON.
 *
 *   __tools_list            list every registered server's tools
 *   __tools_list <server>   list one server's tools
 * @param {{endpoint?: string}} [opts]
 * @returns {string} shell script contents for the discovery shim
 */
export function generateToolsListShim({ endpoint = DEFAULT_DISPATCH_ENDPOINT } = {}) {
  return `#!/bin/sh
# MCP tool discovery — relays 'tools/list' to the host gateway (like a native MCP
# client). Prints all registered servers' tools (name, description, inputSchema).
#   ${TOOLS_LIST_COMMAND}            list every server's tools
#   ${TOOLS_LIST_COMMAND} <server>   list one server's tools
EP=${shq(endpoint)}
if [ $# -ge 1 ]; then
  jq -nc --arg s "$1" '{discover:true,server:$s}'
else
  jq -nc '{discover:true}'
fi | curl -s -X POST "$EP" -H 'Content-Type: application/json' --data-binary @-
echo
`;
}

/**
 * Guest-side helper scripts the agent runs to surface diagnostics the Actions-native
 * way — inline `::error::`/`::warning::`/`::notice::` annotations — and to declare
 * failure. Each takes the raw message as its first arg and does the workflow-command
 * escaping (`%`->`%25`, CR->`%0D`, LF->`%0A`) itself, so the agent NEVER hand-formats
 * `::error::` (the fragile part). They print to the guest console; the host stdout
 * allowlist filter passes these informational commands through so the runner renders
 * them inline. `report-incomplete` additionally prints a plain-text sentinel that the
 * host console grader detects to fail the step (an agent that ran fine but could not
 * achieve the task — neither an exit code nor a workflow command can express that).
 *
 * POSIX sh + awk (mawk/gawk); the escape is line-by-line (joined with %0A) so it works
 * in mawk, which lacks gawk's whole-file RS slurp.
 * @returns {Record<string,string>} filename -> script contents
 */
export function generateHelperScripts() {
  // Line-by-line escape: mawk-safe (default RS splits on \n); rejoin multi-line
  // messages with the literal %0A escape. Escapes % first so we don't double-escape
  // the %0D/%0A we introduce.
  const escape = `awk '
  { gsub(/%/, "%25"); gsub(/\\r/, "%0D"); out = out (NR > 1 ? "%0A" : "") $0 }
  END { printf "%s", out }
'`;
  const emit = (command, description) =>
    `#!/bin/sh
# ${command} — ${description}
# Usage: ${command} "message"
# Escapes the message and prints an Actions workflow command; the agent never
# hand-formats '::...::' itself.
msg=$(printf '%s' "\${1:-}" | ${escape})
printf '::${command === "report-incomplete" ? "error" : command.replace(/^report-/, "")}::%s\\n' "$msg"
`;
  return {
    "report-error": emit("report-error", "surface an inline error annotation"),
    "report-warning": emit("report-warning", "surface an inline warning annotation"),
    "report-notice": emit("report-notice", "surface an inline notice annotation"),
    "report-incomplete":
      emit("report-incomplete", "declare the task could not be completed (fails the run)") +
      `printf '%s\\n' ${shq(REPORT_INCOMPLETE_SENTINEL)}\n`,
  };
}

/**
 * The preamble prepended to the user prompt: tells the agent it's in an isolated
 * microVM, where the event payload is, how to discover + run MCP tools (via the
 * $MV_MCP_DIR env var, never a hardcoded path), and how to surface diagnostics /
 * declare failure via the $MV_HELPERS_DIR helper scripts.
 * @param {string[]} serverNames
 * @param {{mcpDir?: string}} [opts]
 * @returns {string}
 */
export function generateMcpPreamble(serverNames, { mcpDir = DEFAULT_MCP_DIR } = {}) {
  void mcpDir; // paths are referenced via $MV_MCP_DIR, not baked in.
  const lines = [
    "You are an autonomous agent inside an isolated, ephemeral Firecracker microVM.",
    "The triggering event payload (issue/PR JSON) is at the path in $GITHUB_EVENT_PATH.",
  ];
  if (serverNames.length) {
    lines.push(
      "Tools are provided by MCP servers, reachable as commands under $MV_MCP_DIR:",
      ...serverNames.map((s) => `  $MV_MCP_DIR/${s}`),
      `Discover tools (name, description, JSON input schema) by running \`"$MV_MCP_DIR/${TOOLS_LIST_COMMAND}"\` ` +
        "(add a server name to list just that server).",
      'Call a tool with its JSON arguments (matching the schema): ' +
        '`"$MV_MCP_DIR/<server>" <tool> --input \'{"...":"..."}\'`, ' +
        'or `--stdin` to pass the JSON on standard input (use this for large arguments).'
    );
  }
  lines.push(
    'To surface a problem in the run log, run `"$MV_HELPERS_DIR/report-error" "<message>"` ' +
      "(also report-warning and report-notice for less-severe notes).",
    'If you cannot complete the task, run `"$MV_HELPERS_DIR/report-incomplete" "<reason>"` ' +
      "to fail the run with an explanation.",
    "---"
  );
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
  // dirs so multiple overlays don't collide. Nothing inside the guest is purely
  // read-only: every mount is writable via a discard overlay, so a tool that writes
  // into a mounted dir never fails — yet nothing persists and the host image stays
  // pristine (the security boundary is host-side, not guest asset integrity).
  const overlay = (tag, dev, mountPath) =>
    `\n# --- ${tag}: hypervisor read-only lower + throwaway tmpfs overlay ---\n` +
    `mkdir -p /mnt/mv-${tag}-lower /mnt/mv-${tag}-rw ${shq(mountPath)}\n` +
    `mount -o ro ${shq(dev)} /mnt/mv-${tag}-lower\n` +
    `mount -t tmpfs tmpfs /mnt/mv-${tag}-rw\n` +
    `mkdir -p /mnt/mv-${tag}-rw/upper /mnt/mv-${tag}-rw/work\n` +
    `mount -t overlay overlay -o lowerdir=/mnt/mv-${tag}-lower,upperdir=/mnt/mv-${tag}-rw/upper,workdir=/mnt/mv-${tag}-rw/work ${shq(mountPath)}\n`;

  let out = "";
  if (copilot) out += overlay("cp", copilot.dev, copilot.path);
  if (harness) out += overlay("mcp", harness.dev, harness.path);
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
  // The MCP shims live in the harness mount (/__mcp) and the report-* helpers +
  // event.json live on the runtime drive (/__rt); the CLI can only execute/read files
  // under directories it's been granted, so add both (and the workspace when mounted).
  addDirs.push(runtimeDir);
  if (mounts.harness) addDirs.push(mounts.harness.path);
  if (mounts.workspace) addDirs.push(mounts.workspace.path);
  const addDirFlags = addDirs.map((d) => `--add-dir ${shq(d)}`).join(" ");
  // Run the agent from the workspace when it's mounted (like Actions container jobs,
  // whose working directory is the workspace); otherwise fall back to /root.
  const workDir = mounts.workspace ? mounts.workspace.path : "/root";

  return `#!/bin/sh
set -x
RT=${shq(runtimeDir)}
# Make the runtime dir writable via a throwaway overlay so nothing the guest touches is
# blocked by a read-only mount (the baked stub mounts vdb here read-only). The host image
# stays pristine — writes hit tmpfs and are discarded. Bind (not move) the lower first, so
# if the overlay can't be set up the original mount at $RT still works.
mkdir -p /mnt/mv-rt-lower /mnt/mv-rt-rw
if mount --bind "$RT" /mnt/mv-rt-lower 2>/dev/null; then
  mount -t tmpfs tmpfs /mnt/mv-rt-rw 2>/dev/null && \\
  mkdir -p /mnt/mv-rt-rw/upper /mnt/mv-rt-rw/work && \\
  mount -t overlay overlay -o lowerdir=/mnt/mv-rt-lower,upperdir=/mnt/mv-rt-rw/upper,workdir=/mnt/mv-rt-rw/work "$RT" 2>/dev/null || true
fi
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
