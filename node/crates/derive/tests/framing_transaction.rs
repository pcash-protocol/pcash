#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]
//! Framing and transaction-decode tests.

mod common;
use common::*;

use pcash_derive::params::private_value_tx_bytes;
use pcash_derive::private_value_profiles::{PrivateValueShape, S};
use pcash_derive::{
    AccountCreationAuthorization, Batch, BatchExclusionReason, BatchVersion, ContractFunding,
    ParseError, ReceiveKeyUpdate, SectionLayout, Transaction, UserAccountCreation,
    ACCOUNT_MAX_TX_BYTES, BATCH_VERSION_V1, CONTRACT_FUNCTION_BYTES, CONTRACT_MAX_BODY_BYTES,
    CONTRACT_MAX_TX_BYTES, KIND_PRIVATE_VALUE, KIND_USER_ACCOUNT_CREATION, MAX_TX_BYTES,
    MAX_VALID_TX_BYTES, ML_KEM768_PUBLIC_KEY_LEN, OUTPUT_DATA_BYTES, PRIVATE_VALUE_MAX_TX_BYTES,
    PRIVATE_VALUE_PUBLIC_INPUTS, PRIVATE_VALUE_WIRE_INPUTS, USER_ACCOUNT_UPDATE_MAX_TX_BYTES,
    WIRE_PROOF_BYTES,
};
use pcash_state::{content_hash, CircuitWord};

const TRANSFER: SectionLayout = SectionLayout::PrivateValue(PrivateValueShape::S);

/// Decode `tx` under the test network's chain ID.
fn decode(tx: &[u8]) -> Result<Transaction, ParseError> {
    Transaction::decode(tx, PCASH_CHAIN_ID)
}

/// A complete same-chain envelope of type `kind` with no payload.
fn envelope(kind: u8) -> Vec<u8> {
    let mut tx = vec![kind];
    tx.extend_from_slice(&PCASH_CHAIN_ID.to_be_bytes());
    tx
}

// ---- framing --------------------------------------------------------------

#[test]
fn valid_batch_parses_to_n_items() {
    let item0 = vec![0xaa, 0xbb];
    let item1 = vec![0x01, 0x02, 0x03];
    let cd = batch(&[item0.clone(), item1.clone()]);
    let items = Batch::decode(&cd).expect("valid batch").items;
    assert_eq!(items.len(), 2);
    assert_eq!(items[0], item0.as_slice());
    assert_eq!(items[1], item1.as_slice());
}

#[test]
fn empty_count_batch_is_valid_and_empty() {
    let cd = batch(&[]);
    let items = Batch::decode(&cd).expect("count==0 is a valid batch").items;
    assert!(items.is_empty());
}

#[test]
fn wrong_version_ignored() {
    let mut cd = batch(&[vec![1, 2, 3]]);
    cd[0] = 0x02;
    assert!(Batch::decode(&cd).is_err());
}

#[test]
fn versioned_parser_returns_v1() {
    let item = vec![0xaa, 0xbb];
    let cd = batch_for_version(std::slice::from_ref(&item), BatchVersion::V1);
    let parsed = Batch::decode(&cd).expect("known version");
    assert_eq!(parsed.version, BatchVersion::V1);
    assert_eq!(parsed.items, vec![item.as_slice()]);
}

/// A fork that changes the transaction-type set leaves the encoding set alone.
/// The two axes stay independent — a batch version never selects transaction
/// semantics — even though both are timestamped.
#[test]
fn a_fork_that_retires_a_transaction_type_leaves_the_base_encoding_readable() {
    let launch = stub_rules();
    let forked = stub_rules().with_fork(fork_at(10));
    let item = vec![0xff];
    let encoded = batch_for_version(&[item], BatchVersion::V1);

    assert_eq!(
        Batch::decode_accepted(&encoded, &launch, 0)
            .unwrap()
            .version,
        BatchVersion::V1
    );
    assert_eq!(
        Batch::decode_accepted(&encoded, &forked, 20)
            .unwrap()
            .version,
        BatchVersion::V1
    );
}

