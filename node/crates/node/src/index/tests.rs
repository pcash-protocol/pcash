#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]

use super::keys::*;

use super::types::*;
use super::*;

use alloy_primitives::{Address, Bytes, B256, U256};
use pcash_crypto::Fr;
use pcash_derive::private_value_profiles::PrivateValueShape;
use pcash_derive::{
    AccountCreationAuthorization, ContractAccountCreation, ContractBody, ContractFunction,
    ContractFunding, PrivateValueSection, ReceiveKeyUpdate, SectionLayout, Transaction,
    UserAccountCreation, UserAccountUpdate,
};
use pcash_state::{
    AcceptedEffects, AccountResult, Codec, ReceiveKeyOperation, TransactionEffects,
    TransactionOutcome, TransactionResult,
};
use redb::{
    Database, Durability, ReadableDatabase, ReadableTable, ReadableTableMetadata, TableDefinition,
};

use crate::node::{AccountReceiptData, ReceiptRecord};

const TEST_PCASH_CHAIN_ID: u32 = 7;

#[test]
fn settlement_lookup_keeps_an_older_success_after_one_hundred_replays() {
    let temporary = tempfile::TempDir::new().unwrap();
    let store = DerivedIndexStore::create(temporary.path().join("index.redb")).unwrap();
    let content_hash = B256::repeat_byte(0x41);
    let success_id = B256::repeat_byte(0xfe);
    let write = store.db.begin_write().unwrap();
    {
        let mut receipts = write.open_table(T_RECEIPTS).unwrap();
        let mut by_content = write.open_table(T_RECEIPT_BY_CONTENT).unwrap();
        let mut succeeded = write.open_table(T_SUCCEEDED_RECEIPT_BY_CONTENT).unwrap();
        let mut by_block = write.open_table(T_RECEIPT_BY_BLOCK_ORDINAL).unwrap();
        let mut by_kind = write.open_table(T_RECEIPT_BY_KIND_BLOCK_ORDINAL).unwrap();
        for replay in 0..=100u64 {
            let primary = receipt_key(100 + replay, 0, 0);
            let outcome = if replay == 0 {
                TransactionOutcome::Succeeded
            } else {
                TransactionOutcome::NullifierAlreadySpent
            };
            let row = ReceiptRow {
                pcash_transaction_index: 0,
                hash: B256::repeat_byte(replay as u8),
                l1_transaction_hash: B256::repeat_byte(0x91),
                content_hash,
                tx_id: if replay == 0 {
                    success_id
                } else {
                    B256::repeat_byte(replay as u8)
                },
                outcome,
                failure_detail: None,
                l1_sender: Address::ZERO,
                issuance_owner_commitment: None,
                settled_open_fee_amount: U256::ZERO,
                settled_issuance_amount: U256::ZERO,
                has_open_fee: true,
                byte_size: 0,
                kind: pcash_derive::KIND_PRIVATE_VALUE,
                funding_mode: None,
                lifecycle_address: None,
                output_leaf_start: None,
                outputs_added: 0,
                nullifiers: None,
                account: None,
            };
            receipts
                .insert(primary.as_slice(), row.encode().as_slice())
                .unwrap();
            by_content
                .insert(
                    content_receipt_key(content_hash, &primary).as_slice(),
                    b"".as_slice(),
                )
                .unwrap();
            by_block
                .insert(block_ordinal_key(replay, 0).as_slice(), primary.as_slice())
                .unwrap();
            by_kind
                .insert(
                    kind_block_ordinal_key(pcash_derive::KIND_PRIVATE_VALUE, replay, 0).as_slice(),
                    primary.as_slice(),
                )
                .unwrap();
            if replay == 0 {
                succeeded
                    .insert(content_hash.as_slice(), primary.as_slice())
                    .unwrap();
            }
        }
    }
    write.commit().unwrap();
    let rows = store.receipts_for_settlement(content_hash, 100).unwrap();
    assert_eq!(rows.len(), 100);
    assert!(rows
        .iter()
        .any(|receipt| receipt.tx_id == success_id && receipt.accepted()));
    assert!(store
        .receipts_by_block_ordinal(
            None,
            Some(pcash_derive::KIND_USER_ACCOUNT_UPDATE),
            None,
            100,
        )
        .unwrap()
        .is_empty());
}

#[test]
fn open_fee_samples_skip_ineligible_receipts_before_applying_the_limit() {
    let temporary = tempfile::TempDir::new().unwrap();
    let store = DerivedIndexStore::create(temporary.path().join("index.redb")).unwrap();
    let write = store.db.begin_write().unwrap();
    {
        let mut receipts = write.open_table(T_RECEIPTS).unwrap();
        let mut by_block = write.open_table(T_RECEIPT_BY_BLOCK_ORDINAL).unwrap();
        // 300 recent ineligible receipts, 260 eligible receipts, plus open fees
        // immediately outside either end of the requested block window.
        for (block, count) in [(36, 1), (99, 260), (100, 300), (101, 1)] {
            for ordinal in 0..count {
                let (kind, has_open_fee, outcome) = if block != 100 {
                    (
                        [
                            pcash_derive::KIND_PRIVATE_VALUE,
                            pcash_derive::KIND_CONTRACT_ACCOUNT_CREATION,
                            pcash_derive::KIND_USER_ACCOUNT_UPDATE,
                        ][ordinal as usize % 3],
                        true,
                        TransactionOutcome::Succeeded,
                    )
                } else {
                    match ordinal % 3 {
                        0 => (
                            pcash_derive::KIND_USER_ACCOUNT_CREATION,
                            false,
                            TransactionOutcome::Succeeded,
                        ),
                        1 => (
                            pcash_derive::KIND_USER_ACCOUNT_UPDATE,
                            false,
                            TransactionOutcome::Succeeded,
                        ),
                        _ => (
                            pcash_derive::KIND_PRIVATE_VALUE,
                            true,
                            TransactionOutcome::NullifierAlreadySpent,
                        ),
                    }
                };
                let primary = receipt_key(block, 0, ordinal);
                let row = ReceiptRow {
                    pcash_transaction_index: ordinal,
                    hash: B256::ZERO,
                    l1_transaction_hash: B256::ZERO,
                    content_hash: B256::ZERO,
                    tx_id: B256::ZERO,
                    outcome,
                    failure_detail: None,
                    l1_sender: Address::ZERO,
                    issuance_owner_commitment: Some(B256::repeat_byte(1)),
                    settled_open_fee_amount: U256::from(100_000),
                    settled_issuance_amount: U256::ZERO,
                    has_open_fee,
                    byte_size: 1_000,
                    kind,
                    funding_mode: None,
                    lifecycle_address: None,
                    output_leaf_start: None,
                    outputs_added: 0,
                    nullifiers: None,
                    account: None,
                };
                receipts
                    .insert(primary.as_slice(), row.encode().as_slice())
                    .unwrap();
                by_block
                    .insert(
                        block_ordinal_key(block, ordinal).as_slice(),
                        primary.as_slice(),
                    )
                    .unwrap();
            }
        }
    }
    write.commit().unwrap();
    let rows = store.open_fee_receipts(37, 100, 256).unwrap();
    assert_eq!(rows.len(), 256);
    assert_eq!(rows.first().unwrap().pcash_transaction_index, 259);
    assert_eq!(rows.last().unwrap().pcash_transaction_index, 4);
    assert!(rows.iter().all(|receipt| receipt.l1_block_number == 99));
    assert_eq!(store.open_fee_receipts(37, 100, 300).unwrap().len(), 260);
    assert!(store.open_fee_receipts(100, 100, 256).unwrap().is_empty());
    let samples: Vec<_> = rows
        .iter()
        .map(|receipt| crate::fee_estimate::FeeSample {
            fee: receipt.settled_open_fee_amount,
            bytes: receipt.byte_size,
        })
        .collect();
    let quote = crate::fee_estimate::estimate(
        &crate::fee_estimate::FeeEstimateInputs {
            included: &samples,
            pending: &[],
        },
        1_000,
    );
    assert_eq!(quote.basis.included_samples, 256);
    assert_eq!(quote.tiers.standard, U256::from(100_000));
}

fn entry_result(tx_index: u64, entry_index: u64, outcome: TransactionOutcome) -> TransactionResult {
    TransactionResult {
        tx_type: 0,
        funding_mode: 0,
        l1_transaction_index: tx_index,
        batch_item_index: entry_index,
        outcome,
        poster_owner_commitment: B256::repeat_byte(0x0a),
        output_start_index: 0,
        statement_hash: B256::ZERO,
    }
}

#[test]
fn create_refuses_to_truncate_an_existing_index() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("state.index.redb");
    let store = DerivedIndexStore::create(&path).unwrap();
    store.bind_identity(7, B256::repeat_byte(9)).unwrap();
    drop(store);

    assert!(DerivedIndexStore::create(&path).is_err());
    let reopened = DerivedIndexStore::open(&path).unwrap();
    assert_eq!(reopened.identity().unwrap(), (7, B256::repeat_byte(9)));
}

#[test]
fn in_memory_index_uses_the_persistent_schema() {
    let store = DerivedIndexStore::create_in_memory().unwrap();
    store.bind_identity(7, B256::repeat_byte(9)).unwrap();
    assert_eq!(store.identity().unwrap(), (7, B256::repeat_byte(9)));
}

#[test]
fn identity_binding_is_immutable() {
    let tmp = tempfile::tempdir().unwrap();
    let store = DerivedIndexStore::create(tmp.path().join("state.index.redb")).unwrap();
    store.bind_identity(7, B256::repeat_byte(9)).unwrap();
    store.bind_identity(7, B256::repeat_byte(9)).unwrap();
    assert!(store.bind_identity(8, B256::repeat_byte(9)).is_err());
    assert!(store.bind_identity(7, B256::repeat_byte(8)).is_err());
}

#[test]
fn open_requires_the_exact_index_schema() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("state.index.redb");
    let store = DerivedIndexStore::create(&path).unwrap();
    drop(store);
    let db = Database::open(&path).unwrap();
    let mut write = db.begin_write().unwrap();
    write.set_durability(Durability::Immediate).unwrap();
    {
        let mut meta = write.open_table(T_META).unwrap();
        meta.remove(M_TOTAL_SUCCEEDED).unwrap();
    }
    write.commit().unwrap();
    drop(db);

    assert!(DerivedIndexStore::open(&path).is_err());

    let extra_meta_path = tmp.path().join("extra-meta.index.redb");
    drop(DerivedIndexStore::create(&extra_meta_path).unwrap());
    {
        let db = Database::open(&extra_meta_path).unwrap();
        let write = db.begin_write().unwrap();
        {
            let mut meta = write.open_table(T_META).unwrap();
            meta.insert("unexpected", b"value".as_slice()).unwrap();
        }
        write.commit().unwrap();
    }
    assert!(DerivedIndexStore::open(&extra_meta_path).is_err());

    let extra_table_path = tmp.path().join("extra-table.index.redb");
    drop(DerivedIndexStore::create(&extra_table_path).unwrap());
    {
        let db = Database::open(&extra_table_path).unwrap();
        let write = db.begin_write().unwrap();
        let unexpected = TableDefinition::<&[u8], &[u8]>::new("unexpected");
        write.open_table(unexpected).unwrap();
        write.commit().unwrap();
    }
    assert!(DerivedIndexStore::open(&extra_table_path).is_err());
}

