//! Every stored consensus type has one byte encoding, pinned here against
//! bytes written out by hand.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions"
)]

use pcash_state::{
    AcceptedEffects, AccountField, AccountKindDetail, AccountResult, AccountState, AccountWrite,
    Address, BatchExclusionReason, BlockEconomics, BlockHeader, CanonicalBlockHistory, CarrierType,
    Codec, ContractField, DecodeError, DerivationSource, FailureDetail, FailureDetailSeed, Fr,
    ItemExclusionReason, L1DeliveryBatch, L1DeliveryItem, L1LogLeaf, L1Origin, PayoutComponent,
    PayoutIntent, PayoutRecord, PayoutSource, PersistedCheckpoint, ReceiveKeyOperation,
    RejectedEffects, StateComponents, StoredBlock, TransactionEffects, TransactionOutcome,
    TransactionResult, B256, I256, U256,
};
use std::fmt::Debug;

fn cat(parts: &[&[u8]]) -> Vec<u8> {
    parts.concat()
}

fn h(byte: u8) -> [u8; 32] {
    [byte; 32]
}

fn hash(byte: u8) -> B256 {
    B256::repeat_byte(byte)
}

fn u64be(value: u64) -> [u8; 8] {
    value.to_be_bytes()
}

/// A 32-byte big-endian word holding `value`.
fn word(value: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&value.to_be_bytes());
    out
}

/// `value` has exactly the bytes `expected`, in both directions, and no other
/// length of them decodes.
#[track_caller]
fn assert_frozen<T: Codec + PartialEq + Debug>(value: &T, expected: &[u8]) {
    assert_eq!(value.encode(), expected);
    assert_eq!(&T::decode(expected).unwrap(), value);
    for length in 0..expected.len() {
        assert!(
            T::decode(&expected[..length]).is_err(),
            "prefix of {length} bytes decoded"
        );
    }
    assert_eq!(
        T::decode(&[expected, &[0]].concat()),
        Err(DecodeError::Trailing)
    );
}

fn result() -> TransactionResult {
    TransactionResult {
        tx_type: 2,
        account_creation: 1,
        l1_transaction_index: 3,
        batch_item_index: 2,
        outcome: TransactionOutcome::NullifierAlreadySpent,
        poster_owner_commitment: hash(0x0a),
        output_start_index: 40,
        statement_hash: hash(0x0b),
    }
}

fn result_bytes() -> Vec<u8> {
    cat(&[
        &[0x02, 0x01],
        &u64be(3),
        &u64be(2),
        &[0x00, 0x07],
        &h(0x0a),
        &u64be(40),
        &h(0x0b),
    ])
}

fn header() -> BlockHeader {
    BlockHeader {
        parent_hash: hash(0x01),
        number: 0x0102_0304_0506_0708,
        timestamp: 9,
        transaction_results_root: hash(0x02),
        state_root: hash(0x03),
        l1_origin_root: hash(0x04),
        history_root: hash(0x05),
    }
}

fn header_bytes() -> Vec<u8> {
    cat(&[
        &h(0x01),
        &[1, 2, 3, 4, 5, 6, 7, 8],
        &u64be(9),
        &h(0x02),
        &h(0x03),
        &h(0x04),
        &h(0x05),
    ])
}

fn origin() -> L1Origin {
    L1Origin {
        block_number: 100,
        block_hash: hash(0x31),
        block_timestamp: 200,
        l1_logs_root: hash(0x32),
        l1_log_count: 5,
    }
}

fn origin_bytes() -> Vec<u8> {
    cat(&[&u64be(100), &h(0x31), &u64be(200), &h(0x32), &u64be(5)])
}

