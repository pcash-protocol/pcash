//! Batch framing codec, shared by every carrier.
//!
//! ```text
//! VERSION (1, =0x01) ‖ posterOwnerCommitment (32) ‖ posterContext (32) ‖ count (u16) ‖ count × [len (u32) ‖ txBytes]
//! ```
//!
//! The carrier bounds the candidate batch to `pcash_da::MAX_BATCH_BYTES` before
//! framing. `count <= MAX_BATCH_ENTRIES`, and the bytes MUST end exactly after
//! the final item. An unsupported version or batch-level rule failure means the
//! whole batch is ignored — [`Batch::decode`] returns an error.
//! A well-formed batch returns the ordered list of `txBytes` items, admitted and
//! executed later in order. One item's exclusion or rejection discards no
//! sibling, but each successful item changes the state later items see. There
//! is no batch atomicity.

use crate::params::{BatchVersion, ProtocolRules, MAX_BATCH_ENTRIES};
use alloy_primitives::B256;
use pcash_state::codec::{Reader, Writer};
use pcash_state::{fr_from_canonical_bytes, fr_to_bytes, BatchExclusionReason, Fr};

/// A structurally valid batch and the encoding selected by its first byte.
/// Structural framing alone does not establish timestamp-dependent acceptance;
/// consensus callers should use [`Batch::decode_accepted`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Batch<'a> {
    pub version: BatchVersion,
    pub poster_owner_commitment: Fr,
    pub poster_context: B256,
    pub items: Vec<&'a [u8]>,
}

impl<'a> Batch<'a> {
    /// Bytes before the first item: version, poster commitment, poster
    /// context, and count.
    pub const HEADER_LEN: usize = 1 + 32 + 32 + 2;
    /// Bytes of the length prefix in front of each item.
    pub const ITEM_PREFIX_LEN: usize = 4;

    /// Decode framing and return the first batch-level exclusion reason.
    pub fn decode(bytes: &'a [u8]) -> Result<Self, BatchExclusionReason> {
        let truncated = |_| BatchExclusionReason::TruncatedFraming;
        let mut r = Reader::new(bytes);

        let version = BatchVersion::from_wire_byte(r.take_u8().map_err(truncated)?)
            .ok_or(BatchExclusionReason::UnsupportedBatchVersion)?;
        let poster_owner_commitment =
            poster_owner_commitment(B256::from(r.take_array::<32>().map_err(truncated)?))?;
        let poster_context = B256::from(r.take_array::<32>().map_err(truncated)?);
        require_poster_context(poster_context)?;
        let count = r.take_u16().map_err(truncated)? as usize;
        if count > MAX_BATCH_ENTRIES {
            return Err(BatchExclusionReason::BatchCountLimit);
        }

        let mut items = Vec::with_capacity(count);
        for _ in 0..count {
            let len = r.take_u32().map_err(truncated)? as usize;
            // An intact oversized item still has a trustworthy boundary. Admission
            // excludes that item without discarding its siblings.
            items.push(r.take(len).map_err(truncated)?);
        }
        r.finish()
            .map_err(|_| BatchExclusionReason::TrailingBatchBytes)?;

        Ok(Self {
            version,
            poster_owner_commitment,
            poster_context,
            items,
        })
    }

    /// Decode a batch when this binary accepts its encoding for a block with L1
    /// header timestamp `ts`.
    ///
    /// A batch version selects framing and never transaction semantics, but it is
    /// still timestamped. Framing decides which items a block contains at all, so
    /// a version that no node could read at `ts` must stay unreadable when that
    /// block is replayed later — otherwise adding an encoding would pull
    /// transactions out of historical calldata that was skipped when it was posted.
    pub fn decode_accepted(
        bytes: &'a [u8],
        rules: &ProtocolRules,
        ts: u64,
    ) -> Result<Self, BatchExclusionReason> {
        // Version acceptance precedes later framing checks in the public exclusion
        // contract, so inspect the first byte before decoding the remaining fields.
        let version_byte = *bytes
            .first()
            .ok_or(BatchExclusionReason::TruncatedFraming)?;
        let version = BatchVersion::from_wire_byte(version_byte)
            .ok_or(BatchExclusionReason::UnsupportedBatchVersion)?;
        if !rules.accepted_batch_versions_at(ts).contains(&version) {
            return Err(BatchExclusionReason::UnsupportedBatchVersion);
        }
        Self::decode(bytes)
    }

    /// Encode this batch: the exact inverse of [`Batch::decode`] on every batch
    /// it returns. A batch decoding could never return is the reason decoding
    /// would give its bytes rather than bytes that decode to something else. A
    /// batch above `pcash_da::MAX_BATCH_BYTES` is the invalid carrier encoding
    /// the Inbox gives it, since no carrier holds one.
    pub fn encode(&self) -> Result<Vec<u8>, BatchExclusionReason> {
        require_poster_context(self.poster_context)?;
        if self.items.len() > MAX_BATCH_ENTRIES {
            return Err(BatchExclusionReason::BatchCountLimit);
        }
        let len = Self::HEADER_LEN
            + self
                .items
                .iter()
                .map(|item| Self::ITEM_PREFIX_LEN + item.len())
                .sum::<usize>();
        if len > pcash_da::MAX_BATCH_BYTES {
            return Err(BatchExclusionReason::InvalidCarrierEncoding);
        }

        let mut w = Writer::default();
        w.u8(self.version.wire_byte());
        w.bytes(fr_to_bytes(self.poster_owner_commitment).as_slice());
        w.bytes(self.poster_context.as_slice());
        // The count was checked against `MAX_BATCH_ENTRIES` and every length
        // against `MAX_BATCH_BYTES` above, so both fit their fields.
        w.u16(self.items.len() as u16);
        for item in &self.items {
            w.u32(item.len() as u32);
            w.bytes(item);
        }
        Ok(w.into_bytes())
    }
}