#[test]
fn contract_creation_index_uses_the_all_transactions_ordinal() {
    let temporary = tempfile::tempdir().unwrap();
    let store = DerivedIndexStore::create(temporary.path().join("index.redb")).unwrap();
    let material = ContractMaterialUpdate {
        address: Address::repeat_byte(0x41),
        pcash_block_number: 7,
        pcash_block_hash: B256::repeat_byte(0x42),
        pcash_transaction_index: 1,
        transaction_id: B256::repeat_byte(0x43),
        timestamp: 100,
        nullifier_key_commitment: B256::repeat_byte(0x44),
        account_rule_set_commitment: B256::repeat_byte(0x45),
        functions: Vec::new(),
        l1_block_number: 107,
        l1_block_hash: B256::repeat_byte(0x46),
        l1_transaction_index: 0,
        l1_transaction_hash: B256::repeat_byte(0x95),
        batch_item_index: 1,
    };
    let write = store.db.begin_write().unwrap();
    {
        let mut contracts = write.open_table(T_CONTRACT_MATERIAL).unwrap();
        contracts
            .insert(material.address.as_slice(), material.encode().as_slice())
            .unwrap();
        let mut chronological = write.open_table(T_CONTRACT_BY_CREATION).unwrap();
        chronological
            .insert(
                contract_creation_key(7, 1).as_slice(),
                material.address.as_slice(),
            )
            .unwrap();
    }
    write.commit().unwrap();
    assert!(store.contract_material_at(7, 0).unwrap().is_none());
    assert_eq!(store.contract_material_at(7, 1).unwrap().unwrap(), material);
}

struct Fixture {
    boundary: pcash_state::CommittedBoundary,
    transactions: Vec<TransactionEffects>,
    l1_logs: pcash_l1::NormalizedLogBlock,
    receipt: ReceiptRecord,
}

fn user_account_effects(
    kind: u8,
    address: Address,
    revision: u32,
    receive_key: ReceiveKeyOperation,
) -> TransactionEffects {
    TransactionEffects::Accepted(AcceptedEffects {
        kind,
        output_leaf_start: None,
        output_commitments: Vec::new(),
        nullifiers: Vec::new(),
        account: Some(AccountResult::User {
            address,
            revision,
            receive_key,
            prior_state: None,
        }),
        payout: None,
    })
}

fn receive_key_operation(update: &ReceiveKeyUpdate) -> ReceiveKeyOperation {
    match update {
        ReceiveKeyUpdate::Keep => ReceiveKeyOperation::Keep,
        ReceiveKeyUpdate::Clear => ReceiveKeyOperation::Clear,
        ReceiveKeyUpdate::Replace(_) => ReceiveKeyOperation::Replace,
    }
}

fn account_creation_transaction(key: Option<&[u8]>) -> Vec<u8> {
    Transaction::UserAccountCreation(UserAccountCreation::new(
        B256::repeat_byte(3),
        B256::repeat_byte(4),
        key.map(|key| Box::new(key.try_into().unwrap())),
        B256::ZERO,
        1_000,
        AccountCreationAuthorization::Eip712 {
            sig_r: B256::ZERO,
            sig_s: B256::ZERO,
            y_parity: false,
        },
    ))
    .encode(TEST_PCASH_CHAIN_ID)
    .unwrap()
}

/// A zero-fee section framed for an account action of `layout`.
fn zero_fee_private_value_section(layout: SectionLayout) -> PrivateValueSection {
    let wire: Vec<B256> = (0..pcash_derive::PRIVATE_VALUE_WIRE_INPUTS)
        .map(|word| {
            let mut value = [0u8; 32];
            // Serialized word 10 becomes openFeeAmount once the chain ID and the
            // delivery commitment are reconstructed.
            if word != 10 {
                value[31] = word as u8 + 1;
            }
            B256::from(value)
        })
        .collect();
    PrivateValueSection::new(
        PrivateValueShape::S,
        TEST_PCASH_CHAIN_ID,
        &wire,
        vec![0; layout.proof_bytes()],
        vec![
            vec![0; pcash_derive::OUTPUT_DATA_BYTES];
            pcash_derive::PRIVATE_VALUE_OUTPUT_DATA_ITEMS
        ],
        section_arena(),
    )
    .unwrap()
}

/// The arena every fixture section carries.
fn section_arena() -> Vec<u8> {
    (0..pcash_derive::private_value_profiles::S.arena_bytes)
        .map(|byte| byte as u8)
        .collect()
}

fn account_update_transaction(address: Address, update: &ReceiveKeyUpdate) -> Vec<u8> {
    Transaction::UserAccountUpdate(UserAccountUpdate {
        address,
        new_rule_set_commitment: B256::repeat_byte(4),
        receive_key_update: update.clone(),
        account_update_commitment: B256::repeat_byte(5),
        section: zero_fee_private_value_section(SectionLayout::UserAccountUpdate),
    })
    .encode(TEST_PCASH_CHAIN_ID)
    .unwrap()
}

fn fixture(number: u64, parent_hash: B256, seed: u8) -> Fixture {
    fixture_with_logs(
        number,
        parent_hash,
        seed,
        vec![pcash_l1::L1Log {
            transaction_index: 0,
            log_index: 0,
            emitter: Address::repeat_byte(seed.wrapping_add(3)),
            topics: vec![B256::repeat_byte(seed.wrapping_add(4))],
            data: Bytes::from(vec![seed, seed.wrapping_add(1)]),
        }],
    )
}

fn fixture_with_logs(
    number: u64,
    parent_hash: B256,
    seed: u8,
    logs: Vec<pcash_l1::L1Log>,
) -> Fixture {
    let address = Address::repeat_byte(seed);
    let key = vec![seed; pcash_state::ML_KEM768_PUBLIC_KEY_LEN];
    let transaction = account_creation_transaction(Some(&key));
    let content_hash = pcash_state::content_hash(&transaction);
    let l1_data = pcash_l1::L1BlockData::new(
        pcash_l1::L1Header {
            number: 100 + number,
            hash: B256::repeat_byte(seed),
            parent_hash: B256::repeat_byte(seed.wrapping_sub(1)),
            timestamp: 1_000 + number,
        },
        vec![(
            pcash_l1::L1Tx {
                hash: B256::repeat_byte(seed.wrapping_add(1)),
                from: Address::repeat_byte(seed.wrapping_add(2)),
                to: None,
                input: Bytes::new(),
                blob_versioned_hashes: Vec::new(),
                blob_resolution: pcash_l1::BlobResolution::Unresolved,
                tx_index: 0,
            },
            pcash_l1::L1Receipt { logs },
        )],
    );
    let l1_logs = l1_data.normalized_logs().clone();
    let origin = pcash_state::L1Origin {
        block_number: 100 + number,
        block_hash: B256::repeat_byte(seed),
        block_timestamp: 1_000 + number,
        l1_logs_root: l1_logs.root,
        l1_log_count: l1_logs.count(),
    };
    let state = pcash_state::StateCommitment::new(pcash_state::StateComponents {
        output_root: pcash_state::fr_to_bytes(Fr::from(2u64)),
        output_count: 0,
        issuance: pcash_state::IssuanceState {
            issued_so_far: U256::ZERO,
            lag_q: alloy_primitives::I256::ZERO,
        },
        account_state_root: pcash_state::fr_to_bytes(Fr::from(4u64)),
        account_count: 0,
        nullifier_root: pcash_state::fr_to_bytes(Fr::from(6u64)),
        nullifier_count: 0,
    });
    let block = pcash_state::PcashBlock::new(
        parent_hash,
        &pcash_state::BlockInput {
            transaction_effects: Vec::new(),
            l1_logs: Vec::new(),
            history: pcash_state::CanonicalBlockHistory::default(),
            number,
            timestamp: 1_000 + number,
            transaction_results: vec![entry_result(0, 0, TransactionOutcome::Succeeded)],
            transaction_bytes: vec![transaction.clone()],
            l1_origin: origin.clone(),
        },
        pcash_state::fr_to_bytes(state.root),
        Fr::from(number + 2),
        Fr::from(number + 3),
    );
    let transaction_id = pcash_state::transaction_id(origin.block_hash, 0, 0);
    let boundary = pcash_state::CommittedBoundary {
        history: pcash_state::CanonicalBlockHistory::default(),
        block: block.clone(),
        state,
        l1_origin: origin,
        state_outcome: pcash_state::StateOutcome {
            state_root: pcash_state::StateRoot(block.header.state_root),
            output_leaf_start: 0,
            outputs_added: 0,
            inserted_nullifiers: Vec::new(),
        },
    };
    let receipt = ReceiptRecord {
        pcash_transaction_index: 0,
        lifecycle_address: None,
        l1_block_number: boundary.l1_origin.block_number,
        l1_block_hash: boundary.l1_origin.block_hash,
        l1_transaction_index: 0,
        l1_transaction_hash: B256::repeat_byte(0x98),
        batch_item_index: 0,
        content_hash,
        tx_id: transaction_id,
        outcome: TransactionOutcome::Succeeded,
        failure_detail: None,
        l1_sender: Address::ZERO,
        issuance_owner_commitment: None,
        settled_open_fee_amount: U256::ZERO,
        settled_issuance_amount: U256::ZERO,
        has_open_fee: true,
        byte_size: 0,
        kind: pcash_derive::KIND_USER_ACCOUNT_CREATION,
        funding_mode: None,
        output_leaf_start: None,
        outputs_added: 0,
        nullifiers: None,
        account: Some(AccountReceiptData {
            address,
            account_revision: 1,
        }),
    };
    Fixture {
        boundary,
        transactions: vec![user_account_effects(
            pcash_derive::KIND_USER_ACCOUNT_CREATION,
            address,
            1,
            ReceiveKeyOperation::Replace,
        )],
        l1_logs,
        receipt,
    }
}

fn apply_fixture(store: &DerivedIndexStore, fixture: &Fixture) -> DerivedIndexCursor {
    store
        .apply_block(
            &fixture.boundary,
            &fixture.transactions.iter().collect::<Vec<_>>(),
            &fixture.l1_logs,
            std::slice::from_ref(&fixture.receipt),
            None,
            true,
        )
        .unwrap()
}

#[test]
fn normalized_l1_log_openings_are_persisted_and_reorged_with_the_index() {
    let tmp = tempfile::tempdir().unwrap();
    let store = DerivedIndexStore::create(tmp.path().join("state.index.redb")).unwrap();
    let first = fixture(0, B256::ZERO, 31);
    store.bind_identity(7, first.boundary.block.hash).unwrap();
    apply_fixture(&store, &first);
    let proof = store.l1_log_proof(100, 0, 0).unwrap().unwrap();
    assert_eq!(proof.block_hash, first.boundary.l1_origin.block_hash);
    assert_eq!(proof.logs_root, first.boundary.l1_origin.l1_logs_root);
    assert_eq!(proof.log_count, 1);
    assert_eq!(proof.siblings.len(), 64);

    let second = fixture(1, first.boundary.block.hash, 32);
    apply_fixture(&store, &second);
    assert!(store.l1_log_proof(101, 0, 0).unwrap().is_some());
    store
        .rewind_to(IndexBlockId {
            number: 0,
            hash: first.boundary.block.hash,
        })
        .unwrap();
    assert!(store.l1_log_proof(101, 0, 0).is_err());
    assert!(store.l1_log_proof(100, 0, 0).unwrap().is_some());
}

