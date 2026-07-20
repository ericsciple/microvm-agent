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
- [x] **Scaffold → runnable action.** `action.yml` `runs.main` points at `dist/index.js` (bundled from
      `src/main.js` with `@vercel/ncc`; run `npm run build` after changing `src/`). `main.js`
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
        throwaway tmpfs **overlay** at the well-known guest path `/__w`; `workspace+toolcache` also mounts
        `RUNNER_TOOL_CACHE` read-only at `/__t` (opt-in — the glibc/ABI caveat still applies;
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
        RO read at the guest mount path, overlay write succeeds, toolcache write + remount-rw both blocked
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
- [x] **Copilot inference in-guest** — VALIDATED via `agent-e2e.yml` on `ubuntu-latest`
      (`permissions: copilot-requests: write`): real microVM boots, the standalone Copilot CLI
      authenticates and runs the prompt inside the guest, streams live to the step log, and drives the
      `/__mcp` shim → dispatch → safe-output → GitHub. Green runs: issues #11, #12 (`documentation`),
      #13 (`bug`). Wired in `guest-assets.js` init + `gw_addon.py` (`COPILOT_GITHUB_TOKEN` fake in
      guest, `S2STOKENS=true`, `GITHUB_COPILOT_INTEGRATION_ID`, gateway swap). Can't run locally (the
      Codespace token lacks the `copilot-requests` scope) — only via a workflow run.
- [x] **Egress:** `firewall-allow` is threaded into the gateway egress allowlist (`EGRESS_ALLOW` in
      `gw_addon.py`, reachable with NO credential injected) on top of the deny-all baseline in
      `network-up.sh`; credential swaps are lane-bound (`GW_LANES`, decision A).
- [x] **Teardown + outputs:** `main.js` stops the gateway + dispatch and runs `network-down.sh` in a
      `finally`, sets the `status` output, and honors `timeout-minutes` via the boot timeout.
- [ ] **Package:** tag `v0`, keep the `examples/` file as docs, document required permissions.
      (Action is runnable now; `agent-e2e.yml` demonstrates required permissions.)
