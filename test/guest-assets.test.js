import { test } from "node:test";
import assert from "node:assert/strict";
import { generateShim, generateDockerfile, generateInitScript, generateMountSetup, DEFAULT_DISPATCH_ENDPOINT } from "../src/guest-assets.js";

const addLabels = {
  name: "add_labels",
  inputSchema: { type: "object", required: ["labels"], properties: { labels: { type: "array", items: { type: "string" } } } },
};
const addComment = {
  name: "add_comment",
  inputSchema: { type: "object", required: ["body"], properties: { body: { type: "string" } } },
};
const updateIssue = {
  name: "update_issue",
  inputSchema: { type: "object", properties: { title: { type: "string" }, state: { type: "string" } } },
};

test("array-of-strings tool -> positional shim", () => {
  const shim = generateShim(addLabels);
  assert.match(shim, /#!\/bin\/bash/);
  assert.match(shim, /--args '\{tool:"add_labels",args:\{labels:\$ARGS\.positional\}\}'/);
  assert.ok(shim.includes(DEFAULT_DISPATCH_ENDPOINT));
});

test("single-string tool -> whole-line shim", () => {
  const shim = generateShim(addComment);
  assert.match(shim, /--arg v "\$\*" '\{tool:"add_comment",args:\{body:\$v\}\}'/);
});

test("multi-property tool -> JSON-argument shim", () => {
  const shim = generateShim(updateIssue);
  assert.match(shim, /--argjson args "\$\{1:-\{\}\}" '\{tool:"update_issue",args:\$args\}'/);
});

test("endpoint is configurable", () => {
  const shim = generateShim(addLabels, { endpoint: "http://10.0.0.1:5000/x" });
  assert.ok(shim.includes("http://10.0.0.1:5000/x"));
  assert.ok(!shim.includes(DEFAULT_DISPATCH_ENDPOINT));
});

test("Dockerfile copies + chmods every shim and the copilot CLI", () => {
  const df = generateDockerfile(["add_labels", "add_comment"]);
  assert.ok(df.includes("COPY add_labels /usr/local/bin/add_labels"));
  assert.ok(df.includes("COPY add_comment /usr/local/bin/add_comment"));
  assert.ok(df.includes("/usr/local/bin/add_labels /usr/local/bin/add_comment"));
  assert.ok(df.includes("copilot-linux-x64.tar.gz"));
});

test("init script wires networking, auth env, and the prompt", () => {
  const init = generateInitScript();
  assert.ok(init.includes("ip addr add 172.16.0.2/30 dev eth0"));
  assert.ok(init.includes("ip route add default via 172.16.0.1"));
  assert.ok(init.includes("S2STOKENS=true"));
  assert.ok(init.includes("GITHUB_COPILOT_INTEGRATION_ID=agentic-workflows"));
  assert.ok(init.includes('-p "$(cat /etc/prompt.txt)"'));
});

test("generateMountSetup is empty when nothing is mounted", () => {
  assert.equal(generateMountSetup(), "");
  assert.equal(generateMountSetup({}), "");
});

test("workspace mount is an RO lower + tmpfs overlay at the identical path", () => {
  const s = generateMountSetup({ workspace: { dev: "/dev/vdb", path: "/home/runner/work/r/r" } });
  assert.ok(s.includes("mount -o ro '/dev/vdb' /mnt/mv-ws-lower"));
  assert.ok(s.includes("mount -t tmpfs tmpfs /mnt/mv-ws-rw"));
  assert.ok(
    s.includes("mount -t overlay overlay -o lowerdir=/mnt/mv-ws-lower,upperdir=/mnt/mv-ws-rw/upper,workdir=/mnt/mv-ws-rw/work '/home/runner/work/r/r'")
  );
});

test("toolcache mount is a plain RO mount at the identical path", () => {
  const s = generateMountSetup({ toolcache: { dev: "/dev/vdc", path: "/opt/hostedtoolcache" } });
  assert.ok(s.includes("mount -o ro '/dev/vdc' '/opt/hostedtoolcache'"));
  assert.ok(!s.includes("overlay")); // toolcache is read-only, no overlay
});

test("init adds --add-dir for a mounted workspace", () => {
  const init = generateInitScript({ mounts: { workspace: { dev: "/dev/vdb", path: "/ws" } } });
  assert.ok(init.includes("--add-dir '/root'"));
  assert.ok(init.includes("--add-dir '/ws'"));
  assert.ok(init.includes("mount -t overlay overlay"));
});

test("Dockerfile includes util-linux for mount support", () => {
  assert.ok(generateDockerfile([]).includes("util-linux"));
});
