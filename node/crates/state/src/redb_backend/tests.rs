#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]

use super::persist::*;
use super::*;

use crate::codec::{Codec, DecodeError};
use crate::field::{fr_from_canonical_bytes, fr_to_bytes, u256_to_fr, word_to_u256};
use crate::{
    l1_origin_leaf, AcceptedEffects, AccountResult, AccountState, Address, BlockInput, BlockUpdate,
    BoundaryRetention, DerivationSource, Fr, ReceiveKeyOperation, StateDb, StoredBlock,
    TransactionEffects, TransactionOutcome, TransactionResult, TREE_DEPTH, U256,
};
use redb::{
    Database, ReadableDatabase, ReadableTable, ReadableTableMetadata, TableDefinition, TableHandle,
};
use tempfile::TempDir;

fn source() -> DerivationSource {
    DerivationSource {
        pcash_chain_id: 1,
        l1_chain_id: 2,
        inbox_address: Address::repeat_byte(3),
        genesis_l1_block: 100,
        genesis_l1_block_hash: alloy_primitives::B256::repeat_byte(4),
    }
}

fn input(number: u64) -> BlockInput {
    BlockInput {
        transaction_effects: Vec::new(),
        l1_logs: Vec::new(),
        history: crate::CanonicalBlockHistory::default(),
        number,
        timestamp: 10 + number,
        transaction_results: Vec::new(),
        transaction_bytes: Vec::new(),
        l1_origin: crate::L1Origin {
            block_number: 100 + number,
            block_hash: if number == 0 {
                alloy_primitives::B256::repeat_byte(4)
            } else {
                alloy_primitives::B256::repeat_byte(number as u8)
            },
            block_timestamp: 10 + number,
            l1_logs_root: alloy_primitives::B256::ZERO,
            l1_log_count: 0,
        },
    }
}

#[test]
fn in_memory_backend_uses_the_canonical_redb_schema() {
    let mut state =
        RedbState::create_in_memory(source(), alloy_primitives::B256::repeat_byte(1)).unwrap();
    state
        .commit(input(0), BlockUpdate::empty(state.issuance_state()))
        .unwrap();
    assert_eq!(state.canonical_tip().unwrap().header.number, 0);
    preflight_read_schema(&state.db).unwrap();
}

#[test]
fn transaction_effects_round_trip_through_the_committed_read_snapshot() {
    let mut state =
        RedbState::create_in_memory(source(), alloy_primitives::B256::repeat_byte(1)).unwrap();
    let prior_state = AccountState {
        index: 4,
        revision: 7,
        nullifier_key_commitment: Fr::from(11u64),
        account_rule_set_commitment: Fr::from(12u64),
        kind: 0,
        receive_key_hash: fr_to_bytes(Fr::from(13u64)),
    };
    let effects = vec![TransactionEffects::Accepted(AcceptedEffects {
        kind: 3,
        output_leaf_start: None,
        output_commitments: Vec::new(),
        nullifiers: Vec::new(),
        account: Some(AccountResult::User {
            address: Address::repeat_byte(5),
            revision: 8,
            receive_key: ReceiveKeyOperation::Keep,
            prior_state: Some(Box::new(prior_state)),
        }),
        payout: None,
    })];
    let mut block = input(0);
    block.transaction_results.push(TransactionResult {
        tx_type: 3,
        account_creation: 0,
        l1_transaction_index: 0,
        batch_item_index: 0,
        outcome: TransactionOutcome::Succeeded,
        poster_owner_commitment: fr_to_bytes(Fr::from(14u64)),
        output_start_index: 0,
        statement_hash: fr_to_bytes(Fr::from(15u64)),
    });
    block.transaction_bytes.push(vec![3]);
    block.transaction_effects = effects.clone();
    state
        .commit(block, BlockUpdate::empty(state.issuance_state()))
        .unwrap();

    assert_eq!(
        state
            .reader()
            .snapshot()
            .unwrap()
            .canonical_transaction_effects(0),
        Ok(Some(effects))
    );
}

fn timed_input(number: u64, timestamp: u64) -> BlockInput {
    BlockInput {
        transaction_effects: Vec::new(),
        l1_logs: Vec::new(),
        timestamp,
        ..input(number)
    }
}

fn directory_entries(directory: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

#[test]
fn an_interrupted_creation_does_not_block_a_later_create() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("state.redb");
    let leftover = ".state.redb.create.1.0";
    std::fs::write(temporary.path().join(leftover), b"not a redb file").unwrap();
    let state = RedbState::create(&path, source(), alloy_primitives::B256::repeat_byte(1)).unwrap();
    let adopted = state.adopted_fork_compatibility();
    drop(state);
    assert_eq!(
        directory_entries(temporary.path()),
        [leftover, "state.redb"]
    );
    assert_eq!(RedbState::peek_checkpoint(&path).unwrap(), None);
    RedbState::open(&path, source(), adopted).unwrap();
}

/// A second creator that passed the existence check before the first
/// published fails at publication and leaves the published database alone.
#[test]
fn creation_refuses_a_destination_published_after_its_existence_check() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("state.redb");
    let mut first =
        RedbState::create_and_publish(&path, source(), alloy_primitives::B256::repeat_byte(1))
            .unwrap();
    assert!(
        RedbState::create_and_publish(&path, source(), alloy_primitives::B256::repeat_byte(2))
            .is_err()
    );
    first
        .commit(input(0), BlockUpdate::empty(first.issuance_state()))
        .unwrap();
    let adopted = first.adopted_fork_compatibility();
    drop(first);
    assert_eq!(directory_entries(temporary.path()), ["state.redb"]);
    let reopened = RedbState::open(&path, source(), adopted).unwrap();
    assert_eq!(reopened.canonical_tip().unwrap().header.number, 0);
}

#[test]
fn genesis_timestamp_is_cached_and_validated_on_reopen() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("genesis-timestamp.redb");
    let mut state =
        RedbState::create(&path, source(), alloy_primitives::B256::repeat_byte(1)).unwrap();
    assert_eq!(state.genesis_l1_timestamp(), None);
    state
        .commit(
            timed_input(0, 1_800_000_123),
            BlockUpdate::empty(state.issuance_state()),
        )
        .unwrap();
    let adopted = state.adopted_fork_compatibility();
    assert_eq!(state.genesis_l1_timestamp(), Some(1_800_000_123));
    drop(state);

    let state = RedbState::open(&path, source(), adopted).unwrap();
    assert_eq!(state.genesis_l1_timestamp(), Some(1_800_000_123));

    let write = state.db.begin_write().unwrap();
    {
        let mut blocks = write.open_table(T_BLOCKS).unwrap();
        blocks
            .insert(0u64.to_be_bytes().as_slice(), b"{".as_slice())
            .unwrap();
    }
    write.commit().unwrap();

    assert_eq!(state.genesis_l1_timestamp(), Some(1_800_000_123));
    assert!(state.canonical_block(0).is_err());
    drop(state);
    assert!(RedbState::open(&path, source(), adopted).is_err());
}

#[test]
fn failed_genesis_persist_rolls_back_cached_timestamp() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("genesis-rollback.redb");
    let mut state =
        RedbState::create(&path, source(), alloy_primitives::B256::repeat_byte(1)).unwrap();
    state.fail_next_persist();
    assert!(state
        .commit(
            timed_input(0, 1_800_000_123),
            BlockUpdate::empty(state.issuance_state())
        )
        .is_err());
    assert_eq!(state.genesis_l1_timestamp(), None);
    assert!(state.inner.canonical_genesis_hash.is_none());
    assert!(state.canonical_tip().is_none());
    assert_eq!(state.canonical_block(0), Ok(None));

    state
        .commit(
            timed_input(0, 1_800_000_456),
            BlockUpdate::empty(state.issuance_state()),
        )
        .unwrap();
    assert_eq!(state.genesis_l1_timestamp(), Some(1_800_000_456));
}

#[test]
fn corrupt_append_node_is_a_read_error_not_absence() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("append-read-error.redb");
    let mut state =
        RedbState::create(&path, source(), alloy_primitives::B256::repeat_byte(1)).unwrap();
    state
        .commit(input(0), BlockUpdate::empty(state.issuance_state()))
        .unwrap();
    state
        .commit(input(1), BlockUpdate::empty(state.issuance_state()))
        .unwrap();

    let write = state.db.begin_write().unwrap();
    {
        let mut trees = write.open_table(T_TREES).unwrap();
        let key = tree_node_key(2, 0, 1);
        trees.remove(key.as_slice()).unwrap();
    }
    write.commit().unwrap();

    assert!(matches!(
        state.l1_origin_path_at(1, 0),
        Err(StateError::Backend(message))
            if message.contains("persisted append-only tree node is missing")
    ));
}

fn table_len(db: &Database, definition: TableDefinition<&[u8], &[u8]>) -> u64 {
    let read = db.begin_read().unwrap();
    read.open_table(definition).unwrap().len().unwrap()
}