- [x] **Prove end-to-end** — `.github/workflows/agent-e2e.yml` (`issues: opened` → this action with an
      add-labels safe output → label lands on the issue), in-repo on `ubuntu-latest`. **DONE:** multiple
      green runs (issues #11, #12 → `documentation`, #13 → `bug`). This is the primary regression check.

## Open questions — ALL RESOLVED (kept for the decision record)

- [x] **Default `github` server — DECISION: keep the host-side SHIM as default; native is technically possible but NOT adopted (security). Empirical test: native works — run 29666521676.**
  Ran `github-mcp-test.yml` (MV_GITHUB_MODE=native, dummy custom server, github-read prompt). Results:
  - **Native github read WORKS:** agent returned issue #8's real title (`GH_TITLE: Typo: 'recieve'…`)
    using its built-in github tools — **no** `Non-default MCP servers will be blocked`/403 line.
  - **Transport = built-in REMOTE server:** the read hit **`api.githubcopilot.com/mcp/readonly`**
    (read-only endpoint, chosen by the CLI automatically), authenticated via the gateway fake→real
    token swap. So it's form **(a)**: built-in, enabled by env, **no `mcpServers.github` entry needed**.
  - **Hosts dialed:** only `api.github.com` + `api.githubcopilot.com` — both already on the gw allowlist;
    **no new allowlist entry required.** (Contrary to the earlier worry about remote mode needing a PAT:
    the built-in remote github works because it rides the *copilot* auth via the gateway, not a raw
    Actions token to a github.com MCP endpoint.)
  - **Negative control was WEAK/inconclusive:** the dummy used `/bin/cat` (not a real MCP server), so it
    would drop regardless of policy — "not available" doesn't prove policy blocking. Q1 stands alone; the
    custom-server-blocked claim still rests on prototype-lessons.md.
  - **SECURITY nuance to weigh before flipping the default:** native mode currently also exports the fake
    token as `GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_PERSONAL_ACCESS_TOKEN` in the guest. Since the gateway swaps
    fake→real for ANY allowlisted host (incl. `api.github.com`), a guest `gh`/`git`/`curl` to api.github.com
    would be upgraded to the REAL token — and the default `${{ github.token }}` is write-scoped. This
    api.github.com swap is a **pre-existing** property (COPILOT_GITHUB_TOKEN=fake was always present), but
    broadcasting more token env vars widens it. Decide: (i) does the built-in github work with ONLY
    COPILOT_GITHUB_TOKEN (drop the extra vars → least privilege)? and (ii) should api.github.com be removed
    from the guest egress allowlist / the swap be scoped to api.githubcopilot.com only, so the guest can't
    upgrade a fake token into real write access?
    - **UPDATE (decision A, DONE):** (ii) is now closed — the gateway is lane-bound; the real credential is
      swapped ONLY on `api.githubcopilot.com` + `api.github.com/copilot_internal/`, and every other
      `api.github.com` path is deny-by-default (403). A guest can no longer upgrade the fake into the
      write-scoped token. (i) — dropping the extra native token vars — remains part of the deferred
      hardened-native variant.
  - **DECISION (supersedes any "flip to native" note): keep `githubMode` default = `shim`.** Native is an
    **exfil/escalation vector as currently built**: it requires a **guest-held github credential** (the
    fake, gateway-swapped) and leans on the gateway not being blunt — a guest `curl` to `api.github.com`
    gets the **write-scoped** token swapped in. The `mcp/readonly` endpoint only limits writes *through
    that one endpoint*; it does **not** close the `api.github.com` write-swap. **Shim keeps ZERO github
    credential in the guest** (real token host-side in the docker container, `GITHUB_READ_ONLY=1`), so it
    is strictly stronger — see the finalized "Design decisions" section (A/C). Native stays
    **experimental (`githubMode: native`), deferred** until a hardened variant (read-only *downscoped*
    credential bound to a *distinct* MCP host, extra token vars dropped, `api.github.com` write-swap
    closed). **Do NOT flip the default.** `github-mcp-test.yml` + MV_GITHUB_MODE/MV_EXTRA_GUEST_MCP remain
    the test harness.
- [x] **Shim ↔ host dispatch contract (RESOLVED).** A guest shim POSTs `{"tool","args"}` to the host
  dispatch at `http://172.16.0.1:9000/dispatch`; the dispatch forwards it as an MCP `tools/call` to
  the host-side server that advertises that tool. Tool names are discovered by launching each server
  and calling `tools/list` at startup (`src/dispatch.js` / `src/mcp-client.js`). Validated locally
  end-to-end (including through a real microVM).
- [x] **Node build from a Codespace (RESOLVED, then UPDATED 2026-07-19).** Originally zero-dep (no bundle);
  now the action has deps and is bundled with `@vercel/ncc` into `dist/index.js` (committed). Build in a
  Codespace with `npm run build` (don't build on @ericsciple's local machine).

## Prebuilt images: images repo, kernel, rootfs, mounted Copilot

Move off per-run rootfs build. Ship curated Firecracker guest artifacts and fetch/mount them (kernel +
bare rootfs + Copilot). This resolves the "prebuilt-image decision" the gateway options above defer to.
Firecracker only for now. (Design refs, in the planning repo: `adr-base-image-distribution.md`,
`adr-microvm-action.md`.)

**Status (DONE 2026-07-19):** implemented + validated locally (full boot: stub -> /__rt -> init.sh ->
copilot mounted at /opt/copilot -> reached inference `api.githubcopilot.com/v1/messages` through the
lane-bound gateway). Real-token e2e via agent-e2e.yml.

- [x] **New images repo** — `ericsciple/microvm-images` (created). Publishes `vmlinux` + `bare-rootfs.ext4.zst`
      (+ `SHA256SUMS`, `images.json`) as **GitHub Releases** (release `v0.0.1` cut). Build scripts
      (`scripts/build-kernel.sh`, `scripts/build-rootfs.sh`) + a `release.yml` workflow make assets
      reproducible. The action pins a release tag (kernel + rootfs move together as a known set) via the
      `images-tag` input.
- [x] **Kernel (hard-coded for now).** Pinned x86_64 Firecracker CI `vmlinux-6.1.176` (6.1 LTS), recorded
      in `images.json`, published **zstd-compressed** (`vmlinux.zst`, 43M -> 9.4M); the action decompresses
      once (cached). No customer choice / enum yet.
- [x] **Bare rootfs (bare tier only).** Debian bookworm-slim ext4 with the guest-init + Copilot runtime deps
      (`iproute2`, `util-linux`, `procps`, `ca-certificates`, `curl`, `jq`, `git`, **`libstdc++6`**). NO
      Copilot/shims/event/CA baked. glibc **2.36** recorded. Ships a generic `/init` stub that mounts the
      per-run runtime config drive (vdb) and execs `/__rt/init.sh`. (Correction to the original note: the
      list needed the runtime deps + `libstdc++6`, not just "shell+jq+curl+git" — the Copilot binary NEEDs
      `libstdc++.so.6` + `libgcc_s.so.1` in addition to glibc.)
- [x] **Fetch + mount** (now via **`@actions/tool-cache`** in `src/artifacts.js` — updated 2026-07-19 when we
      adopted deps; was previously a hand-rolled curl/fs cache in provision.sh): pinned kernel + bare rootfs
      (from the images release) + the Copilot tarball, downloaded/decompressed/extracted and cached under
      `RUNNER_TOOL_CACHE` (warm-after-first-use). The bare rootfs is decompressed once; `main.js` boots a
      per-run sparse copy so the cache stays pristine. **Copilot is mounted** at
      `/opt/copilot` with a **discard overlay** (RO lower + tmpfs upper — not pure RO, per @ericsciple: tools
      may write into their install dir) and put on PATH; not baked. Install-type mounts (copilot, workspace,
      tool cache) all use the discard overlay now; `/__mcp` stays pure RO (tamper-proof shims).
- [x] **Rootfs compatibility contract (constraint + detection).** Optional `rootfs` input (default = fetched
      bare rootfs). Contract: **x86_64 + glibc >= 2.28 + libstdc++.so.6** (musl/Alpine unsupported). **glibc
      floor = 2.28**, measured off the pinned Copilot build (highest GLIBC symbol needed). **Preflight**
      (`preflightRootfs` in main.js) reads the rootfs ext4 with `debugfs` (no mount): rejects musl / missing
      libstdc++ / glibc < 2.28 with an actionable error, before boot.
- [x] **Open items (resolved):** repo name = `microvm-images`; glibc floor X = **2.28**; kernel provenance =
      vendor the pinned Firecracker CI kernel (6.1.176); ext4 compression = **zstd -19** (~38 MB), kernel
      likewise (`vmlinux.zst`, 9.4 MB); the images repo + tag are **hardcoded** in `main.js` (a version of
      the action maps to a known {kernel, rootfs} set) — NOT user inputs; only a `rootfs` override input
      remains. Copilot build: still fetched as `latest` (cached) — pinning an exact Copilot version is a
      future nicety.

## Options on the table (future)

- **Downscope the github MCP toolsets by default (one-job least-privilege gap).** gh-aw splits work
  across jobs so the *agent* job gets a minimal (read-only) token while a separate job holds the write
  scope. We **collapse everything into one job/step**, so the single `GITHUB_TOKEN` must carry the
  **union** of permissions (write, for safe outputs) — meaning the agent step runs alongside a
  broader-than-it-needs token. Mitigations already in place: the guest holds **no** token (gateway), and
  the default github MCP is **read-only** (`GITHUB_READ_ONLY=1`). But the read surface is still wide —
  `GITHUB_TOOLSETS=default` exposes the full default read toolset (issues, PRs, repo contents, code
  search, …), and the job token's *read* scope is whatever the workflow granted. Consider a **safer
  default**: ship a narrower default toolset (e.g. only what a triage agent needs), expose a
  `github-toolsets` input for authors to widen deliberately, and document minimizing job `permissions:`.
  Weigh usability (too narrow → the agent can't see what it needs) vs. least privilege. (`src/mcp-config.js`
  `GITHUB_TOOLSETS`/`GITHUB_READ_ONLY`.)

- **Agent → Actions error surfacing (guest-side helper scripts; no MCP needed).** The agent needs a way
  to surface errors/warnings inline and to declare failure, the Actions-native way. **Preferred design:
  tiny guest-side helper scripts** (`report-error`, `report-warning`, `report-notice`,
  `report-incomplete`) in a **harness-owned dir, OFF-PATH** (consistent with the `/__mcp` shims — not on
  PATH, so they don't shadow real tools), delivered per-run (on `/__rt` or `/__mcp`, granted via
  `--add-dir`; NOT baked into the prebuilt rootfs). Each takes the raw message as an arg and does the
  workflow-command **escaping** (`%`→`%25`, `\r`→`%0D`, `\n`→`%0A`) so the **agent never hand-formats**
  `::error::` (the fragile part). The script prints `::error::<escaped>` to the guest console → the stdout
  allowlist filter (below) passes it → the runner renders it **inline**. All **guest-side, no dispatch
  round-trip.**
  - **Well-known env vars for the tool dirs (no hardcoded paths).** Surface both the MCP shims dir and the
    helpers dir via well-known env vars — `$MV_MCP_DIR`, `$MV_HELPERS_DIR` (names open) — exported into the
    guest (agent.env). Authors/prompts then use `"$MV_MCP_DIR/<server>"` and `"$MV_HELPERS_DIR/report-error"`
    instead of hardcoding `/__mcp` / the helper path, so we can change the actual dir names freely. **Also
    fix the existing preamble**, which hardcodes `/__mcp` (`generateMcpPreamble`) → use `$MV_MCP_DIR`.
    (Could colocate both in one dir + one var; two keeps forwarders vs. local helpers distinct.)
    **Folder name:** `$MV_HELPERS_DIR = /__helpers` (matches `/__w`/`/__t`/`/__mcp`/`/__rt`); must be
    `--add-dir`'d so the CLI can execute the helpers. **Decided: colocate on `/__rt` as `/__rt/helpers`**
    (skips a virtio drive for a few tiny scripts; env var hides the path). `MV_HELPERS_DIR` (not
    `MV_TOOLS_DIR`) avoids confusion with the tool cache.
  - **Move `event.json` from `/__mcp` → `/__rt`.** It's per-run agent *context* (data), not a tool, so it
    belongs with `/__rt`'s prompt/env/config; `/__mcp` becomes shims-only. Transparent (agent reads it via
    `$GITHUB_EVENT_PATH`). Also **simplifies mount logic**: `/__mcp` is then created only when there are
    MCP servers (today `harnessHasContent` also forces it just to carry event.json), while `/__rt` always
    exists. Requires `--add-dir /__rt` (granted anyway for `/__rt/helpers`; safe — `/__rt` is all
    non-secrets: fake token, public CA, prompt, no-secret mcp-config). (`src/main.js:199-201`.)
  - **Status signal is the one thing needing the host.** Printing `::error::` can't fail the step (that's
    microvm-agent's exit code, not a message). `report-incomplete` (name open: `report-failure`/`fail`,
    asymmetric fail-only — success is the default) prints an `::error::` **plus a machine-readable
    sentinel**; microvm-agent's **console grader already reads the console**, detects the sentinel, and
    does `setFailed`. So even this is a guest helper + the existing grader — **no diagnostics MCP.** (An
    in-process MCP dispatch handler stays a possible alternative if we later want structured
    outputs/aggregation, but helper+sentinel is simpler and meets the requirement.)
  - **How step success/fail actually works (result model).** GitHub Actions decides a step's result
    purely from the **exit code of the step process** — for us `node dist/index.js` (microvm-agent), NOT
    the guest agent. `core.setFailed()` = `process.exitCode=1` + an `::error::` annotation. **There is no
    `::set-result::` workflow command.** The Copilot CLI's exit code lives in the guest and surfaces via
    the console (`=== GUEST: AGENT_EXIT=$? ===`). microvm-agent grades in three layers: (1) infra/boot
    failure → fail; (2) **guest agent exited non-zero** → fail (read `AGENT_EXIT` — see gradeConsole bug
    below); (3) **agent exited 0 but couldn't do the job** → the agent declares via `report-incomplete`
    (neither exit code nor a workflow command can express "ran fine but unachievable").
  - **Preamble edit required.** `generateMcpPreamble` (`src/guest-assets.js`) must add a short
    **behavioral** instruction — "if you cannot complete the task, run `\"$MV_HELPERS_DIR/report-incomplete\"
    \"<reason>\"`" (+ report-error/report-warning to surface problems). The agent needs to be told *when*
    to use them. Deliberate exception to the tiny-preamble rule (1–2 lines).
  - Why these are **not** safe outputs: `safe-outputs/docs/parity-gh-aw.md` §2/§2.1 — safe-outputs =
    optional GitHub-write MCP; error surfacing = harness built-in.

