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
- [x] **Scaffold → runnable action.** `action.yml` `runs.main` points directly at `src/main.js`
      (zero-dependency ESM via `"type":"module"`), so **no `ncc`/`dist` bundle is needed**. `main.js`
      orchestrates the whole flow: inputs → MCP secret split → tool discovery → guest-asset generation
      → provision → rootfs → gateway + dispatch → boot → teardown → `status` output.
- [x] **Provision** (bash under `scripts/`, called from `main.js`): `provision.sh` (KVM access +
      firecracker + kernel), `build-rootfs.sh` (docker export → `mkfs.ext4 -d`, no loop mount),
      `network-up.sh`/`network-down.sh` (tap/NAT/firewall/gateway redirect), `gw_addon.py` (gateway).
      All validated locally in this KVM Codespace; `MV_DRY_RUN=1 node src/main.js` runs the full path
      up to boot (provision + rootfs) green.
- [x] **Mounts (implemented — 2026-07-18; validated locally in a real microVM).** Two axes:
      - **`mounts` input (cumulative enum, default `workspace`):** `none` / `workspace` / `workspace+toolcache`.
        `workspace` mounts `GITHUB_WORKSPACE` as a hypervisor read-only virtio-block lower with a
        throwaway tmpfs **overlay** at the identical guest path; `workspace+toolcache` also mounts
        `RUNNER_TOOL_CACHE` read-only at its identical path (opt-in — the glibc/ABI caveat still applies;
        verify a `setup-node`/`setup-go` build in-guest before relying on it). No full-FS mount.
      - **Well-known guest paths** (Actions container-job convention): workspace -> `/__w`,
        toolcache -> `/__t`, with `GITHUB_WORKSPACE`/`RUNNER_TOOL_CACHE` set in the guest to match;
        the workspace is also added via `--add-dir`. Only the host PATH entries under the tool cache
        are carried across (rewritten to `/__t`, `src/paths.js`) — the whole host PATH is not copied.
        Externals (`/__e`) is NOT mounted: we run no JavaScript actions in the guest (the Copilot CLI
        is a standalone binary, shims are bash, safe-outputs run host-side).
        (Ref: actions/runner `ContainerInfo.cs` maps Work->/__w, Tools->/__t, Externals->/__e.)
      - **Event payload (`copy-event`, default on):** copies **only** `event.json` into the guest and
        repoints `GITHUB_EVENT_PATH`; never copies `RUNNER_TEMP`.
      - **Writes discarded:** overlay writes land in tmpfs and vanish on teardown; the durable output
        path is a safe output (create-pull-request write-back lives in `ericsciple/safe-outputs`, not here).
      - Implementation: `mounts` in `action.yml`/`inputs.js`; `scripts/build-mount-image.sh`
        (`mkfs.ext4 -d`, no loop mount); `generateMountSetup`/`generateInitScript` in `guest-assets.js`;
        `planMounts` + drive wiring in `main.js`. Unit-tested (42 tests). Real-microVM validation proved:
        RO read at identical path, overlay write succeeds, toolcache write + remount-rw both blocked
        (hypervisor-enforced), and the host images stay pristine (writes discarded).
- [x] **Default GitHub MCP (read-only):** inject `github` server; implement name-override +
      `github-mcp: false`. (`src/mcp-config.js`, unit-tested.) **DONE + validated locally:** runs the
      official `ghcr.io/github/github-mcp-server:v1.6.0` host-side over docker/stdio with the real
      token host-side and `GITHUB_READ_ONLY=1`, discovered via the same `tools/list` shim path as safe
      outputs (no guest MCP entry). Verified against the real image: 26 read-only tools discovered
      (`get_file_contents`, `issue_read`, `list_commits`, …). The MCP client was hardened to do the
      full MCP handshake (initialize + `notifications/initialized`) that real servers require.
- [x] **MCP config merge + secret split:** `buildGuestMcpConfig` splits requested servers into a
      guest-visible config (no secrets) and a host-side server plan (real env). A fail-closed guard,
      `assertNoSecretsInGuestConfig`, asserts no host-server secret appears in the guest config; it
      runs in `main.js` before the guest config is written. Unit-tested + verified in the dry-run
      (user secret appears nowhere in the guest inject tree).
- [x] **Shim ↔ host dispatch bridge (RESOLVED + validated locally).** `src/mcp-client.js` (stdio MCP
      client) + `src/dispatch.js` (host HTTP endpoint on `:9000`). Tool→server registry is discovered
      generically via `tools/list` at startup, so safe outputs are not special-cased. Proven locally
      three ways: (a) unit tests with a fixture MCP server; (b) the real `safe-outputs add-labels`
      server driven through the dispatch against a mock GitHub API — label bound to the triggering
      issue, token host-side; (c) end-to-end through a **real Firecracker microVM**: guest shim →
      `172.16.0.1:9000` → dispatch → safe-outputs → GitHub, guest saw `{"status":"ok"}`.
