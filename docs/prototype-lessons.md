# Prototype lessons — the hard-won details (read before building)

The microVM isolation was **fully prototyped and proven** before this repo existed. Do **not**
re-derive it. The verbatim, green-on-`ubuntu-latest` proofs are in `docs/proven-prototype/`
(`agent-sandbox-phase0..6-*.yml`) — copy the exact recipes from there. This file is the index +
the non-obvious gotchas that cost real time to figure out.

Everything ran on a **standard `ubuntu-latest`** GitHub-hosted runner. All seven phases were green.

## What each phase proves (and where the recipe lives)

| Phase file | Proves | Run |
|---|---|---|
| `phase0-kvm` | `/dev/kvm` usable on ubuntu-latest; Firecracker boots | 29044544352 |
| `phase1-agent` | Copilot CLI runs **inside** the VM, real inference via `GITHUB_TOKEN` | 29045484924 |
| `phase2-gateway` | Real token only on a host mitmproxy gateway; guest holds a fake | 29048168739 |
| `phase3-firewall` | Host-enforced egress firewall; in-guest root can't bypass | 29049082359 |
| `phase4-safeoutputs` | Write lane via CLI shims to a host framework; stage-artifact generic | 29056719403 |
| `phase5-redteam` | In-guest-root attacks all fail | 29057650863 |
| `phase6-mounts` | virtio-block ro (hypervisor-enforced) + overlay writes | 29057516085 |

> NOTE: phase4's `safe_outputs_server.py` is **superseded** by the real MCP servers in
> `ericsciple/safe-outputs`. Reuse phase4 only for the **transport** (CLI shim → host) and the
> gateway/firewall wiring, not its inline safe-output app.

## Gotchas (the stuff that cost time)

### KVM
- `/dev/kvm` exists on ubuntu-latest but the runner user isn't in the `kvm` group. You **must**
  `sudo setfacl -m u:"$USER":rw /dev/kvm` (or `sudo chmod 666 /dev/kvm`) before Firecracker.
- "Unofficial" KVM support is an internal GitHub decision, not a hard blocker — it works today.

### Firecracker artifacts
- Kernel (`vmlinux`) + rootfs come from the Firecracker CI S3 bucket
  `https://s3.amazonaws.com/spec.ccfc.min`; you parse the latest `firecracker-ci/<date>-.../x86_64/`
  prefix. The firecracker **binary** comes from its GitHub releases `latest`. Exact `curl`/`grep`
  incantations are in `phase0`.
- Boot args that worked: `console=ttyS0 reboot=k panic=1 init=/init`.

### Guest rootfs build
- Build the rootfs by `docker build` a `debian:bookworm-slim` image, `docker export` it, then
  `mkfs.ext4 -d` the unpacked tree (see `phase1`/`phase4`). No special image tooling needed.
- The guest kernel may not auto-create device nodes: `mknod` `/dev/console`, `/dev/null`,
  `/dev/zero`, `/dev/urandom`, `/dev/ttyS0` in the Dockerfile (see any phase Dockerfile).
- The Copilot CLI is a **standalone binary** (no Node): download
  `https://github.com/github/copilot-cli/releases/latest/download/copilot-linux-x64.tar.gz` and
  `tar -xz` into `/usr/local/bin`.

### Copilot CLI auth + flags (this took several iterations)
- Auth with the Actions token: set in the guest env
  - `COPILOT_GITHUB_TOKEN` = the token (a **fake** sentinel in guest; gateway swaps the real one)
  - `S2STOKENS=true` (lets the CLI accept a `ghs_` Actions token)
  - `GITHUB_COPILOT_INTEGRATION_ID=agentic-workflows` (identifies the calling integration)
  - `COPILOT_AGENT_RUNNER_TYPE=STANDALONE`, `XDG_CONFIG_HOME=/root`
  - workflow needs `permissions: { copilot-requests: write }`
- Prompt flag is **`-p "<prompt>"`**, NOT `--prompt-file` (that flag does not exist; it errored).
- Non-interactive/autonomous: `--no-ask-user --allow-all-tools` (or `--allow-tool <server>` to trust
  a specific named MCP server).
