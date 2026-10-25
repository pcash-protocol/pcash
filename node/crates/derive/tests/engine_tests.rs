#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]
//! Final-state derivation integration tests.

mod common;
use common::*;

use alloy_primitives::{Address, B256, U256};
use k256::ecdsa::SigningKey;
use pcash_derive::private_value_profiles::{PrivateValueShape, S};
use pcash_derive::{
    derive_block, user_account_update_commitment, BlockOutcome, DeriveError, ItemExclusionReason,
    SectionLayout, Transaction, UserAccountCreation, KIND_PRIVATE_VALUE, MAX_TX_BYTES,
    USER_ACCOUNT_UPDATE_PUBLIC_INPUTS, WIRE_PROOF_BYTES,
};
use pcash_state::{
    content_hash, fr_from_canonical_bytes, fr_to_bytes, transaction_id, transaction_results_root,
    transaction_statement_hash, AcceptedEffects, AccountField, AccountResult, CircuitWord,
    ContractField, FailureDetail, FailureDetailSeed, L1DeliveryItem, PayoutComponent, PayoutRecord,
    PayoutSource, ReceiveKeyOperation, RejectedEffects, StateDb, TransactionEffects,
    TransactionOutcome,
};
use pcash_verify::{CachedVerifier, Verifier, VerifyError};

const INBOX: fn() -> Address = || addr(0x5043_5348);

struct ExpectedVkVerifier {
    expected: Vec<u8>,
    expected_public_inputs: usize,
    calls: std::cell::Cell<usize>,
}

#[test]
fn failure_detail_wire_is_tagged_and_uses_rpc_quantities() {
    let detail = FailureDetail::Expired {
        valid_until: U256::from(16u64),
        block_timestamp: 17,
    };
    let value = serde_json::to_value(detail).unwrap();
    assert_eq!(value["type"], "expired");
    assert_eq!(value["validUntil"], "0x10");
    assert_eq!(value["blockTimestamp"], "0x11");
}

struct ExactStatementVerifier {
    expected_public_inputs: Vec<u8>,
    calls: std::cell::Cell<usize>,
}

impl Verifier for ExactStatementVerifier {
    fn verify(&self, _vk: &[u8], _proof: &[u8], public_inputs: &[u8]) -> Result<bool, VerifyError> {
        self.calls.set(self.calls.get() + 1);
        Ok(public_inputs == self.expected_public_inputs)
    }
}

impl Verifier for ExpectedVkVerifier {
    fn verify(&self, vk: &[u8], _proof: &[u8], public_inputs: &[u8]) -> Result<bool, VerifyError> {
        assert_eq!(vk, self.expected);
        assert_eq!(public_inputs.len(), self.expected_public_inputs * 32);
        self.calls.set(self.calls.get() + 1);
        Ok(true)
    }
}

fn initialize(rules: &pcash_derive::ProtocolRules) -> pcash_state::MemState {
    let mut state = mem_state(source(INBOX()));
    let block = block_with_txs(0, Vec::new());
    let outcome = derive_block(&mut state, &block, rules, &StubVerifier::accept()).unwrap();
    assert_eq!(outcome.committed_boundary.block.header.number, 0);
    assert_eq!(
        state.canonical_tip(),
        Some(pcash_state::StoredBlock::from(&outcome.committed_boundary))
    );
    state
}

/// The statement hash a successful result commits for these verifier inputs.
fn statement_hash_of_words(words: &[CircuitWord]) -> B256 {
    let fields: Vec<_> = words
        .iter()
        .map(|word| fr_from_canonical_bytes(*word).unwrap())
        .collect();
    fr_to_bytes(transaction_statement_hash(&fields))
}

fn address_word(address: Address) -> CircuitWord {
    let mut encoded = [0u8; 32];
    encoded[12..].copy_from_slice(address.as_slice());
    CircuitWord::from(encoded)
}

fn recent_pcash_block_hash(state: &impl StateDb) -> B256 {
    state
        .canonical_tip()
        .expect("fixtures initialize PCASH genesis")
        .hash
}

struct PrivateValueFixture {
    public_inputs: Vec<CircuitWord>,
    output_data: [Vec<u8>; 5],
}

/// A type `0x00` S transaction. A zero `designated` address selects the open
/// route; any other address is encoded as the designated issuance owner.
fn private_value_fixture(
    state: &impl StateDb,
    block_number: u64,
    nullifier_seed: u64,
    fee: u64,
    designated: Address,
) -> PrivateValueFixture {
    assert!(fee == 0 || designated == Address::ZERO);
    let output_data = std::array::from_fn(|_| DUMMY_OUTPUT_DATA.to_vec());
    let public_inputs = vec![
        word(u64::from(PCASH_CHAIN_ID)),
        recent_pcash_block_hash(state),
        tagged_word(0x03, nullifier_seed),
        tagged_word(0x04, nullifier_seed + 1),
        tagged_word(0x05, nullifier_seed + 2),
        tagged_word(0x06, nullifier_seed + 3),
        tagged_word(0x07, 0xb0d0),
        tagged_word(0x07, 0xb0d1),
        tagged_word(0x07, 0xb0d2),
        tagged_word(0x07, 0xb0d3),
        tagged_word(0x07, 0xb0d4),
        delivery_commitment_word(
            &output_data.each_ref().map(Vec::as_slice),
            &dummy_arena(PrivateValueShape::S),
        ),
        word(fee),
        address_word(designated),
        word(0),
        word(ts_of(block_number) + 120),
        CircuitWord::ZERO,
        tagged_word(0x10, nullifier_seed),
    ];
    PrivateValueFixture {
        public_inputs,
        output_data,
    }
}

fn private_value_bytes(fixture: &PrivateValueFixture) -> Vec<u8> {
    transfer_txbytes(
        &fixture.public_inputs,
        &stub_proof(
            SectionLayout::PrivateValue(PrivateValueShape::S),
            &[0xde; 64],
        ),
        &[
            &fixture.output_data[0],
            &fixture.output_data[1],
            &fixture.output_data[2],
            &fixture.output_data[3],
            &fixture.output_data[4],
        ],
    )
}

#[test]
fn raw_validation_uses_one_noncommitting_overlay() {
    let rules = stub_rules();
    let state = initialize(&rules);
    let fixture = private_value_fixture(&state, 1, 1, 0, Address::ZERO);
    let transaction = private_value_bytes(&fixture);
    let root_before = state.state_root();
    let head_before = recent_pcash_block_hash(&state);
    let verifier = StubVerifier::accept();

    let results = validate_raw_items(
        &state,
        &rules,
        &verifier,
        ts_of(1),
        addr(0xf00),
        &[transaction.clone(), transaction],
    )
    .unwrap();

    assert_eq!(
        results,
        vec![
            SUCCEEDED,
            ItemResult::Admitted(TransactionOutcome::NullifierAlreadySpent),
        ]
    );
    assert_eq!(verifier.calls.get(), 1);
    assert_eq!(state.state_root(), root_before);
    assert_eq!(recent_pcash_block_hash(&state), head_before);
    assert_eq!(state.output_count(), 0);
}

#[test]
fn output_data_mutation_changes_tx_id_and_the_reconstructed_proof_statement() {
    let rules = stub_rules();
    let state = initialize(&rules);
    let fixture = private_value_fixture(&state, 1, 7, 0, Address::ZERO);
    let original = private_value_bytes(&fixture);
    let verifier = ExactStatementVerifier {
        expected_public_inputs: fixture
            .public_inputs
            .iter()
            .flat_map(|word| word.iter().copied())
            .collect(),
        calls: std::cell::Cell::new(0),
    };

    assert_eq!(
        validate_raw_item(&state, &rules, &verifier, ts_of(1), addr(1), &original).unwrap(),
        SUCCEEDED
    );

    let mut changed_fixture = fixture;
    for offset in [0, 1] {
        changed_fixture.output_data[0][offset] ^= 0xff;
        let changed = private_value_bytes(&changed_fixture);
        assert_ne!(content_hash(&changed), content_hash(&original));
        assert_eq!(
            validate_raw_item(&state, &rules, &verifier, ts_of(1), addr(1), &changed).unwrap(),
            ItemResult::Admitted(TransactionOutcome::ProofRejected)
        );
        changed_fixture.output_data[0][offset] ^= 0xff;
    }
    assert_eq!(verifier.calls.get(), 3);
}

/// Output data is opaque to consensus, and proofs and output-data items carry
/// no length: the enclosing layout fixes both sizes. A section of any other
/// length does not decode, so the item is not admitted; a correctly sized
/// proof reaches the verifier, which alone decides `ProofRejected`.
#[test]
fn output_data_is_opaque_and_section_sizes_are_framing_for_every_proof_kind() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let signing_key = SigningKey::from_slice(&[0x31u8; 32]).unwrap();
    let address = signer_address(&signing_key);
    let creation = signed_account_transaction(
        &signing_key,
        INBOX(),
        tagged_word(0x06, 0xdddd),
        tagged_word(0x07, 1),
        None,
        recent_pcash_block_hash(&state),
        ts_of(0) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS,
    );
    derive_block(
        &mut state,
        &inbox_block(1, vec![batch(&[creation])]),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();

    let recent = recent_pcash_block_hash(&state);
    let deadline = ts_of(2) + 120;
    let proposed = tagged_word(0x07, 2);
    let action = user_account_update_commitment(
        address,
        &state.account_of(address).unwrap().unwrap(),
        field_element(proposed),
        B256::ZERO,
    );

    for first_byte in [0, 2, 255] {
        let mut data = DUMMY_OUTPUT_DATA;
        data[0] = first_byte;
        let small_commitment = uniform_delivery_commitment(PrivateValueShape::S, &data);
        let mut small = private_value_fixture(&state, 2, 0x60, 0, Address::ZERO);
        small.output_data = std::array::from_fn(|_| data.to_vec());
        small.public_inputs[S.delivery_commitment_offset] = small_commitment;

        let shape = PrivateValueShape::L;
        let profile = shape.profile();
        let (mut large_inputs, _) = large_fixture(&state, 10_000, 0);
        large_inputs[profile.delivery_commitment_offset] =
            uniform_delivery_commitment(shape, &data);
        large_inputs[profile.valid_until_offset] = word(deadline);
        let large = profile_txbytes(
            shape,
            &large_inputs,
            &stub_proof(SectionLayout::PrivateValue(shape), &[0xde; 64]),
            &vec![data.as_slice(); profile.outputs],
        );

        let mut fee_inputs = section_words(recent, 77, 1, Address::ZERO, 0, deadline);
        fee_inputs[S.delivery_commitment_offset] = small_commitment;
        let update = account_update_txbytes(
            address,
            proposed,
            pcash_derive::ReceiveKeyUpdate::Keep,
            action,
            &private_value_section(
                &fee_inputs,
                &vec![0u8; WIRE_PROOF_BYTES],
                &[data.as_slice(); 5],
            ),
        );
        let contract = contract_transaction(
            tagged_word(0x0c, 0x80),
            None,
            false,
            &sample_functions(),
            &private_value_section(
                &fee_inputs,
                &vec![0u8; WIRE_PROOF_BYTES],
                &[data.as_slice(); 5],
            ),
        );

        for (transaction, layout) in [
            (
                private_value_bytes(&small),
                SectionLayout::PrivateValue(PrivateValueShape::S),
            ),
            (large, SectionLayout::PrivateValue(PrivateValueShape::L)),
            (update, SectionLayout::UserAccountUpdate),
            (contract, SectionLayout::ContractAccountCreation),
        ] {
            // The section's words, then the carrying type's own input.
            let (words, output_count) =
                match Transaction::decode(&transaction, PCASH_CHAIN_ID).unwrap() {
                    Transaction::PrivateValue(section) => {
                        (section.public_inputs(), section.output_data().len())
                    }
                    Transaction::UserAccountUpdate(update) => {
                        let mut words = update.section.public_inputs();
                        words.push(update.account_update_commitment);
                        (words, update.section.output_data().len())
                    }
                    Transaction::ContractAccountCreation(contract) => {
                        let section = contract.section().unwrap();
                        let address = contract_body_check(&transaction).address().unwrap();
                        let mut words = section.public_inputs();
                        words.push(CircuitWord::left_padding_from(address.as_slice()));
                        (words, section.output_data().len())
                    }
                    Transaction::UserAccountCreation(_) => unreachable!(),
                };
            let expected_public_inputs = words.iter().flat_map(|word| word.to_vec()).collect();
            let verifier = ExactStatementVerifier {
                expected_public_inputs,
                calls: std::cell::Cell::new(0),
            };
            assert_eq!(
                validate_raw_item(&state, &rules, &verifier, ts_of(2), addr(1), &transaction)
                    .unwrap(),
                SUCCEEDED,
                "kind {} with first byte {first_byte}",
                transaction[0],
            );
            // A contract creation's body follows its section, which ends
            // with the arena.
            let section_end = match layout {
                SectionLayout::ContractAccountCreation => 6 + layout.section_bytes(),
                _ => transaction.len(),
            };
            let arena_offset = section_end - layout.shape().profile().arena_bytes;
            let first_data_offset = arena_offset - output_count * data.len();
            for offset in [first_data_offset, arena_offset, section_end - 1] {
                let mut changed = transaction.clone();
                changed[offset] ^= 0xff;
                assert_eq!(
                    validate_raw_item(&state, &rules, &verifier, ts_of(2), addr(1), &changed)
                        .unwrap(),
                    ItemResult::Admitted(TransactionOutcome::ProofRejected),
                    "{layout:?} at offset {offset}"
                );
            }
            let refusing = StubVerifier::reject();
            assert_eq!(
                validate_raw_item(&state, &rules, &refusing, ts_of(2), addr(1), &transaction)
                    .unwrap(),
                ItemResult::Admitted(TransactionOutcome::ProofRejected),
            );
            assert_eq!(refusing.calls.get(), 1);
            // One byte fewer or more in the proof, in the first output-data
            // item, or in the arena.
            let proof_offset = first_data_offset - layout.proof_bytes();
            for offset in [proof_offset, first_data_offset, arena_offset] {
                let mut short = transaction.clone();
                short.remove(offset);
                let mut long = transaction.clone();
                long.insert(offset, 0);
                for (resized, reason) in [
                    (short, ItemExclusionReason::Truncated),
                    (long, ItemExclusionReason::TrailingBytes),
                ] {
                    let result =
                        validate_raw_item(&state, &rules, &verifier, ts_of(2), addr(1), &resized)
                            .unwrap();
                    // A contract creation then reads its body from shifted
                    // bytes, which fails on whichever body field it misreads.
                    if section_end == transaction.len() {
                        assert_eq!(
                            result,
                            ItemResult::Excluded(reason),
                            "{layout:?} at offset {offset}"
                        );
                    } else {
                        assert!(
                            matches!(result, ItemResult::Excluded(_)),
                            "{layout:?} at offset {offset}: {result:?}"
                        );
                    }
                }
            }
            assert_eq!(verifier.calls.get(), 4);
            let block = inbox_block(2, vec![batch(&[transaction])]);
            let _prepared =
                pcash_derive::prepare_block(&block, &rules, &source(INBOX()), &verifier);
            assert_eq!(verifier.calls.get(), 5);
        }
    }
}

#[test]
fn raw_validation_rejects_oversize_and_untrusted_roots_before_verification() {
    let rules = stub_rules();
    let state = initialize(&rules);
    let verifier = StubVerifier::accept();
    assert_eq!(
        validate_raw_item(
            &state,
            &rules,
            &verifier,
            ts_of(1),
            addr(1),
            &vec![0u8; MAX_TX_BYTES + 1],
        )
        .unwrap(),
        ItemResult::Excluded(ItemExclusionReason::ItemTooLarge)
    );

    let mut fixture = private_value_fixture(&state, 1, 10, 0, Address::ZERO);
    fixture.public_inputs[1] = tagged_word(0x08, 0x9999);
    assert_eq!(
        validate_raw_item(
            &state,
            &rules,
            &verifier,
            ts_of(1),
            addr(1),
            &private_value_bytes(&fixture),
        )
        .unwrap(),
        ItemResult::Admitted(TransactionOutcome::RecentPcashBlockNotInWindow)
    );
    assert_eq!(verifier.calls.get(), 0);
}

#[test]
fn oversized_fees_reach_proof_verification_for_every_profile_in_raw_admission_and_derivation() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let hostile_fee = B256::from((U256::from(1) << 192usize).to_be_bytes::<32>());

    let mut small = private_value_fixture(&state, 1, 10, 0, Address::ZERO);
    small.public_inputs[PrivateValueShape::S.profile().open_fee_amount_offset] = hostile_fee;

    let shape = PrivateValueShape::L;
    let profile = shape.profile();
    let (mut large_inputs, _) = large_fixture(&state, 20, 0);
    large_inputs[profile.open_fee_amount_offset] = hostile_fee;
    let output_data = vec![DUMMY_OUTPUT_DATA.as_slice(); profile.outputs];
    let large = profile_txbytes(
        shape,
        &large_inputs,
        &stub_proof(SectionLayout::PrivateValue(shape), &[0xde; 64]),
        &output_data,
    );

    let transactions = [private_value_bytes(&small), large];
    // The payout reservation counts one fee note whatever the fee's size; the
    // proof's fee bound rejects it.
    let verifier = StubVerifier::reject();
    for raw in &transactions {
        assert_eq!(
            validate_raw_item(&state, &rules, &verifier, ts_of(1), addr(1), raw).unwrap(),
            ItemResult::Admitted(TransactionOutcome::ProofRejected)
        );
    }
    assert_eq!(verifier.calls.get(), 2);

    let block = block_with_batch(1, INBOX(), addr(1), batch(&transactions));
    let outcome = derive_block(&mut state, &block, &rules, &verifier).unwrap();
    assert_eq!(
        item_results(&outcome),
        vec![ItemResult::Admitted(TransactionOutcome::ProofRejected); 2]
    );
    assert!(outcome
        .transaction_effects
        .iter()
        .all(|effects| effects.accepted().is_none()));
    assert!(outcome.committed_boundary.history.payouts.is_empty());
    assert_eq!(state.state_components().output_count, 0);
}

#[test]
fn blob_carriers_must_be_resolved_while_mixed_carriers_are_ignored() {
    let rules = stub_rules();
    let mut versioned_hash = B256::ZERO;
    versioned_hash.0[0] = 1;

    let mut unresolved = block_with_batch(1, INBOX(), addr(1), Vec::new());
    unresolved.txs[0].0.blob_versioned_hashes = vec![versioned_hash];
    let mut state = initialize(&rules);
    assert!(matches!(
        derive_block(&mut state, &unresolved, &rules, &StubVerifier::accept()),
        Err(DeriveError::UnresolvedBlobCarrier { .. })
    ));

    let mut resolved = unresolved.clone();
    resolved.txs[0].0.blob_resolution = pcash_l1::BlobResolution::Batch(batch(&[]).into());
    let outcome = derive_block(&mut state, &resolved, &rules, &StubVerifier::accept()).unwrap();
    assert!(item_results(&outcome).is_empty());

    let mut mixed = block_with_batch(2, INBOX(), addr(1), batch(&[]));
    mixed.txs[0].0.blob_versioned_hashes = vec![versioned_hash];
    let outcome = derive_block(&mut state, &mixed, &rules, &StubVerifier::accept()).unwrap();
    assert!(item_results(&outcome).is_empty());
}

#[test]
fn unresolved_blob_after_a_successful_transaction_fails_without_a_commit() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let fixture = private_value_fixture(&state, 1, 100, 11, Address::ZERO);
    let transaction = private_value_bytes(&fixture);
    let mut block = block_with_txs(
        1,
        vec![
            (
                addr(1),
                Some(INBOX()),
                batch(std::slice::from_ref(&transaction)),
            ),
            (addr(2), Some(INBOX()), Vec::new()),
        ],
    );
    let mut versioned_hash = B256::ZERO;
    versioned_hash.0[0] = 1;
    block.txs[1].0.blob_versioned_hashes = vec![versioned_hash];
    let unresolved_transaction = block.txs[1].0.hash;
    let root = state.state_root();
    let tip = state.canonical_tip();

    assert!(matches!(
        derive_block(&mut state, &block, &rules, &StubVerifier::accept()),
        Err(DeriveError::UnresolvedBlobCarrier { transaction }) if transaction == unresolved_transaction
    ));
    assert_eq!(state.state_root(), root);
    assert_eq!(state.canonical_tip(), tip);

    // The same block derives once the blob resolves, and the transaction succeeds.
    block.txs[1].0.blob_resolution = pcash_l1::BlobResolution::Batch(batch(&[]).into());
    let outcome = derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
    assert_eq!(item_results(&outcome), vec![SUCCEEDED]);
}

#[test]
fn mixed_calldata_and_blob_carriers_preserve_order_and_sender_attribution() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let calldata_sender = addr(0xca11);
    let blob_sender = addr(0xb10b);
    let calldata_fixture = private_value_fixture(&state, 1, 100, 11, Address::ZERO);
    let blob_fixture = private_value_fixture(&state, 1, 200, 22, Address::ZERO);
    let calldata_transaction = private_value_bytes(&calldata_fixture);
    let blob_transaction = private_value_bytes(&blob_fixture);
    let mut block = block_with_txs(
        1,
        vec![
            (
                calldata_sender,
                Some(INBOX()),
                batch(std::slice::from_ref(&calldata_transaction)),
            ),
            (blob_sender, Some(INBOX()), Vec::new()),
            (addr(0xbad), Some(INBOX()), Vec::new()),
        ],
    );
    let mut first_hash = B256::repeat_byte(0x11);
    first_hash.0[0] = 1;
    block.txs[1].0.blob_versioned_hashes = vec![first_hash];
    block.txs[1].0.blob_resolution =
        pcash_l1::BlobResolution::Batch(batch(std::slice::from_ref(&blob_transaction)).into());
    let mut second_hash = B256::repeat_byte(0x22);
    second_hash.0[0] = 1;
    block.txs[2].0.blob_versioned_hashes = vec![second_hash];
    block.txs[2].0.blob_resolution = pcash_l1::BlobResolution::Batch(vec![0xff].into());

    let outcome = derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
    let items = delivery_items(&outcome);
    assert_eq!(items.len(), 2, "malformed blob batch is ignored");
    assert_eq!(items[0].0, 0);
    assert_eq!(items[1].0, 1);
    assert_eq!(
        outcome.committed_boundary.block.transaction_bytes,
        vec![calldata_transaction, blob_transaction]
    );
    assert_eq!(
        outcome.committed_boundary.history.l1_delivery_batches.len(),
        3
    );
    assert_eq!(
        outcome.committed_boundary.history.l1_delivery_batches[1].blob_versioned_hashes,
        vec![first_hash]
    );
    assert_eq!(item_results(&outcome), vec![SUCCEEDED; 2]);
    let reward_each = outcome.committed_boundary.history.economics.reward_each;
    assert_eq!(outcome.committed_boundary.history.payouts.len(), 2);
    assert_eq!(
        outcome.committed_boundary.history.payouts[0].owner_commitment,
        word(0xbeef)
    );
    assert_eq!(
        outcome.committed_boundary.history.payouts[0]
            .result_components()
            .0,
        U256::from(33)
    );
    assert_eq!(
        outcome.committed_boundary.history.payouts[1]
            .result_components()
            .1,
        reward_each * U256::from(2)
    );
    assert_eq!(
        outcome.committed_boundary.history.payouts[0].source,
        PayoutSource::PosterPayout {
            l1_transaction_indices: vec![0, 1]
        }
    );
}