- [x] **Safe outputs wiring:** `src/guest-assets.js` generates a schema-driven CLI shim per discovered
      tool (array→positional, string→whole-line, else JSON arg); `main.js` writes them into the guest
      rootfs and runs the servers host-side via the dispatch. The only piece left is the real Copilot
      CLI driving the shim (vs. the simulated shim call) — see the copilot-inference item + agent-e2e
      workflow below.
- [x] **Provision + rootfs (ported into `scripts/` + `main.js`).** All recipes validated locally in
      this Codespace: Firecracker v1.16.1 + CI kernel boot under KVM; guest rootfs built via
      `docker export` + **`mkfs.ext4 -d <dir>`** (NOT a loop mount — Codespaces has no loop devices;
      `-d` also works on hosted runners); tap0/NAT; `chmod 666 /dev/kvm` (no `setfacl` here).
- [ ] **Copilot inference in-guest (needs a real `copilot-requests` token).** The one piece not yet
      validated locally — the Codespace token likely lacks the scope. Wired in `guest-assets.js`
      init + `gw_addon.py` token-swap (`COPILOT_GITHUB_TOKEN` fake in guest, `S2STOKENS=true`,
      `GITHUB_COPILOT_INTEGRATION_ID`, gateway swap). Validate via the `agent-e2e.yml` workflow run
      on `ubuntu-latest` (`permissions: copilot-requests: write`).
- [x] **Egress:** `firewall-allow` is threaded into the gateway allowlist (`EXTRA_ALLOW` in
      `gw_addon.py`) on top of the deny-all baseline in `network-up.sh`.
- [x] **Teardown + outputs:** `main.js` stops the gateway + dispatch and runs `network-down.sh` in a
      `finally`, sets the `status` output, and honors `timeout-minutes` via the boot timeout.
- [ ] **Package:** tag `v0`, keep the `examples/` file as docs, document required permissions.
      (Action is runnable now; `agent-e2e.yml` demonstrates required permissions.)
- [ ] **Prove end-to-end** — `.github/workflows/agent-e2e.yml` added (`issues: opened` → this action
      with an add-labels safe output → label lands on the issue). Runs in-repo on `ubuntu-latest`.
      **Pending its first real run** (needs the copilot-requests token at runtime).

## Open questions (need @ericsciple input)

- **Default `github` server — REOPENED (currently implemented as a host-side shim; likely should be
  NATIVE-in-guest).** The current build runs `ghcr.io/github/github-mcp-server` host-side over stdio and
  exposes it to the guest via CLI shims (like a safe output). **This works, but is probably the wrong
  shape.** The proven prototype found the standalone Copilot CLI's 403 blocks only *non-default* MCP
  servers and that **"the default `github` server is unaffected"** (`docs/prototype-lessons.md:85-88`).
  So `github` can most likely be a **native MCP server in the guest** (no shim) — which also matches gh-aw
  (it keeps `github` native and **never** CLI-mounts it; only `safeoutputs`/`mcpscripts` are always-CLI).
  Resolve this empirically before locking in the shim.
  - **Test (a `copilot-requests: write` KVM `ubuntu-latest` workflow; reuse the phase2 gateway + phase3
    firewall recipes in `docs/proven-prototype/`):**
    1. Boot the guest with the host credential gateway (guest holds a **fake** `COPILOT_GITHUB_TOKEN`;
       gateway swaps to the real token on egress).
    2. Enable the CLI's **default `github`** server in the *guest* config and determine which form the
       standalone CLI expects: **(a)** built-in toolset via env only (no `mcpServers.github` entry), or
       **(b)** an explicit `mcpServers.github` entry (capture transport + URL, e.g.
       `https://api.githubcopilot.com/mcp/`).
    3. Prompt a **github read** ("get issue #N, print its title"); confirm it returns **real data** with
       **no** `Non-default MCP servers will be blocked` / `403` log line, and capture the **exact host(s)**
       the request dials.
    4. In the same run, register a **dummy custom stdio** server and confirm it **is** blocked (re-confirms
       custom servers must stay shims). Upload guest console + gateway log as artifacts.
  - **If native github works (expected):** keep `github` **native in the guest** — in `src/mcp-config.js`
    restore a real guest `github` entry (the shape the test found) carrying only the **fake**
    `COPILOT_GITHUB_TOKEN` (gateway swaps to real; `assertNoSecretsInGuestConfig` must stay green), and
    **remove** the host-side `docker github-mcp-server` + shim path for github. Read-only comes from the
    CLI's default-github config and/or the token scopes (no `GITHUB_READ_ONLY` here — we're not running the
    server ourselves). Add whatever host the read lane dials to the `gw_addon.py` allowlist. Keep
    name-override + `github-mcp: false`.
  - **Only if `github` is ALSO 403'd (unexpected):** keep the **currently-implemented** host-side
    `ghcr.io/github/github-mcp-server` stdio + shim path (env host-side:
    `GITHUB_PERSONAL_ACCESS_TOKEN=<harness github-token>`, `GITHUB_READ_ONLY=1`, `GITHUB_TOOLSETS=default`,
    `GITHUB_HOST=$GITHUB_SERVER_URL`). gh-aw refs in `.repos/gh-aw`: `pkg/workflow/docker.go:28`,
    `pkg/workflow/mcp_renderer_github.go:179-195`, `pkg/workflow/mcp_github_config.go:119-120` (github MCP
    is always read-only). Either way, do **not** use remote HTTP mode — per gh-aw it does not work with the
    Actions `GITHUB_TOKEN` (needs a PAT/App token).
  - **Either way — clarify the split (the current behavior is correct):** apart from `github`, **every**
    MCP server (safe outputs + third-party) is **shim-only** in the guest — there is no dual-access
    native-MCP path — because the 403 is transport-agnostic. Make this explicit in `src/mcp-config.js`
    comments and in the agent prompt (custom tools are shell commands on `$PATH`; only `github` is a native
    MCP server). Deliberate divergence from gh-aw, whose CLI-mount is opt-in + dual-access.
