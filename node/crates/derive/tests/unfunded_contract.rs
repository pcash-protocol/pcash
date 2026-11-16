#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]
//! Contract-account creation in its standalone and attached forms: the unfunded codec and
//! lifetime, and the derivation rules the modes share or that differ between
//! them.

mod common;
use common::*;

use alloy_primitives::{Address, B256, U256};
use pcash_derive::private_value_profiles::PrivateValueShape;
use pcash_derive::{
    derive_block, derive_prepared_block, prepare_block, ParseError, SectionLayout, Transaction,
    CONTRACT_MAX_BODY_BYTES, KIND_CONTRACT_ACCOUNT_CREATION, MAX_TX_BYTES,
    ML_KEM768_PUBLIC_KEY_LEN, RECEIVE_KEY_ABSENT, RECEIVE_KEY_PRESENT, WIRE_PROOF_BYTES,
};
use pcash_state::{
    content_hash, fr_to_bytes, AccountResult, CircuitWord, FailureDetail, FailureDetailSeed,
    ItemExclusionReason, RejectedEffects, StateDb, TransactionEffects, TransactionOutcome,
    RECENT_PCASH_BLOCK_WINDOW_SECONDS,
};
use pcash_verify::CachedVerifier;

const INBOX: fn() -> Address = || addr(0x5043_5348);
const FROZEN_ADDRESS: &str = "0x00b4c38cdda10658734731fdde9d0bc225043b4c";