#[test]
fn block_layouts_are_frozen() {
    assert_frozen(&result(), &result_bytes());
    assert_eq!(result_bytes().len(), 92);
    assert_frozen(&header(), &header_bytes());
    assert_eq!(header_bytes().len(), 176);
    assert_frozen(&origin(), &origin_bytes());
    assert_eq!(origin_bytes().len(), 88);

    let state = StateComponents {
        output_root: hash(0x51),
        output_count: 3,
        issuance: pcash_issuance::IssuanceState {
            issued_so_far: U256::from(9u64),
            lag_q: I256::MINUS_ONE,
        },
        account_state_root: hash(0x52),
        account_count: 4,
        nullifier_root: hash(0x53),
        nullifier_count: 5,
    };
    let state_bytes = cat(&[
        &h(0x51),
        &u64be(3),
        &word(9),
        &h(0xff),
        &h(0x52),
        &u64be(4),
        &h(0x53),
        &u64be(5),
    ]);
    assert_frozen(&state, &state_bytes);
    assert_eq!(state_bytes.len(), 184);

    let block = StoredBlock {
        header: header(),
        hash: hash(0x41),
        l1_origin: origin(),
        state,
    };
    let block_bytes = cat(&[&header_bytes(), &h(0x41), &origin_bytes(), &state_bytes]);
    assert_frozen(&block, &block_bytes);
    assert_eq!(block_bytes.len(), 480);

    assert_frozen(
        &vec![result(), result()],
        &cat(&[&u64be(2), &result_bytes(), &result_bytes()]),
    );
    assert_frozen(&Vec::<TransactionResult>::new(), &u64be(0));
}

#[test]
fn checkpoint_layout_is_frozen() {
    assert_frozen(
        &PersistedCheckpoint {
            finalized_l1_block: 100,
            finalized_l1_hash: hash(0x61),
            pcash_block_number: 2,
            pcash_block_hash: hash(0x62),
            pcash_block_timestamp: 300,
            fork_schedule_prefix_hash: hash(0x63),
            savepoint_id: 7,
        },
        &cat(&[
            &u64be(100),
            &h(0x61),
            &u64be(2),
            &h(0x62),
            &u64be(300),
            &h(0x63),
            &u64be(7),
        ]),
    );
}

#[test]
fn transaction_outcomes_encode_their_protocol_discriminant() {
    for (outcome, discriminant) in [
        (TransactionOutcome::Succeeded, 0u16),
        (TransactionOutcome::PublicInputNotInField, 1),
        (TransactionOutcome::RecentPcashBlockNotInWindow, 2),
        (TransactionOutcome::Expired, 3),
        (TransactionOutcome::NotYetValid, 4),
        (TransactionOutcome::ZeroNullifier, 5),
        (TransactionOutcome::DuplicateInputNullifier, 6),
        (TransactionOutcome::NullifierAlreadySpent, 7),
        (TransactionOutcome::ProofRejected, 8),
        (TransactionOutcome::OutputCapacity, 9),
        (TransactionOutcome::AccountCapacity, 10),
        (TransactionOutcome::InvalidAccountSignature, 11),
        (TransactionOutcome::AccountNotFound, 12),
        (TransactionOutcome::AccountAlreadyExists, 13),
        (TransactionOutcome::AccountRevisionExhausted, 14),
        (TransactionOutcome::WrongAccountKind, 15),
        (TransactionOutcome::ClearWithoutReceiveKey, 16),
        (TransactionOutcome::ReplaceWithIdenticalReceiveKey, 17),
        (TransactionOutcome::AccountUpdateCommitmentMismatch, 18),
        (TransactionOutcome::NonCanonicalAccountField, 19),
        (TransactionOutcome::ContractAddressExists, 20),
        (TransactionOutcome::NonCanonicalContractField, 21),
        (TransactionOutcome::EmptyContractFunctionSet, 22),
        (TransactionOutcome::SelectorsNotStrictlyIncreasing, 23),
        (TransactionOutcome::CarrierContextMismatch, 24),
        (TransactionOutcome::AccountCreationMismatch, 25),
    ] {
        assert_frozen(&outcome, &discriminant.to_be_bytes());
    }
    assert_eq!(
        TransactionOutcome::decode(&26u16.to_be_bytes()),
        Err(DecodeError::Invalid("TransactionOutcome"))
    );
}

fn item() -> L1DeliveryItem {
    L1DeliveryItem {
        batch_item_index: 1,
        content_hash: hash(0x51),
        byte_offset: 67,
        byte_length: 300,
        exclusion_reason: None,
    }
}