fn application_table_snapshot(db: &Database) -> Vec<(u8, Vec<u8>, Vec<u8>)> {
    let read = db.begin_read().unwrap();
    let mut snapshot = Vec::new();
    macro_rules! snapshot_table {
        ($id:expr, $definition:expr) => {{
            let table = read.open_table($definition).unwrap();
            for row in table.iter().unwrap() {
                let (key, value) = row.unwrap();
                snapshot.push(($id, key.value().to_vec(), value.value().to_vec()));
            }
        }};
    }
    snapshot_table!(0, T_META);
    snapshot_table!(1, T_TREES);
    snapshot_table!(2, T_TRANSACTION_RESULTS);
    snapshot_table!(3, T_NULLIFIERS);
    snapshot_table!(4, T_ADDRESSES);
    snapshot_table!(5, T_BLOCKS);
    snapshot_table!(6, T_BLOCK_HISTORY);
    snapshot_table!(7, T_BLOCK_HASH_INDEX);
    snapshot_table!(8, T_SAVEPOINTS);
    snapshot_table!(9, T_BLOCK_BODIES);
    snapshot_table!(10, T_L1_DELIVERY_BATCHES);
    snapshot_table!(11, T_ACCOUNT_WRITES);
    snapshot
}

#[test]
fn compact_block_metadata_does_not_read_transaction_bodies() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("state.redb");
    let mut state =
        RedbState::create(&path, source(), alloy_primitives::B256::repeat_byte(1)).unwrap();
    let mut block_input = input(0);
    let transaction = vec![1, 2, 3, 4];
    let content_hash = crate::content_hash(&transaction);
    block_input.transaction_results = vec![TransactionResult {
        tx_type: 0,
        account_creation: 0,
        l1_transaction_index: 0,
        batch_item_index: 0,
        outcome: TransactionOutcome::ProofRejected,
        poster_owner_commitment: alloy_primitives::B256::repeat_byte(0x0a),
        output_start_index: 0,
        statement_hash: alloy_primitives::B256::ZERO,
    }];
    block_input.transaction_bytes = vec![transaction];
    let result = &block_input.transaction_results[0];
    block_input.history.l1_delivery_batches = vec![crate::L1DeliveryBatch {
        l1_transaction_index: result.l1_transaction_index,
        l1_transaction_hash: alloy_primitives::B256::repeat_byte(0x31),
        l1_sender: Address::ZERO,
        carrier_type: crate::CarrierType::Calldata,
        carrier_hash: content_hash,
        carrier_length: block_input.transaction_bytes[0].len() as u64,
        blob_versioned_hashes: Vec::new(),
        poster_owner_commitment: None,
        poster_context: None,
        exclusion_reason: None,
        first_batch_item_index: result.batch_item_index,
        items: vec![crate::L1DeliveryItem {
            batch_item_index: result.batch_item_index,
            content_hash,
            byte_offset: 0,
            byte_length: block_input.transaction_bytes[0].len() as u64,
            exclusion_reason: None,
        }],
    }];
    let (committed, _) = state
        .commit(block_input, BlockUpdate::empty(state.issuance_state()))
        .unwrap();
    assert_eq!(
        state.canonical_block_metadata(0).unwrap().unwrap().hash,
        committed.block.hash
    );
    let snapshot = state.reader().snapshot().unwrap();
    assert_eq!(
        snapshot.canonical_block(0).unwrap(),
        Some(committed.block.clone())
    );
    assert_eq!(
        snapshot.l1_delivery_batches(0).unwrap(),
        committed.history.l1_delivery_batches
    );
    assert_eq!(
        snapshot
            .transaction_delivery_batches(B256::repeat_byte(0x31))
            .unwrap(),
        Some((0, committed.history.l1_delivery_batches.clone()))
    );
    let write = state.db.begin_write().unwrap();
    {
        let mut bodies = write.open_table(T_BLOCK_BODIES).unwrap();
        bodies.remove([0u8; 16].as_slice()).unwrap();
    }
    write.commit().unwrap();
    assert_eq!(
        state.canonical_block_metadata(0).unwrap().unwrap().hash,
        committed.block.hash
    );
    assert!(state.block_economics(0).unwrap().is_some());
    assert!(state
        .reader()
        .snapshot()
        .unwrap()
        .transaction_delivery_batches(alloy_primitives::B256::repeat_byte(0x31))
        .unwrap()
        .is_some());
    assert_eq!(
        snapshot.canonical_block(0).unwrap(),
        Some(committed.block.clone())
    );
    assert_eq!(
        snapshot.canonical_transaction_body(0, 0).unwrap(),
        committed.block.transaction_bytes.first().cloned()
    );
}

#[test]
fn tip_root_and_count_reads_use_only_the_compact_block() {
    let mut state = RedbState::create_in_memory(source(), B256::repeat_byte(1)).unwrap();
    state
        .commit(input(0), BlockUpdate::empty(state.issuance_state()))
        .unwrap();
    let (committed, _) = state
        .commit(
            input(1),
            BlockUpdate {
                output_commitments: vec![Fr::from(7u64)],
                ..BlockUpdate::empty(state.issuance_state())
            },
        )
        .unwrap();
    let write = state.db.begin_write().unwrap();
    for definition in [T_TRANSACTION_RESULTS, T_BLOCK_BODIES, T_BLOCK_HISTORY] {
        let mut table = write.open_table(definition).unwrap();
        table.retain(|_, _| false).unwrap();
    }
    write.commit().unwrap();

    let stored = StoredBlock::from(&committed);
    let snapshot = state.reader().snapshot().unwrap();
    assert_eq!(snapshot.canonical_tip().unwrap(), Some(stored.clone()));
    assert_eq!(
        snapshot.state_root().unwrap(),
        committed.state_outcome.state_root
    );
    assert_eq!(
        snapshot.state_components().unwrap(),
        committed.state.state_components()
    );
    assert_eq!(snapshot.output_count().unwrap(), 1);
    assert_eq!(snapshot.canonical_stored_block(1).unwrap(), Some(stored));
    assert!(snapshot
        .block_header_path_at(committed.block.hash, 5)
        .unwrap()
        .is_some());
    assert!(snapshot
        .state_path_at(committed.block.hash, 4)
        .unwrap()
        .is_some());
    assert!(snapshot.canonical_block_metadata(1).is_err());
    assert!(snapshot.committed_boundary(1).is_err());

    state.reload(source()).unwrap();
    assert_eq!(state.canonical_tip(), Some(StoredBlock::from(&committed)));
    assert_eq!(state.state_root(), committed.state_outcome.state_root);
    assert_eq!(state.state_components(), committed.state.state_components());
}

#[test]
fn delivery_manifests_and_block_economics_are_canonical_history() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("state.redb");
    let mut state =
        RedbState::create(&path, source(), alloy_primitives::B256::repeat_byte(1)).unwrap();
    let transaction_hash = alloy_primitives::B256::repeat_byte(0x21);
    let manifest = crate::L1DeliveryBatch {
        l1_transaction_index: 3,
        l1_transaction_hash: transaction_hash,
        l1_sender: Address::repeat_byte(0x22),
        carrier_type: crate::CarrierType::Blob,
        carrier_hash: alloy_primitives::B256::repeat_byte(0x23),
        carrier_length: 4096,
        blob_versioned_hashes: vec![alloy_primitives::B256::repeat_byte(0x01)],
        poster_owner_commitment: None,
        poster_context: None,
        exclusion_reason: None,
        first_batch_item_index: 0,
        items: Vec::new(),
    };
    // The same transaction emits a carrier event; another transaction
    // carries only events.
    let event = |l1_transaction_index, l1_transaction_hash, log_index| crate::L1DeliveryBatch {
        l1_transaction_index,
        l1_transaction_hash,
        carrier_type: crate::CarrierType::Event {
            log_index,
            emitter: Address::repeat_byte(0x24),
            context: Some(vec![0x25; 3]),
        },
        blob_versioned_hashes: Vec::new(),
        ..manifest.clone()
    };
    let other_hash = alloy_primitives::B256::repeat_byte(0x26);
    let manifests = vec![
        manifest.clone(),
        event(3, transaction_hash, 2),
        event(4, other_hash, 0),
        event(4, other_hash, 1),
    ];
    let economics = crate::BlockEconomics {
        open_fees_total: U256::from(3),
        ..Default::default()
    };
    let mut block_input = input(0);
    block_input.history = crate::CanonicalBlockHistory {
        l1_delivery_batches: manifests.clone(),
        economics: economics.clone(),
        payouts: Vec::new(),
    };
    state
        .commit(
            block_input,
            BlockUpdate::empty(pcash_issuance::IssuanceState {
                issued_so_far: U256::from(27u64),
                lag_q: alloy_primitives::I256::ZERO,
            }),
        )
        .unwrap();
    let snapshot = state.reader().snapshot().unwrap();
    assert_eq!(
        snapshot
            .transaction_delivery_batches(transaction_hash)
            .unwrap(),
        Some((0, manifests[..2].to_vec()))
    );
    assert_eq!(
        snapshot.transaction_delivery_batches(other_hash).unwrap(),
        Some((0, manifests[2..].to_vec()))
    );
    assert_eq!(
        snapshot
            .transaction_delivery_batches(alloy_primitives::B256::repeat_byte(0x27))
            .unwrap(),
        None
    );
    assert_eq!(state.block_economics(0).unwrap(), Some(economics));
}