/// The accepted batch encodings are a function of the block timestamp, so a
/// replayed block is framed with the encodings of its own time.
///
/// This is the property that makes encoding-only changes time-dependent. The
/// inbox is a routing tag, so anyone may post calldata under a version byte
/// this release cannot read; it is skipped. If a release changed the encoding
/// set globally rather than from an activation timestamp, cold replay would
/// frame calldata differently from how every node framed it when it was
/// posted, and two releases would derive different state from identical L1
/// history.
#[test]
fn batch_encoding_acceptance_follows_the_block_timestamp() {
    let item = vec![0xff];
    let v1 = batch_for_version(std::slice::from_ref(&item), BatchVersion::V1);
    let mut unknown = v1.clone();
    unknown[0] = 0xf0;

    // A version byte no rule set defines never parses.
    let launch = stub_rules();
    for ts in [0, 10, 1_000_000] {
        assert!(
            Batch::decode_accepted(&unknown, &launch, ts).is_err(),
            "an undefined encoding must never parse (ts {ts})"
        );
    }

    // A fork that retires V1 at 100 keeps every earlier block readable,
    // including on replay long after activation.
    let mut retired = fork_at(100);
    retired.accepted_batch_versions = Vec::new();
    let scheduled = stub_rules().with_fork(retired);
    for ts in [0, 50, 99] {
        assert_eq!(
            Batch::decode_accepted(&v1, &scheduled, ts).unwrap().version,
            BatchVersion::V1
        );
    }

    // From activation onward V1 no longer reads.
    for ts in [100, 1_000_000] {
        assert!(
            Batch::decode_accepted(&v1, &scheduled, ts).is_err(),
            "a retired encoding must not parse after activation (ts {ts})"
        );
    }
}

#[test]
fn overrun_length_ignored() {
    // Declare an item longer than the remaining calldata.
    let mut cd = batch(&[]);
    cd[65..67].copy_from_slice(&1u16.to_be_bytes()); // count = 1
    cd.extend_from_slice(&100u32.to_be_bytes()); // len = 100
    cd.extend_from_slice(&[0u8; 10]); // only 10 bytes present
    assert_eq!(
        Batch::decode(&cd).unwrap_err(),
        BatchExclusionReason::TruncatedFraming
    );
}

#[test]
fn trailing_bytes_ignored() {
    let mut cd = batch(&[vec![9, 9]]);
    cd.push(0x00); // extra byte after final item
    assert!(Batch::decode(&cd).is_err());
}

#[test]
fn truncated_header_ignored() {
    assert!(Batch::decode(&[]).is_err());
    assert!(Batch::decode(&[BATCH_VERSION_V1]).is_err());
    assert!(Batch::decode(&[BATCH_VERSION_V1, 0]).is_err());
}

#[test]
fn oversize_count_ignored() {
    let mut cd = batch(&[]);
    cd[65..67].copy_from_slice(&(pcash_derive::MAX_BATCH_ENTRIES as u16 + 1).to_be_bytes());
    assert_eq!(
        Batch::decode(&cd).unwrap_err(),
        BatchExclusionReason::BatchCountLimit
    );
}

#[test]
fn declared_item_length_exceeds_remaining_bytes() {
    let mut cd = batch(&[]);
    cd[65..67].copy_from_slice(&1u16.to_be_bytes());
    cd.extend_from_slice(&(pcash_derive::MAX_TX_BYTES as u32 + 1).to_be_bytes());
    assert_eq!(
        Batch::decode(&cd).unwrap_err(),
        BatchExclusionReason::TruncatedFraming
    );
}

// ---- transaction decode round-trips ---------------------------------------

fn sample_transfer_pis() -> Vec<CircuitWord> {
    let mut pis: Vec<CircuitWord> = (0..PRIVATE_VALUE_PUBLIC_INPUTS)
        .map(|i| word(1000 + i as u64))
        .collect();
    pis[0] = word(u64::from(PCASH_CHAIN_ID));
    pis
}

fn slices(items: &[Vec<u8>]) -> Vec<&[u8]> {
    items.iter().map(Vec::as_slice).collect()
}

#[test]
fn transfer_round_trips() {
    let mut pis = sample_transfer_pis();
    let proof = stub_proof(TRANSFER, &[0xde; 200]);
    let output_data: Vec<Vec<u8>> = (1..=5u8)
        .map(|fill| vec![fill; OUTPUT_DATA_BYTES])
        .collect();
    pis[S.delivery_commitment_offset] =
        delivery_commitment_word(&slices(&output_data), &dummy_arena(PrivateValueShape::S));
    let tx = transfer_txbytes(&pis, &proof, &slices(&output_data));
    match decode(&tx).expect("parse") {
        Transaction::PrivateValue(p) => {
            assert_eq!(p.public_inputs(), pis);
            assert_eq!(p.proof, proof);
            assert_eq!(
                p.output_data()
                    .iter()
                    .map(|data| data.as_slice())
                    .collect::<Vec<_>>(),
                slices(&output_data)
            );
            assert_eq!(p.arena(), dummy_arena(PrivateValueShape::S));
        }
        _ => panic!("expected transfer"),
    }
}

