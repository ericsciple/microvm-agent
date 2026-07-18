# TODO — microvm-agent

Build checklist for the microVM harness action. Pick this up in a Codespace (Node 20+, plus the
host tooling the phase scripts use). The isolation mechanisms are proven in
`github/ericsciple-planning/.github/workflows/agent-sandbox-phase{0..6}-*.yml`; the work here is
porting them into a reusable action with the logic in Node.

## ⚠️ No Actions workflows in this repo

Do **not** add `.github/workflows/` to this repo. It is a personal public repo and workflow runs
would eat into the personal Actions budget. This repo is **action code only**, referenced by
`uses: ericsciple/microvm-agent@<ref>` from elsewhere. The end-to-end proof workflow
(`issues: opened` → `microvm-agent` → add-labels safe output) lives in an **org-owned** repo
(e.g. `github/ericsciple-planning`), not here. The `examples/` file is documentation for a
*consumer's* repo, not a workflow to run here. (Consider disabling Actions in Settings → Actions
so default setup features like CodeQL default setup don't consume budget either.)

## Ground truth to port from (proven, all green on `ubuntu-latest`)

- phase0-kvm — `/dev/kvm` check + Firecracker boot
- phase1-agent — Copilot CLI in the guest; auth via `GITHUB_TOKEN` + `copilot-requests: write`
  (`COPILOT_GITHUB_TOKEN` fake in guest, `S2STOKENS=true`, `-p` prompt, `--allow-all-tools`)
- phase2-gateway — mitmproxy credential gateway; fake→real token swap; inference host-side
- phase3-firewall — host nftables/iptables deny-by-default + allowlist; in-guest root can't bypass
- phase4-safeoutputs — CLI-shim delivery of host-side MCP writers (works around Copilot MCP policy)
- phase5-redteam — adversarial checks (reference for a regression test)
- phase6-mounts — virtio-block ro mounts; hypervisor-enforced read-only

## Build phases (from the plan)

- [x] `ericsciple/safe-outputs` app (add-labels, add-comment) — done; run `npm test` there.
- [ ] **Scaffold → runnable action.** Bundle `src/main.js` → `dist/index.js` (e.g. `ncc`) and commit
      `dist/`. Fill in `readInputs` usage. `action.yml` already declares inputs.
- [ ] **Provision** (bash scripts under `scripts/`, called from `main.js`): KVM/`setfacl`, kernel +
      base rootfs, tap+NAT, firewall, gateway. Port from phase0–3.
- [ ] **Mounts:** `GITHUB_WORKSPACE` + `RUNNER_TOOL_CACHE` read-only + throwaway overlay; wire guest
      `PATH` for `setup-*` toolchains. Port from phase6. Verify a `setup-node`/`setup-go` build runs
      in the guest.
- [ ] **Default GitHub MCP (read-only):** inject `github` server; implement name-override +
      `github-mcp: false`. (`src/mcp-config.js` stub.)
- [ ] **MCP config merge + shims:** finish `buildGuestMcpConfig` — strip real secrets from the guest
      config, place servers host-side, deliver via CLI-shim (phase4). **Do not** put the token in the
      guest config.
- [ ] **Safe outputs wiring:** the user adds `safe-outputs <op>` servers via `mcp-config` with their
      token in their own `env` block (`GITHUB_TOKEN: ${{ github.token }}`). The harness runs them
      host-side (inheriting `GITHUB_EVENT_PATH`), applies that env, and scrubs the secret from the guest
      config; expose to the guest as shims. Not special-cased vs other user servers. Prove `add-labels`
      end-to-end against a throwaway issue.
- [ ] **Egress:** apply `firewall-allow` on top of deny-all.
- [ ] **Teardown + outputs:** stop VM/gateway/firewall/servers; set `status` output; honor
      `timeout-minutes`.
- [ ] **Package:** tag `v0`, keep the `examples/` file as docs (do NOT put it in `.github/workflows/`),
      document required permissions.
- [ ] **Prove end-to-end** from an **org-owned** repo (e.g. `github/ericsciple-planning`): an
      `issues: opened` workflow that `uses: ericsciple/microvm-agent@<ref>` with an add-labels safe
      output, landing a label on a real issue. Not from this repo (budget).

## Key correctness notes

- **Tokens stay host-side.** The harness `github-token` input (default `${{ github.token }}`) is for
  the harness's own use — the inference gateway (guest gets a fake `COPILOT_GITHUB_TOKEN`, swapped at
  the gateway) and the default read-only `github` server. User-added servers (safe outputs, third-party
  tools) carry their own secrets in their `env` block in `mcp-config`. For every server, the harness
  runs it host-side and **never writes the real secret into the guest MCP config**.
- **Copilot MCP policy is ignored** for the prototype — use the CLI-shim path (phase4), not native
  custom MCP servers.
- **Node action, bash provisioning.** Logic (input parsing, MCP merge, safe-output wiring) in Node;
  low-level host setup shelled out to `scripts/*.sh`.
- **Build from a Codespace** (not locally): `npm run build` (once wired) + commit `dist/`.