#[test]
fn normalized_l1_logs_store_one_row_per_log_and_shared_tree_nodes() {
    let tmp = tempfile::tempdir().unwrap();
    let store = DerivedIndexStore::create(tmp.path().join("state.index.redb")).unwrap();
    let log_count = 128u64;
    let logs = (0..log_count)
        .map(|log_index| pcash_l1::L1Log {
            transaction_index: 0,
            log_index,
            emitter: Address::repeat_byte(log_index as u8),
            topics: vec![B256::repeat_byte(log_index as u8)],
            data: Bytes::from(vec![log_index as u8; 1_025]),
        })
        .collect();
    let fixture = fixture_with_logs(0, B256::ZERO, 0x41, logs);
    store.bind_identity(7, fixture.boundary.block.hash).unwrap();
    apply_fixture(&store, &fixture);

    let read = store.db.begin_read().unwrap();
    assert_eq!(read.open_table(T_L1_LOG_BLOCKS).unwrap().len().unwrap(), 1);
    let log_table = read.open_table(T_L1_LOGS).unwrap();
    assert_eq!(log_table.len().unwrap(), log_count);
    for row in log_table.iter().unwrap() {
        let (_, value) = row.unwrap();
        assert!(value.value().len() < 50);
    }
    assert!(read.open_table(T_L1_LOG_NODES).unwrap().len().unwrap() < log_count * 2);
    drop(read);

    let proof = store.l1_log_proof(100, 0, log_count - 1).unwrap().unwrap();
    assert_eq!(proof.log_count, log_count);
    assert_eq!(proof.siblings.len(), pcash_l1::NORMALIZED_LOG_TREE_DEPTH);
    assert!(store.l1_log_proof(100, 1, 0).unwrap().is_none());
}

#[test]
fn missing_normalized_log_metadata_is_index_corruption() {
    let tmp = tempfile::tempdir().unwrap();
    let store = DerivedIndexStore::create(tmp.path().join("state.index.redb")).unwrap();
    let fixture = fixture(0, B256::ZERO, 0x42);
    store.bind_identity(7, fixture.boundary.block.hash).unwrap();
    apply_fixture(&store, &fixture);

    let write = store.db.begin_write().unwrap();
    {
        let mut blocks = write.open_table(T_L1_LOG_BLOCKS).unwrap();
        blocks
            .remove(l1_log_block_key(fixture.boundary.l1_origin.block_number).as_slice())
            .unwrap();
    }
    write.commit().unwrap();

    assert!(store.l1_log_proof(100, 0, 0).is_err());
}

fn update_fixture(
    number: u64,
    parent_hash: B256,
    seed: u8,
    address: Address,
    account_revision: u32,
    update: ReceiveKeyUpdate,
) -> Fixture {
    let mut fixture = fixture(number, parent_hash, seed);
    let transaction = account_update_transaction(address, &update);
    let content_hash = pcash_state::content_hash(&transaction);
    let transaction_id = pcash_state::transaction_id(fixture.boundary.l1_origin.block_hash, 0, 0);
    fixture.transactions = vec![user_account_effects(
        pcash_derive::KIND_USER_ACCOUNT_UPDATE,
        address,
        account_revision,
        receive_key_operation(&update),
    )];
    let block = pcash_state::PcashBlock::new(
        parent_hash,
        &pcash_state::BlockInput {
            transaction_effects: Vec::new(),
            l1_logs: Vec::new(),
            history: pcash_state::CanonicalBlockHistory::default(),
            number,
            timestamp: fixture.boundary.block.header.timestamp,
            transaction_results: vec![entry_result(0, 0, TransactionOutcome::Succeeded)],
            transaction_bytes: vec![transaction.clone()],
            l1_origin: fixture.boundary.l1_origin.clone(),
        },
        fixture.boundary.block.header.state_root,
        Fr::from(number + 2),
        Fr::from(number + 3),
    );
    fixture.boundary.block = block;
    fixture.receipt.content_hash = content_hash;
    fixture.receipt.tx_id = transaction_id;
    fixture.receipt.kind = pcash_derive::KIND_USER_ACCOUNT_UPDATE;
    fixture.receipt.account = Some(AccountReceiptData {
        address,
        account_revision,
    });
    fixture
}

/// A block whose one transaction is an S-profile private-value transfer,
/// accepted with every output and nullifier slot of the profile.
fn private_value_fixture(number: u64, parent_hash: B256, seed: u8) -> Fixture {
    private_value_fixture_at(number, parent_hash, seed, 0)
}

/// [`private_value_fixture`] whose outputs start at `leaf_start`.
fn private_value_fixture_at(number: u64, parent_hash: B256, seed: u8, leaf_start: u64) -> Fixture {
    let profile = pcash_derive::private_value_profiles::S;
    let mut fixture = fixture(number, parent_hash, seed);
    let transaction = Transaction::PrivateValue(zero_fee_private_value_section(
        SectionLayout::PrivateValue(PrivateValueShape::S),
    ))
    .encode(TEST_PCASH_CHAIN_ID)
    .unwrap();
    let content_hash = pcash_state::content_hash(&transaction);
    let transaction_id = pcash_state::transaction_id(fixture.boundary.l1_origin.block_hash, 0, 0);
    let nullifiers: Vec<B256> = (0..profile.inputs)
        .map(|slot| B256::repeat_byte(0x60 + leaf_start as u8 + slot as u8))
        .collect();
    fixture.transactions = vec![TransactionEffects::Accepted(AcceptedEffects {
        kind: pcash_derive::KIND_PRIVATE_VALUE,
        output_leaf_start: Some(leaf_start),
        output_commitments: (0..profile.outputs)
            .map(|slot| B256::repeat_byte(0x70 + slot as u8))
            .collect(),
        nullifiers: nullifiers.clone(),
        account: None,
        payout: None,
    })];
    let mut components = fixture.boundary.state.state_components();
    components.output_count = leaf_start + profile.outputs as u64;
    fixture.boundary.state = pcash_state::StateCommitment::new(components);
    fixture.boundary.block = pcash_state::PcashBlock::new(
        parent_hash,
        &pcash_state::BlockInput {
            transaction_effects: Vec::new(),
            l1_logs: Vec::new(),
            history: pcash_state::CanonicalBlockHistory::default(),
            number,
            timestamp: fixture.boundary.block.header.timestamp,
            transaction_results: vec![entry_result(0, 0, TransactionOutcome::Succeeded)],
            transaction_bytes: vec![transaction.clone()],
            l1_origin: fixture.boundary.l1_origin.clone(),
        },
        pcash_state::fr_to_bytes(fixture.boundary.state.root),
        Fr::from(number + 2),
        Fr::from(number + 3),
    );
    fixture.receipt.content_hash = content_hash;
    fixture.receipt.tx_id = transaction_id;
    fixture.receipt.kind = pcash_derive::KIND_PRIVATE_VALUE;
    fixture.receipt.byte_size = transaction.len() as u64;
    fixture.receipt.issuance_owner_commitment = Some(B256::repeat_byte(0x51));
    fixture.receipt.output_leaf_start = Some(leaf_start);
    fixture.receipt.outputs_added = profile.outputs as u64;
    fixture.receipt.nullifiers = Some(nullifiers);
    fixture.receipt.account = None;
    fixture
}

/// An index holding a genesis block and one S-profile private-value block.
fn private_value_store() -> (DerivedIndexStore, Fixture, u64) {
    let store = DerivedIndexStore::create_in_memory().unwrap();
    let genesis = fixture(0, B256::ZERO, 0x21);
    store
        .bind_identity(TEST_PCASH_CHAIN_ID, genesis.boundary.block.hash)
        .unwrap();
    apply_fixture(&store, &genesis);
    let before = stored_bytes(&store);
    let block = private_value_fixture(1, genesis.boundary.block.hash, 0x22);
    apply_fixture(&store, &block);
    (store, block, before)
}

/// Key and value bytes held across every table of the index.
fn stored_bytes(store: &DerivedIndexStore) -> u64 {
    let read = store.db.begin_read().unwrap();
    read.list_tables()
        .unwrap()
        .map(|table| {
            read.open_untyped_table(table)
                .unwrap()
                .stats()
                .unwrap()
                .stored_bytes()
        })
        .sum()
}

#[test]
fn the_index_stores_an_s_transaction_in_well_under_its_wire_size() {
    let (store, block, before) = private_value_store();
    assert_eq!(block.boundary.block.transaction_bytes[0].len(), 31_647);
    let stored = stored_bytes(&store) - before;
    assert!(stored < 12_000, "the index stored {stored} bytes");
}

#[test]
fn output_pages_hold_whole_transactions_charged_by_stored_bytes() {
    // An S transaction's first output row carries its four nullifiers and its
    // arena.
    const FIRST_ROW: u32 = 4_147;
    const LATER_ROW: u32 = 1_387;
    const TRANSACTION: u32 = FIRST_ROW + 4 * LATER_ROW;
    let (store, block, _) = private_value_store();
    let target = IndexBlockId {
        number: 1,
        hash: block.boundary.block.hash,
    };
    let page = |from, max_outputs, max_bytes| {
        store.output_page(
            from,
            target,
            None,
            OutputLimits {
                max_outputs,
                max_bytes,
            },
        )
    };
    let whole = page(0, 5, TRANSACTION).unwrap();
    assert_eq!(whole.outputs.len(), 5);
    assert!(whole.complete);
    for (slot, output) in whole.outputs.iter().enumerate() {
        let IndexedOutputMaterial::Ordinary {
            output_slot, arena, ..
        } = &output.material
        else {
            panic!("ordinary output");
        };
        assert_eq!(usize::from(*output_slot), slot);
        let expected = if slot == 0 {
            section_arena()
        } else {
            Vec::new()
        };
        assert_eq!(*arena, expected);
        let stored = output.encode().len() as u32;
        assert_eq!(stored, if slot == 0 { FIRST_ROW } else { LATER_ROW });
    }
    // A budget one row or one byte short of the transaction holds nothing.
    for (max_outputs, max_bytes) in [(4, OutputLimits::HARD_MAX_BYTES), (5, TRANSACTION - 1)] {
        match page(0, max_outputs, max_bytes) {
            Err(OutputError::InvalidRequest(message)) => {
                assert_eq!(message, "limits are too small for one transaction");
            }
            other => panic!("{other:?}"),
        }
    }
    // An index inside the transaction rewinds to its first output, and the
    // rewound index rewinds to itself.
    for from in [0, 3, 4] {
        let rewound = page(from, 5, TRANSACTION).unwrap();
        assert_eq!(rewound.from_output_index, 0, "from {from}");
        assert_eq!(rewound.outputs, whole.outputs);
    }
    // The end of the interval is a unit boundary and needs no row.
    let end = page(5, 1, 1).unwrap();
    assert_eq!(end.from_output_index, 5);
    assert!(end.outputs.is_empty());
    assert!(end.complete);
}