#[test]
fn type_five_is_unknown() {
    assert_eq!(decode(&envelope(5)), Err(ParseError::UnknownKind(5)));
}

#[test]
fn private_value_output_data_and_arena_have_exact_sizes() {
    let pis = sample_transfer_pis();
    let tx = transfer_txbytes(
        &pis,
        &stub_proof(TRANSFER, &[]),
        &[DUMMY_OUTPUT_DATA.as_slice(); 5],
    );
    let parsed = match decode(&tx).expect("five full items and the arena parse") {
        Transaction::PrivateValue(parsed) => parsed,
        _ => panic!("expected transfer"),
    };
    assert_eq!(
        parsed
            .output_data()
            .iter()
            .map(|data| data.as_slice())
            .collect::<Vec<_>>(),
        vec![DUMMY_OUTPUT_DATA.as_slice(); 5]
    );
    assert_eq!(parsed.arena(), dummy_arena(PrivateValueShape::S));
    assert_eq!(
        parsed.public_inputs()[S.delivery_commitment_offset],
        uniform_delivery_commitment(PrivateValueShape::S, &DUMMY_OUTPUT_DATA)
    );

    let missing_arena = &tx[..tx.len() - S.arena_bytes];
    assert_eq!(decode(missing_arena), Err(ParseError::Truncated));
    let arena_short = &tx[..tx.len() - 1];
    assert_eq!(decode(arena_short), Err(ParseError::Truncated));

    let mut extra_item = tx;
    extra_item.extend_from_slice(&DUMMY_OUTPUT_DATA);
    assert_eq!(decode(&extra_item).err(), Some(ParseError::Trailing));
}

#[test]
fn the_delivery_commitment_is_reconstructed_from_exact_wire_bytes() {
    let item = |text: &[u8]| {
        let mut data = text.to_vec();
        data.resize(OUTPUT_DATA_BYTES, 0);
        data
    };
    let mut pis = sample_transfer_pis();
    let proof = stub_proof(TRANSFER, &[0xde; 17]);
    let output_data = vec![
        item(b"original-data"),
        item(b""),
        item(b"dummy-data"),
        item(b""),
        item(b""),
    ];
    let arena = dummy_arena(PrivateValueShape::S);
    let dc = S.delivery_commitment_offset;
    pis[dc] = delivery_commitment_word(&slices(&output_data), &arena);

    let original = transfer_txbytes(&pis, &proof, &slices(&output_data));
    assert_eq!(
        original.len(),
        1 + 4
            + 1
            + PRIVATE_VALUE_WIRE_INPUTS * 32
            + WIRE_PROOF_BYTES
            + 5 * OUTPUT_DATA_BYTES
            + S.arena_bytes
    );
    let parsed = match decode(&original).expect("parse original") {
        Transaction::PrivateValue(parsed) => parsed,
        _ => panic!("expected transfer"),
    };
    assert_eq!(parsed.public_inputs(), pis);

    let mut changed_output_data = output_data.clone();
    changed_output_data[0] = item(b"changed-data");
    let mut changed_arena = arena.clone();
    changed_arena[S.arena_bytes - 1] ^= 0xff;
    for (changed, expected) in [
        (
            transfer_txbytes(&pis, &proof, &slices(&changed_output_data)),
            delivery_commitment_word(&slices(&changed_output_data), &arena),
        ),
        (
            profile_txbytes_with_arena(
                PrivateValueShape::S,
                &pis,
                &proof,
                &slices(&output_data),
                &changed_arena,
            ),
            delivery_commitment_word(&slices(&output_data), &changed_arena),
        ),
    ] {
        let changed_parsed = match decode(&changed).expect("parse changed") {
            Transaction::PrivateValue(parsed) => parsed,
            _ => panic!("expected transfer"),
        };
        assert_eq!(changed_parsed.public_inputs()[dc], expected);
        assert_ne!(expected, pis[dc]);
        assert_eq!(&changed_parsed.public_inputs()[..dc], &pis[..dc]);
        assert_eq!(&changed_parsed.public_inputs()[dc + 1..], &pis[dc + 1..]);
        assert_ne!(content_hash(&changed), content_hash(&original));
    }
}

