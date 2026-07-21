#!/usr/bin/env bash
# Vendor the safe-outputs MCP CLI into this action, so it ships in-the-box.
#
# WHY: the microvm-agent action is useless without at least one safe output (a write
# mechanism), and safe-outputs is the first-party one. Rather than make customers add a
# separate setup step, we carry a copy of the safe-outputs source in `vendor/` and put it
# on PATH at runtime. Customers STILL declare each safe output in their mcp-config (that
# declaration is the scoping boundary) — bundling only affects availability, not wiring.
#
# RELIABILITY: this runs at BUILD time, never at runtime. The vendored copy is committed,
# so a workflow run needs no network to use safe-outputs. A failed/partial fetch can never
# leave a broken vendor dir: we download to a temp dir, verify the archive, and only then
# swap it into place and write the `.complete` marker (which records the pinned ref).
#
# Usage:
#   scripts/vendor-safe-outputs.sh                 # fetch the pinned tag and vendor it
#   scripts/vendor-safe-outputs.sh --force         # re-vendor even if already at the ref
#   scripts/vendor-safe-outputs.sh --from-local ../safe-outputs   # vendor a local checkout (dev)
set -euo pipefail

# The pinned safe-outputs release tag. Bump deliberately (then re-run this script + commit).
SAFE_OUTPUTS_REF="v0.1.0"
SAFE_OUTPUTS_REPO="ericsciple/safe-outputs"

HERE="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HERE/vendor/safe-outputs"
MARKER="$DEST/.complete"

FROM_LOCAL=""
FORCE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from-local) FROM_LOCAL="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# The marker records what is currently vendored. Skip if it already matches (unless --force).
want_ref="${FROM_LOCAL:+local:$FROM_LOCAL}"
want_ref="${want_ref:-$SAFE_OUTPUTS_REF}"
if [ -z "$FORCE" ] && [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "$want_ref" ]; then
  echo "vendor/safe-outputs already at '$want_ref' (use --force to re-vendor)."
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1. Get the source into $TMP/src (from a local checkout, or the pinned release tarball).
if [ -n "$FROM_LOCAL" ]; then
  SRC="$FROM_LOCAL/src"
  [ -d "$SRC" ] || { echo "no src/ under --from-local '$FROM_LOCAL'" >&2; exit 1; }
  cp -R "$SRC" "$TMP/src"
  echo "vendoring safe-outputs from local checkout: $FROM_LOCAL"
else
  URL="https://github.com/$SAFE_OUTPUTS_REPO/archive/refs/tags/$SAFE_OUTPUTS_REF.tar.gz"
  echo "fetching $URL"
  # Download to a temp file, then VERIFY the archive before trusting it. A partial or
  # corrupt download fails `tar tzf` here and we bail without touching vendor/.
  curl -fsSL -o "$TMP/src.tar.gz" "$URL"
  tar tzf "$TMP/src.tar.gz" >/dev/null || { echo "downloaded archive is not a valid tar.gz" >&2; exit 1; }
  tar xzf "$TMP/src.tar.gz" -C "$TMP"
  # The tarball extracts to a single top dir like `safe-outputs-0.1.0/`; find it via glob
  # (no pipe-to-head, which would trip SIGPIPE under `set -o pipefail`).
  topdir=""
  for d in "$TMP"/safe-outputs-*/; do topdir="$d"; done
  [ -n "$topdir" ] && [ -d "${topdir}src" ] || { echo "extracted archive has no src/" >&2; exit 1; }
  cp -R "${topdir}src" "$TMP/src"
fi

# 2. Only the runtime source is needed. Drop tests to keep the vendored copy lean.
find "$TMP/src" -name '*.test.js' -delete 2>/dev/null || true

# 3. safe-outputs is "type": "module" ESM, so the vendored copy needs a package.json that
#    marks it as ESM (else node treats the .js files as CommonJS and the imports break).
cat > "$TMP/package.json" <<'JSON'
{
  "name": "safe-outputs-vendored",
  "private": true,
  "type": "module"
}
JSON

# 4. Verify-then-swap: everything above succeeded, so atomically replace vendor/ now.
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$TMP/src" "$DEST/src"
cp "$TMP/package.json" "$DEST/package.json"

# 5. Marker is written LAST, only after a fully successful vendor — records the ref.
printf '%s\n' "$want_ref" > "$MARKER"
echo "vendored safe-outputs ($want_ref) into $DEST"
