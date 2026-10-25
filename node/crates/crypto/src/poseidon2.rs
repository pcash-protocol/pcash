//! Poseidon2 permutation (BN254, t=4, R_F=8, R_P=56, x^5 s-box) and the
//! length-tagged sponge, per `docs/protocol-spec.md`.

use crate::poseidon2_constants::{DIAGONAL, EXTERNAL, ROUND_CONSTANTS};
use crate::{fr_to_bytes, Fr};
use alloy_primitives::{keccak256, B256};
use ark_ff::{AdditiveGroup, BigInteger, Field, PrimeField, Zero};
use sha2::{Digest as _, Sha256};

const T: usize = 4;
const RATE: usize = 3;
const CAPACITY: usize = T - RATE;
const R_F: usize = 8;
const R_P: usize = 56;
const SBOX_EXPONENT: usize = 5;
const LENGTH_TAG_SHIFT: usize = 64;

fn abi_word(value: usize) -> B256 {
    let mut word = B256::ZERO;
    word[24..].copy_from_slice(&(value as u64).to_be_bytes());
    word
}

/// SHA-256 commitment to the exact Poseidon2 permutation and sponge data.
/// The preimage is a sequence of 32-byte words: the domain and curve tags, field
/// modulus, seven permutation/sponge parameters, explicit dimensions/counts for
/// each constant table, then every BN254 field element as its canonical
/// big-endian field word.
pub fn parameters_digest() -> B256 {
    let mut h = Sha256::new();
    h.update(keccak256(b"pcash.poseidon2.parameters"));
    h.update(keccak256(b"pcash.proof.curve.bn254"));
    let modulus = Fr::MODULUS.to_bytes_be();
    let mut modulus_word = B256::ZERO;
    modulus_word[32 - modulus.len()..].copy_from_slice(&modulus);
    h.update(modulus_word);
    for value in [T, RATE, CAPACITY, R_F, R_P, SBOX_EXPONENT, LENGTH_TAG_SHIFT] {
        h.update(abi_word(value));
    }
    h.update(abi_word(EXTERNAL.len()));
    h.update(abi_word(EXTERNAL[0].len()));
    for row in EXTERNAL {
        for value in row {
            h.update(fr_to_bytes(value));
        }
    }
    h.update(abi_word(DIAGONAL.len()));
    for value in DIAGONAL {
        h.update(fr_to_bytes(value));
    }
    h.update(abi_word(ROUND_CONSTANTS.len()));
    for value in ROUND_CONSTANTS {
        h.update(fr_to_bytes(value));
    }
    B256::from(<[u8; 32]>::from(h.finalize()))
}

#[inline]
fn sbox(x: Fr) -> Fr {
    // x^5
    let x2 = x.square();
    let x4 = x2.square();
    debug_assert_eq!(SBOX_EXPONENT, 5);
    x4 * x
}

/// External linear layer: `M_E · s`.
///
/// Same matrix as `EXTERNAL`; the t=4 Poseidon2 addition chain instead of 16 generic muls.
#[inline]
fn extern_layer(s: &[Fr; T]) -> [Fr; T] {
    // [[5,7,1,3],[4,6,1,1],[1,3,5,7],[1,1,4,6]]
    let t0 = s[0] + s[1];
    let t1 = s[2] + s[3];
    let t2 = s[1].double() + t1;
    let t3 = s[3].double() + t0;
    let t4 = t1.double().double() + t3;
    let t5 = t0.double().double() + t2;
    [t3 + t5, t5, t2 + t4, t4]
}

/// Internal linear layer: `out[i] = sum(s) + D_I[i] * s[i]`.
#[inline]
fn intern_layer(s: &[Fr; T]) -> [Fr; T] {
    let mut total = Fr::zero();
    for v in s.iter() {
        total += *v;
    }
    let mut out = [Fr::zero(); T];
    for i in 0..T {
        out[i] = total + DIAGONAL[i] * s[i];
    }
    out
}

fn permute_with(state: &mut [Fr; T]) {
    let rc = &ROUND_CONSTANTS;

    // 1. Initial external layer.
    *state = extern_layer(state);

    // 2. First-half full rounds: RC[0..15].
    for r in 0..(R_F / 2) {
        for i in 0..T {
            state[i] += rc[r * T + i];
        }
        for element in state.iter_mut() {
            *element = sbox(*element);
        }
        *state = extern_layer(state);
    }

    // 3. Partial rounds: RC[16..71], one constant applied to state[0].
    let partial_base = (R_F / 2) * T; // 16
    for r in 0..R_P {
        state[0] += rc[partial_base + r];
        state[0] = sbox(state[0]);
        *state = intern_layer(state);
    }

    // 4. Second-half full rounds: RC[72..87].
    let second_base = partial_base + R_P; // 72
    for r in 0..(R_F / 2) {
        let base = second_base + r * T;
        for i in 0..T {
            state[i] += rc[base + i];
        }
        for element in state.iter_mut() {
            *element = sbox(*element);
        }
        *state = extern_layer(state);
    }
}

