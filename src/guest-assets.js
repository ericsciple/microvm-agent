// Generate the guest-side assets: the CLI shims (one per host-dispatched tool),
// the init script, and the Dockerfile used to build the guest rootfs.
//
// The shims are the guest's only view of a custom/safe-output server: a thin
// bash forwarder on PATH that POSTs `{tool, args}` to the host dispatch endpoint
// (see dispatch.js). We generate each shim from the tool's advertised JSON Schema
// so the agent gets an ergonomic command, without hardcoding per-tool knowledge:
//
//   - one array-of-strings property  -> positional args   (add_labels bug triage)
//   - one string property            -> the whole line     (add_comment hello there)
//   - anything else                  -> a single JSON arg   (update_issue '{"state":"closed"}')

export const DEFAULT_DISPATCH_ENDPOINT = "http://172.16.0.1:9000/dispatch";

/**
 * @param {{name: string, inputSchema?: object}} tool
 * @param {{endpoint?: string}} [opts]
 * @returns {string} bash script contents for the shim
 */
export function generateShim(tool, { endpoint = DEFAULT_DISPATCH_ENDPOINT } = {}) {
  const schema = tool.inputSchema || {};
  const props = schema.properties || {};
  const keys = Object.keys(props);
  const post = `  | curl -s -X POST ${endpoint} -H 'Content-Type: application/json' --data-binary @-\necho`;

  if (keys.length === 1) {
    const key = keys[0];
    const prop = props[key] || {};
    if (prop.type === "array" && prop.items && prop.items.type === "string") {
      return (
        `#!/bin/bash\n` +
        `# ${tool.name}: positional args become the '${key}' array.\n` +
        `jq -nc --args '{tool:"${tool.name}",args:{${key}:$ARGS.positional}}' "$@" \\\n` +
        post +
        `\n`
      );
    }
    if (prop.type === "string") {
      return (
        `#!/bin/bash\n` +
        `# ${tool.name}: the whole command line becomes the '${key}' string.\n` +
        `jq -nc --arg v "$*" '{tool:"${tool.name}",args:{${key}:$v}}' \\\n` +
        post +
        `\n`
      );
    }
  }

  // Generic fallback: the single argument is a JSON object of the tool arguments.
  return (
    `#!/bin/bash\n` +
    `# ${tool.name}: pass tool arguments as a single JSON object, e.g. ${tool.name} '{"...":"..."}'.\n` +
    `jq -nc --argjson args "\${1:-{}}" '{tool:"${tool.name}",args:$args}' \\\n` +
    post +
    `\n`
  );
}

/**
 * The guest init script: bring up networking, trust the gateway CA, export the
 * Copilot CLI auth env, and run the agent with the prompt. Ported from the proven
 * phase1/phase4 init.
 * @param {{guestIp?: string, hostIp?: string, dns?: string}} [opts]
 * @returns {string}
 */
export function generateInitScript({ guestIp = "172.16.0.2", hostIp = "172.16.0.1", dns = "8.8.8.8" } = {}) {
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

export HOME=/root
export XDG_CONFIG_HOME=/root
export COPILOT_AGENT_RUNNER_TYPE=STANDALONE
export S2STOKENS=true
export GITHUB_COPILOT_INTEGRATION_ID=agentic-workflows
export NODE_EXTRA_CA_CERTS=/etc/mitmproxy-ca.pem
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
[ -f /etc/agent.env ] && . /etc/agent.env
cd /root

echo "=== GUEST: starting copilot ==="
copilot --no-ask-user --allow-all-tools \\
  --add-dir /root --log-level all --log-dir /tmp/cplogs \\
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
 * device nodes + the generated shims. Ported from phase4.
 * @param {string[]} shimNames
 * @returns {string}
 */
export function generateDockerfile(shimNames) {
  const copyShims = shimNames.map((n) => `COPY ${n} /usr/local/bin/${n}`).join("\n");
  const chmodShims = shimNames.map((n) => `/usr/local/bin/${n}`).join(" ");
  return `FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \\
      ca-certificates curl iproute2 iptables procps jq \\
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
${copyShims}
RUN chmod +x /init ${chmodShims}
`;
}