/// Two S transactions and a payout row: pages break only between units, a
/// continuation resumes only at a unit boundary, and a request inside the
/// second transaction rewinds to its first output.
#[test]
fn output_continuations_resume_only_at_unit_boundaries() {
    let store = DerivedIndexStore::create_in_memory().unwrap();
    let genesis = fixture(0, B256::ZERO, 0x21);
    store
        .bind_identity(TEST_PCASH_CHAIN_ID, genesis.boundary.block.hash)
        .unwrap();
    apply_fixture(&store, &genesis);
    let first = private_value_fixture_at(1, genesis.boundary.block.hash, 0x22, 0);
    apply_fixture(&store, &first);
    let mut second = private_value_fixture_at(2, first.boundary.block.hash, 0x23, 5);
    let mut tree = pcash_state::SparseTree::new(pcash_state::TREE_DEPTH);
    add_payout(
        &mut second,
        &mut tree,
        10,
        pcash_state::PayoutComponent::Issuance,
    );
    apply_fixture(&store, &second);
    let target = IndexBlockId {
        number: 2,
        hash: second.boundary.block.hash,
    };
    let limits = |max_outputs| OutputLimits {
        max_outputs,
        max_bytes: OutputLimits::HARD_MAX_BYTES,
    };
    let indices = |page: &OutputPage| -> Vec<u64> {
        page.outputs
            .iter()
            .map(|output| output.output_index)
            .collect()
    };

    // Six rows hold the first transaction but not the first and the second.
    let first_page = store.output_page(0, target, None, limits(6)).unwrap();
    assert_eq!(indices(&first_page), (0..5).collect::<Vec<_>>());
    let continuation = first_page.continuation.clone().unwrap();
    assert_eq!(continuation.next_output_index, 5);
    // The second transaction and the payout row fill the next page exactly.
    let second_page = store
        .output_page(0, target, Some(continuation.clone()), limits(6))
        .unwrap();
    assert_eq!(indices(&second_page), (5..11).collect::<Vec<_>>());
    assert!(second_page.complete);
    assert_eq!(second_page.from_output_index, 0);

    // Five rows leave the payout row a page of its own.
    let mut pages = Vec::new();
    let mut continuation = None;
    loop {
        let page = store
            .output_page(0, target, continuation, limits(5))
            .unwrap();
        pages.push(indices(&page));
        if page.complete {
            break;
        }
        continuation = page.continuation;
    }
    assert_eq!(
        pages,
        vec![(0..5).collect::<Vec<_>>(), (5..10).collect(), vec![10]]
    );

    // A request inside the second transaction rewinds to output 5, and its
    // continuation may name either index.
    let rewound = store.output_page(7, target, None, limits(5)).unwrap();
    assert_eq!(rewound.from_output_index, 5);
    assert_eq!(indices(&rewound), (5..10).collect::<Vec<_>>());
    let rest = rewound.continuation.unwrap();
    assert_eq!(rest.from_output_index, 5);
    for from in [5, 7, 9] {
        let page = store
            .output_page(from, target, Some(rest.clone()), limits(5))
            .unwrap();
        assert_eq!(indices(&page), vec![10]);
        assert_eq!(page.from_output_index, 5);
    }
    // A payout row is a unit of its own and never rewinds.
    let payout = store.output_page(10, target, None, limits(1)).unwrap();
    assert_eq!(payout.from_output_index, 10);
    assert_eq!(indices(&payout), vec![10]);

    // A continuation whose next index falls inside a transaction is not one
    // this node issued.
    for next_output_index in [1, 6, 9] {
        let inside = continuation_at(&first_page, next_output_index);
        assert!(matches!(
            store.output_page(0, target, Some(inside), limits(5)),
            Err(OutputError::CursorMismatch)
        ));
    }

    // After a reorg rewinds the second block, the first block's interval
    // still pages and rewinds the same way.
    store
        .rewind_to(IndexBlockId {
            number: 1,
            hash: first.boundary.block.hash,
        })
        .unwrap();
    let first_target = IndexBlockId {
        number: 1,
        hash: first.boundary.block.hash,
    };
    let after = store.output_page(2, first_target, None, limits(5)).unwrap();
    assert_eq!(after.from_output_index, 0);
    assert_eq!(after.target.output_count, 5);
    assert_eq!(indices(&after), (0..5).collect::<Vec<_>>());
    assert!(after.complete);
    assert!(matches!(
        store.output_page(0, target, None, limits(5)),
        Err(OutputError::Unavailable(_))
    ));
}

/// `page`'s continuation with its next index set to `next_output_index`.
fn continuation_at(page: &OutputPage, next_output_index: u64) -> OutputContinuation {
    OutputContinuation {
        next_output_index,
        ..page.continuation.clone().unwrap()
    }
}

