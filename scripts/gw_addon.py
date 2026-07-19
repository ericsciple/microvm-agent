# mitmproxy addon: the credential gateway. Runs on the HOST in transparent mode.
#
# Decision A — per-lane sentinel<->credential binding (the ceiling principle).
# The guest can influence NOTHING about a trusted lane: not the upstream host, not
# the credential, not its scope. Concretely:
#   * Each LANE binds ONE sentinel (a fake token the guest holds) to ONE real
#     credential and an explicit set of allowed targets (host [+ path prefix]).
#   * A sentinel is swapped for its real credential ONLY on that lane's targets.
#     A sentinel seen anywhere else is a cross-lane misuse attempt -> 403.
#   * We NEVER inject a write-capable credential for a request the guest can steer
#     to a general write API. The inference lane's real credential is only ever
#     presented to api.githubcopilot.com (inference / built-in read-only MCP) and
#     the Copilot token-exchange path on api.github.com; every OTHER api.github.com
#     path is rejected (deny-by-default), so a guest `curl api.github.com/...` with
#     the sentinel can never obtain the write-scoped job token.
#   * EGRESS_ALLOW hosts (user firewall-allow + Copilot support hosts) are reachable
#     for plain egress but get NO credential injected.
#
# This is a deliberate, stronger divergence from gh-aw, which (in default mode) hands
# the agent the real token. The firewall (network-up.sh) forces all guest :443 into
# this gateway and DROPs everything else, so the gateway is unbypassable.
#
# Env:
#   GW_LANES     - JSON list of lanes:
#                    [{"name","sentinel","real","targets":[{"host","path_prefix"?}]}]
#                  Secrets (the "real" values) live ONLY here, host-side.
#   EGRESS_ALLOW - optional comma-separated hostnames reachable with NO swap
#                  (the firewall-allow input + Copilot support hosts).
#   GW_LOG_DIR   - directory for the gw-*.log audit trail (default /tmp).
import json
import os
from mitmproxy import http

LANES = json.loads(os.environ.get("GW_LANES", "[]"))

EGRESS_ALLOW = set()
for _h in os.environ.get("EGRESS_ALLOW", "").split(","):
    _h = _h.strip()
    if _h:
        EGRESS_ALLOW.add(_h)

LOG_DIR = os.environ.get("GW_LOG_DIR", "/tmp")


def _log(name, line):
    try:
        with open(os.path.join(LOG_DIR, name + ".log"), "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def _target_match(lane, host, path):
    for t in lane.get("targets", []):
        if host != t.get("host"):
            continue
        prefix = t.get("path_prefix")
        if prefix is None or path.startswith(prefix):
            return True
    return False


def _present_sentinel_lane(flow):
    # Which lane's sentinel (if any) does this request carry? Check headers + body so a
    # guest can't smuggle a sentinel past us in the request body.
    header_blob = "\n".join(
        "%s: %s" % (k, flow.request.headers[k]) for k in flow.request.headers.keys()
    )
    body = flow.request.get_content(strict=False) or b""
    for lane in LANES:
        s = lane.get("sentinel") or ""
        if not s:
            continue
        if s in header_blob or s.encode() in body:
            return lane
    return None


def _swap(flow, fake, real):
    for k in list(flow.request.headers.keys()):
        val = flow.request.headers[k]
        if fake in val:
            flow.request.headers[k] = val.replace(fake, real)
    body = flow.request.get_content(strict=False)
    if body and fake.encode() in body:
        flow.request.set_content(body.replace(fake.encode(), real.encode()))


def request(flow: http.HTTPFlow) -> None:
    host = flow.request.pretty_host
    path = flow.request.path
    _log("gw-hosts", host + " " + path)

    present = _present_sentinel_lane(flow)

    matched = None
    for lane in LANES:
        if _target_match(lane, host, path):
            matched = lane
            break

    allowed = matched is not None or host in EGRESS_ALLOW
    if not allowed:
        _log("gw-blocked", host + " " + path)
        flow.response = http.Response.make(403, b"blocked\n", {"Content-Type": "text/plain"})
        return

    # A sentinel may appear ONLY on its own lane's targets. Anywhere else — a
    # non-target path on a lane host, an EGRESS_ALLOW host, another lane's target —
    # it is a misuse attempt and is rejected before the request leaves the host.
    if present is not None and (matched is None or matched.get("name") != present.get("name")):
        _log("gw-misuse", (present.get("name") or "?") + " sentinel -> " + host + " " + path)
        flow.response = http.Response.make(
            403, b"blocked: sentinel out of lane\n", {"Content-Type": "text/plain"}
        )
        return

    if matched is not None and present is not None and present.get("name") == matched.get("name"):
        _swap(flow, matched["sentinel"], matched.get("real") or "")
        _log("gw-swaps", matched.get("name", "?") + " " + host + " " + path)
