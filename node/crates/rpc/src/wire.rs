//! Serde glue for the `pcash_*` wire encoding.
//!
//! Protocol byte strings are fixed-width lowercase `0x` hex and quantities are
//! minimal JSON-RPC hex (`"0x0"` for zero). `alloy-primitives` and
//! `alloy_serde::quantity` already encode exactly that — `FixedBytes<N>` writes
//! a fixed-width lowercase `0x` string and `ruint` writes `{:#x}` — so this
//! module only fills the gaps they leave:
//!
//! * serde implements arrays up to 32 elements, and the Merkle openings here are
//!   depth-40;
//! * `alloy_serde::quantity` covers the fixed-width integers but not `usize`;
//! * `pcash_state`'s boundary types are foreign, so they are described through
//!   serde's `remote` derive rather than by adding serde to that crate.

use alloy_primitives::B256;
use serde::de::{SeqAccess, Visitor};
use serde::{Deserializer, Serializer};

/// A `[B256; N]` for any `N`, encoded as a JSON array of fixed-width hex strings.
pub mod hash_array {
    use super::{fmt, Deserializer, SeqAccess, Serializer, Visitor, B256};
    use serde::de::Error as _;
    use serde::ser::SerializeSeq as _;
    pub fn serialize<S: Serializer, const N: usize>(
        value: &[B256; N],
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(Some(N))?;
        for hash in value {
            seq.serialize_element(hash)?;
        }
        seq.end()
    }

    pub fn deserialize<'de, D: Deserializer<'de>, const N: usize>(
        deserializer: D,
    ) -> Result<[B256; N], D::Error> {
        struct ArrayVisitor<const N: usize>;

        impl<'de, const N: usize> Visitor<'de> for ArrayVisitor<N> {
            type Value = [B256; N];

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "exactly {N} 32-byte hex strings")
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut out = [B256::ZERO; N];
                for (index, slot) in out.iter_mut().enumerate() {
                    *slot = seq
                        .next_element()?
                        .ok_or_else(|| A::Error::invalid_length(index, &self))?;
                }
                if seq.next_element::<B256>()?.is_some() {
                    return Err(A::Error::invalid_length(N + 1, &self));
                }
                Ok(out)
            }
        }

        deserializer.deserialize_seq(ArrayVisitor::<N>)
    }
}

/// A `usize` as a minimal JSON-RPC hex quantity, via `u64`.
///
/// `alloy_serde::quantity` covers the fixed-width integers; the catalog's limit
/// policy is expressed in `usize` because it bounds in-memory collections.
pub mod quantity_usize {
    use super::{Deserializer, Serializer};
    use serde::de::Error as _;