fn item_bytes() -> Vec<u8> {
    cat(&[&u64be(1), &h(0x51), &u64be(67), &u64be(300), &[0]])
}

fn delivery() -> L1DeliveryBatch {
    L1DeliveryBatch {
        l1_transaction_index: 4,
        l1_transaction_hash: hash(0x62),
        l1_sender: Address::repeat_byte(0x63),
        carrier_type: CarrierType::Blob,
        carrier_hash: hash(0x64),
        carrier_length: 1_000,
        blob_versioned_hashes: vec![hash(0x65)],
        poster_owner_commitment: Some(hash(0x66)),
        poster_context: None,
        exclusion_reason: Some(BatchExclusionReason::TrailingBatchBytes),
        first_batch_item_index: 1,
        items: vec![item()],
    }
}

fn delivery_bytes() -> Vec<u8> {
    cat(&[
        &u64be(4),
        &h(0x62),
        &[0x63; 20],
        &[1],
        &h(0x64),
        &u64be(1_000),
        &u64be(1),
        &h(0x65),
        &[1],
        &h(0x66),
        &[0],
        &[1, 7],
        &u64be(1),
        &u64be(1),
        &item_bytes(),
    ])
}

fn designated() -> PayoutRecord {
    PayoutRecord {
        source: PayoutSource::DesignatedIssuance {
            l1_transaction_index: 4,
            batch_item_index: 1,
        },
        component: PayoutComponent::Issuance,
        amount: U256::from(20u64),
        owner_commitment: hash(0x71),
        output_index: 8,
        contexts: vec![hash(0x72)],
    }
}

fn designated_bytes() -> Vec<u8> {
    cat(&[
        &[0],
        &u64be(4),
        &u64be(1),
        &[1],
        &word(20),
        &h(0x71),
        &u64be(8),
        &u64be(1),
        &h(0x72),
    ])
}

fn economics() -> BlockEconomics {
    BlockEconomics {
        open_fees_total: U256::from(1u64),
        issuance_total: U256::from(2u64),
        qualifying_actions: 3,
        reward_each: U256::from(4u64),
        baseline: U256::from(5u64),
        internal_offer: U256::from(6u64),
        block_allowance: U256::from(7u64),
    }
}

fn economics_bytes() -> Vec<u8> {
    cat(&[
        &word(1),
        &word(2),
        &u64be(3),
        &word(4),
        &word(5),
        &word(6),
        &word(7),
    ])
}

#[test]
fn history_layouts_are_frozen() {
    assert_frozen(&item(), &item_bytes());
    let excluded = L1DeliveryItem {
        exclusion_reason: Some(ItemExclusionReason::WrongChainId),
        ..item()
    };
    assert_frozen(
        &excluded,
        &cat(&[&u64be(1), &h(0x51), &u64be(67), &u64be(300), &[1, 11]]),
    );
    assert_frozen(&delivery(), &delivery_bytes());

    assert_frozen(&designated(), &designated_bytes());
    let poster = PayoutRecord {
        source: PayoutSource::PosterPayout {
            l1_transaction_indices: vec![4, 9],
        },
        component: PayoutComponent::OpenFee,
        contexts: vec![],
        ..designated()
    };
    assert_frozen(
        &poster,
        &cat(&[
            &[1],
            &u64be(2),
            &u64be(4),
            &u64be(9),
            &[0],
            &word(20),
            &h(0x71),
            &u64be(8),
            &u64be(0),
        ]),
    );

    assert_frozen(&economics(), &economics_bytes());
    let history = CanonicalBlockHistory {
        l1_delivery_batches: vec![delivery()],
        economics: economics(),
        payouts: vec![designated()],
    };
    assert_frozen(
        &history,
        &cat(&[
            &u64be(1),
            &delivery_bytes(),
            &economics_bytes(),
            &u64be(1),
            &designated_bytes(),
        ]),
    );
    assert_frozen(
        &CanonicalBlockHistory::default(),
        &cat(&[&u64be(0), &[0u8; 6 * 32 + 8], &u64be(0)]),
    );
}