#[test]
fn incompatible_store_is_rejected() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("state.redb");
    let db = Database::create(&path).unwrap();
    let write = db.begin_write().unwrap();
    {
        let mut meta = write.open_table(T_META).unwrap();
        meta.insert(b"unexpected".as_slice(), b"not-the-state-schema".as_slice())
            .unwrap();
    }
    write.commit().unwrap();
    drop(db);
    assert!(RedbState::peek_checkpoint(&path).is_err());
    assert!(RedbState::open(
        &path,
        source(),
        AdoptedForkCompatibility::base(alloy_primitives::B256::repeat_byte(1)),
    )
    .is_err());
    let db = Database::open(&path).unwrap();
    let read = db.begin_read().unwrap();
    let names = read
        .list_tables()
        .unwrap()
        .map(|table| table.name().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(names, vec!["meta"]);
    let meta = read.open_table(T_META).unwrap();
    assert_eq!(meta.len().unwrap(), 1);
}

#[test]
fn exact_schema_rejects_extra_tables_and_missing_metadata_before_mutation() {
    let temporary = TempDir::new().unwrap();

    let extra_path = temporary.path().join("extra.redb");
    let state = RedbState::create(
        &extra_path,
        source(),
        alloy_primitives::B256::repeat_byte(1),
    )
    .unwrap();
    let adopted = state.adopted_fork_compatibility();
    drop(state);
    let db = Database::open(&extra_path).unwrap();
    let extra: TableDefinition<&[u8], &[u8]> = TableDefinition::new("unexpected");
    let write = db.begin_write().unwrap();
    write.open_table(extra).unwrap();
    write.commit().unwrap();
    let tables_before = db.begin_read().unwrap().list_tables().unwrap().count();
    drop(db);
    assert!(RedbState::open(&extra_path, source(), adopted).is_err());
    let db = Database::open(&extra_path).unwrap();
    assert_eq!(
        db.begin_read().unwrap().list_tables().unwrap().count(),
        tables_before
    );
    drop(db);

    let missing_path = temporary.path().join("missing.redb");
    let state = RedbState::create(
        &missing_path,
        source(),
        alloy_primitives::B256::repeat_byte(1),
    )
    .unwrap();
    let adopted = state.adopted_fork_compatibility();
    drop(state);
    let db = Database::open(&missing_path).unwrap();
    let write = db.begin_write().unwrap();
    {
        let mut meta = write.open_table(T_META).unwrap();
        meta.remove(b"source".as_slice()).unwrap();
    }
    write.commit().unwrap();
    let rows_before = application_table_snapshot(&db);
    drop(db);
    assert!(RedbState::open(&missing_path, source(), adopted).is_err());
    let db = Database::open(&missing_path).unwrap();
    assert_eq!(application_table_snapshot(&db), rows_before);
}

#[test]
fn store_rows_round_trip_and_reject_any_other_length() {
    #[track_caller]
    fn assert_exact<T: Codec + PartialEq + std::fmt::Debug>(value: &T) {
        let encoded = value.encode();
        assert_eq!(&T::decode(&encoded).unwrap(), value);
        assert_eq!(
            T::decode(&encoded[..encoded.len() - 1]),
            Err(DecodeError::Truncated)
        );
        assert_eq!(
            T::decode(&[encoded.as_slice(), &[0]].concat()),
            Err(DecodeError::Trailing)
        );
    }

    let mut inner = InnerState::new(source());
    let boundary = inner.apply(input(0), &BlockUpdate::empty(inner.issuance));
    assert_exact(&StoredBlock::from(&boundary));
    assert_exact(&StoredBlockHistory::from_committed(&boundary));

    let history = StoredBlockHistory {
        history: crate::CanonicalBlockHistory::default(),
        output_leaf_start: 0x0102,
        outputs_added: 3,
        inserted_nullifiers: vec![B256::repeat_byte(0x41)],
    };
    let expected = [
        crate::CanonicalBlockHistory::default().encode().as_slice(),
        &0x0102u64.to_be_bytes(),
        &3u64.to_be_bytes(),
        &1u64.to_be_bytes(),
        &[0x41; 32],
    ]
    .concat();
    assert_eq!(history.encode(), expected);
    assert_eq!(StoredBlockHistory::decode(&expected), Ok(history));

    let adopted = AdoptedForkCompatibility {
        adopted_fork_count: 2,
        adopted_prefix_hash: B256::repeat_byte(0x32),
    };
    let encoded = adopted.encode();
    assert_eq!(
        encoded.as_slice(),
        [&2u32.to_be_bytes()[..], &[0x32; 32]].concat()
    );
    assert_eq!(AdoptedForkCompatibility::decode(&encoded), Ok(adopted));
    assert!(AdoptedForkCompatibility::decode(&encoded[..encoded.len() - 1]).is_err());
    assert!(AdoptedForkCompatibility::decode(&[encoded.as_slice(), &[0]].concat()).is_err());
}

#[test]
fn open_reloads_empty_and_unfinalized_canonical_state() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("state.redb");
    let mut state =
        RedbState::create(&path, source(), alloy_primitives::B256::repeat_byte(1)).unwrap();
    state
        .advance_adopted_fork(1, alloy_primitives::B256::repeat_byte(2))
        .unwrap();
    let adopted = state.adopted_fork_compatibility();
    let empty_root = state.state_root();
    drop(state);

    let mut state = RedbState::open(&path, source(), adopted).unwrap();
    assert_eq!(state.state_root(), empty_root);
    assert_eq!(state.canonical_tip(), None);
    assert!(state.savepoints.is_empty());
    assert_eq!(state.adopted_fork_compatibility(), adopted);
    let (genesis, _) = state
        .commit(
            input(0),
            BlockUpdate {
                output_commitments: vec![Fr::from(7u64)],
                ..BlockUpdate::empty(state.issuance_state())
            },
        )
        .unwrap();
    let genesis_root = state.state_root();
    let adopted = state.adopted_fork_compatibility();
    assert!(state.savepoints.is_empty());
    drop(state);

    let mut state = RedbState::open(&path, source(), adopted).unwrap();
    assert_eq!(state.canonical_tip(), Some(StoredBlock::from(&genesis)));
    assert_eq!(state.state_root(), genesis_root);
    assert_eq!(state.committed_boundary(0), Ok(Some(genesis.clone())));
    assert!(state.savepoints.is_empty());
    let (second, _) = state
        .commit(input(1), BlockUpdate::empty(state.issuance_state()))
        .unwrap();
    let tip = state.canonical_tip().unwrap();
    let root = state.state_root();
    drop(state);

    assert_eq!(RedbState::peek_checkpoint(&path).unwrap(), None);
    let mut state = RedbState::open(&path, source(), adopted).unwrap();
    assert_eq!(state.canonical_tip(), Some(tip));
    assert_eq!(state.state_root(), root);
    assert_eq!(state.committed_boundary(0), Ok(Some(genesis)));
    assert_eq!(state.committed_boundary(1), Ok(Some(second)));
    assert_eq!(state.savepoints.len(), 1);
    assert!(state.savepoints.contains_key(&100));

    state.restore_to(100).unwrap();
    assert_eq!(state.canonical_tip().unwrap().header.number, 0);
    state
        .commit(
            input(1),
            BlockUpdate {
                output_commitments: vec![Fr::from(8u64)],
                ..BlockUpdate::empty(state.issuance_state())
            },
        )
        .unwrap();
    assert_eq!(state.canonical_tip().unwrap().header.number, 1);
}