#[test]
fn a_payout_row_too_large_for_the_byte_budget_is_an_invalid_request() {
    let store = DerivedIndexStore::create_in_memory().unwrap();
    let genesis = fixture(0, B256::ZERO, 1);
    store
        .bind_identity(TEST_PCASH_CHAIN_ID, genesis.boundary.block.hash)
        .unwrap();
    apply_fixture(&store, &genesis);
    let mut tree = pcash_state::SparseTree::new(pcash_state::TREE_DEPTH);
    let mut first = fixture(1, genesis.boundary.block.hash, 2);
    add_payout(
        &mut first,
        &mut tree,
        0,
        pcash_state::PayoutComponent::Issuance,
    );
    apply_fixture(&store, &first);
    let target = IndexBlockId {
        number: 1,
        hash: first.boundary.block.hash,
    };
    match store.output_page(
        0,
        target,
        None,
        OutputLimits {
            max_outputs: 1,
            max_bytes: 1,
        },
    ) {
        Err(OutputError::InvalidRequest(message)) => {
            assert_eq!(message, "limits are too small for one output");
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn canonical_apply_populates_cursor_receipts_material_and_wallet_projection() {
    let tmp = tempfile::tempdir().unwrap();
    let store = DerivedIndexStore::create(tmp.path().join("state.index.redb")).unwrap();
    let first = fixture(0, B256::ZERO, 0x10);
    store.bind_identity(7, first.boundary.block.hash).unwrap();
    let cursor = apply_fixture(&store, &first);

    assert_eq!(store.cursor().unwrap(), Some(cursor));
    assert_eq!(store.transaction_totals().unwrap(), (1, 0, 1));
    assert_eq!(
        store.receipt_by_txid(&first.receipt.tx_id).unwrap(),
        Some(first.receipt.clone())
    );
    let account = first.receipt.account.as_ref().unwrap();
    assert_eq!(
        store
            .receipt_by_account(&account.address, account.account_revision)
            .unwrap(),
        Some(first.receipt.clone())
    );
    let material = store
        .receive_material(account.address, account.account_revision)
        .unwrap()
        .unwrap();
    assert_eq!(material.key, Some(vec![0x10; 1_184]));

    let page = store
        .output_page(
            0,
            IndexBlockId {
                number: 0,
                hash: first.boundary.block.hash,
            },
            None,
            OutputLimits {
                max_outputs: 1,
                max_bytes: OutputLimits::HARD_MAX_BYTES,
            },
        )
        .unwrap();
    assert!(page.complete);
    assert_eq!(page.target.output_count, 0);
    assert!(page.outputs.is_empty());
}

#[test]
fn output_commitment_scan_is_sparse_and_continuations_bind_the_target() {
    let tmp = tempfile::tempdir().unwrap();
    let store = DerivedIndexStore::create(tmp.path().join("state.index.redb")).unwrap();
    let first = fixture(0, B256::ZERO, 0x11);
    store.bind_identity(7, first.boundary.block.hash).unwrap();
    apply_fixture(&store, &first);
    let target = IndexBlockId {
        number: 0,
        hash: first.boundary.block.hash,
    };
    let mut block = store.indexed_block(0).unwrap().unwrap();
    block.output_count = 3;
    let mut write = store.db.begin_write().unwrap();
    write.set_durability(Durability::Immediate).unwrap();
    {
        let mut blocks = write.open_table(T_INDEXED_BLOCKS).unwrap();
        blocks
            .insert(pcash_block_key(0).as_slice(), block.encode().as_slice())
            .unwrap();
        let mut outputs = write.open_table(T_OUTPUTS).unwrap();
        for output_index in [0, 2] {
            let output = IndexedOutputItem {
                output_index,
                output_commitment: B256::repeat_byte(0x20 + output_index as u8),
                material: IndexedOutputMaterial::Ordinary {
                    output_data: vec![0x30 + output_index as u8],
                    transaction_id: B256::repeat_byte(0x40 + output_index as u8),
                    transaction_kind: 0,
                    private_value_shape: Some(0),
                    output_slot: 0,
                    content_hash: B256::repeat_byte(0x50 + output_index as u8),
                    nullifiers: vec![B256::repeat_byte(0x60 + output_index as u8)],
                    arena: vec![0x70 + output_index as u8],
                },
                pcash_block_number: 0,
                pcash_block_hash: target.hash,
            };
            outputs
                .insert(
                    output_key(output_index).as_slice(),
                    output.encode().as_slice(),
                )
                .unwrap();
        }
    }
    write.commit().unwrap();
    let limits = OutputLimits {
        max_outputs: 1,
        max_bytes: OutputLimits::HARD_MAX_BYTES,
    };
    let first_page = store.output_page(0, target, None, limits).unwrap();
    assert_eq!(first_page.outputs[0].output_index, 0);
    assert!(!first_page.complete);
    let continuation = first_page.continuation.unwrap();
    assert_eq!(continuation.next_output_index, 2);
    let second_page = store
        .output_page(0, target, Some(continuation.clone()), limits)
        .unwrap();
    assert_eq!(second_page.outputs[0].output_index, 2);
    assert!(second_page.complete);
    let mut mismatched = continuation;
    mismatched.target_output_count = 4;
    assert!(matches!(
        store.output_page(0, target, Some(mismatched), limits),
        Err(OutputError::CursorMismatch)
    ));
}

#[test]
fn block_economics_rows_follow_apply_rewind_and_bucketing() {
    let store = DerivedIndexStore::create_in_memory().unwrap();
    let economics = |actions: u64, issued: u64, baseline: u64| pcash_state::BlockEconomics {
        open_fees_total: U256::from(actions),
        issuance_total: U256::from(issued),
        qualifying_actions: actions,
        reward_each: U256::from(issued / actions.max(1)),
        baseline: U256::from(baseline),
        internal_offer: U256::from(baseline / 16),
        block_allowance: U256::from(baseline * 3),
    };
    let mut first = fixture(0, B256::ZERO, 0x30);
    first.boundary.history.economics = economics(2, 100, 700);
    store.bind_identity(7, first.boundary.block.hash).unwrap();
    apply_fixture(&store, &first);
    let mut second = fixture(1, first.boundary.block.hash, 0x31);
    second.boundary.history.economics = economics(3, 300, 690);
    apply_fixture(&store, &second);
    let mut third = fixture(2, second.boundary.block.hash, 0x32);
    third.boundary.history.economics = economics(0, 0, 680);
    let cursor = apply_fixture(&store, &third);

    let rows = store.block_economics_from(0, 10).unwrap();
    assert_eq!(
        rows.iter().map(|(number, _)| *number).collect::<Vec<_>>(),
        vec![0, 1, 2]
    );
    assert_eq!(rows[0].1.l1_number, 100);
    assert_eq!(rows[2].1.timestamp, 1_002);
    assert_eq!(rows[1].1.issuance_total, U256::from(300));
    assert_eq!(rows[1].1.lag_q, alloy_primitives::I256::ZERO);
    assert_eq!(store.block_economics_from(3, 10).unwrap().len(), 0);

    let read = store.read_snapshot().unwrap();
    let page = crate::node::block_economics_page(
        &read,
        cursor,
        pcash_rpc::BlockEconomicsQuery {
            from_block: Some(1),
            limit: None,
            bucket: Some(2),
        },
    )
    .unwrap();
    assert_eq!(page.at_block_number, 2);
    assert_eq!(page.at_block_hash, third.boundary.block.hash);
    assert_eq!(page.records.len(), 2);
    let full = &page.records[0];
    assert_eq!((full.first_block, full.last_block, full.blocks), (0, 1, 2));
    assert_eq!((full.first_timestamp, full.last_timestamp), (1_000, 1_001));
    assert_eq!(full.qualifying_actions, 5);
    assert_eq!(full.issuance_total, U256::from(400));
    assert_eq!(full.open_fees_total, U256::from(5));
    assert_eq!(full.baseline, U256::from(690));
    assert_eq!(full.reward_each, U256::from(100));
    let partial = &page.records[1];
    assert_eq!(
        (partial.first_block, partial.last_block, partial.blocks),
        (2, 2, 1)
    );
    assert_eq!(partial.baseline, U256::from(680));
    assert_eq!(page.next_block, None);

    let limited = crate::node::block_economics_page(
        &read,
        cursor,
        pcash_rpc::BlockEconomicsQuery {
            from_block: None,
            limit: Some(1),
            bucket: Some(2),
        },
    )
    .unwrap();
    assert_eq!(limited.records.len(), 1);
    assert_eq!(limited.next_block, Some(2));

    let beyond = crate::node::block_economics_page(
        &read,
        cursor,
        pcash_rpc::BlockEconomicsQuery {
            from_block: Some(3),
            limit: None,
            bucket: None,
        },
    )
    .unwrap();
    assert!(beyond.records.is_empty());
    assert_eq!(beyond.next_block, None);

    assert!(matches!(
        crate::node::block_economics_page(
            &read,
            cursor,
            pcash_rpc::BlockEconomicsQuery {
                from_block: None,
                limit: Some(0),
                bucket: None,
            },
        ),
        Err(pcash_rpc::IndexReadError::Invalid(_))
    ));

    store
        .rewind_to(IndexBlockId {
            number: 1,
            hash: second.boundary.block.hash,
        })
        .unwrap();
    assert_eq!(store.block_economics_from(0, 10).unwrap().len(), 2);
}

#[test]
fn block_economics_pages_make_progress_when_a_bucket_fills_the_scan_budget() {
    let store = DerivedIndexStore::create_in_memory().unwrap();
    let mut parent = B256::ZERO;
    let mut cursor = None;
    for number in 0..8u64 {
        let mut block = fixture(number, parent, 0x40 + number as u8);
        block.boundary.history.economics = pcash_state::BlockEconomics {
            qualifying_actions: number,
            issuance_total: U256::from(number * 10),
            ..Default::default()
        };
        if number == 0 {
            store.bind_identity(7, block.boundary.block.hash).unwrap();
        }
        cursor = Some(apply_fixture(&store, &block));
        parent = block.boundary.block.hash;
    }
    let cursor = cursor.unwrap();
    let read = store.read_snapshot().unwrap();
    let limits = crate::node::BlockEconomicsLimits {
        records: 1024,
        bucket: 4,
        scanned_rows: 4,
    };
    let follow = |bucket: u64, from: u64| {
        let mut pages = Vec::new();
        let mut next = Some(from);
        while let Some(from_block) = next {
            let page = crate::node::block_economics_page_with_limits(
                &read,
                cursor,
                pcash_rpc::BlockEconomicsQuery {
                    from_block: Some(from_block),
                    limit: None,
                    bucket: Some(bucket),
                },
                limits,
            )
            .unwrap();
            assert!(
                !page.records.is_empty(),
                "a page must make progress before continuing"
            );
            next = page.next_block;
            pages.push(page);
        }
        pages
    };
    let coverage = |pages: &[pcash_rpc::dto::BlockEconomicsPageDto]| {
        let mut covered = Vec::new();
        for record in pages.iter().flat_map(|page| page.records.iter()) {
            assert_eq!(record.blocks, record.last_block - record.first_block + 1);
            assert_eq!(
                record.qualifying_actions,
                (record.first_block..=record.last_block).sum::<u64>()
            );
            covered.extend(record.first_block..=record.last_block);
        }
        covered
    };

    // A bucket exactly the size of the scan budget: one bucket per page.
    let pages = follow(4, 0);
    assert_eq!(pages.len(), 2);
    assert_eq!(coverage(&pages), (0..8).collect::<Vec<_>>());
    assert_eq!(pages[0].records[0].last_block, 3);
    assert_eq!(pages[1].records[0].first_block, 4);
    assert_eq!(pages[1].next_block, None);

    // A bucket smaller than the budget leaves a partial bucket at the end of
    // each scan; it is retried from its first block, never dropped.
    let pages = follow(3, 0);
    assert_eq!(pages.len(), 3);
    assert_eq!(coverage(&pages), (0..8).collect::<Vec<_>>());
    assert_eq!(pages[0].next_block, Some(3));
    assert_eq!(pages[1].next_block, Some(6));
    let last = &pages[2].records[0];
    assert_eq!((last.first_block, last.last_block, last.blocks), (6, 7, 2));

    // Starting inside a bucket rounds down to that bucket's first block.
    let pages = follow(3, 5);
    assert_eq!(pages.len(), 2);
    assert_eq!(coverage(&pages), (3..8).collect::<Vec<_>>());

    // A bucket larger than the budget is rejected instead of looping.
    assert!(matches!(
        crate::node::block_economics_page_with_limits(
            &read,
            cursor,
            pcash_rpc::BlockEconomicsQuery {
                from_block: None,
                limit: None,
                bucket: Some(5),
            },
            limits,
        ),
        Err(pcash_rpc::IndexReadError::Invalid(_))
    ));
}

#[test]
fn rewind_removes_later_rows_and_transaction_totals() {
    let tmp = tempfile::tempdir().unwrap();
    let store = DerivedIndexStore::create(tmp.path().join("state.index.redb")).unwrap();
    let first = fixture(0, B256::ZERO, 0x30);
    store.bind_identity(7, first.boundary.block.hash).unwrap();
    apply_fixture(&store, &first);
    let second = fixture(1, first.boundary.block.hash, 0x31);
    apply_fixture(&store, &second);

    store
        .rewind_to(IndexBlockId {
            number: 0,
            hash: first.boundary.block.hash,
        })
        .unwrap();
    assert_eq!(store.transaction_totals().unwrap(), (1, 0, 1));
    assert!(store
        .get_block(first.boundary.l1_origin.block_number)
        .unwrap()
        .is_some());
    assert!(store
        .get_block(second.boundary.l1_origin.block_number)
        .unwrap()
        .is_none());
    assert!(store
        .receipt_by_txid(&second.receipt.tx_id)
        .unwrap()
        .is_none());
    assert!(store
        .receipt_by_txid(&first.receipt.tx_id)
        .unwrap()
        .is_some());
    let second_account = second.receipt.account.as_ref().unwrap();
    assert!(store
        .receive_material(second_account.address, second_account.account_revision)
        .unwrap()
        .is_none());
}

#[test]
fn rewinding_a_repeated_success_keeps_the_earlier_success_pointer() {
    let tmp = tempfile::tempdir().unwrap();
    let store = DerivedIndexStore::create(tmp.path().join("state.index.redb")).unwrap();
    let genesis = fixture(0, B256::ZERO, 0x2f);
    store.bind_identity(7, genesis.boundary.block.hash).unwrap();
    apply_fixture(&store, &genesis);
    let first = fixture(1, genesis.boundary.block.hash, 0x30);
    apply_fixture(&store, &first);
    // The same direct-creation bytes from another L1 sender also succeed.
    let mut second = fixture(2, first.boundary.block.hash, 0x31);
    second.receipt.content_hash = first.receipt.content_hash;
    apply_fixture(&store, &second);
    let success = || {
        store
            .succeeded_receipt_by_content(first.receipt.content_hash)
            .unwrap()
            .map(|receipt| receipt.tx_id)
    };
    assert_eq!(success(), Some(first.receipt.tx_id));

    store
        .rewind_to(IndexBlockId {
            number: 1,
            hash: first.boundary.block.hash,
        })
        .unwrap();
    assert_eq!(success(), Some(first.receipt.tx_id));

    store
        .rewind_to(IndexBlockId {
            number: 0,
            hash: genesis.boundary.block.hash,
        })
        .unwrap();
    assert_eq!(success(), None);
}

#[test]
fn keep_material_survives_live_apply_restart_and_reorg() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("state.index.redb");
    let store = DerivedIndexStore::create(&path).unwrap();
    let first = fixture(0, B256::ZERO, 1);
    store.bind_identity(7, first.boundary.block.hash).unwrap();
    apply_fixture(&store, &first);
    let address = first.receipt.account.as_ref().unwrap().address;
    let original = store.receive_material(address, 1).unwrap().unwrap();

    let second = update_fixture(
        1,
        first.boundary.block.hash,
        2,
        address,
        2,
        ReceiveKeyUpdate::Keep,
    );
    apply_fixture(&store, &second);

    let carried = store.receive_material(address, 2).unwrap().unwrap();
    assert_eq!(carried.key, original.key);
    {
        let read = store.db.begin_read().unwrap();
        let receive = read.open_table(T_RECEIVE_MATERIAL).unwrap();
        assert_eq!(receive.iter().unwrap().count(), 2);
        let key = receive_material_key(&address, 2);
        let stored = receive.get(key.as_slice()).unwrap().unwrap();
        let key_bytes = carried.key.as_ref().unwrap().len();
        assert_eq!(stored.value().len(), 1 + 8 + key_bytes);
        assert_eq!(
            ReceiveMaterialUpdate::decode(stored.value()).unwrap(),
            carried
        );
    }

    drop(store);
    let reopened = DerivedIndexStore::open(&path).unwrap();
    assert_eq!(
        reopened.receive_material(address, 2).unwrap().unwrap(),
        carried
    );
    reopened
        .rewind_to(IndexBlockId {
            number: 0,
            hash: first.boundary.block.hash,
        })
        .unwrap();
    assert!(reopened.receive_material(address, 2).unwrap().is_none());
    assert_eq!(
        reopened.receive_material(address, 1).unwrap().unwrap(),
        original
    );
}

#[test]
fn clear_keep_after_clear_replace_and_rewind_preserve_normalized_semantics() {
    let tmp = tempfile::tempdir().unwrap();
    let store = DerivedIndexStore::create(tmp.path().join("state.index.redb")).unwrap();
    let first = fixture(0, B256::ZERO, 1);
    let address = first.receipt.account.as_ref().unwrap().address;
    store.bind_identity(7, first.boundary.block.hash).unwrap();
    apply_fixture(&store, &first);

    let second = update_fixture(
        1,
        first.boundary.block.hash,
        2,
        address,
        2,
        ReceiveKeyUpdate::Clear,
    );
    apply_fixture(&store, &second);
    assert_eq!(
        store.receive_material(address, 2).unwrap().unwrap().key,
        None
    );

    let third = update_fixture(
        2,
        second.boundary.block.hash,
        3,
        address,
        3,
        ReceiveKeyUpdate::Keep,
    );
    apply_fixture(&store, &third);
    assert_eq!(
        store.receive_material(address, 3).unwrap().unwrap().key,
        None
    );

    let replacement = [0x7c; pcash_state::ML_KEM768_PUBLIC_KEY_LEN];
    let fourth = update_fixture(
        3,
        third.boundary.block.hash,
        4,
        address,
        4,
        ReceiveKeyUpdate::Replace(Box::new(replacement)),
    );
    apply_fixture(&store, &fourth);
    assert_eq!(
        store.receive_material(address, 4).unwrap().unwrap().key,
        Some(replacement.to_vec())
    );

    store
        .rewind_to(IndexBlockId {
            number: 2,
            hash: third.boundary.block.hash,
        })
        .unwrap();
    assert!(store.receive_material(address, 4).unwrap().is_none());
    assert_eq!(
        store.receive_material(address, 3).unwrap().unwrap().key,
        None
    );
}

#[test]
fn keep_material_resolves_sequentially_within_one_index_block() {
    let tmp = tempfile::tempdir().unwrap();
    let store = DerivedIndexStore::create(tmp.path().join("state.index.redb")).unwrap();
    let mut fixture = fixture(0, B256::ZERO, 1);
    let address = fixture.receipt.account.as_ref().unwrap().address;
    let transaction = account_update_transaction(address, &ReceiveKeyUpdate::Keep);
    let first_transaction = fixture.boundary.block.transaction_bytes[0].clone();
    let content_hash = pcash_state::content_hash(&transaction);
    let transaction_id = pcash_state::transaction_id(fixture.boundary.l1_origin.block_hash, 0, 1);
    fixture.transactions.push(user_account_effects(
        pcash_derive::KIND_USER_ACCOUNT_UPDATE,
        address,
        2,
        ReceiveKeyOperation::Keep,
    ));
    fixture.boundary.block = pcash_state::PcashBlock::new(
        B256::ZERO,
        &pcash_state::BlockInput {
            transaction_effects: Vec::new(),
            l1_logs: Vec::new(),
            history: pcash_state::CanonicalBlockHistory::default(),
            number: 0,
            timestamp: fixture.boundary.block.header.timestamp,
            transaction_results: vec![
                entry_result(0, 0, TransactionOutcome::Succeeded),
                entry_result(0, 1, TransactionOutcome::Succeeded),
            ],
            transaction_bytes: vec![first_transaction, transaction],
            l1_origin: fixture.boundary.l1_origin.clone(),
        },
        fixture.boundary.block.header.state_root,
        Fr::from(2u64),
        Fr::from(3u64),
    );
    let second_receipt = ReceiptRecord {
        pcash_transaction_index: 1,
        lifecycle_address: None,
        l1_block_number: fixture.receipt.l1_block_number,
        l1_block_hash: fixture.receipt.l1_block_hash,
        l1_transaction_index: 0,
        l1_transaction_hash: B256::repeat_byte(0x99),
        batch_item_index: 1,
        content_hash,
        tx_id: transaction_id,
        outcome: TransactionOutcome::Succeeded,
        failure_detail: None,
        l1_sender: Address::ZERO,
        issuance_owner_commitment: None,
        settled_open_fee_amount: U256::ZERO,
        settled_issuance_amount: U256::ZERO,
        has_open_fee: true,
        byte_size: 0,
        kind: pcash_derive::KIND_USER_ACCOUNT_UPDATE,
        funding_mode: None,
        output_leaf_start: None,
        outputs_added: 0,
        nullifiers: None,
        account: Some(AccountReceiptData {
            address,
            account_revision: 2,
        }),
    };
    store.bind_identity(7, fixture.boundary.block.hash).unwrap();
    store
        .apply_block(
            &fixture.boundary,
            &fixture.transactions.iter().collect::<Vec<_>>(),
            &fixture.l1_logs,
            &[fixture.receipt.clone(), second_receipt],
            None,
            true,
        )
        .unwrap();

    let first = store.receive_material(address, 1).unwrap().unwrap();
    let second = store.receive_material(address, 2).unwrap().unwrap();
    assert_eq!(second.key, first.key);
}

struct StubVerification(std::collections::HashMap<Address, Option<ContractSourceInfo>>);

impl StubVerification {
    fn new(entries: &[(Address, Option<ContractSourceInfo>)]) -> Self {
        Self(entries.iter().copied().collect())
    }
}

impl ContractVerificationLookup for StubVerification {
    fn lookup(
        &self,
        address: Address,
        _functions: &[ContractFunctionMaterial],
    ) -> Option<ContractSourceInfo> {
        self.0.get(&address).copied().flatten()
    }
}

fn verified(opening_count: u64) -> Option<ContractSourceInfo> {
    Some(ContractSourceInfo {
        verified: true,
        opening_count,
    })
}

fn unverified() -> Option<ContractSourceInfo> {
    Some(ContractSourceInfo {
        verified: false,
        opening_count: 0,
    })
}

struct ContractFixture {
    boundary: pcash_state::CommittedBoundary,
    transactions: Vec<TransactionEffects>,
    l1_logs: pcash_l1::NormalizedLogBlock,
    receipts: Vec<ReceiptRecord>,
}

fn contract_creation_transaction(function: &ContractFunctionMaterial) -> Vec<u8> {
    Transaction::ContractAccountCreation(ContractAccountCreation {
        body: ContractBody::new(
            false,
            B256::repeat_byte(6),
            None,
            vec![ContractFunction {
                selector: function.selector,
                application_vk_hash: function.application_vk_hash,
                configuration_commitment: function.configuration_commitment,
            }],
        )
        .unwrap(),
        funding: ContractFunding::Sponsored(zero_fee_private_value_section(
            SectionLayout::ContractAccountCreation,
        )),
    })
    .encode(TEST_PCASH_CHAIN_ID)
    .unwrap()
}

fn contract_fixture(
    number: u64,
    parent_hash: B256,
    seed: u8,
    addresses: &[Address],
) -> ContractFixture {
    let l1_data = pcash_l1::L1BlockData::new(
        pcash_l1::L1Header {
            number: 100 + number,
            hash: B256::repeat_byte(seed),
            parent_hash: B256::repeat_byte(seed.wrapping_sub(1)),
            timestamp: 1_000 + number,
        },
        vec![(
            pcash_l1::L1Tx {
                hash: B256::repeat_byte(seed.wrapping_add(1)),
                from: Address::repeat_byte(seed.wrapping_add(2)),
                to: None,
                input: Bytes::new(),
                blob_versioned_hashes: Vec::new(),
                blob_resolution: pcash_l1::BlobResolution::Unresolved,
                tx_index: 0,
            },
            pcash_l1::L1Receipt {
                logs: vec![pcash_l1::L1Log {
                    transaction_index: 0,
                    log_index: 0,
                    emitter: Address::repeat_byte(seed.wrapping_add(3)),
                    topics: vec![B256::repeat_byte(seed.wrapping_add(4))],
                    data: Bytes::from(vec![seed]),
                }],
            },
        )],
    );
    let l1_logs = l1_data.normalized_logs().clone();
    let origin = pcash_state::L1Origin {
        block_number: 100 + number,
        block_hash: B256::repeat_byte(seed),
        block_timestamp: 1_000 + number,
        l1_logs_root: l1_logs.root,
        l1_log_count: l1_logs.count(),
    };
    let transactions = (0..addresses.len())
        .map(|index| {
            contract_creation_transaction(&ContractFunctionMaterial {
                selector: index as u8,
                application_vk_hash: B256::repeat_byte(seed.wrapping_add(7)),
                configuration_commitment: B256::repeat_byte(seed.wrapping_add(8)),
            })
        })
        .collect::<Vec<_>>();
    let results = (0..transactions.len() as u64)
        .map(|index| entry_result(0, index, TransactionOutcome::Succeeded))
        .collect::<Vec<_>>();
    let state = pcash_state::StateCommitment::new(pcash_state::StateComponents {
        output_root: pcash_state::fr_to_bytes(Fr::from(2u64)),
        output_count: 0,
        issuance: pcash_state::IssuanceState {
            issued_so_far: U256::ZERO,
            lag_q: alloy_primitives::I256::ZERO,
        },
        account_state_root: pcash_state::fr_to_bytes(Fr::from(4u64)),
        account_count: addresses.len() as u64,
        nullifier_root: pcash_state::fr_to_bytes(Fr::from(6u64)),
        nullifier_count: 0,
    });
    let state_root = pcash_state::fr_to_bytes(state.root);
    let block = pcash_state::PcashBlock::new(
        parent_hash,
        &pcash_state::BlockInput {
            transaction_effects: Vec::new(),
            l1_logs: Vec::new(),
            history: pcash_state::CanonicalBlockHistory::default(),
            number,
            timestamp: 1_000 + number,
            transaction_results: results,
            transaction_bytes: transactions.clone(),
            l1_origin: origin.clone(),
        },
        state_root,
        Fr::from(number + 2),
        Fr::from(number + 3),
    );
    let effects = addresses
        .iter()
        .map(|address| {
            TransactionEffects::Accepted(AcceptedEffects {
                kind: pcash_derive::KIND_CONTRACT_ACCOUNT_CREATION,
                output_leaf_start: None,
                output_commitments: Vec::new(),
                nullifiers: Vec::new(),
                account: Some(AccountResult::Contract {
                    address: *address,
                    nullifier_key_commitment: B256::repeat_byte(seed.wrapping_add(5)),
                    function_set_commitment: B256::repeat_byte(seed.wrapping_add(6)),
                }),
                payout: None,
            })
        })
        .collect::<Vec<_>>();
    let receipts = addresses
        .iter()
        .zip(&transactions)
        .enumerate()
        .map(|(index, (address, transaction))| ReceiptRecord {
            pcash_transaction_index: index as u64,
            lifecycle_address: None,
            l1_block_number: origin.block_number,
            l1_block_hash: origin.block_hash,
            l1_transaction_index: 0,
            l1_transaction_hash: B256::repeat_byte(0x9a),
            batch_item_index: index as u64,
            content_hash: pcash_state::content_hash(transaction),
            tx_id: pcash_state::transaction_id(origin.block_hash, 0, index as u64),
            outcome: TransactionOutcome::Succeeded,
            failure_detail: None,
            l1_sender: Address::ZERO,
            issuance_owner_commitment: None,
            settled_open_fee_amount: U256::ZERO,
            settled_issuance_amount: U256::ZERO,
            has_open_fee: true,
            byte_size: transaction.len() as u64,
            kind: pcash_derive::KIND_CONTRACT_ACCOUNT_CREATION,
            funding_mode: pcash_rpc::dto::ContractFundingMode::of(transaction),
            output_leaf_start: None,
            outputs_added: 0,
            nullifiers: None,
            account: Some(AccountReceiptData {
                address: *address,
                account_revision: 1,
            }),
        })
        .collect::<Vec<_>>();
    let boundary = pcash_state::CommittedBoundary {
        history: pcash_state::CanonicalBlockHistory::default(),
        block,
        state,
        l1_origin: origin,
        state_outcome: pcash_state::StateOutcome {
            state_root: pcash_state::StateRoot(state_root),
            output_leaf_start: 0,
            outputs_added: 0,
            inserted_nullifiers: Vec::new(),
        },
    };
    ContractFixture {
        boundary,
        transactions: effects,
        l1_logs,
        receipts,
    }
}

fn apply_contract_fixture(
    store: &DerivedIndexStore,
    fixture: &ContractFixture,
    verification: Option<&dyn ContractVerificationLookup>,
) {
    store
        .apply_block(
            &fixture.boundary,
            &fixture.transactions.iter().collect::<Vec<_>>(),
            &fixture.l1_logs,
            &fixture.receipts,
            verification,
            true,
        )
        .unwrap();
}

#[test]
fn indexed_receipts_preserve_open_fee_eligibility() {
    let tmp = tempfile::tempdir().unwrap();
    let store = DerivedIndexStore::create(tmp.path().join("state.index.redb")).unwrap();
    let mut fixture = contract_fixture(
        0,
        B256::ZERO,
        0x51,
        &[Address::repeat_byte(0x61), Address::repeat_byte(0x62)],
    );
    fixture.receipts[0].has_open_fee = true;
    fixture.receipts[1].has_open_fee = false;
    store.bind_identity(7, fixture.boundary.block.hash).unwrap();
    apply_contract_fixture(&store, &fixture, None);
    let rows = store
        .receipts_by_block_ordinal(
            None,
            Some(pcash_derive::KIND_CONTRACT_ACCOUNT_CREATION),
            None,
            2,
        )
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert!(!rows[0].2.has_open_fee);
    assert!(rows[1].2.has_open_fee);
}

#[test]
fn apply_block_indexes_contract_verification_from_the_supplied_lookup() {
    let tmp = tempfile::tempdir().unwrap();
    let store = DerivedIndexStore::create(tmp.path().join("state.index.redb")).unwrap();
    let first = Address::repeat_byte(0x61);
    let second = Address::repeat_byte(0x62);
    let fixture = contract_fixture(0, B256::ZERO, 0x51, &[first, second]);
    store.bind_identity(7, fixture.boundary.block.hash).unwrap();
    let verification = StubVerification::new(&[(first, verified(3)), (second, unverified())]);
    apply_contract_fixture(&store, &fixture, Some(&verification));

    assert_eq!(store.contract_source_info(first).unwrap(), verified(3));
    assert_eq!(store.contract_source_info(second).unwrap(), unverified());
    assert_eq!(store.verified_contract_at(0, 0).unwrap(), Some(first));
    assert_eq!(store.verified_contract_at(0, 1).unwrap(), None);
}

#[test]
fn apply_block_without_a_lookup_writes_no_contract_verification_rows() {
    let tmp = tempfile::tempdir().unwrap();
    let store = DerivedIndexStore::create(tmp.path().join("state.index.redb")).unwrap();
    let first = Address::repeat_byte(0x61);
    let second = Address::repeat_byte(0x62);
    let fixture = contract_fixture(0, B256::ZERO, 0x51, &[first, second]);
    store.bind_identity(7, fixture.boundary.block.hash).unwrap();
    apply_contract_fixture(&store, &fixture, None);

    assert_eq!(store.contract_source_info(first).unwrap(), None);
    assert_eq!(store.contract_source_info(second).unwrap(), None);
    assert_eq!(store.verified_contract_at(0, 0).unwrap(), None);
    assert!(store
        .verified_contract_page(0, None, 10)
        .unwrap()
        .is_empty());
}

#[test]
fn recompute_contract_verification_rewrites_every_row_from_the_current_lookup() {
    let tmp = tempfile::tempdir().unwrap();
    let store = DerivedIndexStore::create(tmp.path().join("state.index.redb")).unwrap();
    let first = Address::repeat_byte(0x61);
    let second = Address::repeat_byte(0x62);
    let third = Address::repeat_byte(0x63);
    let fixture = contract_fixture(0, B256::ZERO, 0x51, &[first, second, third]);
    store.bind_identity(7, fixture.boundary.block.hash).unwrap();
    apply_contract_fixture(
        &store,
        &fixture,
        Some(&StubVerification::new(&[
            (first, verified(3)),
            (second, unverified()),
            (third, verified(4)),
        ])),
    );

    store
        .recompute_contract_verification(&StubVerification::new(&[
            (first, verified(5)),
            (second, verified(7)),
            (third, None),
        ]))
        .unwrap();

    assert_eq!(store.contract_source_info(first).unwrap(), verified(5));
    assert_eq!(store.contract_source_info(second).unwrap(), verified(7));
    assert_eq!(store.contract_source_info(third).unwrap(), None);
    assert_eq!(store.verified_contract_at(0, 0).unwrap(), Some(first));
    assert_eq!(store.verified_contract_at(0, 1).unwrap(), Some(second));
    assert_eq!(store.verified_contract_at(0, 2).unwrap(), None);
}

#[test]
fn update_contract_verification_changes_only_the_named_contract() {
    let tmp = tempfile::tempdir().unwrap();
    let store = DerivedIndexStore::create(tmp.path().join("state.index.redb")).unwrap();
    let first = Address::repeat_byte(0x61);
    let second = Address::repeat_byte(0x62);
    let fixture = contract_fixture(0, B256::ZERO, 0x51, &[first, second]);
    store.bind_identity(7, fixture.boundary.block.hash).unwrap();
    apply_contract_fixture(
        &store,
        &fixture,
        Some(&StubVerification::new(&[
            (first, verified(3)),
            (second, unverified()),
        ])),
    );

    store
        .update_contract_verification(second, &StubVerification::new(&[(second, verified(9))]))
        .unwrap();
    assert_eq!(store.contract_source_info(first).unwrap(), verified(3));
    assert_eq!(store.contract_source_info(second).unwrap(), verified(9));
    assert_eq!(store.verified_contract_at(0, 0).unwrap(), Some(first));
    assert_eq!(store.verified_contract_at(0, 1).unwrap(), Some(second));

    store
        .update_contract_verification(second, &StubVerification::new(&[(second, None)]))
        .unwrap();
    assert_eq!(store.contract_source_info(first).unwrap(), verified(3));
    assert_eq!(store.contract_source_info(second).unwrap(), None);
    assert_eq!(store.verified_contract_at(0, 0).unwrap(), Some(first));
    assert_eq!(store.verified_contract_at(0, 1).unwrap(), None);
}

#[test]
fn rewind_removes_the_verification_rows_of_orphaned_contracts() {
    let tmp = tempfile::tempdir().unwrap();
    let store = DerivedIndexStore::create(tmp.path().join("state.index.redb")).unwrap();
    let retained = Address::repeat_byte(0x61);
    let orphaned = Address::repeat_byte(0x71);
    let first = contract_fixture(0, B256::ZERO, 0x51, &[retained]);
    store.bind_identity(7, first.boundary.block.hash).unwrap();
    apply_contract_fixture(
        &store,
        &first,
        Some(&StubVerification::new(&[(retained, verified(3))])),
    );
    let second = contract_fixture(1, first.boundary.block.hash, 0x52, &[orphaned]);
    apply_contract_fixture(
        &store,
        &second,
        Some(&StubVerification::new(&[(orphaned, verified(4))])),
    );
    assert_eq!(store.verified_contract_at(1, 0).unwrap(), Some(orphaned));

    store
        .rewind_to(IndexBlockId {
            number: 0,
            hash: first.boundary.block.hash,
        })
        .unwrap();

    assert_eq!(store.contract_source_info(orphaned).unwrap(), None);
    assert_eq!(store.verified_contract_at(1, 0).unwrap(), None);
    assert_eq!(store.contract_source_info(retained).unwrap(), verified(3));
    assert_eq!(store.verified_contract_at(0, 0).unwrap(), Some(retained));
}

#[test]
fn verified_contract_page_pages_the_verified_subset_in_creation_order() {
    let tmp = tempfile::tempdir().unwrap();
    let store = DerivedIndexStore::create(tmp.path().join("state.index.redb")).unwrap();
    let first = Address::repeat_byte(0x61);
    let second = Address::repeat_byte(0x62);
    let third = Address::repeat_byte(0x63);
    let fixture = contract_fixture(0, B256::ZERO, 0x51, &[first, second, third]);
    store.bind_identity(7, fixture.boundary.block.hash).unwrap();
    apply_contract_fixture(
        &store,
        &fixture,
        Some(&StubVerification::new(&[
            (first, verified(3)),
            (second, unverified()),
            (third, verified(4)),
        ])),
    );

    let unfiltered = store
        .contract_material_page(0, None, 10)
        .unwrap()
        .into_iter()
        .map(|material| material.address)
        .collect::<Vec<_>>();
    assert_eq!(unfiltered, vec![third, second, first]);
    let verified_addresses = store
        .verified_contract_page(0, None, 10)
        .unwrap()
        .into_iter()
        .map(|material| material.address)
        .collect::<Vec<_>>();
    assert_eq!(verified_addresses, vec![third, first]);

    let page = store.verified_contract_page(0, None, 1).unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].address, third);
    let next = store
        .verified_contract_page(
            0,
            Some((page[0].pcash_block_number, page[0].pcash_transaction_index)),
            1,
        )
        .unwrap();
    assert_eq!(next.len(), 1);
    assert_eq!(next[0].address, first);
    assert!(store
        .verified_contract_page(
            0,
            Some((next[0].pcash_block_number, next[0].pcash_transaction_index)),
            1,
        )
        .unwrap()
        .is_empty());
    assert_eq!(store.verified_contract_at(0, 1).unwrap(), None);
}

