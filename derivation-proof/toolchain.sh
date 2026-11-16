#!/usr/bin/env bash
# Set up what the SP1 programs build with, under PCASH_SP1_ROOT, and print the
# variables build-guest.sh reads, as shell assignments:
#
# - SP1's Rust toolchain and rv64im GCC, at pinned releases;
# - bb's source at the commit of the bb version the node pins in
#   assets/prover-toolchain.json, and the libraries bb's CMake pins;
# - bb's Chonk verifier built for the guest (bb/), and its reference strings.
#
# build-guest.sh runs it in its build image. Each step is skipped once done.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
root="${PCASH_SP1_ROOT:?}"

# SP1's builds of its toolchain for each host differ, the standard library
# included, so the programs build with the Linux x86-64 one everywhere.
rust_tag=succinct-1.96.0-64bit-v3
rust_asset=rust-toolchain-x86_64-unknown-linux-gnu.tar.gz
rust_sha256=23905647c8ba007bed72e9207ceada06d08023f4dca73c87a122acbe7468ce07
gcc_tag=2026.02.13
gcc_asset=riscv64im-linux-amd64.tar.gz
gcc_sha256=7294ee279f52a75b0ad669fff60277d52e520b2b5fd7065c8264ac1ad93c1334

# The aztec-packages commit of each bb release the node may pin.
bb_version="$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["barretenberg"]["version"])' \
  "$repo/assets/prover-toolchain.json")"
case "$bb_version" in
  6.0.0) bb_commit=0219f11d8133970df3974fe5ae65e006bf8c193a ;;
  *) echo "no bb source commit for bb $bb_version: add it to $0" >&2; exit 1 ;;
esac

sha256() {
  sha256sum "$1" | cut -d' ' -f1
}

# Download a release archive, check it, and unpack it into $1.
unpack() {
  local dir="$1" url="$2" expected="$3"
  [ -f "$dir/.done" ] && return
  rm -rf "$dir" && mkdir -p "$dir"
  echo "downloading $url" >&2
  curl -fsSL --retry 3 -o "$dir.tar.gz" "$url"
  if [ "$(sha256 "$dir.tar.gz")" != "$expected" ]; then
    echo "$url: unexpected SHA-256" >&2
    exit 1
  fi
  tar -xzf "$dir.tar.gz" -C "$dir"
  rm "$dir.tar.gz"
  touch "$dir/.done"
}