- CLI reads MCP config from `$XDG_CONFIG_HOME/.copilot/mcp-config.json`.

### Gateway (credentials out of the guest)
- `mitmproxy` in **transparent** mode is the gateway:
  `mitmdump --mode transparent --listen-host 0.0.0.0 --listen-port 8080 -s gw_addon.py -q --set block_global=false`
  started host-side with `REAL_TOKEN` + `FAKE_TOKEN` in its env.
- Host redirects guest HTTPS into it: `iptables -t nat -A PREROUTING -i tap0 -p tcp --dport 443 -j REDIRECT --to-ports 8080`.
- The addon (`gw_addon.py` in phase2/3/4) does two jobs: **swap** the fake `ghs_FAKE…` token for the
  real one on outbound requests, and **enforce the domain allowlist** (403 anything not on it).
- Guest must **trust the gateway CA**: install it (`update-ca-certificates`) and set
  `NODE_EXTRA_CA_CERTS=/etc/mitmproxy-ca.pem` + `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`.

### Host-enforced firewall
- On the guest's tap device, default-deny egress enforced on the **host** (so in-guest root can't lift
  it). The proven `iptables` sequence (phase3): accept RELATED/ESTABLISHED back to tap, accept DNS
  (udp/tcp 53), **DROP** everything else from tap, `MASQUERADE` out the host iface, plus the :443
  REDIRECT to the gateway. Add a host MCP port ACCEPT if using an HTTP host server.
- Set `sysctl net.ipv4.ip_forward=1` and `net.ipv4.conf.all.send_redirects=0`.

### Egress allowlist (the exact hosts the Copilot CLI needs)
- `api.githubcopilot.com` — inference (`/models`, `POST /v1/messages`)
- `api.github.com` — token exchange, `/copilot/mcp_registry`, release checks
- `api.mcp.github.com` — MCP registry policy fetch
- Nothing else was needed for a basic run.

### MCP registry policy (why safe outputs are CLI shims for now)
- The standalone Copilot CLI **blocks non-default (custom) MCP servers** when it can't fetch the MCP
  registry policy — which 403s with an Actions `GITHUB_TOKEN` — regardless of transport
  (stdio or http). Log line: `Failed to fetch MCP registry policy: 403 Forbidden. Non-default MCP
  servers will be blocked…`. The default `github` server is unaffected.
- **Workaround used (phase4):** expose custom/safe-output servers as **CLI shims** on the guest PATH
  (invoked via the agent's bash tool) that forward to the host-side server. Policy is out of scope for
  this prototype. (Native custom MCP would need the automation policy path resolved.)

### Networking constants that must line up
- tap `tap0` = `172.16.0.1/30`; guest eth0 = `172.16.0.2`; guest MAC = `06:00:AC:10:00:02`; guest
  default route via `172.16.0.1`; guest `nameserver` in `/etc/resolv.conf`.

### Guest boot/shutdown
- `init=/init` (a bash script). At the end, `echo b > /proc/sysrq-trigger` to reboot (Firecracker exits
  cleanly on guest reboot); follow with `sleep infinity` so init never exits and panics the kernel.

### Mounts (phase6)
- Firecracker has **no** virtiofs/bind mounts — host paths are shared as **virtio-block** drives.
- A drive with `"is_read_only": true` is **hypervisor-enforced** read-only: in-guest root can't even
  `mount -o remount,rw` (it errors `Read-only file system`), and the host image is unchanged after.
- For a writable-but-disposable workspace: mount the block device ro, then lay a writable **overlay**
  (tmpfs/scratch upper) inside the guest; writes are discarded on teardown. Persist only via safe
  outputs. Mount **only** `GITHUB_WORKSPACE` + the Actions tool cache (`RUNNER_TOOL_CACHE`).

## How to use this when building the action

The action's `src/main.js` orchestrates these proven pieces (see `../TODO.md` for the checklist):
provision (KVM, firecracker, rootfs, mounts) → start gateway + firewall + host MCP servers → boot the
guest and run the CLI → teardown. Lift the exact commands from `docs/proven-prototype/phaseN-*.yml`;
this file tells you which phase has each piece and where the sharp edges are.