#[test]
fn timestamp_activation_retires_a_transaction_type() {
    let rules = stub_rules().with_fork(fork_at(10));
    let mut pis = vec![CircuitWord::ZERO; PRIVATE_VALUE_PUBLIC_INPUTS];
    pis[0] = word(u64::from(PCASH_CHAIN_ID));
    let transfer = transfer_txbytes(
        &pis,
        &stub_proof(TRANSFER, &[]),
        &[DUMMY_OUTPUT_DATA.as_slice(); 5],
    );
    let account = account_txbytes(
        word(7),
        word(8),
        None,
        CircuitWord::ZERO,
        20,
        CircuitWord::ZERO,
        CircuitWord::ZERO,
        0,
    );
    // The boundary is the exact activation timestamp, not the block before it.
    assert!(rules.transaction_type_allowed_at(KIND_USER_ACCOUNT_CREATION, 9));
    assert!(!rules.transaction_type_allowed_at(KIND_USER_ACCOUNT_CREATION, 10));
    for ts in [9, 10] {
        assert!(rules.transaction_type_allowed_at(KIND_PRIVATE_VALUE, ts));
    }
    // Decoding is independent of the fork gate: a retired type still decodes.
    assert!(matches!(
        decode(&account),
        Ok(Transaction::UserAccountCreation(_))
    ));
    assert!(matches!(
        decode(&transfer),
        Ok(Transaction::PrivateValue(_))
    ));
}

#[test]
fn account_round_trips_with_and_without_key() {
    // With receive key.
    let key = receive_key(0x5a);
    let tx = account_txbytes(
        word(0xaa),
        word(0xbb),
        Some(key.as_slice()),
        word(0xcc),
        123,
        word(0x11),
        word(0x22),
        0,
    );
    match decode(&tx).expect("parse") {
        Transaction::UserAccountCreation(r) => {
            assert_eq!(r.nullifier_key_commitment, word(0xaa));
            assert_eq!(r.receive_key(), Some(&*key));
            assert_eq!(r.recent_pcash_block_hash, word(0xcc));
            assert!(matches!(
                r.authorization,
                AccountCreationAuthorization::Eip712 {
                    y_parity: false,
                    ..
                }
            ));
        }
        _ => panic!("expected account"),
    }

    // Without receive key.
    let tx2 = account_txbytes(
        word(0xaa),
        word(0xbb),
        None,
        word(0xcc),
        124,
        word(0x11),
        word(0x22),
        1,
    );
    match decode(&tx2).expect("parse") {
        Transaction::UserAccountCreation(r) => {
            assert!(r.receive_key().is_none());
            assert_eq!(r.recent_pcash_block_hash, word(0xcc));
            assert!(matches!(
                r.authorization,
                AccountCreationAuthorization::Eip712 { y_parity: true, .. }
            ));
        }
        _ => panic!("expected account"),
    }
}

