//! Canonical PCASH data-carrier encoding.
//!
//! PCASH uses one deliberately simple encoding inside Ethereum blobs. The
//! layout matches Alloy's `SimpleCoder` for one value, but consensus is defined
//! here rather than by a dependency's decoder:
//!
//! - every 32-byte field element starts with zero;
//! - the first field element contains an eight-byte big-endian payload length
//!   in bytes 1 through 8 and zero padding after it;
//! - subsequent field elements carry 31 payload bytes each;
//! - the final field element and every unused field element are zero padded;
//! - the number of blobs is minimal for the declared payload.

#[cfg(feature = "kzg")]
use alloy_eips::eip4844::{env_settings::EnvKzgSettings, kzg_to_versioned_hash, AsCkzg};
use alloy_eips::{
    eip4844::{Blob, FIELD_ELEMENTS_PER_BLOB, VERSIONED_HASH_VERSION_KZG},
    eip7594::MAX_BLOBS_PER_TX_FUSAKA,
};
use alloy_primitives::B256;

const FIELD_ELEMENT_BYTES: usize = 32;
const PAYLOAD_BYTES_PER_FIELD_ELEMENT: usize = 31;
const LENGTH_BYTES: usize = 8;

/// Maximum number of blobs in one canonical PCASH carrier.
///
/// PCASH fixes this consensus limit to Ethereum's Fusaka per-transaction
/// maximum. Later block-level blob-parameter changes do not change the number
/// of blobs one transaction may carry.
pub const MAX_BATCH_BLOBS: usize = MAX_BLOBS_PER_TX_FUSAKA as usize;

/// Maximum byte length of one canonical PCASH batch, independent of carrier.
///
/// One field element is reserved for the length header. Every remaining field
/// element in the maximum six-blob transaction carries 31 payload bytes.
pub const MAX_BATCH_BYTES: usize =
    (MAX_BATCH_BLOBS * FIELD_ELEMENTS_PER_BLOB as usize - 1) * PAYLOAD_BYTES_PER_FIELD_ELEMENT;

/// How an Inbox transaction carries its batch, selected structurally before
/// any blob I/O or batch parsing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InboxEncoding {
    Calldata,
    Blob,
    Invalid,
}

