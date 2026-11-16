//! PCASH cryptographic primitives.
//!
//! Implements the normative construction in `docs/protocol-spec.md`:
//! - the Poseidon2 `t=4, R_F=8, R_P=56` permutation, the length-tagged sponge,
//!   and its byte-string form,
//! - the empty-subtree Merkle ladder and LSB-first membership recomputation,
//! - the `pcash.` domain-tag constants.

use ark_ff::{BigInteger, PrimeField};

pub use alloy_primitives::B256;
pub use ark_bn254::Fr;

pub mod domain_tags;
pub mod merkle;
pub mod poseidon2;
mod poseidon2_constants;

pub use poseidon2::{poseidon, poseidon_bytes};

/// Canonical 32-byte big-endian encoding of a BN254 scalar.
pub fn fr_to_bytes(value: Fr) -> B256 {
    let bytes = value.into_bigint().to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    B256::from(out)
}

/// Split a 32-byte big-endian word into two 16-byte BN254 scalar field limbs
/// (high, low). Lossless encoding for raw words: Ethereum block hashes, log
/// topics, and the signed issuance lag.
pub fn bytes32_limbs(bytes: &[u8; 32]) -> (Fr, Fr) {
    (
        Fr::from_be_bytes_mod_order(&bytes[..16]),
        Fr::from_be_bytes_mod_order(&bytes[16..]),
    )
}