#[test]
fn user_account_update_round_trips_and_consumes_the_pinned_terminal_proof() {
    let proof = vec![0x44; WIRE_PROOF_BYTES];
    let tx = account_update_txbytes(
        addr(0x1234),
        word(0xbb),
        ReceiveKeyUpdate::Keep,
        word(0xdd),
        &zero_fee_section(word(0xcc), 1, 456, &proof),
    );
    let Transaction::UserAccountUpdate(update) = decode(&tx).expect("parse update") else {
        panic!("expected user-account update")
    };
    assert_eq!(update.address, addr(0x1234));
    assert_eq!(
        update.section.public_inputs().len(),
        PRIVATE_VALUE_PUBLIC_INPUTS
    );
    assert_eq!(
        update.section.public_inputs()[0],
        word(u64::from(PCASH_CHAIN_ID))
    );
    assert_eq!(update.section.public_inputs()[1], word(0xcc));
    assert_eq!(
        update.section.public_inputs()[pcash_derive::private_value_profiles::S.valid_until_offset],
        word(456)
    );
    assert_eq!(update.account_update_commitment, word(0xdd));
    assert_eq!(update.receive_key_update, ReceiveKeyUpdate::Keep);
    assert_eq!(update.section.proof, proof);

    // The update layout fixes the proof size.
    let proof_start =
        1 + 4 + 20 + 32 + 1 + 32 + SectionLayout::UserAccountUpdate.wire_inputs() * 32;
    assert_eq!(tx[proof_start..proof_start + proof.len()], proof[..]);
    let mut short_proof = tx.clone();
    short_proof.remove(proof_start);
    assert_eq!(decode(&short_proof).err(), Some(ParseError::Truncated));
    let mut cut = tx.clone();
    cut.pop();
    assert_eq!(decode(&cut).err(), Some(ParseError::Truncated));

    let mut trailing = tx;
    trailing.push(0);
    assert_eq!(decode(&trailing).err(), Some(ParseError::Trailing));

    let clear = account_update_txbytes(
        addr(0x1234),
        word(0xbb),
        ReceiveKeyUpdate::Clear,
        word(0xdd),
        &zero_fee_section(word(0xcc), 4, 456, &proof),
    );
    let Transaction::UserAccountUpdate(clear) = decode(&clear).expect("parse clear") else {
        panic!("expected user-account update")
    };
    assert_eq!(clear.receive_key_update, ReceiveKeyUpdate::Clear);

    let key = receive_key(0x5a);
    let replace = account_update_txbytes(
        addr(0x1234),
        word(0xbb),
        ReceiveKeyUpdate::Replace(key.clone()),
        word(0xdd),
        &zero_fee_section(word(0xcc), 5, 456, &proof),
    );
    assert_eq!(
        replace.len(),
        1 + 4
            + 20
            + 32
            + 1
            + ML_KEM768_PUBLIC_KEY_LEN
            + 32
            + zero_fee_section(word(0xcc), 5, 456, &proof).len()
    );
    let Transaction::UserAccountUpdate(replace) = decode(&replace).expect("parse replace") else {
        panic!("expected user-account update")
    };
    assert_eq!(replace.receive_key_update, ReceiveKeyUpdate::Replace(key));

    let mut invalid_operation = account_update_txbytes(
        addr(0x1234),
        word(0xbb),
        ReceiveKeyUpdate::Keep,
        word(0xdd),
        &zero_fee_section(word(0xcc), 6, 456, &proof),
    );
    invalid_operation[1 + 4 + 20 + 32] = 3;
    assert_eq!(
        decode(&invalid_operation).err(),
        Some(ParseError::UnknownReceiveKeyMode(3))
    );
}

// ---- malformed transactions rejected --------------------------------------

#[test]
fn empty_txbytes_rejected() {
    assert_eq!(decode(&[]), Err(ParseError::Empty));
}

#[test]
fn unknown_kind_rejected() {
    let mut tx = envelope(0x07);
    tx.push(0x00);
    assert_eq!(decode(&tx), Err(ParseError::UnknownKind(7)));
    // An item shorter than the envelope is truncated whatever its type byte.
    assert_eq!(decode(&[0x07, 0x00]), Err(ParseError::Truncated));
}

#[test]
fn transfer_trailing_bytes_rejected() {
    let pis = sample_transfer_pis();
    let mut tx = transfer_txbytes(
        &pis,
        &stub_proof(TRANSFER, &[]),
        &[DUMMY_OUTPUT_DATA.as_slice(); 5],
    );
    tx.push(0xff); // trailing byte
    assert_eq!(decode(&tx).err(), Some(ParseError::Trailing));
}

#[test]
fn transfer_truncated_public_inputs_rejected() {
    // One serialized verifier input short.
    let mut tx = envelope(KIND_PRIVATE_VALUE_LOCAL);
    tx.push(0); // shape S
    tx.extend(std::iter::repeat_n(
        0u8,
        SectionLayout::UserAccountUpdate.wire_inputs() * 32,
    ));
    assert_eq!(decode(&tx), Err(ParseError::Truncated));
}

#[test]
fn account_receive_key_mode_outside_its_set_is_not_decodable() {
    let mut tx = account_txbytes(
        word(0xaa),
        word(0xbb),
        None,
        word(0xcc),
        125,
        word(0x11),
        word(0x22),
        0,
    );
    tx[1 + 4 + 1 + 32 + 32] = 2;
    assert_eq!(decode(&tx), Err(ParseError::UnknownReceiveKeyMode(2)));
}