#[test]
fn blob_carriage_does_not_change_the_derived_state() {
    let rules = stub_rules();
    let sender = addr(0xabc);
    let calldata_block = block_with_batch(1, INBOX(), sender, batch(&[]));
    let mut blob_block = calldata_block.clone();
    let resolved_batch = std::mem::take(&mut blob_block.txs[0].0.input);
    let mut versioned_hash = B256::repeat_byte(0x33);
    versioned_hash.0[0] = 1;
    blob_block.txs[0].0.blob_versioned_hashes = vec![versioned_hash];
    blob_block.txs[0].0.blob_resolution = pcash_l1::BlobResolution::Batch(resolved_batch);

    let mut calldata_state = initialize(&rules);
    let calldata = derive_block(
        &mut calldata_state,
        &calldata_block,
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    let mut blob_state = initialize(&rules);
    let blob = derive_block(
        &mut blob_state,
        &blob_block,
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();

    assert_eq!(blob_state.issuance_state(), calldata_state.issuance_state());
    assert_eq!(blob_state.state_root(), calldata_state.state_root());
    assert_eq!(
        blob.committed_boundary.block,
        calldata.committed_boundary.block
    );
}

#[test]
fn private_value_commit_exposes_exact_typed_index_effects() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let fixture = private_value_fixture(&state, 1, 20, 0, Address::ZERO);
    let transaction = private_value_bytes(&fixture);
    let id = content_hash(&transaction);
    let before = state.state_root();

    let outcome = derive_block(
        &mut state,
        &block_with_batch(
            1,
            INBOX(),
            addr(0xf00),
            batch(std::slice::from_ref(&transaction)),
        ),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();

    assert_eq!(item_results(&outcome), vec![SUCCEEDED]);
    let effects = accepted_effects(&outcome, 0).unwrap();
    assert_eq!(effects.kind, KIND_PRIVATE_VALUE);
    assert!(effects.account.is_none());
    assert_eq!(effects.output_leaf_start, Some(0));
    assert_eq!(effects.output_commitments.len(), 5);
    assert_eq!(
        Transaction::decode(&transaction, PCASH_CHAIN_ID)
            .unwrap()
            .output_data()
            .iter()
            .map(|data| data.as_slice())
            .collect::<Vec<_>>(),
        fixture
            .output_data
            .iter()
            .map(Vec::as_slice)
            .collect::<Vec<_>>()
    );
    assert_eq!(effects.nullifiers, fixture.public_inputs[2..6]);
    for nullifier in &effects.nullifiers {
        assert!(state.nullifier_seen(*nullifier).unwrap());
    }

    let boundary = &outcome.committed_boundary;
    assert_ne!(boundary.state_outcome.state_root, before);
    assert!(boundary.block.is_well_formed(&boundary.history.payouts));
    assert_eq!(boundary.block.transaction_bytes, vec![transaction.clone()]);
    assert_eq!(boundary.block.transaction_results.len(), 1);
    let result = &boundary.block.transaction_results[0];
    assert_eq!(result.outcome, TransactionOutcome::Succeeded);
    assert_eq!(
        (result.tx_type, result.funding_mode),
        (KIND_PRIVATE_VALUE, 0)
    );
    assert_eq!(result.poster_owner_commitment, word(0xbeef));
    assert_eq!(result.output_start_index, 0);
    assert_eq!(
        result.statement_hash,
        statement_hash_of_words(&fixture.public_inputs)
    );
    assert_eq!(boundary.block.header.parent_hash, fixture.public_inputs[1]);
    assert_eq!(
        boundary.block.header.state_root,
        fr_to_bytes(boundary.state.root)
    );
    assert_eq!(
        boundary.state_outcome.inserted_nullifiers,
        fixture.public_inputs[2..6]
    );
    let (l1_transaction_index, item) = delivery_items(&outcome)[0];
    assert_eq!(
        (l1_transaction_index, item.batch_item_index),
        (
            boundary.block.transaction_results[0].l1_transaction_index,
            boundary.block.transaction_results[0].batch_item_index
        )
    );
    assert_eq!(item.content_hash, id);
}

#[test]
fn same_block_nullifier_reuse_is_skipped_without_partial_effects() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let fixture = private_value_fixture(&state, 1, 30, 0, Address::ZERO);
    let transaction = private_value_bytes(&fixture);
    let outcome = derive_block(
        &mut state,
        &block_with_batch(
            1,
            INBOX(),
            addr(0xf00),
            batch(&[transaction.clone(), transaction]),
        ),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();

    assert_eq!(
        item_results(&outcome),
        vec![
            SUCCEEDED,
            ItemResult::Admitted(TransactionOutcome::NullifierAlreadySpent)
        ]
    );
    assert!(matches!(
        outcome.transaction_effects[1],
        TransactionEffects::Rejected(RejectedEffects {
            account: None,
            detail: Some(FailureDetailSeed::NullifierAlreadySpent { input_slot: 0, .. }),
        })
    ));
    assert_eq!(
        outcome.committed_boundary.block.transaction_results.len(),
        2
    );
    assert_eq!(
        outcome.committed_boundary.block.transaction_results[1].outcome,
        TransactionOutcome::NullifierAlreadySpent
    );
    assert_eq!(state.output_count(), 6);
}

#[test]
fn mixed_blocks_commit_frozen_hashes_effects_and_history() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let signing_key = SigningKey::from_slice(&[0x41u8; 32]).unwrap();
    let address = signer_address(&signing_key);
    let recent = recent_pcash_block_hash(&state);
    let creation = signed_account_transaction(
        &signing_key,
        INBOX(),
        tagged_word(0x06, 0xaaaa),
        tagged_word(0x07, 1),
        Some(vec![0x5a; pcash_state::ML_KEM768_PUBLIC_KEY_LEN]),
        recent,
        ts_of(0) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS,
    );
    let mut unknown_parity = creation.clone();
    *unknown_parity.last_mut().unwrap() = 2;
    let open_fixture = private_value_fixture(&state, 1, 100, 3, Address::ZERO);
    let open = private_value_bytes(&open_fixture);
    let designated = private_value_bytes(&private_value_fixture(&state, 1, 200, 0, addr(0x77)));
    let first_batch = batch(&[
        creation.clone(),
        contract_with_fee(&state, 0x100, 7, 5),
        // Same derived address: rejected against the in-block overlay.
        contract_with_fee(&state, 0x100, 8, 6),
        open.clone(),
        // Replayed nullifiers.
        open,
        // Shorter than the envelope: excluded, never admitted.
        vec![0xff, 0xee],
        designated,
        // The account already exists in the overlay.
        creation,
    ]);
    let mut expired = private_value_fixture(&state, 1, 400, 0, Address::ZERO);
    expired.public_inputs[S.valid_until_offset] = word(ts_of(1) - 1);
    let second_batch = posted_batch(
        &[
            private_value_bytes(&private_value_fixture(&state, 1, 300, 9, Address::ZERO)),
            // Creates the carrier sender's account.
            direct_account_transaction(recent, ts_of(1)),
            // A zero `s` recovers no signer.
            account_txbytes(
                tagged_word(0x06, 0xbbbb),
                tagged_word(0x07, 1),
                None,
                recent,
                ts_of(1),
                word(1),
                word(0),
                0,
            ),
            // A parity byte outside {0, 1}: excluded, never admitted.
            unknown_parity,
            // Expired before this block.
            private_value_bytes(&expired),
        ],
        word(0xf00d),
        word(0xfeed),
    );
    let block = inbox_block(1, vec![first_batch, second_batch]);
    let first = derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
    assert_eq!(
        item_results(&first),
        vec![
            SUCCEEDED,
            SUCCEEDED,
            ItemResult::Admitted(TransactionOutcome::ContractAddressExists),
            SUCCEEDED,
            ItemResult::Admitted(TransactionOutcome::NullifierAlreadySpent),
            ItemResult::Excluded(ItemExclusionReason::Truncated),
            SUCCEEDED,
            ItemResult::Admitted(TransactionOutcome::AccountAlreadyExists),
            SUCCEEDED,
            SUCCEEDED,
            ItemResult::Admitted(TransactionOutcome::InvalidAccountSignature),
            ItemResult::Excluded(ItemExclusionReason::UnknownYParity),
            ItemResult::Admitted(TransactionOutcome::Expired),
        ]
    );
    assert_eq!(state.account_of(addr(0x101)).unwrap().unwrap().revision, 1);
    assert_components_balance(&first);
    // Only a success commits a statement, and only a successful section an
    // output start; every result commits its type and its batch's poster.
    let (first_poster, second_poster) = (word(0xbeef), word(0xf00d));
    let committed: Vec<_> = first
        .committed_boundary
        .block
        .transaction_results
        .iter()
        .map(|result| {
            (
                result.tx_type,
                result.funding_mode,
                result.poster_owner_commitment,
                result.output_start_index,
                result.statement_hash != B256::ZERO,
            )
        })
        .collect();
    assert_eq!(
        committed,
        vec![
            (1, 0, first_poster, 0, true),
            (2, 1, first_poster, 0, true),
            (2, 1, first_poster, 0, false),
            (0, 0, first_poster, 5, true),
            (0, 0, first_poster, 0, false),
            (0, 0, first_poster, 10, true),
            (1, 0, first_poster, 0, false),
            (0, 0, second_poster, 15, true),
            (1, 0, second_poster, 0, true),
            (1, 0, second_poster, 0, false),
            (0, 0, second_poster, 0, false),
        ]
    );
    let results = &first.committed_boundary.block.transaction_results;
    assert_eq!(
        results[0].statement_hash,
        fr_to_bytes(transaction_statement_hash(&[
            pcash_state::addr_to_fr(address),
            field_element(tagged_word(0x06, 0xaaaa)),
            field_element(tagged_word(0x07, 1)),
            field_element(pcash_state::receive_key_hash(
                &[0x5a; pcash_state::ML_KEM768_PUBLIC_KEY_LEN]
            )),
        ]))
    );
    assert_eq!(
        results[3].statement_hash,
        statement_hash_of_words(&open_fixture.public_inputs)
    );

    use pcash_derive::ReceiveKeyUpdate;
    let current = state.account_of(address).unwrap().unwrap();
    let deadline = ts_of(2) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let cleared = pcash_state::AccountState {
        revision: current.revision + 1,
        account_rule_set_commitment: field_element(tagged_word(0x07, 2)),
        receive_key_hash: B256::ZERO,
        ..current
    };
    let update = |base: &pcash_state::AccountState,
                  operation: ReceiveKeyUpdate,
                  rule_set: CircuitWord,
                  salt: u64| {
        account_update_txbytes(
            address,
            rule_set,
            operation,
            user_account_update_commitment(address, base, field_element(rule_set), B256::ZERO),
            &private_value_section(
                &section_words(
                    recent_pcash_block_hash(&state),
                    salt,
                    4,
                    Address::ZERO,
                    0,
                    deadline,
                ),
                &vec![0u8; WIRE_PROOF_BYTES],
                &[DUMMY_OUTPUT_DATA.as_slice(); 5],
            ),
        )
    };
    let items = vec![
        update(&current, ReceiveKeyUpdate::Clear, tagged_word(0x07, 2), 11),
        // The first update already cleared the key, so this stops before its
        // stale account update commitment is examined.
        update(&current, ReceiveKeyUpdate::Clear, tagged_word(0x07, 3), 12),
        // Bound to the revision the first update just replaced.
        update(&current, ReceiveKeyUpdate::Keep, tagged_word(0x07, 4), 13),
        // Bound to the overlay revision, which the rejections left intact.
        update(&cleared, ReceiveKeyUpdate::Keep, tagged_word(0x07, 5), 14),
        private_value_bytes(&private_value_fixture(&state, 2, 500, 1, Address::ZERO)),
    ];
    let block = inbox_block(2, vec![batch(&items)]);
    let second = derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
    assert_eq!(
        item_results(&second),
        vec![
            SUCCEEDED,
            ItemResult::Admitted(TransactionOutcome::ClearWithoutReceiveKey),
            ItemResult::Admitted(TransactionOutcome::AccountUpdateCommitmentMismatch),
            SUCCEEDED,
            SUCCEEDED,
        ]
    );
    assert_components_balance(&second);
    assert_eq!(state.account_of(address).unwrap().unwrap().revision, 3);

    assert_eq!(
        committed_digest(&first),
        frozen_digest(
            "0x2a8483876eb4ff1552f2d4bfe3db88f37b36cef8040339ea1146139c3618ca4a",
            "0xa61bf99761b9632835f9ef26bfbd73a3c27013d94c2457c53ea5c0b2e3c125d1",
        )
    );
    assert_eq!(
        committed_digest(&second),
        frozen_digest(
            "0x0133aba1b2e19abf720a814279410763ef86202d497f852cab979b742135d6dd",
            "0xfe93cb5e85a2681bc5b511c6a5f26754ae3555c1cf2144d395a89abdb3819ad4",
        )
    );
}

/// Inbox calldata with an explicit poster owner commitment and recovery context.
fn posted_batch(items: &[Vec<u8>], poster: CircuitWord, context: CircuitWord) -> Vec<u8> {
    let mut calldata = batch(items);
    calldata[1..33].copy_from_slice(poster.as_slice());
    calldata[33..65].copy_from_slice(context.as_slice());
    calldata
}

/// One inbox transaction per batch, in order, from distinct L1 senders.
fn inbox_block(number: u64, batches: Vec<Vec<u8>>) -> pcash_l1::L1BlockData {
    block_with_txs(
        number,
        batches
            .into_iter()
            .enumerate()
            .map(|(index, calldata)| (addr(0x100 + index as u64), Some(INBOX()), calldata))
            .collect(),
    )
}

/// Every settled fee and every unit of issuance lands in exactly one payout
/// component.
fn assert_components_balance(outcome: &BlockOutcome) {
    let economics = &outcome.committed_boundary.history.economics;
    assert_eq!(
        outcome
            .committed_boundary
            .history
            .payouts
            .iter()
            .map(|p| p.result_components().0)
            .sum::<U256>(),
        economics.open_fees_total
    );
    assert_eq!(
        outcome
            .committed_boundary
            .history
            .payouts
            .iter()
            .map(|p| p.result_components().1)
            .sum::<U256>(),
        economics.issuance_total
    );
    for payout in &outcome.committed_boundary.history.payouts {
        assert_eq!(
            payout.amount,
            payout.result_components().0 + payout.result_components().1
        );
        assert!(!payout.amount.is_zero());
        assert!(payout.result_components().0.is_zero() ^ payout.result_components().1.is_zero());
        assert!(payout.amount <= U256::from(u128::MAX));
    }
}

/// Every framed item's delivery-manifest record with its L1 transaction index,
/// in canonical order.
fn delivery_items(outcome: &BlockOutcome) -> Vec<(u64, &L1DeliveryItem)> {
    outcome
        .committed_boundary
        .history
        .l1_delivery_batches
        .iter()
        .flat_map(|batch| {
            batch
                .items
                .iter()
                .map(move |item| (batch.l1_transaction_index, item))
        })
        .collect()
}

/// Every framed item's effects in canonical order; `None` for an excluded
/// item.
fn item_effects(outcome: &BlockOutcome) -> Vec<Option<&TransactionEffects>> {
    let mut effects = outcome.transaction_effects.iter();
    let items = delivery_items(outcome)
        .into_iter()
        .map(|(_, item)| {
            item.exclusion_reason
                .is_none()
                .then(|| effects.next().expect("effects for every admitted item"))
        })
        .collect();
    assert!(effects.next().is_none());
    items
}

fn accepted_effects(outcome: &BlockOutcome, item: usize) -> Option<&AcceptedEffects> {
    item_effects(outcome)[item].and_then(TransactionEffects::accepted)
}

fn failure_detail(outcome: &BlockOutcome, item: usize) -> Option<&FailureDetailSeed> {
    match item_effects(outcome)[item] {
        Some(TransactionEffects::Rejected(effects)) => effects.detail.as_ref(),
        _ => None,
    }
}

fn payout_context(outcome: &BlockOutcome, item: usize) -> B256 {
    accepted_effects(outcome, item)
        .unwrap()
        .payout
        .as_ref()
        .unwrap()
        .context
}

#[test]
fn open_fee_pays_poster_while_designated_issuance_pays_its_owner() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let items = vec![
        private_value_bytes(&private_value_fixture(&state, 1, 10, 0, Address::ZERO)),
        private_value_bytes(&private_value_fixture(&state, 1, 20, 5, Address::ZERO)),
        private_value_bytes(&private_value_fixture(&state, 1, 30, 0, addr(0xa))),
        private_value_bytes(&private_value_fixture(&state, 1, 40, 0, addr(0xb))),
    ];
    let block = inbox_block(1, vec![batch(&items)]);
    let outcome = derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
    let economics = &outcome.committed_boundary.history.economics;
    let reward = economics.reward_each;
    assert!(!reward.is_zero());
    assert_eq!(economics.qualifying_actions, 4);
    assert_eq!(economics.issuance_total, reward * U256::from(4));
    assert_eq!(economics.open_fees_total, U256::from(5));
    assert_eq!(
        outcome.committed_boundary.history.payouts,
        vec![
            PayoutRecord {
                source: PayoutSource::DesignatedIssuance {
                    l1_transaction_index: 0,
                    batch_item_index: 2,
                },
                component: PayoutComponent::Issuance,
                amount: reward,
                owner_commitment: address_word(addr(0xa)),
                output_index: 20,
                contexts: vec![payout_context(&outcome, 2)],
            },
            PayoutRecord {
                source: PayoutSource::DesignatedIssuance {
                    l1_transaction_index: 0,
                    batch_item_index: 3,
                },
                component: PayoutComponent::Issuance,
                amount: reward,
                owner_commitment: address_word(addr(0xb)),
                output_index: 21,
                contexts: vec![payout_context(&outcome, 3)],
            },
            PayoutRecord {
                source: PayoutSource::PosterPayout {
                    l1_transaction_indices: vec![0],
                },
                component: PayoutComponent::OpenFee,
                amount: U256::from(5),
                owner_commitment: word(0xbeef),
                output_index: 22,
                contexts: vec![word(0xcafe)],
            },
            PayoutRecord {
                source: PayoutSource::PosterPayout {
                    l1_transaction_indices: vec![0]
                },
                component: PayoutComponent::Issuance,
                amount: reward * U256::from(2),
                owner_commitment: word(0xbeef),
                output_index: 23,
                contexts: vec![word(0xcafe)],
            },
        ]
    );
    assert_ne!(payout_context(&outcome, 2), payout_context(&outcome, 3));
    assert_eq!(state.issuance_state().issued_so_far, reward * U256::from(4));
    assert_eq!(state.output_count(), 24);
    assert_components_balance(&outcome);
}

#[test]
fn routing_never_changes_the_issuance_settlement() {
    let rules = stub_rules();
    let variants: [[(u64, Address); 3]; 4] = [
        [(0, Address::ZERO), (0, Address::ZERO), (0, Address::ZERO)],
        [(0, addr(0xd0)), (0, addr(0xd1)), (0, addr(0xd2))],
        [(7, Address::ZERO), (0, addr(0xd1)), (0, addr(0xd2))],
        [(0, addr(0xd0)), (0, Address::ZERO), (11, Address::ZERO)],
    ];
    let mut settled = Vec::new();
    for (variant, expected_fees) in variants.iter().zip([0u64, 0, 7, 11]) {
        let mut state = initialize(&rules);
        let parent = state.issuance_state();
        let items = variant
            .iter()
            .zip([100u64, 200, 300])
            .map(|(&(fee, designated), seed)| {
                private_value_bytes(&private_value_fixture(&state, 1, seed, fee, designated))
            })
            .collect::<Vec<_>>();
        let block = inbox_block(1, vec![batch(&items)]);
        let elapsed = block.header.timestamp - state.last_l1_timestamp();
        let outcome = derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
        let economics = outcome.committed_boundary.history.economics.clone();
        let expected = pcash_issuance::transition(parent, elapsed, 3);
        assert_eq!(state.issuance_state(), expected.state);
        assert_eq!(economics.reward_each, expected.reward_each);
        assert_eq!(economics.issuance_total, expected.new_issuance);
        assert_eq!(economics.open_fees_total, U256::from(expected_fees));
        assert_components_balance(&outcome);
        settled.push((
            state.issuance_state(),
            economics.qualifying_actions,
            economics.reward_each,
            economics.issuance_total,
            economics.baseline,
            economics.internal_offer,
            economics.block_allowance,
        ));
    }
    assert!(settled.windows(2).all(|pair| pair[0] == pair[1]));
}