#[test]
fn enum_tags_are_frozen() {
    assert_frozen(&CarrierType::Calldata, &[0]);
    assert_frozen(&CarrierType::Blob, &[1]);
    assert_frozen(
        &CarrierType::Event {
            log_index: 3,
            emitter: Address::repeat_byte(0x44),
            context: Some(vec![5, 6]),
        },
        &cat(&[&[2], &u64be(3), &[0x44; 20], &[1], &u64be(2), &[5, 6]]),
    );
    assert_frozen(
        &CarrierType::Event {
            log_index: 0,
            emitter: Address::repeat_byte(0x44),
            context: None,
        },
        &cat(&[&[2], &u64be(0), &[0x44; 20], &[0]]),
    );
    assert_eq!(
        CarrierType::decode(&[3]),
        Err(DecodeError::Invalid("CarrierType"))
    );
    assert_frozen(&PayoutComponent::OpenFee, &[0]);
    assert_frozen(&PayoutComponent::Issuance, &[1]);
    assert_eq!(
        PayoutComponent::decode(&[2]),
        Err(DecodeError::Invalid("PayoutComponent"))
    );

    for (reason, tag) in [
        (BatchExclusionReason::UnsupportedCarrierEncoding, 0u8),
        (BatchExclusionReason::InvalidCarrierEncoding, 1),
        (BatchExclusionReason::UnsupportedBatchVersion, 2),
        (BatchExclusionReason::InvalidPosterOwnerCommitment, 3),
        (BatchExclusionReason::InvalidPosterContext, 4),
        (BatchExclusionReason::BatchCountLimit, 5),
        (BatchExclusionReason::TruncatedFraming, 6),
        (BatchExclusionReason::TrailingBatchBytes, 7),
    ] {
        assert_frozen(&reason, &[tag]);
    }
    assert!(BatchExclusionReason::decode(&[8]).is_err());

    for (reason, tag) in [
        (ItemExclusionReason::ItemTooLarge, 0u8),
        (ItemExclusionReason::Empty, 1),
        (ItemExclusionReason::UnknownKind, 2),
        (ItemExclusionReason::UnknownPrivateValueShape, 3),
        (ItemExclusionReason::UnknownAuthorizationMode, 4),
        (ItemExclusionReason::UnknownAccountCreationTag, 5),
        (ItemExclusionReason::UnknownReceiveKeyMode, 6),
        (ItemExclusionReason::UnknownPublishesNkRootFlag, 7),
        (ItemExclusionReason::UnknownYParity, 8),
        (ItemExclusionReason::Truncated, 9),
        (ItemExclusionReason::TrailingBytes, 10),
        (ItemExclusionReason::WrongChainId, 11),
        (ItemExclusionReason::DirectModeOutsideInbox, 12),
        (ItemExclusionReason::DirectCreationAttachment, 13),
    ] {
        assert_frozen(&reason, &[tag]);
    }
    assert!(ItemExclusionReason::decode(&[14]).is_err());

    assert_frozen(&AccountField::NullifierKeyCommitment, &[0]);
    assert_frozen(&AccountField::RuleSetCommitment, &[1]);
    assert_frozen(&ContractField::NullifierKeyMaterial, &[0]);
    assert_frozen(&ContractField::ApplicationVkHash, &[1]);
    assert_frozen(&ContractField::ConfigurationCommitment, &[2]);
    assert_frozen(&AccountKindDetail::User, &[0]);
    assert_frozen(&AccountKindDetail::Contract, &[1]);
    assert_frozen(&ReceiveKeyOperation::Keep, &[0]);
    assert_frozen(&ReceiveKeyOperation::Clear, &[1]);
    assert_frozen(&ReceiveKeyOperation::Replace, &[2]);
    assert!(ReceiveKeyOperation::decode(&[3]).is_err());
}