#[test]
fn open_rejects_wrong_identity_checkpointed_and_incomplete_stores() {
    let temporary = TempDir::new().unwrap();

    let wrong_identity_path = temporary.path().join("wrong-identity.redb");
    let state = RedbState::create(
        &wrong_identity_path,
        source(),
        alloy_primitives::B256::repeat_byte(1),
    )
    .unwrap();
    let adopted = state.adopted_fork_compatibility();
    drop(state);
    let mut wrong_source = source();
    wrong_source.l1_chain_id += 1;
    assert!(matches!(
        RedbState::open(&wrong_identity_path, wrong_source, adopted),
        Err(StateError::Backend(message))
            if message.contains("does not match the configured source")
    ));
    let mut wrong_adopted = adopted;
    wrong_adopted.adopted_prefix_hash = alloy_primitives::B256::repeat_byte(2);
    assert!(matches!(
        RedbState::open(&wrong_identity_path, source(), wrong_adopted),
        Err(StateError::ForkDowngrade)
    ));

    let checkpointed_path = temporary.path().join("checkpointed.redb");
    let mut state = RedbState::create(
        &checkpointed_path,
        source(),
        alloy_primitives::B256::repeat_byte(1),
    )
    .unwrap();
    state
        .commit(input(0), BlockUpdate::empty(state.issuance_state()))
        .unwrap();
    let checkpointed_adopted = state.adopted_fork_compatibility();
    state
        .advance_finalized(
            100,
            alloy_primitives::B256::repeat_byte(4),
            alloy_primitives::B256::repeat_byte(3),
        )
        .unwrap();
    drop(state);
    assert!(matches!(
        RedbState::open(&checkpointed_path, source(), checkpointed_adopted),
        Err(StateError::Backend(message))
            if message.contains("without a finalized checkpoint")
    ));

    let incomplete_path = temporary.path().join("incomplete.redb");
    let mut state = RedbState::create(
        &incomplete_path,
        source(),
        alloy_primitives::B256::repeat_byte(1),
    )
    .unwrap();
    state
        .commit(input(0), BlockUpdate::empty(state.issuance_state()))
        .unwrap();
    let incomplete_adopted = state.adopted_fork_compatibility();
    state
        .commit(input(1), BlockUpdate::empty(state.issuance_state()))
        .unwrap();
    let savepoint_id = state.savepoints[&100];
    {
        let write = state.db.begin_write().unwrap();
        write.delete_persistent_savepoint(savepoint_id).unwrap();
        write.commit().unwrap();
    }
    drop(state);
    assert!(matches!(
        RedbState::open(&incomplete_path, source(), incomplete_adopted),
        Err(StateError::Backend(message))
            if message.contains("associations do not match persistent savepoints")
    ));
}

#[test]
fn open_requires_the_canonical_tip_row() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("non-prefix.redb");
    let mut state =
        RedbState::create(&path, source(), alloy_primitives::B256::repeat_byte(1)).unwrap();
    state
        .commit(input(0), BlockUpdate::empty(state.issuance_state()))
        .unwrap();
    state
        .commit(input(1), BlockUpdate::empty(state.issuance_state()))
        .unwrap();
    let adopted = state.adopted_fork_compatibility();
    drop(state);

    let db = Database::open(&path).unwrap();
    let write = db.begin_write().unwrap();
    for definition in [T_BLOCKS, T_TRANSACTION_RESULTS, T_BLOCK_HISTORY] {
        let mut table = write.open_table(definition).unwrap();
        let value = table
            .remove(1u64.to_be_bytes().as_slice())
            .unwrap()
            .unwrap()
            .value()
            .to_vec();
        table
            .insert(2u64.to_be_bytes().as_slice(), value.as_slice())
            .unwrap();
    }
    write.commit().unwrap();
    drop(db);

    assert!(matches!(
        RedbState::open(&path, source(), adopted),
        Err(StateError::Backend(message)) if message.contains("canonical block history has a gap")
    ));
}

#[test]
fn bounded_open_defers_ancient_state_rehashing_to_explicit_audit() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("audit.redb");
    let mut state =
        RedbState::create(&path, source(), alloy_primitives::B256::repeat_byte(1)).unwrap();
    for number in 0..=3 {
        state
            .commit(
                timed_input(number, 10 + number * 100_000),
                BlockUpdate::empty(state.issuance_state()),
            )
            .unwrap();
    }
    let adopted = state.adopted_fork_compatibility();
    assert!(state.inner.committed_boundaries.is_empty());
    drop(state);

    let db = Database::open(&path).unwrap();
    let write = db.begin_write().unwrap();
    {
        let mut blocks = write.open_table(T_BLOCKS).unwrap();
        let key = 0u64.to_be_bytes();
        let bytes = blocks
            .get(key.as_slice())
            .unwrap()
            .unwrap()
            .value()
            .to_vec();
        let mut block = StoredBlock::decode(&bytes).unwrap();
        block.state.output_root = fr_to_bytes(Fr::from(999u64));
        let bytes = block.encode();
        blocks.insert(key.as_slice(), bytes.as_slice()).unwrap();
    }
    write.commit().unwrap();
    drop(db);

    let state = RedbState::open(&path, source(), adopted).unwrap();
    assert!(state.audit_full_history().is_err());
}

#[test]
fn resume_rejects_wrong_valid_savepoint_without_mutating_canonical_state() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("state.redb");
    let mut state =
        RedbState::create(&path, source(), alloy_primitives::B256::repeat_byte(1)).unwrap();
    let (genesis, _) = state
        .commit(input(0), BlockUpdate::empty(state.issuance_state()))
        .unwrap();
    state
        .advance_finalized(
            100,
            alloy_primitives::B256::repeat_byte(4),
            alloy_primitives::B256::repeat_byte(3),
        )
        .unwrap();
    state
        .commit(
            input(1),
            BlockUpdate {
                output_commitments: vec![Fr::from(7u64)],
                ..BlockUpdate::empty(state.issuance_state())
            },
        )
        .unwrap();
    let (tip, _) = state
        .commit(input(2), BlockUpdate::empty(state.issuance_state()))
        .unwrap();
    let adopted = state.adopted_fork_compatibility();
    let correct_savepoint_id = state.savepoints[&100];
    let wrong_savepoint_id = state.savepoints[&101];
    assert_ne!(correct_savepoint_id, wrong_savepoint_id);

    let mut corrupted_checkpoint = {
        let read = state.db.begin_read().unwrap();
        let meta = read.open_table(T_META).unwrap();
        let bytes = meta
            .get(b"checkpoint".as_slice())
            .unwrap()
            .unwrap()
            .value()
            .to_vec();
        PersistedCheckpoint::decode(&bytes).unwrap()
    };
    corrupted_checkpoint.savepoint_id = wrong_savepoint_id;
    {
        let write = state.db.begin_write().unwrap();
        {
            let mut meta = write.open_table(T_META).unwrap();
            let bytes = corrupted_checkpoint.encode();
            meta.insert(b"checkpoint".as_slice(), bytes.as_slice())
                .unwrap();
        }
        write.commit().unwrap();
    }
    let database_before = application_table_snapshot(&state.db);
    drop(state);

    let error = match RedbState::resume(&path, source(), adopted) {
        Ok(_) => panic!("a checkpoint naming the wrong valid savepoint must be rejected"),
        Err(error) => error,
    };
    assert!(
        error
            .to_string()
            .contains("checkpoint block, result, history, and hash-index counts do not match"),
        "unexpected resume error: {error}"
    );
    let db = Database::open(&path).unwrap();
    assert_eq!(
        application_table_snapshot(&db),
        database_before,
        "rejected preflight must not change any canonical application row"
    );
    {
        let read = db.begin_read().unwrap();
        let blocks = read.open_table(T_BLOCKS).unwrap();
        let (_, value) = blocks.last().unwrap().unwrap();
        let persisted: StoredBlock = Codec::decode(value.value()).unwrap();
        assert_eq!(persisted.hash, tip.block.hash);
        assert_eq!(persisted.header.number, 2);
        let meta = read.open_table(T_META).unwrap();
        let stored: PersistedCheckpoint =
            Codec::decode(meta.get(b"checkpoint".as_slice()).unwrap().unwrap().value()).unwrap();
        assert_eq!(stored, corrupted_checkpoint);
    }
    {
        let write = db.begin_write().unwrap();
        {
            let mut meta = write.open_table(T_META).unwrap();
            corrupted_checkpoint.savepoint_id = correct_savepoint_id;
            let bytes = corrupted_checkpoint.encode();
            meta.insert(b"checkpoint".as_slice(), bytes.as_slice())
                .unwrap();
        }
        write.commit().unwrap();
    }
    drop(db);

    let resumed = RedbState::resume(&path, source(), adopted).unwrap();
    assert_eq!(resumed.canonical_tip(), Some(StoredBlock::from(&genesis)));
}

/// A genesis derived under another PCASH chain ID, stored under the configured
/// source: only genesis's parent hash disagrees with the source.
fn state_with_a_foreign_genesis_parent(path: &std::path::Path) -> RedbState {
    let foreign = DerivationSource {
        pcash_chain_id: source().pcash_chain_id + 1,
        ..source()
    };
    let mut state =
        RedbState::create(path, foreign, alloy_primitives::B256::repeat_byte(1)).unwrap();
    state
        .commit(input(0), BlockUpdate::empty(state.issuance_state()))
        .unwrap();
    let write = state.db.begin_write().unwrap();
    {
        let mut meta = write.open_table(T_META).unwrap();
        meta.insert(b"source".as_slice(), source().encode().as_slice())
            .unwrap();
    }
    write.commit().unwrap();
    state
}

#[test]
fn full_history_audit_rejects_a_genesis_parent_the_source_does_not_derive() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("state.redb");
    let state = state_with_a_foreign_genesis_parent(&path);
    let adopted = state.adopted_fork_compatibility();
    drop(state);

    let state = RedbState::open(&path, source(), adopted).unwrap();
    assert!(matches!(
        state.audit_full_history(),
        Err(StateError::Backend(message)) if message.contains("durable canonical history audit failed")
    ));
}

