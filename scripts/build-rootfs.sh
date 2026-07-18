#!/usr/bin/env bash
# Build an ext4 guest rootfs from a docker build context, overlaying runtime
# injection files, WITHOUT a loop mount.
#
# Firecracker shares host paths as virtio-block images, and Codespaces (and some
# runners) can't loop-mount, so we build the filesystem directly from a directory
# tree with `mkfs.ext4 -d` (proven in phase0). Runtime files (prompt.txt,
# agent.env, the gateway CA, the guest MCP config) are laid over the exported tree
# before mkfs, since we can't mount-and-copy afterwards.
#
# Usage: build-rootfs.sh <context_dir> <inject_dir> <out.ext4> [size]
set -euo pipefail

CTX="$1"
INJECT="$2"
OUT="$3"
SIZE="${4:-3G}"
IMG="mv-guest-$$"

docker build -q -t "$IMG" "$CTX" >/dev/null
cid=$(docker create "$IMG")
docker export "$cid" -o "${OUT}.tar"
docker rm "$cid" >/dev/null
docker rmi "$IMG" >/dev/null 2>&1 || true

ROOT="$(mktemp -d)"
sudo tar -C "$ROOT" -xf "${OUT}.tar"
if [ -d "$INJECT" ]; then
  sudo cp -a "$INJECT/." "$ROOT/"
fi

truncate -s "$SIZE" "$OUT"
sudo mkfs.ext4 -q -d "$ROOT" -F "$OUT"

sudo rm -rf "$ROOT" "${OUT}.tar"
echo "built ${OUT} (${SIZE})"
