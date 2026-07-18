# TODO — microvm-agent

Build checklist for the microVM harness action. Pick this up in a Codespace (Node 20+, plus the
host tooling the phase scripts use). **The isolation is already prototyped and proven — do not
re-derive it.** The verbatim, green proofs are in `docs/proven-prototype/` (copy the exact recipes
from there), and `docs/prototype-lessons.md` indexes them and calls out every non-obvious gotcha
(KVM setfacl, Copilot auth env + the `-p` flag, the mitmproxy token-swap gateway, the host firewall
rules, the egress allowlist, the MCP-policy 403 + CLI-shim workaround, virtio-block ro + overlay).
**Read `docs/prototype-lessons.md` first.** The work here is porting those proven pieces into the
action, not figuring them out again.

## Actions workflows

Workflows are now allowed in this repo (the earlier "no workflows / personal budget" restriction
was lifted; `ubuntu-latest` has `/dev/kvm` for Firecracker). `.github/workflows/ci.yml` runs the
unit tests. The full harness end-to-end (`issues: opened` → microvm-agent → add-labels safe output)
can also live here once the host provisioning phases are built — it's no longer required to run only
from an org-owned repo. The `examples/` file remains documentation for a *consumer's* repo.

## Ground truth to port from (proven, all green on `ubuntu-latest`)

In `docs/proven-prototype/` (verbatim, no drift) — indexed with gotchas in
`docs/prototype-lessons.md`:

- `phase0-kvm` — `/dev/kvm` check (`setfacl`) + Firecracker boot
- `phase1-agent` — Copilot CLI in the guest; auth via `GITHUB_TOKEN` + `copilot-requests: write`
  (`COPILOT_GITHUB_TOKEN`, `S2STOKENS=true`, `GITHUB_COPILOT_INTEGRATION_ID`, `-p` prompt,
  `--allow-all-tools`)
- `phase2-gateway` — mitmproxy credential gateway; fake→real token swap; inference host-side
- `phase3-firewall` — host iptables deny-by-default + allowlist; in-guest root can't bypass
- `phase4-safeoutputs` — CLI-shim delivery of host-side writers (works around Copilot MCP policy);
  reuse the transport + gateway wiring only (the safe-output app now lives in `ericsciple/safe-outputs`)
- `phase5-redteam` — adversarial checks (reference for a regression test)
- `phase6-mounts` — virtio-block ro mounts (hypervisor-enforced) + overlay for writes

## Build phases (from the plan)

- [x] `ericsciple/safe-outputs` app — done and expanded: `add-labels`, `add-comment`,
      `update-issue`, `create-pull-request`, plus scope-widening flags + sanitization. Run
      `npm test` there (61 tests green).
- [ ] **Scaffold → runnable action.** Bundle `src/main.js` → `dist/index.js` (e.g. `ncc`) and commit
      `dist/`. Fill in `readInputs` usage. `action.yml` already declares inputs.
      (`readInputs` is now wired + unit-tested; still needs the `ncc` bundle step, run from a Codespace.)
- [ ] **Provision** (bash scripts under `scripts/`, called from `main.js`): KVM/`setfacl`, kernel +
      base rootfs, tap+NAT, firewall, gateway. Port from phase0–3. (Needs a real KVM-capable host;
      cannot be validated in the offline dev sandbox.)
- [ ] **Mounts:** `GITHUB_WORKSPACE` + `RUNNER_TOOL_CACHE` read-only + throwaway overlay; wire guest
      `PATH` for `setup-*` toolchains. Port from phase6. Verify a `setup-node`/`setup-go` build runs
      in the guest.
- [x] **Default GitHub MCP (read-only):** inject `github` server; implement name-override +
      `github-mcp: false`. (`src/mcp-config.js`, unit-tested.) NOTE: the guest `github` entry is a
      no-secret placeholder shape — its exact transport through the gateway is an open question below.
- [x] **MCP config merge + secret split:** `buildGuestMcpConfig` splits requested servers into a
      guest-visible config (no secrets) and a host-side server plan (real env). A fail-closed guard,
      `assertNoSecretsInGuestConfig`, asserts no host-server secret appears in the guest config; it
      runs in `main.js` before the guest config would be written. Unit-tested (16 tests).
      *Still TODO (needs the running host):* actually launch `hostServers`, generate the per-server
      CLI shims on the guest PATH, and run the host dispatch endpoint (phase4 transport).
- [ ] **Safe outputs wiring:** config half is done — safe-output servers are treated like any other
      user server (env kept host-side, scrubbed from the guest). Remaining: run them host-side with
      `GITHUB_EVENT_PATH`, wire the shims, and prove `add-labels` end-to-end against a throwaway issue.
- [ ] **Egress:** apply `firewall-allow` on top of deny-all.
- [ ] **Teardown + outputs:** stop VM/gateway/firewall/servers; set `status` output; honor
      `timeout-minutes`.
- [ ] **Package:** tag `v0`, keep the `examples/` file as docs (do NOT put it in `.github/workflows/`),
      document required permissions.
- [ ] **Prove end-to-end** with an `issues: opened` workflow that runs the harness with an
      add-labels safe output, landing a label on a real issue. Can now run in-repo on `ubuntu-latest`
      (KVM available), or from an org-owned repo (e.g. `github/ericsciple-planning`) via
      `uses: ericsciple/microvm-agent@<ref>`. Blocked on the host provisioning phases above.

## Open questions (need @ericsciple input)

- **Default `github` server transport.** `buildGuestMcpConfig` emits a minimal, tokenless placeholder
  for the guest `github` entry (`{ readOnly: true, tokenEnv: "COPILOT_GITHUB_TOKEN" }`). What is the
  real shape the standalone Copilot CLI expects for a read-only github server reached through the
  gateway — is it the CLI's built-in github toolset (configured via env only), or an explicit
  `mcpServers.github` HTTP/stdio entry? This determines the final placeholder.
- **Shim ↔ host dispatch contract.** Phase4 used a bash shim that POSTs `{tool, args}` to
  `http://172.16.0.1:9000/dispatch`, where a host service applied the effect. With real MCP servers,
  the host dispatch needs to forward the shim call as an MCP `tools/call` to the right host-side
  stdio server and return the result. Confirm: one dispatch endpoint multiplexing by server/tool
  name, and how tool names are discovered (launch each server + `tools/list`, or declared in config).
- **Node build from a Codespace.** Per your workflow, I did not run the `ncc` bundle or commit
  `dist/` here. Command to run in a Codespace: `npm i -D @vercel/ncc && npx ncc build src/main.js -o dist`
  then commit `dist/`. Confirm `ncc` is the bundler you want (vs. esbuild).

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
