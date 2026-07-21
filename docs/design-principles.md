# Core design principles — microvm-agent

> **These are core invariants, not style preferences.** They exist because breaking them
> silently (re)introduces security holes or architectural rot. An AI agent (or human)
> **must not modify, weaken, or work around any principle here without explicit human
> agreement** that (a) names the specific principle, and (b) acknowledges the change is a
> deliberate, heavy decision — not an incidental implementation choice. See
> [Changing a principle](#changing-a-principle).
>
> If a task seems to require violating a principle, **stop and surface it** — the
> violation is the finding, not an obstacle to route around.

## Why this doc exists

The harness runs an untrusted AI agent inside a microVM and lets it reach GitHub and
apply narrowly-scoped writes **without ever putting a credential in the sandbox**. That
guarantee is only as strong as its weakest seam. Several past bugs came from *quietly
special-casing* one feature (e.g. baking file-handling logic into the generic MCP shim,
or a per-tool helper script) — each one broke a principle below without anyone deciding
to. This document makes the invariants explicit so a reviewer can catch a violation on
sight.

---

## Security invariants

1. **The guest holds no real credentials.** The sandbox gets only fake stand-in tokens.
   Every real token (the job token, per-server secrets, the inference credential) lives
   host-side. A fully-compromised agent must not be able to read a real credential or
   escalate to a write-scoped API. (See `docs/architecture.md` §1, §4.)

2. **Egress is host-enforced and unbypassable.** All guest `:443` is redirected through
   the host credential gateway; default-DROP firewall on `tap0`; DNS pinned to one
   resolver. In-guest root cannot lift any of this.

3. **The credential gateway is lane-bound.** A real token is swapped in only on its
   allowlisted host + path prefix (inference). Every other `api.github.com` path is
   deny-by-default. The guest can never turn a fake stand-in token into the write-scoped
   job token.

4. **The untrusted guest console cannot inject workflow commands.** The guest serial
   console is filtered host-side: only informational annotations
   (`::error::`/`::warning::`/`::notice::`/`::debug::`/`::group::`) pass through;
   every other `::…::` (capability/state commands) is neutralized. (`src/console-filter.js`.)

5. **Nothing inside the guest is purely read-only; the host images stay pristine.**
   Every mount (shims, runtime config, workspace, tool cache, Copilot) is writable via a
   **throwaway tmpfs discard overlay**, and the rootfs is writable — so a tool that writes
   into any directory never fails. Guest writes hit tmpfs and are discarded; the
   underlying host images are never modified and nothing persists across runs (except via
   safe outputs). Shim/asset *read-only-ness is not a security control* — the guest can
   bypass a shim anyway; the real boundary is host-side (gateway, dispatch, firewall,
   console filter). (`generateMountSetup`, `generateInitScript`.)

---

## MCP delivery invariants

6. **Every MCP server runs host-side and is exposed to the guest as a generic shim.**
   Servers (safe outputs, github, third-party) run on the host with their real env; the
   guest gets one thin forwarder per server under `$MV_MCP_DIR`. No server, and no
   secret, ever runs or lives in the guest. (`src/mcp-config.js`, `src/dispatch.js`.)

7. **Shims are PURE PASSTHROUGH — no per-tool logic, ever.** A call shim forwards a JSON
   arguments object to the gateway and nothing else. It **must not** inspect args,
   translate them, synthesize them, read files, encode content, or special-case any tool
   or server. The invocation is uniform for every tool:
   `"$MV_MCP_DIR/<server>" <tool> --input '<JSON>' | --stdin`.
   *This is the principle the `--add`/`--delete` file-handling hack violated. If a tool
   needs file bytes, the **agent** produces them per the tool's schema (it has the
   workspace); the harness stays ignorant of what a "file" is.*

8. **Tool arguments come only from the tool's advertised `inputSchema`.** The harness
   never invents argument shapes. What the agent sends is what the schema declares.

