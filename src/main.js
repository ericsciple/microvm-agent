// microVM agent harness — host-side entrypoint.
//
// Runs on the trusted runner HOST. Provisions a Firecracker microVM, stands up
// the host-side credential gateway + egress firewall + MCP dispatch, boots the
// Copilot CLI inside the guest wired to talk only through the gateway, and tears
// everything down. The guest holds only fake tokens; every real credential stays
// host-side. The low-level recipes are ported from docs/proven-prototype/ and the
// Node logic (inputs, MCP secret split, tool discovery, shim generation, dispatch)
// is validated by the unit tests + local microVM runs (see TODO.md).
//
// MV_DRY_RUN=1 stops after the rootfs is built (before booting), so the whole
// provisioning path can be exercised without a Copilot inference token.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readInputs } from "./inputs.js";
import { buildGuestMcpConfig, assertNoSecretsInGuestConfig } from "./mcp-config.js";
import { discoverTools, createDispatchServer } from "./dispatch.js";
import { generateShim, generateInitScript, generateDockerfile } from "./guest-assets.js";
import { translateToolCachePathEntries } from "./paths.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, "..", "scripts");
const WORK = process.env.MV_WORKDIR || path.join(process.cwd(), ".mvwork");

// A sentinel the guest holds in place of the real inference token; the host
// gateway swaps it for the real one on the way out. Not a secret.
const FAKE_TOKEN = "ghs_FAKE_GUEST_TOKEN_DO_NOT_USE";
const DISPATCH_PORT = 9000;
const GATEWAY_PORT = 8080;

// Well-known guest mount points, mirroring the Actions container-job convention
// (actions/runner ContainerInfo.cs maps the work dir -> /__w and the tool cache ->
// /__t). We map the host paths to these fixed locations and set GITHUB_WORKSPACE /
// RUNNER_TOOL_CACHE accordingly inside the guest.
const GUEST_WORKSPACE_PATH = "/__w";
const GUEST_TOOLCACHE_PATH = "/__t";

const log = (m) => process.stderr.write(`[microvm-agent] ${m}\n`);
const runScript = (name, args = []) =>
  execFileSync("bash", [path.join(SCRIPTS, name), ...args], { stdio: "inherit" });

