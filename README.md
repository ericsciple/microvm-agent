# microvm-agent

Safely run an AI agent prompt inside a hardware-virtualized **microVM**, as an ordinary GitHub
Action. This is the **microVM harness** from the "Securely running agents in Actions" ADR
(github/c2c-actions#10331): the agent (Copilot CLI) runs in a Firecracker microVM, and everything
trusted — the job token, the egress firewall, the MCP gateway, the MCP servers, and the inference
proxy — stays on the runner host, outside the VM. Safe by default.

> **Status: scaffold / prototype.** The action is not runnable yet. The isolation mechanisms are
> already proven (see the plan and phase workflows referenced in `TODO.md`); this repo is where they
> get packaged into a reusable action. See `TODO.md` for the build checklist.

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

A safe output is just an MCP server, so you give it a token through its own `env`, like any MCP
server. The harness keeps that secret host-side and never puts it in the guest's config.

## Design (what the action does)

- **Runs on the host (trusted side).** Node.js entrypoint owns the logic (inputs, MCP config merge,
  safe-output wiring) and shells out to bash for host provisioning.
- **microVM sandbox by default.** Firecracker; `/dev/kvm` on standard hosted runners (proven).
- **Credentials stay host-side.** The `github-token` input (default `${{ github.token }}`) is what the
  **harness itself** uses host-side — for the inference gateway and the default read-only `github` server.
  Servers the user adds (safe outputs, third-party tools) get their own secrets via their `env` block in
  `mcp-config`. Either way the guest gets only fake sentinels; real tokens are **never** placed in the
  guest's MCP config.
- **Egress denied by default.** Host-enforced firewall + allowlist; extend with `firewall-allow`.
- **Read-only mounts + throwaway overlay.** `GITHUB_WORKSPACE` and the Actions tool cache are mounted
  read-only; the agent writes into a discarded overlay. Persisting changes happens only via safe
  outputs.
- **MCP is the one surface.** Read tools and safe outputs are all MCP servers added via `mcp-config`.
  The default read-only `github` server is on unless `github-mcp: false` or overridden by name.

## Related

- `ericsciple/safe-outputs` — the context-aware safe-output MCP servers this harness wires in.
- **`docs/prototype-lessons.md`** — hard-won findings from the proven prototype (read this before
  building); **`docs/proven-prototype/`** — the verbatim, green phase workflows to lift recipes from.
- Plan + proven phase workflows: `github/ericsciple-planning`
  (`work/ACTIONS-AGENT-STEP-PROTOTYPE/harness-action-plan.md`).