    pub fn serialize<S: Serializer>(value: &usize, serializer: S) -> Result<S::Ok, S::Error> {
        alloy_serde::quantity::serialize(&(*value as u64), serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<usize, D::Error> {
        let value: u64 = alloy_serde::quantity::deserialize(deserializer)?;
        usize::try_from(value).map_err(D::Error::custom)
    }
}

use core::fmt;

/// `pcash_state::IssuanceState` on the wire, flattened into [`StateComponentsDef`].
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(remote = "pcash_state::IssuanceState", rename_all = "camelCase")]
pub struct IssuanceStateDef {
    pub issued_so_far: alloy_primitives::U256,
    pub lag_q: alloy_primitives::I256,
}

/// `pcash_state::StateComponents` on the wire. Foreign type, so it is described
/// here rather than by giving `pcash-state` a serde dependency.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(remote = "pcash_state::StateComponents", rename_all = "camelCase")]
pub struct StateComponentsDef {
    pub output_root: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub output_count: u64,
    #[serde(flatten, with = "IssuanceStateDef")]
    pub issuance: pcash_state::IssuanceState,
    pub account_state_root: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub account_count: u64,
    pub nullifier_root: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub nullifier_count: u64,
}

/// `pcash_state::BlockHeader` on the wire.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(remote = "pcash_state::BlockHeader", rename_all = "camelCase")]
pub struct BlockHeaderDef {
    pub parent_hash: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub number: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub timestamp: u64,
    pub transaction_results_root: B256,
    pub state_root: B256,
    pub l1_origin_root: B256,
    pub history_root: B256,
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions"
)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Serialize, Deserialize, PartialEq, Eq, Debug)]
    struct TestHashes {
        #[serde(with = "hash_array")]
        hashes: [B256; 3],
    }

    #[derive(Serialize, Deserialize, PartialEq, Eq, Debug)]
    struct TestSize {
        #[serde(with = "quantity_usize")]
        size: usize,
    }

    #[derive(Serialize, Deserialize, PartialEq, Eq, Debug)]
    struct WrapperComponents(#[serde(with = "StateComponentsDef")] pcash_state::StateComponents);

    #[derive(Serialize, Deserialize, PartialEq, Eq, Debug)]
    struct WrapperHeader(#[serde(with = "BlockHeaderDef")] pcash_state::BlockHeader);

    #[test]
    fn hash_array_round_trip() {
        let original = TestHashes {
            hashes: [
                B256::repeat_byte(0x11),
                B256::repeat_byte(0x22),
                B256::repeat_byte(0x33),
            ],
        };
        let json = serde_json::to_string(&original).expect("serialize TestHashes");
        let decoded: TestHashes = serde_json::from_str(&json).expect("deserialize TestHashes");
        assert_eq!(decoded, original);
    }

    #[test]
    fn hash_array_rejects_wrong_length() {
        // Too few elements (2 instead of 3)
        let json_too_short = r#"{"hashes":["0x1111111111111111111111111111111111111111111111111111111111111111","0x2222222222222222222222222222222222222222222222222222222222222222"]}"#;
        assert!(serde_json::from_str::<TestHashes>(json_too_short).is_err());

        // Too many elements (4 instead of 3)
        let json_too_long = r#"{"hashes":["0x1111111111111111111111111111111111111111111111111111111111111111","0x2222222222222222222222222222222222222222222222222222222222222222","0x3333333333333333333333333333333333333333333333333333333333333333","0x4444444444444444444444444444444444444444444444444444444444444444"]}"#;
        assert!(serde_json::from_str::<TestHashes>(json_too_long).is_err());
    }

    #[test]
    fn quantity_usize_round_trip() {
        let val = TestSize { size: 0 };
        let json = serde_json::to_string(&val).expect("serialize zero");
        assert_eq!(json, r#"{"size":"0x0"}"#);
        let back: TestSize = serde_json::from_str(&json).expect("deserialize zero");
        assert_eq!(back.size, 0);

        let val_large = TestSize { size: 4096 };
        let json_large = serde_json::to_string(&val_large).expect("serialize 4096");
        assert_eq!(json_large, r#"{"size":"0x1000"}"#);
        let back_large: TestSize = serde_json::from_str(&json_large).expect("deserialize 4096");
        assert_eq!(back_large.size, 4096);
    }

    #[test]
    fn state_components_remote_round_trip() {
        let components = pcash_state::StateComponents {
            output_root: B256::repeat_byte(0x01),
            output_count: 10,
            issuance: pcash_state::IssuanceState {
                issued_so_far: alloy_primitives::U256::from(20),
                lag_q: alloy_primitives::I256::try_from(-5i64).unwrap() << 128,
            },
            account_state_root: B256::repeat_byte(0x03),
            account_count: 30,
            nullifier_root: B256::repeat_byte(0x04),
            nullifier_count: 40,
        };
        let wrapper = WrapperComponents(components);
        let json = serde_json::to_string(&wrapper).expect("serialize components");
        assert!(json.contains(r#""outputCount":"0xa""#));
        assert!(json.contains(r#""issuedSoFar":"0x14","lagQ":"#));
        let decoded: WrapperComponents =
            serde_json::from_str(&json).expect("deserialize components");
        assert_eq!(decoded.0, wrapper.0);
    }

    #[test]
    fn block_header_remote_round_trip() {
        let header = pcash_state::BlockHeader {
            parent_hash: B256::repeat_byte(0x10),
            number: 100,
            timestamp: 1_700_000_000,
            transaction_results_root: B256::repeat_byte(0x20),
            state_root: B256::repeat_byte(0x30),
            l1_origin_root: B256::repeat_byte(0x40),
            history_root: B256::repeat_byte(0x50),
        };
        let wrapper = WrapperHeader(header);
        let json = serde_json::to_string(&wrapper).expect("serialize header");
        assert!(json.contains(r#""number":"0x64""#));
        let decoded: WrapperHeader = serde_json::from_str(&json).expect("deserialize header");
        assert_eq!(decoded.0, wrapper.0);
    }
}
