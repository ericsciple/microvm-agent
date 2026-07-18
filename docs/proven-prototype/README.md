# Proven prototype (reference only)

These are the **verbatim** phase workflows from the microVM harness prototype, copied here so this
repo is self-contained. Each ran green on a standard `ubuntu-latest` runner and proves one layer of
the design. They are **reference material**, not workflows to run here — they are not in
`.github/workflows/` and must not be (see `../../TODO.md`: no Actions workflows in this repo).

Start with `../prototype-lessons.md`, which indexes these files and calls out the non-obvious
gotchas. When building `src/main.js` + `scripts/`, lift the exact commands from these files rather
than re-deriving them.

| File | Layer |
|---|---|
| `agent-sandbox-phase0-kvm.yml` | KVM check + Firecracker boot |
| `agent-sandbox-phase1-agent.yml` | Copilot CLI inside the microVM + auth |
| `agent-sandbox-phase2-gateway.yml` | Host mitmproxy credential gateway (token swap) |
| `agent-sandbox-phase3-firewall.yml` | Host-enforced egress firewall + allowlist |
| `agent-sandbox-phase4-safeoutputs.yml` | Write lane transport (CLI shims → host) |
| `agent-sandbox-phase5-redteam.yml` | In-guest-root adversarial checks |
| `agent-sandbox-phase6-mounts.yml` | virtio-block ro mounts + overlay |