#[test]
fn account_y_parity_outside_its_set_is_not_decodable() {
    let tx = account_txbytes(
        word(0xaa),
        word(0xbb),
        None,
        word(0xcc),
        125,
        word(0x11),
        word(0x22),
        2,
    );
    assert_eq!(decode(&tx), Err(ParseError::UnknownYParity(2)));
}

/// `publishesNkRoot ‖ nullifier-key material ‖ receiveKeyMode ‖
/// functionCount`, with no receive key and no functions.
fn functionless_body(publishes_nk_root: u8, receive_key_mode: u8) -> Vec<u8> {
    let mut body = vec![publishes_nk_root];
    body.extend_from_slice(word(0xaa).as_slice());
    body.push(receive_key_mode);
    body.push(0); // functionCount
    body
}

#[test]
fn contract_selectors_outside_their_sets_are_not_decodable() {
    for (publishes_nk_root, receive_key_mode, expected) in [
        (1, 0, None),
        (2, 0, Some(ParseError::UnknownPublishesNkRootFlag(2))),
        (0, 2, Some(ParseError::UnknownReceiveKeyMode(2))),
    ] {
        let body = functionless_body(publishes_nk_root, receive_key_mode);
        for tx in [
            sponsored_contract_txbytes(&body, &contract_stub_section()),
            unfunded_contract_txbytes(&body, word(0xbb), 125),
        ] {
            let decoded = decode(&tx);
            match &expected {
                None => assert!(matches!(
                    decoded,
                    Ok(Transaction::ContractAccountCreation(_))
                )),
                Some(error) => assert_eq!(decoded.err().as_ref(), Some(error)),
            }
        }
    }
    let mut unknown = unfunded_contract_txbytes(&functionless_body(0, 0), word(0xbb), 125);
    unknown[5] = 2;
    assert_eq!(decode(&unknown), Err(ParseError::UnknownFundingMode(2)));
}

#[test]
fn contract_trailing_bytes_rejected() {
    let mut body = functionless_body(0, 0);
    body[34] = 1; // functionCount
    body.push(0); // selector
    body.extend_from_slice(word(1).as_slice());
    body.extend_from_slice(word(2).as_slice());
    for mut tx in [
        sponsored_contract_txbytes(&body, &contract_stub_section()),
        unfunded_contract_txbytes(&body, word(0xbb), 125),
    ] {
        assert!(matches!(
            decode(&tx),
            Ok(Transaction::ContractAccountCreation(_))
        ));
        tx.push(0xff);
        assert_eq!(decode(&tx).err(), Some(ParseError::Trailing));
    }
}

const KIND_PRIVATE_VALUE_LOCAL: u8 = 0;

/// A contract-creation section: a zero fee over the dummy output data.
fn contract_stub_section() -> Vec<u8> {
    let mut pis: Vec<CircuitWord> = (0..PRIVATE_VALUE_PUBLIC_INPUTS as u64).map(word).collect();
    pis[0] = word(u64::from(PCASH_CHAIN_ID));
    private_value_section(
        &pis,
        &stub_proof(SectionLayout::ContractAccountCreation, &[0xab; 8]),
        &[DUMMY_OUTPUT_DATA.as_slice(); 5],
    )
}

// ---- max serialization size -------------------------------------

/// `MAX_TX_BYTES` is a fixed parsing bound; the per-kind maxima are
/// non-normative sizing guidance and every real transaction stays under both.
#[test]
fn max_tx_bytes_is_the_fixed_parsing_bound() {
    assert_eq!(MAX_TX_BYTES, 131_072);
    assert_eq!(PRIVATE_VALUE_MAX_TX_BYTES, 80_198);
    assert_eq!(ACCOUNT_MAX_TX_BYTES, 1_360);
    assert_eq!(CONTRACT_FUNCTION_BYTES, 65);
    assert_eq!(CONTRACT_MAX_BODY_BYTES, 17_794);
    // The largest contract creation is sponsored: the funding mode and the
    // sponsor's private-value section precede the body.
    assert_eq!(CONTRACT_MAX_TX_BYTES, 49_409);
    assert_eq!(USER_ACCOUNT_UPDATE_MAX_TX_BYTES, 32_883);
    assert_eq!(
        SectionLayout::ContractAccountCreation.section_bytes(),
        31_609
    );
    // L is the widest compiled shape.
    assert_eq!(MAX_VALID_TX_BYTES, PRIVATE_VALUE_MAX_TX_BYTES);
    // Every per-kind worst case fits under the fixed bound, with headroom.
    for per_kind in [
        PRIVATE_VALUE_MAX_TX_BYTES,
        ACCOUNT_MAX_TX_BYTES,
        CONTRACT_MAX_TX_BYTES,
        USER_ACCOUNT_UPDATE_MAX_TX_BYTES,
    ] {
        assert!(per_kind < MAX_TX_BYTES);
    }
}

