# microvm-agent — architecture & security model

This document explains how `microvm-agent` runs an AI agent (the Copilot CLI) inside a
Firecracker microVM **without ever placing a real credential inside the sandbox**, and
how it lets the agent reach GitHub/Copilot and apply narrowly-scoped writes anyway.

If you only read one thing: **the guest is untrusted.** Every secret, every policy
decision, and every write-capable credential lives on the **host**. The guest holds only
fake sentinel tokens and thin forwarder shims. Even a fully-compromised agent cannot read
a real token or escalate to a write API.

---

## 1. Trust boundary (component view)

```mermaid
flowchart TB
  subgraph HOST["🖥️  HOST — trusted (GitHub Actions runner)"]
    direction TB
    MAIN["Node action entrypoint<br/>(src/main.js)"]
    GW["Credential gateway<br/>mitmdump + gw_addon.py<br/>:8080"]
    DISP["MCP dispatch<br/>(src/dispatch.js)<br/>:9000"]
    SRV["MCP servers (host-side)<br/>safe-outputs, github shim, …<br/>hold the REAL tokens"]
    FW["Firewall + NAT + tap0<br/>(network-up.sh)"]
    TOKREAL[("REAL job token<br/>+ server secrets")]:::secret
  end

  subgraph GUEST["📦  GUEST — untrusted (Firecracker microVM)"]
    direction TB
    CLI["Copilot CLI<br/>(glibc binary)"]
    SHIM["/__mcp/&lt;server&gt; shims<br/>(read-only mount)"]
    FAKE[("FAKE sentinel token<br/>ghs_FAKE_…")]:::fake
    MNT["/__w workspace (ro+overlay)<br/>/__t tool cache (ro)<br/>/__mcp shims+event.json (ro)"]
  end

  MAIN --> GW & DISP & SRV & FW
  TOKREAL -.host-only.-> GW & SRV
  CLI -->|"HTTPS :443<br/>(fake token)"| FW
  FW -->|"REDIRECT :443→:8080"| GW
  GW -->|"fake→REAL swap,<br/>lane-bound"| INTERNET["🌐 api.githubcopilot.com<br/>api.github.com"]
  SHIM -->|"POST :9000 /dispatch"| DISP
  DISP --> SRV
  SRV -->|"REAL token,<br/>host-side only"| INTERNET
  FAKE -.only thing the guest holds.-> CLI

  classDef secret fill:#ffd9d9,stroke:#c0392b,color:#000;
  classDef fake fill:#d9e8ff,stroke:#2c6fbf,color:#000;
```