#[test]
fn resume_rejects_a_genesis_parent_the_source_does_not_derive() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("state.redb");
    let mut state = state_with_a_foreign_genesis_parent(&path);
    state
        .advance_finalized(
            100,
            alloy_primitives::B256::repeat_byte(4),
            alloy_primitives::B256::repeat_byte(3),
        )
        .unwrap();
    let adopted = state.adopted_fork_compatibility();
    drop(state);

    assert!(matches!(
        RedbState::resume(&path, source(), adopted),
        Err(StateError::Backend(message))
            if message.contains("checkpoint savepoint semantic identity does not match the checkpoint")
    ));
}

#[test]
fn adopted_marker_is_monotonic_and_survives_restore() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("state.redb");
    let mut state =
        RedbState::create(&path, source(), alloy_primitives::B256::repeat_byte(1)).unwrap();
    state
        .commit(input(0), BlockUpdate::empty(state.issuance_state()))
        .unwrap();
    state
        .commit(input(1), BlockUpdate::empty(state.issuance_state()))
        .unwrap();
    state
        .advance_adopted_fork(1, alloy_primitives::B256::repeat_byte(2))
        .unwrap();
    state.restore_to(100).unwrap();
    assert_eq!(state.adopted_fork_compatibility().adopted_fork_count, 1);
    assert_eq!(
        state.advance_adopted_fork(0, alloy_primitives::B256::repeat_byte(1)),
        Err(StateError::ForkDowngrade)
    );
    drop(state);
    let (stored_source, restored) = RedbState::peek_adopted(path).unwrap().unwrap();
    assert_eq!(stored_source, source());
    assert_eq!(restored.adopted_fork_count, 1);
}

#[test]
fn adopted_marker_can_be_recovered_from_an_incompatible_state_schema() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("old-state.redb");
    let marker = AdoptedForkCompatibility::base(alloy_primitives::B256::repeat_byte(9));
    let db = Database::create(&path).unwrap();
    let write = db.begin_write().unwrap();
    {
        let mut meta = write.open_table(T_META).unwrap();
        meta.insert(b"adopted".as_slice(), marker.encode().as_slice())
            .unwrap();
    }
    write.commit().unwrap();
    // The marker's network is the source stored beside it.
    assert!(RedbState::peek_adopted(&path).is_err());
    let write = db.begin_write().unwrap();
    {
        let mut meta = write.open_table(T_META).unwrap();
        meta.insert(b"source".as_slice(), source().encode().as_slice())
            .unwrap();
    }
    write.commit().unwrap();
    drop(db);

    assert_eq!(
        RedbState::peek_adopted(&path).unwrap(),
        Some((source(), marker))
    );
    assert!(RedbState::peek_checkpoint(&path).is_err());
}

#[test]
fn block_records_are_permanent_across_prune_reorg_and_reload() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("state.redb");
    let mut state =
        RedbState::create(&path, source(), alloy_primitives::B256::repeat_byte(1)).unwrap();
    for number in 0..=12 {
        state
            .commit(
                timed_input(number, 10 + number * 50_000),
                BlockUpdate::empty(state.issuance_state()),
            )
            .unwrap();
        if number >= 2 {
            let finalized_number = number - 2;
            let finalized = state.block(finalized_number).unwrap().unwrap();
            state
                .advance_finalized(
                    finalized.l1_origin.block_number,
                    finalized.l1_origin.block_hash,
                    alloy_primitives::B256::repeat_byte(finalized_number as u8),
                )
                .unwrap();
            state.prune(finalized.l1_origin.block_number).unwrap();
        }
    }

    for definition in [
        T_BLOCKS,
        T_TRANSACTION_RESULTS,
        T_BLOCK_HISTORY,
        T_BLOCK_HASH_INDEX,
    ] {
        assert_eq!(table_len(&state.db, definition), 13);
    }
    assert!(state.inner.committed_boundaries.is_empty());
    assert!(state.inner.l1_origin_tree.to_entries().len() <= TREE_DEPTH + 1);
    assert!(state.inner.history_tree.to_entries().len() <= TREE_DEPTH + 1);
    state.audit_full_history().unwrap();
    assert_eq!(
        state
            .blocks(8, 20, 3)
            .unwrap()
            .into_iter()
            .map(|block| block.header.number)
            .collect::<Vec<_>>(),
        vec![8, 9, 10]
    );
    assert_eq!(
        state.boundary_retention(),
        Some(BoundaryRetention {
            oldest_contiguous: 0,
            tip: 12,
        })
    );
    assert!(state.block(8).unwrap().is_some());
    let historical = state.committed_boundary(8).unwrap().unwrap();
    assert_eq!(
        state.committed_boundary_by_block_hash(historical.block.hash),
        Ok(Some(historical))
    );
    assert_eq!(
        state.committed_boundary_by_block_hash(alloy_primitives::B256::repeat_byte(0xff)),
        Ok(None)
    );
    assert!(state.l1_origin_path_at(8, 0).unwrap().is_some());
    assert!(state.l1_origin_path_at(9, 0).unwrap().is_some());
    let current = state.committed_boundary(12).unwrap().unwrap();
    let current_path = state.l1_origin_path_at(12, 0).unwrap().unwrap();
    assert_eq!(
        pcash_crypto::merkle::root_from_index(
            l1_origin_leaf(&state.committed_boundary(0).unwrap().unwrap().l1_origin),
            0,
            &current_path,
        ),
        fr_from_canonical_bytes(current.block.header.l1_origin_root).unwrap()
    );

    state.restore_to(111).unwrap();
    assert_eq!(state.canonical_tip().unwrap().header.number, 11);
    assert!(state.block(12).unwrap().is_none());
    assert_eq!(table_len(&state.db, T_TRANSACTION_RESULTS), 12);
    assert_eq!(table_len(&state.db, T_BLOCK_HISTORY), 12);
    let mut replacement = timed_input(12, 610_000);
    let replacement_transaction = vec![0x99];
    let content_hash = crate::content_hash(&replacement_transaction);
    replacement.transaction_results.push(TransactionResult {
        tx_type: 0,
        account_creation: 0,
        l1_transaction_index: 0,
        batch_item_index: 0,
        outcome: TransactionOutcome::Succeeded,
        poster_owner_commitment: alloy_primitives::B256::repeat_byte(0x0a),
        output_start_index: 0,
        statement_hash: alloy_primitives::B256::ZERO,
    });
    replacement.transaction_bytes.push(replacement_transaction);
    let result = &replacement.transaction_results[0];
    replacement.history.l1_delivery_batches = vec![crate::L1DeliveryBatch {
        l1_transaction_index: result.l1_transaction_index,
        l1_transaction_hash: alloy_primitives::B256::repeat_byte(0x51),
        l1_sender: Address::ZERO,
        carrier_type: crate::CarrierType::Calldata,
        carrier_hash: content_hash,
        carrier_length: 1,
        blob_versioned_hashes: Vec::new(),
        poster_owner_commitment: None,
        poster_context: None,
        exclusion_reason: None,
        first_batch_item_index: 0,
        items: vec![crate::L1DeliveryItem {
            batch_item_index: 0,
            content_hash,
            byte_offset: 0,
            byte_length: 1,
            exclusion_reason: None,
        }],
    }];
    let (replacement, _) = state
        .commit(replacement, BlockUpdate::empty(state.issuance_state()))
        .unwrap();
    assert_eq!(replacement.block.header.number, 12);
    for definition in [
        T_BLOCKS,
        T_TRANSACTION_RESULTS,
        T_BLOCK_HISTORY,
        T_BLOCK_HASH_INDEX,
    ] {
        assert_eq!(table_len(&state.db, definition), 13);
    }

    let adopted = state.adopted_fork_compatibility();
    drop(state);
    let resumed = RedbState::resume(&path, source(), adopted).unwrap();
    assert_eq!(resumed.canonical_tip().unwrap().header.number, 10);
    for definition in [T_BLOCKS, T_TRANSACTION_RESULTS, T_BLOCK_HISTORY] {
        assert_eq!(table_len(&resumed.db, definition), 11);
    }
    assert_eq!(
        resumed.boundary_retention(),
        Some(BoundaryRetention {
            oldest_contiguous: 0,
            tip: 10,
        })
    );
    assert!(resumed.block(8).unwrap().is_some());
    assert!(resumed.committed_boundary(8).unwrap().is_some());
    assert!(resumed.l1_origin_path_at(10, 0).unwrap().is_some());
}