- **Shim ↔ host dispatch contract (RESOLVED).** A guest shim POSTs `{"tool","args"}` to the host
  dispatch at `http://172.16.0.1:9000/dispatch`; the dispatch forwards it as an MCP `tools/call` to
  the host-side server that advertises that tool. Tool names are discovered by launching each server
  and calling `tools/list` at startup (`src/dispatch.js` / `src/mcp-client.js`). Validated locally
  end-to-end (including through a real microVM).
- **Node build from a Codespace (RESOLVED).** No bundler needed — the action is zero-dependency
  ESM (`"type":"module"`) and `runs.main` points directly at `src/main.js`, so there's no `dist/`
  to build or commit.

## Options on the table (future)

- **Node-native TLS-intercepting gateway (drop the mitmproxy/Python dependency).** Today the
  credential gateway is `mitmproxy` (`mitmdump` + `gw_addon.py`), which the harness installs at
  provision time (pip/pipx). Replacing it with a small Node-native TLS-terminating forward proxy
  (generate a CA once, MITM `:443`, do the fake→real token swap + egress allowlist in JS) would make
  the harness **fully self-contained** (Node-only, no Python/pip install) and shave provisioning time.
  **Wanted**, provided it doesn't drastically bloat the guest/host footprint. Risks to weigh: correct
  TLS termination + SNI/ALPN handling, CA trust in the guest (same as today), HTTP/2, and streaming.
  A dependency-light approach (built-in `node:tls`/`node:http2` + a tiny cert-gen) is preferred over a
  heavy proxy library.

## Key correctness notes

- **Tokens stay host-side.** The harness `github-token` input (default `${{ github.token }}`) is for
  the harness's own use — the inference gateway (guest gets a fake `COPILOT_GITHUB_TOKEN`, swapped at
  the gateway) and the default read-only `github` server. User-added servers (safe outputs, third-party
  tools) carry their own secrets in their `env` block in `mcp-config`. For every server, the harness
  runs it host-side and **never writes the real secret into the guest MCP config**.
- **Copilot MCP policy is ignored** for the prototype — use the CLI-shim path (phase4), not native
  custom MCP servers. This is why safe outputs appear to the agent as **shell commands** (e.g. the
  prompt says "run `add_labels <label>`") rather than advertised MCP tools: the standalone Copilot CLI
  blocks non-default MCP servers when it can't fetch the MCP registry policy (403 with an Actions
  token), so custom servers are delivered as PATH shims invoked via the agent's bash tool. Native
  custom MCP would need the automation policy path resolved.
- **Node action, bash provisioning.** Logic (input parsing, MCP merge, safe-output wiring) in Node;
  low-level host setup shelled out to `scripts/*.sh`.
- **Zero-dependency ESM action.** `runs.main` -> `src/main.js` directly; no `dist/` bundle to build.
