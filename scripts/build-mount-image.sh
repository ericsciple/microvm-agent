#!/usr/bin/env bash
# Build a virtio-block ext4 image populated from a host directory, WITHOUT a loop
# mount (Codespaces has no loop devices; `mkfs.ext4 -d` works on runners too).
#
# Firecracker has no virtiofs/bind mounts, so a host path is shared by turning it
# into an ext4 image and attaching it as a drive. Attaching that drive with
# is_read_only:true is hypervisor-enforced read-only (see phase6). The image is
# auto-sized from the source tree plus headroom.
#
# Usage: build-mount-image.sh <src_dir> <out.ext4> [extra_margin_mb]
set -euo pipefail

SRC="$1"
OUT="$2"
MARGIN_MB="${3:-256}"

if [ ! -d "$SRC" ]; then
  echo "build-mount-image: source directory does not exist: $SRC" >&2
  exit 1
fi

USED_MB=$(du -sm --apparent-size "$SRC" 2>/dev/null | cut -f1)
[ -n "$USED_MB" ] || USED_MB=0
# ext4 needs room for metadata/journal; size = apparent used + margin, min 64 MiB.
SIZE_MB=$((USED_MB + MARGIN_MB))
[ "$SIZE_MB" -ge 64 ] || SIZE_MB=64

rm -f "$OUT"
truncate -s "${SIZE_MB}M" "$OUT"
sudo mkfs.ext4 -q -d "$SRC" -F "$OUT"
echo "built ${OUT} (${SIZE_MB}M) from ${SRC}"