fn node_inner_for(index: DerivedIndexStore, path: &std::path::Path) -> crate::node::NodeInner {
    let rules = pcash_derive::ProtocolRules::new([vec![0xaa], vec![]], vec![0xcc], vec![0xdd]);
    let state = pcash_state::RedbState::create(
        path,
        pcash_state::DerivationSource {
            pcash_chain_id: TEST_PCASH_CHAIN_ID,
            l1_chain_id: 1,
            inbox_address: Address::ZERO,
            genesis_l1_block: 0,
            genesis_l1_block_hash: B256::ZERO,
        },
        rules.base_fork_schedule_prefix_hash(),
    )
    .unwrap();
    crate::node::NodeInner::new(state, index, rules)
}

#[test]
fn contract_verification_changed_recomputes_when_ready_and_writes_nothing_when_not() {
    use std::sync::{Arc, Mutex};

    let tmp = tempfile::tempdir().unwrap();
    let store = DerivedIndexStore::create(tmp.path().join("state.index.redb")).unwrap();
    let first = Address::repeat_byte(0x61);
    let second = Address::repeat_byte(0x62);
    let fixture = contract_fixture(0, B256::ZERO, 0x51, &[first, second]);
    store
        .bind_identity(TEST_PCASH_CHAIN_ID, fixture.boundary.block.hash)
        .unwrap();
    apply_contract_fixture(&store, &fixture, None);
    assert_eq!(store.contract_source_info(first).unwrap(), None);
    let cursor = store.cursor().unwrap().unwrap();

    let inner = Arc::new(Mutex::new(node_inner_for(
        store,
        &tmp.path().join("state.redb"),
    )));
    let handle = crate::node::NodeHandle::new(Arc::clone(&inner));
    {
        let mut guard = inner.lock().unwrap();
        guard.contract_verification = Some(Arc::new(StubVerification::new(&[
            (first, verified(3)),
            (second, unverified()),
        ])));
        guard.set_index_lifecycle(DerivedIndexLifecycle::Ready(cursor));
    }

    handle.contract_verification_changed(None).unwrap();
    {
        let guard = inner.lock().unwrap();
        assert_eq!(
            guard.index.contract_source_info(first).unwrap(),
            verified(3)
        );
        assert_eq!(
            guard.index.contract_source_info(second).unwrap(),
            unverified()
        );
        assert_eq!(guard.index.verified_contract_at(0, 0).unwrap(), Some(first));
    }

    {
        let mut guard = inner.lock().unwrap();
        guard.contract_verification =
            Some(Arc::new(StubVerification::new(&[(first, verified(9))])));
        guard.set_index_lifecycle(DerivedIndexLifecycle::Unavailable);
    }
    handle.contract_verification_changed(None).unwrap();
    {
        let guard = inner.lock().unwrap();
        assert_eq!(
            guard.index.contract_source_info(first).unwrap(),
            verified(3)
        );
        assert_eq!(
            guard.index.contract_source_info(second).unwrap(),
            unverified()
        );
        assert_eq!(guard.index.verified_contract_at(0, 0).unwrap(), Some(first));
    }

    // No canonical block was ever committed to this state, so an explicit
    // recompute has nothing to rebuild and does not report the index unready.
    handle.recompute_contract_verification().unwrap();
}