/// A 4-in / 5-out transfer — one envelope chain ID, 16 serialized verifier
/// inputs, the pinned proof, five `OUTPUT_DATA_BYTES` items, and the arena —
/// serializes to exactly `private_value_tx_bytes(S)` and parses through
/// framing and transaction decoding.
#[test]
fn private_value_serialization_equals_its_pinned_size_and_parses() {
    let size = 1
        + 4
        + 1
        + PRIVATE_VALUE_WIRE_INPUTS * 32
        + WIRE_PROOF_BYTES
        + 5 * OUTPUT_DATA_BYTES
        + S.arena_bytes;
    assert_eq!(size, private_value_tx_bytes(PrivateValueShape::S));
    assert_eq!(size, 31_647);

    let mut pis: Vec<CircuitWord> = (0..PRIVATE_VALUE_PUBLIC_INPUTS as u64).map(word).collect();
    pis[0] = word(u64::from(PCASH_CHAIN_ID));
    let proof = vec![0xab; WIRE_PROOF_BYTES];
    let output_data = vec![0xcd; OUTPUT_DATA_BYTES];
    let tx = transfer_txbytes(&pis, &proof, &[output_data.as_slice(); 5]);
    assert_eq!(tx.len(), size);
    assert!(tx.len() <= MAX_TX_BYTES, "and fits the framing ceiling");

    let cd = batch(&[tx]);
    let items = Batch::decode(&cd).expect("transfer batch parses").items;
    assert_eq!(items.len(), 1);
    match decode(items[0]).expect("transfer item decodes") {
        Transaction::PrivateValue(p) => {
            assert_eq!(p.public_inputs().len(), PRIVATE_VALUE_PUBLIC_INPUTS);
            assert_eq!(p.proof.len(), WIRE_PROOF_BYTES);
            assert_eq!(p.output_data().len(), 5);
            assert!(p.output_data().iter().all(|e| e.as_slice() == output_data));
        }
        _ => panic!("expected transfer"),
    }
}

/// A sponsored contract account carrying both optional fields and all 255
/// function slots reaches the per-kind contract maximum exactly, stays under
/// the fixed `MAX_TX_BYTES` bound, and remains parseable.
#[test]
fn max_contract_account_serialization_equals_kind_max_and_parses() {
    let mut body = vec![1]; // publishesNkRoot
    body.extend_from_slice(word(0xdd).as_slice()); // nkRoot
    body.push(1); // receiveKeyMode
    body.extend_from_slice(&[0xcc; ML_KEM768_PUBLIC_KEY_LEN]);
    body.push(u8::MAX); // functionCount
    for selector in 0..u8::MAX {
        body.push(selector);
        body.extend_from_slice(word(u64::from(selector) + 1).as_slice());
        body.extend_from_slice(word(u64::from(selector) + 2).as_slice());
    }
    assert_eq!(body.len(), CONTRACT_MAX_BODY_BYTES);

    let output_data = vec![0xcd; OUTPUT_DATA_BYTES];
    let mut pis: Vec<CircuitWord> = (0..PRIVATE_VALUE_PUBLIC_INPUTS as u64).map(word).collect();
    pis[0] = word(u64::from(PCASH_CHAIN_ID));
    let section = private_value_section(
        &pis,
        &vec![0xab; WIRE_PROOF_BYTES],
        &[output_data.as_slice(); 5],
    );
    let tx = sponsored_contract_txbytes(&body, &section);
    assert_eq!(tx.len(), CONTRACT_MAX_TX_BYTES);
    assert!(tx.len() <= MAX_TX_BYTES);
    match decode(&tx).expect("maximum contract creation decodes") {
        Transaction::ContractAccountCreation(creation) => {
            assert!(creation.body.receive_key.is_some());
            assert!(creation.body.publishes_nk_root);
            assert_eq!(creation.body.functions.len(), usize::from(u8::MAX));
            let ContractFunding::Sponsored(section) = &creation.funding else {
                panic!("sponsored funding")
            };
            assert_eq!(section.public_inputs().len(), PRIVATE_VALUE_PUBLIC_INPUTS);
            assert_eq!(section.proof.len(), WIRE_PROOF_BYTES);
        }
        _ => panic!("expected contract"),
    }

    // A section without its body, or a body without its section, is
    // truncated.
    let section_end = 1 + 4 + 1 + section.len();
    assert_eq!(decode(&tx[..section_end]), Err(ParseError::Truncated));
    let mut bare_body = tx[..6].to_vec();
    bare_body.extend_from_slice(&body);
    assert_eq!(decode(&bare_body), Err(ParseError::Truncated));
}

