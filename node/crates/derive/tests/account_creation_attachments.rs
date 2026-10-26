#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests assert fixture construction"
)]

mod common;
use common::*;

use alloy_primitives::{Address, B256};
use k256::ecdsa::SigningKey;
use pcash_derive::private_value_profiles::PrivateValueShape;
use pcash_derive::{
    derive_block, AccountCreationAttachment, AccountCreationAuthorization, ContractAccountCreation,
    ContractBody, ContractFunction, PrivateValueSection, ReceiveKeyUpdate, SectionLayout,
    Transaction, UserAccountCreation, UserAccountUpdate,
};
use pcash_state::{fr_from_canonical_bytes, CircuitWord, StateDb, TransactionOutcome};
use pcash_verify::{Verifier, VerifyError};

fn inbox() -> Address {
    addr(0x914)
}

fn initial() -> pcash_state::MemState {
    let mut state = mem_state(source(inbox()));
    derive_block(
        &mut state,
        &block_with_txs(0, vec![]),
        &stub_rules(),
        &StubVerifier::accept(),
    )
    .unwrap();
    state
}

fn body() -> ContractBody {
    ContractBody::new(
        true,
        word(17),
        Some(receive_key(9)),
        vec![ContractFunction {
            selector: 3,
            application_vk_hash: word(31),
            configuration_commitment: word(41),
        }],
    )
    .unwrap()
}

fn section(state: &impl StateDb, salt: u64) -> PrivateValueSection {
    let words = section_words(
        state.canonical_tip().unwrap().hash,
        salt,
        0,
        Address::ZERO,
        0,
        ts_of(20),
    );
    let raw = transfer_txbytes(
        &words,
        &stub_proof(SectionLayout::PrivateValue(PrivateValueShape::S), &[1]),
        &[DUMMY_OUTPUT_DATA.as_slice(); 5],
    );
    match Transaction::decode(&raw, PCASH_CHAIN_ID).unwrap() {
        Transaction::PrivateValue(section) => section,
        _ => unreachable!(),
    }
}

fn attached(state: &impl StateDb, salt: u64, attachment: AccountCreationAttachment) -> Vec<u8> {
    Transaction::PrivateValue(
        section(state, salt)
            .with_account_creation(attachment)
            .unwrap(),
    )
    .encode(PCASH_CHAIN_ID)
    .unwrap()
}

fn signed(state: &impl StateDb, root: u64, recent: B256, deadline: u64) -> UserAccountCreation {
    let signing_key = SigningKey::from_slice(&[0x51; 32]).unwrap();
    let mut creation = UserAccountCreation::new(
        word(root),
        word(71),
        Some(receive_key(1)),
        recent,
        deadline,
        AccountCreationAuthorization::DirectL1,
    );
    let digest = pcash_derive::eip712::account_signing_hash(&creation, &state.derivation_source());
    let (signature, recovery) = signing_key
        .sign_prehash_recoverable(digest.as_slice())
        .unwrap();
    creation.authorization = AccountCreationAuthorization::Eip712 {
        sig_r: CircuitWord::from(<[u8; 32]>::from(signature.r().to_bytes())),
        sig_s: CircuitWord::from(<[u8; 32]>::from(signature.s().to_bytes())),
        y_parity: recovery.is_y_odd(),
    };
    creation
}

#[test]
fn contract_attachment_inserts_then_reuses_in_one_block_and_inputs_spend_once() {
    let mut state = initial();
    let first = attached(&state, 1, AccountCreationAttachment::Contract(body()));
    let second = attached(&state, 2, AccountCreationAttachment::Contract(body()));
    let outcome = derive_block(
        &mut state,
        &block_with_batch(1, inbox(), addr(1), batch(&[first.clone(), second, first])),
        &stub_rules(),
        &StubVerifier::accept(),
    )
    .unwrap();
    let results = &outcome.committed_boundary.block.transaction_results;
    assert_eq!(
        results
            .iter()
            .map(|r| (r.outcome, r.account_creation))
            .collect::<Vec<_>>(),
        vec![
            (TransactionOutcome::Succeeded, 1),
            (TransactionOutcome::Succeeded, 2),
            (TransactionOutcome::NullifierAlreadySpent, 0),
        ]
    );
    assert_eq!(state.account_count(), 1);
    assert!(outcome.transaction_effects[0]
        .accepted()
        .unwrap()
        .account
        .is_some());
    assert!(outcome.transaction_effects[1]
        .accepted()
        .unwrap()
        .account
        .is_none());
}