async function main() {
  const inputs = readInputs();
  if (!inputs.prompt) throw new Error("input 'prompt' is required.");
  if (!inputs.githubToken) throw new Error("no github-token available for the harness (gateway/github).");

  // 1. Plan MCP servers: guest config (no secrets) + host server plan (real env).
  const { guestConfig, hostServers } = buildGuestMcpConfig(inputs);
  assertNoSecretsInGuestConfig({ guestConfig, hostServers });

  // 2. Discover the tools each custom server advertises -> shims + dispatch registry.
  const discovered = await discoverTools(hostServers, { log });
  const registry = {};
  for (const { server, name } of discovered) {
    if (registry[name]) throw new Error(`Tool name collision on '${name}'.`);
    registry[name] = server;
  }
  log(`tools exposed to the guest as shims: ${discovered.map((d) => d.name).join(", ") || "(none)"}`);

  // 3. Generate the guest build context + the runtime injection tree.
  const ctx = freshDir(path.join(WORK, "guest"));
  const inject = freshDir(path.join(WORK, "inject"));
  fs.mkdirSync(path.join(inject, "etc"), { recursive: true });
  fs.mkdirSync(path.join(inject, "root", ".copilot"), { recursive: true });
  fs.mkdirSync(path.join(inject, "usr", "local", "share", "ca-certificates"), { recursive: true });

  // Plan the mounts: build a virtio-block image per host path and assign guest
  // device names in drive order (rootfs is vda, so the first extra drive is vdb).
  const { drives, initMounts } = planMounts(inputs);

  fs.writeFileSync(path.join(ctx, "init.sh"), generateInitScript({ mounts: initMounts }));
  const shimNames = discovered.map((d) => d.name);
  for (const d of discovered) {
    fs.writeFileSync(path.join(ctx, d.name), generateShim({ name: d.name, inputSchema: d.inputSchema }));
  }
  fs.writeFileSync(path.join(ctx, "Dockerfile"), generateDockerfile(shimNames));

  fs.writeFileSync(path.join(inject, "etc", "prompt.txt"), inputs.prompt + "\n");

  // Runtime agent env. The event payload is copied in (agent context only) and
  // GITHUB_EVENT_PATH repointed at the guest copy — ONLY event.json is copied,
  // never RUNNER_TEMP (checkout persists a push token there).
  let agentEnv = `export COPILOT_GITHUB_TOKEN=${FAKE_TOKEN}\n`;
  // Point the guest's GITHUB_WORKSPACE / RUNNER_TOOL_CACHE at the well-known mount
  // points, so the agent and tooling resolve them correctly inside the guest.
  if (initMounts.workspace) agentEnv += `export GITHUB_WORKSPACE=${initMounts.workspace.path}\n`;
  if (initMounts.toolcache) {
    agentEnv += `export RUNNER_TOOL_CACHE=${initMounts.toolcache.path}\n`;
    // Bring only the tool-cache PATH entries across, rewritten to the guest mount
    // point — not the whole host PATH (host-specific dirs don't exist in the guest).
    const guestPathAdds = translateToolCachePathEntries(
      process.env.PATH || "",
      inputs.toolCache,
      initMounts.toolcache.path
    );
    if (guestPathAdds.length) {
      agentEnv += `export PATH=${guestPathAdds.join(":")}:$PATH\n`;
      log(`guest PATH += ${guestPathAdds.join(":")}`);
    }
  }
  if (inputs.copyEvent && inputs.eventPath && fs.existsSync(inputs.eventPath)) {
    fs.copyFileSync(inputs.eventPath, path.join(inject, "etc", "event.json"));
    agentEnv += `export GITHUB_EVENT_PATH=/etc/event.json\n`;
    log("copied event.json into the guest (GITHUB_EVENT_PATH repointed).");
  }
  fs.writeFileSync(path.join(inject, "etc", "agent.env"), agentEnv);
  // Guest MCP config carries NO secret (asserted above).
  fs.writeFileSync(
    path.join(inject, "root", ".copilot", "mcp-config.json"),
    JSON.stringify(guestConfig, null, 2)
  );

  // 4. Provision KVM + firecracker + kernel, then the gateway CA (needed in the rootfs).
  runScript("provision.sh", [WORK]);
  if (!process.env.MV_DRY_RUN) generateGatewayCa(inject);

  // 5. Build the guest rootfs (docker export -> mkfs.ext4 -d, no loop mount) and
  //    any requested mount images (workspace/toolcache -> virtio-block ext4).
  const rootfs = path.join(WORK, "rootfs.ext4");
  runScript("build-rootfs.sh", [ctx, inject, rootfs, "3G"]);
  for (const drive of drives) {
    runScript("build-mount-image.sh", [drive.src, drive.image]);
  }

  if (process.env.MV_DRY_RUN) {
    log(`MV_DRY_RUN set: guest rootfs + ${drives.length} mount image(s) built; skipping boot.`);
    return setStatus("dry-run");
  }

  // 6. Host network: tap + NAT + firewall + gateway redirect.
  runScript("network-up.sh");

  // 7. Host services: credential gateway + MCP dispatch.
  const gwLog = fs.openSync(path.join(WORK, "gateway.log"), "a");
  const gateway = spawn(
    "mitmdump",
    ["--mode", "transparent", "--listen-host", "0.0.0.0", "--listen-port", String(GATEWAY_PORT), "-s", path.join(SCRIPTS, "gw_addon.py"), "-q", "--set", "block_global=false"],
    {
      stdio: ["ignore", gwLog, gwLog],
      env: { ...process.env, REAL_TOKEN: inputs.githubToken, FAKE_TOKEN, EXTRA_ALLOW: inputs.firewallAllow.join(",") },
    }
  );
  const dispatch = createDispatchServer(registry, { log });
  await new Promise((r) => dispatch.listen(DISPATCH_PORT, "0.0.0.0", r));
  log(`dispatch on 0.0.0.0:${DISPATCH_PORT}, gateway on :${GATEWAY_PORT}`);

  // 8. Boot the guest and run the agent (host timeout reaps the VM).
  let status = "failed";
  const consoleLog = path.join(WORK, "console.log");
  try {
    writeVmConfig(rootfs, drives);
    const seconds = Math.max(60, inputs.timeoutMinutes * 60);
    // IMPORTANT: boot with async spawn, NOT execFileSync. The dispatch HTTP
    // server lives in this same process; a synchronous boot would block the event
    // loop for the whole VM lifetime, so the guest's shim calls to :9000 would
    // hang with no response. Awaiting the child keeps the event loop free to serve
    // dispatch (and the gateway) while the guest runs.
    await bootVm(seconds, consoleLog);
    status = gradeConsole(consoleLog);
  } catch {
    // firecracker is reaped by the host timeout; grade from the console regardless.
    status = fs.existsSync(consoleLog) ? gradeConsole(consoleLog) : "failed";
  } finally {
    gateway.kill("SIGTERM");
    await new Promise((r) => dispatch.close(r));
    try {
      runScript("network-down.sh");
    } catch {
      /* best effort */
    }
  }
  setStatus(status);
  if (status !== "completed") process.exitCode = 1;
}

/**
 * Boot the guest and resolve when it exits. The host `timeout` reaps the VM at
 * the deadline, and a guest reboot makes firecracker exit cleanly, so a non-zero
 * exit is expected and not treated as an error (the console is graded instead).
 */