#[test]
fn atomic_commit_failure_leaves_no_boundary_or_savepoint() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("state.redb");
    let mut state =
        RedbState::create(&path, source(), alloy_primitives::B256::repeat_byte(1)).unwrap();
    state
        .commit(input(0), BlockUpdate::empty(state.issuance_state()))
        .unwrap();
    let adopted = state.adopted_fork_compatibility();
    let before = state.state_root();
    let tables_before = application_table_snapshot(&state.db);
    let savepoints_before = persistent_savepoint_ids(&state.db).unwrap();
    state.fail_next_atomic_commit();
    let update = BlockUpdate {
        output_commitments: vec![Fr::from(9u64)],
        account_ops: vec![crate::AccountOp {
            address: Address::repeat_byte(0x61),
            nullifier_key_commitment: Fr::from(62u64),
            account_rule_set_commitment: Fr::from(63u64),
            kind: 0,
            receive_key_hash: alloy_primitives::B256::ZERO,
            published_receive_key: None,
        }],
        nullifiers: vec![fr_to_bytes(Fr::from(10u64))],
        ..BlockUpdate::empty(state.issuance_state())
    };
    assert!(state.commit(input(1), update.clone()).is_err());
    assert_eq!(state.state_root(), before);
    assert_eq!(application_table_snapshot(&state.db), tables_before);
    assert_eq!(
        persistent_savepoint_ids(&state.db).unwrap(),
        savepoints_before
    );
    assert!(state.savepoints.is_empty());
    drop(state);

    let mut state = RedbState::open(&path, source(), adopted).unwrap();
    assert_eq!(state.state_root(), before);
    let (committed, _) = state.commit(input(1), update).unwrap();
    assert_eq!(committed.block.header.number, 1);
}

#[test]
fn nullifier_working_set_is_bounded_and_matches_the_complete_tree() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("state.redb");
    let mut redb =
        RedbState::create(&path, source(), alloy_primitives::B256::repeat_byte(1)).unwrap();
    let mut memory = crate::MemState::new(source());
    let nullifier = |value: u64| fr_to_bytes(Fr::from(value));
    // Later blocks insert below, between, and above stored values, so the
    // sentinel and stored predecessors are rewritten.
    let blocks: [&[u64]; 5] = [&[], &[2, 3, 1 << 40], &[6, 10], &[], &[7, u64::MAX, 1]];
    let commit = |state: &mut dyn StateDb, number: u64, values: &[u64]| {
        state.commit(
            input(number),
            BlockUpdate {
                nullifiers: values.iter().copied().map(nullifier).collect(),
                ..BlockUpdate::empty(state.issuance_state())
            },
        )
    };
    // Between blocks only the root is held, and the table holds one row per
    // spent nullifier.
    let assert_matches = |redb: &RedbState, memory: &crate::MemState, spent: u64| {
        assert_eq!(redb.state_root(), memory.state_root());
        assert_eq!(redb.inner.nullifier_tree.held_rows(), (0, 1));
        assert_eq!(table_len(&redb.db, T_NULLIFIERS), spent);
        for value in [1, 2, 3, 4, 6, 7, 10, 11, 12, 1 << 40, u64::MAX] {
            let key = nullifier(value);
            assert_eq!(redb.nullifier_seen(key), memory.nullifier_seen(key));
            assert_eq!(redb.nullifier_proof(key), memory.nullifier_proof(key));
            assert!(redb
                .nullifier_proof(key)
                .unwrap()
                .verify(redb.state_components().nullifier_root));
        }
    };

    let mut spent = 0;
    for (number, values) in blocks.iter().enumerate().take(3) {
        commit(&mut redb, number as u64, values).unwrap();
        commit(&mut memory, number as u64, values).unwrap();
        spent += values.len() as u64;
        assert_matches(&redb, &memory, spent);
    }

    let adopted = redb.adopted_fork_compatibility();
    drop(redb);
    let mut redb = RedbState::open(&path, source(), adopted).unwrap();
    assert_matches(&redb, &memory, spent);
    for (number, values) in blocks.iter().enumerate().skip(3) {
        commit(&mut redb, number as u64, values).unwrap();
        commit(&mut memory, number as u64, values).unwrap();
        assert_matches(&redb, &memory, spent + values.len() as u64);
    }

    // A reorg reloads only the root, and the replacement suffix reads the
    // restored rows.
    redb.restore_to(103).unwrap();
    memory.restore_to(103).unwrap();
    assert_matches(&redb, &memory, spent);
    commit(&mut redb, 4, &[7, 12]).unwrap();
    commit(&mut memory, 4, &[7, 12]).unwrap();
    assert_matches(&redb, &memory, spent + 2);
}

#[test]
fn output_tree_is_held_as_its_frontier_and_matches_the_complete_tree() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("state.redb");
    let mut redb =
        RedbState::create(&path, source(), alloy_primitives::B256::repeat_byte(1)).unwrap();
    let mut memory = crate::MemState::new(source());
    // Block sizes cross several power-of-two boundaries, with one empty block.
    let sizes = [3u64, 0, 5, 8, 1, 6];
    let mut first = 0;
    let blocks: Vec<Vec<Fr>> = sizes
        .iter()
        .map(|&size| {
            let leaves = (first..first + size).map(|i| Fr::from(1000 + i)).collect();
            first += size;
            leaves
        })
        .collect();
    let commit = |state: &mut dyn StateDb, number: u64, leaves: &[Fr]| {
        state.commit(
            input(number),
            BlockUpdate {
                output_commitments: leaves.to_vec(),
                ..BlockUpdate::empty(state.issuance_state())
            },
        )
    };
    // Between blocks the writer holds at most one node per level and the root,
    // and every historical path is read from the store.
    let assert_matches = |redb: &RedbState, memory: &crate::MemState, outputs: u64| {
        assert_eq!(redb.state_root(), memory.state_root());
        assert_eq!(redb.inner.output_count, outputs);
        assert!(redb.inner.output_tree.held_nodes() <= TREE_DEPTH + 1);
        for index in 0..outputs {
            assert_eq!(
                redb.path(crate::TreeId::Output, index).unwrap(),
                memory.path(crate::TreeId::Output, index).unwrap()
            );
        }
    };

    let mut outputs = 0;
    for (number, leaves) in blocks.iter().enumerate().take(4) {
        commit(&mut redb, number as u64, leaves).unwrap();
        commit(&mut memory, number as u64, leaves).unwrap();
        outputs += leaves.len() as u64;
        assert_matches(&redb, &memory, outputs);
    }

    // A restart loads only the frontier, and later appends build on it.
    let adopted = redb.adopted_fork_compatibility();
    drop(redb);
    let mut redb = RedbState::open(&path, source(), adopted).unwrap();
    assert_matches(&redb, &memory, outputs);
    let before_suffix = outputs;
    for (number, leaves) in blocks.iter().enumerate().skip(4) {
        commit(&mut redb, number as u64, leaves).unwrap();
        commit(&mut memory, number as u64, leaves).unwrap();
        outputs += leaves.len() as u64;
        assert_matches(&redb, &memory, outputs);
    }

    // A reorg reloads the frontier of the restored tip, and the replacement
    // block appends from it.
    redb.restore_to(103).unwrap();
    memory.restore_to(103).unwrap();
    assert_matches(&redb, &memory, before_suffix);
    let replacement = [Fr::from(5000), Fr::from(5001)];
    commit(&mut redb, 4, &replacement).unwrap();
    commit(&mut memory, 4, &replacement).unwrap();
    assert_matches(&redb, &memory, before_suffix + 2);
}

/// Values spread over the field, in blocks large enough that one block's
/// insertions share predecessors and paths.
#[test]
fn nullifier_blocks_of_scattered_keys_match_the_complete_tree() {
    let temporary = TempDir::new().unwrap();
    let mut redb = RedbState::create(
        temporary.path().join("state.redb"),
        source(),
        alloy_primitives::B256::repeat_byte(1),
    )
    .unwrap();
    let mut memory = crate::MemState::new(source());
    let nullifiers: Vec<_> = (0u8..200)
        .map(|index| {
            fr_to_bytes(u256_to_fr(word_to_u256(alloy_primitives::keccak256([
                index,
            ]))))
        })
        .collect();
    let spent = &nullifiers[..160];
    for (number, block) in spent.chunks(32).enumerate() {
        let update = BlockUpdate {
            nullifiers: block.to_vec(),
            ..BlockUpdate::empty(redb.issuance_state())
        };
        redb.commit(input(number as u64), update.clone()).unwrap();
        memory.commit(input(number as u64), update).unwrap();
        assert_eq!(redb.state_root(), memory.state_root());
    }
    assert_eq!(table_len(&redb.db, T_NULLIFIERS), spent.len() as u64);
    for &nullifier in &nullifiers {
        let proof = redb.nullifier_proof(nullifier).unwrap();
        assert_eq!(proof.spent(), spent.contains(&nullifier));
        assert_eq!(proof, memory.nullifier_proof(nullifier).unwrap());
        assert!(proof.verify(redb.state_components().nullifier_root));
    }
}