/// Classify an Inbox transaction without performing availability work.
pub fn classify_inbox_carrier(input: &[u8], versioned_hashes: &[B256]) -> InboxEncoding {
    if versioned_hashes.is_empty() {
        return if input.len() <= MAX_BATCH_BYTES {
            InboxEncoding::Calldata
        } else {
            InboxEncoding::Invalid
        };
    }
    if !input.is_empty()
        || versioned_hashes.len() > MAX_BATCH_BLOBS
        || versioned_hashes
            .iter()
            .any(|hash| !is_supported_versioned_hash(hash))
    {
        return InboxEncoding::Invalid;
    }
    InboxEncoding::Blob
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CodecError {
    #[error("blob carrier contains no blobs")]
    NoBlobs,
    #[error("blob carrier declares an empty payload")]
    EmptyPayload,
    #[error("blob payload length does not fit this platform")]
    LengthOverflow,
    #[error("blob payload length {length} exceeds the {maximum}-byte limit")]
    PayloadTooLarge { length: usize, maximum: usize },
    #[error("blob carrier ends before its declared {length}-byte payload")]
    Truncated { length: usize },
    #[error("blob carrier is not the canonical PCASH encoding")]
    NonCanonical,
}

/// Return the minimal blob count for one nonempty payload.
pub fn required_blobs(payload_len: usize) -> Result<usize, CodecError> {
    if payload_len == 0 {
        return Ok(0);
    }
    if payload_len > MAX_BATCH_BYTES {
        return Err(CodecError::PayloadTooLarge {
            length: payload_len,
            maximum: MAX_BATCH_BYTES,
        });
    }
    let payload_elements = payload_len.div_ceil(PAYLOAD_BYTES_PER_FIELD_ELEMENT);
    let total_elements = payload_elements + 1;
    let elements_per_blob = FIELD_ELEMENTS_PER_BLOB as usize;
    Ok(total_elements.div_ceil(elements_per_blob))
}

/// Encode exactly one nonempty payload into its canonical minimal blob list.
pub fn encode(payload: &[u8]) -> Result<Vec<Blob>, CodecError> {
    if payload.is_empty() {
        return Err(CodecError::EmptyPayload);
    }
    let blob_count = required_blobs(payload.len())?;
    let mut blobs = vec![Blob::default(); blob_count];

    let length = payload.len() as u64;
    blobs[0][1..=LENGTH_BYTES].copy_from_slice(&length.to_be_bytes());

    for (chunk_index, chunk) in payload.chunks(PAYLOAD_BYTES_PER_FIELD_ELEMENT).enumerate() {
        let field_index = chunk_index + 1;
        let blob_index = field_index / FIELD_ELEMENTS_PER_BLOB as usize;
        let field_in_blob = field_index % FIELD_ELEMENTS_PER_BLOB as usize;
        let start = field_in_blob * FIELD_ELEMENT_BYTES + 1;
        let end = start + chunk.len();
        blobs[blob_index][start..end].copy_from_slice(chunk);
    }
    Ok(blobs)
}

/// Decode one payload and reject every alternate representation of the same
/// bytes, including extra blobs, nonzero padding, and a second encoded value.
pub fn decode_canonical_refs(blobs: &[&Blob], maximum: usize) -> Result<Vec<u8>, CodecError> {
    let first = blobs.first().ok_or(CodecError::NoBlobs)?;
    let mut encoded_length = [0u8; LENGTH_BYTES];
    encoded_length.copy_from_slice(&first[1..=LENGTH_BYTES]);
    let length_u64 = u64::from_be_bytes(encoded_length);
    let length = usize::try_from(length_u64).map_err(|_| CodecError::LengthOverflow)?;
    if length == 0 {
        return Err(CodecError::EmptyPayload);
    }
    if length > maximum {
        return Err(CodecError::PayloadTooLarge { length, maximum });
    }
    let blob_count = required_blobs(length)?;
    if blob_count > blobs.len() {
        return Err(CodecError::Truncated { length });
    }
    if blob_count != blobs.len()
        || first[0] != 0
        || first[LENGTH_BYTES + 1..FIELD_ELEMENT_BYTES]
            .iter()
            .any(|&byte| byte != 0)
    {
        return Err(CodecError::NonCanonical);
    }

    let mut payload = Vec::with_capacity(length);
    for field in blobs
        .iter()
        .flat_map(|blob| blob.chunks_exact(FIELD_ELEMENT_BYTES))
        .skip(1)
    {
        let body = &field[1..];
        let take = (length - payload.len()).min(PAYLOAD_BYTES_PER_FIELD_ELEMENT);
        if field[0] != 0 || body[take..].iter().any(|&byte| byte != 0) {
            return Err(CodecError::NonCanonical);
        }
        payload.extend_from_slice(&body[..take]);
    }
    Ok(payload)
}

/// True only for the KZG commitment version whose blob codec PCASH defines.
pub const fn is_supported_versioned_hash(hash: &B256) -> bool {
    hash.0[0] == VERSIONED_HASH_VERSION_KZG
}

/// Recompute the EIP-4844 versioned hash for untrusted blob bytes.
#[cfg(feature = "kzg")]
pub fn versioned_hash(blob: &Blob) -> Result<B256, c_kzg::Error> {
    let settings = EnvKzgSettings::Default.get();
    let commitment = settings.blob_to_kzg_commitment(blob.as_ckzg())?;
    Ok(kzg_to_versioned_hash(commitment.to_bytes().as_ref()))
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]
mod tests {
    use super::*;
    use alloy_eips::eip4844::builder::{SidecarBuilder, SimpleCoder};
    use serde::Deserialize;
    use sha2::{Digest, Sha256};

    /// [`decode_canonical_refs`] over owned blobs.
    fn decode_canonical(blobs: &[Blob], maximum: usize) -> Result<Vec<u8>, CodecError> {
        decode_canonical_refs(&blobs.iter().collect::<Vec<_>>(), maximum)
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CodecVectors {
        format: String,
        payload_pattern: String,
        cases: Vec<CodecVector>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CodecVector {
        name: String,
        payload_length: usize,
        blob_count: usize,
        blob_sha256: Vec<String>,
    }

    #[test]
    fn round_trips_one_and_multiple_blobs() {
        for length in [1, 30, 31, 32, 126_945, 126_946, MAX_BATCH_BYTES] {
            let payload = (0..length).map(|i| i as u8).collect::<Vec<_>>();
            let blobs = encode(&payload).unwrap();
            assert_eq!(blobs.len(), required_blobs(length).unwrap());
            assert_eq!(decode_canonical(&blobs, MAX_BATCH_BYTES).unwrap(), payload);
        }
    }

    #[test]
    fn rejects_a_declared_length_the_supplied_blobs_cannot_hold() {
        // One byte past a single blob's capacity, declared in a lone blob.
        let mut blobs = encode(&vec![7; 126_945]).unwrap();
        assert_eq!(blobs.len(), 1);
        blobs[0][1..=LENGTH_BYTES].copy_from_slice(&126_946u64.to_be_bytes());
        assert_eq!(
            decode_canonical(&blobs, MAX_BATCH_BYTES),
            Err(CodecError::Truncated { length: 126_946 })
        );

        // A carrier that dropped trailing blobs of an honest encoding.
        for length in [126_946, 3 * 126_945, MAX_BATCH_BYTES] {
            let mut blobs = encode(&vec![7; length]).unwrap();
            while blobs.len() > 1 {
                blobs.pop();
                assert_eq!(
                    decode_canonical(&blobs, MAX_BATCH_BYTES),
                    Err(CodecError::Truncated { length })
                );
            }
        }
    }

    #[test]
    fn a_hostile_length_word_is_bounded_before_any_allocation() {
        let mut blobs = encode(&[7]).unwrap();
        blobs[0][1..=LENGTH_BYTES].copy_from_slice(&u64::MAX.to_be_bytes());
        assert!(matches!(
            decode_canonical(&blobs, MAX_BATCH_BYTES),
            Err(CodecError::PayloadTooLarge { .. })
        ));
        // Even a caller-supplied ceiling above the protocol maximum cannot
        // make the blob count arithmetic run on an unbounded length.
        assert!(matches!(
            decode_canonical(&blobs, usize::MAX),
            Err(CodecError::PayloadTooLarge { .. })
        ));
    }

    #[test]
    fn encoding_matches_alloy_simple_coder_for_one_value() {
        for length in [1, 31, 32, 126_945, 126_946, MAX_BATCH_BYTES] {
            let payload = (0..length).map(|i| i as u8).collect::<Vec<_>>();
            let expected = SidecarBuilder::<SimpleCoder>::from_slice(&payload).take();
            assert_eq!(encode(&payload).unwrap(), expected);
        }
    }

    #[test]
    fn matches_shared_cross_language_blob_vectors() {
        let vectors: CodecVectors =
            serde_json::from_str(include_str!("../../../../vectors/blob_codec.json")).unwrap();
        assert_eq!(vectors.format, "pcash-blob-codec");
        assert_eq!(vectors.payload_pattern, "byte[i] = i mod 256");
        for vector in vectors.cases {
            let payload = (0..vector.payload_length)
                .map(|index| index as u8)
                .collect::<Vec<_>>();
            let blobs = encode(&payload).unwrap();
            assert_eq!(blobs.len(), vector.blob_count, "{}", vector.name);
            let digests = blobs
                .iter()
                .map(|blob| hex::encode(Sha256::digest(blob.as_slice())))
                .collect::<Vec<_>>();
            assert_eq!(digests, vector.blob_sha256, "{}", vector.name);
        }
    }

    #[test]
    fn maximum_batch_exactly_fills_one_l1_transaction() {
        assert_eq!(MAX_BATCH_BLOBS, 6);
        assert_eq!(MAX_BATCH_BYTES, 761_825);
        assert_eq!(required_blobs(MAX_BATCH_BYTES), Ok(MAX_BATCH_BLOBS));
        assert_eq!(
            required_blobs(MAX_BATCH_BYTES + 1),
            Err(CodecError::PayloadTooLarge {
                length: MAX_BATCH_BYTES + 1,
                maximum: MAX_BATCH_BYTES,
            })
        );
        assert!(matches!(
            encode(&vec![0; MAX_BATCH_BYTES + 1]),
            Err(CodecError::PayloadTooLarge { .. })
        ));
    }

    #[test]
    fn rejects_empty_payload_and_empty_carrier() {
        assert_eq!(encode(&[]), Err(CodecError::EmptyPayload));
        assert_eq!(
            decode_canonical(&[], MAX_BATCH_BYTES),
            Err(CodecError::NoBlobs)
        );
        let empty_blob = Blob::default();
        assert_eq!(
            decode_canonical(std::slice::from_ref(&empty_blob), MAX_BATCH_BYTES),
            Err(CodecError::EmptyPayload)
        );
    }

    #[test]
    fn rejects_nonzero_prefixes_and_every_padding_region() {
        for length in [5, 126_946] {
            let canonical = encode(&vec![7; length]).unwrap();
            let final_field = length.div_ceil(PAYLOAD_BYTES_PER_FIELD_ELEMENT);
            let final_payload_bytes = (length - 1) % PAYLOAD_BYTES_PER_FIELD_ELEMENT + 1;
            let total_bytes = canonical.len() * canonical[0].len();
            let mut offsets = vec![
                0,
                LENGTH_BYTES + 1,
                FIELD_ELEMENT_BYTES - 1,
                FIELD_ELEMENT_BYTES,
                final_field * FIELD_ELEMENT_BYTES,
                final_field * FIELD_ELEMENT_BYTES + 1 + final_payload_bytes,
                (final_field + 1) * FIELD_ELEMENT_BYTES,
                (final_field + 1) * FIELD_ELEMENT_BYTES + 1,
                total_bytes - FIELD_ELEMENT_BYTES,
                total_bytes - 1,
            ];
            if canonical.len() > 1 {
                offsets.push(canonical[0].len());
                offsets.push(canonical[0].len() - FIELD_ELEMENT_BYTES);
            }
            for offset in offsets {
                let mut blobs = canonical.clone();
                blobs[offset / canonical[0].len()][offset % canonical[0].len()] = 1;
                assert_eq!(
                    decode_canonical(&blobs, MAX_BATCH_BYTES),
                    Err(CodecError::NonCanonical),
                    "payload length {length}, offset {offset}"
                );
            }
        }
    }

    #[test]
    fn rejects_nonminimal_blob_count_and_trailing_value() {
        let mut blobs = encode(b"pcash").unwrap();
        blobs.push(Blob::default());
        assert_eq!(
            decode_canonical(&blobs, MAX_BATCH_BYTES),
            Err(CodecError::NonCanonical)
        );

        let mut blobs = encode(b"pcash").unwrap();
        let second_header = 2 * FIELD_ELEMENT_BYTES;
        blobs[0][second_header + 8] = 1;
        assert_eq!(
            decode_canonical(&blobs, MAX_BATCH_BYTES),
            Err(CodecError::NonCanonical)
        );
    }

    #[test]
    fn rejects_declared_payload_above_limit() {
        let mut blob = Blob::default();
        let oversized = MAX_BATCH_BYTES + 1;
        blob[1..9].copy_from_slice(&(oversized as u64).to_be_bytes());
        assert_eq!(
            decode_canonical(std::slice::from_ref(&blob), MAX_BATCH_BYTES),
            Err(CodecError::PayloadTooLarge {
                length: oversized,
                maximum: MAX_BATCH_BYTES
            })
        );
    }

    #[test]
    fn recognizes_only_kzg_versioned_hashes() {
        let mut hash = B256::ZERO;
        hash.0[0] = VERSIONED_HASH_VERSION_KZG;
        assert!(is_supported_versioned_hash(&hash));
        hash.0[0] = 2;
        assert!(!is_supported_versioned_hash(&hash));
    }

    #[test]
    fn carrier_classification_rejects_mixed_and_unsupported_inputs() {
        let mut kzg_hash = B256::ZERO;
        kzg_hash.0[0] = VERSIONED_HASH_VERSION_KZG;
        assert_eq!(
            classify_inbox_carrier(b"batch", &[]),
            InboxEncoding::Calldata
        );
        assert_eq!(
            classify_inbox_carrier(&vec![0; MAX_BATCH_BYTES + 1], &[]),
            InboxEncoding::Invalid
        );
        assert_eq!(
            classify_inbox_carrier(&[], &[kzg_hash]),
            InboxEncoding::Blob
        );
        assert_eq!(
            classify_inbox_carrier(&[], &[kzg_hash; MAX_BATCH_BLOBS]),
            InboxEncoding::Blob
        );
        assert_eq!(
            classify_inbox_carrier(b"batch", &[kzg_hash]),
            InboxEncoding::Invalid
        );

        let unsupported = B256::repeat_byte(2);
        assert_eq!(
            classify_inbox_carrier(&[], &[unsupported]),
            InboxEncoding::Invalid
        );
        assert_eq!(
            classify_inbox_carrier(&[], &[kzg_hash; MAX_BATCH_BLOBS + 1]),
            InboxEncoding::Invalid
        );
    }

    #[cfg(feature = "kzg")]
    #[test]
    fn versioned_hash_matches_eip4844_kzg_commitment() {
        let zero_hash = versioned_hash(&Blob::default()).unwrap();
        assert!(is_supported_versioned_hash(&zero_hash));
        assert_eq!(
            hex::encode(zero_hash),
            "010657f37554c781402a22917dee2f75def7ab966d7b770905398eba3c444014"
        );
        let blobs = encode(b"pcash").unwrap();
        let hash = versioned_hash(&blobs[0]).unwrap();
        assert!(is_supported_versioned_hash(&hash));
        assert_ne!(hash, zero_hash);
    }
}