/// The poster owner commitment a batch word encodes, which must be a canonical
/// field element.
fn poster_owner_commitment(word: B256) -> Result<Fr, BatchExclusionReason> {
    fr_from_canonical_bytes(word).ok_or(BatchExclusionReason::InvalidPosterOwnerCommitment)
}

fn require_poster_context(context: B256) -> Result<(), BatchExclusionReason> {
    fr_from_canonical_bytes(context)
        .map(|_| ())
        .ok_or(BatchExclusionReason::InvalidPosterContext)
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

    /// An empty batch whose count field claims `count` items.
    fn header(count: u16) -> Vec<u8> {
        let mut out = Batch {
            version: BatchVersion::V1,
            poster_owner_commitment: Fr::from(7u64),
            poster_context: B256::ZERO,
            items: vec![],
        }
        .encode()
        .unwrap();
        out[65..].copy_from_slice(&count.to_be_bytes());
        out
    }

    #[test]
    fn canonical_poster_is_required_even_without_items() {
        let valid = header(0);
        assert!(Batch::decode(&valid).is_ok());
        for length in 0..67 {
            assert!(Batch::decode(&valid[..length]).is_err());
        }
        let mut zero = valid.clone();
        zero[1..33].fill(0);
        assert_eq!(
            Batch::decode(&zero).unwrap().poster_owner_commitment,
            Fr::from(0u64)
        );
        let mut outside = valid;
        outside[1..33].fill(0xff);
        assert!(Batch::decode(&outside).is_err());
        let mut bad_context = header(0);
        bad_context[33..65].fill(0xff);
        assert!(Batch::decode(&bad_context).is_err());
    }

    #[test]
    fn count_length_payload_and_trailing_bounds() {
        assert!(Batch::decode(&header((MAX_BATCH_ENTRIES + 1) as u16)).is_err());
        let mut bytes = header(1);
        bytes.extend_from_slice(&3u32.to_be_bytes());
        bytes.extend_from_slice(&[0xaa, 0xbb, 0xcc]);
        let parsed = Batch::decode(&bytes).unwrap();
        assert_eq!(parsed.items, vec![&[0xaa, 0xbb, 0xcc][..]]);
        for length in 67..bytes.len() {
            assert!(Batch::decode(&bytes[..length]).is_err());
        }
        bytes.push(0);
        assert!(Batch::decode(&bytes).is_err());
    }

    #[test]
    fn encode_refuses_a_batch_no_carrier_holds() {
        let fits =
            vec![0xaa; pcash_da::MAX_BATCH_BYTES - Batch::HEADER_LEN - Batch::ITEM_PREFIX_LEN];
        fn batch(item: &[u8]) -> Batch<'_> {
            Batch {
                version: BatchVersion::V1,
                poster_owner_commitment: Fr::from(7u64),
                poster_context: B256::ZERO,
                items: vec![item],
            }
        }
        let bytes = batch(&fits).encode().unwrap();
        assert_eq!(bytes.len(), pcash_da::MAX_BATCH_BYTES);
        assert_eq!(Batch::decode(&bytes).unwrap().items, vec![fits.as_slice()]);
        let over = [fits.as_slice(), &[0xaa]].concat();
        assert_eq!(
            batch(&over).encode().unwrap_err(),
            BatchExclusionReason::InvalidCarrierEncoding
        );
    }

    #[test]
    fn exclusion_reason_comes_from_the_failing_framing_check() {
        let rules = ProtocolRules::new([vec![], vec![]], vec![]);
        assert_eq!(
            Batch::decode_accepted(&[], &rules, 0).unwrap_err(),
            BatchExclusionReason::TruncatedFraming
        );
        let mut bytes = header(0);
        bytes[0] = 0xff;
        bytes[1..33].fill(0xff);
        assert_eq!(
            Batch::decode_accepted(&bytes, &rules, 0).unwrap_err(),
            BatchExclusionReason::UnsupportedBatchVersion
        );
        bytes[0] = 1;
        assert_eq!(
            Batch::decode_accepted(&bytes, &rules, 0).unwrap_err(),
            BatchExclusionReason::InvalidPosterOwnerCommitment
        );
        let mut bytes = header((MAX_BATCH_ENTRIES + 1) as u16);
        assert_eq!(
            Batch::decode_accepted(&bytes, &rules, 0).unwrap_err(),
            BatchExclusionReason::BatchCountLimit
        );
        bytes = header(1);
        bytes.extend_from_slice(&1u32.to_be_bytes());
        assert_eq!(
            Batch::decode_accepted(&bytes, &rules, 0).unwrap_err(),
            BatchExclusionReason::TruncatedFraming
        );
        bytes = header(0);
        bytes.push(0);
        assert_eq!(
            Batch::decode_accepted(&bytes, &rules, 0).unwrap_err(),
            BatchExclusionReason::TrailingBatchBytes
        );
    }
}
