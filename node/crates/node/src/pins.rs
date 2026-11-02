//! Proof-system release pins (spec §16) that the node checks at startup.
//!
//! A proof is valid exactly when the pinned Barretenberg release accepts it
//! (§8.1), so that verifier's accept/reject behavior, bugs included, is
//! consensus. Another implementation need not run this binary, but it must
//! reproduce that behavior exactly. The node refuses to start unless its bb
//! is byte for byte the binary of this release and its Grumpkin CRS prefix
//! matches the pinned digest, and a verifier worker decides nothing until it
//! passes the hiding-kernel known answers in `pcash-verify`.
//!
//! The pins are compiled in from `assets/prover-toolchain.json`, the manifest
//! the toolchain installer authenticates bb and the CRS against, so this binary
//! and the tools it runs cannot name different releases.
//!
//! `PROVENANCE.md` accounts how the pinned artifacts were produced.
//!
//! A change to the Barretenberg version in that manifest merges only after
//! every check below passes:
//! - Diff bb's source against the previous release, and re-read the reports
//!   `refusal.rs` in `pcash-verify` recognizes against the new wording, the
//!   order of the checks after its progress line, and what bb logs only on a
//!   fresh worker, such as the lazy Grumpkin CRS load.
//! - Each archive's `binarySha256` in the manifest is the SHA-256 of the `bb`
//!   inside it, on all four platforms. `just tools` checks only the host's.
//! - `just tools`, then `just ci-all`. Its bundle build runs `check_release`:
//!   ACIR, VK digests, `megaVkHash` and proof lengths may change only where
//!   bb's prover or flavor source did. It also runs the native
//!   `sdk/test/recursiveComposition.proving.test.ts` regressions and the
//!   circuit-kind refusals in `sdk/test/circuitKindRefusals.proving.test.ts`,
//!   which `PCASH_REQUIRE_PROVER=1` keeps from being skipped, and the bb.js CRS
//!   key and size check in `sdk/test/browser/crsIntegrity.test.ts`.
//! - `PCASH_TOOL_ROOT="$PWD/.pcash-tools" cargo test -p pcash-verify -- --ignored`.
//!   CI runs only two of these live verifier tests; the others exercise the
//!   refusal reports against the binary. Among them, the malformed-proof fuzz
//!   (`fuzz.rs`) requires bb to reject every mutated known answer within ten
//!   times the known answer's own verification time. Each crash, hang or
//!   unrecognized refusal it finds needs a node-side pre-check or an upstream
//!   fix before the re-pin merges.
//! - The CRS pins in the manifest are still the bytes the new bb reads.

use std::collections::BTreeMap;

use alloy_primitives::B256;
use serde::{de::Error as _, Deserialize};

const MANIFEST: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../assets/prover-toolchain.json"
));

/// The release this binary is qualified against.
pub struct ReleasePins {
    /// SHA-256 of the pinned Barretenberg release's `bb` for this platform.
    pub bb_sha256: B256,
    /// Length of the pinned Grumpkin G1 prefix: the first 65,536 points of the
    /// transparent v2 SRS in `grumpkin_g1_v2.flat.dat`. The CHONK verifier uses
    /// 2^15 points, and the pinned bb loads them as part of this prefix.
    pub grumpkin_g1_prefix_bytes: usize,
    /// SHA-256 of that Grumpkin G1 prefix.
    pub grumpkin_g1_prefix_sha256: B256,
}

#[derive(Deserialize)]
struct Manifest {
    barretenberg: Barretenberg,
    crs: Crs,
}

#[derive(Deserialize)]
struct Barretenberg {
    archives: BTreeMap<String, Archive>,
}

#[derive(Deserialize)]
struct Archive {
    #[serde(rename = "binarySha256")]
    binary_sha256: B256,
}

#[derive(Deserialize)]
struct Crs {
    #[serde(rename = "grumpkinG1")]
    grumpkin_g1: Prefix,
}

#[derive(Deserialize)]
struct Prefix {
    bytes: usize,
    sha256: B256,
}

/// This platform as the manifest keys its archives: Node's `platform()-arch()`.
fn platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        os => os,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        arch => arch,
    };
    format!("{os}-{arch}")
}

/// Read the pins from the compiled-in toolchain manifest.
pub fn release_pins() -> serde_json::Result<ReleasePins> {
    let manifest: Manifest = serde_json::from_str(MANIFEST)?;
    let platform = platform();
    let bb = manifest
        .barretenberg
        .archives
        .get(&platform)
        .ok_or_else(|| {
            serde_json::Error::custom(format!("no Barretenberg release is pinned for {platform}"))
        })?;
    Ok(ReleasePins {
        bb_sha256: bb.binary_sha256,
        grumpkin_g1_prefix_bytes: manifest.crs.grumpkin_g1.bytes,
        grumpkin_g1_prefix_sha256: manifest.crs.grumpkin_g1.sha256,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_compiled_in_manifest_carries_every_pin() {
        assert!(release_pins().is_ok());
    }
}
