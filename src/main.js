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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as core from "@actions/core";
import * as exec from "@actions/exec";

import { readInputs } from "./inputs.js";
import { buildGuestMcpConfig, assertNoSecretsInGuestConfig } from "./mcp-config.js";
import { createDispatchServer } from "./dispatch.js";
import { fetchArtifacts } from "./artifacts.js";
import { generateServerShim, generateMcpPreamble, generateInitScript, DEFAULT_MCP_DIR, DEFAULT_RUNTIME_DIR, DEFAULT_COPILOT_DIR } from "./guest-assets.js";
import { translateToolCachePathEntries } from "./paths.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, "..", "scripts");
// Scratch dir for the kernel, rootfs, and mount images. MUST live OUTSIDE
// GITHUB_WORKSPACE: our multi-GB artifacts (rootfs.ext4, the mount images
// themselves) would otherwise be packaged into the workspace mount image and
// overflow it. Prefer RUNNER_TEMP (runner scratch, never checked out, never
// mounted into the guest); fall back to the OS temp dir.
const WORK =
  process.env.MV_WORKDIR ||
  path.join(process.env.RUNNER_TEMP || os.tmpdir(), "microvm-agent-work");


// A sentinel the guest holds in place of the real inference token; the host
// gateway swaps it for the real one on the way out. Not a secret.
const FAKE_TOKEN = "ghs_FAKE_GUEST_TOKEN_DO_NOT_USE";
const DISPATCH_PORT = 9000;
const GATEWAY_PORT = 8080;

// Decision A: the gateway binds each sentinel to ONE real credential and an explicit
// set of targets. The inference lane's real credential (the job token, host-side only)
// is swapped in ONLY on the inference host and the Copilot token-exchange path; every
// other api.github.com path is deny-by-default, so the guest can never turn the
// sentinel into the write-scoped job token. Hosts the guest may merely reach (no
// credential injected) go in EGRESS_ALLOW, not here.
function buildGatewayLanes(inputs) {
  return [
    {
      name: "inference",
      sentinel: FAKE_TOKEN,
      real: inputs.githubToken,
      targets: [
        // Copilot inference + the built-in read-only github MCP (rides copilot auth).
        { host: "api.githubcopilot.com" },
        // The Copilot token-exchange namespace (POST /copilot_internal/v2/token, etc.).
        // No general-write REST endpoint lives under this prefix.
        { host: "api.github.com", path_prefix: "/copilot_internal/" },
      ],
    },
  ];
}

// provision.sh installs mitmproxy (the gateway) to ~/.local/bin; make sure that's
// on PATH when we invoke mitmdump, even if the runner hasn't added it yet.
const LOCAL_BIN = path.join(process.env.HOME || "/root", ".local", "bin");
const GATEWAY_ENV = { ...process.env, PATH: `${LOCAL_BIN}:${process.env.PATH || ""}` };

// Well-known guest mount points, mirroring the Actions container-job convention
// (actions/runner ContainerInfo.cs maps the work dir -> /__w and the tool cache ->
// /__t). We map the host paths to these fixed locations and set GITHUB_WORKSPACE /
// RUNNER_TOOL_CACHE accordingly inside the guest.
const GUEST_WORKSPACE_PATH = "/__w";
const GUEST_TOOLCACHE_PATH = "/__t";

const log = (m) => core.info(`[microvm-agent] ${m}`);
// Run a provisioning script via @actions/exec (echoes the command + streams output
// live to the step log). No secrets are passed as args (only IMAGES_*/COPILOT_URL and
// mount paths), so the command echo is safe.
const runScript = (name, args = [], extraEnv = {}) =>
  exec.exec("bash", [path.join(SCRIPTS, name), ...args], {
    env: { ...process.env, ...extraEnv },
  });

// Prebuilt guest artifacts: the pinned microvm-images release the harness fetches the
// kernel + bare rootfs from. Hardcoded (not a user input) — a given version of this
// action maps to a known-compatible {kernel, rootfs} set. Bump these together with the
// action when cutting a new images release.
const IMAGES_REPO = "ericsciple/microvm-images";
const IMAGES_TAG = "v0.0.1";
const COPILOT_URL = "https://github.com/github/copilot-cli/releases/latest/download/copilot-linux-x64.tar.gz";

