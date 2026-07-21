# Copilot instructions — microvm-agent

Before changing this repository, read **`docs/design-principles.md`**. It lists the core
invariants (security, MCP delivery, result model) that keep an untrusted agent credential-free
inside the microVM.

**Heavy-change rule (do not skip):** You **must not** modify, weaken, or work around any core
design principle without **explicit human agreement** that (a) names the specific principle and
(b) acknowledges the change is a deliberate, heavy decision. If a task appears to require
violating a principle, **stop and surface it as a finding** — do not quietly route around it.
Convenience ("it was easier", "the demo/test needed it") is never sufficient justification; that
is exactly how these invariants erode. When a principle legitimately changes, update
`docs/design-principles.md` in the same change with the rationale.

**Especially watch for the recurring failure mode:** putting per-tool or per-server logic into the
generic MCP shim/dispatch, or adding a bespoke helper for one safe output. Shims are pure
passthrough; the harness never special-cases a specific tool by name (principle #7, #13).

Other conventions:
- `dist/` is generated from `src/` via `npm run build`; rebuild and commit it in sync. Never
  hand-edit `dist/`.
- Well-known guest paths are referenced via env vars (`$MV_MCP_DIR`, `$MV_HELPERS_DIR`), never
  hardcoded.
- Architecture + security model: `docs/architecture.md`. Decision record + open items: `TODO.md`.
