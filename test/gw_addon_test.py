#!/usr/bin/env python3
# Tests for the credential gateway (scripts/gw_addon.py), decision A: per-lane
# sentinel<->credential binding. Stubs the `mitmproxy` module so no install is needed.
import os
import sys
import types
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(os.path.dirname(HERE), "scripts")

SENTINEL = "ghs_FAKE_GUEST_TOKEN_DO_NOT_USE"
REAL = "ghs_REAL_WRITE_SCOPED_JOB_TOKEN"

LANES_JSON = (
    '[{"name":"inference","sentinel":"%s","real":"%s","targets":'
    '[{"host":"api.githubcopilot.com"},'
    '{"host":"api.github.com","path_prefix":"/copilot_internal/"}]}]'
) % (SENTINEL, REAL)


class _Headers(dict):
    def keys(self):
        return list(super().keys())


class _Response:
    def __init__(self, status, content):
        self.status_code = status
        self.content = content

    @staticmethod
    def make(status, content, headers):
        return _Response(status, content)


class _Request:
    def __init__(self, host, path, headers=None, content=b""):
        self._host = host
        self.path = path
        self.headers = _Headers(headers or {})
        self._content = content

    @property
    def pretty_host(self):
        return self._host

    def get_content(self, strict=False):
        return self._content

    def set_content(self, c):
        self._content = c


class _Flow:
    def __init__(self, request):
        self.request = request
        self.response = None


def _install_stub():
    mit = types.ModuleType("mitmproxy")
    http_mod = types.ModuleType("mitmproxy.http")
    http_mod.Response = _Response

    class HTTPFlow:  # only used as a type annotation
        pass

    http_mod.HTTPFlow = HTTPFlow
    mit.http = http_mod
    sys.modules["mitmproxy"] = mit
    sys.modules["mitmproxy.http"] = http_mod


def _load_addon(tmpdir):
    os.environ["GW_LANES"] = LANES_JSON
    os.environ["EGRESS_ALLOW"] = "api.mcp.github.com,example.allow.test"
    os.environ["GW_LOG_DIR"] = tmpdir
    # Fresh import each time so env is re-read.
    for m in list(sys.modules):
        if m == "gw_addon":
            del sys.modules[m]
    sys.path.insert(0, SCRIPTS)
    import gw_addon  # noqa: E402
    return gw_addon


def _auth(token):
    return {"authorization": "token " + token}


CASES = []


def case(fn):
    CASES.append(fn)
    return fn


@case
def test_token_exchange_swaps(gw):
    """Sentinel on the Copilot token-exchange path -> swapped to the real credential."""
    f = _Flow(_Request("api.github.com", "/copilot_internal/v2/token", _auth(SENTINEL)))
    gw.request(f)
    assert f.response is None, "exchange path must be allowed"
    assert f.request.headers["authorization"] == "token " + REAL, "must swap to real"


@case
def test_inference_host_swaps(gw):
    """Sentinel on the inference host (any path) -> swapped."""
    f = _Flow(_Request("api.githubcopilot.com", "/chat/completions", _auth(SENTINEL)))
    gw.request(f)
    assert f.response is None
    assert f.request.headers["authorization"] == "token " + REAL


@case
def test_write_path_hole_closed(gw):
    """THE HOLE: sentinel on a general api.github.com write path -> 403, never swapped."""
    f = _Flow(_Request("api.github.com", "/repos/o/r/issues", _auth(SENTINEL)))
    gw.request(f)
    assert f.response is not None and f.response.status_code == 403, "must block"
    assert REAL not in f.request.headers["authorization"], "must NOT leak the real token"


@case
def test_api_github_other_path_denied_without_sentinel(gw):
    """Deny-by-default: any non-exchange api.github.com path is blocked even w/o a token."""
    f = _Flow(_Request("api.github.com", "/user"))
    gw.request(f)
    assert f.response is not None and f.response.status_code == 403


@case
def test_egress_host_no_swap(gw):
    """EGRESS_ALLOW host with no sentinel -> allowed, no credential injected."""
    f = _Flow(_Request("api.mcp.github.com", "/", {"authorization": "token real-copilot"}))
    gw.request(f)
    assert f.response is None
    assert f.request.headers["authorization"] == "token real-copilot"


@case
def test_sentinel_on_egress_host_is_misuse(gw):
    """Sentinel sent to an EGRESS_ALLOW host is out-of-lane misuse -> 403, no swap."""
    f = _Flow(_Request("api.mcp.github.com", "/", _auth(SENTINEL)))
    gw.request(f)
    assert f.response is not None and f.response.status_code == 403
    assert REAL not in f.request.headers["authorization"]


@case
def test_sentinel_to_user_allow_host_is_misuse(gw):
    """Sentinel to a user firewall-allow host must not yield the real token."""
    f = _Flow(_Request("example.allow.test", "/x", _auth(SENTINEL)))
    gw.request(f)
    assert f.response is not None and f.response.status_code == 403
    assert REAL not in f.request.headers["authorization"]


@case
def test_user_allow_host_without_sentinel_ok(gw):
    """A user firewall-allow host is reachable for plain egress (no swap)."""
    f = _Flow(_Request("example.allow.test", "/x"))
    gw.request(f)
    assert f.response is None


@case
def test_unlisted_host_blocked(gw):
    """A host on no lane and not in EGRESS_ALLOW is blocked."""
    f = _Flow(_Request("evil.example.com", "/"))
    gw.request(f)
    assert f.response is not None and f.response.status_code == 403


@case
def test_sentinel_smuggled_in_body_on_bad_host(gw):
    """A sentinel hidden in the body of an out-of-lane request is still caught -> 403."""
    f = _Flow(_Request("api.mcp.github.com", "/", content=("x=" + SENTINEL).encode()))
    gw.request(f)
    assert f.response is not None and f.response.status_code == 403


def main():
    _install_stub()
    passed = 0
    for fn in CASES:
        tmpdir = tempfile.mkdtemp()
        gw = _load_addon(tmpdir)
        fn(gw)
        passed += 1
        print("  ok - %s" % fn.__name__)
    print("gw_addon: %d/%d passed" % (passed, len(CASES)))


if __name__ == "__main__":
    main()
