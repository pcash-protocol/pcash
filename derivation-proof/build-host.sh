#!/usr/bin/env bash
# Build the host natively against the same circuit bundle as the guest.
#
# Requires PCASH_TOOL_ROOT and PCASH_CIRCUIT_CACHE, as for build-guest.sh, and
# protoc (on PATH, or PROTOC) for the SP1 SDK's build. Writes the binary path
# to stdout.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
: "${PCASH_TOOL_ROOT:?}" "${PCASH_CIRCUIT_CACHE:?}"
target_dir="${HOST_TARGET_DIR:-$here/target/host}"

bundle="$(node "$repo/scripts/circuits/bundle.mjs" --print-path 2>/dev/null | tail -n 1)"
[ -d "$bundle" ] || { echo "circuit bundle did not resolve" >&2; exit 1; }

export PCASH_CIRCUIT_BUNDLE="$bundle"
cd "$here/host"
CARGO_TARGET_DIR="$target_dir" cargo build --release >&2
echo "$target_dir/release/derivation-proof-host"
