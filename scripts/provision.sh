#!/usr/bin/env bash
# Host setup for a microVM run. The guest artifacts (kernel, rootfs, Copilot) are
# fetched separately by the action via @actions/tool-cache (see src/artifacts.js);
# this script handles the host-only bits: KVM access, the Firecracker binary, the
# decompression/filesystem tools, and the credential gateway (mitmproxy).
#
# Populates WORKDIR (arg 1) with the `firecracker` binary.
set -euo pipefail

WORKDIR="${1:-.mvwork}"
mkdir -p "$WORKDIR"
ARCH="$(uname -m)"

# The runner/Codespace user is not in the kvm group by default. setfacl is the
# least-privilege grant; chmod 666 is the fallback where setfacl isn't installed.
sudo setfacl -m u:"${USER}":rw /dev/kvm 2>/dev/null || sudo chmod 666 /dev/kvm || true

# zstd (kernel/rootfs decompress) + e2fsprogs (mkfs.ext4/debugfs) are needed host-side.
# Preinstalled on hosted runners; install on demand otherwise.
if ! command -v zstd >/dev/null 2>&1 || ! command -v debugfs >/dev/null 2>&1; then
  sudo apt-get update -q >/dev/null 2>&1 || true
  sudo apt-get install -y -q zstd e2fsprogs >/dev/null 2>&1 || true
fi

# Firecracker binary (cached in WORKDIR).
if [ ! -x "$WORKDIR/firecracker" ]; then
  FREL="https://github.com/firecracker-microvm/firecracker/releases"
  LATEST=$(basename "$(curl -fsSLI -o /dev/null -w '%{url_effective}' ${FREL}/latest)")
  curl -sSL "${FREL}/download/${LATEST}/firecracker-${LATEST}-${ARCH}.tgz" | tar -xz -C "$WORKDIR"
  mv "$WORKDIR/release-${LATEST}-${ARCH}/firecracker-${LATEST}-${ARCH}" "$WORKDIR/firecracker"
  chmod +x "$WORKDIR/firecracker"
fi

# The credential gateway uses mitmproxy (mitmdump) — a HARNESS dependency, installed
# here if missing. pipx (isolated) is preferred; fall back to pip. -> ~/.local/bin,
# which main.js adds to PATH when it launches the gateway.
if ! command -v mitmdump >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/mitmdump" ]; then
  echo "installing mitmproxy (gateway dependency)"
  if command -v pipx >/dev/null 2>&1; then
    pipx install mitmproxy >/dev/null
  else
    pip3 install --user mitmproxy >/dev/null 2>&1 || pip3 install --break-system-packages mitmproxy >/dev/null
  fi
fi

"$WORKDIR/firecracker" --version | head -1
echo "host setup complete (${WORKDIR})"