// A per-run writable rootfs, so the cached bare rootfs stays pristine across runs.
// Sparse copy (the 2G ext4 is mostly empty), boot read-write, discard after.
function copyRootfs(src, dest) {
  execFileSync("cp", ["--reflink=auto", "--sparse=always", src, dest]);
  log(`rootfs: per-run copy ${dest}`);
}

// The Copilot CLI compatibility floor (measured from the pinned linux-x64 build:
// highest GLIBC symbol needed is 2.28; it also NEEDs libstdc++.so.6). musl unsupported.
const GLIBC_FLOOR = [2, 28];

// Fail fast if the rootfs can't run the Copilot CLI: x86_64 + glibc >= floor +
// libstdc++ present, no musl. Reads the ext4 with debugfs (no mount needed). Best-effort
// on a custom rootfs; a no-op-ish sanity check for our own bare rootfs.
function preflightRootfs(img) {
  if (os.arch() !== "x64") throw new Error(`microvm-agent supports x86_64 only (host arch: ${os.arch()}).`);
  const debug = (cmd) => {
    try {
      return execFileSync("debugfs", ["-R", cmd, img], { stdio: ["ignore", "pipe", "ignore"] }).toString();
    } catch {
      return "";
    }
  };
  const libDir = "/lib/x86_64-linux-gnu";
  const lsLib = debug(`ls -l ${libDir}`);
  if (!lsLib) { log("preflight: could not read rootfs libs via debugfs; skipping (custom rootfs?)."); return; }
  if (/ld-musl|libc\.musl/.test(lsLib) || (!/libc\.so\.6/.test(lsLib) && !/libc-/.test(lsLib))) {
    throw new Error("rootfs looks like musl/Alpine or has no glibc; the Copilot CLI needs glibc. Use a glibc rootfs (x86_64, glibc >= 2.28).");
  }
  if (!/libstdc\+\+\.so\.6/.test(lsLib)) {
    throw new Error("rootfs is missing libstdc++.so.6, which the Copilot CLI requires. Install libstdc++6 in the rootfs.");
  }
  // Extract libc.so.6 and read its glibc release version.
  try {
    const tmp = path.join(WORK, "libc.probe");
    execFileSync("debugfs", ["-R", `dump ${libDir}/libc.so.6 ${tmp}`, img], { stdio: "ignore" });
    const s = fs.readFileSync(tmp);
    const txt = s.toString("latin1");
    const m = /GNU C Library.*?version (\d+)\.(\d+)/.exec(txt) || /release version (\d+)\.(\d+)/.exec(txt);
    fs.rmSync(tmp, { force: true });
    if (m) {
      const v = [parseInt(m[1], 10), parseInt(m[2], 10)];
      const ok = v[0] > GLIBC_FLOOR[0] || (v[0] === GLIBC_FLOOR[0] && v[1] >= GLIBC_FLOOR[1]);
      if (!ok) throw new Error(`rootfs glibc ${v[0]}.${v[1]} is too old; the Copilot CLI needs glibc >= ${GLIBC_FLOOR.join(".")}.`);
      log(`preflight: rootfs glibc ${v[0]}.${v[1]} (>= ${GLIBC_FLOOR.join(".")}), libstdc++ present — OK.`);
    } else {
      log("preflight: glibc version string not found; libstdc++ present, not musl — proceeding.");
    }
  } catch (e) {
    if (/too old/.test(e.message)) throw e;
    log(`preflight: glibc version probe inconclusive (${e.message}); libstdc++ present, not musl — proceeding.`);
  }
}

