//! `Batch::encode` and `Batch::decode` are exact inverses over a frozen layout.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions"
)]

mod common;

use alloy_primitives::B256;
use common::{field_element, word};
use pcash_derive::{Batch, BatchExclusionReason, BatchVersion, MAX_BATCH_ENTRIES};
use pcash_state::Fr;

fn batch<'a>(items: &[&'a [u8]]) -> Batch<'a> {
    Batch {
        version: BatchVersion::V1,
        poster_owner_commitment: field_element(word(0xbeef)),
        poster_context: word(0xcafe),
        items: items.to_vec(),
    }
}

/// Both directions: the batch survives its bytes and the bytes survive their
/// batch.
#[track_caller]
fn assert_roundtrip(batch: &Batch<'_>) -> Vec<u8> {
    let encoded = batch.encode().unwrap();
    let decoded = Batch::decode(&encoded).unwrap();
    assert_eq!(&decoded, batch);
    assert_eq!(decoded.encode().unwrap(), encoded);
    encoded
}

#[test]
fn layout_is_frozen() {
    let poster = field_element(B256::repeat_byte(0x11));
    let context = B256::repeat_byte(0x22);
    let value = Batch {
        version: BatchVersion::V1,
        poster_owner_commitment: poster,
        poster_context: context,
        items: vec![&[0xaa, 0xbb], &[], &[0xcc]],
    };

    let mut expected = vec![0u8; 82];
    expected[0] = 0x01;
    expected[1..33].fill(0x11);
    expected[33..65].fill(0x22);
    expected[65..67].copy_from_slice(&[0x00, 0x03]);
    expected[67..71].copy_from_slice(&[0, 0, 0, 2]);
    expected[71..73].copy_from_slice(&[0xaa, 0xbb]);
    expected[73..77].copy_from_slice(&[0, 0, 0, 0]);
    expected[77..81].copy_from_slice(&[0, 0, 0, 1]);
    expected[81] = 0xcc;

    assert_eq!(value.encode().unwrap(), expected);
    assert_eq!(Batch::decode(&expected), Ok(value));
    assert_eq!(Batch::HEADER_LEN, 67);
    assert_eq!(Batch::ITEM_PREFIX_LEN, 4);
}

#[test]
fn empty_and_full_batches_round_trip() {
    assert_eq!(assert_roundtrip(&batch(&[])).len(), Batch::HEADER_LEN);

    let item = [0x5a_u8; 3];
    let full = vec![&item[..]; MAX_BATCH_ENTRIES];
    assert_roundtrip(&batch(&full));

    // Both poster words may be zero.
    let mut zero_context = batch(&[&item]);
    zero_context.poster_context = B256::ZERO;
    assert_roundtrip(&zero_context);
    let mut zero_poster = batch(&[&item]);
    zero_poster.poster_owner_commitment = Fr::from(0u64);
    let encoded = assert_roundtrip(&zero_poster);
    assert_eq!(&encoded[1..33], B256::ZERO.as_slice());
}

#[test]
fn every_encoding_has_exactly_one_valid_length() {
    let encoded = assert_roundtrip(&batch(&[&[1, 2, 3], &[], &[4]]));
    assert_eq!(
        Batch::decode(&[]),
        Err(BatchExclusionReason::TruncatedFraming)
    );
    for length in 1..encoded.len() {
        assert!(
            Batch::decode(&encoded[..length]).is_err(),
            "prefix of {length} bytes decoded"
        );
    }
    let mut trailing = encoded;
    trailing.push(0);
    assert_eq!(
        Batch::decode(&trailing),
        Err(BatchExclusionReason::TrailingBatchBytes)
    );
}

#[test]
fn a_batch_with_no_encoding_is_the_reason_decoding_would_give() {
    let outside_field = B256::repeat_byte(0xff);

    let mut noncanonical_context = batch(&[]);
    noncanonical_context.poster_context = outside_field;
    let too_many = batch(&vec![&[][..]; MAX_BATCH_ENTRIES + 1]);

    for (value, reason) in [
        (
            &noncanonical_context,
            BatchExclusionReason::InvalidPosterContext,
        ),
        (&too_many, BatchExclusionReason::BatchCountLimit),
    ] {
        assert_eq!(value.encode(), Err(reason));
    }

    // The same header bytes are what decoding rejects. A poster commitment
    // is a field element, so only its non-canonical words have no batch.
    for (offset, fill, reason) in [
        (1, 0xff, BatchExclusionReason::InvalidPosterOwnerCommitment),
        (33, 0xff, BatchExclusionReason::InvalidPosterContext),
    ] {
        let mut encoded = batch(&[]).encode().unwrap();
        encoded[offset..offset + 32].fill(fill);
        assert_eq!(Batch::decode(&encoded), Err(reason));
    }
}

/// splitmix64.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn bytes(&mut self, len: usize) -> Vec<u8> {
        (0..len).map(|_| self.next() as u8).collect()
    }
}

#[test]
fn generated_batches_round_trip() {
    let mut rng = Rng(0x5043_4153_4842_4154);
    for _ in 0..1_000 {
        let count = (rng.next() % 9) as usize;
        let items: Vec<Vec<u8>> = (0..count)
            .map(|_| {
                let len = (rng.next() % 40) as usize;
                rng.bytes(len)
            })
            .collect();
        let value = Batch {
            version: BatchVersion::V1,
            poster_owner_commitment: Fr::from(rng.next()),
            poster_context: word(rng.next()),
            items: items.iter().map(Vec::as_slice).collect(),
        };
        let encoded = assert_roundtrip(&value);
        assert_eq!(
            encoded.len(),
            Batch::HEADER_LEN
                + items
                    .iter()
                    .map(|item| Batch::ITEM_PREFIX_LEN + item.len())
                    .sum::<usize>()
        );
    }
}
