import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateServerShim,
  generateMcpPreamble,
  generateMountSetup,
  generateDockerfile,
  generateInitScript,
  DEFAULT_DISPATCH_ENDPOINT,
  DEFAULT_MCP_DIR,
} from "../src/guest-assets.js";

test("generateServerShim forwards {server,tool,args} to the dispatch endpoint", () => {
  const shim = generateServerShim("labeler");
  assert.match(shim, /^#!\/bin\/sh/);
  assert.ok(shim.includes("S='labeler'"));
  assert.ok(shim.includes(DEFAULT_DISPATCH_ENDPOINT));
  // help (no args) lists tools; tool --help shows schema; else invoke with positional args.
  assert.match(shim, /\{server:\$s,help:true\}/);
  assert.match(shim, /\{server:\$s,tool:\$t,help:true\}/);
  assert.match(shim, /\{server:\$s,tool:\$t,args:\$ARGS\.positional\}/);
});

test("generateServerShim endpoint is configurable", () => {
  const shim = generateServerShim("x", { endpoint: "http://10.0.0.1:5000/y" });
  assert.ok(shim.includes("http://10.0.0.1:5000/y"));
  assert.ok(!shim.includes(DEFAULT_DISPATCH_ENDPOINT));
});

test("generateMcpPreamble lists servers with absolute /__mcp paths + event path", () => {
  const p = generateMcpPreamble(["labeler", "github"]);
  assert.match(p, /isolated, ephemeral Firecracker microVM/);
  assert.match(p, /\$GITHUB_EVENT_PATH/);
  assert.ok(p.includes(`${DEFAULT_MCP_DIR}/labeler`));
  assert.ok(p.includes(`${DEFAULT_MCP_DIR}/github`));
  assert.match(p, /---\n$/);
});

test("generateMcpPreamble with no servers still gives isolation + event context", () => {
  const p = generateMcpPreamble([]);
  assert.match(p, /microVM/);
  assert.ok(!p.includes("/__mcp/"));
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

test("toolcache mount is a plain RO mount at /__t", () => {
  const s = generateMountSetup({ toolcache: { dev: "/dev/vdd", path: "/__t" } });
  assert.ok(s.includes("mount -o ro '/dev/vdd' '/__t'"));
});

test("Dockerfile installs jq/curl/util-linux and does NOT bake shims", () => {
  const df = generateDockerfile();
  assert.ok(df.includes("jq util-linux"));
  assert.ok(df.includes("copilot-linux-x64.tar.gz"));
  assert.ok(!df.includes("/usr/local/bin/add_labels"));
  assert.ok(!/COPY \w+ \/usr\/local\/bin/.test(df));
});

test("init mounts harness + wires auth env and prompt", () => {
  const init = generateInitScript({ mounts: { harness: { dev: "/dev/vdb", path: "/__mcp" } } });
  assert.ok(init.includes("mount -o ro '/dev/vdb' '/__mcp'"));
  assert.ok(init.includes("S2STOKENS=true"));
  assert.ok(init.includes('-p "$(cat /etc/prompt.txt)"'));
});

test("init runs the agent from the workspace when mounted, else /root", () => {
  const mounted = generateInitScript({ mounts: { workspace: { dev: "/dev/vdc", path: "/__w" } } });
  assert.ok(mounted.includes("cd '/__w' 2>/dev/null || cd /root"));
  const bare = generateInitScript();
  assert.ok(bare.includes("cd '/root'"));
});
