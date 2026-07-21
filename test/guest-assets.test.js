import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateServerShim,
  generateToolsListShim,
  generateHelperScripts,
  generateMcpPreamble,
  generateMountSetup,
  generateInitScript,
  DEFAULT_DISPATCH_ENDPOINT,
  DEFAULT_MCP_DIR,
  DEFAULT_HELPERS_DIR,
  REPORT_INCOMPLETE_SENTINEL,
  TOOLS_LIST_COMMAND,
} from "../src/guest-assets.js";

test("generateServerShim is a pure passthrough: forwards {server,tool,input}", () => {
  const shim = generateServerShim("labeler");
  assert.match(shim, /^#!\/bin\/sh/);
  assert.ok(shim.includes("S='labeler'"));
  assert.ok(shim.includes(DEFAULT_DISPATCH_ENDPOINT));
  // Two forms only: --input '<JSON>' and --stdin. Envelope is {server,tool,input}.
  assert.match(shim, /--input/);
  assert.match(shim, /--stdin/);
  assert.match(shim, /\{server:\$s,tool:\$t,input:\$input\}/);
  // No discovery, no positional/flag translation, no file handling in the call shim.
  assert.ok(!shim.includes("--add"));
  assert.ok(!shim.includes("--help"));
  assert.ok(!shim.includes("ARGS.positional"));
  assert.ok(!shim.includes("base64"));
});

test("generateToolsListShim relays discovery to the gateway", () => {
  const shim = generateToolsListShim();
  assert.match(shim, /^#!\/bin\/sh/);
  assert.match(shim, /\{discover:true\}/);
  assert.match(shim, /\{discover:true,server:\$s\}/);
  assert.ok(shim.includes(DEFAULT_DISPATCH_ENDPOINT));
});

test("TOOLS_LIST_COMMAND is a reserved __-prefixed built-in", () => {
  assert.equal(TOOLS_LIST_COMMAND, "__tools_list");
  assert.match(TOOLS_LIST_COMMAND, /^__/);
});

test("generateServerShim endpoint is configurable", () => {
  const shim = generateServerShim("x", { endpoint: "http://10.0.0.1:5000/y" });
  assert.ok(shim.includes("http://10.0.0.1:5000/y"));
  assert.ok(!shim.includes(DEFAULT_DISPATCH_ENDPOINT));
});

test("generateMcpPreamble lists servers via $MV_MCP_DIR + discovery + call guidance", () => {
  const p = generateMcpPreamble(["labeler", "github"]);
  assert.match(p, /isolated, ephemeral Firecracker microVM/);
  assert.match(p, /\$GITHUB_EVENT_PATH/);
  // Paths are referenced through the env var, never hardcoded.
  assert.ok(p.includes("$MV_MCP_DIR/labeler"));
  assert.ok(p.includes("$MV_MCP_DIR/github"));
  assert.ok(!p.includes(`${DEFAULT_MCP_DIR}/labeler`));
  // Discovery via the reserved __tools_list command; calls via --input/--stdin.
  assert.ok(p.includes(`$MV_MCP_DIR/${TOOLS_LIST_COMMAND}`));
  assert.match(p, /--input/);
  assert.match(p, /--stdin/);
  // The diagnostics helpers are advertised via $MV_HELPERS_DIR.
  assert.ok(p.includes('"$MV_HELPERS_DIR/report-error"'));
  assert.ok(p.includes('"$MV_HELPERS_DIR/report-incomplete"'));
  assert.match(p, /---\n$/);
});

test("generateMcpPreamble with no servers still gives isolation + event + helpers", () => {
  const p = generateMcpPreamble([]);
  assert.match(p, /microVM/);
  assert.ok(!p.includes("$MV_MCP_DIR"));
  // Helpers are always available regardless of MCP servers.
  assert.ok(p.includes('"$MV_HELPERS_DIR/report-error"'));
});

test("harness mount is a read-only mount at /__mcp", () => {
  const s = generateMountSetup({ harness: { dev: "/dev/vdb", path: "/__mcp" } });
  assert.ok(s.includes("mount -o ro '/dev/vdb' '/__mcp'"));
  assert.ok(!s.includes("overlay"));
});

test("workspace mount is an RO lower + tmpfs overlay at /__w", () => {
  const s = generateMountSetup({ workspace: { dev: "/dev/vdc", path: "/__w" } });
  assert.ok(s.includes("mount -o ro '/dev/vdc' /mnt/mv-ws-lower"));
  assert.ok(s.includes("mount -t overlay overlay"));
  assert.ok(s.includes("'/__w'"));
});

test("toolcache mount is an RO lower + tmpfs overlay at /__t", () => {
  const s = generateMountSetup({ toolcache: { dev: "/dev/vdd", path: "/__t" } });
  assert.ok(s.includes("mount -o ro '/dev/vdd' /mnt/mv-tc-lower"));
  assert.ok(s.includes("mount -t overlay overlay"));
  assert.ok(s.includes("'/__t'"));
});

test("copilot mount is an RO lower + tmpfs discard overlay", () => {
  const s = generateMountSetup({ copilot: { dev: "/dev/vdc", path: "/opt/copilot" } });
  assert.ok(s.includes("mount -o ro '/dev/vdc' /mnt/mv-cp-lower"));
  assert.ok(s.includes("mount -t overlay overlay"));
  assert.ok(s.includes("'/opt/copilot'"));
});

test("init mounts harness + wires auth env and prompt from /__rt", () => {
  const init = generateInitScript({ mounts: { harness: { dev: "/dev/vdd", path: "/__mcp" } } });
  assert.ok(init.includes("mount -o ro '/dev/vdd' '/__mcp'"));
  assert.ok(init.includes("S2STOKENS=true"));
  assert.ok(init.includes('-p "$(cat "$RT/prompt.txt")"'));
  assert.ok(init.includes('. "$RT/agent.env"'));
  // The CLI must be granted the /__mcp dir to execute the shims there, and /__rt for the
  // report-* helpers + event.json.
  assert.ok(init.includes("--add-dir '/__mcp'"));
  assert.ok(init.includes("--add-dir '/__rt'"));
});

test("generateHelperScripts emits the four report-* helpers with escaping", () => {
  const h = generateHelperScripts();
  assert.deepEqual(
    Object.keys(h).sort(),
    ["report-error", "report-incomplete", "report-notice", "report-warning"]
  );
  for (const [name, body] of Object.entries(h)) {
    assert.match(body, /^#!\/bin\/sh/, `${name} is a sh script`);
    // Escapes %, CR, LF so the agent never hand-formats the workflow command.
    assert.ok(body.includes('gsub(/%/, "%25")'), `${name} escapes %`);
    assert.ok(body.includes('gsub(/\\r/, "%0D")'), `${name} escapes CR`);
    assert.ok(body.includes("%0A"), `${name} escapes LF`);
  }
  assert.ok(h["report-error"].includes("printf '::error::%s\\n'"));
  assert.ok(h["report-warning"].includes("printf '::warning::%s\\n'"));
  assert.ok(h["report-notice"].includes("printf '::notice::%s\\n'"));
  // report-incomplete prints an error annotation AND the plain-text grading sentinel.
  assert.ok(h["report-incomplete"].includes("printf '::error::%s\\n'"));
  assert.ok(h["report-incomplete"].includes(REPORT_INCOMPLETE_SENTINEL));
  // The sentinel must NOT be a ::workflow-command:: (the filter would neutralize it).
  assert.ok(!/^::/.test(REPORT_INCOMPLETE_SENTINEL));
});

test("DEFAULT_HELPERS_DIR is colocated under the runtime dir", () => {
  assert.equal(DEFAULT_HELPERS_DIR, "/__rt/helpers");
});

test("init puts the copilot mount on PATH", () => {
  const init = generateInitScript({ mounts: { copilot: { dev: "/dev/vdc", path: "/opt/copilot" } } });
  assert.ok(init.includes("export PATH='/opt/copilot':$PATH"));
});

test("init runs the agent from the workspace when mounted, else /root", () => {
  const mounted = generateInitScript({ mounts: { workspace: { dev: "/dev/vde", path: "/__w" } } });
  assert.ok(mounted.includes("cd '/__w' 2>/dev/null || cd /root"));
  const bare = generateInitScript();
  assert.ok(bare.includes("cd '/root'"));
});