**The line down the middle is the security boundary.** Nothing red (real credentials)
ever crosses into the guest. The guest reaches the outside world only through two
host-controlled choke points: the **gateway** (for the agent's own HTTPS) and the
**dispatch** (for MCP tool calls).

---

## 2. Two lanes out of the sandbox

The guest can talk to exactly two host services. Everything else is dropped.

| Lane | Guest side | Host side | What crosses | Credential |
|------|-----------|-----------|--------------|------------|
| **Inference** | Copilot CLI → HTTPS `:443` | Gateway `:8080` (mitmproxy) | Copilot inference + built-in read-only github MCP | Guest sends **fake**; gateway swaps to **real** only on the bound lane |
| **MCP tools** | `/__mcp/<server>` shim → `POST :9000` | Dispatch `:9000` → host-side MCP server | Tool calls (safe outputs, github shim) | Guest sends **no token**; the **real** token is used host-side by the server |

Key property: the **write-scoped** job token is used **only** by host-side MCP servers
(lane 2). The guest never holds it and can never reach it.

---

## 3. Network & firewall (how egress is pinned)

```mermaid
flowchart LR
  subgraph G["GUEST 172.16.0.2"]
    A["agent HTTPS :443"]
    B["shim → 172.16.0.1:9000"]
    C["DNS :53"]
  end
  subgraph H["HOST 172.16.0.1 (tap0)"]
    direction TB
    IPT{"iptables on tap0<br/>default: DROP"}
    GW["gateway :8080"]
    DISP["dispatch :9000"]
  end
  A -->|":443"| IPT
  B -->|":9000"| IPT
  C -->|":53"| IPT
  IPT -->|"REDIRECT 443→8080"| GW
  IPT -->|"ACCEPT :9000"| DISP
  IPT -->|"ACCEPT :53 → ONE pinned resolver only"| DNS["🌐 resolver"]
  IPT -->|"everything else"| DROP["⛔ DROP"]
  GW -->|"allowlist + lane swap"| NET["🌐 allowlisted GitHub hosts"]
```

- Firewall is enforced on the **host** `tap0` device (`network-up.sh`), so **in-guest root
  cannot lift it**. Default policy is DROP.
- All guest `:443` is **REDIRECTed to the gateway** — the guest has no way to bypass it or
  reach `:443` directly. The gateway is therefore *unbypassable*.
- DNS `:53` is pinned to a **single resolver** (decision B) — otherwise DNS is a
  tunnel/exfil channel needing no token.
- Only `:9000` (dispatch) and the pinned `:53` are otherwise allowed out.

---

## 4. The credential gateway (mitmproxy) — what it is & why

**mitmproxy** (`mitmdump`, run **host-side**) is a TLS-intercepting forward proxy: it holds
a CA the guest trusts, so it can terminate the guest's TLS, inspect/modify the plaintext
request, then re-encrypt to the real upstream. Our addon (`scripts/gw_addon.py`) makes it
the **credential gateway**.

### Per-lane sentinel↔credential binding (decision A)

```mermaid
sequenceDiagram
  participant CLI as Guest: Copilot CLI<br/>(holds FAKE)
  participant GW as Host: gateway :8080
  participant GH as api.githubcopilot.com /<br/>api.github.com

  Note over CLI: agent makes an HTTPS call<br/>Authorization: token FAKE

  CLI->>GW: request (TLS, FAKE token)
  Note over GW: 1. host in allowlist?<br/>2. does a lane's target match?<br/>3. is a sentinel present, and on ITS lane?

  alt Inference lane (api.githubcopilot.com,<br/>or api.github.com /copilot_internal/)
    GW->>GW: swap FAKE → REAL
    GW->>GH: request (REAL token)
    GH-->>CLI: response (streamed back)
  else FAKE on any OTHER api.github.com path
    GW-->>CLI: 403 (deny-by-default,<br/>REAL never injected)
  else FAKE on an egress-allow host (out of lane)
    GW-->>CLI: 403 (sentinel misuse)
  else host not allowlisted
    GW-->>CLI: 403 (blocked)
  end
```

The real credential is swapped in **only** on its lane's `host [+ path prefix]`. A guest
`curl api.github.com/repos/…` carrying the fake token gets a **403 with no swap** — it
cannot turn the sentinel into the write-scoped job token. (Empirically confirmed: in a real
run the real token was injected only on `api.githubcopilot.com`; zero swaps on
`api.github.com`.)

> **Why a MITM proxy at all?** So the guest can *use* a credential it never *holds*. The
> real token exists only inside the host gateway; the sandbox sees only a fake. This is the
> core of the "credentials stay host-side" guarantee.

---

## 5. MCP tools — host-side servers, guest-side shims

Non-default MCP servers can't run natively in the guest (the Copilot CLI blocks them when
the MCP registry policy 403s with an Actions token — see TODO). So **every** MCP server
runs **host-side**; the guest gets only thin **forwarder shims**. This is both the policy
workaround and security-aligned: servers + their secrets never enter the sandbox.

```mermaid
sequenceDiagram
  participant A as Guest: agent (bash)
  participant S as Guest: /__mcp/labeler shim<br/>(read-only)
  participant D as Host: dispatch :9000
  participant M as Host: safe-outputs server<br/>(holds REAL token)
  participant GH as api.github.com

  A->>S: /__mcp/labeler add_labels bug
  S->>D: POST {server, tool, args:["bug"]}
  Note over D: lazy — fetch+cache this<br/>server's tools/list once,<br/>convert positional args to arg object
  D->>M: MCP tools/call add_labels {labels:["bug"]}
  M->>GH: PATCH issue labels (REAL token, host-side)
  GH-->>M: ok
  M-->>D: result
  D-->>S: {status:"ok"}
  S-->>A: ok
```