fn accepted() -> AcceptedEffects {
    AcceptedEffects {
        kind: 2,
        output_leaf_start: Some(40),
        output_commitments: vec![hash(0x81), hash(0x82)],
        nullifiers: vec![hash(0x83)],
        account: Some(AccountResult::User {
            address: Address::repeat_byte(0x84),
            revision: 3,
            receive_key: ReceiveKeyOperation::Replace,
            prior_state: Some(Box::new(AccountState {
                index: 9,
                revision: 2,
                nullifier_key_commitment: Fr::from(0x87u64),
                account_rule_set_commitment: Fr::from(0x88u64),
                kind: 0,
                receive_key_hash: B256::from(word(0x89)),
            })),
        }),
        payout: Some(PayoutIntent {
            open_fee_amount: U256::from(11u64),
            issuance_owner_commitment: Fr::from(0x85u64),
            context: hash(0x86),
        }),
    }
}

fn accepted_bytes() -> Vec<u8> {
    cat(&[
        &[2],
        &[1],
        &u64be(40),
        &u64be(2),
        &h(0x81),
        &h(0x82),
        &u64be(1),
        &h(0x83),
        &[1, 0],
        &[0x84; 20],
        &[0, 0, 0, 3],
        &[2],
        &[1],
        &u64be(9),
        &[0, 0, 0, 2],
        &word(0x87),
        &word(0x88),
        &[0],
        &word(0x89),
        &[1],
        &word(11),
        &word(0x85),
        &h(0x86),
    ])
}

#[test]
fn effects_layouts_are_frozen() {
    assert_frozen(&accepted(), &accepted_bytes());
    assert_frozen(
        &TransactionEffects::Accepted(accepted()),
        &cat(&[&[0], &accepted_bytes()]),
    );
    assert_frozen(
        &AccountResult::User {
            address: Address::repeat_byte(0x90),
            revision: 1,
            receive_key: ReceiveKeyOperation::Clear,
            prior_state: None,
        },
        &cat(&[&[0], &[0x90; 20], &[0, 0, 0, 1], &[1], &[0]]),
    );
    assert_frozen(
        &AccountResult::Contract {
            address: Address::repeat_byte(0x91),
            nullifier_key_commitment: hash(0x92),
            function_set_commitment: hash(0x93),
        },
        &cat(&[&[1], &[0x91; 20], &h(0x92), &h(0x93)]),
    );

    let rejected =
        |account, detail| TransactionEffects::Rejected(RejectedEffects { account, detail });
    assert_frozen(&rejected(None, None), &[1, 0, 0]);
    assert_frozen(
        &rejected(
            None,
            Some(FailureDetailSeed::NullifierAlreadySpent {
                input_slot: 2,
                nullifier: hash(0x94),
            }),
        ),
        &cat(&[&[1, 0, 1, 1], &[0, 2], &h(0x94)]),
    );
    // A complete detail is tagged with the outcome it explains.
    assert_frozen(
        &rejected(
            None,
            Some(FailureDetailSeed::Complete(
                FailureDetail::AccountAlreadyExists {
                    address: Address::repeat_byte(0x95),
                    existing_revision: 6,
                },
            )),
        ),
        &cat(&[&[1, 0, 1, 0], &[0, 13], &[0x95; 20], &[0, 0, 0, 6]]),
    );
    // The account precedes the detail.
    assert_frozen(
        &rejected(
            Some(Address::repeat_byte(0x97)),
            Some(FailureDetailSeed::Complete(
                FailureDetail::AccountAlreadyExists {
                    address: Address::repeat_byte(0x97),
                    existing_revision: 7,
                },
            )),
        ),
        &cat(&[
            &[1, 1],
            &[0x97; 20],
            &[1, 0],
            &[0, 13],
            &[0x97; 20],
            &[0, 0, 0, 7],
        ]),
    );
    assert!(TransactionEffects::decode(&[2]).is_err());
    assert!(FailureDetailSeed::decode(&[2]).is_err());
    // An outcome that carries no detail is not a detail tag.
    assert_eq!(
        FailureDetail::decode(&TransactionOutcome::ProofRejected.as_u16().to_be_bytes()),
        Err(DecodeError::Invalid("FailureDetail"))
    );

    assert_frozen(
        &L1LogLeaf {
            transaction_index: 1,
            log_index: 2,
            leaf: hash(0x96),
        },
        &cat(&[&u64be(1), &u64be(2), &h(0x96)]),
    );
}