#[test]
fn copied_standalone_contract_does_not_break_attachment() {
    let mut state = initial();
    let raw = attached(&state, 3, AccountCreationAttachment::Contract(body()));
    let standalone = Transaction::ContractAccountCreation(ContractAccountCreation {
        body: body(),
        recent_pcash_block_hash: state.canonical_tip().unwrap().hash,
        valid_until_timestamp: ts_of(20),
    })
    .encode(PCASH_CHAIN_ID)
    .unwrap();
    let outcome = derive_block(
        &mut state,
        &block_with_batch(1, inbox(), addr(2), batch(&[standalone, raw])),
        &stub_rules(),
        &StubVerifier::accept(),
    )
    .unwrap();
    assert_eq!(item_results(&outcome), vec![SUCCEEDED, SUCCEEDED]);
    assert_eq!(
        outcome.committed_boundary.block.transaction_results[1].account_creation,
        2
    );
    assert_eq!(state.account_count(), 1);
}

#[test]
fn rejected_value_proof_leaves_no_account_or_note_effects() {
    let mut state = initial();
    let raw = attached(&state, 4, AccountCreationAttachment::Contract(body()));
    let outcome = derive_block(
        &mut state,
        &block_with_batch(1, inbox(), addr(3), batch(std::slice::from_ref(&raw))),
        &stub_rules(),
        &StubVerifier::reject(),
    )
    .unwrap();
    assert_eq!(
        item_results(&outcome),
        vec![ItemResult::Admitted(TransactionOutcome::ProofRejected)]
    );
    assert_eq!(state.account_count(), 0);
    assert_eq!(state.output_count(), 0);
    let next = derive_block(
        &mut state,
        &block_with_batch(2, inbox(), addr(3), batch(&[raw])),
        &stub_rules(),
        &StubVerifier::accept(),
    )
    .unwrap();
    assert_eq!(item_results(&next), vec![SUCCEEDED]);
    assert_eq!(state.account_count(), 1);
}

struct ExactStatement(Vec<u8>);
impl Verifier for ExactStatement {
    fn verify(&self, _: &[u8], _: &[u8], inputs: &[u8]) -> Result<bool, VerifyError> {
        Ok(inputs == self.0)
    }
}

#[test]
fn stripping_or_substituting_attachment_changes_the_verified_statement() {
    let state = initial();
    let original = section(&state, 5)
        .with_account_creation(AccountCreationAttachment::Contract(body()))
        .unwrap();
    let verifier = ExactStatement(
        original
            .public_inputs()
            .iter()
            .flat_map(|w| w.to_vec())
            .collect(),
    );
    let original = Transaction::PrivateValue(original)
        .encode(PCASH_CHAIN_ID)
        .unwrap();
    assert_eq!(
        validate_raw_item(
            &state,
            &stub_rules(),
            &verifier,
            ts_of(1),
            addr(1),
            &original
        )
        .unwrap(),
        SUCCEEDED
    );
    let stripped = Transaction::PrivateValue(section(&state, 5))
        .encode(PCASH_CHAIN_ID)
        .unwrap();
    let mut other = body();
    other.nullifier_key_material = word(18);
    let substituted = attached(&state, 5, AccountCreationAttachment::Contract(other));
    for raw in [stripped, substituted] {
        assert_eq!(
            validate_raw_item(&state, &stub_rules(), &verifier, ts_of(1), addr(1), &raw).unwrap(),
            ItemResult::Admitted(TransactionOutcome::ProofRejected)
        );
    }
}