- **Consider a prompt-file input.** Today `prompt` is an inline string input (verbose in YAML for long
  prompts, no syntax highlighting, awkward to reuse/version). Consider adding a `prompt-file` input (a
  path, e.g. a Markdown file in the repo, whose contents become the prompt) — and/or supporting the
  gh-aw-style convention of authoring the prompt as a Markdown file. Decide precedence if both `prompt`
  and `prompt-file` are given, and how the MCP preamble composes with a file-sourced prompt.

- **Evaluate whether to deprecate / relate to `actions/ai-inference`.** `actions/ai-inference` is
  GitHub's action for a single GitHub Models inference call (prompt → completion; no tools, no sandbox,
  no safe outputs). microvm-agent is a full sandboxed *agentic* harness (tools, MCP, egress firewall,
  safe outputs). Question: are they complementary (simple inference step vs. sandboxed agent) or does
  microvm-agent's direction overlap enough to supersede it for some use cases? Decide positioning — not
  necessarily a deprecation, could just be guidance on when to use which. (Verify the current scope of
  `actions/ai-inference` before deciding.)

- **Benchmark Firecracker startup vs. a Docker-sandbox (SBX) approach.** Measure end-to-end
  time-to-agent-running for our Firecracker microVM path vs. running the agent in a Docker container
  sandbox (à la gh-aw's AWF: container + squid egress proxy, no hardware VM). Compare: boot/startup
  latency (we've seen Firecracker boot ~1.3s + rootfs/mount build), per-run overhead (image pulls vs.
  our fetch+mount), warm-cache behavior, and the security tradeoff (hardware-VM isolation + zero-cred
  guest vs. shared-kernel container). Goal: quantify what the microVM isolation costs us in startup so
  we can decide where each model fits.

- **Reconsider the zero-dependency stance — adopt a few well-maintained deps. [DONE 2026-07-19]**
  The action WAS zero-dependency ESM; hand-rolling common things meant missing upstream security updates.
  @ericsciple: "Having dependencies for common things means we actually get security updates, etc."
  **Adopted** (bundled with `@vercel/ncc` -> `dist/index.js`, `runs.main: dist/index.js`; `npm run build`
  regenerates it; `node_modules` gitignored, `dist/` committed):
  - **`@actions/core`** — `src/inputs.js` (getInput), outputs (`setOutput`), failure (`setFailed`), logging.
  - **`@actions/exec`** — `runScript` + the firecracker boot (live command tracing to the step log).
  - **`@actions/tool-cache`** — `src/artifacts.js` fetches/decompresses/extracts + caches kernel, rootfs,
    Copilot under `RUNNER_TOOL_CACHE` (warm-after-first-use). `provision.sh` slimmed to host setup.
  - **`@modelcontextprotocol/sdk`** — `src/mcp-client.js` now uses the official `Client` +
    `StdioClientTransport` for the initialize/tools handshake (dispatch API unchanged).
  - **Dependency trust bar (@ericsciple's rule, kept for future deps):** only take a production dependency
    on something **trusted, reliable, high-use** — prefer first-party `@actions/*`; a non-toolkit dep must
    clear the same bar (reputable org, large downloads, active maintenance). All four cleared it (verified
    downloads/provenance). `@actions/exec` also added per @ericsciple (nice console tracing).
  - Follow-up: **safe-outputs is an MCP server/CLI, NOT a GitHub Action** (@ericsciple flagged this) — the
    `@actions/*` toolkit does **not** apply to it (no `INPUT_*`/`GITHUB_OUTPUT`/`RUNNER_TOOL_CACHE` there).
    The only relevant dependency for it is the **server side of `@modelcontextprotocol/sdk`** (`Server` +
    `StdioServerTransport`) to replace the hand-rolled protocol in `safe-outputs/src/mcp.js` — same official
    SDK, same trust bar; optional. (Its tiny `safe-outputs/setup/` Node action is the only actual Action in
    that repo, where `@actions/*` could apply, but it's ~50 lines and intentionally minimal.)
  - A CI check that `dist/` is in sync with `src/` (rebuild + `git diff --exit-code`) would prevent drift.

- **Node-native TLS-intercepting gateway (drop the mitmproxy/Python dependency).** Today the
  credential gateway is `mitmproxy` (`mitmdump` + `gw_addon.py`), which the harness installs at
  provision time (pip/pipx). Replacing it with a small Node-native TLS-terminating forward proxy
  (generate a CA once, MITM `:443`, do the fake→real token swap + egress allowlist in JS) would make
  the harness **fully self-contained** (Node-only, no Python/pip install) and shave provisioning time.
  **Wanted**, provided it doesn't drastically bloat the guest/host footprint. Risks to weigh: correct
  TLS termination + SNI/ALPN handling, CA trust in the guest (same as today), HTTP/2, and streaming.
  A dependency-light approach (built-in `node:tls`/`node:http2` + a tiny cert-gen) is preferred over a
  heavy proxy library.
  - **Research findings (2026-07-18).** The decisive constraints are (1) upstream **HTTP/2** — Copilot
    inference on `api.githubcopilot.com` uses h2 + SSE streaming; and (2) our gateway runs
    **`--mode transparent`** (iptables REDIRECT `:443`→`:8080`, guest holds no `HTTPS_PROXY` and can't
    opt out). Nearly every alternative is disqualified by one of these:
    - **Node libs:** only **`mockttp`** (httptoolkit, Apache-2.0, ~434k dl/wk, Node≥20, real h2 in+out via
      `http2-wrapper`+`httpolyglot`, CA + per-SNI leaf gen, request rewriting) is viable. `http-mitm-proxy`,
      `proxy-chain`, `http-proxy`, `hoxy` are all **HTTP/1.1-only or not MITM** → would break inference.
    - **Binaries:** **`go-mitmproxy`** ships a ~3.8 MB Linux binary with h2+SSE, but has **NO transparent
      mode** and credential swap needs a custom Go plugin. `martian` (archived), `goproxy`/Caddy
      (library/custom-build) rejected. mitmproxy's own standalone PyInstaller binary is **~119 MB**
      (`downloads.mitmproxy.org/12.2.3/mitmproxy-12.2.3-linux-x86_64.tar.gz`, verified — not on GitHub
      releases; embeds its own Python).
    - **Pure Node built-ins:** feasible (~500–700 LOC) but needs two small trusted deps — **`selfsigned`**
      (17.9M dl/wk; Node stdlib can't sign X.509) + **`http2-wrapper`** for upstream h2. `node-forge` is
      unmaintained — avoid.
    - **The catch for ALL of them:** mockttp / go-mitmproxy / pure-Node all require **explicit proxy mode**
      (set `HTTPS_PROXY` in the guest, or handle `SO_ORIGINAL_DST` which Node lacks). Only mitmproxy
      preserves our current transparent, un-opt-out-able interception out of the box.
    - **Recommendation: DEFER (host-side concern, independent of the guest prebuilt images).** The
      motivation is dropping the per-run `pip install mitmproxy` — a **HOST** dependency. NOTE (correcting an
      earlier conflation): mitmproxy runs on the host, so the prebuilt **guest** kernel/rootfs work does
      **not** touch it. The clean way to drop the per-run install is to **bundle mitmproxy host-side** (see
      the next item), which keeps transparent mode. Only build a Node/other gateway if we specifically want
      **zero Python on the host**, in which case **mockttp (explicit proxy mode)** is the top pick.

- **Bundle mitmproxy with the action (drop the per-run `pip install`, keep transparent mode).** Today
  `provision.sh` runs `pip install mitmproxy` (needs host Python+pip+network, compiles native wheels).
  Three ways to bundle it instead, in order of preference:
  1. **⭐ Standalone binary from the images release** — now that the guest rootfs is prebuilt (no docker on
     the default path), the tidiest option is to publish the mitmproxy PyInstaller binary (~119 MB, embeds
     its own Python) as a `microvm-images` release asset and `curl` + cache it in `provision.sh` (exactly
     like the kernel/rootfs). **Zero host Python, no docker.** Keeps `--mode transparent`. Compresses well
     for the asset. Preferred because it fits the fetch-and-cache pattern we already use.
  2. **Official Docker image** — `docker run --network host -v <gw_addon.py> … mitmproxy/mitmproxy:12.2.3
     mitmdump …` (pinned; ~103 MB). No host Python, no ABI drift. BUT docker is **no longer** otherwise
     required on the default path (rootfs is prebuilt; the github-mcp shim is the only remaining docker
     use, and only in shim mode), so this would re-introduce a docker dependency. `--network host`
     preserves transparent mode; pass `GW_LANES`/`EGRESS_ALLOW` via `-e`, volume for `GW_LOG_DIR`.
  3. **Vendor `cp312-manylinux` wheels / a frozen venv** + `pip install --no-index` → requirement becomes
     a **specific Python minor** (fragile: a cp312 wheel breaks on a future 3.13 runner). Least preferred.

## Key correctness notes

- **[BUG — grading gap] `gradeConsole` ignores the agent's exit code.** `gradeConsole` (`src/main.js:362`)
  returns "completed" whenever the console contains `GUEST: starting copilot` — it does **not** check the
  `=== GUEST: AGENT_EXIT=$? ===` line the init script emits (`src/guest-assets.js:181`). So a Copilot CLI
  that **starts and then crashes** (non-zero exit) currently grades as **success** and the step passes.
  Fix: parse `AGENT_EXIT=N` and treat non-zero as failure (result-model layer 2, above). This is
  independent of the diagnostics MCP (layer 3, the exited-0-but-unachievable case).

- **[BUG — security] Guest console is streamed raw to the action's stdout → workflow-command injection.**
  `bootVm` runs firecracker via `exec.exec`, which echoes the guest serial console to the step's stdout
  (live logs). But the runner interprets **any** `::command::` line on stdout, so a compromised/
  hallucinating guest could emit `::set-output::`, `::add-path::`, `::save-state::`, `::add-mask::`,
  `::stop-commands::`, etc. **Fix (preferred): an allowlist filter.** Stop `exec.exec` echoing raw
  (`silent: true` + our own listener) and have microvm-agent process guest stdout/stderr **line by
  line**, re-emitting to `process.stdout`:
  - **Allow** informational, no-capability commands through verbatim (so errors surface **inline**):
    `::error::`, `::warning::`, `::notice::`, `::debug::`, `::group::`/`::endgroup::`.
  - **Neutralize** everything else (capability/state changes): `::set-output::`, `::save-state::`,
    `::add-path::`, `::set-env::`, `::add-mask::`, `::stop-commands::`, `::echo::`, … — escape the line
    so the runner doesn't interpret it.
  This is better than the blunt `::stop-commands::<token>` wrap (which would suppress `::error::` too):
  the allowlist **keeps inline error/warning while blocking injection**, and pairs with the diagnostics
  MCP above (which owns the status-affecting `report_incomplete`). (`src/main.js` `bootVm`.)

- **[BUG — latent] mcp-config server names are unvalidated but used verbatim as the `/__mcp/<name>`
  shim filename** (`src/main.js` `path.join(harnessSrc, name)`) **and referenced in the prompt.** A name
  containing `/` (or other unsafe chars) breaks shim generation with no clear error. Fix: validate each
  server name at parse time against a safe charset (`[A-Za-z0-9._-]`, length-capped) and reject with an
  actionable error. (Also a prerequisite for the safe-outputs op-count `MCP_STATE_DIR` design, which
  reuses the name verbatim as a per-instance state-dir segment — see
  `safe-outputs/docs/parity-gh-aw.md` §3.1.)
- **[FUTURE] Per-MCP-server scratch dir (`MCP_STATE_DIR`).** For safe-outputs run-wide op-count limits,
  the harness should give **every** host MCP server a private per-(step, instance) dir via a generic
  `MCP_STATE_DIR` env var = `${RUNNER_TEMP}/mcp-state/${STEP_GUID}/${serverName}` (GUID minted once per
  run; removed in teardown). Generic primitive, not safe-outputs-specific. See parity doc §3.1(1).

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
- **Bundled ESM action.** `src/*.js` (ESM) is bundled with `@vercel/ncc` to `dist/index.js`, which
  `runs.main` points at. Deps: `@actions/core`, `@actions/exec`, `@actions/tool-cache`,
  `@modelcontextprotocol/sdk`. Rebuild `dist/` with `npm run build` after changing `src/`.

## Design decisions — guest security model, MCP delivery, discovery (finalized 2026-07-18)

Captured from a design review. These supersede the "shim everything incl. github via docker" phrasing
of the reopened github item above where they conflict; read this section as the source of truth.

**Implementation status (2026-07-18):**
- [x] **B (DNS pinning)** — network-up/down.sh pin egress :53 to one resolver (MV_DNS_RESOLVER); guest
  resolv.conf threaded. (Stronger allowlisted-name host resolver still deferred.)
- [x] **C/D/E (MCP delivery + off-PATH shims + lazy discovery)** — one shim per server at `/__mcp/<server>`,
  delivered via a READ-ONLY `/__mcp` virtio-block mount (not baked); OFF $PATH (absolute path), CLI granted
  `/__mcp` via `--add-dir`. Lazy per-server tools/list (cached host-side); host-side `convertArgs`; preamble
  lists servers + `$GITHUB_EVENT_PATH`; event.json rides the `/__mcp` mount. Mounts stay `__`-prefixed
  (`/__mcp`,`/__w`,`/__t`), no host-path mirroring. Validated via unit tests + a real-microVM run
  (`/__mcp/labeler --help` lazy-listed, `add_labels` applied) AND the full agent-e2e (issue #11 -> label).
  E-minor: dispatch keeps tool `description`. **NOTE:** github still runs as a host-side docker shim in
  the default `shim` mode (per the github decision); one-shim-per-server + lazy startup means the github
  container is only launched on first `/__mcp/github` use.
- [x] **A (gateway per-lane sentinel binding)** — DONE. `gw_addon.py` reworked to a per-lane
  sentinel↔credential model (`GW_LANES`): the inference sentinel is swapped for the real credential
  ONLY on `api.githubcopilot.com` + `api.github.com` `/copilot_internal/` (token exchange); every other
  `api.github.com` path is deny-by-default (403); a sentinel seen off its lane (EGRESS_ALLOW host, other
  path) is rejected as misuse. `EGRESS_ALLOW` hosts (`api.mcp.github.com` + firewall-allow) are reachable
  with NO credential injected. Closes the write-escalation hole (guest `curl api.github.com/...`+sentinel
  can no longer obtain the write-scoped job token). Covered by `test/gw_addon_test.py` (10 cases) and
  validated via an agent-e2e run.
  - **Empirical audit (run 29670863410, issue #13 -> `bug`):** real credential swapped ONLY on
    `api.githubcopilot.com` (`/mcp/readonly`, `/models`, `/v1/messages`); ZERO swaps on `api.github.com`.
    Deny-by-default 403'd `api.github.com /repos/github/copilot-cli/releases/latest` (CLI self-update
    check) and `api.github.com /copilot/mcp_registry` (MCP policy probe) — both benign/tolerated; the
    agent still triaged + labeled. Note: with `S2STOKENS`+integration-id the Copilot token exchange
    happens server-side at `api.githubcopilot.com`, so the `/copilot_internal/` allowance wasn't even
    exercised in this run (kept as a safety net).

### A. Gateway invariant (the ceiling principle)
The guest can influence **nothing** about a trusted lane — not the upstream host, not the credential,
not its scope (read/write), not the enabled tool set. The gateway/firewall/servers define the ceiling;
the guest may only operate at or below it. Concretely:
- **Per-lane sentinel↔credential binding.** Use a *distinct* fake token ("sentinel") per lane, each
  mapped to exactly one real credential + one destination (and path where needed). Never cross-apply a
  sentinel across lanes. (Today `gw_addon.py` uses ONE fake→ONE real for every allowlisted host — the
  hole; a guest `curl`+fake to `api.github.com` gets the write-scoped job token. Fix this.)
- **Never inject a write-capable credential for any guest-reachable request.** The write (job) token is
  used ONLY host-side by safe-output servers; the guest has no path to it.
- **Inference lane:** swap the sentinel only on `api.githubcopilot.com` + the specific Copilot
  *token-exchange path* on `api.github.com`; reject other `api.github.com` paths; present an
  inference-scoped credential there, not the full job token.
- This is a deliberate, **stronger divergence from gh-aw**, which trusts its OS sandbox and (in default
  mode) hands the agent the real token.

### B. Firewall vs gateway (how URL/destination is actually pinned)
- Guest `:443` is **REDIRECTed to the host gateway** (`nat PREROUTING … --dport 443 REDIRECT :8080`);
  it does NOT traverse the FORWARD allowlist. The **gateway** (`gw_addon.py` `ALLOW`) enforces the
  HTTPS destination allowlist; **iptables** forces all `:443` into the gateway and DROPs everything else
  (deny-by-default), making the gateway **unbypassable**.
- Therefore the guest has **zero control over the inference URL**: even with full URL control it can only
  reach allowlisted GitHub hosts. **Do NOT adopt gh-aw's guest-settable base-URL (BYOK) approach** — keep
  transparent interception.
- **Tighten DNS:** `network-up.sh` currently allows `:53` to ANY resolver → a DNS-tunneling exfil
  channel (no token needed). Pin DNS to a specific resolver, or run a host-side resolver that only
  answers allowlisted names.

### C. MCP delivery — all servers host-side, exposed as CLIs
- **Every** MCP server (safe outputs, third-party, AND github) runs **host-side**; the guest gets only
  thin forwarder shims → host dispatch. Nothing with a credential or policy decision lives in the VM.
  This is both the 403 workaround (non-default MCP servers blocked in-guest, transport-agnostic) AND
  security-aligned (servers + creds outside guest control).
- **github stays a host-side shim for the prototype** (guest holds NO github credential; no
  `api.github.com` write swap). Native-in-guest github is deferred until a *hardened* variant exists: a
  **read-only, downscoped** github credential bound to a **distinct** github-MCP host, so even full guest
  control of that lane can't exceed read. (The `github-mcp-test.yml` result informs feasibility, but the
  security invariant, not the 403 test, is the deciding factor.)
- **One shim per SERVER**, not per tool: `<server> <tool> <args>`. The server name namespaces tools
  (avoids cross-server tool-name collisions) and bounds the file count. (Currently one-per-tool in
  `main.js` — change.)

### D. Shim + injected-artifact location
- **Shims do NOT go on `$PATH`** — avoids shadowing real CLI tools in either direction. Put them in a
  **harness-owned, read-only, off-PATH directory** (suggested `/__mcp`, echoing the runner's `__w`/`__t`
  convention), surfaced via an env var + the preamble. A **read-only mount** makes integrity
  hypervisor-enforced (agent can't tamper) — stronger than gh-aw's `chmod 555`.
- **Event payload:** inject ONLY the single `event.json` (never `RUNNER_TEMP` — it holds the
  `actions/checkout@v7` push token) into a well-known harness location and set the standard
  **`GITHUB_EVENT_PATH`** env var to it. Default ON, independent of the mount enum. It can ride the same
  small read-only "harness config" mount as the shims.
- **All guest mounts use `__`-prefixed well-known paths — NO host-path mirroring** (matches the built
  code: `main.js` `GUEST_WORKSPACE_PATH="/__w"`, `GUEST_TOOLCACHE_PATH="/__t"`). Workspace -> `/__w`,
  toolcache -> `/__t` (Actions container-job convention), with `GITHUB_WORKSPACE`/`RUNNER_TOOL_CACHE` set
  to match and only the tool-cache PATH entries rewritten to `/__t` (`src/paths.js`); shims -> `/__mcp`;
  `event.json` surfaced via `GITHUB_EVENT_PATH`. We do **not** mount at identical host paths — an earlier
  draft (in this doc and the base-image notes) proposed that to skip PATH translation, but it was
  **rejected**; the guest never mirrors host paths.
- Deliver these per-run artifacts via a small **read-only mount** (fits prebuilt base images; don't bake
  per-run shims into the rootfs).

### E. Tool discovery — lazy / piecemeal (token- and time-efficient)
- **No startup `tools/list`, no giant manifest JSON.** Generate the shims from the **server list
  (config) alone**.
- **Preamble (tiny, ~4–6 lines):** state it's an isolated microVM; point to `$GITHUB_EVENT_PATH` for run
  context; list the tool **servers** + a one-line description each + "run `<server> --help`"; then the
  user prompt.
- **Lazy detail:** `<server> --help` / `<server> <tool> --help` resolve tool lists/schemas **on demand**
  via dispatch → `tools/list` for that one server, **cached** host-side. Detail is pulled only for tools
  the agent actually uses.
- **Lazy server startup:** don't boot a server (e.g. the github docker container, if used) until first
  invoked.
- This can be **more token-efficient than native MCP**, which front-loads every tool's schema into
  context each turn. Also: keep the tool `description` from `tools/list` (`dispatch.js` currently drops
  it).

### F. Copilot auth (confirmed — no change)
Default (non-BYOK) Copilot path: `COPILOT_GITHUB_TOKEN` (fake in guest, swapped at the gateway) +
`S2STOKENS=true` + `GITHUB_COPILOT_INTEGRATION_ID=agentic-workflows` + `COPILOT_AGENT_RUNNER_TYPE=STANDALONE`
+ `XDG_CONFIG_HOME`. Matches gh-aw's default. gh-aw's `byok-copilot` (dummy `COPILOT_API_KEY` + custom
`api-target` base URL) is the future **multi-provider / agent-agnostic** seam — not needed now, and we do
NOT want its guest-settable base URL (see B).