fn sponge_with(inputs: &[Fr]) -> Fr {
    let n = inputs.len();
    // state = [0, 0, 0, N << 64]
    let tag = Fr::from(n as u64) * Fr::from(1u128 << LENGTH_TAG_SHIFT);
    let mut state = [Fr::zero(), Fr::zero(), Fr::zero(), tag];

    if n == 0 {
        permute_with(&mut state);
        return state[0];
    }

    for chunk in inputs.chunks(RATE) {
        for (j, v) in chunk.iter().enumerate() {
            state[j] += *v;
        }
        permute_with(&mut state);
    }
    state[0]
}

/// Length-tagged Poseidon2 sponge: `poseidon(x_1, ..., x_N) -> Fr`.
pub fn poseidon(inputs: &[Fr]) -> Fr {
    sponge_with(inputs)
}

/// Byte-string hash `poseidonBytes(domain, bytes)`: the sponge over the domain,
/// the byte length, and the bytes as 16-byte big-endian chunks, the last chunk
/// short when the length is not a multiple of 16.
pub fn poseidon_bytes(domain: Fr, bytes: &[u8]) -> Fr {
    let mut inputs = Vec::with_capacity(2 + bytes.len().div_ceil(16));
    inputs.push(domain);
    inputs.push(Fr::from(bytes.len() as u64));
    inputs.extend(bytes.chunks(16).map(Fr::from_be_bytes_mod_order));
    sponge_with(&inputs)
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]
mod profile_tests {
    use super::*;
    use alloy_primitives::b256;
    use ark_ff::PrimeField;

    const POSEIDON2_ASSET: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../assets/poseidon2_bn254_t4_rf8_rp56.json"
    ));

    fn fr_hex(s: &str) -> Fr {
        let s = s.strip_prefix("0x").unwrap_or(s);
        let s = if s.len() % 2 == 1 {
            format!("0{s}")
        } else {
            s.to_string()
        };
        Fr::from_be_bytes_mod_order(&hex::decode(s).unwrap())
    }

    #[test]
    fn poseidon_profile_matches_conformance_digest() {
        assert_eq!(
            parameters_digest(),
            b256!("0x9d32f7cc779e8ebf3b11370f3cbe6d363774dc3c6b66fd729850855f8aaa7d5b")
        );
    }

    #[test]
    fn compiled_constants_match_source_asset() {
        let asset: serde_json::Value = serde_json::from_str(POSEIDON2_ASSET).unwrap();
        assert_eq!(asset["curve"], "bn254");
        assert_eq!(asset["rate"].as_u64().unwrap() as usize, RATE);
        assert_eq!(asset["capacity"].as_u64().unwrap() as usize, CAPACITY);
        assert_eq!(asset["fullRounds"].as_u64().unwrap() as usize, R_F);
        assert_eq!(asset["partialRounds"].as_u64().unwrap() as usize, R_P);

        let external = asset["externalMatrix"].as_array().unwrap();
        assert_eq!(external.len(), T);
        for (i, row) in external.iter().enumerate() {
            let row = row.as_array().unwrap();
            assert_eq!(row.len(), T);
            for (j, value) in row.iter().enumerate() {
                assert_eq!(EXTERNAL[i][j], fr_hex(value.as_str().unwrap()));
            }
        }

        let diagonal = asset["internalDiagonal"].as_array().unwrap();
        assert_eq!(diagonal.len(), T);
        for (i, value) in diagonal.iter().enumerate() {
            assert_eq!(DIAGONAL[i], fr_hex(value.as_str().unwrap()));
        }

        let round_constants = asset["roundConstants"].as_array().unwrap();
        assert_eq!(round_constants.len(), ROUND_CONSTANTS.len());
        for (i, value) in round_constants.iter().enumerate() {
            assert_eq!(ROUND_CONSTANTS[i], fr_hex(value.as_str().unwrap()));
        }
    }

    #[test]
    fn length_tag_is_not_last_chunk_padding() {
        let a = Fr::from(1u64);
        let b = Fr::from(2u64);
        assert_ne!(poseidon(&[a, b]), poseidon(&[a, b, Fr::zero()]));
    }

    fn dense_extern(s: &[Fr; T]) -> [Fr; T] {
        let mut out = [Fr::zero(); T];
        for i in 0..T {
            let mut acc = Fr::zero();
            for j in 0..T {
                acc += EXTERNAL[i][j] * s[j];
            }
            out[i] = acc;
        }
        out
    }

    #[test]
    fn extern_layer_matches_external_matrix() {
        for j in 0..T {
            let mut unit = [Fr::zero(); T];
            unit[j] = Fr::from(1u64);
            let out = extern_layer(&unit);
            assert_eq!(out, dense_extern(&unit));
            for i in 0..T {
                assert_eq!(out[i], EXTERNAL[i][j]);
            }
        }
        let mixed = [
            Fr::from(2u64),
            Fr::from(3u64),
            Fr::from(5u64),
            Fr::from(7u64),
        ];
        assert_eq!(extern_layer(&mixed), dense_extern(&mixed));
    }
}
