//! Canonical byte encodings between PCASH wire types and the BN254 scalar field.
//!
//! Field elements use a 32-byte big-endian representation; addresses are widened
//! to `uint160`. Monetary widths are set by spec §2.1; this module enforces none.

use alloy_primitives::{Address, B256, U256};
use ark_ff::PrimeField;
use pcash_crypto::Fr;

pub use pcash_crypto::fr_to_bytes;

/// The field element a canonical 32-byte big-endian word encodes, or `None`
/// when the word is `>= p`. This is the only conversion of a word that arrives
/// from outside the node into a field element.
pub fn fr_from_canonical_bytes(word: B256) -> Option<Fr> {
    let value = Fr::from_be_bytes_mod_order(word.as_slice());
    (fr_to_bytes(value) == word).then_some(value)
}

/// The field element of a word this node already holds in canonical form: one
/// it encoded with [`fr_to_bytes`], or an external word that
/// [`fr_from_canonical_bytes`] accepted before it was stored. It is not a check
/// and never takes an external word.
pub fn fr_from_internal_word(word: B256) -> Fr {
    Fr::from_be_bytes_mod_order(word.as_slice())
}

/// Widen a 20-byte Ethereum address to a field element (`uint160`).
pub fn addr_to_fr(a: Address) -> Fr {
    Fr::from_be_bytes_mod_order(a.as_slice())
}

/// Encode a 256-bit unsigned integer as a field element (reduced mod p).
pub fn u256_to_fr(u: U256) -> Fr {
    Fr::from_be_bytes_mod_order(&u.to_be_bytes::<32>())
}

/// Interpret a 32-byte big-endian word as a 256-bit integer.
pub fn word_to_u256(word: B256) -> U256 {
    U256::from_be_bytes(word.0)
}

/// Undo one recorded map write: `Some` restores the prior value, `None` means
/// the key did not exist before and is removed.
pub(crate) fn restore_entry<K, V, S>(
    map: &mut std::collections::HashMap<K, V, S>,
    key: K,
    value: Option<V>,
) where
    K: std::hash::Hash + Eq,
    S: std::hash::BuildHasher,
{
    match value {
        Some(value) => {
            map.insert(key, value);
        }
        None => {
            map.remove(&key);
        }
    }
}

/// The low 20 bytes of a circuit word, as an [`Address`]. The protocol encodes
/// an address as a left-padded 32-byte word.
pub fn address_from_word(word: B256) -> Address {
    Address::from_word(word)
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::unreadable_literal,
    reason = "tests use direct assertions"
)]
mod tests {
    use super::*;
    use ark_ff::{One, Zero};
    use std::collections::HashMap;

    #[test]
    fn canonical_fr_parsing() {
        // Zero is canonical
        let zero_word = B256::ZERO;
        let zero_fr = fr_from_canonical_bytes(zero_word);
        assert_eq!(zero_fr, Some(Fr::zero()));
        assert_eq!(fr_to_bytes(zero_fr.unwrap()), zero_word);

        // One is canonical
        let mut one_bytes = [0u8; 32];
        one_bytes[31] = 1;
        let one_word = B256::from(one_bytes);
        let one_fr = fr_from_canonical_bytes(one_word);
        assert_eq!(one_fr, Some(Fr::one()));
        assert_eq!(fr_to_bytes(one_fr.unwrap()), one_word);

        // BN254 scalar field modulus r from ark_bn254::Fr:
        use ark_ff::BigInteger;
        let mut modulus = [0u8; 32];
        let be_bytes = <Fr as PrimeField>::MODULUS.to_bytes_be();
        modulus[32 - be_bytes.len()..].copy_from_slice(&be_bytes);
        let modulus_word = B256::from(modulus);
        assert_eq!(fr_from_canonical_bytes(modulus_word), None);

        // Modulus - 1 is the maximum valid canonical scalar
        let mut r_minus_one = modulus_word;
        r_minus_one[31] -= 1;
        assert!(fr_from_canonical_bytes(r_minus_one).is_some());

        // Modulus + 1 is non-canonical
        let mut r_plus_one = modulus_word;
        r_plus_one[31] += 1;
        assert_eq!(fr_from_canonical_bytes(r_plus_one), None);

        // 0xFF...FF is non-canonical
        let max_u256 = B256::repeat_byte(0xff);
        assert_eq!(fr_from_canonical_bytes(max_u256), None);
    }

    #[test]
    fn address_and_word_conversions() {
        let addr = Address::repeat_byte(0x42);
        let field = addr_to_fr(addr);
        let word = fr_to_bytes(field);
        let recovered = address_from_word(word);
        assert_eq!(recovered, addr);
    }

    #[test]
    fn u256_word_conversions() {
        let num = U256::from(1_234_567_890_u64);
        let field = u256_to_fr(num);
        let word = fr_to_bytes(field);
        let recovered = word_to_u256(word);
        assert_eq!(recovered, num);
    }

    #[test]
    fn restore_entry_helper() {
        let mut map: HashMap<&str, i32> = HashMap::new();
        map.insert("key1", 100);

        // Restoring Some overrides the value
        restore_entry(&mut map, "key1", Some(42));
        assert_eq!(map.get("key1"), Some(&42));

        // Restoring None deletes the value
        restore_entry(&mut map, "key1", None);
        assert_eq!(map.get("key1"), None);
    }
}