fn address(byte: u8) -> Address {
    Address::repeat_byte(byte)
}

/// Each detail's tag is the `u16` discriminant of the outcome it explains.
#[test]
fn failure_detail_layouts_are_frozen() {
    assert_frozen(
        &FailureDetail::PublicInputNotInField {
            public_input_index: 4,
            supplied: hash(0x0a),
        },
        &cat(&[&[0, 1], &[0, 4], &h(0x0a)]),
    );
    assert_frozen(
        &FailureDetail::RecentPcashBlockNotInWindow {
            referenced_block_hash: hash(0x0a),
            window_start_timestamp: 1,
            window_end_timestamp: 2,
        },
        &cat(&[&[0, 2], &h(0x0a), &u64be(1), &u64be(2)]),
    );
    assert_frozen(
        &FailureDetail::Expired {
            valid_until: U256::from(9u64),
            block_timestamp: 1,
        },
        &cat(&[&[0, 3], &word(9), &u64be(1)]),
    );
    assert_frozen(
        &FailureDetail::NotYetValid {
            not_before: U256::from(9u64),
            block_timestamp: 1,
        },
        &cat(&[&[0, 4], &word(9), &u64be(1)]),
    );
    assert_frozen(
        &FailureDetail::ZeroNullifier { input_slot: 1 },
        &cat(&[&[0, 5], &[0, 1]]),
    );
    assert_frozen(
        &FailureDetail::DuplicateInputNullifier {
            first_input_slot: 1,
            duplicate_input_slot: 2,
            nullifier: hash(0x0a),
        },
        &cat(&[&[0, 6], &[0, 1], &[0, 2], &h(0x0a)]),
    );
    assert_frozen(
        &FailureDetail::NullifierAlreadySpent {
            input_slot: 1,
            nullifier: hash(0x0a),
            spending_transaction_id: hash(0x0b),
        },
        &cat(&[&[0, 7], &[0, 1], &h(0x0a), &h(0x0b)]),
    );
    assert_frozen(
        &FailureDetail::OutputCapacity {
            requested_count: 2,
            limit: 1,
        },
        &cat(&[&[0, 9], &u64be(2), &u64be(1)]),
    );
    assert_frozen(
        &FailureDetail::AccountCapacity {
            requested_count: 2,
            limit: 1,
        },
        &cat(&[&[0, 10], &u64be(2), &u64be(1)]),
    );
    assert_frozen(
        &FailureDetail::AccountNotFound {
            address: address(0xa1),
        },
        &cat(&[&[0, 12], &[0xa1; 20]]),
    );
    assert_frozen(
        &FailureDetail::AccountAlreadyExists {
            address: address(0xa1),
            existing_revision: 6,
        },
        &cat(&[&[0, 13], &[0xa1; 20], &[0, 0, 0, 6]]),
    );
    assert_frozen(
        &FailureDetail::AccountRevisionExhausted {
            address: address(0xa1),
            revision: u32::MAX,
        },
        &cat(&[&[0, 14], &[0xa1; 20], &[0xff; 4]]),
    );
    assert_frozen(
        &FailureDetail::WrongAccountKind {
            address: address(0xa1),
            expected: AccountKindDetail::User,
            actual: AccountKindDetail::Contract,
        },
        &cat(&[&[0, 15], &[0xa1; 20], &[0], &[1]]),
    );
    assert_frozen(
        &FailureDetail::ClearWithoutReceiveKey {
            address: address(0xa1),
        },
        &cat(&[&[0, 16], &[0xa1; 20]]),
    );
    assert_frozen(
        &FailureDetail::ReplaceWithIdenticalReceiveKey {
            address: address(0xa1),
            receive_key_hash: hash(0x0a),
        },
        &cat(&[&[0, 17], &[0xa1; 20], &h(0x0a)]),
    );
    assert_frozen(
        &FailureDetail::AccountUpdateCommitmentMismatch {
            expected: hash(0x0a),
            supplied: hash(0x0b),
        },
        &cat(&[&[0, 18], &h(0x0a), &h(0x0b)]),
    );
    assert_frozen(
        &FailureDetail::NonCanonicalAccountField {
            field: AccountField::RuleSetCommitment,
            supplied: hash(0x0a),
        },
        &cat(&[&[0, 19], &[1], &h(0x0a)]),
    );
    assert_frozen(
        &FailureDetail::ContractAddressExists {
            address: address(0xa1),
        },
        &cat(&[&[0, 20], &[0xa1; 20]]),
    );
    assert_frozen(
        &FailureDetail::NonCanonicalContractField {
            field: ContractField::ApplicationVkHash,
            function_index: Some(3),
            supplied: hash(0x0a),
        },
        &cat(&[&[0, 21], &[1], &[1], &[0, 3], &h(0x0a)]),
    );
    assert_frozen(
        &FailureDetail::NonCanonicalContractField {
            field: ContractField::ConfigurationCommitment,
            function_index: None,
            supplied: hash(0x0a),
        },
        &cat(&[&[0, 21], &[2], &[0], &h(0x0a)]),
    );
    assert_frozen(
        &FailureDetail::SelectorsNotStrictlyIncreasing {
            previous_function_index: 1,
            previous_selector: 5,
            function_index: 2,
            selector: 6,
        },
        &cat(&[&[0, 23], &[0, 1], &[5], &[0, 2], &[6]]),
    );
    assert_frozen(
        &FailureDetail::CarrierContextMismatch {
            required: hash(0x0a),
            carrier: hash(0x0b),
        },
        &cat(&[&[0, 24], &h(0x0a), &h(0x0b)]),
    );
}