9. **Discovery mirrors native MCP.** Tool discovery is `tools/list`, relayed live to the
   gateway by the reserved `$MV_MCP_DIR/__tools_list` command (all servers, or one). It
   returns the native shape (name, description, `inputSchema`). No baked manifest; no
   bespoke discovery protocol.

10. **`/__mcp` is commands only; `/__rt` is runtime plumbing.** `$MV_MCP_DIR` holds the
    call shims + the `__tools_list` built-in. Per-run context/config (init, prompt,
    agent.env, CA, event.json, `report-*` helpers) lives on `/__rt`. Don't mix the two.

11. **The `__` prefix is a reserved namespace** for harness-provided built-ins under
    `/__mcp` (e.g. `__tools_list`). Customer MCP server names starting with `__` are
    rejected at config time. (`src/mcp-config.js`.)

12. **Well-known paths are referenced via env vars, never hardcoded.** `$MV_MCP_DIR`
    (MCP call + discovery commands) and `$MV_HELPERS_DIR` (report-* diagnostics) are
    always exported; the event payload is at `$GITHUB_EVENT_PATH` (the standard Actions
    variable, repointed to the copy on `/__rt`). Prompts, helpers, and authors use the
    vars so the actual directories can be relocated freely.

13. **No feature is special-cased in the harness.** Safe outputs, github, and any custom
    server flow through the *identical* host-launch → `tools/list` → shim path. If a
    change would make the harness "know about" a specific server or tool by name, that's
    a principle-level red flag (see #7).

---

## Result / error-surfacing invariants

14. **The step result is the harness process's exit code**, graded from the guest
    console. The run fails if: the guest never reached the agent (infra failure), the
    guest agent exited non-zero (`AGENT_EXIT`), or the agent declared it could not finish
    the task by running `report-incomplete` (which prints a special marker line the host
    grader watches for). There is no `::set-result::` workflow command.
    (`src/console-filter.js` `gradeConsoleText`.)

15. **The agent surfaces diagnostics via guest-side helpers, not by hand-formatting
    workflow commands.** `report-error`/`report-warning`/`report-notice`/`report-incomplete`
    under `$MV_HELPERS_DIR` do the escaping; the agent never writes `::…::` itself.

16. **The prepended preamble is the agent's runtime contract — keep it in sync.** The
    harness prepends a preamble to the author's prompt (`generateMcpPreamble`) that tells
    the agent everything it needs to operate: that it's sandboxed, where the event payload
    is, how to **discover** tools (`__tools_list`), how to **call** them (`--input`/`--stdin`
    with JSON matching the schema), and how to report **errors / incompletion**
    (`$MV_HELPERS_DIR/report-*`). If you change any tool/discovery/call convention or any
    error/result-reporting mechanism, you **must** update the preamble in the same change —
    the agent knows only what the preamble tells it. A behavior the agent can't discover
    from the preamble (or via `__tools_list`) effectively doesn't exist. Keep it short:
    state the contract, don't duplicate per-tool schemas (those come from discovery).

---

## Build / correctness invariants

17. **`dist/` is generated from `src/`.** After changing `src/`, rebuild with
    `npm run build` and commit `dist/` in sync. Never hand-edit `dist/`.

18. **Dependencies must clear a high trust bar.** Prefer first-party `@actions/*`; any
    other production dependency must be reputable, widely used, and actively maintained.

---

## Changing a principle

A principle here changes **only** when a human explicitly and unambiguously agrees to it,
naming the principle and acknowledging it's a heavy, deliberate decision. Concretely:

- An AI agent proposing such a change must **call it out as a core-principle change**,
  explain the security/architecture tradeoff, and get explicit human sign-off **before**
  implementing — not bundle it into an unrelated change.
- "It was easier" / "it made the demo work" / "the test needed it" are **not** sufficient
  justification. Convenience is exactly how these invariants erode.
- When a principle does change, update this doc in the same change, with the rationale.