function bootVm(seconds, consoleLog) {
  return new Promise((resolve) => {
    const fileStream = fs.createWriteStream(consoleLog);
    const child = spawn(
      "sudo",
      ["timeout", "-k", "5", String(seconds), path.join(WORK, "firecracker"), "--api-sock", "/tmp/mv-fc.sock", "--config-file", path.join(WORK, "vm_config.json")],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    // Stream the guest's serial console live to BOTH this action's stdout (so the
    // user sees it in the workflow step log in real time) and the console.log file
    // (kept as an artifact / for grading).
    const fanout = (chunk) => {
      process.stdout.write(chunk);
      fileStream.write(chunk);
    };
    child.stdout.on("data", fanout);
    child.stderr.on("data", fanout);
    const finish = () => {
      fileStream.end();
      resolve();
    };
    child.on("close", finish);
    child.on("error", finish);
  });
}

function gradeConsole(consoleLog) {
  const text = fs.readFileSync(consoleLog, "utf8");
  return /GUEST: starting copilot/.test(text) ? "completed" : "failed";
}

function freshDir(p) {
  fs.rmSync(p, { recursive: true, force: true });
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function generateGatewayCa(inject) {
  // A short mitmdump run generates ~/.mitmproxy/mitmproxy-ca-cert.pem.
  try {
    execFileSync("bash", ["-c", "timeout 8 mitmdump -q >/dev/null 2>&1 || true"], { stdio: "ignore" });
  } catch {
    /* the timeout exit is expected */
  }
  const ca = path.join(process.env.HOME || "/root", ".mitmproxy", "mitmproxy-ca-cert.pem");
  if (!fs.existsSync(ca)) throw new Error("gateway CA was not generated (is mitmproxy installed?).");
  fs.copyFileSync(ca, path.join(inject, "etc", "mitmproxy-ca.pem"));
  fs.copyFileSync(ca, path.join(inject, "usr", "local", "share", "ca-certificates", "mitmproxy.crt"));
}

function writeVmConfig(rootfs, extraDrives = []) {
  const config = {
    "boot-source": {
      kernel_image_path: path.join(WORK, "vmlinux"),
      boot_args: "console=ttyS0 reboot=k panic=1 init=/init",
    },
    drives: [
      { drive_id: "rootfs", path_on_host: rootfs, is_root_device: true, is_read_only: false },
      // Extra drives follow the rootfs in order, so they appear as vdb, vdc, ...
      ...extraDrives.map((d) => ({
        drive_id: d.id,
        path_on_host: d.image,
        is_root_device: false,
        is_read_only: true,
      })),
    ],
    "network-interfaces": [{ iface_id: "eth0", host_dev_name: "tap0", guest_mac: "06:00:AC:10:00:02" }],
    "machine-config": { vcpu_count: 2, mem_size_mib: 2048 },
  };
  fs.writeFileSync(path.join(WORK, "vm_config.json"), JSON.stringify(config, null, 2));
}

/**
 * Decide which host paths to expose as virtio-block drives, assigning guest device
 * names in drive order (rootfs=vda, so the first extra drive is vdb). Returns the
 * drives to build/attach and the mount plan handed to the guest init.
 * @param {ReturnType<import("./inputs.js").readInputs>} inputs
 */
function planMounts(inputs) {
  const drives = [];
  const initMounts = {};
  if (inputs.mounts === "none") return { drives, initMounts };

  const letters = "bcdefg";
  let i = 0;
  const nextDev = () => `/dev/vd${letters[i++]}`;

  // workspace (RO lower + throwaway overlay), mounted at the well-known guest path.
  if (inputs.workspace && fs.existsSync(inputs.workspace)) {
    const dev = nextDev();
    drives.push({ id: "workspace", src: inputs.workspace, image: path.join(WORK, "workspace.ext4") });
    initMounts.workspace = { dev, path: GUEST_WORKSPACE_PATH };
    log(`mount: workspace ${inputs.workspace} (ro+overlay) -> ${dev} at ${GUEST_WORKSPACE_PATH}`);
  } else if (inputs.mounts !== "none") {
    log(`mount: workspace requested but GITHUB_WORKSPACE is unset/missing; skipping.`);
  }

  // toolcache (RO), opt-in via workspace+toolcache, at its standard well-known path.
  if (inputs.mounts === "workspace+toolcache") {
    if (inputs.toolCache && fs.existsSync(inputs.toolCache)) {
      const dev = nextDev();
      drives.push({ id: "toolcache", src: inputs.toolCache, image: path.join(WORK, "toolcache.ext4") });
      initMounts.toolcache = { dev, path: GUEST_TOOLCACHE_PATH };
      log(`mount: toolcache ${inputs.toolCache} (ro) -> ${dev} at ${GUEST_TOOLCACHE_PATH}`);
    } else {
      log(`mount: toolcache requested but RUNNER_TOOL_CACHE is unset/missing; skipping.`);
    }
  }

  return { drives, initMounts };
}

function setStatus(status) {
  log(`status=${status}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `status=${status}\n`);
}

main().catch((err) => {
  process.stderr.write(`microvm-agent failed: ${err.message}\n`);
  process.exit(1);
});