# Check out one revision of a repository into $1, with only the given paths.
checkout() {
  local dir="$1" url="$2" revision="$3"
  shift 3
  [ -f "$dir/.done" ] && return
  rm -rf "$dir" && mkdir -p "$dir"
  echo "fetching $url at $revision" >&2
  git -C "$dir" init -q
  git -C "$dir" remote add origin "$url"
  if [ $# -gt 0 ]; then
    git -C "$dir" config core.sparseCheckout true
    printf '%s\n' "$@" > "$dir/.git/info/sparse-checkout"
  fi
  git -C "$dir" fetch -q --depth 1 --filter=blob:none origin "$revision"
  git -C "$dir" checkout -q FETCH_HEAD
  touch "$dir/.done"
}

rust="$root/rust-$rust_tag-${rust_asset%.tar.gz}"
gcc_dir="$root/gcc-$gcc_tag-${gcc_asset%.tar.gz}"
unpack "$rust" "https://github.com/succinctlabs/rust/releases/download/$rust_tag/$rust_asset" "$rust_sha256"
unpack "$gcc_dir" "https://github.com/succinctlabs/riscv-gnu-toolchain/releases/download/$gcc_tag/$gcc_asset" "$gcc_sha256"
gcc="$(find "$gcc_dir/" -name riscv64-unknown-elf-gcc -type f | head -n 1)"
[ -n "$gcc" ] || { echo "no riscv64-unknown-elf-gcc in $gcc_dir" >&2; exit 1; }
gcc_bin="$(dirname "$gcc")"

# The library's directory is named by everything that goes into it.
recipe="$(cd "$here/bb" && find . -type f | LC_ALL=C sort | xargs cat | { cat; echo "$bb_commit $gcc_tag"; } | sha256 /dev/stdin)"
chonk="$root/chonk-${recipe:0:16}"
if [ ! -f "$chonk/libchonk.a" ]; then
  bb_dir="$root/bb-$bb_commit"
  checkout "$bb_dir/aztec-packages" https://github.com/AztecProtocol/aztec-packages.git "$bb_commit" \
    /barretenberg/cpp/src/ /barretenberg/cpp/cmake/
  bb_src="$bb_dir/aztec-packages/barretenberg/cpp/src"
  cmake="$bb_dir/aztec-packages/barretenberg/cpp/cmake"
  pin() { sed -n "$2" "$cmake/$1" | head -n 1; }
  checkout "$bb_dir/deps/msgpack-c" https://github.com/AztecProtocol/msgpack-c.git \
    "$(pin msgpack.cmake 's/.*git fetch --depth 1 origin --quiet \([0-9a-f]\{40\}\).*/\1/p')"
  checkout "$bb_dir/deps/nlohmann_json" https://github.com/nlohmann/json.git \
    "$(pin nlohmann_json.cmake 's/.*NLOHMANN_JSON_COMMIT_HASH "\([0-9a-f]\{40\}\)".*/\1/p')"
  checkout "$bb_dir/deps/tracy" https://github.com/wolfpld/tracy.git \
    "$(pin tracy.cmake 's/.*TRACY_COMMIT_HASH "\([0-9a-f]\{40\}\)".*/\1/p')"
  checkout "$bb_dir/deps/libdeflate" https://github.com/ebiggers/libdeflate.git \
    "$(pin libdeflate.cmake 's/^ *GIT_TAG *\([^ ]*\).*/\1/p')"
  checkout "$bb_dir/deps/httplib" https://github.com/yhirose/cpp-httplib.git \
    "$(pin httplib.cmake 's/^ *GIT_TAG *\([^ ]*\).*/\1/p')"
  mkdir -p "$chonk/gen"
  python3 -I "$here/bb/prepare.py" verifier "$bb_src" "$chonk/gen/chonk_verifier_native.cpp"
  read -r crs_url crs_range < <(python3 -I "$here/bb/prepare.py" grumpkin-chunk "$bb_src")
  curl -fsSL --retry 3 -r "$crs_range" -o "$chonk/grumpkin-chunk.dat" "$crs_url"
  python3 -I "$here/bb/prepare.py" crs "$bb_src" "$chonk/grumpkin-chunk.dat" "$chonk/crs"
  rm "$chonk/grumpkin-chunk.dat"
  # bb's largest sources take up to 2 GB each to compile.
  jobs="$(getconf _NPROCESSORS_ONLN)"
  memory_jobs=$(( $(sed -n 's/^MemAvailable: *\([0-9]*\) kB/\1/p' /proc/meminfo) / 2000000 ))
  jobs=$(( memory_jobs < jobs ? memory_jobs : jobs ))
  jobs=$(( jobs > 0 ? jobs : 1 ))
  echo "building bb's verifier for the guest ($jobs jobs)" >&2
  make -s -C "$here/bb" -j "$jobs" BB="$bb_src" DEPS="$bb_dir/deps" GEN="$chonk/gen" OUT="$chonk/obj" \
    CXX="$gcc_bin/riscv64-unknown-elf-g++" CC="$gcc_bin/riscv64-unknown-elf-gcc" AR="$gcc_bin/riscv64-unknown-elf-ar" >&2
  mv "$chonk/obj/libchonk.a" "$chonk/libchonk.a"
  rm -rf "$chonk/obj"
fi

cat <<EOF
SP1_RUSTC='$rust/bin/rustc'
SP1_GCC='$(dirname "$gcc_bin")'
CHONK_LIB='$chonk'
CHONK_CRS='$chonk/crs'
EOF
