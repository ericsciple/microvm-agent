# Task: settle GitHub MCP as **native-in-guest** vs **CLI-shim**, then wire accordingly

**Status: this REVISES the "Default `github` server — RESOLVED" item in `TODO.md`.** Treat that item
as *provisional*. Do the test below FIRST; it decides the final wiring. Do not hard-code the
host-side `docker github-mcp-server` + shim path until the test says you must.

## Background (what we already know)

From the proven prototype (`docs/prototype-lessons.md`, "MCP registry policy"):

- The standalone Copilot CLI **blocks non-default (custom) MCP servers** whenever it can't fetch the
  MCP registry policy — which **403s with an Actions `GITHUB_TOKEN`** — **regardless of transport
  (stdio or http)**. Log line:
  `Failed to fetch MCP registry policy: 403 Forbidden. Non-default MCP servers will be blocked…`
- **The default `github` server is unaffected** by that 403.

Implications:

1. **Custom servers (safe outputs + third-party) must stay CLI shims** — the 403 is transport-agnostic,
   so there is no native-MCP path for them in the guest. This is already what `src/mcp-config.js`
   does, and it is correct.
2. **`github` is probably the exception**: because the *default* `github` server is unaffected, it can
   likely be a **native MCP server inside the guest** — which is also exactly what gh-aw does (gh-aw
   keeps `github` native and **never** CLI-mounts it; only `safeoutputs`/`mcpscripts` are always-CLI and
   other servers are opt-in dual-access). What we have NOT yet proven is the github **read lane actually
   returning data** through the host gateway. That's the gap this task closes.

So the earlier "shim github via a host-side `docker ghcr.io/github/github-mcp-server`" idea is a
*fallback*, not the preferred design. Prefer **native github in the guest** if the test confirms it.

## The test (run in a workflow with `copilot-requests: write`)

Goal: empirically answer "can `github` be a native MCP server in the guest, returning real data, with
no 403?" and "how is the default github server actually configured?"

You can run this from `microvm-agent`'s own workflows (they're allowed here) or from an org repo — it
needs `permissions: copilot-requests: write` and a KVM `ubuntu-latest`. Reuse the proven gateway +
firewall recipes in `docs/proven-prototype/` (phase2 gateway = fake→real token swap; phase3 firewall).

Steps:

1. Boot the guest as in the proven prototype, with the credential gateway on the host (guest holds a
   **fake** `COPILOT_GITHUB_TOKEN`; gateway swaps to the real token on egress). Keep the egress
   allowlist from `gw_addon.py` (`api.github.com`, `api.githubcopilot.com`, `api.mcp.github.com`) — add
   any github-MCP host the CLI actually dials (see step 3).
2. In the **guest** MCP config, enable the CLI's **default `github`** server. Determine which of these
   the standalone CLI expects (this is itself an output of the test):
   - **(a) built-in toolset via env only** — no `mcpServers.github` entry at all; the CLI turns on its
     github tools from env (`COPILOT_GITHUB_TOKEN` / integration id). OR
   - **(b) an explicit `mcpServers.github` entry** — if so, capture its exact shape (transport + URL,
     e.g. an HTTP entry to `https://api.githubcopilot.com/mcp/`, reached through the gateway).
3. Prompt the agent to call a **github read tool** (e.g. "get issue #N in <owner>/<repo> and print its
   title") and capture:
   - whether it returns **real data** (native github read lane works in-guest), and
   - the **exact hosts** the request hits (so we can pin the egress allowlist), and
   - whether the `Non-default MCP servers will be blocked` / `403 Forbidden` log line appears for
     `github` (expected: it does NOT).
4. In the **same** run, register a **dummy custom stdio MCP server** in the guest config (any trivial
   server) and confirm it **IS** blocked (the 403 log line names it). This re-confirms custom servers
   must remain shims.

Capture the guest console + gateway log as artifacts either way.

## Decide + wire based on results

**If native github works (expected):**
- Keep `github` as a **native MCP server in the guest** (built-in default; shape per step 2).
  In `src/mcp-config.js`: replace the `githubReadOnlyGuestEntry()` placeholder with the real shape the
  test found, and **drop** the "host-side `docker github-mcp-server` + shim" plan for github.
- Keep the token out of the guest: the guest entry carries only the **fake** `COPILOT_GITHUB_TOKEN`;
  the host **gateway** swaps it to the real token on egress (same mechanism as inference). Confirm
  `assertNoSecretsInGuestConfig` still passes (no real token in the guest config).
- Enforce read-only: prefer the default github server's read-only behavior; if the CLI exposes a
  read-only knob for its default github server, set it. (We are NOT running `github-mcp-server`
  ourselves in this path, so `GITHUB_READ_ONLY=1` does not apply — read-only must come from the CLI's
  default-github configuration and/or the token scopes. Writes still go only through safe outputs.)
- Add any github-MCP host the CLI dials to the egress allowlist in `gw_addon.py`.

**Only if `github` is ALSO blocked by the 403 (unexpected):**
- Fall back to the previously-described design: run `ghcr.io/github/github-mcp-server` **host-side over
  stdio** (env host-side: `GITHUB_PERSONAL_ACCESS_TOKEN=<harness github-token>`, `GITHUB_READ_ONLY=1`,
  `GITHUB_TOOLSETS=default`, `GITHUB_HOST=$GITHUB_SERVER_URL`) and expose it to the guest via the
  existing **CLI-shim + dispatch** bridge, exactly like a safe output. Real token stays host-side.

## Also clarify (independent of the test result)

The current `src/mcp-config.js` behavior is: **only `github` is (or will be) native in the guest; every
other MCP server — safe outputs and third-party alike — is CLI-shim-only** (there is no dual-access /
native-MCP path for them, because the 403 is transport-agnostic). Keep it that way, and make it
**explicit** in code comments + the prompt the agent sees, so:
- the agent is told its custom tools are invoked as **shell commands** (shims on `$PATH`), not MCP tools;
- `github` is the one server it reaches as a **native MCP** server.

This is a deliberate divergence from gh-aw (whose CLI-mount is opt-in + dual-access, and which keeps
`github` native): for us, shimming custom servers is **mandatory**, forced by the standalone CLI's 403
on non-default MCP servers.

## Acceptance

- A workflow run showing the guest agent performing a **real github read** with no 403 (or, if it 403s,
  proof of that), plus proof a dummy custom server is blocked.
- `src/mcp-config.js` updated to the winning github path; `assertNoSecretsInGuestConfig` still green.
- Egress allowlist updated to whatever host(s) the github read lane actually uses.
- Code comments + agent prompt state the native-`github` / shim-everything-else split explicitly.