#[test]
fn recompute_clears_the_rows_an_unavailable_source_registry_cannot_answer_for() {
    use std::sync::{Arc, Mutex};

    let tmp = tempfile::tempdir().unwrap();
    let store = DerivedIndexStore::create(tmp.path().join("state.index.redb")).unwrap();
    let address = Address::repeat_byte(0x61);
    let fixture = contract_fixture(0, B256::ZERO, 0x51, &[address]);
    store
        .bind_identity(TEST_PCASH_CHAIN_ID, fixture.boundary.block.hash)
        .unwrap();
    apply_contract_fixture(
        &store,
        &fixture,
        Some(&StubVerification::new(&[(address, verified(3))])),
    );
    let cursor = store.cursor().unwrap().unwrap();

    let inner = Arc::new(Mutex::new(node_inner_for(
        store,
        &tmp.path().join("state.redb"),
    )));
    inner
        .lock()
        .unwrap()
        .set_index_lifecycle(DerivedIndexLifecycle::Ready(cursor));

    // A registry path that cannot be opened leaves the service loaded but with
    // no snapshot, so every summary errors and every lookup through it answers
    // `None`.
    let unavailable = Arc::new(pcash_pscan::registry::SourceVerificationService::open(
        tmp.path(),
        TEST_PCASH_CHAIN_ID,
        B256::ZERO,
        None,
    ));
    assert_eq!(
        unavailable.info().status,
        pcash_pscan::dto::SourceVerificationStatus::Unavailable
    );
    let handle =
        crate::node::NodeHandle::new(Arc::clone(&inner)).with_source_verification(unavailable);

    handle.contract_verification_changed(None).unwrap();
    {
        let guard = inner.lock().unwrap();
        assert_eq!(guard.index.contract_source_info(address).unwrap(), None);
        assert_eq!(guard.index.verified_contract_at(0, 0).unwrap(), None);
    }

    inner.lock().unwrap().contract_verification =
        Some(Arc::new(StubVerification::new(&[(address, verified(3))])));
    handle.contract_verification_changed(None).unwrap();
    let guard = inner.lock().unwrap();
    assert_eq!(
        guard.index.contract_source_info(address).unwrap(),
        verified(3)
    );
    assert_eq!(
        guard.index.verified_contract_at(0, 0).unwrap(),
        Some(address)
    );
}