#[test]
fn complete_block_allowance_is_shared_across_carriers_and_ignores_failed_attempts() {
    const SUCCESSFUL_ACTIONS: u64 = 65;

    fn repartitioned_block(items: &[Vec<u8>], partitions: &[usize]) -> pcash_l1::L1BlockData {
        assert_eq!(partitions.iter().sum::<usize>(), items.len());
        let mut offset = 0;
        let txs = partitions
            .iter()
            .enumerate()
            .map(|(index, count)| {
                let end = offset + count;
                let calldata = batch(&items[offset..end]);
                offset = end;
                (addr(0x100 + index as u64), Some(INBOX()), calldata)
            })
            .collect();
        block_with_txs(1, txs)
    }

    let rules = stub_rules();
    let mut first_state = initialize(&rules);
    let parent_issuance = first_state.issuance_state();
    let parent_timestamp = first_state.last_l1_timestamp();
    let mut items = Vec::new();
    // One open-fee action, then zero-fee actions alternating between the open
    // route and distinct designated owners.
    for index in 0..SUCCESSFUL_ACTIONS {
        let (fee, designated) = match index {
            0 => (7, Address::ZERO),
            1 => (0, addr(0x9876)),
            _ if index % 2 == 1 => (0, addr(0x2_000 + index)),
            _ => (0, Address::ZERO),
        };
        let fixture = private_value_fixture(&first_state, 1, 1_000 + index * 10, fee, designated);
        items.push(private_value_bytes(&fixture));
    }
    let duplicate = items[0].clone();
    let mut expired = private_value_fixture(&first_state, 1, 9_000, 13, Address::ZERO);
    expired.public_inputs[S.valid_until_offset] = word(ts_of(1) - 1);
    items.push(private_value_bytes(&expired));
    items.push(duplicate);

    // Each carrier holds at most `pcash_da::MAX_BATCH_BYTES`.
    let first_block = repartitioned_block(&items, &[20, 20, 20, 7]);
    let elapsed = first_block.header.timestamp - parent_timestamp;
    let quote = pcash_issuance::quote(parent_issuance, elapsed);
    let expected_reward = quote.block_allowance / U256::from(SUCCESSFUL_ACTIONS);
    assert!(
        expected_reward < quote.internal_offer,
        "the block allowance must bind"
    );
    let expected_issuance = expected_reward * U256::from(SUCCESSFUL_ACTIONS);
    let expected_issuance_state =
        pcash_issuance::transition(parent_issuance, elapsed, SUCCESSFUL_ACTIONS).state;

    let first = derive_block(
        &mut first_state,
        &first_block,
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    let first_economics = &first.committed_boundary.history.economics;
    let mut expected_results = vec![SUCCEEDED; SUCCESSFUL_ACTIONS as usize];
    expected_results.extend([
        ItemResult::Admitted(TransactionOutcome::Expired),
        ItemResult::Admitted(TransactionOutcome::NullifierAlreadySpent),
    ]);
    assert_eq!(item_results(&first), expected_results);
    assert_eq!(first_economics.qualifying_actions, SUCCESSFUL_ACTIONS);
    assert_eq!(first_economics.reward_each, expected_reward);
    assert_eq!(first_economics.issuance_total, expected_issuance);
    assert_eq!(first_economics.open_fees_total, U256::from(7));
    assert_eq!(
        first_state.issuance_state().issued_so_far,
        expected_issuance
    );
    assert_eq!(first_state.issuance_state(), expected_issuance_state);
    assert_ne!(first_state.issuance_state().lag_q, parent_issuance.lag_q);
    assert!(first_economics.issuance_total <= quote.block_allowance);

    // Designated payouts in canonical order (action 1, then the odd actions),
    // then the one poster group holding every open action.
    let designated_actions = 1 + (3..SUCCESSFUL_ACTIONS).step_by(2).count();
    let open_actions = SUCCESSFUL_ACTIONS as usize - designated_actions;
    assert_eq!(
        first.committed_boundary.history.payouts.len(),
        designated_actions + 2
    );
    let (designated, poster) = first
        .committed_boundary
        .history
        .payouts
        .split_at(designated_actions);
    assert!(designated.iter().all(|payout| matches!(
        payout.source,
        PayoutSource::DesignatedIssuance { .. }
    ) && payout.result_components().1 == expected_reward));
    assert!(designated
        .iter()
        .all(|payout| payout.result_components().0.is_zero()));
    assert_eq!(poster[0].result_components().0, U256::from(7));
    assert_eq!(
        poster[1].result_components().1,
        expected_reward * U256::from(open_actions)
    );
    assert_eq!(
        poster[0].source,
        PayoutSource::PosterPayout {
            l1_transaction_indices: vec![0, 1, 2, 3]
        }
    );
    assert_components_balance(&first);

    let mut second_state = initialize(&rules);
    let second_block = repartitioned_block(&items, &[1, 22, 22, 22]);
    let second = derive_block(
        &mut second_state,
        &second_block,
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    assert_eq!(
        second_state.state_components(),
        first_state.state_components()
    );
    assert_eq!(
        second.committed_boundary.history.economics,
        first.committed_boundary.history.economics
    );
    assert_eq!(
        second.committed_boundary.history.payouts.len(),
        first.committed_boundary.history.payouts.len()
    );
    assert_ne!(
        second.committed_boundary.history.payouts[0].source,
        first.committed_boundary.history.payouts[0].source,
        "the control block must actually move a payout across carrier coordinates"
    );
    for (left, right) in first
        .committed_boundary
        .history
        .payouts
        .iter()
        .zip(&second.committed_boundary.history.payouts)
    {
        assert_eq!(
            std::mem::discriminant(&left.source),
            std::mem::discriminant(&right.source)
        );
        assert_eq!(left.amount, right.amount);
        assert_eq!(left.result_components().0, right.result_components().0);
        assert_eq!(left.result_components().1, right.result_components().1);
        assert_eq!(left.owner_commitment, right.owner_commitment);
        assert_eq!(left.output_index, right.output_index);
        assert_eq!(left.contexts, right.contexts);
    }
}

#[test]
fn poster_payout_aggregates_across_batches_after_designated_issuance() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let open = |seed, fee| {
        private_value_bytes(&private_value_fixture(&state, 1, seed, fee, Address::ZERO))
    };
    let first = open(100, 7);
    let designated = private_value_bytes(&private_value_fixture(&state, 1, 500, 0, addr(0xd)));
    let block = inbox_block(
        1,
        vec![
            posted_batch(std::slice::from_ref(&first), word(0xbeef), word(0xcafe)),
            posted_batch(
                &[
                    first.clone(),
                    vec![0xff],
                    open(200, 9),
                    designated,
                    open(250, 11),
                ],
                word(0xbeef),
                word(99),
            ),
            posted_batch(&[open(300, 5)], word(0xab), word(0xcafe)),
            // A zero-fee batch still contributes issuance and keeps its context.
            posted_batch(&[open(350, 0)], word(0xbeef), word(0x77)),
            // A poster group can hold issuance alone.
            posted_batch(&[open(360, 0)], word(0xcd), word(0x78)),
        ],
    );
    let outcome = derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
    let economics = &outcome.committed_boundary.history.economics;
    let reward = economics.reward_each;
    assert!(!reward.is_zero());
    assert_eq!(economics.qualifying_actions, 7);
    assert_eq!(economics.open_fees_total, U256::from(32));
    let summary = outcome
        .committed_boundary
        .history
        .payouts
        .iter()
        .map(|p| {
            (
                p.source.clone(),
                p.owner_commitment,
                p.result_components().0,
                p.result_components().1,
                p.contexts.clone(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        summary,
        vec![
            (
                PayoutSource::DesignatedIssuance {
                    l1_transaction_index: 1,
                    batch_item_index: 3,
                },
                address_word(addr(0xd)),
                U256::ZERO,
                reward,
                vec![payout_context(&outcome, 4)],
            ),
            (
                PayoutSource::PosterPayout {
                    l1_transaction_indices: vec![0, 1, 3],
                },
                word(0xbeef),
                U256::from(27),
                U256::ZERO,
                vec![word(0xcafe), word(99), word(0x77)],
            ),
            (
                PayoutSource::PosterPayout {
                    l1_transaction_indices: vec![0, 1, 3]
                },
                word(0xbeef),
                U256::ZERO,
                reward * U256::from(4),
                vec![word(0xcafe), word(99), word(0x77)],
            ),
            (
                PayoutSource::PosterPayout {
                    l1_transaction_indices: vec![2],
                },
                word(0xab),
                U256::from(5),
                U256::ZERO,
                vec![word(0xcafe)],
            ),
            (
                PayoutSource::PosterPayout {
                    l1_transaction_indices: vec![2]
                },
                word(0xab),
                U256::ZERO,
                reward,
                vec![word(0xcafe)],
            ),
            (
                PayoutSource::PosterPayout {
                    l1_transaction_indices: vec![4],
                },
                word(0xcd),
                U256::ZERO,
                reward,
                vec![word(0x78)],
            ),
        ]
    );
    assert_components_balance(&outcome);

    // Distinct PCASH blocks never aggregate.
    let later = private_value_bytes(&private_value_fixture(&state, 2, 400, 3, Address::ZERO));
    let next = inbox_block(2, vec![batch(&[later])]);
    let later_outcome = derive_block(&mut state, &next, &rules, &StubVerifier::accept()).unwrap();
    assert_eq!(later_outcome.committed_boundary.history.payouts.len(), 2);
    assert_eq!(
        later_outcome.committed_boundary.history.payouts[0]
            .result_components()
            .0,
        U256::from(3)
    );
    assert!(
        later_outcome.committed_boundary.history.payouts[0].output_index
            > outcome
                .committed_boundary
                .history
                .payouts
                .last()
                .unwrap()
                .output_index
    );
}

/// A batch may name the zero poster owner commitment. Nobody can open its
/// payouts, but its items execute and its open fees and issuance settle,
/// commit, and enter the output tree exactly as a named poster's do.
#[test]
fn zero_poster_owner_batches_are_admitted_and_paid_like_any_other() {
    let rules = stub_rules();
    let prior = initialize(&rules);
    let items = vec![
        private_value_bytes(&private_value_fixture(&prior, 1, 100, 5, Address::ZERO)),
        private_value_bytes(&private_value_fixture(&prior, 1, 200, 0, Address::ZERO)),
    ];
    let derive = |poster: CircuitWord| {
        let mut state = initialize(&rules);
        let block = inbox_block(1, vec![posted_batch(&items, poster, word(0xc0))]);
        let outcome = derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
        (state, outcome)
    };
    let (state, zero) = derive(B256::ZERO);
    let (named_state, named) = derive(word(0xa1));

    assert_eq!(item_results(&zero), vec![SUCCEEDED; 2]);
    let delivery = &zero.committed_boundary.history.l1_delivery_batches[0];
    assert_eq!(delivery.exclusion_reason, None);
    assert_eq!(delivery.poster_owner_commitment, Some(B256::ZERO));
    assert!(zero
        .committed_boundary
        .block
        .transaction_results
        .iter()
        .all(|result| result.poster_owner_commitment == B256::ZERO));
    let history = &zero.committed_boundary.history;
    assert_eq!(
        history.economics,
        named.committed_boundary.history.economics
    );
    let reward = history.economics.reward_each;
    assert!(!reward.is_zero());
    assert_eq!(
        history
            .payouts
            .iter()
            .map(|p| (p.owner_commitment, p.result_components()))
            .collect::<Vec<_>>(),
        vec![
            (B256::ZERO, (U256::from(5), U256::ZERO)),
            (B256::ZERO, (U256::ZERO, reward * U256::from(2))),
        ]
    );
    // Apart from their owner, the payouts are the named poster's.
    let named_payouts = &named.committed_boundary.history.payouts;
    assert_eq!(history.payouts.len(), named_payouts.len());
    for (payout, named_payout) in history.payouts.iter().zip(named_payouts) {
        assert_eq!(named_payout.owner_commitment, word(0xa1));
        assert_eq!(
            *payout,
            PayoutRecord {
                owner_commitment: B256::ZERO,
                ..named_payout.clone()
            }
        );
    }
    // Each payout note is an output-tree leaf after the transactions' outputs.
    assert_eq!(state.output_count(), 12);
    assert_eq!(named_state.output_count(), 12);
    for payout in &history.payouts {
        let path = state
            .path(pcash_state::TreeId::Output, payout.output_index)
            .unwrap();
        assert_eq!(
            pcash_crypto::merkle::root_from_index(
                payout.output_commitment(),
                payout.output_index,
                &path
            ),
            state.output_root()
        );
    }
    assert_components_balance(&zero);
}

#[test]
fn poster_groups_follow_their_first_positive_contribution() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let open = |seed, fee| {
        private_value_bytes(&private_value_fixture(&state, 1, seed, fee, Address::ZERO))
    };
    // Poster A first appears with a zero-fee open account operation, which
    // contributes nothing; poster B's positive contribution comes first.
    let zero_fee_account = contract_with_fee(&state, 0x100, 7, 0);
    let block = inbox_block(
        1,
        vec![
            posted_batch(&[zero_fee_account], word(0xa1), word(0xc0)),
            posted_batch(&[open(100, 5)], word(0xb1), word(0xc1)),
            posted_batch(&[open(200, 7)], word(0xa1), word(0xc2)),
        ],
    );
    let outcome = derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
    assert_eq!(item_results(&outcome), vec![SUCCEEDED; 3]);
    let reward = outcome.committed_boundary.history.economics.reward_each;
    assert!(!reward.is_zero());
    assert_eq!(
        outcome
            .committed_boundary
            .history
            .payouts
            .iter()
            .map(|p| (
                p.source.clone(),
                p.owner_commitment,
                p.result_components().0,
                p.result_components().1,
                p.contexts.clone()
            ))
            .collect::<Vec<_>>(),
        vec![
            (
                PayoutSource::PosterPayout {
                    l1_transaction_indices: vec![1],
                },
                word(0xb1),
                U256::from(5),
                U256::ZERO,
                vec![word(0xc1)],
            ),
            (
                PayoutSource::PosterPayout {
                    l1_transaction_indices: vec![1]
                },
                word(0xb1),
                U256::ZERO,
                reward,
                vec![word(0xc1)],
            ),
            (
                PayoutSource::PosterPayout {
                    l1_transaction_indices: vec![2],
                },
                word(0xa1),
                U256::from(7),
                U256::ZERO,
                vec![word(0xc2)],
            ),
            (
                PayoutSource::PosterPayout {
                    l1_transaction_indices: vec![2]
                },
                word(0xa1),
                U256::ZERO,
                reward,
                vec![word(0xc2)],
            ),
        ]
    );
    assert_components_balance(&outcome);
}

#[test]
fn copied_open_bytes_pay_the_first_successful_poster_and_designated_bytes_keep_their_owner() {
    let rules = stub_rules();
    let prior = initialize(&rules);
    let open = private_value_bytes(&private_value_fixture(&prior, 1, 100, 5, Address::ZERO));
    let designated = private_value_bytes(&private_value_fixture(&prior, 1, 200, 0, addr(0xd)));
    let copies = [
        posted_batch(&[open.clone(), designated.clone()], word(0xa1), word(0xc1)),
        posted_batch(&[open, designated], word(0xb1), word(0xc2)),
    ];
    let mut designated_payouts = Vec::new();
    for (first, second) in [(0, 1), (1, 0)] {
        let mut state = initialize(&rules);
        let block = inbox_block(1, vec![copies[first].clone(), copies[second].clone()]);
        let outcome = derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
        let economics = &outcome.committed_boundary.history.economics;
        let reward = economics.reward_each;
        assert_eq!(economics.qualifying_actions, 2);
        assert_eq!(
            item_results(&outcome)[2..],
            [ItemResult::Admitted(TransactionOutcome::NullifierAlreadySpent); 2]
        );
        let transactions = &outcome.committed_boundary.block.transaction_bytes;
        let items = delivery_items(&outcome);
        for (first_slot, copied_slot) in [(0, 2), (1, 3)] {
            let (_, first_item) = items[first_slot];
            let (_, copied_item) = items[copied_slot];
            assert_eq!(transactions[first_slot], transactions[copied_slot]);
            assert_eq!(first_item.content_hash, copied_item.content_hash);
            let [first_id, copied_id] = [first_slot, copied_slot].map(|slot| {
                let (l1_transaction_index, item) = items[slot];
                assert_eq!(
                    item.content_hash,
                    pcash_state::content_hash(&transactions[slot])
                );
                transaction_id(
                    block.header.hash,
                    l1_transaction_index,
                    item.batch_item_index,
                )
            });
            assert_ne!(first_id, copied_id);
        }
        assert_eq!(outcome.committed_boundary.history.payouts.len(), 3);
        let poster = &outcome.committed_boundary.history.payouts[1];
        assert_eq!(
            poster.owner_commitment,
            [word(0xa1), word(0xb1)][first],
            "the open copy pays only the first successful inclusion's poster"
        );
        assert_eq!(poster.contexts, vec![[word(0xc1), word(0xc2)][first]]);
        assert_eq!(poster.result_components().0, U256::from(5));
        assert_eq!(poster.result_components().1, U256::ZERO);
        assert_eq!(
            outcome.committed_boundary.history.payouts[2]
                .result_components()
                .1,
            reward
        );
        assert_components_balance(&outcome);
        designated_payouts.push(outcome.committed_boundary.history.payouts[0].clone());
    }
    assert_eq!(designated_payouts[0], designated_payouts[1]);
    assert_eq!(
        designated_payouts[0].owner_commitment,
        address_word(addr(0xd))
    );
    assert!(designated_payouts[0].result_components().0.is_zero());
}

#[test]
fn reproof_with_new_dummy_nullifiers_cannot_spend_a_canonical_nullifier_twice() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let paid_fixture = private_value_fixture(&state, 1, 10, 2, Address::ZERO);
    let paid = private_value_bytes(&paid_fixture);
    let mut reproved = private_value_fixture(&state, 1, 40, 2, Address::ZERO);
    reproved.public_inputs[S.nullifiers_offset] = paid_fixture.public_inputs[S.nullifiers_offset];
    assert_ne!(
        reproved.public_inputs[S.nullifiers_offset + 1],
        paid_fixture.public_inputs[S.nullifiers_offset + 1]
    );
    let reproved = private_value_bytes(&reproved);
    assert_ne!(reproved, paid);
    let mut expired = private_value_fixture(&state, 1, 20, 0, addr(0xd));
    expired.public_inputs[S.valid_until_offset] = word(ts_of(1) - 1);
    let excluded = private_value_fixture(&state, 1, 30, 4, Address::ZERO);
    let block = inbox_block(
        1,
        vec![
            batch(&[
                paid.clone(),
                private_value_bytes(&expired),
                reproved,
                vec![0xff],
            ]),
            posted_batch(
                &[private_value_bytes(&excluded)],
                B256::repeat_byte(0xff),
                word(0xcafe),
            ),
        ],
    );
    let outcome = derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
    assert_eq!(
        item_results(&outcome),
        vec![
            SUCCEEDED,
            ItemResult::Admitted(TransactionOutcome::Expired),
            ItemResult::Admitted(TransactionOutcome::NullifierAlreadySpent),
            ItemResult::Excluded(ItemExclusionReason::Truncated),
        ]
    );
    assert_eq!(
        outcome.committed_boundary.history.l1_delivery_batches[1].exclusion_reason,
        Some(pcash_state::BatchExclusionReason::InvalidPosterOwnerCommitment)
    );
    let economics = &outcome.committed_boundary.history.economics;
    assert_eq!(economics.qualifying_actions, 1);
    assert_eq!(economics.open_fees_total, U256::from(2));
    assert_eq!(outcome.committed_boundary.history.payouts.len(), 2);
    assert_eq!(
        outcome.committed_boundary.history.payouts[0].owner_commitment,
        word(0xbeef)
    );
    assert_eq!(
        outcome.committed_boundary.history.payouts[0]
            .result_components()
            .0,
        U256::from(2)
    );
    assert_eq!(
        outcome.committed_boundary.history.payouts[1]
            .result_components()
            .1,
        economics.reward_each
    );
    assert!(!state.nullifier_seen(excluded.public_inputs[2]).unwrap());
    assert_components_balance(&outcome);

    // A later block's reproof of the same spend fails against the committed
    // nullifier set.
    let mut later = private_value_fixture(&state, 2, 50, 0, Address::ZERO);
    later.public_inputs[S.nullifiers_offset] = paid_fixture.public_inputs[S.nullifiers_offset];
    let block = inbox_block(2, vec![batch(&[private_value_bytes(&later)])]);
    let outcome = derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
    assert_eq!(
        item_results(&outcome),
        vec![ItemResult::Admitted(
            TransactionOutcome::NullifierAlreadySpent
        )]
    );
    assert!(matches!(
        outcome.transaction_effects[0],
        TransactionEffects::Rejected(RejectedEffects {
            account: None,
            detail: Some(FailureDetailSeed::NullifierAlreadySpent { input_slot: 0, .. }),
        })
    ));
}

fn contract_with_fee(state: &impl StateDb, nk: u64, salt: u64, fee: u64) -> Vec<u8> {
    let recent = recent_pcash_block_hash(state);
    let deadline = ts_of(1) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    contract_transaction(
        tagged_word(0x0c, nk),
        None,
        false,
        &sample_functions(),
        &private_value_section(
            &section_words(recent, salt, fee, Address::ZERO, 0, deadline),
            &vec![0u8; WIRE_PROOF_BYTES],
            &[DUMMY_OUTPUT_DATA.as_slice(); 5],
        ),
    )
}

#[test]
fn account_operations_pay_open_fees_to_poster_and_never_earn_issuance() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let signing_key = SigningKey::from_slice(&[0x31u8; 32]).unwrap();
    let address = signer_address(&signing_key);
    let creation = signed_account_transaction(
        &signing_key,
        INBOX(),
        tagged_word(0x06, 0xdddd),
        tagged_word(0x07, 1),
        None,
        recent_pcash_block_hash(&state),
        ts_of(0) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS,
    );
    let items = vec![
        creation,
        contract_with_fee(&state, 0x100, 7, 5),
        contract_with_fee(&state, 0x200, 8, 6),
        contract_with_fee(&state, 0x300, 9, 0),
        private_value_bytes(&private_value_fixture(&state, 1, 100, 0, Address::ZERO)),
    ];
    let block = inbox_block(1, vec![batch(&items)]);
    let outcome = derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
    assert_eq!(item_results(&outcome), vec![SUCCEEDED; 5]);
    let economics = &outcome.committed_boundary.history.economics;
    let reward = economics.reward_each;
    assert_eq!(economics.qualifying_actions, 1);
    assert_eq!(economics.issuance_total, reward);
    assert_eq!(economics.open_fees_total, U256::from(11));
    let summary = outcome
        .committed_boundary
        .history
        .payouts
        .iter()
        .map(|p| {
            (
                p.owner_commitment,
                p.result_components().0,
                p.result_components().1,
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        summary,
        vec![
            (word(0xbeef), U256::from(11), U256::ZERO),
            (word(0xbeef), U256::ZERO, reward)
        ]
    );
    assert_components_balance(&outcome);

    // A user-account update pays its open fee to the poster and earns no issuance.
    let current = state.account_of(address).unwrap().unwrap();
    let deadline = ts_of(1) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let proposed = tagged_word(0x07, 2);
    let action =
        user_account_update_commitment(address, &current, field_element(proposed), B256::ZERO);
    let update = account_update_txbytes(
        address,
        proposed,
        pcash_derive::ReceiveKeyUpdate::Keep,
        action,
        &private_value_section(
            &section_words(
                recent_pcash_block_hash(&state),
                11,
                4,
                Address::ZERO,
                0,
                deadline,
            ),
            &vec![0u8; WIRE_PROOF_BYTES],
            &[DUMMY_OUTPUT_DATA.as_slice(); 5],
        ),
    );
    let block = inbox_block(2, vec![batch(&[update])]);
    let outcome = derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
    assert_eq!(item_results(&outcome), vec![SUCCEEDED]);
    let economics = &outcome.committed_boundary.history.economics;
    assert_eq!(economics.qualifying_actions, 0);
    assert!(economics.issuance_total.is_zero());
    assert_eq!(outcome.committed_boundary.history.payouts.len(), 1);
    assert_eq!(
        outcome.committed_boundary.history.payouts[0].owner_commitment,
        word(0xbeef)
    );
    assert_eq!(
        outcome.committed_boundary.history.payouts[0]
            .result_components()
            .0,
        U256::from(4)
    );
    assert!(outcome.committed_boundary.history.payouts[0]
        .result_components()
        .1
        .is_zero());
    assert_eq!(
        outcome.committed_boundary.history.payouts[0].contexts,
        vec![word(0xcafe)]
    );
}

/// Commit an empty PCASH block 1 whose settlement leaves `issuance` as the
/// parent state of block 2.
fn commit_issuance_state(
    state: &mut pcash_state::MemState,
    issuance: pcash_issuance::IssuanceState,
) {
    let block = block_with_txs(1, Vec::new());
    let logs = block.normalized_logs();
    state
        .commit(
            pcash_state::BlockInput {
                transaction_effects: Vec::new(),
                l1_logs: Vec::new(),
                number: 1,
                timestamp: block.header.timestamp,
                transaction_results: Vec::new(),
                transaction_bytes: Vec::new(),
                l1_origin: pcash_state::L1Origin {
                    block_number: 1,
                    block_hash: block.header.hash,
                    block_timestamp: block.header.timestamp,
                    l1_logs_root: logs.root,
                    l1_log_count: logs.count(),
                },
                history: pcash_state::CanonicalBlockHistory::default(),
            },
            pcash_state::BlockUpdate::empty(issuance),
        )
        .unwrap();
}

#[test]
fn without_issuance_zero_fee_actions_pay_nothing_while_fees_still_settle() {
    let rules = stub_rules();
    let initial = pcash_issuance::initial_state();
    let exhausted = pcash_issuance::IssuanceState {
        issued_so_far: pcash_issuance::supply_cap(),
        lag_q: initial.lag_q,
    };
    // Keep the offer lag below the multiplier cutoff.
    let zero_offer = pcash_issuance::IssuanceState {
        issued_so_far: U256::ZERO,
        lag_q: -(alloy_primitives::I256::try_from(129 * pcash_issuance::HALF_LIFE_SECONDS)
            .unwrap()
            << pcash_issuance::FRACTION_BITS),
    };
    for issuance in [exhausted, zero_offer] {
        let mut state = initialize(&rules);
        commit_issuance_state(&mut state, issuance);
        let transaction = |seed, fee, designated| {
            private_value_bytes(&private_value_fixture(&state, 2, seed, fee, designated))
        };
        let block = inbox_block(
            2,
            vec![
                posted_batch(
                    &[
                        transaction(100, 5, Address::ZERO),
                        transaction(200, 0, addr(0xd)),
                        transaction(300, 0, Address::ZERO),
                    ],
                    word(0xbeef),
                    word(0xcafe),
                ),
                posted_batch(
                    &[transaction(400, 0, Address::ZERO)],
                    word(0xbeef),
                    word(0x77),
                ),
                posted_batch(
                    &[transaction(500, 6, Address::ZERO)],
                    word(0xab),
                    word(0x78),
                ),
            ],
        );
        let outcome = derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
        let economics = &outcome.committed_boundary.history.economics;
        assert!(economics.reward_each.is_zero());
        assert!(economics.issuance_total.is_zero());
        assert_eq!(economics.qualifying_actions, 5);
        assert_eq!(economics.open_fees_total, U256::from(11));
        let summary = outcome
            .committed_boundary
            .history
            .payouts
            .iter()
            .map(|p| {
                (
                    p.owner_commitment,
                    p.result_components().0,
                    p.contexts.clone(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            summary,
            vec![
                (word(0xbeef), U256::from(5), vec![word(0xcafe)]),
                (word(0xab), U256::from(6), vec![word(0x78)]),
            ]
        );
        assert_eq!(
            outcome.committed_boundary.history.payouts[1].source,
            PayoutSource::PosterPayout {
                l1_transaction_indices: vec![2]
            }
        );
        assert_eq!(state.issuance_state().issued_so_far, issuance.issued_so_far);
        assert_components_balance(&outcome);
    }
}

#[test]
fn fork_activation_retires_a_transaction_type_at_its_timestamp() {
    let rules = stub_rules().with_fork(fork_at(ts_of(1)));
    let mut state = initialize(&rules);
    let owner = addr(0x1234);
    let recent = state.canonical_tip().unwrap().hash;
    let deadline = ts_of(0) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let account = direct_account_transaction(recent, deadline);
    assert_eq!(
        validate_raw_item(
            &state,
            &rules,
            &StubVerifier::accept(),
            ts_of(1) - 1,
            owner,
            &account,
        )
        .unwrap(),
        SUCCEEDED
    );

    let transfer = private_value_fixture(&state, 1, 50, 0, Address::ZERO);
    let block = block_with_batch(
        1,
        INBOX(),
        owner,
        batch(&[account, private_value_bytes(&transfer)]),
    );
    let verifier = StubVerifier::accept();
    let outcome = derive_block(&mut state, &block, &rules, &verifier).unwrap();

    assert_eq!(
        item_results(&outcome),
        vec![
            ItemResult::Excluded(ItemExclusionReason::UnknownKind),
            SUCCEEDED
        ]
    );
    assert_eq!(verifier.calls.get(), 1);
    assert_eq!(state.account_count(), 0);
}

#[test]
fn verifier_tool_failure_is_fatal_and_leaves_state_unchanged() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let fixture = private_value_fixture(&state, 1, 60, 0, Address::ZERO);
    let block = block_with_batch(
        1,
        INBOX(),
        addr(0xf00),
        batch(&[private_value_bytes(&fixture)]),
    );
    let root = state.state_root();
    let tip = state.canonical_tip();
    let verifier = StubVerifier {
        result: Err(()),
        calls: std::cell::Cell::new(0),
    };
    assert!(matches!(
        derive_block(&mut state, &block, &rules, &verifier),
        Err(DeriveError::Verify(_))
    ));
    assert_eq!(state.state_root(), root);
    assert_eq!(state.canonical_tip(), tip);
}

#[test]
fn unrelated_ethereum_activity_creates_no_native_notes() {
    let rules = stub_rules();
    let a = addr(1);
    let b = addr(2);
    let mut state = initialize(&rules);
    let before = state.output_root();
    let block = block_with_txs(
        1,
        vec![(a, None, vec![]), (b, None, vec![]), (a, None, vec![])],
    );
    derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
    assert_eq!(state.issuance_state().issued_so_far, U256::ZERO);
    assert_eq!(state.output_root(), before);
}

fn to32(value: k256::FieldBytes) -> CircuitWord {
    CircuitWord::from(<[u8; 32]>::from(value))
}

fn signer_address(signing_key: &SigningKey) -> Address {
    let point = signing_key.verifying_key().to_encoded_point(false);
    Address::from_slice(&keccak(&point.as_bytes()[1..65]).as_slice()[12..])
}

/// The fields of one signed user-account creation and its EIP-712 signature.
#[derive(Clone)]
struct SignedCreation {
    nullifier_key_commitment: CircuitWord,
    rule_set: CircuitWord,
    receive_key: Option<Vec<u8>>,
    recent: B256,
    deadline: u64,
    r: CircuitWord,
    s: CircuitWord,
    y_parity: u8,
}

impl SignedCreation {
    /// The creation `signing_key` signs for the test network with `inbox`.
    fn new(
        signing_key: &SigningKey,
        inbox: Address,
        nullifier_key_commitment: CircuitWord,
        rule_set: CircuitWord,
        receive_key: Option<Vec<u8>>,
        recent: B256,
        deadline: u64,
    ) -> Self {
        let creation = UserAccountCreation::new(
            nullifier_key_commitment,
            rule_set,
            receive_key
                .as_deref()
                .map(|key| Box::new(key.try_into().unwrap())),
            recent,
            deadline,
            // The digest does not cover the signature.
            pcash_derive::AccountCreationAuthorization::Eip712 {
                sig_r: CircuitWord::ZERO,
                sig_s: CircuitWord::ZERO,
                y_parity: false,
            },
        );
        let digest = pcash_derive::eip712::account_signing_hash(&creation, &source(inbox));
        let (signature, recovery_id) = signing_key
            .sign_prehash_recoverable(digest.as_slice())
            .unwrap();
        Self {
            nullifier_key_commitment,
            rule_set,
            receive_key,
            recent,
            deadline,
            r: to32(signature.r().to_bytes()),
            s: to32(signature.s().to_bytes()),
            y_parity: recovery_id.to_byte(),
        }
    }

    /// A copy with fields changed after signing.
    fn with(&self, change: impl FnOnce(&mut Self)) -> Self {
        let mut changed = self.clone();
        change(&mut changed);
        changed
    }

    fn bytes(&self) -> Vec<u8> {
        account_txbytes(
            self.nullifier_key_commitment,
            self.rule_set,
            self.receive_key.as_deref(),
            self.recent,
            self.deadline,
            self.r,
            self.s,
            self.y_parity,
        )
    }
}

fn signed_account_transaction(
    signing_key: &SigningKey,
    inbox: Address,
    nullifier_key_commitment: CircuitWord,
    account_rule_set: CircuitWord,
    receive_key: Option<Vec<u8>>,
    recent_pcash_block_hash: B256,
    valid_until_timestamp: u64,
) -> Vec<u8> {
    SignedCreation::new(
        signing_key,
        inbox,
        nullifier_key_commitment,
        account_rule_set,
        receive_key,
        recent_pcash_block_hash,
        valid_until_timestamp,
    )
    .bytes()
}

#[test]
fn user_account_effect_retains_exact_material_while_state_keeps_only_receive_key_hash() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let signing_key = SigningKey::from_slice(&[0x11u8; 32]).unwrap();
    let address = signer_address(&signing_key);
    let nullifier_key_commitment = tagged_word(0x06, 0xdddd);
    let rule_set = tagged_word(0x07, 1);
    let receive_key = vec![0x5a; pcash_state::ML_KEM768_PUBLIC_KEY_LEN];
    let recent = state.canonical_tip().unwrap().hash;
    let transaction = signed_account_transaction(
        &signing_key,
        INBOX(),
        nullifier_key_commitment,
        rule_set,
        Some(receive_key.clone()),
        recent,
        ts_of(0) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS,
    );
    assert_eq!(
        validate_raw_item(
            &state,
            &rules,
            &StubVerifier::accept(),
            ts_of(1),
            addr(0xf00),
            &transaction,
        )
        .unwrap(),
        SUCCEEDED
    );
    let outcome = derive_block(
        &mut state,
        &block_with_batch(
            1,
            INBOX(),
            addr(0xf00),
            batch(std::slice::from_ref(&transaction)),
        ),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();

    let account = state.account_of(address).unwrap().unwrap();
    assert_eq!(account.revision, 1);
    assert_eq!(account.kind, 0);
    assert_eq!(
        account.receive_key_hash,
        pcash_state::receive_key_hash(&receive_key)
    );
    let effects = accepted_effects(&outcome, 0).unwrap();
    let Some(AccountResult::User {
        address: written,
        revision,
        receive_key: operation,
        ..
    }) = &effects.account
    else {
        panic!("expected a user account result")
    };
    assert_eq!(*written, address);
    assert_eq!(*revision, 1);
    assert_eq!(*operation, ReceiveKeyOperation::Replace);
    assert_eq!(
        outcome.committed_boundary.block.transaction_bytes,
        vec![transaction.clone()]
    );

    let update = signed_account_transaction(
        &signing_key,
        INBOX(),
        nullifier_key_commitment,
        tagged_word(0x07, 2),
        None,
        recent,
        ts_of(0) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS,
    );
    let rejected = derive_block(
        &mut state,
        &block_with_batch(2, INBOX(), addr(0xf00), batch(&[update])),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    assert_eq!(
        item_results(&rejected),
        vec![ItemResult::Admitted(
            TransactionOutcome::AccountAlreadyExists
        )]
    );
    assert!(matches!(
        failure_detail(&rejected, 0),
        Some(FailureDetailSeed::Complete(
            FailureDetail::AccountAlreadyExists {
                existing_revision: 1,
                ..
            }
        ))
    ));
    let account = state.account_of(address).unwrap().unwrap();
    assert_eq!(account.revision, 1);
    assert_eq!(
        account.receive_key_hash,
        pcash_state::receive_key_hash(&receive_key)
    );
}

#[test]
fn user_account_creation_requires_a_live_named_block_and_an_unexpired_deadline() {
    let rules = stub_rules();
    let state = initialize(&rules);
    let signing_key = SigningKey::from_slice(&[0x13u8; 32]).unwrap();
    let nullifier_key_commitment = tagged_word(0x06, 0xabcd);
    let rule_set = tagged_word(0x07, 1);
    let recent = state.canonical_tip().unwrap().hash;
    let window_end = ts_of(0) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let signed = |recent, deadline| {
        signed_account_transaction(
            &signing_key,
            INBOX(),
            nullifier_key_commitment,
            rule_set,
            None,
            recent,
            deadline,
        )
    };
    let validate = |raw: &[u8], timestamp| {
        validate_raw_item(
            &state,
            &rules,
            &StubVerifier::accept(),
            timestamp,
            Address::ZERO,
            raw,
        )
        .unwrap()
    };

    // The deadline may outlast the named block's window; the window still
    // ends the creation's usable life.
    let far_deadline = signed(recent, window_end + 30 * 86_400);
    for timestamp in [ts_of(1), window_end] {
        assert_eq!(validate(&far_deadline, timestamp), SUCCEEDED);
    }
    assert_eq!(
        validate(&far_deadline, window_end + 1),
        ItemResult::Admitted(TransactionOutcome::RecentPcashBlockNotInWindow)
    );

    assert_eq!(
        validate(&signed(recent, ts_of(0)), ts_of(1)),
        ItemResult::Admitted(TransactionOutcome::Expired)
    );
    assert_eq!(
        validate(&signed(tagged_word(0x08, 123), ts_of(1) + 60), ts_of(1)),
        ItemResult::Admitted(TransactionOutcome::RecentPcashBlockNotInWindow)
    );
    // The named block is checked before the deadline.
    assert_eq!(
        validate(&signed(tagged_word(0x08, 123), ts_of(0)), ts_of(1)),
        ItemResult::Admitted(TransactionOutcome::RecentPcashBlockNotInWindow)
    );
}

/// An account-update signature outlives any one proof: nothing stops a prover
/// that kept the signature and its witnesses from anchoring a fresh proof of the
/// same signed transition in a later block. What ends the authorization is the
/// account advancing. Once the update applies, the signed current row is stale,
/// so consensus recomputes a different account update commitment and refuses to apply
/// the transition twice. Letting a proof expire is not revocation; the revision
/// bump is.
#[test]
fn reproving_an_applied_account_update_cannot_bump_the_revision_twice() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let signing_key = SigningKey::from_slice(&[0x21u8; 32]).unwrap();
    let address = signer_address(&signing_key);
    let nullifier_key_commitment = tagged_word(0x06, 0xdddd);
    let initial_rule_set = tagged_word(0x07, 11);
    let creation_recent = state.canonical_tip().unwrap().hash;
    let creation = signed_account_transaction(
        &signing_key,
        INBOX(),
        nullifier_key_commitment,
        initial_rule_set,
        None,
        creation_recent,
        ts_of(0) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS,
    );
    derive_block(
        &mut state,
        &block_with_batch(1, INBOX(), addr(0xf00), batch(&[creation])),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();

    let current = state.account_of(address).unwrap().unwrap();
    let proposed = tagged_word(0x07, 12);
    let deadline = ts_of(1) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    // The one action the owner signed, bound to the row it was signed against.
    let signed_action =
        user_account_update_commitment(address, &current, field_element(proposed), B256::ZERO);
    let proof = vec![0u8; WIRE_PROOF_BYTES];
    let first = account_update_txbytes(
        address,
        proposed,
        pcash_derive::ReceiveKeyUpdate::Keep,
        signed_action,
        &zero_fee_section(state.canonical_tip().unwrap().hash, 21, deadline, &proof),
    );
    let outcome = derive_block(
        &mut state,
        &block_with_batch(2, INBOX(), addr(0xf00), batch(&[first])),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    assert_eq!(item_results(&outcome), vec![SUCCEEDED]);
    assert_eq!(state.account_of(address).unwrap().unwrap().revision, 2);

    // Re-proved later against a fresh anchor and fresh fee notes, carrying the
    // same signed action. The proof verifies; the transition does not apply.
    let reproved = account_update_txbytes(
        address,
        proposed,
        pcash_derive::ReceiveKeyUpdate::Keep,
        signed_action,
        &zero_fee_section(
            state.canonical_tip().unwrap().hash,
            22,
            ts_of(2) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS,
            &proof,
        ),
    );
    let replayed = derive_block(
        &mut state,
        &block_with_batch(3, INBOX(), addr(0xf00), batch(&[reproved])),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    assert_eq!(
        item_results(&replayed),
        vec![ItemResult::Admitted(
            TransactionOutcome::AccountUpdateCommitmentMismatch
        )]
    );
    assert!(matches!(
        &failure_detail(&replayed, 0),
        Some(FailureDetailSeed::Complete(FailureDetail::AccountUpdateCommitmentMismatch {
            expected,
            supplied,
        })) if *supplied == signed_action && *expected != signed_action
    ));
    assert_eq!(state.account_of(address).unwrap().unwrap().revision, 2);
}

/// The kernel takes the proposed leaf as a witness, so the action word is the
/// only binding between the signed successor and the posted rule-set and
/// receive-key fields. Posting different fields with a signed action fails.
#[test]
fn account_update_fields_must_match_the_signed_successor() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let signing_key = SigningKey::from_slice(&[0x23u8; 32]).unwrap();
    let address = signer_address(&signing_key);
    let creation = signed_account_transaction(
        &signing_key,
        INBOX(),
        tagged_word(0x06, 0xcccc),
        tagged_word(0x07, 31),
        None,
        state.canonical_tip().unwrap().hash,
        ts_of(0) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS,
    );
    derive_block(
        &mut state,
        &block_with_batch(1, INBOX(), addr(0xf00), batch(&[creation])),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();

    let current = state.account_of(address).unwrap().unwrap();
    let signed_rule_set = tagged_word(0x07, 32);
    // Signed: install `signed_rule_set` and keep the absent receive key.
    let signed_action = user_account_update_commitment(
        address,
        &current,
        field_element(signed_rule_set),
        B256::ZERO,
    );
    let recent = state.canonical_tip().unwrap().hash;
    let deadline = ts_of(1) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let proof = vec![0u8; WIRE_PROOF_BYTES];
    let other_rule_set = account_update_txbytes(
        address,
        tagged_word(0x07, 33),
        pcash_derive::ReceiveKeyUpdate::Keep,
        signed_action,
        &zero_fee_section(recent, 23, deadline, &proof),
    );
    let other_receive_key = account_update_txbytes(
        address,
        signed_rule_set,
        pcash_derive::ReceiveKeyUpdate::Replace(receive_key(0x6e)),
        signed_action,
        &zero_fee_section(recent, 24, deadline, &proof),
    );
    let outcome = derive_block(
        &mut state,
        &block_with_batch(
            2,
            INBOX(),
            addr(0xf00),
            batch(&[other_rule_set, other_receive_key]),
        ),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    assert_eq!(
        item_results(&outcome),
        vec![ItemResult::Admitted(TransactionOutcome::AccountUpdateCommitmentMismatch); 2]
    );
    for index in 0..2 {
        assert!(matches!(
            &failure_detail(&outcome, index),
            Some(FailureDetailSeed::Complete(FailureDetail::AccountUpdateCommitmentMismatch {
                expected,
                supplied,
            })) if *supplied == signed_action && *expected != signed_action
        ));
    }
    assert_eq!(state.account_of(address).unwrap().unwrap(), current);
}

#[test]
fn user_account_update_is_a_live_compare_and_swap_and_cannot_replay() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let signing_key = SigningKey::from_slice(&[0x12u8; 32]).unwrap();
    let address = signer_address(&signing_key);
    let nullifier_key_commitment = tagged_word(0x06, 0xeeee);
    let initial_rule_set = tagged_word(0x07, 1);
    let creation_recent = state.canonical_tip().unwrap().hash;
    let creation = signed_account_transaction(
        &signing_key,
        INBOX(),
        nullifier_key_commitment,
        initial_rule_set,
        None,
        creation_recent,
        ts_of(0) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS,
    );
    derive_block(
        &mut state,
        &block_with_batch(1, INBOX(), addr(0xf00), batch(&[creation])),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();

    let current = state.account_of(address).unwrap().unwrap();
    let recent = state.canonical_tip().unwrap().hash;
    let deadline = ts_of(1) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let rule_set_one = tagged_word(0x07, 2);
    let rule_set_two = tagged_word(0x07, 3);
    let rule_set_three = tagged_word(0x07, 4);
    let replacement_key = receive_key(0x6b);
    let new_receive_key_hash = pcash_state::receive_key_hash(replacement_key.as_slice());
    let action_one = user_account_update_commitment(
        address,
        &current,
        field_element(rule_set_one),
        new_receive_key_hash,
    );
    let action_two =
        user_account_update_commitment(address, &current, field_element(rule_set_two), B256::ZERO);
    let after_one = pcash_state::AccountState {
        index: current.index,
        revision: current.revision + 1,
        nullifier_key_commitment: current.nullifier_key_commitment,
        account_rule_set_commitment: field_element(rule_set_one),
        kind: current.kind,
        receive_key_hash: new_receive_key_hash,
    };
    let action_three = user_account_update_commitment(
        address,
        &after_one,
        field_element(rule_set_three),
        new_receive_key_hash,
    );
    let redundant_replace_action = user_account_update_commitment(
        address,
        &after_one,
        field_element(rule_set_two),
        new_receive_key_hash,
    );
    let proof = vec![0u8; WIRE_PROOF_BYTES];
    let update_one = account_update_txbytes(
        address,
        rule_set_one,
        pcash_derive::ReceiveKeyUpdate::Replace(replacement_key.clone()),
        action_one,
        &zero_fee_section(recent, 1, deadline, &proof),
    );
    let conflicting = account_update_txbytes(
        address,
        rule_set_two,
        pcash_derive::ReceiveKeyUpdate::Clear,
        action_two,
        &zero_fee_section(recent, 2, deadline, &proof),
    );
    let redundant_replace = account_update_txbytes(
        address,
        rule_set_two,
        pcash_derive::ReceiveKeyUpdate::Replace(replacement_key.clone()),
        redundant_replace_action,
        &zero_fee_section(recent, 3, deadline, &proof),
    );
    let keep = account_update_txbytes(
        address,
        rule_set_three,
        pcash_derive::ReceiveKeyUpdate::Keep,
        action_three,
        &zero_fee_section(recent, 4, deadline, &proof),
    );
    let redundant_clear_verifier = ExpectedVkVerifier {
        expected: rules.user_account_update_hiding_kernel_vk.clone(),
        expected_public_inputs: USER_ACCOUNT_UPDATE_PUBLIC_INPUTS,
        calls: std::cell::Cell::new(0),
    };
    assert_eq!(
        validate_raw_item(
            &state,
            &rules,
            &redundant_clear_verifier,
            ts_of(1),
            Address::ZERO,
            &conflicting,
        )
        .unwrap(),
        ItemResult::Admitted(TransactionOutcome::ClearWithoutReceiveKey)
    );
    assert_eq!(redundant_clear_verifier.calls.get(), 0);
    let update_verifier = ExpectedVkVerifier {
        expected: rules.user_account_update_hiding_kernel_vk.clone(),
        expected_public_inputs: USER_ACCOUNT_UPDATE_PUBLIC_INPUTS,
        calls: std::cell::Cell::new(0),
    };
    let outcome = derive_block(
        &mut state,
        &block_with_batch(
            2,
            INBOX(),
            addr(0xf00),
            batch(&[update_one.clone(), redundant_replace, keep, conflicting]),
        ),
        &rules,
        &update_verifier,
    )
    .unwrap();
    assert_eq!(
        item_results(&outcome),
        vec![
            SUCCEEDED,
            ItemResult::Admitted(TransactionOutcome::ReplaceWithIdenticalReceiveKey),
            SUCCEEDED,
            ItemResult::Admitted(TransactionOutcome::AccountUpdateCommitmentMismatch),
        ]
    );
    // prepare_block warms all four; both rejections depend on live account state.
    assert_eq!(update_verifier.calls.get(), 4);
    assert_eq!(state.account_of(address).unwrap().unwrap().revision, 3);
    assert_eq!(
        fr_to_bytes(
            state
                .account_of(address)
                .unwrap()
                .unwrap()
                .account_rule_set_commitment
        ),
        rule_set_three
    );
    assert_eq!(
        state.account_of(address).unwrap().unwrap().receive_key_hash,
        new_receive_key_hash
    );
    let Some(AccountResult::User {
        revision,
        receive_key: operation,
        prior_state: first_prior,
        ..
    }) = &accepted_effects(&outcome, 0).unwrap().account
    else {
        panic!("expected a user account result")
    };
    assert_eq!(*revision, 2);
    assert_eq!(*operation, ReceiveKeyOperation::Replace);
    assert_eq!(first_prior.as_deref().copied(), Some(current));
    let Some(AccountResult::User {
        revision: keep_revision,
        receive_key: keep_operation,
        prior_state: second_prior,
        ..
    }) = &accepted_effects(&outcome, 2).unwrap().account
    else {
        panic!("expected a user account result")
    };
    assert_eq!(*keep_revision, 3);
    assert_eq!(*keep_operation, ReceiveKeyOperation::Keep);
    assert_eq!(second_prior.as_deref().copied(), Some(after_one));

    let replay = derive_block(
        &mut state,
        &block_with_batch(3, INBOX(), addr(0xf00), batch(&[update_one])),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    assert_eq!(
        item_results(&replay),
        vec![ItemResult::Admitted(
            TransactionOutcome::ReplaceWithIdenticalReceiveKey
        )]
    );
}

#[test]
fn account_writes_record_exactly_the_receive_keys_each_write_introduces() {
    let rules = stub_rules();
    let mut state =
        pcash_state::RedbState::create_in_memory(source(INBOX()), B256::repeat_byte(1)).unwrap();
    derive_block(
        &mut state,
        &block_with_txs(0, Vec::new()),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    let signing_key = SigningKey::from_slice(&[0x13u8; 32]).unwrap();
    let address = signer_address(&signing_key);
    let window = pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let created_key = vec![0x5c; pcash_state::ML_KEM768_PUBLIC_KEY_LEN];
    let replacement_key = receive_key(0x6d);
    let creation = signed_account_transaction(
        &signing_key,
        INBOX(),
        tagged_word(0x06, 0xeeef),
        tagged_word(0x07, 1),
        Some(created_key.clone()),
        state.canonical_tip().unwrap().hash,
        ts_of(0) + window,
    );
    let block = |number: u64, items: &[Vec<u8>]| {
        block_with_batch(number, INBOX(), addr(0xf00), batch(items))
    };
    derive_block(
        &mut state,
        &block(1, &[creation]),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();

    let proof = vec![0u8; WIRE_PROOF_BYTES];
    let created = state.account_of(address).unwrap().unwrap();
    let recent = state.canonical_tip().unwrap().hash;
    let deadline = ts_of(1) + window;
    let replaced = pcash_state::receive_key_hash(replacement_key.as_slice());
    let replace = account_update_txbytes(
        address,
        tagged_word(0x07, 2),
        pcash_derive::ReceiveKeyUpdate::Replace(replacement_key.clone()),
        user_account_update_commitment(
            address,
            &created,
            field_element(tagged_word(0x07, 2)),
            replaced,
        ),
        &zero_fee_section(recent, 1, deadline, &proof),
    );
    let after_replace = pcash_state::AccountState {
        revision: created.revision + 1,
        account_rule_set_commitment: field_element(tagged_word(0x07, 2)),
        receive_key_hash: replaced,
        ..created
    };
    let keep = account_update_txbytes(
        address,
        tagged_word(0x07, 3),
        pcash_derive::ReceiveKeyUpdate::Keep,
        user_account_update_commitment(
            address,
            &after_replace,
            field_element(tagged_word(0x07, 3)),
            replaced,
        ),
        &zero_fee_section(recent, 2, deadline, &proof),
    );
    derive_block(
        &mut state,
        &block(2, &[replace, keep]),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();

    let kept = state.account_of(address).unwrap().unwrap();
    let recent = state.canonical_tip().unwrap().hash;
    let deadline = ts_of(2) + window;
    let clear = account_update_txbytes(
        address,
        tagged_word(0x07, 4),
        pcash_derive::ReceiveKeyUpdate::Clear,
        user_account_update_commitment(
            address,
            &kept,
            field_element(tagged_word(0x07, 4)),
            B256::ZERO,
        ),
        &zero_fee_section(recent, 3, deadline, &proof),
    );
    derive_block(
        &mut state,
        &block(3, &[clear]),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    assert_eq!(state.account_of(address).unwrap().unwrap().revision, 4);

    let writes = state
        .reader()
        .snapshot()
        .unwrap()
        .account_writes(0, 0, u64::MAX)
        .unwrap()
        .map(|entry| {
            entry.map(|entry| {
                (
                    entry.block_number,
                    entry.ordinal,
                    entry.write.account.revision,
                    entry.write.account.receive_key_hash,
                    entry.write.published_receive_key,
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let created_hash = pcash_state::receive_key_hash(&created_key);
    assert_eq!(
        writes,
        vec![
            (1, 0, 1, created_hash, Some(created_key)),
            (2, 0, 2, replaced, Some(replacement_key.to_vec())),
            (2, 1, 3, replaced, None),
            (3, 0, 4, B256::ZERO, None),
        ]
    );
}

#[derive(Clone)]
struct ContractFunctionFixture {
    selector: u8,
    application_vk_hash: CircuitWord,
    configuration_commitment: CircuitWord,
}

/// A sponsored creation of the body [`contract_body`] encodes.
#[allow(
    clippy::too_many_arguments,
    reason = "fixture constructor names every encoded field"
)]
fn contract_transaction(
    nullifier_key_material: CircuitWord,
    receive_key: Option<&[u8]>,
    publishes_nk_root: bool,
    functions: &[ContractFunctionFixture],
    section: &[u8],
) -> Vec<u8> {
    sponsored_contract_txbytes(
        &contract_body(
            nullifier_key_material,
            receive_key,
            publishes_nk_root,
            functions,
        ),
        section,
    )
}

fn contract_body(
    nullifier_key_material: CircuitWord,
    receive_key: Option<&[u8]>,
    publishes_nk_root: bool,
    functions: &[ContractFunctionFixture],
) -> Vec<u8> {
    let mut body = vec![u8::from(publishes_nk_root)];
    body.extend_from_slice(nullifier_key_material.as_slice());
    if let Some(key) = receive_key {
        body.push(pcash_derive::RECEIVE_KEY_PRESENT);
        body.extend_from_slice(key);
    } else {
        body.push(pcash_derive::RECEIVE_KEY_ABSENT);
    }
    body.push(functions.len() as u8);
    for function in functions {
        body.push(function.selector);
        body.extend_from_slice(function.application_vk_hash.as_slice());
        body.extend_from_slice(function.configuration_commitment.as_slice());
    }
    body
}

fn sample_functions() -> Vec<ContractFunctionFixture> {
    vec![
        ContractFunctionFixture {
            selector: 0,
            application_vk_hash: tagged_word(0x09, 0x1a),
            configuration_commitment: tagged_word(0x0a, 0x1b),
        },
        ContractFunctionFixture {
            selector: 3,
            application_vk_hash: tagged_word(0x09, 0x2a),
            configuration_commitment: tagged_word(0x0a, 0x2b),
        },
    ]
}

/// A creation whose fee section fails leaves no contract behind: the section is
/// checked before any account effect, so a replayed sponsor nullifier or a
/// rejected proof loses the address rather than creating it for free.
#[test]
fn contract_creation_with_a_failing_fee_section_creates_no_account() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let functions = sample_functions();
    let recent = state.canonical_tip().unwrap().hash;
    let deadline = ts_of(1) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let section = zero_fee_section(recent, 8, deadline, &vec![0u8; WIRE_PROOF_BYTES]);
    let transaction =
        contract_transaction(tagged_word(0x0c, 0xbeef), None, false, &functions, &section);
    let address = contract_body_check(&transaction).address().unwrap();

    // The same sponsor nullifiers in one block: the second creation is skipped
    // and its distinct address never appears.
    let other = contract_transaction(tagged_word(0x0c, 0xfeed), None, false, &functions, &section);
    let replayed_address = contract_body_check(&other).address().unwrap();
    assert_ne!(address, replayed_address);
    let outcome = derive_block(
        &mut state,
        &block_with_batch(
            1,
            INBOX(),
            addr(0xf00),
            batch(&[transaction.clone(), other.clone()]),
        ),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    assert_eq!(
        item_results(&outcome),
        vec![
            SUCCEEDED,
            ItemResult::Admitted(TransactionOutcome::NullifierAlreadySpent)
        ]
    );
    assert!(state.account_of(address).unwrap().is_some());
    assert!(state.account_of(replayed_address).unwrap().is_none());

    // A rejected proof is the same: no account, no outputs, no fee.
    let fresh = contract_transaction(
        tagged_word(0x0c, 0xf00d),
        None,
        false,
        &functions,
        &zero_fee_section(recent, 9, deadline, &vec![0u8; WIRE_PROOF_BYTES]),
    );
    let fresh_address = contract_body_check(&fresh).address().unwrap();
    let rejected = derive_block(
        &mut state,
        &block_with_batch(2, INBOX(), addr(0xf00), batch(std::slice::from_ref(&fresh))),
        &rules,
        &StubVerifier::reject(),
    )
    .unwrap();
    assert_eq!(
        item_results(&rejected),
        vec![ItemResult::Admitted(TransactionOutcome::ProofRejected)]
    );
    assert!(state.account_of(fresh_address).unwrap().is_none());
}

#[test]
fn contract_effect_retains_typed_material_and_duplicate_address_is_rejected() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let functions = sample_functions();
    let receive_key = vec![0x6a; pcash_state::ML_KEM768_PUBLIC_KEY_LEN];
    let nk_commitment = tagged_word(0x0c, 0xcafe);
    let recent = state.canonical_tip().unwrap().hash;
    let deadline = ts_of(1) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let transaction = contract_transaction(
        nk_commitment,
        Some(&receive_key),
        false,
        &functions,
        &zero_fee_section(recent, 6, deadline, &vec![0u8; WIRE_PROOF_BYTES]),
    );
    let address = contract_body_check(&transaction).address().unwrap();
    assert_eq!(
        validate_raw_item(
            &state,
            &rules,
            &StubVerifier::accept(),
            ts_of(1),
            addr(0xf00),
            &transaction,
        )
        .unwrap(),
        SUCCEEDED
    );
    let outcome = derive_block(
        &mut state,
        &block_with_batch(
            1,
            INBOX(),
            addr(0xf00),
            batch(std::slice::from_ref(&transaction)),
        ),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();

    let account = state.account_of(address).unwrap().unwrap();
    assert_eq!(account.kind, 1);
    assert_eq!(
        account.receive_key_hash,
        pcash_state::receive_key_hash(&receive_key)
    );
    let Some(AccountResult::Contract {
        address: written, ..
    }) = &accepted_effects(&outcome, 0).unwrap().account
    else {
        panic!("expected a contract account result")
    };
    assert_eq!(*written, address);
    assert_eq!(
        outcome.committed_boundary.block.transaction_bytes,
        vec![transaction.clone()]
    );

    let current = state.account_of(address).unwrap().unwrap();
    let recent = state.canonical_tip().unwrap().hash;
    let deadline = ts_of(1) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let proposed_rule_set = tagged_word(0x07, 0x99);
    let asserted_action = user_account_update_commitment(
        address,
        &current,
        field_element(proposed_rule_set),
        B256::ZERO,
    );
    let update = account_update_txbytes(
        address,
        proposed_rule_set,
        pcash_derive::ReceiveKeyUpdate::Clear,
        asserted_action,
        &zero_fee_section(recent, 5, deadline, &vec![0u8; WIRE_PROOF_BYTES]),
    );
    let rejected_update = derive_block(
        &mut state,
        &block_with_batch(2, INBOX(), addr(0xf00), batch(&[update])),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    assert_eq!(
        item_results(&rejected_update),
        vec![ItemResult::Admitted(TransactionOutcome::WrongAccountKind)]
    );
    assert_eq!(state.account_of(address).unwrap().unwrap().revision, 1);

    let duplicate = derive_block(
        &mut state,
        &block_with_batch(
            3,
            INBOX(),
            addr(0xf00),
            batch(std::slice::from_ref(&transaction)),
        ),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    assert_eq!(
        item_results(&duplicate),
        vec![ItemResult::Admitted(
            TransactionOutcome::ContractAddressExists
        )]
    );
    assert!(accepted_effects(&duplicate, 0).is_none());
}

#[test]
fn published_root_contract_creation_is_accepted() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let functions = sample_functions();
    let nk_root = tagged_word(0x0d, 0x2024);
    let recent = state.canonical_tip().unwrap().hash;
    let deadline = ts_of(1) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let transaction = contract_transaction(
        nk_root,
        None,
        true,
        &functions,
        &zero_fee_section(recent, 7, deadline, &vec![0u8; WIRE_PROOF_BYTES]),
    );
    let outcome = derive_block(
        &mut state,
        &block_with_batch(1, INBOX(), addr(0xf00), batch(&[transaction])),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    assert_eq!(item_results(&outcome), vec![SUCCEEDED]);
}

#[test]
fn malformed_batch_and_non_inbox_calldata_commit_an_empty_block() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let malformed = vec![1, 0, 1, 0, 0, 0, 100, 1, 2];
    let outcome = derive_block(
        &mut state,
        &block_with_txs(
            1,
            vec![
                (addr(1), Some(INBOX()), malformed),
                (addr(2), Some(addr(0x999)), batch(&[vec![0xff]])),
            ],
        ),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    assert!(item_results(&outcome).is_empty());
    assert!(outcome
        .committed_boundary
        .block
        .transaction_results
        .is_empty());
    assert_eq!(
        outcome
            .committed_boundary
            .block
            .header
            .transaction_results_root,
        transaction_results_root(&[], &[])
    );
    assert_eq!(outcome.committed_boundary.block.header.number, 1);
}

#[test]
fn genesis_anchor_and_timestamp_regression_fail_without_a_commit() {
    let expected_hash = B256::from([0x55; 32]);
    let rules = stub_rules();
    let mut state = mem_state(pcash_state::DerivationSource {
        genesis_l1_block_hash: expected_hash,
        ..source(INBOX())
    });
    let root = state.state_root();
    let wrong = block_with_txs(0, Vec::new());
    assert!(matches!(
        derive_block(&mut state, &wrong, &rules, &StubVerifier::accept()),
        Err(DeriveError::GenesisAnchorMismatch { .. })
    ));
    assert_eq!(state.state_root(), root);
    assert!(state.canonical_tip().is_none());

    let mut correct = block_with_txs(0, Vec::new());
    correct.header.hash = expected_hash;
    derive_block(&mut state, &correct, &rules, &StubVerifier::accept()).unwrap();
    let tip = state.canonical_tip();
    let root = state.state_root();
    let regressed = block_with_txs_at(1, ts_of(0) - 1, Vec::new());
    assert!(matches!(
        derive_block(&mut state, &regressed, &rules, &StubVerifier::accept()),
        Err(DeriveError::TimestampRegression { .. })
    ));
    assert_eq!(state.canonical_tip(), tip);
    assert_eq!(state.state_root(), root);
}

#[test]
fn prewarm_skips_items_derivation_discards_before_verification() {
    // Prewarming runs full proof verification off the node lock. A wrong-chain
    // item is never admitted, and a transaction with a non-canonical field word
    // fails a pure public-input gate, so neither reaches the engine's verifier
    // call. Prewarming them would let an L1 sender force expensive verifier
    // work per follower for items derivation discards for free.
    let rules = stub_rules();
    let state = initialize(&rules);
    let good = private_value_bytes(&private_value_fixture(&state, 1, 1, 0, Address::ZERO));

    let mut wrong_chain = private_value_fixture(&state, 2, 2, 0, Address::ZERO);
    wrong_chain.public_inputs[0] = word(u64::from(PCASH_CHAIN_ID) + 1);
    let wrong_chain = private_value_bytes(&wrong_chain);

    let mut non_canonical = private_value_fixture(&state, 3, 3, 0, Address::ZERO);
    let mut raw = non_canonical.public_inputs[6].0;
    raw[0] = 0xff; // >= the BN254 scalar field modulus top byte
    non_canonical.public_inputs[6] = CircuitWord::from(raw);
    let non_canonical = private_value_bytes(&non_canonical);

    let block = block_with_batch(
        4,
        INBOX(),
        addr(1),
        batch(&[good, wrong_chain, non_canonical]),
    );

    let verifier = StubVerifier::accept();
    let _prepared = pcash_derive::prepare_block(&block, &rules, &source(INBOX()), &verifier);
    assert_eq!(
        verifier.calls.get(),
        1,
        "only the canonical transaction may be prewarmed"
    );
}

#[test]
fn prewarm_skips_account_updates_the_engine_rejects_before_verification() {
    // The account-update arm of the pure gate: a stale valid-until deadline or
    // non-canonical fields must not reach the verifier during prewarming.
    let rules = stub_rules();
    let state = initialize(&rules);
    let recent = recent_pcash_block_hash(&state);
    let address = addr(0x71);

    let fresh = account_update_txbytes(
        address,
        tagged_word(0x01, 1),
        pcash_derive::ReceiveKeyUpdate::Keep,
        tagged_word(0x02, 2),
        &zero_fee_section(recent, 6, ts_of(4) + 120, &vec![0x77; WIRE_PROOF_BYTES]),
    );
    let stale = account_update_txbytes(
        address,
        tagged_word(0x01, 3),
        pcash_derive::ReceiveKeyUpdate::Keep,
        tagged_word(0x02, 4),
        &zero_fee_section(recent, 7, ts_of(2), &vec![0x77; WIRE_PROOF_BYTES]),
    );

    let block = block_with_batch(4, INBOX(), addr(1), batch(&[fresh, stale]));

    let verifier = StubVerifier::accept();
    let _prepared = pcash_derive::prepare_block(&block, &rules, &source(INBOX()), &verifier);
    assert_eq!(
        verifier.calls.get(),
        1,
        "only the unexpired account update may be prewarmed"
    );
}

#[test]
fn prewarm_skips_private_value_timestamp_window_rejections() {
    // Derivation rejects expired and not-yet-valid transactions before its
    // verifier call. Prewarm must mirror that gate, or an L1 sender retains the
    // bb-verification amplification through deadline-invalid transactions alone.
    let rules = stub_rules();
    let state = initialize(&rules);

    let mut expired_private_value = private_value_fixture(&state, 4, 11, 0, Address::ZERO);
    expired_private_value.public_inputs[S.valid_until_offset] = word(ts_of(4).saturating_sub(1));
    let mut future_private_value = private_value_fixture(&state, 4, 12, 0, Address::ZERO);
    future_private_value.public_inputs[S.not_before_offset] = word(ts_of(4) + 10_000);

    let block = block_with_batch(
        5,
        INBOX(),
        addr(1),
        batch(&[
            private_value_bytes(&expired_private_value),
            private_value_bytes(&future_private_value),
        ]),
    );

    let verifier = StubVerifier::accept();
    let _prepared = pcash_derive::prepare_block(&block, &rules, &source(INBOX()), &verifier);
    assert_eq!(
        verifier.calls.get(),
        0,
        "deadline-invalid transactions must never be prewarmed"
    );
}

/// Counts the verdicts asked of `inner`.
struct CountedVerifier<V> {
    inner: V,
    calls: std::cell::Cell<usize>,
}

impl<V: Verifier> Verifier for CountedVerifier<V> {
    fn verify(&self, vk: &[u8], proof: &[u8], public_inputs: &[u8]) -> Result<bool, VerifyError> {
        self.calls.set(self.calls.get() + 1);
        self.inner.verify(vk, proof, public_inputs)
    }
}

/// Accepts every proof and keeps each public-input blob it was asked about.
struct RecordingVerifier {
    public_inputs: std::cell::RefCell<Vec<Vec<u8>>>,
}

impl Verifier for RecordingVerifier {
    fn verify(&self, _vk: &[u8], _proof: &[u8], public_inputs: &[u8]) -> Result<bool, VerifyError> {
        self.public_inputs.borrow_mut().push(public_inputs.to_vec());
        Ok(true)
    }
}

/// A successful proof-bearing result commits the hash of exactly the public
/// inputs its proof was verified against; an account creation without a proof
/// commits the address and the account row it wrote. Each section's result
/// commits the output index its outputs start at.
#[test]
fn successful_results_commit_the_verified_statement_or_the_written_account() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let creation_deadline = ts_of(0) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let signed_creation = |seed: u8, recent: B256| {
        let signing_key = SigningKey::from_slice(&[seed; 32]).unwrap();
        let raw = signed_account_transaction(
            &signing_key,
            INBOX(),
            tagged_word(0x06, 0xdddd),
            tagged_word(0x07, 1),
            Some(vec![0x5a; pcash_state::ML_KEM768_PUBLIC_KEY_LEN]),
            recent,
            creation_deadline,
        );
        (signer_address(&signing_key), raw)
    };
    let (updated, creation) = signed_creation(0x31, recent_pcash_block_hash(&state));
    derive_block(
        &mut state,
        &inbox_block(1, vec![batch(&[creation])]),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();

    let recent = recent_pcash_block_hash(&state);
    let (signed_address, signed) = signed_creation(0x32, recent);
    let proposed = tagged_word(0x07, 2);
    let update = account_update_txbytes(
        updated,
        proposed,
        pcash_derive::ReceiveKeyUpdate::Keep,
        user_account_update_commitment(
            updated,
            &state.account_of(updated).unwrap().unwrap(),
            field_element(proposed),
            pcash_state::receive_key_hash(&[0x5a; pcash_state::ML_KEM768_PUBLIC_KEY_LEN]),
        ),
        &zero_fee_section(recent, 77, ts_of(2) + 120, &vec![0x77; WIRE_PROOF_BYTES]),
    );
    let unfunded = unfunded_contract_txbytes(
        &contract_body(tagged_word(0x0c, 0x81), None, false, &sample_functions()),
        recent,
        creation_deadline,
    );
    let items = vec![
        private_value_bytes(&private_value_fixture(&state, 2, 0x60, 0, Address::ZERO)),
        large_fixture(&state, 10_000, 0).1,
        signed,
        direct_account_transaction(recent, creation_deadline),
        update,
        unfunded,
        contract_with_fee(&state, 0x80, 0x90, 0),
    ];
    let verifier = RecordingVerifier {
        public_inputs: std::cell::RefCell::new(Vec::new()),
    };
    let outcome = derive_block(
        &mut state,
        &block_with_batch(2, INBOX(), addr(0xf00), batch(&items)),
        &rules,
        &verifier,
    )
    .unwrap();
    assert_eq!(item_results(&outcome), vec![SUCCEEDED; 7]);

    let boundary = &outcome.committed_boundary;
    assert!(boundary.block.is_well_formed(&boundary.history.payouts));
    let results = &boundary.block.transaction_results;
    // Prewarming verifies the block's proofs in block order.
    let verified: Vec<_> = verifier
        .public_inputs
        .borrow()
        .iter()
        .map(|blob| {
            let words: Vec<CircuitWord> = blob.chunks(32).map(B256::from_slice).collect();
            statement_hash_of_words(&words)
        })
        .collect();
    let proven: Vec<_> = [0, 1, 4, 6]
        .iter()
        .map(|&index| results[index].statement_hash)
        .collect();
    assert_eq!(verified, proven);

    let written = |address: Address| {
        let row = state.account_of(address).unwrap().unwrap();
        fr_to_bytes(transaction_statement_hash(&[
            pcash_state::addr_to_fr(address),
            row.nullifier_key_commitment,
            row.account_rule_set_commitment,
            pcash_state::fr_from_internal_word(row.receive_key_hash),
        ]))
    };
    let contract = match &accepted_effects(&outcome, 5).unwrap().account {
        Some(AccountResult::Contract { address, .. }) => *address,
        other => panic!("unfunded creation wrote {other:?}"),
    };
    assert_eq!(results[2].statement_hash, written(signed_address));
    assert_eq!(results[3].statement_hash, written(addr(0xf00)));
    assert_eq!(results[5].statement_hash, written(contract));

    let shapes: Vec<_> = results
        .iter()
        .map(|result| {
            (
                result.tx_type,
                result.funding_mode,
                result.output_start_index,
            )
        })
        .collect();
    assert_eq!(
        shapes,
        vec![
            (0, 0, 0),
            (0, 0, 5),
            (1, 0, 0),
            (1, 0, 0),
            (3, 0, 37),
            (2, 0, 0),
            (2, 1, 42),
        ]
    );
}

/// Every transaction type and funding mode succeeds from a prewarmed block:
/// execution asks for one verdict per proof-bearing transaction, and the
/// complete cache, which fails on a miss, already holds each.
#[test]
fn every_transaction_type_and_funding_mode_executes_from_the_prewarmed_cache() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let creation_deadline = ts_of(0) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let signed_creation = |seed: u8, recent: B256| {
        let signing_key = SigningKey::from_slice(&[seed; 32]).unwrap();
        let raw = signed_account_transaction(
            &signing_key,
            INBOX(),
            tagged_word(0x06, 0xdddd),
            tagged_word(0x07, 1),
            None,
            recent,
            creation_deadline,
        );
        (signer_address(&signing_key), raw)
    };
    // Block 1 creates the account block 2 updates.
    let (address, creation) = signed_creation(0x31, recent_pcash_block_hash(&state));
    derive_block(
        &mut state,
        &inbox_block(1, vec![batch(&[creation])]),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();

    let recent = recent_pcash_block_hash(&state);
    let small = private_value_bytes(&private_value_fixture(&state, 2, 0x60, 0, Address::ZERO));
    let (_, large) = large_fixture(&state, 10_000, 0);
    let (_, signed) = signed_creation(0x32, recent);
    let direct = direct_account_transaction(recent, creation_deadline);
    let proposed = tagged_word(0x07, 2);
    let update = account_update_txbytes(
        address,
        proposed,
        pcash_derive::ReceiveKeyUpdate::Keep,
        user_account_update_commitment(
            address,
            &state.account_of(address).unwrap().unwrap(),
            field_element(proposed),
            B256::ZERO,
        ),
        &zero_fee_section(recent, 77, ts_of(2) + 120, &vec![0x77; WIRE_PROOF_BYTES]),
    );
    let unfunded = unfunded_contract_txbytes(
        &contract_body(tagged_word(0x0c, 0x81), None, false, &sample_functions()),
        recent,
        creation_deadline,
    );
    let sponsored = contract_with_fee(&state, 0x80, 0x90, 0);
    let block = block_with_batch(
        2,
        INBOX(),
        addr(0xf00),
        batch(&[
            small,
            large,
            signed,
            direct,
            update,
            unfunded,
            sponsored,
            vec![0xff],
            vec![0xaa; MAX_TX_BYTES + 1],
        ]),
    );
    let verifier = StubVerifier::accept();
    let prepared = pcash_derive::prepare_block(&block, &rules, &source(INBOX()), &verifier);
    // Both private-value shapes, the update, and the sponsored creation.
    assert_eq!(verifier.calls.get(), 4);
    let under_lock = CountedVerifier {
        inner: CachedVerifier::new_complete(prepared.cache(), &verifier),
        calls: std::cell::Cell::new(0),
    };
    let outcome = pcash_derive::derive_prepared_block(&mut state, &prepared, &under_lock).unwrap();
    assert_eq!(under_lock.calls.get(), 4);
    assert_eq!(verifier.calls.get(), 4);
    assert_eq!(
        item_results(&outcome),
        [
            vec![SUCCEEDED; 7],
            vec![
                ItemResult::Excluded(ItemExclusionReason::Truncated),
                ItemResult::Excluded(ItemExclusionReason::ItemTooLarge),
            ],
        ]
        .concat()
    );
}

/// The validity window gates prewarming and execution alike for every
/// proof-bearing type. A transaction at either inclusive bound reaches its
/// proof; one outside the window is rejected without being prewarmed. The
/// recent-block check before the window and the checks after it keep their
/// places when a transaction fails more than one.
#[test]
fn the_validity_window_gates_prewarming_and_execution_alike_for_every_proof_kind() {
    use TransactionOutcome::{
        ContractAddressExists, Expired, NotYetValid, ProofRejected, RecentPcashBlockNotInWindow,
    };
    let rules = stub_rules();
    let mut state = initialize(&rules);
    // Block 1 creates the account the updates name and the contract one
    // creation collides with.
    let signing_key = SigningKey::from_slice(&[0x31u8; 32]).unwrap();
    let address = signer_address(&signing_key);
    let genesis = recent_pcash_block_hash(&state);
    let creation_deadline = ts_of(0) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let existing_body = contract_body(tagged_word(0x0c, 0x81), None, false, &sample_functions());
    let setup = derive_block(
        &mut state,
        &inbox_block(
            1,
            vec![batch(&[
                signed_account_transaction(
                    &signing_key,
                    INBOX(),
                    tagged_word(0x06, 0xdddd),
                    tagged_word(0x07, 1),
                    None,
                    genesis,
                    creation_deadline,
                ),
                unfunded_contract_txbytes(&existing_body, genesis, creation_deadline),
            ])],
        ),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    assert_eq!(item_results(&setup), vec![SUCCEEDED; 2]);
    let existing = accepted_effects(&setup, 1)
        .and_then(|effects| effects.account.as_ref())
        .unwrap()
        .address();

    let recent = recent_pcash_block_hash(&state);
    let unknown = tagged_word(0x08, 0x9999);
    let timestamp = ts_of(2);
    let live = timestamp + 60;
    let data = [DUMMY_OUTPUT_DATA.as_slice(); 5];
    let proposed = tagged_word(0x07, 2);
    let action = user_account_update_commitment(
        address,
        &state.account_of(address).unwrap().unwrap(),
        field_element(proposed),
        B256::ZERO,
    );
    let sponsored = |body: &[u8], words: &[CircuitWord]| {
        sponsored_contract_txbytes(
            body,
            &private_value_section(words, &vec![0u8; WIRE_PROOF_BYTES], &data),
        )
    };
    let fresh_body = contract_body(tagged_word(0x0c, 0x80), None, false, &sample_functions());
    let private_value = |words: &[CircuitWord]| {
        transfer_txbytes(
            words,
            &stub_proof(
                SectionLayout::PrivateValue(PrivateValueShape::S),
                &[0xde; 64],
            ),
            &data,
        )
    };
    let update = |words: &[CircuitWord]| {
        account_update_txbytes(
            address,
            proposed,
            pcash_derive::ReceiveKeyUpdate::Keep,
            action,
            &private_value_section(words, &vec![0x77; WIRE_PROOF_BYTES], &data),
        )
    };
    let creation = |words: &[CircuitWord]| sponsored(&fresh_body, words);
    // The funding mode does not enter the address.
    let fresh_address = contract_body_check(&unfunded_contract_txbytes(&fresh_body, recent, live))
        .address()
        .unwrap();
    type Build<'a> = &'a dyn Fn(&[CircuitWord]) -> Vec<u8>;
    let kinds: [(&str, Build, Option<Address>); 3] = [
        ("private value", &private_value, None),
        ("account update", &update, Some(address)),
        ("sponsored creation", &creation, Some(fresh_address)),
    ];

    let expired = FailureDetail::Expired {
        valid_until: U256::from(timestamp - 1),
        block_timestamp: timestamp,
    };
    let not_in_window = FailureDetail::RecentPcashBlockNotInWindow {
        referenced_block_hash: unknown,
        window_start_timestamp: timestamp - pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS,
        window_end_timestamp: timestamp,
    };
    let mut cases = Vec::new();
    for (kind_index, (kind, build, account)) in kinds.iter().enumerate() {
        // Distinct sections, so every prewarmed statement is its own.
        let words = |row: u64, recent, not_before, valid_until| {
            let salt = 16 * kind_index as u64 + row;
            section_words(recent, salt, 0, Address::ZERO, not_before, valid_until)
        };
        let mut zero_nullifier = words(4, recent, 0, timestamp - 1);
        zero_nullifier[2] = word(0);
        for (name, words, outcome, detail) in [
            // Both bounds are inside the window.
            (
                "at its deadline",
                words(0, recent, 0, timestamp),
                ProofRejected,
                None,
            ),
            (
                "at its not-before time",
                words(1, recent, timestamp, live),
                ProofRejected,
                None,
            ),
            (
                "one second past its deadline",
                words(2, recent, 0, timestamp - 1),
                Expired,
                Some(expired.clone()),
            ),
            (
                "one second before its not-before time",
                words(3, recent, timestamp + 1, live),
                NotYetValid,
                Some(FailureDetail::NotYetValid {
                    not_before: U256::from(timestamp + 1),
                    block_timestamp: timestamp,
                }),
            ),
            // The window precedes the nullifier checks.
            (
                "expired with a zero nullifier",
                zero_nullifier,
                Expired,
                Some(expired.clone()),
            ),
            // The recent block precedes the window, expired or not.
            (
                "expired at an unknown recent block",
                words(5, unknown, 0, timestamp - 1),
                RecentPcashBlockNotInWindow,
                Some(not_in_window.clone()),
            ),
            (
                "live at an unknown recent block",
                words(6, unknown, 0, live),
                RecentPcashBlockNotInWindow,
                Some(not_in_window.clone()),
            ),
        ] {
            cases.push(rejection(
                format!("{kind} {name}"),
                build(&words),
                *account,
                outcome,
                detail,
            ));
        }
    }
    // The address precedes the window.
    cases.push(rejection(
        "sponsored creation expired at an existing address",
        sponsored(
            &existing_body,
            &section_words(recent, 63, 0, Address::ZERO, 0, timestamp - 1),
        ),
        Some(existing),
        ContractAddressExists,
        Some(FailureDetail::ContractAddressExists { address: existing }),
    ));
    // Per type: both bounds, and the live transaction whose recent block
    // only state can refuse.
    assert_rejections(&mut state, &rules, 2, cases, 9);
}

/// The carrier context of an Inbox transaction from `sender`, as a verifier
/// word.
fn inbox_carrier_context(sender: Address) -> CircuitWord {
    fr_to_bytes(pcash_l1::carrier_context_hash(
        pcash_l1::CarrierKind::Inbox,
        sender.into_array(),
        &[],
    ))
}

/// Profile-S section words with `carrier_context` as the required carrier
/// context.
fn section_words_requiring(
    recent: B256,
    salt: u64,
    valid_until: u64,
    carrier_context: CircuitWord,
) -> Vec<CircuitWord> {
    let mut words = section_words(recent, salt, 0, Address::ZERO, 0, valid_until);
    words[S.carrier_context_hash_offset] = carrier_context;
    words
}

/// A user account created in block 1 by a signed creation, for updates to
/// name.
fn state_with_user_account(
    rules: &pcash_derive::ProtocolRules,
) -> (pcash_state::MemState, Address) {
    let mut state = initialize(rules);
    let signing_key = SigningKey::from_slice(&[0x31u8; 32]).unwrap();
    let genesis = recent_pcash_block_hash(&state);
    let setup = derive_block(
        &mut state,
        &inbox_block(
            1,
            vec![batch(&[signed_account_transaction(
                &signing_key,
                INBOX(),
                tagged_word(0x06, 0xdddd),
                tagged_word(0x07, 1),
                None,
                genesis,
                ts_of(0) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS,
            )])],
        ),
        rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    assert_eq!(item_results(&setup), vec![SUCCEEDED]);
    (state, signer_address(&signing_key))
}

/// A nonzero `carrierContextHash` is a condition on the carrier that delivers
/// the transaction, checked right after the time bounds in every
/// proof-bearing type's order. Prewarming applies it as execution does: a
/// transaction that requires another carrier context is never verified. The
/// time bounds before the condition, and an existing contract address before
/// a sponsored creation's time bounds, keep their places; the condition
/// precedes the nullifier and account checks.
#[test]
fn the_carrier_context_condition_gates_prewarming_and_execution_alike_for_every_proof_kind() {
    use TransactionOutcome::{
        CarrierContextMismatch, ContractAddressExists, NotYetValid, ProofRejected,
    };
    let rules = stub_rules();
    let (mut state, address) = state_with_user_account(&rules);
    let recent = recent_pcash_block_hash(&state);
    // Block 2 creates the contract one creation collides with; block 3
    // carries the cases.
    let timestamp = ts_of(3);
    let live = timestamp + 60;
    // `assert_rejections` validates every case as an item of an Inbox
    // transaction from this sender, and derives them as one.
    let sender = addr(0xf00);
    let delivered = inbox_carrier_context(sender);
    let another_sender = inbox_carrier_context(addr(0xf01));
    // The sender's address as an event emitter with an empty context: the
    // carrier kind separates the two.
    let emitted_by_sender = fr_to_bytes(pcash_l1::carrier_context_hash(
        pcash_l1::CarrierKind::Event,
        sender.into_array(),
        &[],
    ));
    assert_ne!(emitted_by_sender, delivered);

    let data = [DUMMY_OUTPUT_DATA.as_slice(); 5];
    let proposed = tagged_word(0x07, 2);
    let action = user_account_update_commitment(
        address,
        &state.account_of(address).unwrap().unwrap(),
        field_element(proposed),
        B256::ZERO,
    );
    let private_value = |words: &[CircuitWord]| {
        transfer_txbytes(
            words,
            &stub_proof(
                SectionLayout::PrivateValue(PrivateValueShape::S),
                &[0xde; 64],
            ),
            &data,
        )
    };
    let update_of = |account: Address, words: &[CircuitWord]| {
        account_update_txbytes(
            account,
            proposed,
            pcash_derive::ReceiveKeyUpdate::Keep,
            action,
            &private_value_section(words, &vec![0x77; WIRE_PROOF_BYTES], &data),
        )
    };
    let update = |words: &[CircuitWord]| update_of(address, words);
    let sponsored = |body: &[u8], words: &[CircuitWord]| {
        sponsored_contract_txbytes(
            body,
            &private_value_section(words, &vec![0u8; WIRE_PROOF_BYTES], &data),
        )
    };
    let fresh_body = contract_body(tagged_word(0x0c, 0x80), None, false, &sample_functions());
    let creation = |words: &[CircuitWord]| sponsored(&fresh_body, words);
    let fresh_address = contract_body_check(&unfunded_contract_txbytes(&fresh_body, recent, live))
        .address()
        .unwrap();
    type Build<'a> = &'a dyn Fn(&[CircuitWord]) -> Vec<u8>;
    let kinds: [(&str, Build, Option<Address>); 3] = [
        ("private value", &private_value, None),
        ("account update", &update, Some(address)),
        ("sponsored creation", &creation, Some(fresh_address)),
    ];

    let mismatch = |required: CircuitWord| {
        Some(FailureDetail::CarrierContextMismatch {
            required,
            carrier: delivered,
        })
    };
    let mut cases = Vec::new();
    for (kind_index, (kind, build, account)) in kinds.iter().enumerate() {
        // Distinct sections, so every prewarmed statement is its own.
        let words = |row: u64, not_before: u64, carrier_context: CircuitWord| {
            let mut words = section_words_requiring(
                recent,
                16 * kind_index as u64 + row,
                live,
                carrier_context,
            );
            words[S.not_before_offset] = word(not_before);
            words
        };
        let mut zero_nullifier = words(5, 0, another_sender);
        zero_nullifier[S.nullifiers_offset] = word(0);
        for (name, words, outcome, detail) in [
            (
                "requiring its Inbox sender's carrier context",
                words(0, 0, delivered),
                ProofRejected,
                None,
            ),
            (
                "requiring no carrier context",
                words(1, 0, CircuitWord::ZERO),
                ProofRejected,
                None,
            ),
            (
                "requiring another sender's carrier context",
                words(2, 0, another_sender),
                CarrierContextMismatch,
                mismatch(another_sender),
            ),
            (
                "requiring its sender as an event emitter",
                words(3, 0, emitted_by_sender),
                CarrierContextMismatch,
                mismatch(emitted_by_sender),
            ),
            // The time bounds precede the condition.
            (
                "not yet valid and requiring another carrier context",
                words(4, timestamp + 1, another_sender),
                NotYetValid,
                Some(FailureDetail::NotYetValid {
                    not_before: U256::from(timestamp + 1),
                    block_timestamp: timestamp,
                }),
            ),
            // The condition precedes the nullifier checks.
            (
                "requiring another carrier context with a zero nullifier",
                zero_nullifier,
                CarrierContextMismatch,
                mismatch(another_sender),
            ),
        ] {
            cases.push(rejection(
                format!("{kind} {name}"),
                build(&words),
                *account,
                outcome,
                detail,
            ));
        }
    }
    // The condition precedes the account checks of an update.
    let missing = addr(0x9999);
    cases.push(rejection(
        "account update of a missing account requiring another carrier context",
        update_of(
            missing,
            &section_words_requiring(recent, 60, live, another_sender),
        ),
        Some(missing),
        CarrierContextMismatch,
        mismatch(another_sender),
    ));
    // A sponsored creation's address precedes its time bounds and condition.
    let existing_body = contract_body(tagged_word(0x0c, 0x81), None, false, &sample_functions());
    let existing = {
        let unfunded = unfunded_contract_txbytes(&existing_body, recent, live);
        let address = contract_body_check(&unfunded).address().unwrap();
        let outcome = derive_block(
            &mut state,
            &block_with_batch(2, INBOX(), sender, batch(&[unfunded])),
            &rules,
            &StubVerifier::accept(),
        )
        .unwrap();
        assert_eq!(item_results(&outcome), vec![SUCCEEDED]);
        address
    };
    cases.push(rejection(
        "sponsored creation at an existing address requiring another carrier context",
        sponsored(
            &existing_body,
            &section_words_requiring(recent, 61, live, another_sender),
        ),
        Some(existing),
        ContractAddressExists,
        Some(FailureDetail::ContractAddressExists { address: existing }),
    ));
    // Per type: the matching carrier context and no condition reach the proof.
    assert_rejections(&mut state, &rules, 3, cases, 6);
}

/// A transaction whose carrier context condition holds executes; one that
/// requires another carrier context consumes nothing and is never verified,
/// so the same bytes succeed when the carrier it names delivers them. Zero
/// requires nothing.
#[test]
fn a_carrier_context_condition_is_met_only_by_the_carrier_it_names() {
    let rules = stub_rules();
    let (mut state, address) = state_with_user_account(&rules);
    let recent = recent_pcash_block_hash(&state);
    let valid_until = ts_of(4) + 120;
    let first_sender = addr(0xa1);
    let second_sender = addr(0xa2);
    let first = inbox_carrier_context(first_sender);
    let second = inbox_carrier_context(second_sender);
    let data = [DUMMY_OUTPUT_DATA.as_slice(); 5];
    let private_value = |salt: u64, carrier_context: CircuitWord| {
        transfer_txbytes(
            &section_words_requiring(recent, salt, valid_until, carrier_context),
            &stub_proof(
                SectionLayout::PrivateValue(PrivateValueShape::S),
                &[0xde; 64],
            ),
            &data,
        )
    };
    let update = |state: &pcash_state::MemState, salt: u64, carrier_context: CircuitWord| {
        let proposed = tagged_word(0x07, salt);
        account_update_txbytes(
            address,
            proposed,
            pcash_derive::ReceiveKeyUpdate::Keep,
            user_account_update_commitment(
                address,
                &state.account_of(address).unwrap().unwrap(),
                field_element(proposed),
                B256::ZERO,
            ),
            &private_value_section(
                &section_words_requiring(recent, salt, valid_until, carrier_context),
                &vec![0x77; WIRE_PROOF_BYTES],
                &data,
            ),
        )
    };
    let creation = |nk: u64, salt: u64, carrier_context: CircuitWord| {
        let body = contract_body(tagged_word(0x0c, nk), None, false, &sample_functions());
        let address = contract_body_check(&unfunded_contract_txbytes(&body, recent, valid_until))
            .address()
            .unwrap();
        let raw = sponsored_contract_txbytes(
            &body,
            &private_value_section(
                &section_words_requiring(recent, salt, valid_until, carrier_context),
                &vec![0u8; WIRE_PROOF_BYTES],
                &data,
            ),
        );
        (address, raw)
    };
    let section_nullifiers = |salt: u64| {
        section_words_requiring(recent, salt, valid_until, CircuitWord::ZERO)
            [S.nullifiers_offset..S.outputs_offset]
            .to_vec()
    };

    let private_value_for_second = private_value(3, second);
    let update_for_second = update(&state, 4, second);
    let (contract_for_second, creation_for_second) = creation(0x82, 5, second);
    let (contract_for_first, creation_for_first) = creation(0x83, 6, first);
    let (contract_for_anyone, creation_for_anyone) = creation(0x84, 7, CircuitWord::ZERO);
    let block = block_with_batch(
        2,
        INBOX(),
        first_sender,
        batch(&[
            private_value(1, CircuitWord::ZERO),
            private_value(2, first),
            private_value_for_second.clone(),
            update_for_second.clone(),
            creation_for_second.clone(),
            creation_for_first,
            creation_for_anyone,
        ]),
    );
    let verifier = StubVerifier::accept();
    let outcome = derive_block(&mut state, &block, &rules, &verifier).unwrap();
    let mismatch = ItemResult::Admitted(TransactionOutcome::CarrierContextMismatch);
    assert_eq!(
        item_results(&outcome),
        vec![SUCCEEDED, SUCCEEDED, mismatch, mismatch, mismatch, SUCCEEDED, SUCCEEDED]
    );
    // Only the four that reach their proofs are verified.
    assert_eq!(verifier.calls.get(), 4);
    for (index, account) in [
        (2, None),
        (3, Some(address)),
        (4, Some(contract_for_second)),
    ] {
        assert_eq!(
            outcome.transaction_effects[index],
            TransactionEffects::Rejected(RejectedEffects {
                account,
                detail: Some(FailureDetailSeed::Complete(
                    FailureDetail::CarrierContextMismatch {
                        required: second,
                        carrier: first,
                    }
                )),
            })
        );
    }
    for salt in [3, 4, 5] {
        for nullifier in section_nullifiers(salt) {
            assert!(!state.nullifier_seen(nullifier).unwrap());
        }
    }
    assert_eq!(state.account_of(address).unwrap().unwrap().revision, 1);
    assert!(state.account_of(contract_for_second).unwrap().is_none());
    assert!(state.account_of(contract_for_first).unwrap().is_some());
    assert!(state.account_of(contract_for_anyone).unwrap().is_some());

    // The same bytes, delivered by the carrier they name.
    let outcome = derive_block(
        &mut state,
        &block_with_batch(
            3,
            INBOX(),
            second_sender,
            batch(&[
                private_value_for_second,
                update_for_second,
                creation_for_second,
            ]),
        ),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    assert_eq!(item_results(&outcome), vec![SUCCEEDED; 3]);
    assert_eq!(state.account_of(address).unwrap().unwrap().revision, 2);
    assert!(state.account_of(contract_for_second).unwrap().is_some());

    // An update that requires nothing executes from any carrier.
    let unconditional = update(&state, 8, CircuitWord::ZERO);
    let outcome = derive_block(
        &mut state,
        &block_with_batch(4, INBOX(), addr(0xa3), batch(&[unconditional])),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    assert_eq!(item_results(&outcome), vec![SUCCEEDED]);
    assert_eq!(state.account_of(address).unwrap().unwrap().revision, 3);
}

/// A direct-mode user-account creation: the account is whichever L1 sender
/// carries it.
fn direct_account_transaction(recent: B256, deadline: u64) -> Vec<u8> {
    let mut raw = account_txbytes(
        word(7),
        word(8),
        None,
        recent,
        deadline,
        CircuitWord::ZERO,
        CircuitWord::ZERO,
        0,
    );
    raw[5] = 0;
    raw.truncate(raw.len() - 65);
    raw
}

#[test]
fn direct_creation_creates_the_account_at_its_carrier_sender() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let recent = state.canonical_tip().unwrap().hash;
    let deadline = ts_of(0) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let raw = direct_account_transaction(recent, deadline);
    let senders = [addr(0x1234), addr(0x5678)];
    // The same bytes carried by two senders create two accounts.
    let outcome = derive_block(
        &mut state,
        &block_with_txs(
            1,
            senders
                .iter()
                .map(|&sender| (sender, Some(INBOX()), batch(std::slice::from_ref(&raw))))
                .collect(),
        ),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    assert_eq!(item_results(&outcome), vec![SUCCEEDED; 2]);
    for (index, sender) in senders.into_iter().enumerate() {
        let Some(AccountResult::User { address, .. }) =
            &accepted_effects(&outcome, index).unwrap().account
        else {
            panic!("expected a user account result")
        };
        assert_eq!(*address, sender);
        assert_eq!(state.account_of(sender).unwrap().unwrap().revision, 1);
    }
    assert_eq!(state.account_count(), 2);

    // An existing account is found before the recent block or the deadline
    // is examined.
    let stale = direct_account_transaction(tagged_word(0x08, 0x123), ts_of(0));
    for raw in [raw, stale] {
        assert_eq!(
            validate_raw_item(
                &state,
                &rules,
                &StubVerifier::accept(),
                ts_of(2),
                senders[0],
                &raw,
            )
            .unwrap(),
            ItemResult::Admitted(TransactionOutcome::AccountAlreadyExists)
        );
    }
}

/// A signed creation names its account only through its signature. Changing
/// a signed field or the signature after signing recovers to an unrelated
/// address or to none, so the intended account cannot be created without its
/// authorization, even when its own address carries the altered bytes.
#[test]
fn the_intended_account_cannot_be_created_without_its_authorization() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let signing_key = SigningKey::from_slice(&[0x17; 32]).unwrap();
    let owner = signer_address(&signing_key);
    let signed = SignedCreation::new(
        &signing_key,
        INBOX(),
        tagged_word(0x06, 0x1717),
        tagged_word(0x07, 0x17),
        Some(vec![0x5b; pcash_state::ML_KEM768_PUBLIC_KEY_LEN]),
        recent_pcash_block_hash(&state),
        ts_of(0) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS,
    );
    let flip_low_bit = |word: &mut CircuitWord| word.0[31] ^= 1;
    // A changed payload always recovers, to some other signer.
    let altered_payloads = [
        (
            "nullifier-key commitment",
            signed.with(|c| flip_low_bit(&mut c.nullifier_key_commitment)),
        ),
        (
            "rule-set commitment",
            signed.with(|c| flip_low_bit(&mut c.rule_set)),
        ),
        (
            "receive key",
            signed.with(|c| c.receive_key.as_mut().unwrap()[0] ^= 1),
        ),
        ("receive key removed", signed.with(|c| c.receive_key = None)),
        ("deadline", signed.with(|c| c.deadline -= 1)),
    ];
    // A changed signature may recover to another signer or to none.
    let altered_signatures = [
        ("signature r", signed.with(|c| flip_low_bit(&mut c.r))),
        ("signature s", signed.with(|c| flip_low_bit(&mut c.s))),
        ("y parity", signed.with(|c| c.y_parity ^= 1)),
    ];
    let cases = altered_payloads
        .iter()
        .chain(&altered_signatures)
        .collect::<Vec<_>>();
    let outcome = derive_block(
        &mut state,
        &block_with_batch(
            1,
            INBOX(),
            owner,
            batch(
                &cases
                    .iter()
                    .map(|(_, creation)| creation.bytes())
                    .collect::<Vec<_>>(),
            ),
        ),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    let results = item_results(&outcome);
    assert_eq!(results.len(), cases.len());
    for (index, ((name, _), result)) in cases.iter().zip(results).enumerate() {
        match result {
            SUCCEEDED => {
                let Some(AccountResult::User { address, .. }) =
                    &accepted_effects(&outcome, index).unwrap().account
                else {
                    panic!("{name}: expected a user account result")
                };
                assert_ne!(*address, owner, "{name}");
            }
            ItemResult::Admitted(TransactionOutcome::InvalidAccountSignature) => {
                assert!(index >= altered_payloads.len(), "{name}");
                // A signature that does not recover addresses no account.
                assert_eq!(
                    outcome.transaction_effects[index],
                    TransactionEffects::Rejected(RejectedEffects {
                        account: None,
                        detail: None,
                    }),
                    "{name}"
                );
            }
            other => panic!("{name}: {other:?}"),
        }
    }
    assert!(state.account_of(owner).unwrap().is_none());

    // The authorized bytes create the signer's account from any carrier.
    let relayer = addr(0x9999);
    let accepted = derive_block(
        &mut state,
        &block_with_batch(2, INBOX(), relayer, batch(&[signed.bytes()])),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    assert_eq!(item_results(&accepted), vec![SUCCEEDED]);
    assert_eq!(state.account_of(owner).unwrap().unwrap().revision, 1);
    assert!(state.account_of(relayer).unwrap().is_none());
}

#[test]
fn direct_creation_preserves_chain_recent_block_and_deadline_constraints() {
    let rules = stub_rules();
    let state = initialize(&rules);
    let owner = addr(0x1234);
    let recent = state.canonical_tip().unwrap().hash;
    let window_end = ts_of(0) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let validate = |raw: &[u8], timestamp| {
        validate_raw_item(
            &state,
            &rules,
            &StubVerifier::accept(),
            timestamp,
            owner,
            raw,
        )
        .unwrap()
    };
    let mut wrong_chain = direct_account_transaction(recent, window_end);
    wrong_chain[1..5].copy_from_slice(&(PCASH_CHAIN_ID + 1).to_be_bytes());
    assert_eq!(
        validate(&wrong_chain, ts_of(1)),
        ItemResult::Excluded(ItemExclusionReason::WrongChainId)
    );
    assert_eq!(
        validate(
            &direct_account_transaction(word(0x123), window_end),
            ts_of(1)
        ),
        ItemResult::Admitted(TransactionOutcome::RecentPcashBlockNotInWindow)
    );
    assert_eq!(
        validate(&direct_account_transaction(recent, ts_of(0)), ts_of(1)),
        ItemResult::Admitted(TransactionOutcome::Expired)
    );
    // The deadline may outlast the named block's window; the window still
    // ends the creation's usable life.
    let far_deadline = direct_account_transaction(recent, u64::MAX);
    for timestamp in [ts_of(1), window_end] {
        assert_eq!(validate(&far_deadline, timestamp), SUCCEEDED);
    }
    assert_eq!(
        validate(&far_deadline, window_end + 1),
        ItemResult::Admitted(TransactionOutcome::RecentPcashBlockNotInWindow)
    );
    // type ‖ chainId ‖ authorizationMode, then the nullifier-key commitment.
    let mut zero_field = direct_account_transaction(recent, window_end);
    zero_field[6..38].fill(0);
    assert_eq!(validate(&zero_field, ts_of(1)), SUCCEEDED);
    let mut bad_field = direct_account_transaction(recent, window_end);
    bad_field[6..38].fill(0xff);
    assert_eq!(
        validate(&bad_field, ts_of(1)),
        ItemResult::Admitted(TransactionOutcome::NonCanonicalAccountField)
    );
}

#[test]
fn direct_creation_uses_the_authenticated_blob_carrier_sender() {
    let rules = stub_rules();
    let owner = addr(0x1234);
    let mut state = initialize(&rules);
    let recent = state.canonical_tip().unwrap().hash;
    let raw = direct_account_transaction(
        recent,
        ts_of(0) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS,
    );
    let mut block = block_with_batch(1, INBOX(), owner, batch(&[raw]));
    let bytes = std::mem::take(&mut block.txs[0].0.input);
    let mut versioned_hash = B256::repeat_byte(0x33);
    versioned_hash.0[0] = 1;
    block.txs[0].0.blob_versioned_hashes = vec![versioned_hash];
    block.txs[0].0.blob_resolution = pcash_l1::BlobResolution::Batch(bytes);
    let outcome = derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
    assert_eq!(item_results(&outcome), vec![SUCCEEDED]);
    assert_eq!(state.account_of(owner).unwrap().unwrap().revision, 1);
}

/// A direct-mode creation delivered by a carrier event is not admitted
/// (`DirectModeOutsideInbox`): the Ethereum sender behind an event is whoever
/// called the emitting contract. Signed mode works from any carrier, and the
/// same direct bytes through the Inbox create the sender's account.
#[test]
fn a_direct_creation_from_a_carrier_event_is_not_admitted() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let recent = state.canonical_tip().unwrap().hash;
    let deadline = ts_of(0) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let direct = direct_account_transaction(recent, deadline);
    let signing_key = SigningKey::from_slice(&[0x32u8; 32]).unwrap();
    let signed = signed_account_transaction(
        &signing_key,
        INBOX(),
        tagged_word(0x06, 0xeeee),
        tagged_word(0x07, 1),
        None,
        recent,
        deadline,
    );
    let sender = addr(0x1234);
    let router = addr(0x7007);
    let block = block_with_receipts(
        1,
        vec![(
            sender,
            Some(router),
            Vec::new(),
            vec![carrier_event(
                router,
                &[],
                &batch(&[direct.clone(), signed]),
            )],
        )],
    );
    let outcome = derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
    assert_eq!(
        item_results(&outcome),
        vec![
            ItemResult::Excluded(ItemExclusionReason::DirectModeOutsideInbox),
            SUCCEEDED
        ]
    );
    assert_eq!(
        outcome.committed_boundary.block.transaction_results[0].batch_item_index,
        1
    );
    assert!(state.account_of(sender).unwrap().is_none());
    assert!(state.account_of(router).unwrap().is_none());
    assert!(state
        .account_of(signer_address(&signing_key))
        .unwrap()
        .is_some());

    let outcome = derive_block(
        &mut state,
        &block_with_batch(2, INBOX(), sender, batch(&[direct])),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    assert_eq!(item_results(&outcome), vec![SUCCEEDED]);
    assert!(state.account_of(sender).unwrap().is_some());
}

fn large_fixture(state: &impl StateDb, seed: u64, fee: u64) -> (Vec<CircuitWord>, Vec<u8>) {
    let shape = PrivateValueShape::L;
    let profile = shape.profile();
    let mut pis = vec![word(0); profile.public_inputs];
    pis[0] = word(u64::from(PCASH_CHAIN_ID));
    pis[1] = recent_pcash_block_hash(state);
    for i in 0..profile.inputs {
        pis[2 + i] = word(seed + i as u64);
    }
    for i in 0..profile.outputs {
        pis[profile.outputs_offset + i] = word(50_000 + i as u64);
    }
    pis[profile.delivery_commitment_offset] =
        uniform_delivery_commitment(shape, &DUMMY_OUTPUT_DATA);
    pis[profile.open_fee_amount_offset] = word(fee);
    pis[profile.valid_until_offset] = word(ts_of(1) + 120);
    let data = vec![DUMMY_OUTPUT_DATA.as_slice(); profile.outputs];
    let raw = profile_txbytes(
        shape,
        &pis,
        &stub_proof(SectionLayout::PrivateValue(shape), &[0xde; 64]),
        &data,
    );
    (pis, raw)
}

#[test]
fn l_uses_its_key_and_settles_all_inputs_outputs_and_late_conflicts() {
    let mut rules = stub_rules();
    rules.private_value_hiding_kernel_vks = [vec![0x51], vec![0x52]];
    let mut state = initialize(&rules);
    let (pis, large) = large_fixture(&state, 10_000, 7);
    let verifier = ExpectedVkVerifier {
        expected: vec![0x52],
        expected_public_inputs: PrivateValueShape::L.profile().public_inputs,
        calls: std::cell::Cell::new(0),
    };
    assert_eq!(
        validate_raw_item(&state, &rules, &verifier, ts_of(1), addr(1), &large).unwrap(),
        SUCCEEDED
    );
    assert_eq!(verifier.calls.get(), 1);
    let mut small = private_value_fixture(&state, 1, 20, 11, Address::ZERO);
    let ordinary_small = private_value_bytes(&small);
    small.public_inputs[2] = pis[2 + PrivateValueShape::L.profile().inputs - 1];
    let conflict = private_value_bytes(&small);
    let block = block_with_txs(
        1,
        vec![
            (addr(1), Some(INBOX()), batch(&[large])),
            (addr(1), Some(INBOX()), batch(&[ordinary_small, conflict])),
        ],
    );
    let outcome = derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
    assert_eq!(
        item_results(&outcome),
        vec![
            SUCCEEDED,
            SUCCEEDED,
            ItemResult::Admitted(TransactionOutcome::NullifierAlreadySpent)
        ]
    );
    let effects = accepted_effects(&outcome, 0).unwrap();
    assert_eq!(
        effects.nullifiers.len(),
        PrivateValueShape::L.profile().inputs
    );
    assert_eq!(
        effects.output_commitments.len(),
        PrivateValueShape::L.profile().outputs
    );
    for (i, nullifier) in effects.nullifiers.iter().enumerate() {
        assert_eq!(*nullifier, pis[2 + i]);
        assert!(state.nullifier_seen(*nullifier).unwrap());
    }
    assert_eq!(outcome.committed_boundary.block.header.number, 1);
    assert_eq!(outcome.committed_boundary.block.transaction_bytes.len(), 3);
    let reward = outcome.committed_boundary.history.economics.reward_each;
    assert_eq!(outcome.committed_boundary.history.payouts.len(), 2);
    assert_eq!(
        outcome.committed_boundary.history.payouts[0]
            .result_components()
            .0,
        U256::from(18)
    );
    assert_eq!(
        outcome.committed_boundary.history.payouts[1]
            .result_components()
            .1,
        reward * U256::from(2)
    );
    assert_eq!(
        outcome.committed_boundary.history.payouts[0].source,
        PayoutSource::PosterPayout {
            l1_transaction_indices: vec![0, 1]
        }
    );
    assert_components_balance(&outcome);
}

// ---- hostile-calldata rejection outcomes ----------------------------------

/// A 32-byte word that is not a canonical field element (`>= p`).
const NOT_IN_FIELD: CircuitWord = CircuitWord::repeat_byte(0xff);

struct Rejection {
    name: String,
    transaction: Vec<u8>,
    /// The account the transaction addresses.
    account: Option<Address>,
    outcome: TransactionOutcome,
    detail: Option<FailureDetail>,
}

fn rejection(
    name: impl Into<String>,
    transaction: Vec<u8>,
    account: Option<Address>,
    outcome: TransactionOutcome,
    detail: Option<FailureDetail>,
) -> Rejection {
    Rejection {
        name: name.into(),
        transaction,
        account,
        outcome,
        detail,
    }
}

/// Derive block `number` from one batch carrying every case. Each must be
/// admitted, commit exactly its outcome code, failure detail, and addressed
/// account, and leave no effect behind, both validated alone and in the
/// derived block.
///
/// `derive_block` prepares the block and then executes it against the
/// complete cache, so a case whose proof execution reached without prewarming
/// would fail derivation on the cache miss. The verifier rejects, so a case
/// that passes every check before its proof commits `ProofRejected`, from the
/// verdict prewarming cached. `prewarmed` is the number of cases that pass the
/// pure pre-verification gates, whose proofs `prepare_block` verifies whether
/// or not derivation then reaches them.
fn assert_rejections(
    state: &mut pcash_state::MemState,
    rules: &pcash_derive::ProtocolRules,
    number: u64,
    cases: Vec<Rejection>,
    prewarmed: usize,
) {
    let accounts_before = state.account_count();
    let items: Vec<Vec<u8>> = cases.iter().map(|case| case.transaction.clone()).collect();
    let direct = StubVerifier::reject();
    for case in &cases {
        assert_eq!(
            validate_raw_item(
                state,
                rules,
                &direct,
                ts_of(number),
                addr(0xf00),
                &case.transaction,
            )
            .unwrap(),
            ItemResult::Admitted(case.outcome),
            "{}",
            case.name,
        );
    }
    let verifier = StubVerifier::reject();
    let outcome = derive_block(
        state,
        &block_with_batch(number, INBOX(), addr(0xf00), batch(&items)),
        rules,
        &verifier,
    )
    .unwrap();

    let results = &outcome.committed_boundary.block.transaction_results;
    assert_eq!(item_results(&outcome).len(), cases.len());
    assert_eq!(results.len(), cases.len());
    assert_eq!(outcome.transaction_effects.len(), cases.len());
    for (index, case) in cases.into_iter().enumerate() {
        assert_eq!(results[index].outcome, case.outcome, "{}", case.name);
        assert_eq!(
            outcome.transaction_effects[index],
            TransactionEffects::Rejected(RejectedEffects {
                account: case.account,
                detail: case.detail.map(FailureDetailSeed::Complete),
            }),
            "{}",
            case.name
        );
    }
    assert_eq!(verifier.calls.get(), prewarmed);
    assert_eq!(state.account_count(), accounts_before);
}

#[test]
fn private_value_value_errors_commit_their_exact_outcome_before_verification() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let mutated = |mutate: &dyn Fn(&mut PrivateValueFixture)| {
        let mut fixture = private_value_fixture(&state, 1, 0x40, 0, Address::ZERO);
        mutate(&mut fixture);
        private_value_bytes(&fixture)
    };
    // The BN254 scalar field modulus `p`.
    let modulus =
        alloy_primitives::b256!("30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001");

    let cases = vec![
        rejection(
            "non-field output body",
            mutated(&|f| f.public_inputs[6] = NOT_IN_FIELD),
            None,
            TransactionOutcome::PublicInputNotInField,
            Some(FailureDetail::PublicInputNotInField {
                public_input_index: 6,
                supplied: NOT_IN_FIELD,
            }),
        ),
        // The field modulus itself is the smallest non-canonical word.
        rejection(
            "deadline equal to the modulus",
            mutated(&|f| f.public_inputs[S.valid_until_offset] = modulus),
            None,
            TransactionOutcome::PublicInputNotInField,
            Some(FailureDetail::PublicInputNotInField {
                public_input_index: S.valid_until_offset as u16,
                supplied: modulus,
            }),
        ),
        rejection(
            "zero nullifier",
            mutated(&|f| f.public_inputs[4] = word(0)),
            None,
            TransactionOutcome::ZeroNullifier,
            Some(FailureDetail::ZeroNullifier { input_slot: 2 }),
        ),
        // Two zero nullifiers are also duplicates; the zero check comes first.
        rejection(
            "two zero nullifiers",
            mutated(&|f| {
                f.public_inputs[3] = word(0);
                f.public_inputs[5] = word(0);
            }),
            None,
            TransactionOutcome::ZeroNullifier,
            Some(FailureDetail::ZeroNullifier { input_slot: 1 }),
        ),
        rejection(
            "duplicate nullifier",
            mutated(&|f| f.public_inputs[5] = f.public_inputs[3]),
            None,
            TransactionOutcome::DuplicateInputNullifier,
            Some(FailureDetail::DuplicateInputNullifier {
                first_input_slot: 1,
                duplicate_input_slot: 3,
                nullifier: tagged_word(0x04, 0x41),
            }),
        ),
    ];
    // prepare_block warms the three nullifier cases; its gates exclude nullifier checks.
    assert_rejections(&mut state, &rules, 1, cases, 3);
    assert!(!state.nullifier_seen(tagged_word(0x03, 0x40)).unwrap());
}

/// The secp256k1 group order `n`.
const SECP256K1_ORDER: CircuitWord =
    alloy_primitives::b256!("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

#[test]
fn user_account_creation_field_and_signature_errors_commit_their_exact_outcome() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let signing_key = SigningKey::from_slice(&[0x31u8; 32]).unwrap();
    let address = signer_address(&signing_key);
    let recent = state.canonical_tip().unwrap().hash;
    let deadline = ts_of(0) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let signed = SignedCreation::new(
        &signing_key,
        INBOX(),
        tagged_word(0x06, 0xaaaa),
        tagged_word(0x07, 1),
        None,
        recent,
        deadline,
    );
    // A malformed or non-canonical signature names no account, so its outcome
    // has no detail.
    let malformed = |name, signature: SignedCreation| {
        rejection(
            name,
            signature.bytes(),
            None,
            TransactionOutcome::InvalidAccountSignature,
            None,
        )
    };
    // `(r, n - s)` with the opposite parity recovers the same signer.
    let high_s = CircuitWord::from(
        (U256::from_be_bytes(SECP256K1_ORDER.0) - U256::from_be_bytes(signed.s.0))
            .to_be_bytes::<32>(),
    );
    // Validly signed, so the field checks are the first that fail.
    let noncanonical = |name, nullifier_key_commitment, rule_set_commitment, field, supplied| {
        rejection(
            name,
            signed_account_transaction(
                &signing_key,
                INBOX(),
                nullifier_key_commitment,
                rule_set_commitment,
                None,
                recent,
                deadline,
            ),
            Some(address),
            TransactionOutcome::NonCanonicalAccountField,
            Some(FailureDetail::NonCanonicalAccountField { field, supplied }),
        )
    };

    let cases = vec![
        malformed("zero r", signed.with(|c| c.r = word(0))),
        malformed("zero s", signed.with(|c| c.s = word(0))),
        malformed("r equal to n", signed.with(|c| c.r = SECP256K1_ORDER)),
        malformed("s equal to n", signed.with(|c| c.s = SECP256K1_ORDER)),
        malformed("r above n", signed.with(|c| c.r = NOT_IN_FIELD)),
        malformed(
            "high s",
            signed.with(|c| {
                c.s = high_s;
                c.y_parity ^= 1;
            }),
        ),
        // The signature is checked first.
        malformed(
            "zero s with non-field commitments and a stale block",
            signed.with(|c| {
                c.s = word(0);
                c.nullifier_key_commitment = NOT_IN_FIELD;
                c.rule_set = NOT_IN_FIELD;
                c.recent = tagged_word(0x08, 1);
                c.deadline = 0;
            }),
        ),
        noncanonical(
            "non-field nullifier-key commitment",
            NOT_IN_FIELD,
            tagged_word(0x07, 1),
            AccountField::NullifierKeyCommitment,
            NOT_IN_FIELD,
        ),
        noncanonical(
            "non-field rule-set commitment",
            tagged_word(0x06, 0xaaaa),
            NOT_IN_FIELD,
            AccountField::RuleSetCommitment,
            NOT_IN_FIELD,
        ),
        // The nullifier-key commitment is checked first.
        noncanonical(
            "both commitments non-field",
            NOT_IN_FIELD,
            NOT_IN_FIELD,
            AccountField::NullifierKeyCommitment,
            NOT_IN_FIELD,
        ),
        // Field canonicality precedes the named block and the deadline.
        rejection(
            "non-field commitment with a stale block and an expired deadline",
            SignedCreation::new(
                &signing_key,
                INBOX(),
                NOT_IN_FIELD,
                tagged_word(0x07, 1),
                None,
                tagged_word(0x08, 1),
                0,
            )
            .bytes(),
            Some(address),
            TransactionOutcome::NonCanonicalAccountField,
            Some(FailureDetail::NonCanonicalAccountField {
                field: AccountField::NullifierKeyCommitment,
                supplied: NOT_IN_FIELD,
            }),
        ),
    ];
    // Account creation carries no proof.
    assert_rejections(&mut state, &rules, 1, cases, 0);
    assert!(state.account_of(address).unwrap().is_none());
}

/// A zero nullifier-key commitment is a canonical field element. The
/// account it creates has no known opening, so nobody can operate it, but
/// the creation itself is valid.
#[test]
fn zero_nullifier_key_commitment_creates_a_user_account() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let signing_key = SigningKey::from_slice(&[0x31u8; 32]).unwrap();
    let address = signer_address(&signing_key);
    let creation = signed_account_transaction(
        &signing_key,
        INBOX(),
        word(0),
        tagged_word(0x07, 1),
        None,
        recent_pcash_block_hash(&state),
        ts_of(0) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS,
    );
    let block = block_with_batch(1, INBOX(), addr(0xf00), batch(&[creation]));
    let outcome = derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
    assert_eq!(item_results(&outcome), vec![SUCCEEDED]);
    let account = state.account_of(address).unwrap().unwrap();
    assert_eq!(
        account.nullifier_key_commitment,
        pcash_state::Fr::from(0u64)
    );
    assert_eq!(account.revision, 1);
}

#[test]
fn user_account_update_field_errors_and_missing_account_commit_their_exact_outcome() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let address = addr(0xacc0);
    let recent = state.canonical_tip().unwrap().hash;
    let deadline = ts_of(1) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let proof = vec![0u8; WIRE_PROOF_BYTES];
    let section = zero_fee_section(recent, 1, deadline, &proof);
    let update = |operation, account_update_commitment, section: &[u8]| {
        account_update_txbytes(
            address,
            tagged_word(0x07, 2),
            operation,
            account_update_commitment,
            section,
        )
    };

    let cases = vec![
        // The appended account update commitment is the update's last verifier word.
        rejection(
            "non-field account update commitment",
            update(pcash_derive::ReceiveKeyUpdate::Keep, NOT_IN_FIELD, &section),
            Some(address),
            TransactionOutcome::PublicInputNotInField,
            Some(FailureDetail::PublicInputNotInField {
                public_input_index: S.public_inputs as u16,
                supplied: NOT_IN_FIELD,
            }),
        ),
        rejection(
            "non-field rule-set commitment",
            account_update_txbytes(
                address,
                NOT_IN_FIELD,
                pcash_derive::ReceiveKeyUpdate::Keep,
                word(1),
                &section,
            ),
            Some(address),
            TransactionOutcome::NonCanonicalAccountField,
            Some(FailureDetail::NonCanonicalAccountField {
                field: AccountField::RuleSetCommitment,
                supplied: NOT_IN_FIELD,
            }),
        ),
        rejection(
            "no account at the address",
            update(pcash_derive::ReceiveKeyUpdate::Keep, word(1), &section),
            Some(address),
            TransactionOutcome::AccountNotFound,
            Some(FailureDetail::AccountNotFound { address }),
        ),
    ];
    // prepare_block warms the missing-account case; account lookup is a state check.
    assert_rejections(&mut state, &rules, 1, cases, 1);
    assert!(!state.nullifier_seen(tagged_word(0x0e, 17)).unwrap());
}

#[test]
fn contract_creation_body_errors_commit_their_exact_outcome_before_the_fee_section() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let recent = state.canonical_tip().unwrap().hash;
    let deadline = ts_of(1) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let proof = vec![0u8; WIRE_PROOF_BYTES];
    let section = zero_fee_section(recent, 1, deadline, &proof);
    let material = tagged_word(0x0c, 0xbeef);
    let contract = |material, functions: &[ContractFunctionFixture]| {
        contract_transaction(material, None, false, functions, &section)
    };
    let with_functions = |mutate: &dyn Fn(&mut Vec<ContractFunctionFixture>)| {
        let mut functions = sample_functions();
        mutate(&mut functions);
        contract(material, &functions)
    };
    let noncanonical = |name, transaction, field, function_index, supplied| {
        rejection(
            name,
            transaction,
            None,
            TransactionOutcome::NonCanonicalContractField,
            Some(FailureDetail::NonCanonicalContractField {
                field,
                function_index,
                supplied,
            }),
        )
    };
    let selectors = |name, first: u8, second: u8| {
        rejection(
            name,
            with_functions(&|f| {
                f[0].selector = first;
                f[1].selector = second;
            }),
            None,
            TransactionOutcome::SelectorsNotStrictlyIncreasing,
            Some(FailureDetail::SelectorsNotStrictlyIncreasing {
                previous_function_index: 0,
                previous_selector: first,
                function_index: 1,
                selector: second,
            }),
        )
    };

    let cases = vec![
        noncanonical(
            "non-field nullifier-key material",
            contract(NOT_IN_FIELD, &sample_functions()),
            ContractField::NullifierKeyMaterial,
            None,
            NOT_IN_FIELD,
        ),
        noncanonical(
            "non-field application VK hash",
            with_functions(&|f| f[1].application_vk_hash = NOT_IN_FIELD),
            ContractField::ApplicationVkHash,
            Some(1),
            NOT_IN_FIELD,
        ),
        noncanonical(
            "non-field configuration commitment",
            with_functions(&|f| f[0].configuration_commitment = NOT_IN_FIELD),
            ContractField::ConfigurationCommitment,
            Some(0),
            NOT_IN_FIELD,
        ),
        // Field canonicality of every function precedes selector ordering.
        noncanonical(
            "non-field word after misordered selectors",
            with_functions(&|f| {
                f[1].selector = 0;
                f[1].configuration_commitment = NOT_IN_FIELD;
            }),
            ContractField::ConfigurationCommitment,
            Some(1),
            NOT_IN_FIELD,
        ),
        rejection(
            "no functions",
            contract(material, &[]),
            None,
            TransactionOutcome::EmptyContractFunctionSet,
            None,
        ),
        selectors("repeated selector", 3, 3),
        selectors("descending selectors", 3, 0),
    ];
    assert_rejections(&mut state, &rules, 1, cases, 0);
    assert!(!state.nullifier_seen(tagged_word(0x0e, 17)).unwrap());
}

/// Zero nullifier-key material is canonical in both modes. A published root
/// of zero is one more public root; a private commitment of zero has no known
/// opening, so nobody can operate that contract. A private commitment equal
/// to the zero root's commitment is an ordinary commitment. Each creates its
/// contract, and the publication flag keeps the two equal commitments at
/// distinct addresses.
#[test]
fn zero_nullifier_key_material_creates_contracts_in_both_modes() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let recent = state.canonical_tip().unwrap().hash;
    let deadline = ts_of(1) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let proof = vec![0u8; WIRE_PROOF_BYTES];
    let zero = pcash_state::Fr::from(0u64);
    let zero_root_commitment = pcash_crypto::poseidon(&[
        pcash_crypto::domain_tags::NULLIFIER_KEY_COMMITMENT_DOMAIN,
        zero,
    ]);
    // (published root, material, the account's nullifier-key commitment)
    let cases = [
        (false, word(0), zero),
        (true, word(0), zero_root_commitment),
        (
            false,
            fr_to_bytes(zero_root_commitment),
            zero_root_commitment,
        ),
    ];
    let transactions: Vec<Vec<u8>> = cases
        .iter()
        .enumerate()
        .map(|(salt, &(published, material, _))| {
            let section = zero_fee_section(recent, 0x50 + salt as u64, deadline, &proof);
            contract_transaction(material, None, published, &sample_functions(), &section)
        })
        .collect();
    let addresses: Vec<Address> = transactions
        .iter()
        .map(|transaction| contract_body_check(transaction).address().unwrap())
        .collect();
    assert_ne!(addresses[1], addresses[2]);
    let block = block_with_batch(1, INBOX(), addr(0xf00), batch(&transactions));
    let outcome = derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
    assert_eq!(item_results(&outcome), vec![SUCCEEDED; 3]);
    for (address, (_, _, commitment)) in addresses.iter().zip(cases) {
        let account = state.account_of(*address).unwrap().unwrap();
        assert_eq!(account.nullifier_key_commitment, commitment);
        assert_eq!(account.kind, pcash_derive::ACCOUNT_KIND_CONTRACT);
    }
}

/// A selector byte outside its set, or a key whose presence disagrees with
/// its selector, leaves the item undecodable: it is not admitted, commits no
/// transaction result, and never reaches the verifier.
#[test]
fn selector_bytes_outside_their_sets_are_not_admitted() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let signing_key = SigningKey::from_slice(&[0x31u8; 32]).unwrap();
    let recent = recent_pcash_block_hash(&state);
    let deadline = ts_of(0) + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let keyless = signed_account_transaction(
        &signing_key,
        INBOX(),
        tagged_word(0x06, 0xaaaa),
        tagged_word(0x07, 1),
        None,
        recent,
        deadline,
    );
    let mut direct_keyed = account_txbytes(
        word(7),
        word(8),
        Some(&[0x5a; pcash_state::ML_KEM768_PUBLIC_KEY_LEN]),
        recent,
        deadline,
        CircuitWord::ZERO,
        CircuitWord::ZERO,
        0,
    );
    direct_keyed[5] = 0;
    direct_keyed.truncate(direct_keyed.len() - 65);
    let update = |operation| {
        account_update_txbytes(
            addr(0xacc0),
            tagged_word(0x07, 2),
            operation,
            word(1),
            &zero_fee_section(recent, 1, deadline, &vec![0u8; WIRE_PROOF_BYTES]),
        )
    };
    let keep = update(pcash_derive::ReceiveKeyUpdate::Keep);
    let replace = update(pcash_derive::ReceiveKeyUpdate::Replace(receive_key(0x6b)));
    let contract = contract_with_fee(&state, 0x100, 7, 0);
    let set = |transaction: &[u8], offset: usize, value: u8| {
        let mut changed = transaction.to_vec();
        changed[offset] = value;
        changed
    };
    // type ‖ chainId ‖ authorizationMode ‖ nullifier-key commitment ‖ rule-set commitment.
    let creation_mode = 1 + 4 + 1 + 32 + 32;
    let parity = keyless.len() - 1;
    // type ‖ chainId ‖ address ‖ rule-set commitment.
    let update_operation = 1 + 4 + 20 + 32;
    // type ‖ chainId ‖ fundingMode ‖ section, then publishesNkRoot ‖
    // nullifier-key material.
    let funding_mode = pcash_derive::FUNDING_MODE_OFFSET;
    let contract_flag = 1 + 4 + 1 + SectionLayout::ContractAccountCreation.section_bytes();
    let contract_mode = contract_flag + 1 + 32;

    use ItemExclusionReason::{
        TrailingBytes, Truncated, UnknownFundingMode, UnknownPublishesNkRootFlag,
        UnknownReceiveKeyMode, UnknownYParity,
    };
    let cases = [
        (
            "creation receive-key mode two",
            set(&keyless, creation_mode, 2),
            UnknownReceiveKeyMode,
        ),
        (
            "creation receive-key mode 0xff",
            set(&keyless, creation_mode, 0xff),
            UnknownReceiveKeyMode,
        ),
        (
            "creation present without a key",
            set(&keyless, creation_mode, pcash_derive::RECEIVE_KEY_PRESENT),
            Truncated,
        ),
        (
            "direct creation absent with a key",
            set(
                &direct_keyed,
                creation_mode,
                pcash_derive::RECEIVE_KEY_ABSENT,
            ),
            TrailingBytes,
        ),
        ("parity two", set(&keyless, parity, 2), UnknownYParity),
        // Ethereum's legacy `v` encoding is not a parity bit.
        ("legacy v", set(&keyless, parity, 27), UnknownYParity),
        ("parity 0xff", set(&keyless, parity, 0xff), UnknownYParity),
        (
            "update operation three",
            set(&keep, update_operation, 3),
            UnknownReceiveKeyMode,
        ),
        (
            "update operation 0xff",
            set(&keep, update_operation, 0xff),
            UnknownReceiveKeyMode,
        ),
        (
            "replace without a key",
            set(
                &keep,
                update_operation,
                pcash_derive::RECEIVE_KEY_UPDATE_REPLACE,
            ),
            Truncated,
        ),
        (
            "keep with a key",
            set(
                &replace,
                update_operation,
                pcash_derive::RECEIVE_KEY_UPDATE_KEEP,
            ),
            TrailingBytes,
        ),
        (
            "funding mode two",
            set(&contract, funding_mode, 2),
            UnknownFundingMode,
        ),
        (
            "funding mode 0xff",
            set(&contract, funding_mode, 0xff),
            UnknownFundingMode,
        ),
        (
            "publishesNkRoot two",
            set(&contract, contract_flag, 2),
            UnknownPublishesNkRootFlag,
        ),
        (
            "publishesNkRoot 0xff",
            set(&contract, contract_flag, 0xff),
            UnknownPublishesNkRootFlag,
        ),
        (
            "contract receive-key mode two",
            set(&contract, contract_mode, 2),
            UnknownReceiveKeyMode,
        ),
    ];
    let verifier = StubVerifier::accept();
    for (name, transaction, reason) in &cases {
        assert_eq!(
            validate_raw_item(
                &state,
                &rules,
                &verifier,
                ts_of(1),
                addr(0xf00),
                transaction
            )
            .unwrap(),
            ItemResult::Excluded(*reason),
            "{name}"
        );
    }
    let raw_items = cases
        .iter()
        .map(|(_, transaction, _)| transaction.clone())
        .collect::<Vec<_>>();
    let outcome = derive_block(
        &mut state,
        &block_with_batch(1, INBOX(), addr(0xf00), batch(&raw_items)),
        &rules,
        &verifier,
    )
    .unwrap();
    let items = &outcome.committed_boundary.history.l1_delivery_batches[0].items;
    assert_eq!(items.len(), cases.len());
    for ((name, _, reason), item) in cases.iter().zip(items) {
        assert_eq!(item.exclusion_reason, Some(*reason), "{name}");
    }
    assert!(outcome.transaction_effects.is_empty());
    assert!(outcome
        .committed_boundary
        .block
        .transaction_results
        .is_empty());
    assert_eq!(verifier.calls.get(), 0);
    assert_eq!(state.account_count(), 0);
}