fn account() -> AccountState {
    AccountState {
        index: 0x0102_0304_0506,
        revision: 7,
        nullifier_key_commitment: Fr::from(11u64),
        account_rule_set_commitment: Fr::from(12u64),
        kind: 1,
        receive_key_hash: hash(0x13),
    }
}

fn account_bytes() -> Vec<u8> {
    cat(&[
        &[0, 0, 1, 2, 3, 4, 5, 6],
        &[0, 0, 0, 7],
        &word(11),
        &word(12),
        &[1],
        &h(0x13),
    ])
}

#[test]
fn account_layouts_are_frozen() {
    assert_frozen(&account(), &account_bytes());
    assert_eq!(account_bytes().len(), 109);

    let address = Address::repeat_byte(0x41);
    assert_frozen(
        &AccountWrite {
            address,
            account: account(),
            published_receive_key: None,
        },
        &cat(&[&[0x41; 20], &account_bytes(), &[0]]),
    );
    assert_frozen(
        &AccountWrite {
            address,
            account: account(),
            published_receive_key: Some(vec![0x5a, 0x5b, 0x5c]),
        },
        &cat(&[
            &[0x41; 20],
            &account_bytes(),
            &[1],
            &u64be(3),
            &[0x5a, 0x5b, 0x5c],
        ]),
    );

    // A flag is 0 or 1, and a field element is below the modulus.
    let bad_flag = cat(&[&[0x41; 20], &account_bytes(), &[2]]);
    assert_eq!(
        AccountWrite::decode(&bad_flag),
        Err(DecodeError::Invalid("flag"))
    );
    let mut outside_field = account_bytes();
    outside_field[12..44].fill(0xff);
    assert_eq!(
        AccountState::decode(&outside_field),
        Err(DecodeError::Invalid("field element"))
    );
}

#[test]
fn byte_arrays_are_their_bytes() {
    assert_frozen(&[0x5a_u8, 0x5b, 0x5c], &[0x5a, 0x5b, 0x5c]);
    assert_frozen(
        &vec![[0x01_u8; 2], [0x02; 2]],
        &cat(&[&u64be(2), &[1, 1, 2, 2]]),
    );
}

#[test]
fn source_layout_is_frozen() {
    assert_frozen(
        &DerivationSource {
            pcash_chain_id: 0x0102_0304,
            l1_chain_id: 5,
            inbox_address: Address::repeat_byte(0x06),
            genesis_l1_block: 7,
            genesis_l1_block_hash: hash(0x08),
        },
        &cat(&[&[1, 2, 3, 4], &u64be(5), &[0x06; 20], &u64be(7), &h(0x08)]),
    );
}
