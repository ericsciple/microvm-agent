# microvm-agent

Safely run an AI agent prompt inside a hardware-virtualized **microVM**, as an ordinary GitHub
Action. This is the **microVM harness** from the "Securely running agents in Actions" ADR
(github/c2c-actions#10331): the agent (Copilot CLI) runs in a Firecracker microVM, and everything
trusted — the job token, the egress firewall, the MCP gateway, the MCP servers, and the inference
proxy — stays on the runner host, outside the VM. Safe by default.

> **Status: prototype.** The core is built and proven end to end (issue → microVM agent →
> add-labels safe output lands a label). See `TODO.md` for what's done and what remains.

## Intended usage

```yaml
jobs:
  triage:
    runs-on: ubuntu-latest
    permissions:
      copilot-requests: write   # inference through the gateway
      issues: write             # for the add-labels / add-comment safe outputs
    steps:
      - uses: actions/checkout@v4
      # setup-* steps run here, on the host; their tool caches are mounted into the guest
      - uses: ericsciple/microvm-agent@v0
        with:
          prompt: "Read this issue and apply the most relevant labels."
          mcp-config: |
            {
              "mcpServers": {
                "labeler": {
                  "command": "safe-outputs",
                  "args": ["add-labels"],
                  "env": { "GITHUB_TOKEN": "${{ github.token }}" }
                }
              }
            }
```

The first-party **safe-outputs** MCP servers ship **in-the-box** with this action, so
`command: "safe-outputs"` works with no separate setup step. You still **declare** each safe
output you want in `mcp-config` — that declaration is how you scope what the agent can do (which
operation, which flags, which token). A safe output is just an MCP server, so you give it a token
through its own `env`, like any MCP server; the harness keeps that secret host-side and never puts
it in the guest's config. (To pin or override the bundled version, put your own `safe-outputs` on
PATH — e.g. via `ericsciple/safe-outputs/setup@<ref>` — and it takes precedence.)

## Requirements

Runs on a KVM-capable Linux runner (standard `ubuntu-latest` works — `/dev/kvm` is available).
The harness installs/fetches its own dependencies during provisioning: the Firecracker binary, a
**prebuilt guest kernel + bare rootfs** (from [`ericsciple/microvm-images`](https://github.com/ericsciple/microvm-images)
releases), the Copilot CLI (mounted, not baked), and **mitmproxy** for the credential gateway. `sudo`,
`iptables`, and `e2fsprogs`/`zstd` are expected on the runner (present on hosted runners); `docker` is
**not** needed on the default path. Nothing else to add — the safe-outputs CLI is bundled with the action.

## Design (what the action does)

- **Runs on the host (trusted side).** Node.js entrypoint owns the logic (inputs, MCP config merge,
  safe-output wiring) and shells out to bash for host provisioning.
- **microVM sandbox by default.** Firecracker; `/dev/kvm` on standard hosted runners (proven). The guest
  kernel + bare rootfs are **prebuilt** (fetched from `microvm-images`); the Copilot CLI is mounted, not
  baked, so the base image is generic and cacheable.
- **Credentials stay host-side.** The `github-token` input (default `${{ github.token }}`) is what the
  **harness itself** uses host-side — for the inference gateway and the default read-only `github` server.
  Servers the user adds (safe outputs, third-party tools) get their own secrets via their `env` block in
  `mcp-config`. Either way the guest gets only fake sentinels; real tokens are **never** placed in the
  guest's MCP config.
- **Egress denied by default.** Host-enforced firewall + allowlist; extend with `firewall-allow`. The
  gateway is **lane-bound**: the real credential is swapped in only on its allowlisted host/path
  (inference), never on a general write API — see `docs/architecture.md`.
- **Read-only mounts + throwaway overlay.** `GITHUB_WORKSPACE`, the Actions tool cache, and the Copilot
  CLI are mounted from read-only images with a discard tmpfs overlay; the agent can write but changes are
  discarded. Persisting changes happens only via safe outputs.
- **MCP is the one surface.** Read tools and safe outputs are all MCP servers added via `mcp-config`.
  The default read-only `github` server is on unless `github-mcp: false` or overridden by name.
- **Inline diagnostics + safe result model.** The agent surfaces problems the Actions-native way via
  guest-side helpers (`report-error`/`report-warning`/`report-notice`, and `report-incomplete` to fail
  the run) exposed at `$MV_HELPERS_DIR`. The untrusted guest console is passed through a host-side
  allowlist filter so it can show `::error::`/`::warning::` inline but can't inject capability workflow
  commands; the step passes/fails on the guest agent's exit code. See `docs/architecture.md` §6.

## Related

- **`docs/architecture.md`** — architecture & security model, with diagrams (trust boundary,
  credential gateway, MCP shim/dispatch flow, network/firewall, mounts). Read this to understand *how*
  the guest stays credential-free.
- `ericsciple/safe-outputs` — the context-aware safe-output MCP servers this harness wires in.
- **`docs/prototype-lessons.md`** — hard-won findings from the proven prototype (read this before
  building); **`docs/proven-prototype/`** — the verbatim, green phase workflows to lift recipes from.
- Plan + proven phase workflows: `github/ericsciple-planning`
  (`work/ACTIONS-AGENT-STEP-PROTOTYPE/harness-action-plan.md`).