#[test]
fn user_reuse_keeps_updated_rules_receive_key_revision_and_index() {
    let mut state = initial();
    let creation = signed(&state, 61, state.canonical_tip().unwrap().hash, ts_of(20));
    let address = creation.signer(&state.derivation_source()).unwrap();
    let raw = attached(&state, 6, AccountCreationAttachment::User(creation.clone()));
    derive_block(
        &mut state,
        &block_with_batch(1, inbox(), addr(4), batch(&[raw])),
        &stub_rules(),
        &StubVerifier::accept(),
    )
    .unwrap();
    let current = state.account_of(address).unwrap().unwrap();
    let key = receive_key(2);
    let key_hash = pcash_state::receive_key_hash(key.as_slice());
    let rules = word(72);
    let update = Transaction::UserAccountUpdate(UserAccountUpdate {
        address,
        new_rule_set_commitment: rules,
        receive_key_update: ReceiveKeyUpdate::Replace(key),
        account_update_commitment: pcash_derive::user_account_update_commitment(
            address,
            &current,
            fr_from_canonical_bytes(rules).unwrap(),
            key_hash,
        ),
        section: section(&state, 7),
    })
    .encode(PCASH_CHAIN_ID)
    .unwrap();
    let raw = attached(&state, 8, AccountCreationAttachment::User(creation));
    let outcome = derive_block(
        &mut state,
        &block_with_batch(2, inbox(), addr(4), batch(&[update, raw])),
        &stub_rules(),
        &StubVerifier::accept(),
    )
    .unwrap();
    assert_eq!(item_results(&outcome), vec![SUCCEEDED, SUCCEEDED]);
    let final_account = state.account_of(address).unwrap().unwrap();
    assert_eq!(final_account.index, current.index);
    assert_eq!(final_account.revision, 2);
    assert_eq!(
        final_account.account_rule_set_commitment,
        fr_from_canonical_bytes(rules).unwrap()
    );
    assert_eq!(final_account.receive_key_hash, key_hash);
    assert_eq!(state.account_count(), 1);
    assert_eq!(
        outcome.committed_boundary.block.transaction_results[1].account_creation,
        2
    );
    assert!(outcome.transaction_effects[1]
        .accepted()
        .unwrap()
        .account
        .is_none());
}

#[test]
fn existing_user_does_not_skip_signature_timing_or_root_checks() {
    let mut state = initial();
    let recent = state.canonical_tip().unwrap().hash;
    let creation = signed(&state, 62, recent, ts_of(1));
    let raw = attached(&state, 9, AccountCreationAttachment::User(creation.clone()));
    derive_block(
        &mut state,
        &block_with_batch(1, inbox(), addr(5), batch(&[raw])),
        &stub_rules(),
        &StubVerifier::accept(),
    )
    .unwrap();
    let mut malformed = signed(&state, 62, recent, ts_of(20));
    malformed.authorization = AccountCreationAuthorization::Eip712 {
        sig_r: CircuitWord::ZERO,
        sig_s: word(1),
        y_parity: false,
    };
    let cases = [
        (creation, TransactionOutcome::Expired),
        (
            signed(&state, 63, recent, ts_of(20)),
            TransactionOutcome::AccountCreationMismatch,
        ),
        (
            signed(&state, 62, word(123), ts_of(20)),
            TransactionOutcome::RecentPcashBlockNotInWindow,
        ),
        (malformed, TransactionOutcome::InvalidAccountSignature),
    ];
    for (creation, expected) in cases {
        let raw = attached(&state, 10, AccountCreationAttachment::User(creation));
        assert_eq!(
            validate_raw_item(
                &state,
                &stub_rules(),
                &StubVerifier::accept(),
                ts_of(2),
                addr(5),
                &raw
            )
            .unwrap(),
            ItemResult::Admitted(expected)
        );
    }
}

#[test]
fn attachment_tags_and_signed_only_user_encoding_are_structural() {
    let state = initial();
    let mut raw = Transaction::PrivateValue(section(&state, 11))
        .encode(PCASH_CHAIN_ID)
        .unwrap();
    *raw.last_mut().unwrap() = 3;
    assert_eq!(
        Transaction::decode(&raw, PCASH_CHAIN_ID),
        Err(pcash_derive::ParseError::UnknownAccountCreationTag(3))
    );
    let direct = UserAccountCreation::new(
        word(1),
        word(2),
        None,
        state.canonical_tip().unwrap().hash,
        ts_of(20),
        AccountCreationAuthorization::DirectL1,
    );
    assert!(section(&state, 11)
        .with_account_creation(AccountCreationAttachment::User(direct.clone()))
        .is_err());
    let payload = Transaction::UserAccountCreation(direct)
        .encode(PCASH_CHAIN_ID)
        .unwrap();
    *raw.last_mut().unwrap() = 1;
    raw.extend_from_slice(&payload[5..]);
    assert_eq!(
        Transaction::decode(&raw, PCASH_CHAIN_ID),
        Err(pcash_derive::ParseError::DirectCreationAttachment)
    );
}
