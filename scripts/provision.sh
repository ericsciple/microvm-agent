#!/usr/bin/env bash
# Ensure /dev/kvm is usable and fetch the Firecracker binary + guest kernel.
# Idempotent: skips downloads that already exist. Ports the proven phase0/phase1
# recipe. Populates WORKDIR (arg 1, default .mvwork) with `firecracker` + `vmlinux`.
set -euo pipefail

WORKDIR="${1:-.mvwork}"
mkdir -p "$WORKDIR"
cd "$WORKDIR"
ARCH="$(uname -m)"

# The runner/Codespace user is not in the kvm group by default. setfacl is the
# least-privilege grant; chmod 666 is the fallback where setfacl isn't installed.
sudo setfacl -m u:"${USER}":rw /dev/kvm 2>/dev/null || sudo chmod 666 /dev/kvm || true

S3="https://s3.amazonaws.com/spec.ccfc.min"

if [ ! -f vmlinux ]; then
  CI_PREFIX=$(curl -fsSL "$S3?list-type=2&prefix=firecracker-ci/&delimiter=/" \
    | grep -oP "(?<=<Prefix>)firecracker-ci/[0-9]{8}-[^/]+/(?=</Prefix>)" | sort | tail -1)
  KERNEL_KEY=$(curl -fsSL "$S3?list-type=2&prefix=${CI_PREFIX}${ARCH}/vmlinux-" \
    | grep -oP "(?<=<Key>)(${CI_PREFIX}${ARCH}/vmlinux-[0-9]+\.[0-9]+\.[0-9]{1,3})(?=</Key>)" \
    | sort -V | tail -1)
  echo "kernel: ${KERNEL_KEY}"
  curl -fsSL "$S3/${KERNEL_KEY}" -o vmlinux
fi

if [ ! -x firecracker ]; then
  REL="https://github.com/firecracker-microvm/firecracker/releases"
  LATEST=$(basename "$(curl -fsSLI -o /dev/null -w '%{url_effective}' ${REL}/latest)")
  curl -sSL "${REL}/download/${LATEST}/firecracker-${LATEST}-${ARCH}.tgz" | tar -xz
  mv "release-${LATEST}-${ARCH}/firecracker-${LATEST}-${ARCH}" firecracker
  chmod +x firecracker
fi

./firecracker --version | head -1
echo "provisioned into ${WORKDIR}"