#[test]
fn persist_failure_restores_every_component() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("state.redb");
    let mut state =
        RedbState::create(&path, source(), alloy_primitives::B256::repeat_byte(1)).unwrap();
    state
        .commit(input(0), BlockUpdate::empty(state.issuance_state()))
        .unwrap();
    let adopted = state.adopted_fork_compatibility();
    let before = state.state_root();
    let tables_before = application_table_snapshot(&state.db);
    let savepoints_before = persistent_savepoint_ids(&state.db).unwrap();
    state.fail_next_persist();
    let update = BlockUpdate {
        output_commitments: vec![Fr::from(9u64)],
        nullifiers: vec![fr_to_bytes(Fr::from(10u64))],
        ..BlockUpdate::empty(state.issuance_state())
    };
    assert!(state.commit(input(1), update.clone()).is_err());
    assert_eq!(state.state_root(), before);
    assert_eq!(application_table_snapshot(&state.db), tables_before);
    assert_eq!(
        persistent_savepoint_ids(&state.db).unwrap(),
        savepoints_before
    );
    assert!(state.savepoints.is_empty());
    drop(state);

    let mut state = RedbState::open(&path, source(), adopted).unwrap();
    assert_eq!(state.state_root(), before);
    let (committed, _) = state.commit(input(1), update).unwrap();
    assert_eq!(committed.block.header.number, 1);
}

#[test]
fn account_point_reads_and_hydration_do_not_load_metadata() {
    let mut state = RedbState::create_in_memory(source(), B256::repeat_byte(1)).unwrap();
    let address = Address::repeat_byte(42);
    let operation = crate::AccountOp {
        address,
        nullifier_key_commitment: Fr::from(31u64),
        account_rule_set_commitment: Fr::from(32u64),
        kind: 0,
        receive_key_hash: alloy_primitives::B256::ZERO,
        published_receive_key: None,
    };
    let update = BlockUpdate {
        account_ops: vec![operation],
        ..BlockUpdate::empty(state.issuance_state())
    };
    state.commit(input(0), update.clone()).unwrap();
    let account = state.account_of(address).unwrap().unwrap();
    let write = state.db.begin_write().unwrap();
    {
        let mut meta = write.open_table(T_META).unwrap();
        meta.insert(b"source".as_slice(), b"{".as_slice()).unwrap();
    }
    write.commit().unwrap();

    assert!(state.reader().snapshot().is_err());
    assert_eq!(state.account_of(address).unwrap(), Some(account));
    assert_eq!(state.account_of(Address::repeat_byte(43)).unwrap(), None);
    state.hydrate_account_update(&update).unwrap();
    assert_eq!(state.inner.accounts.get(&address), Some(&account));
    state
        .hydrate_account_update(&BlockUpdate::empty(state.issuance_state()))
        .unwrap();
    assert!(state.inner.accounts.is_empty());

    let write = state.db.begin_write().unwrap();
    {
        let mut accounts = write.open_table(T_ADDRESSES).unwrap();
        accounts
            .insert(address.as_slice(), b"{".as_slice())
            .unwrap();
    }
    write.commit().unwrap();
    assert!(state.account_state(address).is_err());
    assert!(state.hydrate_account_update(&update).is_err());
}

#[test]
fn database_read_snapshot_matches_writer_state_and_witnesses() {
    let mut state = RedbState::create_in_memory(source(), B256::repeat_byte(1)).unwrap();
    let reader = state.reader();
    let empty = reader.snapshot().unwrap();
    assert_eq!(empty.state_root().unwrap(), state.state_root());
    assert_eq!(empty.state_components().unwrap(), state.state_components());
    assert_eq!(empty.canonical_tip().unwrap(), None);
    let address = Address::repeat_byte(42);
    let nullifier = fr_to_bytes(Fr::from(91u64));
    let mut genesis_input = input(0);
    genesis_input.history.economics.open_fees_total = U256::from(27u64);
    state
        .commit(
            genesis_input,
            BlockUpdate {
                output_commitments: vec![Fr::from(11u64), Fr::from(12u64)],
                issuance: pcash_issuance::IssuanceState {
                    issued_so_far: U256::from(27u64),
                    lag_q: alloy_primitives::I256::ZERO,
                },
                account_ops: vec![crate::AccountOp {
                    address,
                    nullifier_key_commitment: Fr::from(31u64),
                    account_rule_set_commitment: Fr::from(32u64),
                    kind: 0,
                    receive_key_hash: alloy_primitives::B256::ZERO,
                    published_receive_key: None,
                }],
                nullifiers: vec![nullifier],
            },
        )
        .unwrap();
    state
        .commit(input(1), BlockUpdate::empty(state.issuance_state()))
        .unwrap();
    let snapshot = reader.snapshot().unwrap();
    assert_eq!(snapshot.state_root().unwrap(), state.state_root());
    assert_eq!(
        snapshot.state_components().unwrap(),
        state.state_components()
    );
    assert_eq!(
        snapshot.derivation_source().unwrap(),
        state.derivation_source()
    );
    assert_eq!(snapshot.canonical_tip().unwrap(), state.canonical_tip());
    assert_eq!(
        snapshot.canonical_tip_summary().unwrap(),
        state.canonical_tip_summary()
    );
    assert_eq!(
        snapshot.boundary_retention().unwrap(),
        state.boundary_retention()
    );
    assert_eq!(
        snapshot.genesis_l1_timestamp().unwrap(),
        state.genesis_l1_timestamp()
    );
    assert_eq!(
        snapshot.last_l1_timestamp().unwrap(),
        state.last_l1_timestamp()
    );
    assert_eq!(
        snapshot.account_of(address).unwrap(),
        state.account_of(address).unwrap()
    );
    for tree in [crate::TreeId::Output, crate::TreeId::Account] {
        for index in 0..3 {
            assert_eq!(
                snapshot.path(tree, index).unwrap(),
                state.path(tree, index).unwrap()
            );
        }
    }
    for key in [nullifier, fr_to_bytes(Fr::from(92u64))] {
        assert_eq!(
            snapshot.nullifier_seen(key).unwrap(),
            state.nullifier_seen(key).unwrap()
        );
        assert_eq!(
            snapshot.nullifier_proof(key).unwrap(),
            state.nullifier_proof(key).unwrap()
        );
        assert!(snapshot
            .nullifier_proof(key)
            .unwrap()
            .verify(snapshot.state_components().unwrap().nullifier_root));
    }
    assert_eq!(snapshot.l1_origin_root().unwrap(), state.l1_origin_root());
    assert_eq!(snapshot.output_root().unwrap(), state.output_root());
    assert_eq!(
        snapshot.account_state_root().unwrap(),
        state.account_state_root()
    );
    assert_eq!(snapshot.output_count().unwrap(), state.output_count());
    assert_eq!(snapshot.account_count().unwrap(), state.account_count());
    for number in 0..=1 {
        let block = state.canonical_block(number).unwrap().unwrap();
        assert_eq!(
            snapshot.canonical_block(number).unwrap(),
            Some(block.clone())
        );
        assert_eq!(
            snapshot.canonical_stored_block(number).unwrap(),
            state.canonical_stored_block(number).unwrap()
        );
        assert_eq!(
            snapshot.canonical_stored_block_by_hash(block.hash).unwrap(),
            state.canonical_stored_block_by_hash(block.hash).unwrap()
        );
        assert_eq!(
            snapshot.committed_boundary(number).unwrap(),
            state.committed_boundary(number).unwrap()
        );
        assert_eq!(
            snapshot
                .committed_boundary_by_block_hash(block.hash)
                .unwrap(),
            state.committed_boundary_by_block_hash(block.hash).unwrap()
        );
        assert_eq!(
            snapshot.l1_origin_path_at(number, 0).unwrap(),
            state.l1_origin_path_at(number, 0).unwrap()
        );
        assert_eq!(
            snapshot.history_block_path_at(number, 0).unwrap(),
            state.history_block_path_at(number, 0).unwrap()
        );
        assert_eq!(
            snapshot.block_header_path_at(block.hash, 0).unwrap(),
            state.block_header_path_at(block.hash, 0).unwrap()
        );
        assert_eq!(
            snapshot.state_path_at(block.hash, 0).unwrap(),
            state.state_path_at(block.hash, 0).unwrap()
        );
        assert_eq!(
            snapshot.l1_delivery_batches(number).unwrap(),
            state.l1_delivery_batches(number).unwrap()
        );
        assert_eq!(
            snapshot.block_economics(number).unwrap(),
            state.block_economics(number).unwrap()
        );
    }
    assert_eq!(empty.output_count().unwrap(), 0);
    assert_eq!(
        empty.state_components().unwrap().issuance.issued_so_far,
        U256::ZERO
    );
    state
        .advance_finalized(100, input(0).l1_origin.block_hash, B256::repeat_byte(1))
        .unwrap();
    assert!(snapshot.checkpoint().is_none());
    assert_eq!(
        reader
            .snapshot()
            .unwrap()
            .checkpoint()
            .unwrap()
            .finalized_l1_block,
        100
    );
}