async function main() {
  const inputs = readInputs();
  if (!inputs.prompt) throw new Error("input 'prompt' is required.");
  if (!inputs.githubToken) throw new Error("no github-token available for the harness (gateway/github).");

  // 1. Plan MCP servers: guest config (no secrets) + host server plan (real env).
  const { guestConfig, hostServers } = buildGuestMcpConfig(inputs);
  assertNoSecretsInGuestConfig({ guestConfig, hostServers });

  // 2. Build the server map for lazy dispatch (keyed by server name). No startup
  // tools/list — discovery is lazy (dispatch fetches + caches per server on demand).
  const serverMap = {};
  for (const s of hostServers) {
    if (!s.command) continue;
    serverMap[s.name] = s;
  }
  const serverNames = Object.keys(serverMap);
  log(`MCP servers exposed to the guest as shims: ${serverNames.join(", ") || "(none)"}`);

  // 3. Host setup (KVM, firecracker, mitmproxy) + fetch the prebuilt guest artifacts
  //    (pinned kernel + bare rootfs from the images release, the Copilot CLI) via
  //    @actions/tool-cache — warm-after-first-use under RUNNER_TOOL_CACHE.
  await runScript("provision.sh", [WORK]);
  const { kernelPath, rootfsPath, copilotDir } = await fetchArtifacts({
    imagesRepo: IMAGES_REPO,
    imagesTag: IMAGES_TAG,
    copilotUrl: inputs.copilotUrl || COPILOT_URL,
    copilotVersion: IMAGES_TAG,
  });

  // 4. Preflight the rootfs compatibility contract (x86_64 + glibc >= floor +
  //    libstdc++). For our bare rootfs this is a sanity check; it mainly guards a
  //    custom rootfs. Fail fast with an actionable error, not a late boot hang.
  const rootfsSrc = inputs.rootfs || rootfsPath;
  if (!process.env.MV_DRY_RUN) preflightRootfs(rootfsSrc);

  // 5a. Assemble the read-only /__mcp harness mount: one shim per server + event.json.
  const harnessSrc = freshDir(path.join(WORK, "harness"));
  for (const name of serverNames) {
    const shimPath = path.join(harnessSrc, name);
    fs.writeFileSync(shimPath, generateServerShim(name));
    fs.chmodSync(shimPath, 0o755);
  }
  let guestEventPath = "";
  if (inputs.copyEvent && inputs.eventPath && fs.existsSync(inputs.eventPath)) {
    fs.copyFileSync(inputs.eventPath, path.join(harnessSrc, "event.json"));
    guestEventPath = `${DEFAULT_MCP_DIR}/event.json`;
    log("copied event.json into the /__mcp harness mount (GITHUB_EVENT_PATH repointed).");
  }
  const harnessHasContent = serverNames.length > 0 || guestEventPath !== "";

  // 5b. The per-run runtime config mount (/__rt, always vdb): init.sh + prompt.txt +
  //     agent.env + mitmproxy-ca.pem + mcp-config.json. The bare rootfs is prebuilt and
  //     generic, so nothing is baked in — everything run-specific rides this mount.
  const rtSrc = freshDir(path.join(WORK, "runtime"));
  if (!process.env.MV_DRY_RUN) generateGatewayCa(rtSrc);
  else fs.writeFileSync(path.join(rtSrc, "mitmproxy-ca.pem"), ""); // dry-run has no gateway

  // 5c. The Copilot CLI mount (vdc): the fetched binary dir, mounted with a discard overlay.
  const copilotSrc = copilotDir;

  // 6. Plan drives + guest mount points. Order is fixed: vda rootfs, vdb runtime,
  //    vdc copilot, then harness/workspace/toolcache.
  const { drives, initMounts } = planMounts(inputs, {
    rtSrc,
    copilotSrc,
    harnessSrc: harnessHasContent ? harnessSrc : null,
  });

  // init.sh (delivered on /__rt) — references its config files from /__rt.
  fs.writeFileSync(
    path.join(rtSrc, "init.sh"),
    generateInitScript({ mounts: initMounts, dns: process.env.MV_DNS_RESOLVER || "8.8.8.8" })
  );

  // The prompt = MCP preamble (isolation notice, event path, how to run tools) + the
  // user's prompt.
  const preamble = generateMcpPreamble(serverNames, { mcpDir: DEFAULT_MCP_DIR });
  fs.writeFileSync(path.join(rtSrc, "prompt.txt"), preamble + inputs.prompt + "\n");

  // Runtime agent env (no secrets — all fake sentinels).
  let agentEnv = `export COPILOT_GITHUB_TOKEN=${FAKE_TOKEN}\n`;
  // In native github mode, the CLI's built-in github server may read the token from a
  // different env var; export the SAME fake sentinel under the common names so the
  // gateway's fake->real swap covers whichever one it uses (all fake — safe).
  if (inputs.githubMode === "native") {
    agentEnv += `export GITHUB_PERSONAL_ACCESS_TOKEN=${FAKE_TOKEN}\n`;
    agentEnv += `export GITHUB_TOKEN=${FAKE_TOKEN}\n`;
    agentEnv += `export GH_TOKEN=${FAKE_TOKEN}\n`;
  }
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
  if (guestEventPath) agentEnv += `export GITHUB_EVENT_PATH=${guestEventPath}\n`;
  fs.writeFileSync(path.join(rtSrc, "agent.env"), agentEnv);
  // Guest MCP config carries NO secret (asserted above). Empty by default — every
  // server reaches the guest as a /__mcp shim, not a native guest MCP entry.
  fs.writeFileSync(path.join(rtSrc, "mcp-config.json"), JSON.stringify(guestConfig, null, 2));

  // 7. Build images: a per-run writable sparse copy of the bare rootfs (so the cached
  //    original stays pristine) + one virtio-block ext4 per drive.
  const rootfs = path.join(WORK, "rootfs.ext4");
  copyRootfs(rootfsSrc, rootfs);
  for (const drive of drives) {
    await runScript("build-mount-image.sh", [drive.src, drive.image]);
  }

  if (process.env.MV_DRY_RUN) {
    log(`MV_DRY_RUN set: rootfs copy + ${drives.length} mount image(s) built; skipping boot.`);
    return setStatus("dry-run");
  }

  // 6. Host network: tap + NAT + firewall + gateway redirect.
  await runScript("network-up.sh");

  // 7. Host services: credential gateway + MCP dispatch.
  const gwLog = fs.openSync(path.join(WORK, "gateway.log"), "a");
  // Copilot support hosts the guest may reach for plain egress (NO credential
  // injected) + the user's firewall-allow hosts. api.github.com is deliberately NOT
  // here — it is reachable only via the inference lane's token-exchange path prefix.
  const egressAllow = ["api.mcp.github.com", ...inputs.firewallAllow].join(",");
  const gateway = spawn(
    "mitmdump",
    ["--mode", "transparent", "--listen-host", "0.0.0.0", "--listen-port", String(GATEWAY_PORT), "-s", path.join(SCRIPTS, "gw_addon.py"), "-q", "--set", "block_global=false"],
    {
      stdio: ["ignore", gwLog, gwLog],
      env: {
        ...GATEWAY_ENV,
        GW_LANES: JSON.stringify(buildGatewayLanes(inputs)),
        EGRESS_ALLOW: egressAllow,
        GW_LOG_DIR: WORK,
      },
    }
  );
  const dispatch = createDispatchServer(serverMap, { log });
  await new Promise((r) => dispatch.listen(DISPATCH_PORT, "0.0.0.0", r));
  log(`dispatch on 0.0.0.0:${DISPATCH_PORT}, gateway on :${GATEWAY_PORT}`);

  // 8. Boot the guest and run the agent (host timeout reaps the VM).
  let status = "failed";
  const consoleLog = path.join(WORK, "console.log");
  try {
    writeVmConfig(rootfs, drives, kernelPath);
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
      await runScript("network-down.sh");
    } catch {
      /* best effort */
    }
  }
  setStatus(status);
  if (status !== "completed") core.setFailed(`agent did not complete (status=${status}).`);
}

