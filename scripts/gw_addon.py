# mitmproxy addon: the credential gateway. Runs on the HOST in transparent mode.
# Two jobs (ported from the proven phase2/phase4 addon):
#   1. Swap the guest's FAKE token for the REAL one on outbound requests, so the
#      real inference/GitHub token never lives inside the guest.
#   2. Enforce the egress domain allowlist: anything not on it gets a 403.
#
# Env:
#   REAL_TOKEN   - the real token (host-only)
#   FAKE_TOKEN   - the sentinel the guest holds
#   EXTRA_ALLOW  - optional comma-separated extra hostnames (the firewall-allow input)
import os
from mitmproxy import http

FAKE = os.environ.get("FAKE_TOKEN", "")
REAL = os.environ.get("REAL_TOKEN", "")

# The hosts the standalone Copilot CLI needs (inference, token exchange, MCP policy).
ALLOW = {"api.github.com", "api.githubcopilot.com", "api.mcp.github.com"}
for extra in os.environ.get("EXTRA_ALLOW", "").split(","):
    extra = extra.strip()
    if extra:
        ALLOW.add(extra)


def _append(path, line):
    with open(path, "a") as f:
        f.write(line + "\n")


def request(flow: http.HTTPFlow) -> None:
    host = flow.request.pretty_host
    _append("/tmp/gw-hosts.log", host)
    if host not in ALLOW:
        _append("/tmp/gw-blocked.log", host + " " + flow.request.path)
        flow.response = http.Response.make(403, b"blocked\n", {"Content-Type": "text/plain"})
        return
    if FAKE:
        swapped = False
        for k in list(flow.request.headers.keys()):
            val = flow.request.headers[k]
            if FAKE in val:
                flow.request.headers[k] = val.replace(FAKE, REAL)
                swapped = True
        body = flow.request.get_content(strict=False)
        if body and FAKE.encode() in body:
            flow.request.set_content(body.replace(FAKE.encode(), REAL.encode()))
            swapped = True
        if swapped:
            _append("/tmp/gw-swaps.log", host + " " + flow.request.path)
