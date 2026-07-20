# scripts/

Host-side provisioning, called from `src/main.js`. Ported from the proven
`docs/proven-prototype/agent-sandbox-phase{0..6}-*.yml` and validated locally in a
KVM-capable Codespace.

| Script | Purpose |
|---|---|
| `provision.sh <workdir>` | Host setup: grant `/dev/kvm` access, install `zstd`/`e2fsprogs` if missing, fetch the Firecracker binary, and install mitmproxy. The guest artifacts (kernel, rootfs, Copilot) are fetched separately by the action via `@actions/tool-cache` (`src/artifacts.js`). |
| `build-mount-image.sh <src> <out.ext4> [margin_mb]` | Pack a host dir into a virtio-block ext4 via `mkfs.ext4 -d` (no loop mount). Used for the runtime config, Copilot, `/__mcp`, workspace, and tool-cache mounts. |
| `network-up.sh` | tap0 + NAT + host-enforced deny-all firewall + `:443`→gateway redirect + host dispatch port. |
| `network-down.sh` | Best-effort teardown of the above. |
| `gw_addon.py` | mitmproxy addon: per-lane sentinel↔credential binding — swap each fake token for its real credential ONLY on that lane's allowed host/path targets (decision A), enforce the egress allowlist, and reject out-of-lane sentinel use. |

Requires: `sudo`, `iptables`, `mkfs.ext4` (e2fsprogs), `debugfs` (e2fsprogs), `zstd`,
`curl`, `jq`, and `mitmproxy` (`mitmdump`) on PATH. (No `docker` needed on the default
path — the rootfs is prebuilt by `microvm-images`.)

