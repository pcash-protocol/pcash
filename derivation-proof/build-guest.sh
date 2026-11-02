#!/usr/bin/env bash
# Build an SP1 program ELF the way sp1-build does: SP1's rustc with its flags,
# for SP1's RISC-V target. The argument names the program's directory: guest
# (the range program, the default) or aggregation. toolchain.sh sets up the
# toolchain and bb's verifier.
#
# The build runs in a linux/amd64 image of pinned Rust and Node (the node
# crates' build scripts run bundle.mjs), with this checkout at /pcash,
# PCASH_SP1_ROOT (default .cache/pcash/sp1 in the repository) at /sp1 and the
# circuit bundle at /bundle. The host's toolchain, Cargo and paths all reach
# the program, so this gives the same programs, and the same keys, on any
# machine.
#
# Requires docker, and PCASH_TOOL_ROOT and PCASH_CIRCUIT_CACHE for resolving
# the circuit bundle. Writes the ELF path to stdout.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
program="${1:-guest}"

if [ -z "${PCASH_GUEST_IMAGE_BUILD:-}" ]; then
  repo="$(dirname "$here")"
  : "${PCASH_TOOL_ROOT:?}" "${PCASH_CIRCUIT_CACHE:?}"
  bundle="$(node "$repo/scripts/circuits/bundle.mjs" --print-path 2>/dev/null | tail -n 1)"
  [ -d "$bundle" ] || { echo "circuit bundle did not resolve" >&2; exit 1; }
  root="${PCASH_SP1_ROOT:-$repo/.cache/pcash/sp1}"
  mkdir -p "$root/cargo"
  # bundle.mjs reads the git directory, which is outside a worktree.
  git_dir="$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)"
  image="$(docker build -q --platform linux/amd64 - <<'EOF'
FROM node:24.15.0-trixie-slim@sha256:291be77873bc04731968cacf82f0fcef17cee8cf200c6b6951e2bcab41560eb7 AS node
FROM rust:1.96.1-trixie@sha256:1f0dbad1df66647807e6952d1db85d0b2bda7606cb2139d82517e4f009967376
COPY --from=node /usr/local/bin/node /usr/local/bin/node
EOF
)"
  docker run --rm --init --platform linux/amd64 --user "$(id -u):$(id -g)" \
    -v "$repo:/pcash" -v "$git_dir:$git_dir:ro" -v "$root:/sp1" -v "$root/cargo:/cargo" -v "$bundle:/bundle:ro" \
    -e PCASH_GUEST_IMAGE_BUILD=1 -e PCASH_SP1_ROOT=/sp1 -e PCASH_CIRCUIT_BUNDLE=/bundle -e PCASH_CIRCUIT_KAT_SET \
    -e CARGO_HOME=/cargo -e HOME=/tmp \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" /pcash/derivation-proof/build-guest.sh "$program" >&2
  echo "$here/target/guest/riscv64im-succinct-zkvm-elf/release/$(sed -n 's/^name = "\(.*\)"/\1/p' "$here/$program/Cargo.toml" | head -n 1)"
  exit
fi

toolchain="$("$here/toolchain.sh")"
eval "$toolchain"
export CHONK_LIB CHONK_CRS SP1_GCC
export RUSTC="$SP1_RUSTC" RUSTC_BOOTSTRAP=1
export CC_riscv64im_succinct_zkvm_elf="$SP1_GCC/bin/riscv64-unknown-elf-gcc"
export CXX_riscv64im_succinct_zkvm_elf="$SP1_GCC/bin/riscv64-unknown-elf-g++"
export AR_riscv64im_succinct_zkvm_elf="$SP1_GCC/bin/riscv64-unknown-elf-ar"
flags=(
  -C passes=lower-atomic
  -C link-arg=--image-base=0x78000000
  -C panic=abort
  --cfg 'getrandom_backend="custom"'
  -C llvm-args=-misched-prera-direction=bottomup
  -C llvm-args=-misched-postra-direction=bottomup
)
CARGO_ENCODED_RUSTFLAGS="$(IFS=$'\x1f'; printf '%s' "${flags[*]}")"
export CARGO_ENCODED_RUSTFLAGS

cd "$here/$program"
CARGO_TARGET_DIR="$here/target/guest" cargo build --locked --release --target riscv64im-succinct-zkvm-elf