/**
 * Boot the guest and resolve when it exits. The host `timeout` reaps the VM at
 * the deadline, and a guest reboot makes firecracker exit cleanly, so a non-zero
 * exit is expected and not treated as an error (the console is graded instead).
 *
 * Uses @actions/exec (awaited, so the event loop stays free to serve the in-process
 * dispatch + gateway while the VM runs) — it streams the serial console live to the
 * step log, and a listener also captures it to console.log for grading.
 */
async function bootVm(seconds, consoleLog) {
  const sock = path.join(WORK, "mv-fc.sock");
  // Remove any stale API socket so a retry in the same workdir doesn't fail to bind.
  try {
    execFileSync("sudo", ["rm", "-f", sock], { stdio: "ignore" });
  } catch {
    /* best effort */
  }
  const fileStream = fs.createWriteStream(consoleLog);
  const capture = (chunk) => fileStream.write(chunk);
  await exec.exec(
    "sudo",
    ["timeout", "-k", "5", String(seconds), path.join(WORK, "firecracker"), "--api-sock", sock, "--config-file", path.join(WORK, "vm_config.json")],
    { ignoreReturnCode: true, listeners: { stdout: capture, stderr: capture } }
  );
  await new Promise((r) => fileStream.end(r));
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

function generateGatewayCa(rtDir) {
  // A short mitmdump run generates ~/.mitmproxy/mitmproxy-ca-cert.pem.
  try {
    execFileSync("bash", ["-c", "timeout 8 mitmdump -q >/dev/null 2>&1 || true"], { stdio: "ignore", env: GATEWAY_ENV });
  } catch {
    /* the timeout exit is expected */
  }
  const ca = path.join(process.env.HOME || "/root", ".mitmproxy", "mitmproxy-ca-cert.pem");
  if (!fs.existsSync(ca)) throw new Error("gateway CA was not generated (is mitmproxy installed?).");
  // Delivered on the runtime drive (/__rt); init.sh copies it into the guest trust store.
  fs.copyFileSync(ca, path.join(rtDir, "mitmproxy-ca.pem"));
}

function writeVmConfig(rootfs, extraDrives = [], kernelPath = path.join(WORK, "vmlinux")) {
  const config = {
    "boot-source": {
      kernel_image_path: kernelPath,
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
 * names in a FIXED order: rootfs=vda, runtime=vdb (the bare rootfs's /init stub
 * hardcodes vdb -> /__rt), copilot=vdc, then the /__mcp harness, workspace, toolcache.
 * Install-type mounts (copilot/workspace/toolcache) get a discard overlay in-guest.
 * @param {ReturnType<import("./inputs.js").readInputs>} inputs
 * @param {{rtSrc:string, copilotSrc:string, harnessSrc:string|null}} sources
 */
function planMounts(inputs, { rtSrc, copilotSrc, harnessSrc = null }) {
  const drives = [];
  const initMounts = {};

  const letters = "bcdefg";
  let i = 0;
  const nextDev = () => `/dev/vd${letters[i++]}`;

  // runtime config (/__rt): ALWAYS vdb — the baked /init stub mounts vdb and execs
  // /__rt/init.sh. Not exposed to the agent (plumbing), so it's not in initMounts.
  const rtDev = nextDev();
  drives.push({ id: "runtime", src: rtSrc, image: path.join(WORK, "runtime.ext4") });
  log(`mount: runtime ${rtSrc} (ro) -> ${rtDev} at ${DEFAULT_RUNTIME_DIR}`);

  // copilot: ALWAYS present; mounted with a discard overlay, added to PATH by init.sh.
  const cpDev = nextDev();
  drives.push({ id: "copilot", src: copilotSrc, image: path.join(WORK, "copilot.ext4") });
  initMounts.copilot = { dev: cpDev, path: DEFAULT_COPILOT_DIR };
  log(`mount: copilot ${copilotSrc} (ro+overlay) -> ${cpDev} at ${DEFAULT_COPILOT_DIR}`);

  // harness (/__mcp): shims + event.json, read-only. First agent-facing mount when present.
  if (harnessSrc) {
    const dev = nextDev();
    drives.push({ id: "harness", src: harnessSrc, image: path.join(WORK, "harness.ext4") });
    initMounts.harness = { dev, path: DEFAULT_MCP_DIR };
    log(`mount: harness ${harnessSrc} (ro) -> ${dev} at ${DEFAULT_MCP_DIR}`);
  }

  if (inputs.mounts === "none") return { drives, initMounts };

  // workspace (RO lower + throwaway overlay), mounted at the well-known guest path.
  if (inputs.workspace && fs.existsSync(inputs.workspace)) {
    const dev = nextDev();
    drives.push({ id: "workspace", src: inputs.workspace, image: path.join(WORK, "workspace.ext4") });
    initMounts.workspace = { dev, path: GUEST_WORKSPACE_PATH };
    log(`mount: workspace ${inputs.workspace} (ro+overlay) -> ${dev} at ${GUEST_WORKSPACE_PATH}`);
  } else {
    log(`mount: workspace requested but GITHUB_WORKSPACE is unset/missing; skipping.`);
  }

  // toolcache (RO lower + throwaway overlay), opt-in, at its well-known path.
  if (inputs.mounts === "workspace+toolcache") {
    if (inputs.toolCache && fs.existsSync(inputs.toolCache)) {
      const dev = nextDev();
      drives.push({ id: "toolcache", src: inputs.toolCache, image: path.join(WORK, "toolcache.ext4") });
      initMounts.toolcache = { dev, path: GUEST_TOOLCACHE_PATH };
      log(`mount: toolcache ${inputs.toolCache} (ro+overlay) -> ${dev} at ${GUEST_TOOLCACHE_PATH}`);
    } else {
      log(`mount: toolcache requested but RUNNER_TOOL_CACHE is unset/missing; skipping.`);
    }
  }

  return { drives, initMounts };
}

function setStatus(status) {
  log(`status=${status}`);
  core.setOutput("status", status);
}

main().catch((err) => {
  core.setFailed(`microvm-agent failed: ${err.message}`);
});