- **One shim per server** at `/__mcp/<server>`, invoked `<server> <tool> <args>`.
- Shims are delivered via a **read-only mount** (`/__mcp`) — tamper-proof
  (hypervisor-enforced), off `$PATH`, not baked into the rootfs.
- **Lazy discovery**: no startup `tools/list`; the dispatch fetches + caches a server's
  tools on first use. The prompt preamble lists the servers + "run `<server> --help`".
- The real token for each server stays host-side in the server's process env.

---

## 6. Guest filesystem & mounts

```mermaid
flowchart TB
  subgraph VM["Guest microVM filesystem"]
    ROOT["/ rootfs (ext4)<br/>Copilot CLI, jq, curl<br/>throwaway — discarded on teardown"]
    W["/__w  workspace<br/>read-only image + tmpfs overlay<br/>(agent writes go to the overlay,<br/>discarded)"]
    T["/__t  tool cache<br/>read-only"]
    MCP["/__mcp  harness config<br/>read-only: shims + event.json"]
  end
  HOSTFS[("Host: workspace, tool cache,<br/>event.json")] -->|"built into virtio-block<br/>ext4 images (mkfs.ext4 -d)"| W & T & MCP
```

- Well-known guest paths mirror the Actions container-job convention: workspace → `/__w`,
  tool cache → `/__t` (with `GITHUB_WORKSPACE` / `RUNNER_TOOL_CACHE` set to match). **No
  host-path mirroring** — the guest never sees real host paths.
- Workspace is a **read-only lower + throwaway tmpfs overlay**: the agent can write, but
  changes are discarded. **Persisting anything happens only via safe outputs** (lane 2).
- Only the single `event.json` is injected (via `/__mcp`, surfaced as
  `GITHUB_EVENT_PATH`) — never `RUNNER_TEMP` (which holds the checkout push token).

---

## 7. End-to-end lifecycle (what `main.js` orchestrates)

```mermaid
flowchart LR
  I["read inputs"] --> P["split MCP config:<br/>guest config (no secrets)<br/>+ host server plan (real env)"]
  P --> B["build /__mcp harness<br/>(shims + event.json)"]
  B --> R["provision + build rootfs<br/>+ mount images"]
  R --> N["network up:<br/>tap0 + firewall + redirect"]
  N --> S["start gateway :8080<br/>+ dispatch :9000"]
  S --> V["boot microVM (async)<br/>stream console → step log"]
  V --> A["agent runs;<br/>inference via gateway,<br/>tools via dispatch"]
  A --> T["teardown:<br/>stop services, network down,<br/>set status output"]
```

The boot is **async** (`spawn`, not `execFileSync`): the dispatch server lives in the same
Node process and must keep its event loop free to answer the guest's shim calls **while the
VM is running**.

---

## 8. Security invariants (the short list)

1. **No real credential in the guest** — only fake sentinels; the gateway swaps host-side.
2. **Lane-bound swap** — the real token is injected only on its allowlisted host/path; every
   other `api.github.com` path is deny-by-default (no write escalation).
3. **Write token is host-only** — used solely by host-side MCP servers; unreachable from the
   guest.
4. **Unbypassable egress** — host firewall forces all `:443` through the gateway; default
   DROP; DNS pinned to one resolver.
5. **Tamper-proof injected assets** — shims/event.json ride a hypervisor read-only mount.
6. **No persistence except via safe outputs** — workspace writes hit a throwaway overlay.
7. **Guest controls nothing about a trusted lane** — not the URL, not the credential, not
   its scope (the "ceiling principle", decision A).

---

*Source of truth for the finalized decisions (A–F): `TODO.md` → "Design decisions".*