#[test]
fn a_rejected_admin_publication_maps_its_class_and_leaves_the_verification_view_alone() {
    use std::sync::{Arc, Mutex};

    use pcash_rpc::{AdminApi, AdminApiError};

    let tmp = tempfile::tempdir().unwrap();
    let store = DerivedIndexStore::create(tmp.path().join("state.index.redb")).unwrap();
    let address = Address::repeat_byte(0x61);
    let fixture = contract_fixture(0, B256::ZERO, 0x51, &[address]);
    store
        .bind_identity(TEST_PCASH_CHAIN_ID, fixture.boundary.block.hash)
        .unwrap();
    apply_contract_fixture(
        &store,
        &fixture,
        Some(&StubVerification::new(&[(address, verified(3))])),
    );
    let cursor = store.cursor().unwrap().unwrap();

    let inner = Arc::new(Mutex::new(node_inner_for(
        store,
        &tmp.path().join("state.redb"),
    )));
    inner
        .lock()
        .unwrap()
        .set_index_lifecycle(DerivedIndexLifecycle::Ready(cursor));

    // A registry path that cannot be opened leaves the service loaded with no
    // snapshot, so it rejects every publication and answers every lookup with
    // `None`. That second half is what makes the assertions below decisive: had
    // either rejection run the index refresh, it would have cleared the rows.
    let unavailable = Arc::new(pcash_pscan::registry::SourceVerificationService::open(
        tmp.path(),
        TEST_PCASH_CHAIN_ID,
        B256::ZERO,
        None,
    ));
    let handle =
        crate::node::NodeHandle::new(Arc::clone(&inner)).with_source_verification(unavailable);

    let malformed = handle.publish_source_verification(serde_json::json!({"nope": true}));
    assert!(
        matches!(malformed, Err(AdminApiError::SourceInvalid(_))),
        "{malformed:?}"
    );

    // Well-formed enough to deserialize, so this one is the registry's own
    // rejection rather than serde's.
    let rejected = handle.publish_source_verification(serde_json::json!({
        "version": 1,
        "manifest": {},
        "attachments": {},
    }));
    assert!(
        matches!(rejected, Err(AdminApiError::SourceUnavailable(_))),
        "{rejected:?}"
    );

    let guard = inner.lock().unwrap();
    assert_eq!(
        guard.index.contract_source_info(address).unwrap(),
        verified(3)
    );
    assert_eq!(
        guard.index.verified_contract_at(0, 0).unwrap(),
        Some(address)
    );
}

#[test]
fn verified_contract_page_excludes_contracts_above_the_requested_head() {
    let tmp = tempfile::tempdir().unwrap();
    let store = DerivedIndexStore::create(tmp.path().join("state.index.redb")).unwrap();
    let below = Address::repeat_byte(0x61);
    let above = Address::repeat_byte(0x71);
    let first = contract_fixture(0, B256::ZERO, 0x51, &[below]);
    store.bind_identity(7, first.boundary.block.hash).unwrap();
    apply_contract_fixture(
        &store,
        &first,
        Some(&StubVerification::new(&[(below, verified(3))])),
    );
    let second = contract_fixture(1, first.boundary.block.hash, 0x52, &[above]);
    apply_contract_fixture(
        &store,
        &second,
        Some(&StubVerification::new(&[(above, verified(4))])),
    );

    let at_head = store
        .verified_contract_page(0, None, 10)
        .unwrap()
        .into_iter()
        .map(|material| material.address)
        .collect::<Vec<_>>();
    assert_eq!(at_head, vec![below]);
    let past_head = store
        .verified_contract_page(1, None, 10)
        .unwrap()
        .into_iter()
        .map(|material| material.address)
        .collect::<Vec<_>>();
    assert_eq!(past_head, vec![above, below]);
}

#[test]
fn read_snapshot_keeps_one_index_boundary_during_apply_and_rewind() {
    let store = DerivedIndexStore::create_in_memory().unwrap();
    let first = fixture(0, B256::ZERO, 0x70);
    store.bind_identity(7, first.boundary.block.hash).unwrap();
    let first_cursor = apply_fixture(&store, &first);
    let before = store.read_snapshot().unwrap();
    let second = fixture(1, first.boundary.block.hash, 0x71);
    let second_cursor = std::thread::scope(|scope| {
        scope
            .spawn(|| apply_fixture(&store, &second))
            .join()
            .unwrap()
    });
    let after = store.read_snapshot().unwrap();
    assert_eq!(before.cursor().unwrap(), Some(first_cursor));
    assert_eq!(before.transaction_totals().unwrap(), (1, 0, 1));
    assert!(before
        .receipt_by_txid(&second.receipt.tx_id)
        .unwrap()
        .is_none());
    assert_eq!(after.cursor().unwrap(), Some(second_cursor));
    assert_eq!(after.transaction_totals().unwrap(), (2, 0, 2));
    store
        .rewind_to(IndexBlockId {
            number: 0,
            hash: first.boundary.block.hash,
        })
        .unwrap();
    assert_eq!(store.cursor().unwrap(), Some(first_cursor));
    assert_eq!(after.cursor().unwrap(), Some(second_cursor));
    assert_eq!(
        after.receipt_by_txid(&second.receipt.tx_id).unwrap(),
        Some(second.receipt.clone())
    );
    let account = second.receipt.account.as_ref().unwrap();
    assert!(after
        .receive_material(account.address, account.account_revision)
        .unwrap()
        .is_some());
    assert!(store
        .receive_material(account.address, account.account_revision)
        .unwrap()
        .is_none());
}

/// Append one poster payout at `output_index`, the block's last output.
fn add_payout(
    fixture: &mut Fixture,
    tree: &mut pcash_state::SparseTree,
    output_index: u64,
    component: pcash_state::PayoutComponent,
) {
    let payout = pcash_state::PayoutRecord {
        source: pcash_state::PayoutSource::PosterPayout {
            l1_transaction_indices: vec![0],
        },
        component,
        amount: U256::from(7),
        owner_commitment: pcash_state::fr_to_bytes(Fr::from(8u64)),
        output_index,
        contexts: vec![pcash_state::fr_to_bytes(Fr::from(9 + output_index))],
    };
    tree.set_leaf(output_index, payout.output_commitment());
    let mut components = fixture.boundary.state.state_components();
    components.output_count = output_index + 1;
    components.output_root = pcash_state::fr_to_bytes(tree.root());
    fixture.boundary.state = pcash_state::StateCommitment::new(components);
    fixture.boundary.history.payouts = vec![payout];
    fixture.boundary.state_outcome.outputs_added = 1;
    fixture.boundary.state_outcome.output_leaf_start = output_index;
    fixture.boundary.state_outcome.state_root =
        pcash_state::StateRoot(pcash_state::fr_to_bytes(fixture.boundary.state.root));
    fixture.boundary.block.header.state_root = fixture.boundary.state_outcome.state_root.0;
    fixture.boundary.block.hash = fixture.boundary.block.header.try_hash().unwrap();
}

#[test]
fn system_payout_outputs_page_and_rewind_with_the_canonical_output_count() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("payout.index.redb");
    let store = DerivedIndexStore::create(&path).unwrap();
    let genesis = fixture(0, B256::ZERO, 1);
    store
        .bind_identity(TEST_PCASH_CHAIN_ID, genesis.boundary.block.hash)
        .unwrap();
    apply_fixture(&store, &genesis);
    let mut tree = pcash_state::SparseTree::new(pcash_state::TREE_DEPTH);
    let mut first = fixture(1, genesis.boundary.block.hash, 2);
    add_payout(
        &mut first,
        &mut tree,
        0,
        pcash_state::PayoutComponent::OpenFee,
    );
    apply_fixture(&store, &first);
    let mut second = fixture(2, first.boundary.block.hash, 3);
    add_payout(
        &mut second,
        &mut tree,
        1,
        pcash_state::PayoutComponent::Issuance,
    );
    apply_fixture(&store, &second);
    drop(store);
    let store = DerivedIndexStore::open(&path).unwrap();
    let target = IndexBlockId {
        number: 2,
        hash: second.boundary.block.hash,
    };
    let limits = OutputLimits {
        max_outputs: 1,
        max_bytes: 10_000,
    };
    let first_page = store.output_page(0, target, None, limits).unwrap();
    assert_eq!(first_page.target.output_count, 2);
    assert_eq!(first_page.outputs[0].output_index, 0);
    assert!(
        matches!(&first_page.outputs[0].material, IndexedOutputMaterial::System { transaction_id, payout } if transaction_id.is_none() && payout == &first.boundary.history.payouts[0])
    );
    let last_page = store
        .output_page(0, target, first_page.continuation, limits)
        .unwrap();
    assert_eq!(last_page.outputs[0].output_index, 1);
    assert!(
        matches!(&last_page.outputs[0].material, IndexedOutputMaterial::System { transaction_id, payout } if transaction_id.is_none() && payout == &second.boundary.history.payouts[0])
    );
    assert!(last_page.complete);
    store
        .rewind_to(IndexBlockId {
            number: 0,
            hash: genesis.boundary.block.hash,
        })
        .unwrap();
    assert!(matches!(
        store.output_page(0, target, None, limits),
        Err(OutputError::Unavailable(_))
    ));
    drop(store);
    let store = DerivedIndexStore::open(&path).unwrap();
    let page = store
        .output_page(
            0,
            IndexBlockId {
                number: 0,
                hash: genesis.boundary.block.hash,
            },
            None,
            limits,
        )
        .unwrap();
    assert_eq!(page.target.output_count, 0);
    assert!(page.outputs.is_empty());
}
