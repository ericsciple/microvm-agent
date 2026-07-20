#!/usr/bin/env bash
# Provision the host for a microVM run and fetch all guest artifacts.
#
# Prebuilt-image model: instead of building a rootfs per run, we fetch a pinned
# kernel + bare rootfs from a microvm-images release and the Copilot CLI tarball,
# and cache them (tool-cache pattern) so repeat runs reuse them. The bare rootfs is
# decompressed once; main.js boots a per-run sparse copy so the cache stays pristine.
#
# Populates WORKDIR (arg 1) with `firecracker` + `vmlinux`, and the shared CACHE with
# `bare-rootfs.ext4` and `copilot/copilot`. Env:
#   IMAGES_REPO (default ericsciple/microvm-images), IMAGES_TAG (default v0.0.1),
#   COPILOT_URL (default the latest linux-x64 release tarball).
set -euo pipefail

WORKDIR="${1:-.mvwork}"
mkdir -p "$WORKDIR"
ARCH="$(uname -m)"

IMAGES_REPO="${IMAGES_REPO:-ericsciple/microvm-images}"
IMAGES_TAG="${IMAGES_TAG:-v0.0.1}"
COPILOT_URL="${COPILOT_URL:-https://github.com/github/copilot-cli/releases/latest/download/copilot-linux-x64.tar.gz}"

# Cache under the runner tool cache when available so artifacts survive across steps
# and (on self-hosted / warmed runners) across runs. Keyed by the images tag.
CACHE="${RUNNER_TOOL_CACHE:-$HOME/.cache}/microvm-agent/${IMAGES_TAG}"
mkdir -p "$CACHE" "$CACHE/copilot"

# The runner/Codespace user is not in the kvm group by default. setfacl is the
# least-privilege grant; chmod 666 is the fallback where setfacl isn't installed.
sudo setfacl -m u:"${USER}":rw /dev/kvm 2>/dev/null || sudo chmod 666 /dev/kvm || true

# zstd (rootfs decompress) + e2fsprogs (mkfs.ext4/debugfs) are needed host-side.
# They are preinstalled on hosted runners; install on demand otherwise.
if ! command -v zstd >/dev/null 2>&1 || ! command -v debugfs >/dev/null 2>&1; then
  sudo apt-get update -q >/dev/null 2>&1 || true
  sudo apt-get install -y -q zstd e2fsprogs >/dev/null 2>&1 || true
fi

dl() { # dl <url> <out>  — download only if missing
  [ -s "$2" ] || { echo "fetch: $1"; curl -fsSL --retry 3 "$1" -o "$2"; }
}

REL="https://github.com/${IMAGES_REPO}/releases/download/${IMAGES_TAG}"

# Guest kernel (pinned) — compressed asset from the images release; decompress once
# (Firecracker boots an uncompressed kernel), cached, then copy into WORKDIR.
dl "${REL}/vmlinux.zst" "$CACHE/vmlinux.zst"
if [ ! -s "$CACHE/vmlinux" ]; then
  echo "decompressing kernel"
  zstd -dq -f "$CACHE/vmlinux.zst" -o "$CACHE/vmlinux"
fi
cp "$CACHE/vmlinux" "$WORKDIR/vmlinux"

# Bare rootfs (pinned) — fetch the compressed ext4 once, decompress once.
dl "${REL}/bare-rootfs.ext4.zst" "$CACHE/bare-rootfs.ext4.zst"
if [ ! -s "$CACHE/bare-rootfs.ext4" ]; then
  echo "decompressing bare rootfs"
  zstd -dq -f "$CACHE/bare-rootfs.ext4.zst" -o "$CACHE/bare-rootfs.ext4"
fi

# Copilot CLI — fetched host-side and mounted into the guest (not baked). Cached.
if [ ! -s "$CACHE/copilot/copilot" ]; then
  echo "fetch: $COPILOT_URL"
  curl -fsSL --retry 3 "$COPILOT_URL" -o "$CACHE/copilot.tgz"
  tar -xz -C "$CACHE/copilot" -f "$CACHE/copilot.tgz"
  chmod +x "$CACHE/copilot/copilot"
  rm -f "$CACHE/copilot.tgz"
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

# Export the cache location for main.js (it reads MV_CACHE_DIR).
echo "MV_CACHE_DIR=$CACHE" > "$WORKDIR/provision.env"
"$WORKDIR/firecracker" --version | head -1
echo "provisioned into ${WORKDIR} (cache ${CACHE})"
