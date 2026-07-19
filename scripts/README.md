# scripts/

Host-side provisioning, called from `src/main.js`. Ported from the proven
`docs/proven-prototype/agent-sandbox-phase{0..6}-*.yml` and validated locally in a
KVM-capable Codespace.

| Script | Purpose |
|---|---|
| `provision.sh <workdir>` | Grant `/dev/kvm` access; download the Firecracker binary + guest kernel (idempotent). |
| `build-rootfs.sh <ctx> <inject> <out.ext4> [size]` | `docker build`/`export` the guest, overlay runtime files, and pack to ext4 via `mkfs.ext4 -d` (no loop mount — works in Codespaces and on runners). |
| `network-up.sh` | tap0 + NAT + host-enforced deny-all firewall + `:443`→gateway redirect + host dispatch port. |
| `network-down.sh` | Best-effort teardown of the above. |
| `gw_addon.py` | mitmproxy addon: per-lane sentinel↔credential binding — swap each fake token for its real credential ONLY on that lane's allowed host/path targets (decision A), enforce the egress allowlist, and reject out-of-lane sentinel use. |

Requires: `docker`, `sudo`, `iptables`, `mkfs.ext4`, `curl`, `jq`, and `mitmproxy`
(`mitmdump`) on PATH.