/// An item one byte over `MAX_TX_BYTES` remains framed so admission can reject
/// that item without discarding its siblings.
#[test]
fn item_over_max_tx_bytes_remains_individually_framed() {
    let oversize = vec![0u8; MAX_TX_BYTES + 1];
    let cd = batch(&[oversize]);
    let items = Batch::decode(&cd)
        .expect("oversized item keeps trusted boundaries")
        .items;
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].len(), MAX_TX_BYTES + 1);
}

#[test]
fn account_authorization_modes_have_exact_distinct_encodings() {
    let signed = account_txbytes(word(7), word(8), None, word(9), 1000, word(10), word(11), 0);
    assert!(matches!(
        decode(&signed).unwrap(),
        Transaction::UserAccountCreation(UserAccountCreation {
            authorization: AccountCreationAuthorization::Eip712 { .. },
            ..
        })
    ));
    let mut direct = signed[..signed.len() - 65].to_vec();
    direct[5] = 0;
    assert!(matches!(
        decode(&direct).unwrap(),
        Transaction::UserAccountCreation(UserAccountCreation {
            authorization: AccountCreationAuthorization::DirectL1,
            ..
        })
    ));
    assert_eq!(signed.len() - direct.len(), 65);
    let mut unknown = direct.clone();
    unknown[5] = 2;
    assert_eq!(
        decode(&unknown),
        Err(ParseError::UnknownAuthorizationMode(2))
    );
    let mut direct_with_signature = signed.clone();
    direct_with_signature[5] = 0;
    assert_eq!(decode(&direct_with_signature), Err(ParseError::Trailing));
    let mut signed_without_signature = direct;
    signed_without_signature[5] = 1;
    assert_eq!(
        decode(&signed_without_signature),
        Err(ParseError::Truncated)
    );
    let mut no_mode = signed;
    no_mode.remove(5);
    assert!(decode(&no_mode).is_err());
}

#[test]
fn private_value_shape_is_explicit_and_l_keeps_every_late_slot() {
    let shape = PrivateValueShape::L;
    let profile = shape.profile();
    let mut pis: Vec<CircuitWord> = (0..profile.public_inputs as u64).map(word).collect();
    pis[0] = word(u64::from(PCASH_CHAIN_ID));
    let data: Vec<Vec<u8>> = (0..profile.outputs)
        .map(|i| vec![i as u8; OUTPUT_DATA_BYTES])
        .collect();
    pis[profile.delivery_commitment_offset] =
        delivery_commitment_word(&slices(&data), &dummy_arena(shape));
    let proof = vec![0xab; pcash_derive::params::WIRE_PROOF_BYTES];
    let raw = profile_txbytes(shape, &pis, &proof, &slices(&data));
    assert_eq!(raw.len(), PRIVATE_VALUE_MAX_TX_BYTES);
    let Transaction::PrivateValue(section) = decode(&raw).unwrap() else {
        panic!("private value");
    };
    assert_eq!(section.shape(), shape);
    assert_eq!(section.public_inputs(), pis);
    assert_eq!(
        section
            .output_data()
            .iter()
            .map(|data| data.as_slice())
            .collect::<Vec<_>>(),
        slices(&data)
    );
    assert_eq!(section.proof, proof);
    assert_eq!(section.arena(), dummy_arena(shape));
    let mut unknown = raw.clone();
    unknown[5] = 2;
    assert_eq!(
        decode(&unknown).err(),
        Some(ParseError::UnknownPrivateValueShape(2))
    );
    assert_eq!(
        decode(&raw[..raw.len() - 1]).err(),
        Some(ParseError::Truncated)
    );
    let mut wrong_shape = raw;
    wrong_shape[5] = PrivateValueShape::S as u8;
    assert!(decode(&wrong_shape).is_err());
}