#[test]
fn database_read_snapshot_remains_coherent_across_concurrent_commit_and_reorg() {
    use std::sync::mpsc;
    use std::time::Duration;
    fn send_sync<T: Send + Sync>() {}
    send_sync::<RedbStateReader>();
    send_sync::<RedbReadSnapshot>();
    let mut state = RedbState::create_in_memory(source(), B256::repeat_byte(1)).unwrap();
    state
        .commit(
            input(0),
            BlockUpdate {
                output_commitments: vec![Fr::from(3u64)],
                ..BlockUpdate::empty(state.issuance_state())
            },
        )
        .unwrap();
    let reader = state.reader();
    let old = reader.snapshot().unwrap();
    let old_root = old.state_root().unwrap();
    let old_path = old.path(crate::TreeId::Output, 0).unwrap();
    let (writing, started) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let writer = std::thread::spawn(move || {
        let write = state.db.begin_write().unwrap();
        writing.send(()).unwrap();
        released.recv_timeout(Duration::from_secs(5)).unwrap();
        write.abort().unwrap();
        state
            .commit(
                input(1),
                BlockUpdate {
                    output_commitments: vec![Fr::from(4u64)],
                    ..BlockUpdate::empty(state.issuance_state())
                },
            )
            .unwrap();
        state
    });
    started.recv_timeout(Duration::from_secs(5)).unwrap();
    let during_write = reader.snapshot().unwrap();
    assert_eq!(during_write.state_root().unwrap(), old_root);
    assert_eq!(
        during_write.path(crate::TreeId::Output, 0).unwrap(),
        old_path
    );
    release.send(()).unwrap();
    let mut state = writer.join().unwrap();
    let before_reorg = reader.snapshot().unwrap();
    let orphan = before_reorg.canonical_tip().unwrap().unwrap();
    assert_eq!(before_reorg.output_count().unwrap(), 2);
    assert_eq!(old.output_count().unwrap(), 1);
    assert_eq!(old.state_root().unwrap(), old_root);
    assert_eq!(old.path(crate::TreeId::Output, 0).unwrap(), old_path);
    assert_eq!(old.canonical_block(1).unwrap(), None);
    state.restore_to(source().genesis_l1_block).unwrap();
    state
        .commit(
            timed_input(1, 20),
            BlockUpdate {
                output_commitments: vec![Fr::from(5u64)],
                ..BlockUpdate::empty(state.issuance_state())
            },
        )
        .unwrap();
    let replacement = reader.snapshot().unwrap();
    assert_ne!(
        replacement.canonical_tip().unwrap().unwrap().hash,
        orphan.hash
    );
    assert_eq!(
        replacement
            .canonical_block_metadata_by_hash(orphan.hash)
            .unwrap(),
        None
    );
    assert_eq!(before_reorg.canonical_tip().unwrap(), Some(orphan));
    assert_eq!(old.path(crate::TreeId::Output, 0).unwrap(), old_path);
}

#[test]
fn catch_up_persist_skips_savepoints_until_checkpoint() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("state.redb");
    let mut state =
        RedbState::create(&path, source(), alloy_primitives::B256::repeat_byte(1)).unwrap();
    state.set_persist_reorg_savepoint(false);
    state
        .commit(input(0), BlockUpdate::empty(state.issuance_state()))
        .unwrap();
    let (second, _) = state
        .commit(input(1), BlockUpdate::empty(state.issuance_state()))
        .unwrap();
    assert!(state.savepoints.is_empty());
    assert_eq!(state.latest_savepoint_at_or_below(101), None);
    state
        .advance_finalized(
            second.l1_origin.block_number,
            second.l1_origin.block_hash,
            alloy_primitives::B256::repeat_byte(1),
        )
        .unwrap();
    assert_eq!(state.latest_savepoint_at_or_below(101), Some(101));
    assert_eq!(state.latest_savepoint_at_or_below(100), None);
    let adopted = state.adopted_fork_compatibility();
    drop(state);

    let resumed = RedbState::resume(&path, source(), adopted).unwrap();
    assert_eq!(resumed.canonical_tip().unwrap().header.number, 1);
    assert_eq!(resumed.latest_savepoint_at_or_below(101), Some(101));
}

/// Fold an append frontier with the empty ladder from the next append
/// position up to the root, as a client checks it.
fn fold_frontier(frontier: &crate::OutputFrontier) -> Fr {
    let mut ommers = frontier
        .ommers
        .iter()
        .map(|ommer| fr_from_canonical_bytes(*ommer).unwrap());
    let mut node = pcash_crypto::merkle::empty(0);
    for height in 0..TREE_DEPTH {
        node = if (frontier.output_count >> height) & 1 == 1 {
            pcash_crypto::poseidon(&[ommers.next().unwrap(), node])
        } else {
            pcash_crypto::poseidon(&[node, pcash_crypto::merkle::empty(height)])
        };
    }
    assert!(ommers.next().is_none());
    node
}

#[test]
fn output_frontier_is_block_exact_and_extends_to_the_next_block() {
    let mut state = RedbState::create_in_memory(source(), B256::repeat_byte(1)).unwrap();
    let leaf = |index: u64| Fr::from(1_000 + index);
    let mut independent = crate::SparseTree::new(TREE_DEPTH);
    let mut expected = Vec::new();
    let mut count = 0u64;
    // Counts after each block: 0, 1, 3, 3, 7, 31, 62, 63, 127, 127, 254.
    for (number, added) in [0u64, 1, 2, 0, 4, 24, 31, 1, 64, 0, 127]
        .into_iter()
        .enumerate()
    {
        let leaves = (count..count + added).map(leaf).collect::<Vec<_>>();
        for index in count..count + added {
            independent.set_leaf(index, leaf(index));
        }
        count += added;
        state
            .commit(
                input(number as u64),
                BlockUpdate {
                    output_commitments: leaves,
                    ..BlockUpdate::empty(state.issuance_state())
                },
            )
            .unwrap();
        expected.push(crate::OutputFrontier {
            output_count: count,
            output_root: fr_to_bytes(independent.root()),
            ommers: (0..=TREE_DEPTH as u8)
                .filter(|&height| (count >> height) & 1 == 1)
                .map(|height| fr_to_bytes(independent.node_value(height, (count >> height) - 1)))
                .collect(),
        });
    }

    let snapshot = state.reader().snapshot().unwrap();
    for (number, expected_frontier) in expected.iter().enumerate() {
        let frontier = snapshot.output_frontier(number as u64).unwrap().unwrap();
        assert_eq!(&frontier, expected_frontier, "block {number}");
        assert_eq!(
            fold_frontier(&frontier),
            fr_from_canonical_bytes(frontier.output_root).unwrap(),
            "block {number}"
        );

        // The ommers are exactly the append-only frontier coordinates, and
        // appending the next block's leaves to them alone yields its root.
        let mut rows = (0..TREE_DEPTH as u8)
            .filter(|&height| (frontier.output_count >> height) & 1 == 1)
            .map(|height| (height, (frontier.output_count >> height) - 1))
            .zip(&frontier.ommers)
            .map(|((height, index), ommer)| (height, index, ommer.0))
            .collect::<Vec<_>>();
        rows.push((TREE_DEPTH as u8, 0, frontier.output_root.0));
        let mut appended = crate::SparseTree::from_entries(TREE_DEPTH, &rows);
        if let Some(next) = expected.get(number + 1) {
            for index in frontier.output_count..next.output_count {
                appended.set_leaf(index, leaf(index));
            }
            assert_eq!(
                fr_to_bytes(appended.root()),
                next.output_root,
                "block {number}"
            );
        }
    }
    assert_eq!(expected[0].output_count, 0);
    assert!(expected[0].ommers.is_empty());
    assert_eq!(expected[10].ommers.len(), 7);
    assert_eq!(
        snapshot.output_frontier(expected.len() as u64).unwrap(),
        None
    );
}

#[test]
fn historical_output_paths_clip_later_appends_and_hold_the_read_snapshot() {
    let mut state = RedbState::create_in_memory(source(), B256::repeat_byte(1)).unwrap();
    let mut first = BlockUpdate::empty(state.issuance_state());
    first.output_commitments = vec![Fr::from(11u64), Fr::from(12u64), Fr::from(13u64)];
    let (boundary, _) = state.commit(input(0), first).unwrap();
    let snapshot = state.reader().snapshot().unwrap();
    let mut second = BlockUpdate::empty(state.issuance_state());
    second.output_commitments = vec![Fr::from(14u64), Fr::from(15u64)];
    state.commit(input(1), second).unwrap();
    let fresh = state.reader().snapshot().unwrap();
    for index in 0..3 {
        let old = snapshot.output_path_at(0, index).unwrap().unwrap();
        let now = fresh.output_path_at(0, index).unwrap().unwrap();
        assert_eq!(old, now);
        assert_eq!(
            fr_to_bytes(pcash_crypto::merkle::root_from_index(
                Fr::from(11 + index),
                index,
                &now
            )),
            boundary.state.state_components().output_root
        );
    }
    assert!(snapshot.output_path_at(1, 0).unwrap().is_none());
    assert!(fresh.output_path_at(0, 3).unwrap().is_none());
    assert!(fresh.output_path_at(1, 4).unwrap().is_some());
}
