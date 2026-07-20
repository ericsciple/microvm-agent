// Fetch the prebuilt guest artifacts via @actions/tool-cache: the pinned kernel +
// bare rootfs (from the microvm-images release) and the Copilot CLI. tool-cache gives
// us retrying downloads, tarball extraction, and a versioned cache under
// RUNNER_TOOL_CACHE (warm-after-first-use; pre-populatable on hosted runners).
//
// The kernel and rootfs ship as single zstd-compressed files, which tool-cache does
// not decompress, so we shell out to `zstd -d` (installed by provision.sh) and cache
// the decompressed result. The Copilot CLI ships as a .tar.gz, which tool-cache
// extracts directly.

import path from "node:path";
import * as tc from "@actions/tool-cache";
import * as exec from "@actions/exec";

// Download `url`, zstd-decompress to a file named `outName`, and cache it under
// (tool, version). Returns the path to the cached decompressed file.
async function fetchZstFile(url, outName, tool, version) {
  const cached = tc.find(tool, version);
  if (cached) return path.join(cached, outName);
  const z = await tc.downloadTool(url);
  const out = `${z}.${outName}`;
  await exec.exec("zstd", ["-dq", "-f", z, "-o", out]);
  const dir = await tc.cacheFile(out, outName, tool, version);
  return path.join(dir, outName);
}

/**
 * @param {{imagesRepo:string, imagesTag:string, copilotUrl:string, copilotVersion:string}} opts
 * @returns {Promise<{kernelPath:string, rootfsPath:string, copilotDir:string}>}
 */
export async function fetchArtifacts({ imagesRepo, imagesTag, copilotUrl, copilotVersion }) {
  const rel = `https://github.com/${imagesRepo}/releases/download/${imagesTag}`;

  const kernelPath = await fetchZstFile(`${rel}/vmlinux.zst`, "vmlinux", "microvm-vmlinux", imagesTag);
  const rootfsPath = await fetchZstFile(`${rel}/bare-rootfs.ext4.zst`, "bare-rootfs.ext4", "microvm-rootfs", imagesTag);

  // Copilot CLI: a .tar.gz that extracts to a single `copilot` binary.
  let copilotDir = tc.find("microvm-copilot", copilotVersion);
  if (!copilotDir) {
    const tgz = await tc.downloadTool(copilotUrl);
    const extracted = await tc.extractTar(tgz);
    copilotDir = await tc.cacheDir(extracted, "microvm-copilot", copilotVersion);
  }

  return { kernelPath, rootfsPath, copilotDir };
}