fn initialize(rules: &pcash_derive::ProtocolRules) -> pcash_state::MemState {
    let mut state = mem_state(source(INBOX()));
    derive_block(
        &mut state,
        &block_with_txs(0, vec![]),
        rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    state
}

fn body(publishes_nk_root: bool, key: Option<&[u8]>, function_count: u8) -> Vec<u8> {
    let mut body = vec![u8::from(publishes_nk_root)];
    body.extend_from_slice(word(1).as_slice());
    if let Some(key) = key {
        body.push(RECEIVE_KEY_PRESENT);
        body.extend_from_slice(key);
    } else {
        body.push(RECEIVE_KEY_ABSENT);
    }
    body.push(function_count);
    for selector in 0..function_count {
        body.push(selector);
        body.extend_from_slice(word(2).as_slice());
        body.extend_from_slice(word(3).as_slice());
    }
    body
}

fn frozen_body() -> Vec<u8> {
    let mut body = vec![0];
    body.extend_from_slice(word(0x11).as_slice());
    // No receive key, two functions.
    body.extend_from_slice(&[RECEIVE_KEY_ABSENT, 2]);
    for (selector, vk, config) in [(1u8, 0x22, 0x33), (5, 0x44, 0x55)] {
        body.push(selector);
        body.extend_from_slice(word(vk).as_slice());
        body.extend_from_slice(word(config).as_slice());
    }
    body
}

fn unfunded(body: &[u8], recent: CircuitWord, deadline: u64) -> Vec<u8> {
    unfunded_contract_txbytes(body, recent, deadline)
}

/// Section words for a attachment that pays `fee` on the open route from the
/// notes `salt` names, with no not-before bound.
fn fee_words(recent: CircuitWord, salt: u64, fee: u64, deadline: u64) -> Vec<CircuitWord> {
    section_words(recent, salt, fee, Address::ZERO, 0, deadline)
}

fn attached(body: &[u8], words: &[CircuitWord]) -> Vec<u8> {
    attached_contract_txbytes(
        body,
        &private_value_section(
            words,
            &vec![0; WIRE_PROOF_BYTES],
            &[DUMMY_OUTPUT_DATA.as_slice(); 5],
        ),
    )
}

/// The result of an unfunded creation, which never reaches a verifier.
fn status(
    state: &impl StateDb,
    rules: &pcash_derive::ProtocolRules,
    timestamp: u64,
    raw: &[u8],
) -> ItemResult {
    let verifier = StubVerifier::reject();
    let result = validate_raw_item(state, rules, &verifier, timestamp, addr(0xf00), raw).unwrap();
    assert_eq!(verifier.calls.get(), 0);
    result
}

fn frozen_address() -> Address {
    FROZEN_ADDRESS.parse().unwrap()
}

#[test]
fn unfunded_wire_is_fixed_and_body_address_is_frozen() {
    let raw = unfunded(&frozen_body(), word(4), 5);
    assert_eq!(raw.len(), 210);
    assert_eq!(hex::encode(&raw), "025043534800000000000000000000000000000000000000000000000000000000000000040000000000000005000000000000000000000000000000000000000000000000000000000000000011000201000000000000000000000000000000000000000000000000000000000000002200000000000000000000000000000000000000000000000000000000000000330500000000000000000000000000000000000000000000000000000000000000440000000000000000000000000000000000000000000000000000000000000055");
    let Transaction::ContractAccountCreation(creation) =
        Transaction::decode(&raw, PCASH_CHAIN_ID).unwrap()
    else {
        panic!("contract creation")
    };
    assert_eq!(
        Transaction::decode(&raw, PCASH_CHAIN_ID + 1),
        Err(ParseError::WrongChainId(PCASH_CHAIN_ID))
    );
    assert_eq!(creation.recent_pcash_block_hash, word(4));
    assert_eq!(creation.valid_until_timestamp, 5);
    let check = contract_body_check(&raw);
    assert_eq!(check.address().unwrap(), frozen_address());
    assert_eq!(
        check.nullifier_key_commitment().unwrap(),
        field_element(word(0x11))
    );
    // The publication lifetime and enclosing transaction do not enter the address.
    let reanchored = unfunded(&frozen_body(), word(6), 7);
    let paid = attached(&frozen_body(), &fee_words(word(4), 7, 5, 5));
    for other in [&reanchored, &paid] {
        assert_eq!(
            contract_body_check(other).address().unwrap(),
            frozen_address()
        );
        assert_ne!(content_hash(&raw), content_hash(other));
    }
}

#[test]
fn unfunded_parsing_consumes_exactly_its_shape_and_rejects_unknown_selectors() {
    let raw = unfunded(&body(false, None, 1), word(4), 5);
    assert!(Transaction::decode(&raw, PCASH_CHAIN_ID).is_ok());
    for len in 1..raw.len() {
        assert_eq!(
            Transaction::decode(&raw[..len], PCASH_CHAIN_ID),
            Err(ParseError::Truncated),
            "length {len}"
        );
    }
    let mut trailing = raw.clone();
    trailing.push(0);
    assert_eq!(
        Transaction::decode(&trailing, PCASH_CHAIN_ID),
        Err(ParseError::Trailing)
    );
    // type ‖ chainId ‖ recent block ‖ deadline, then
    // publishesNkRoot ‖ nullifier-key material ‖ receive-key mode.
    for (offset, error) in [
        (45, ParseError::UnknownPublishesNkRootFlag(2)),
        (78, ParseError::UnknownReceiveKeyMode(2)),
    ] {
        let mut invalid = raw.clone();
        invalid[offset] = 2;
        assert_eq!(Transaction::decode(&invalid, PCASH_CHAIN_ID), Err(error));
    }
    let maximum = unfunded(
        &body(true, Some(&vec![0x6a; ML_KEM768_PUBLIC_KEY_LEN]), u8::MAX),
        word(4),
        5,
    );
    assert_eq!(maximum.len(), 17_839);
    assert_eq!(maximum.len(), 45 + CONTRACT_MAX_BODY_BYTES);
    assert!(maximum.len() < MAX_TX_BYTES);
    assert!(Transaction::decode(&maximum, PCASH_CHAIN_ID).is_ok());
}

/// Truncations, trailing bytes, and unassigned attachment tags leave
/// an item undecodable in either mode: it is excluded, commits no transaction
/// result, and reaches no verifier.
#[test]
fn malformed_creations_of_either_mode_are_excluded_without_admitting_an_item() {
    use ItemExclusionReason::{TrailingBytes, Truncated, UnknownAccountCreationTag};
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let recent = state.canonical_tip().unwrap().hash;
    let body = body(false, None, 1);
    let free = unfunded(&body, recent, ts_of(1));
    let paid = attached(&body, &fee_words(recent, 7, 0, ts_of(1)));
    let with_mode = |raw: &[u8], mode: u8| {
        let mut changed = raw.to_vec();
        changed[6 + SectionLayout::PrivateValue(PrivateValueShape::S).section_bytes()] = mode;
        changed
    };

    let mut free_items = (1..free.len())
        .map(|len| (free[..len].to_vec(), Truncated))
        .collect::<Vec<_>>();
    free_items.push(([free.as_slice(), &[0]].concat(), TrailingBytes));

    // Each boundary of the attached layout: envelope, profile, section
    // words, proof, output data, and body.
    let section_end = 6 + SectionLayout::PrivateValue(PrivateValueShape::S).section_bytes();
    let proof_start = 6 + 14 * 32;
    let mut paid_items = [
        1,
        5,
        6,
        38,
        proof_start,
        proof_start + WIRE_PROOF_BYTES,
        section_end - 1,
        section_end,
        section_end + 1,
        paid.len() - 1,
    ]
    .into_iter()
    .map(|len| (paid[..len].to_vec(), Truncated))
    .collect::<Vec<_>>();
    paid_items.push(([paid.as_slice(), &[0]].concat(), TrailingBytes));
    paid_items.extend([3, 0xff].map(|mode| (with_mode(&paid, mode), UnknownAccountCreationTag)));

    // Every unassigned mode of a attached creation is refused by admission.
    let verifier = StubVerifier::accept();
    let unknown_paid = (3..=u8::MAX)
        .map(|mode| with_mode(&paid, mode))
        .collect::<Vec<_>>();
    assert_eq!(
        validate_raw_items(
            &state,
            &rules,
            &verifier,
            ts_of(1),
            addr(0xf00),
            &unknown_paid
        )
        .unwrap(),
        vec![ItemResult::Excluded(UnknownAccountCreationTag); 253]
    );

    let calldata = |items: &[(Vec<u8>, ItemExclusionReason)]| {
        batch(&items.iter().map(|(raw, _)| raw.clone()).collect::<Vec<_>>())
    };
    let block = block_with_txs(
        1,
        vec![
            (addr(0xf00), Some(INBOX()), calldata(&free_items)),
            (addr(0xf00), Some(INBOX()), calldata(&paid_items)),
        ],
    );
    let outcome = derive_block(&mut state, &block, &rules, &verifier).unwrap();
    assert_eq!(
        item_results(&outcome),
        free_items
            .iter()
            .chain(&paid_items)
            .map(|(_, reason)| ItemResult::Excluded(*reason))
            .collect::<Vec<_>>()
    );
    assert!(outcome.transaction_effects.is_empty());
    assert!(outcome
        .committed_boundary
        .block
        .transaction_results
        .is_empty());
    assert_eq!(verifier.calls.get(), 0);
    assert_eq!(state.account_count(), 0);
    assert_eq!(state.output_count(), 0);
}

#[test]
fn unfunded_deadline_and_recent_block_boundaries_use_creation_outcomes() {
    let rules = stub_rules();
    let state = initialize(&rules);
    let recent = state.canonical_tip().unwrap().hash;
    let body = body(false, None, 1);
    let end = ts_of(0) + RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let cases = [
        (ts_of(1), recent, ts_of(1), SUCCEEDED),
        (
            ts_of(1),
            recent,
            ts_of(1) - 1,
            ItemResult::Admitted(TransactionOutcome::Expired),
        ),
        (
            ts_of(1),
            recent,
            0,
            ItemResult::Admitted(TransactionOutcome::Expired),
        ),
        (end, recent, end, SUCCEEDED),
        (
            end + 1,
            recent,
            end + 1,
            ItemResult::Admitted(TransactionOutcome::RecentPcashBlockNotInWindow),
        ),
        // A deadline past the named block's window is accepted while the
        // block is in the window, and the window still ends its usable life.
        (ts_of(1), recent, end + 1, SUCCEEDED),
        (ts_of(1), recent, u64::MAX, SUCCEEDED),
        (end, recent, u64::MAX, SUCCEEDED),
        (
            end + 1,
            recent,
            u64::MAX,
            ItemResult::Admitted(TransactionOutcome::RecentPcashBlockNotInWindow),
        ),
        (
            ts_of(1),
            word(0),
            0,
            ItemResult::Admitted(TransactionOutcome::RecentPcashBlockNotInWindow),
        ),
        (
            ts_of(1),
            word(9),
            end,
            ItemResult::Admitted(TransactionOutcome::RecentPcashBlockNotInWindow),
        ),
    ];
    for (timestamp, recent, deadline, expected) in cases {
        assert_eq!(
            status(
                &state,
                &rules,
                timestamp,
                &unfunded(&body, recent, deadline)
            ),
            expected
        );
    }
    assert_eq!(
        status(&state, &rules, ts_of(0) - 1, &unfunded(&body, recent, end)),
        ItemResult::Admitted(TransactionOutcome::RecentPcashBlockNotInWindow)
    );
    let mut future = initialize(&rules);
    derive_block(
        &mut future,
        &block_with_txs(1, vec![]),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    let uncommitted_here = future.canonical_tip().unwrap().hash;
    assert_eq!(
        status(
            &state,
            &rules,
            ts_of(1),
            &unfunded(&body, uncommitted_here, end)
        ),
        ItemResult::Admitted(TransactionOutcome::RecentPcashBlockNotInWindow)
    );
    let mut wrong_chain = unfunded(&body, recent, end);
    wrong_chain[1..5].copy_from_slice(&(PCASH_CHAIN_ID + 1).to_be_bytes());
    assert_eq!(
        status(&state, &rules, ts_of(1), &wrong_chain),
        ItemResult::Excluded(ItemExclusionReason::WrongChainId)
    );
}

#[test]
fn attached_not_before_and_expiry_boundaries_are_inclusive() {
    let rules = stub_rules();
    let state = initialize(&rules);
    let recent = state.canonical_tip().unwrap().hash;
    let body = body(false, None, 1);
    let end = ts_of(0) + RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let paid = |not_before, valid_until| {
        attached(
            &body,
            &section_words(recent, 7, 0, Address::ZERO, not_before, valid_until),
        )
    };
    let not_yet_valid = ItemResult::Admitted(TransactionOutcome::NotYetValid);
    let expired = ItemResult::Admitted(TransactionOutcome::Expired);
    let not_in_window = ItemResult::Admitted(TransactionOutcome::RecentPcashBlockNotInWindow);
    let (not_before, valid_until) = (ts_of(1) + 10, ts_of(1) + 100);
    let cases = [
        (paid(not_before, valid_until), not_before - 1, not_yet_valid),
        (paid(not_before, valid_until), not_before, SUCCEEDED),
        (paid(not_before, valid_until), valid_until, SUCCEEDED),
        (paid(not_before, valid_until), valid_until + 1, expired),
        // One valid instant.
        (paid(ts_of(1), ts_of(1)), ts_of(1) - 1, not_yet_valid),
        (paid(ts_of(1), ts_of(1)), ts_of(1), SUCCEEDED),
        (paid(ts_of(1), ts_of(1)), ts_of(1) + 1, expired),
        // A deadline past the named block's window.
        (paid(0, u64::MAX), end, SUCCEEDED),
        (paid(0, u64::MAX), end + 1, not_in_window),
    ];
    let verifier = StubVerifier::accept();
    for (raw, timestamp, expected) in &cases {
        assert_eq!(
            validate_raw_item(&state, &rules, &verifier, *timestamp, addr(0xf00), raw).unwrap(),
            *expected,
            "timestamp {timestamp}"
        );
    }
    let accepted = cases
        .iter()
        .filter(|(_, _, expected)| *expected == SUCCEEDED)
        .count();
    assert_eq!(verifier.calls.get(), accepted);
}

#[test]
fn unfunded_body_failures_precede_invalid_timing_and_leave_no_effects() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    // publishesNkRoot ‖ material ‖ receive-key mode ‖ function count, then
    // each function's selector ‖ vk hash ‖ configuration.
    let mut material = body(false, None, 0);
    material[1..33].fill(0xff);
    let mut function = body(false, None, 1);
    function[36..68].fill(0xff);
    let mut duplicate = body(false, None, 2);
    duplicate[100] = 0;
    let cases = [
        (material, TransactionOutcome::NonCanonicalContractField),
        (function, TransactionOutcome::NonCanonicalContractField),
        (
            body(false, None, 0),
            TransactionOutcome::EmptyContractFunctionSet,
        ),
        (
            duplicate,
            TransactionOutcome::SelectorsNotStrictlyIncreasing,
        ),
    ];
    let items: Vec<_> = cases
        .iter()
        .map(|(body, _)| unfunded(body, word(0), 0))
        .collect();
    let block = block_with_batch(1, INBOX(), addr(0xf00), batch(&items));
    let verifier = StubVerifier::reject();
    let outcome = derive_block(&mut state, &block, &rules, &verifier).unwrap();
    assert_eq!(
        item_results(&outcome),
        cases
            .iter()
            .map(|(_, expected)| ItemResult::Admitted(*expected))
            .collect::<Vec<_>>()
    );
    assert_eq!(outcome.transaction_effects.len(), cases.len());
    // A body that fails a static check addresses no account.
    for effects in &outcome.transaction_effects {
        assert!(matches!(
            effects,
            TransactionEffects::Rejected(RejectedEffects { account: None, .. })
        ));
    }
    assert_eq!(state.account_count(), 0);
    assert_eq!(state.output_count(), 0);
    assert_eq!(verifier.calls.get(), 0);
}

/// Inputs that break more than one rule commit the outcome of the first check
/// in the shared order: attached section canonicality, the body, its address,
/// timing, then the attachment's payment and proof. Account capacity, between
/// the address and timing, is covered by the engine's unit test
/// `unfunded_account_capacity_precedes_timing`.
#[test]
fn the_first_failed_check_decides_in_both_modes() {
    use TransactionOutcome::{
        ContractAddressExists, EmptyContractFunctionSet, Expired, NotYetValid,
        NullifierAlreadySpent, ProofRejected, PublicInputNotInField, RecentPcashBlockNotInWindow,
        ZeroNullifier,
    };
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let genesis = state.canonical_tip().unwrap().hash;
    // Block 1 creates the contract at `existing`'s address and spends the
    // attachment notes of `spent`.
    let existing = body(false, None, 1);
    let spent = fee_words(genesis, 7, 0, ts_of(1));
    let setup = derive_block(
        &mut state,
        &block_with_batch(
            1,
            INBOX(),
            addr(0xf00),
            batch(&[
                unfunded(&existing, genesis, ts_of(1)),
                attached(&body(false, None, 2), &spent),
            ]),
        ),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    assert_eq!(item_results(&setup), vec![SUCCEEDED; 2]);

    let recent = state.canonical_tip().unwrap().hash;
    let timestamp = ts_of(2);
    let (live, past) = (timestamp + 60, timestamp - 1);
    let fresh = body(false, None, 3);
    let bad = body(false, None, 0);
    let noncanonical = CircuitWord::repeat_byte(0xff);
    let unknown = word(9);
    let words = |salt, not_before, valid_until| {
        section_words(recent, salt, 0, Address::ZERO, not_before, valid_until)
    };
    let set = |mut words: Vec<CircuitWord>, index: usize, value: CircuitWord| {
        words[index] = value;
        words
    };
    let cases = [
        // Section canonicality precedes the body and the address.
        (
            "attached noncanonical recent hash, bad body",
            attached(&bad, &set(words(20, 0, live), 1, noncanonical)),
            PublicInputNotInField,
        ),
        (
            "attached noncanonical recent hash, existing address",
            attached(&existing, &set(words(21, 0, live), 1, noncanonical)),
            PublicInputNotInField,
        ),
        // An unfunded recent hash is only compared with committed block
        // hashes, after the body and the address.
        (
            "unfunded noncanonical recent hash",
            unfunded(&fresh, noncanonical, live),
            RecentPcashBlockNotInWindow,
        ),
        (
            "unfunded noncanonical recent hash, bad body",
            unfunded(&bad, noncanonical, live),
            EmptyContractFunctionSet,
        ),
        (
            "unfunded noncanonical recent hash, existing address",
            unfunded(&existing, noncanonical, live),
            ContractAddressExists,
        ),
        // The body and the address precede timing.
        (
            "unfunded expired, bad body",
            unfunded(&bad, recent, past),
            EmptyContractFunctionSet,
        ),
        (
            "attached expired, bad body",
            attached(&bad, &words(22, 0, past)),
            Expired,
        ),
        (
            "unfunded expired, existing address",
            unfunded(&existing, recent, past),
            ContractAddressExists,
        ),
        (
            "unfunded unknown block, existing address",
            unfunded(&existing, unknown, live),
            ContractAddressExists,
        ),
        (
            "attached expired, existing address",
            attached(&existing, &words(23, 0, past)),
            Expired,
        ),
        (
            "attached unknown block, existing address",
            attached(&existing, &set(words(24, 0, live), 1, unknown)),
            RecentPcashBlockNotInWindow,
        ),
        (
            "attached not yet valid, existing address",
            attached(&existing, &words(25, timestamp + 1, live)),
            NotYetValid,
        ),
        // Timing precedes the attachment's payment and proof.
        (
            "attached unknown block, duplicate nullifier",
            attached(&fresh, &{
                let misanchored = set(words(26, 0, live), 1, unknown);
                set(misanchored.clone(), 3, misanchored[2])
            }),
            RecentPcashBlockNotInWindow,
        ),
        (
            "attached expired, zero nullifier",
            attached(&fresh, &set(words(27, 0, past), 2, word(0))),
            Expired,
        ),
        (
            "attached expired, spent nullifier",
            attached(&fresh, &set(words(28, 0, past), 2, spent[2])),
            Expired,
        ),
        (
            "attached not yet valid, rejected proof",
            attached(&fresh, &words(29, timestamp + 1, live)),
            NotYetValid,
        ),
        // Each payment failure on its own.
        (
            "attached zero nullifier",
            attached(&fresh, &set(words(30, 0, live), 2, word(0))),
            ZeroNullifier,
        ),
        (
            "attached spent nullifier",
            attached(&fresh, &set(words(31, 0, live), 2, spent[2])),
            NullifierAlreadySpent,
        ),
        (
            "attached rejected proof",
            attached(&fresh, &words(32, 0, live)),
            ProofRejected,
        ),
    ];
    let verifier = StubVerifier::reject();
    for (name, raw, expected) in &cases {
        assert_eq!(
            validate_raw_item(&state, &rules, &verifier, timestamp, addr(0xf00), raw).unwrap(),
            ItemResult::Admitted(*expected),
            "{name}"
        );
    }
    // Only the last case reaches its proof.
    assert_eq!(verifier.calls.get(), 1);
}

#[test]
fn both_key_forms_and_receive_key_states_create_without_proofs_fees_or_issuance() {
    for published in [false, true] {
        for key in [None, Some(vec![0x6a; ML_KEM768_PUBLIC_KEY_LEN])] {
            let rules = stub_rules();
            let mut state = initialize(&rules);
            let recent = state.canonical_tip().unwrap().hash;
            let raw = unfunded(&body(published, key.as_deref(), 2), recent, ts_of(1));
            let check = contract_body_check(&raw);
            let address = check.address().unwrap();
            let expected_nk = fr_to_bytes(check.nullifier_key_commitment().unwrap());
            let verifier = StubVerifier::reject();
            let block =
                block_with_batch(1, INBOX(), addr(0xf00), batch(std::slice::from_ref(&raw)));
            let outcome = derive_block(&mut state, &block, &rules, &verifier).unwrap();
            assert_eq!(item_results(&outcome), vec![SUCCEEDED]);
            let TransactionEffects::Accepted(effects) = &outcome.transaction_effects[0] else {
                panic!("accepted effects")
            };
            assert_eq!(effects.kind, KIND_CONTRACT_ACCOUNT_CREATION);
            assert!(effects.nullifiers.is_empty());
            assert!(effects.output_commitments.is_empty());
            assert!(effects.output_leaf_start.is_none());
            assert!(effects.payout.is_none());
            let Some(AccountResult::Contract {
                address: written,
                nullifier_key_commitment,
                ..
            }) = &effects.account
            else {
                panic!("contract material")
            };
            assert_eq!(*written, address);
            assert_eq!(*nullifier_key_commitment, expected_nk);
            let account = state.account_of(address).unwrap().unwrap();
            assert_eq!(account.kind, 1);
            assert_eq!(account.revision, 1);
            assert_eq!(account.index, 0);
            assert_eq!(
                account.receive_key_hash,
                key.as_ref()
                    .map_or(B256::ZERO, |key| pcash_state::receive_key_hash(key))
            );
            assert_eq!(state.output_count(), 0);
            assert_eq!(verifier.calls.get(), 0);
            let history = &outcome.committed_boundary.history;
            assert!(history.payouts.is_empty());
            assert_eq!(history.economics.qualifying_actions, 0);
            assert_eq!(history.economics.open_fees_total, U256::ZERO);
            assert_eq!(history.economics.issuance_total, U256::ZERO);
            assert_eq!(
                outcome.committed_boundary.block.transaction_bytes,
                vec![raw]
            );
        }
    }
}

#[test]
fn attachment_succeeds_before_or_after_standalone_creation() {
    for unfunded_first in [false, true] {
        let rules = stub_rules();
        let mut state = initialize(&rules);
        let recent = state.canonical_tip().unwrap().hash;
        let body = body(false, None, 2);
        let free = unfunded(&body, recent, ts_of(1));
        let paid = attached(&body, &fee_words(recent, 7, 5, ts_of(1)));
        let items = if unfunded_first {
            vec![free, paid]
        } else {
            vec![paid, free]
        };
        let outcome = derive_block(
            &mut state,
            &block_with_batch(1, INBOX(), addr(0xf00), batch(&items)),
            &rules,
            &StubVerifier::accept(),
        )
        .unwrap();
        assert_eq!(
            item_results(&outcome),
            if unfunded_first {
                vec![SUCCEEDED, SUCCEEDED]
            } else {
                vec![
                    SUCCEEDED,
                    ItemResult::Admitted(TransactionOutcome::ContractAddressExists),
                ]
            }
        );
        assert_eq!(state.account_count(), 1);
        assert!(state.nullifier_seen(tagged_word(0x0e, 7 * 16 + 1)).unwrap());
        let economics = &outcome.committed_boundary.history.economics;
        assert_eq!(economics.open_fees_total, U256::from(5));
        assert_eq!(economics.qualifying_actions, 1);
        assert_eq!(economics.issuance_total, economics.reward_each);
        assert_eq!(outcome.committed_boundary.history.payouts.len(), 2);
        assert_eq!(state.output_count(), 7);
    }
}

#[test]
fn prepared_and_direct_execution_agree_for_unfunded_creations_and_failures() {
    let rules = stub_rules();
    let mut direct_state = initialize(&rules);
    let mut prepared_state = initialize(&rules);
    let recent = direct_state.canonical_tip().unwrap().hash;
    let contract_body = body(true, Some(&vec![0x6a; ML_KEM768_PUBLIC_KEY_LEN]), 2);
    let accepted = unfunded(&contract_body, recent, ts_of(1));
    let expired = unfunded(&body(false, None, 1), recent, ts_of(1) - 1);
    let far_deadline = unfunded(
        &body(false, None, 1),
        recent,
        ts_of(0) + RECENT_PCASH_BLOCK_WINDOW_SECONDS + 1,
    );
    let block = block_with_batch(
        1,
        INBOX(),
        addr(0xf00),
        batch(&[accepted.clone(), accepted, expired, far_deadline]),
    );
    let verifier = StubVerifier::reject();
    let direct = derive_block(&mut direct_state, &block, &rules, &verifier).unwrap();
    let prepared = prepare_block(&block, &rules, &source(INBOX()), &verifier);
    let cached = CachedVerifier::new_complete(prepared.cache(), &verifier);
    let prepared_outcome = derive_prepared_block(&mut prepared_state, &prepared, &cached).unwrap();
    assert_eq!(
        direct.committed_boundary,
        prepared_outcome.committed_boundary
    );
    assert_eq!(
        direct.transaction_effects,
        prepared_outcome.transaction_effects
    );
    assert_eq!(
        item_results(&direct),
        vec![
            SUCCEEDED,
            ItemResult::Admitted(TransactionOutcome::ContractAddressExists),
            ItemResult::Admitted(TransactionOutcome::Expired),
            SUCCEEDED,
        ]
    );
    assert_eq!(verifier.calls.get(), 0);
    // The expired creation addresses the account the later creation of the
    // same body writes.
    let written = direct.transaction_effects[3]
        .accepted()
        .and_then(|effects| effects.account.as_ref())
        .unwrap()
        .address();
    assert_eq!(
        direct.transaction_effects[2],
        TransactionEffects::Rejected(RejectedEffects {
            account: Some(written),
            detail: Some(FailureDetailSeed::Complete(FailureDetail::Expired {
                valid_until: U256::from(ts_of(1) - 1),
                block_timestamp: ts_of(1)
            })),
        })
    );
}

/// Prewarming and execution verify only attached creations, and a block that
/// pays issuance for a transfer pays none for a creation in either mode.
#[test]
fn attached_creation_verifies_and_earns_one_ordinary_issuance_share() {
    let rules = stub_rules();
    let mut direct_state = initialize(&rules);
    let mut prepared_state = initialize(&rules);
    let recent = direct_state.canonical_tip().unwrap().hash;
    let deadline = ts_of(1);
    let transfer = transfer_txbytes(
        &fee_words(recent, 0x50, 0, deadline),
        &stub_proof(SectionLayout::PrivateValue(PrivateValueShape::S), &[]),
        &[DUMMY_OUTPUT_DATA.as_slice(); 5],
    );
    let items = vec![
        unfunded(&body(false, None, 1), recent, deadline),
        attached(&body(false, None, 2), &fee_words(recent, 0x51, 5, deadline)),
        attached(&body(false, None, 3), &fee_words(recent, 0x52, 0, deadline)),
        unfunded(&body(true, None, 1), recent, deadline),
        transfer,
    ];
    let block = block_with_batch(1, INBOX(), addr(0xf00), batch(&items));

    // The two attached creations and the transfer.
    let verifier = StubVerifier::accept();
    let prepared = prepare_block(&block, &rules, &source(INBOX()), &verifier);
    assert_eq!(verifier.calls.get(), 3);
    let cached = CachedVerifier::new_complete(prepared.cache(), &verifier);
    let outcome = derive_prepared_block(&mut prepared_state, &prepared, &cached).unwrap();
    assert_eq!(verifier.calls.get(), 3);
    let direct_verifier = StubVerifier::accept();
    let direct = derive_block(&mut direct_state, &block, &rules, &direct_verifier).unwrap();
    assert_eq!(direct_verifier.calls.get(), 3);
    assert_eq!(direct.committed_boundary, outcome.committed_boundary);

    assert_eq!(item_results(&outcome), vec![SUCCEEDED; 5]);
    assert_eq!(prepared_state.account_count(), 4);
    let economics = &outcome.committed_boundary.history.economics;
    assert_eq!(economics.qualifying_actions, 3);
    assert!(!economics.reward_each.is_zero());
    assert_eq!(
        economics.issuance_total,
        economics.reward_each * U256::from(3)
    );
    assert_eq!(economics.open_fees_total, U256::from(5));
    let payouts = &outcome.committed_boundary.history.payouts;
    assert_eq!(payouts.len(), 2);
    assert_eq!(payouts[0].result_components().0, U256::from(5));
    assert_eq!(payouts[0].result_components().1, U256::ZERO);
    assert_eq!(payouts[1].result_components().0, U256::ZERO);
    assert_eq!(
        payouts[1].result_components().1,
        economics.reward_each * U256::from(3)
    );
    assert_eq!(payouts[1].output_index, payouts[0].output_index + 1);
    assert_eq!(payouts[1].owner_commitment, payouts[0].owner_commitment);
    assert_eq!(payouts[1].source, payouts[0].source);
    assert_eq!(payouts[1].contexts, payouts[0].contexts);
}

#[test]
fn unfunded_creation_rejects_an_orphaned_reference() {
    let rules = stub_rules();
    let mut original = initialize(&rules);
    let mut alternate = initialize(&rules);
    derive_block(
        &mut original,
        &block_with_txs(1, vec![]),
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    let orphan = original.canonical_tip().unwrap().hash;
    let mut replacement = block_with_txs(1, vec![]);
    replacement.header.hash = B256::from([0xcc; 32]);
    derive_block(
        &mut alternate,
        &replacement,
        &rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    assert_ne!(orphan, alternate.canonical_tip().unwrap().hash);
    assert_eq!(
        status(
            &original,
            &rules,
            ts_of(2),
            &unfunded(&body(false, None, 1), orphan, ts_of(2))
        ),
        SUCCEEDED
    );
    assert_eq!(
        status(
            &alternate,
            &rules,
            ts_of(2),
            &unfunded(&body(false, None, 1), orphan, ts_of(2))
        ),
        ItemResult::Admitted(TransactionOutcome::RecentPcashBlockNotInWindow)
    );
}

/// One body creates the same account in either mode, and its leaf is the
/// frozen SDK vector.
#[test]
fn both_modes_create_the_frozen_account_leaf_for_one_body() {
    let mut created = Vec::new();
    for attachment in [false, true] {
        let rules = stub_rules();
        let mut state = initialize(&rules);
        let recent = state.canonical_tip().unwrap().hash;
        let raw = if attachment {
            attached(&frozen_body(), &fee_words(recent, 7, 0, ts_of(1)))
        } else {
            unfunded(&frozen_body(), recent, ts_of(1))
        };
        let verifier = StubVerifier::accept();
        let block = block_with_batch(1, INBOX(), addr(0xf00), batch(&[raw]));
        let outcome = derive_block(&mut state, &block, &rules, &verifier).unwrap();
        assert_eq!(item_results(&outcome), vec![SUCCEEDED]);
        assert_eq!(verifier.calls.get(), usize::from(attachment));
        let account = state.account_of(frozen_address()).unwrap().unwrap();
        let leaf = pcash_state::account_state_commitment(
            frozen_address(),
            account.nullifier_key_commitment,
            account.account_rule_set_commitment,
            account.kind,
            account.revision,
            account.receive_key_hash,
        );
        assert_eq!(
            B256::from(fr_to_bytes(leaf)),
            "0x0cb5521888121b9fc096a3bf387ad4aaa8af754be8251468d05f4847c9c86860"
                .parse::<B256>()
                .unwrap()
        );
        let TransactionEffects::Accepted(effects) = &outcome.transaction_effects[0] else {
            panic!("accepted effects")
        };
        created.push((account, effects.account.clone()));
    }
    assert_eq!(created[0], created[1]);
}
