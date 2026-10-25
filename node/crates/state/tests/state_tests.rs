#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]
use alloy_primitives::{Address, B256, U256};
use pcash_crypto::{merkle, Fr};
use pcash_state::{
    account_state_commitment, content_hash, fr_to_bytes, receive_key_hash,
    state_root_from_components, AccountOp, AdoptedForkCompatibility, BlockInput, BlockUpdate,
    DerivationSource, L1Origin, MemState, RedbState, StateDb, TransactionOutcome,
    TransactionResult, TreeId, ML_KEM768_PUBLIC_KEY_LEN, RECENT_PCASH_BLOCK_WINDOW_SECONDS,
};
use tempfile::TempDir;

fn source(anchor_hash: B256) -> DerivationSource {
    DerivationSource {
        pcash_chain_id: 0x5043_5348,
        l1_chain_id: 11_155_111,
        inbox_address: Address::repeat_byte(0x33),
        genesis_l1_block: 1_000,
        genesis_l1_block_hash: anchor_hash,
    }
}

fn input(source: DerivationSource, number: u64, timestamp: u64) -> BlockInput {
    let l1_block_number = source.genesis_l1_block + number;
    let l1_block_hash = if number == 0 {
        source.genesis_l1_block_hash
    } else {
        B256::repeat_byte(number as u8)
    };
    let transaction = vec![number as u8, timestamp as u8];
    let result = TransactionResult {
        tx_type: 0,
        funding_mode: 0,
        l1_transaction_index: 0,
        batch_item_index: 0,
        outcome: TransactionOutcome::Succeeded,
        poster_owner_commitment: B256::repeat_byte(0x0a),
        output_start_index: 0,
        statement_hash: B256::ZERO,
    };
    let history = pcash_state::CanonicalBlockHistory {
        l1_delivery_batches: vec![pcash_state::L1DeliveryBatch {
            l1_transaction_index: 0,
            l1_transaction_hash: B256::repeat_byte(0x80 | number as u8),
            l1_sender: Address::ZERO,
            carrier_type: pcash_state::CarrierType::Calldata,
            carrier_hash: content_hash(&transaction),
            carrier_length: transaction.len() as u64,
            blob_versioned_hashes: Vec::new(),
            poster_owner_commitment: None,
            poster_context: None,
            exclusion_reason: None,
            first_batch_item_index: 0,
            items: vec![pcash_state::L1DeliveryItem {
                batch_item_index: 0,
                content_hash: content_hash(&transaction),
                byte_offset: 0,
                byte_length: transaction.len() as u64,
                exclusion_reason: None,
            }],
        }],
        economics: pcash_state::BlockEconomics::default(),
        payouts: Vec::new(),
    };
    BlockInput {
        transaction_effects: Vec::new(),
        l1_logs: Vec::new(),
        history,
        number,
        timestamp,
        transaction_results: vec![result],
        transaction_bytes: vec![transaction],
        l1_origin: L1Origin {
            block_number: l1_block_number,
            block_hash: l1_block_hash,
            block_timestamp: timestamp,
            l1_logs_root: B256::ZERO,
            l1_log_count: 0,
        },
    }
}

fn account(address: Address, key: Option<&[u8]>) -> AccountOp {
    AccountOp {
        address,
        nullifier_key_commitment: Fr::from(7u64),
        account_rule_set_commitment: Fr::from(8u64),
        kind: 0,
        receive_key_hash: key.map_or(B256::ZERO, receive_key_hash),
        published_receive_key: key.map(<[u8]>::to_vec),
    }
}

fn mixed_update(address: Address, key: &[u8], sequence: u64) -> BlockUpdate {
    BlockUpdate {
        output_commitments: vec![Fr::from(100 + sequence), Fr::from(200 + sequence)],
        issuance: pcash_issuance::IssuanceState {
            issued_so_far: U256::from(1_000u64),
            lag_q: alloy_primitives::I256::ZERO,
        },
        account_ops: vec![account(address, Some(key))],
        nullifiers: vec![fr_to_bytes(Fr::from(300 + sequence))],
    }
}

fn input_with_economics(
    source: DerivationSource,
    number: u64,
    timestamp: u64,
    update: &BlockUpdate,
) -> BlockInput {
    let mut block_input = input(source, number, timestamp);
    block_input.history.economics.issuance_total = update.issuance.issued_so_far;
    block_input
}

#[test]
fn final_state_root_is_the_typed_nine_leaf_commitment() {
    let source = source(B256::repeat_byte(0x11));
    let mut state = MemState::new(source);
    let key = vec![0x5a; ML_KEM768_PUBLIC_KEY_LEN];
    let update = mixed_update(Address::repeat_byte(9), &key, 1);
    state
        .commit(input_with_economics(source, 0, 10, &update), update)
        .unwrap();
    let components = state.state_components();
    assert_eq!(state.state_root(), state_root_from_components(components));
    assert_eq!(
        state.state_root().to_hex(),
        "0x24f35dd49ad4e863354030213a32414f57c0b0b5791531756211d39bd27309d4"
    );
    assert_eq!(components.output_root, fr_to_bytes(state.output_root()));
    assert_eq!(components.issuance, state.issuance_state());
    assert_eq!(
        components.account_state_root,
        fr_to_bytes(state.account_state_root())
    );
    assert!(state
        .nullifier_proof(fr_to_bytes(Fr::from(301u64)))
        .unwrap()
        .verify(components.nullifier_root));
    assert_eq!(components.account_count, 1);
    assert_eq!(components.nullifier_count, 1);
}

#[test]
fn unified_account_state_commitment_commits_receive_key_and_every_update_advances_revision() {
    let source = source(B256::repeat_byte(0x11));
    let mut state = MemState::new(source);
    let address = Address::repeat_byte(9);
    let key = vec![0xa5; ML_KEM768_PUBLIC_KEY_LEN];
    state
        .commit(
            input(source, 0, 10),
            BlockUpdate {
                account_ops: vec![account(address, Some(&key))],
                ..BlockUpdate::empty(state.issuance_state())
            },
        )
        .unwrap();
    let first = state.account_of(address).unwrap().unwrap();
    assert_eq!(first.index, 0);
    assert_eq!(first.revision, 1);
    assert_eq!(first.receive_key_hash, receive_key_hash(&key));
    assert_eq!(
        merkle::root_from_index(
            account_state_commitment(
                address,
                first.nullifier_key_commitment,
                first.account_rule_set_commitment,
                first.kind,
                first.revision,
                first.receive_key_hash,
            ),
            first.index,
            &state.path(TreeId::Account, first.index).unwrap(),
        ),
        state.account_state_root()
    );

    state
        .commit(
            input(source, 1, 11),
            BlockUpdate {
                account_ops: vec![account(address, None)],
                ..BlockUpdate::empty(state.issuance_state())
            },
        )
        .unwrap();
    let cleared = state.account_of(address).unwrap().unwrap();
    assert_eq!(cleared.index, 0);
    assert_eq!(cleared.revision, 2);
    assert_eq!(cleared.receive_key_hash, B256::ZERO);
    assert_eq!(state.account_count(), 1);
}

#[test]
fn sequential_same_block_account_updates_are_one_last_write_wins_leaf() {
    let source = source(B256::repeat_byte(0x11));
    let mut state = MemState::new(source);
    let address = Address::repeat_byte(9);
    let first_key = vec![0xa5; ML_KEM768_PUBLIC_KEY_LEN];
    let replacement_key = vec![0x5a; ML_KEM768_PUBLIC_KEY_LEN];
    state
        .commit(
            input(source, 0, 10),
            BlockUpdate {
                account_ops: vec![
                    account(address, Some(&first_key)),
                    account(address, None),
                    account(address, Some(&replacement_key)),
                ],
                ..BlockUpdate::empty(state.issuance_state())
            },
        )
        .unwrap();

    let account = state.account_of(address).unwrap().unwrap();
    assert_eq!(account.index, 0);
    assert_eq!(account.revision, 3);
    assert_eq!(account.receive_key_hash, receive_key_hash(&replacement_key));
    assert_eq!(state.account_count(), 1);
    assert_eq!(
        merkle::root_from_index(
            account_state_commitment(
                address,
                account.nullifier_key_commitment,
                account.account_rule_set_commitment,
                account.kind,
                account.revision,
                account.receive_key_hash,
            ),
            account.index,
            &state.path(TreeId::Account, account.index).unwrap(),
        ),
        state.account_state_root()
    );
}

#[test]
fn raw_receive_material_is_not_returned_by_state() {
    let source = source(B256::repeat_byte(0x11));
    let mut state = MemState::new(source);
    let address = Address::repeat_byte(7);
    let vectors: serde_json::Value =
        serde_json::from_str(include_str!("../../../../vectors/protocol_vectors.json")).unwrap();
    let vector = &vectors["accountStateCommitment"];
    let key = hex::decode(
        vector["receiveKey"]
            .as_str()
            .unwrap()
            .strip_prefix("0x")
            .unwrap(),
    )
    .unwrap();
    assert_eq!(key.len(), ML_KEM768_PUBLIC_KEY_LEN);
    state
        .commit(
            input(source, 0, 10),
            BlockUpdate {
                account_ops: vec![account(address, Some(&key))],
                ..BlockUpdate::empty(state.issuance_state())
            },
        )
        .unwrap();
    let view = state.account_of(address).unwrap().unwrap();
    assert_eq!(
        view.receive_key_hash,
        vector["receiveKeyHash"]
            .as_str()
            .unwrap()
            .parse::<B256>()
            .unwrap()
    );
}

#[test]
fn nullifier_set_authenticates_membership_and_absence() {
    let source = source(B256::repeat_byte(0x11));
    let mut state = MemState::new(source);
    let spent = fr_to_bytes(Fr::from(55u64));
    state
        .commit(
            input(source, 0, 10),
            BlockUpdate {
                nullifiers: vec![spent],
                ..BlockUpdate::empty(state.issuance_state())
            },
        )
        .unwrap();
    assert!(state.nullifier_seen(spent).unwrap());
    let nullifier_root = state.state_components().nullifier_root;
    assert!(state.nullifier_proof(spent).unwrap().verify(nullifier_root));
    let unspent = fr_to_bytes(Fr::from(56u64));
    let proof = state.nullifier_proof(unspent).unwrap();
    assert!(!proof.spent());
    assert!(proof.verify(nullifier_root));
}

#[test]
fn genesis_parent_hash_binds_source_while_state_remains_intrinsic() {
    let first_source = source(B256::repeat_byte(0x11));
    let mut second_source = first_source;
    second_source.pcash_chain_id += 1;
    let mut first = MemState::new(first_source);
    let mut second = MemState::new(second_source);
    let key = vec![0x5a; ML_KEM768_PUBLIC_KEY_LEN];
    let update = mixed_update(Address::repeat_byte(9), &key, 1);
    let (a, _) = first
        .commit(
            input_with_economics(first_source, 0, 10, &update),
            update.clone(),
        )
        .unwrap();
    let (b, _) = second
        .commit(input_with_economics(second_source, 0, 10, &update), update)
        .unwrap();
    assert_eq!(a.state_outcome.state_root, b.state_outcome.state_root);
    assert_eq!(a.state.root, b.state.root);
    assert_ne!(a.block.hash, b.block.hash);
    assert_eq!(
        a.block.header.parent_hash,
        fr_to_bytes(first_source.genesis_parent_hash())
    );
    assert_eq!(
        b.block.header.parent_hash,
        fr_to_bytes(second_source.genesis_parent_hash())
    );
    assert_eq!(
        hex::encode(a.block.hash),
        "0a1058494e9722afd6dfa0a41d396e2b6576d46650997d1560c6292a73b79df0"
    );
}

#[test]
fn later_headers_link_and_authenticate_prior_pcash_blocks() {
    let source = source(B256::repeat_byte(0x11));
    let mut state = MemState::new(source);
    let (genesis, _) = state
        .commit(
            input(source, 0, 10),
            BlockUpdate::empty(state.issuance_state()),
        )
        .unwrap();
    let (second, _) = state
        .commit(
            input(source, 1, 11),
            BlockUpdate::empty(state.issuance_state()),
        )
        .unwrap();
    assert_eq!(second.block.header.parent_hash, genesis.block.hash);
    let path = state.history_block_path_at(1, 0).unwrap().unwrap();
    assert_eq!(
        merkle::root_from_index(pcash_state::history_leaf(genesis.block.hash), 0, &path),
        pcash_state::fr_from_canonical_bytes(second.block.header.history_root).unwrap()
    );
}

#[test]
fn transaction_results_root_changes_only_block_identity() {
    let source = source(B256::repeat_byte(0x11));
    let mut first = MemState::new(source);
    let mut second = MemState::new(source);
    let input_a = input(source, 0, 10);
    let mut input_b = input_a.clone();
    input_b.transaction_results.push(TransactionResult {
        tx_type: 0,
        funding_mode: 0,
        l1_transaction_index: 0,
        batch_item_index: 1,
        outcome: TransactionOutcome::ProofRejected,
        poster_owner_commitment: B256::repeat_byte(0x0a),
        output_start_index: 0,
        statement_hash: B256::ZERO,
    });
    input_b.transaction_bytes.push(vec![0xff]);
    input_b.history.l1_delivery_batches[0]
        .items
        .push(pcash_state::L1DeliveryItem {
            batch_item_index: 1,
            content_hash: content_hash(&[0xff]),
            byte_offset: 0,
            byte_length: 1,
            exclusion_reason: None,
        });
    let (a, _) = first
        .commit(input_a, BlockUpdate::empty(first.issuance_state()))
        .unwrap();
    let (b, _) = second
        .commit(input_b, BlockUpdate::empty(second.issuance_state()))
        .unwrap();
    assert_eq!(a.state_outcome.state_root, b.state_outcome.state_root);
    assert_eq!(a.state.root, b.state.root);
    assert_ne!(a.block.hash, b.block.hash);
}

#[test]
fn recent_block_hash_has_one_hour_lifetime() {
    let source = source(B256::repeat_byte(0x11));
    let mut state = MemState::new(source);
    let (boundary, _) = state
        .commit(
            input(source, 0, 100),
            BlockUpdate::empty(state.issuance_state()),
        )
        .unwrap();
    assert!(state.recent_pcash_block_hash_in_window(
        boundary.block.hash,
        100 + RECENT_PCASH_BLOCK_WINDOW_SECONDS
    ));
    assert!(!state.recent_pcash_block_hash_in_window(
        boundary.block.hash,
        101 + RECENT_PCASH_BLOCK_WINDOW_SECONDS
    ));
}

/// A reopened or restored `RedbState` rebuilds its recent-block window from
/// block records. It must accept exactly the hashes that a `MemState`, which
/// only pushes and rolls back, accepts.
#[test]
fn redb_recent_block_window_matches_memory_across_reopen_and_restore() {
    fn commit(memory: &mut MemState, redb: &mut RedbState, block: BlockInput) -> B256 {
        let (boundary, _) = memory
            .commit(block.clone(), BlockUpdate::empty(memory.issuance_state()))
            .unwrap();
        let (redb_boundary, _) = redb
            .commit(block, BlockUpdate::empty(redb.issuance_state()))
            .unwrap();
        assert_eq!(redb_boundary, boundary);
        boundary.block.hash
    }
    fn reopen(redb: RedbState, path: &std::path::Path, source: DerivationSource) -> RedbState {
        let adopted = redb.adopted_fork_compatibility();
        drop(redb);
        RedbState::open(path, source, adopted).unwrap()
    }
    /// Each hash's window membership at the tip's timestamp, which both
    /// states must agree on.
    fn verdicts(memory: &MemState, redb: &RedbState, hashes: &[B256]) -> Vec<bool> {
        let tip = StateDb::canonical_tip(memory).unwrap();
        assert_eq!(StateDb::canonical_tip(redb), Some(tip.clone()));
        hashes
            .iter()
            .map(|&hash| {
                let in_window =
                    memory.recent_pcash_block_hash_in_window(hash, tip.header.timestamp);
                assert_eq!(
                    redb.recent_pcash_block_hash_in_window(hash, tip.header.timestamp),
                    in_window
                );
                in_window
            })
            .collect()
    }

    let window = RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let source = source(B256::repeat_byte(0x11));
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("recent-window.redb");
    let mut memory = MemState::new(source);
    let mut redb = RedbState::create(&path, source, B256::repeat_byte(0x44)).unwrap();
    let mut hashes = Vec::new();

    // The tip is exactly one window after block 0, so block 0 sits on the cutoff.
    for (number, timestamp) in [(0, 100), (1, 100 + window / 2), (2, 100 + window)] {
        hashes.push(commit(
            &mut memory,
            &mut redb,
            input(source, number, timestamp),
        ));
    }
    redb = reopen(redb, &path, source);
    assert_eq!(verdicts(&memory, &redb, &hashes), [true, true, true]);

    // Block 3 is exactly one window before the tip and stays; block 2 is one
    // second older and is evicted.
    for (number, timestamp) in [(3, 101 + window), (4, 101 + 2 * window)] {
        hashes.push(commit(
            &mut memory,
            &mut redb,
            input(source, number, timestamp),
        ));
    }
    let expected = [false, false, false, true, true];
    assert_eq!(verdicts(&memory, &redb, &hashes), expected);
    redb = reopen(redb, &path, source);
    assert_eq!(verdicts(&memory, &redb, &hashes), expected);

    // Restoring to block 2 brings back blocks 0 through 2, which the pushes of
    // blocks 3 and 4 evicted, and drops the orphaned blocks 3 and 4.
    memory.restore_to(source.genesis_l1_block + 2).unwrap();
    redb.restore_to(source.genesis_l1_block + 2).unwrap();
    assert_eq!(
        verdicts(&memory, &redb, &hashes),
        [true, true, true, false, false]
    );

    // A replacement block 3 one second later than the orphaned one evicts block 0.
    hashes.push(commit(
        &mut memory,
        &mut redb,
        input(source, 3, 102 + window),
    ));
    let expected = [false, true, true, false, false, true];
    assert_eq!(verdicts(&memory, &redb, &hashes), expected);
    redb = reopen(redb, &path, source);
    assert_eq!(verdicts(&memory, &redb, &hashes), expected);
}

#[test]
fn historical_ethereum_header_and_state_openings_are_block_exact() {
    let source = source(B256::repeat_byte(0x11));
    let mut state = MemState::new(source);
    let (first, _) = state
        .commit(
            input(source, 0, 10),
            BlockUpdate::empty(state.issuance_state()),
        )
        .unwrap();
    let (second, _) = state
        .commit(
            input(source, 1, 11),
            BlockUpdate::empty(state.issuance_state()),
        )
        .unwrap();
    let first_path = state.l1_origin_path_at(0, 0).unwrap().unwrap();
    assert_eq!(
        merkle::root_from_index(
            pcash_state::l1_origin_leaf(&first.l1_origin),
            0,
            &first_path
        ),
        pcash_state::fr_from_canonical_bytes(first.block.header.l1_origin_root).unwrap()
    );
    let anchor_path_at_second = state.l1_origin_path_at(1, 0).unwrap().unwrap();
    assert_eq!(
        merkle::root_from_index(
            pcash_state::l1_origin_leaf(&first.l1_origin),
            0,
            &anchor_path_at_second
        ),
        pcash_state::fr_from_canonical_bytes(second.block.header.l1_origin_root).unwrap()
    );
    let found = state
        .committed_boundary_by_block_hash(first.block.hash)
        .unwrap()
        .unwrap();
    assert_eq!(found.block.hash, first.block.hash);
    let (state_root, _) = state
        .block_header_path_at(first.block.hash, pcash_state::BLOCK_HEADER_KEY_STATE_ROOT)
        .unwrap()
        .unwrap();
    assert_eq!(fr_to_bytes(state_root), first.block.header.state_root);
    let key = pcash_state::STATE_KEY_ACCOUNT_STATE_ROOT;
    let (account_state_root, _) = state.state_path_at(first.block.hash, key).unwrap().unwrap();
    assert_eq!(account_state_root, first.state.leaves[key as usize]);
}

#[test]
fn mem_rollback_and_retry_reproduce_identical_boundary() {
    let source = source(B256::repeat_byte(0x11));
    let mut state = MemState::new(source);
    state
        .commit(
            input(source, 0, 10),
            BlockUpdate::empty(state.issuance_state()),
        )
        .unwrap();
    let key = vec![0x5a; ML_KEM768_PUBLIC_KEY_LEN];
    let update = mixed_update(Address::repeat_byte(9), &key, 1);
    let (first, _) = state
        .commit(input_with_economics(source, 1, 11, &update), update.clone())
        .unwrap();
    state.restore_to(1_000).unwrap();
    let (second, _) = state
        .commit(input_with_economics(source, 1, 11, &update), update)
        .unwrap();
    assert_eq!(first, second);
}

#[test]
fn redb_and_mem_are_byte_identical() {
    let source = source(B256::repeat_byte(0x11));
    let temporary = TempDir::new().unwrap();
    let mut memory = MemState::new(source);
    let mut redb = RedbState::create(
        temporary.path().join("state.redb"),
        source,
        B256::repeat_byte(0x44),
    )
    .unwrap();
    let key = vec![0x5a; ML_KEM768_PUBLIC_KEY_LEN];
    for number in 0..4 {
        let update = mixed_update(Address::repeat_byte((number + 1) as u8), &key, number);
        let block_input = input_with_economics(source, number, 10 + number, &update);
        let (expected, _) = memory.commit(block_input.clone(), update.clone()).unwrap();
        let (actual, _) = redb.commit(block_input, update).unwrap();
        assert_eq!(actual, expected);
        assert_eq!(redb.state_root(), memory.state_root());
        for owner in 0..=number {
            let address = Address::repeat_byte((owner + 1) as u8);
            assert_eq!(redb.account_of(address), memory.account_of(address));
        }
    }
}

#[test]
fn checkpoint_resumes_repeatedly_with_complete_identity_and_prefix() {
    let source = source(B256::repeat_byte(0x11));
    let base_prefix = B256::repeat_byte(0x44);
    let activated_prefix = B256::repeat_byte(0x55);
    let checkpoint_prefix = B256::repeat_byte(0x66);
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("state.redb");
    let mut state = RedbState::create(&path, source, base_prefix).unwrap();
    let (genesis, _) = state
        .commit(
            input(source, 0, 10),
            BlockUpdate::empty(state.issuance_state()),
        )
        .unwrap();
    state
        .commit(
            input(source, 1, 11),
            BlockUpdate::empty(state.issuance_state()),
        )
        .unwrap();
    state.advance_adopted_fork(1, activated_prefix).unwrap();
    state
        .advance_finalized(
            source.genesis_l1_block,
            source.genesis_l1_block_hash,
            checkpoint_prefix,
        )
        .unwrap();
    let adopted = state.adopted_fork_compatibility();
    drop(state);

    let checkpoint = RedbState::peek_checkpoint(&path).unwrap().unwrap();
    assert_eq!(checkpoint.finalized_l1_block, source.genesis_l1_block);
    assert_eq!(checkpoint.pcash_block_number, 0);
    assert_eq!(checkpoint.pcash_block_hash, genesis.block.hash);
    assert_eq!(checkpoint.fork_schedule_prefix_hash, checkpoint_prefix);

    let resumed = RedbState::resume(&path, source, adopted).unwrap();
    assert_eq!(resumed.canonical_tip().unwrap().hash, genesis.block.hash);
    assert_eq!(resumed.adopted_fork_compatibility(), adopted);
    drop(resumed);
    let resumed_again = RedbState::resume(&path, source, adopted).unwrap();
    assert_eq!(
        resumed_again.canonical_tip().unwrap().hash,
        genesis.block.hash
    );
}

#[test]
fn resume_rejects_wrong_source_or_adopted_prefix_before_restore() {
    let source = source(B256::repeat_byte(0x11));
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("state.redb");
    let mut state = RedbState::create(&path, source, B256::repeat_byte(0x44)).unwrap();
    state
        .commit(
            input(source, 0, 10),
            BlockUpdate::empty(state.issuance_state()),
        )
        .unwrap();
    state
        .advance_finalized(
            source.genesis_l1_block,
            source.genesis_l1_block_hash,
            B256::repeat_byte(0x66),
        )
        .unwrap();
    let adopted = state.adopted_fork_compatibility();
    drop(state);

    let mut wrong_source = source;
    wrong_source.pcash_chain_id += 1;
    assert!(RedbState::resume(&path, wrong_source, adopted).is_err());
    let mut wrong_source = source;
    wrong_source.l1_chain_id += 1;
    assert!(RedbState::resume(&path, wrong_source, adopted).is_err());
    let mut wrong_source = source;
    wrong_source.inbox_address = Address::repeat_byte(0x99);
    assert!(RedbState::resume(&path, wrong_source, adopted).is_err());
    let mut wrong_source = source;
    wrong_source.genesis_l1_block += 1;
    assert!(RedbState::resume(&path, wrong_source, adopted).is_err());
    let mut wrong_source = source;
    wrong_source.genesis_l1_block_hash = B256::repeat_byte(0x99);
    assert!(RedbState::resume(&path, wrong_source, adopted).is_err());
    let wrong_adopted = AdoptedForkCompatibility {
        adopted_prefix_hash: B256::repeat_byte(0x77),
        ..adopted
    };
    assert!(RedbState::resume(&path, source, wrong_adopted).is_err());
}

#[test]
fn memory_and_redb_backends_stay_in_lockstep_through_a_mixed_sequence() {
    // mem and redb implement one StateDb contract; any divergence between
    // them is consensus divergence. Drive the same mixed sequence through
    // both backends and compare every observable after each step.
    let src = source(B256::repeat_byte(0x11));
    let address = Address::repeat_byte(0x46);
    let key = vec![0x7b; ML_KEM768_PUBLIC_KEY_LEN];

    let mut memory = MemState::new(src);
    let temporary = TempDir::new().unwrap();
    let mut redb = RedbState::create(
        temporary.path().join("state.redb"),
        src,
        B256::repeat_byte(0x44),
    )
    .unwrap();

    for number in 0u64..4 {
        let update = mixed_update(address, &key, number + 1);
        let block_input = input_with_economics(src, number, 10 + number, &update);
        let (m, _) = memory.commit(block_input.clone(), update.clone()).unwrap();
        let (r, _) = redb.commit(block_input, update).unwrap();
        assert_eq!(m.block.hash, r.block.hash, "block {number} hash");
        assert_eq!(
            m.state_outcome.state_root, r.state_outcome.state_root,
            "block {number} state root"
        );
        assert_eq!(memory.state_root(), redb.state_root());
        assert_eq!(memory.canonical_tip(), redb.canonical_tip());
        assert_eq!(memory.issuance_state(), redb.issuance_state());

        assert_eq!(memory.account_of(address), redb.account_of(address));
        let spent = fr_to_bytes(Fr::from(300 + number + 1));
        assert_eq!(memory.nullifier_seen(spent), redb.nullifier_seen(spent));
    }

    // Read-path parity: output-commitment-tree paths against the shared final root.
    for index in 0..memory.output_count().min(redb.output_count()) {
        assert_eq!(
            memory.path(TreeId::Output, index),
            redb.path(TreeId::Output, index),
            "output path {index}"
        );
    }

    // Reopened persistence must reproduce the in-memory picture exactly.
    let adopted = redb.adopted_fork_compatibility();
    drop(redb);
    let resumed = RedbState::open(temporary.path().join("state.redb"), src, adopted).unwrap();
    assert_eq!(memory.state_root(), resumed.state_root());
    assert_eq!(memory.canonical_tip(), resumed.canonical_tip());
    assert_eq!(memory.account_of(address), resumed.account_of(address));
    assert_eq!(memory.issuance_state(), resumed.issuance_state());
    for number in 0u64..4 {
        assert_eq!(
            memory
                .committed_boundary(number)
                .unwrap()
                .unwrap()
                .block
                .transaction_bytes,
            resumed
                .committed_boundary(number)
                .unwrap()
                .unwrap()
                .block
                .transaction_bytes,
            "canonical transaction bytes at block {number}"
        );
    }
}

#[test]
fn issuance_state_and_payout_notes_survive_snapshot_reorg_and_checkpoint() {
    use pcash_crypto::{domain_tags, poseidon};
    use pcash_state::{BlockEconomics, PayoutComponent, PayoutRecord, PayoutSource};

    let src = source(B256::repeat_byte(0x51));
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("issuance.redb");
    let prefix = B256::repeat_byte(0x52);
    let mut memory = MemState::new(src);
    let mut disk = RedbState::create(&path, src, prefix).unwrap();
    assert_eq!(
        StateDb::issuance_state(&disk),
        pcash_issuance::initial_state()
    );

    fn commit_pair(
        memory: &mut MemState,
        disk: &mut RedbState,
        input: BlockInput,
        update: BlockUpdate,
    ) {
        assert_eq!(
            memory.commit(input.clone(), update.clone()).unwrap(),
            disk.commit(input, update).unwrap()
        );
    }
    commit_pair(
        &mut memory,
        &mut disk,
        input(src, 0, 0),
        BlockUpdate::empty(pcash_issuance::initial_state()),
    );
    let parent = StateDb::issuance_state(&disk);
    let quote = pcash_issuance::quote(parent, 86_400);
    let settled = pcash_issuance::transition(parent, 86_400, 3);
    let owner = Fr::from(44u64);
    let mut block = input(src, 1, 86_400);
    block.history.economics = BlockEconomics {
        open_fees_total: U256::from(14),
        issuance_total: settled.new_issuance,
        qualifying_actions: 3,
        reward_each: settled.reward_each,
        baseline: quote.baseline,
        internal_offer: quote.internal_offer,
        block_allowance: quote.block_allowance,
    };
    let mut outputs = Vec::new();
    let designated = |batch_item_index| PayoutSource::DesignatedIssuance {
        l1_transaction_index: 0,
        batch_item_index,
    };
    let poster = PayoutSource::PosterPayout {
        l1_transaction_indices: vec![0],
    };
    for (index, (source, component, amount)) in [
        (
            designated(0),
            PayoutComponent::Issuance,
            settled.reward_each,
        ),
        (
            designated(1),
            PayoutComponent::Issuance,
            settled.reward_each,
        ),
        (poster.clone(), PayoutComponent::OpenFee, U256::from(14)),
        (poster, PayoutComponent::Issuance, settled.reward_each),
    ]
    .into_iter()
    .enumerate()
    {
        let body = poseidon(&[
            domain_tags::NOTE_BODY_COMMITMENT_DOMAIN,
            owner,
            Fr::from(0u64),
            pcash_state::u256_to_fr(amount),
        ]);
        outputs.push(poseidon(&[
            domain_tags::OUTPUT_COMMITMENT_DOMAIN,
            body,
            Fr::from(index as u64),
        ]));
        block.history.payouts.push(PayoutRecord {
            source,
            component,
            amount,
            owner_commitment: fr_to_bytes(owner),
            output_index: index as u64,
            contexts: vec![B256::repeat_byte(0x60 + index as u8)],
        });
    }
    let expected_history = block.history.clone();
    commit_pair(
        &mut memory,
        &mut disk,
        block,
        BlockUpdate {
            output_commitments: outputs,
            ..BlockUpdate::empty(settled.state)
        },
    );
    let retained = disk.reader().snapshot().unwrap();
    assert_eq!(retained.history(1).unwrap(), Some(expected_history.clone()));
    assert_eq!(retained.state_components().unwrap().issuance, settled.state);
    assert_eq!(
        retained.state_components().unwrap().issuance.issued_so_far,
        settled.new_issuance
    );
    assert_eq!(retained.output_count().unwrap(), 4);

    let next = pcash_issuance::transition(settled.state, 12, 1);
    let mut orphan = input(src, 2, 86_412);
    orphan.history.payouts.push(PayoutRecord {
        source: PayoutSource::DesignatedIssuance {
            l1_transaction_index: 0,
            batch_item_index: 0,
        },
        component: PayoutComponent::Issuance,
        amount: next.reward_each,
        owner_commitment: fr_to_bytes(owner),
        output_index: 4,
        contexts: vec![B256::repeat_byte(0x70)],
    });
    commit_pair(
        &mut memory,
        &mut disk,
        orphan,
        BlockUpdate {
            output_commitments: vec![Fr::from(999u64)],
            ..BlockUpdate::empty(next.state)
        },
    );
    let orphan_hash = StateDb::canonical_tip(&disk).unwrap().hash;
    assert_eq!(retained.state_components().unwrap().issuance, settled.state);
    memory.restore_to(src.genesis_l1_block + 1).unwrap();
    disk.restore_to(src.genesis_l1_block + 1).unwrap();
    assert_eq!(StateDb::issuance_state(&disk), settled.state);
    assert_eq!(StateDb::state_root(&disk), StateDb::state_root(&memory));
    assert!(
        StateDb::committed_boundary_by_block_hash(&disk, orphan_hash)
            .unwrap()
            .is_none()
    );
    assert!(disk
        .reader()
        .snapshot()
        .unwrap()
        .history(2)
        .unwrap()
        .is_none());

    let replacement = pcash_issuance::transition(settled.state, 24, 0);
    commit_pair(
        &mut memory,
        &mut disk,
        input(src, 2, 86_424),
        BlockUpdate::empty(replacement.state),
    );
    assert_eq!(
        StateDb::issuance_state(&disk).issued_so_far,
        settled.state.issued_so_far
    );
    assert_ne!(StateDb::issuance_state(&disk).lag_q, settled.state.lag_q);
    let replacement_hash = StateDb::canonical_tip(&disk).unwrap().hash;
    disk.advance_finalized(
        src.genesis_l1_block + 2,
        input(src, 2, 86_424).l1_origin.block_hash,
        prefix,
    )
    .unwrap();
    let adopted = disk.adopted_fork_compatibility();
    drop(retained);
    drop(disk);
    let disk = RedbState::resume(&path, src, adopted).unwrap();
    assert_eq!(StateDb::issuance_state(&disk), replacement.state);
    assert_eq!(
        StateDb::canonical_tip(&disk).unwrap().hash,
        replacement_hash
    );
    assert_eq!(
        disk.reader().snapshot().unwrap().history(1).unwrap(),
        Some(expected_history)
    );
    assert!(disk
        .reader()
        .snapshot()
        .unwrap()
        .history(2)
        .unwrap()
        .unwrap()
        .payouts
        .is_empty());
}

/// One account write: `published` is the exact key the write introduces.
fn write_op(
    address: Address,
    rule: u64,
    kind: u8,
    receive_key_hash: B256,
    published: Option<&[u8]>,
) -> AccountOp {
    AccountOp {
        address,
        nullifier_key_commitment: Fr::from(7u64),
        account_rule_set_commitment: Fr::from(rule),
        kind,
        receive_key_hash,
        published_receive_key: published.map(<[u8]>::to_vec),
    }
}

/// Rebuild the account tree from the canonical write record alone.
fn replay_account_writes(state: &RedbState, through_block: u64) -> (B256, u64) {
    let snapshot = state.reader().snapshot().unwrap();
    let mut tree = pcash_state::SparseTree::new(pcash_state::TREE_DEPTH);
    let mut count = 0;
    for entry in snapshot.account_writes(0, 0, through_block).unwrap() {
        let write = entry.unwrap().write;
        let account = write.account;
        tree.set_leaf(
            account.index,
            account_state_commitment(
                write.address,
                account.nullifier_key_commitment,
                account.account_rule_set_commitment,
                account.kind,
                account.revision,
                account.receive_key_hash,
            ),
        );
        count = count.max(account.index + 1);
    }
    (fr_to_bytes(tree.root()), count)
}

#[test]
fn account_writes_replay_to_each_block_account_root_and_follow_reorgs() {
    let src = source(B256::repeat_byte(0x11));
    let temporary = TempDir::new().unwrap();
    let mut state = RedbState::create(
        temporary.path().join("state.redb"),
        src,
        B256::repeat_byte(0x44),
    )
    .unwrap();
    let alice = Address::repeat_byte(0xa1);
    let bob = Address::repeat_byte(0xb0);
    let contract = Address::repeat_byte(0xc0);
    let bare_contract = Address::repeat_byte(0xc1);
    let key_one = vec![0x11; ML_KEM768_PUBLIC_KEY_LEN];
    let key_two = vec![0x22; ML_KEM768_PUBLIC_KEY_LEN];
    let with = receive_key_hash;
    let cleared = B256::ZERO;
    let blocks = [
        Vec::new(),
        vec![
            write_op(alice, 1, 0, with(&key_one), Some(&key_one)),
            write_op(bob, 1, 0, cleared, None),
        ],
        Vec::new(),
        vec![
            // Keep carries the previous key state forward and publishes nothing.
            write_op(alice, 2, 0, with(&key_one), None),
            write_op(bob, 2, 0, with(&key_two), Some(&key_two)),
            write_op(contract, 3, 1, with(&key_one), Some(&key_one)),
        ],
        vec![
            write_op(alice, 3, 0, cleared, None),
            write_op(alice, 4, 0, with(&key_two), Some(&key_two)),
            write_op(bare_contract, 5, 1, cleared, None),
        ],
    ];
    for (number, ops) in blocks.iter().enumerate() {
        state
            .commit(
                input(src, number as u64, 10 + number as u64),
                BlockUpdate {
                    account_ops: ops.clone(),
                    ..BlockUpdate::empty(state.issuance_state())
                },
            )
            .unwrap();
    }

    for number in 0..blocks.len() as u64 {
        let components = state
            .committed_boundary(number)
            .unwrap()
            .unwrap()
            .state
            .state_components();
        assert_eq!(
            replay_account_writes(&state, number),
            (components.account_state_root, components.account_count),
            "block {number}"
        );
    }

    let snapshot = state.reader().snapshot().unwrap();
    let entries = snapshot
        .account_writes(0, 0, u64::MAX)
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let positions = entries
        .iter()
        .map(|entry| (entry.block_number, entry.ordinal))
        .collect::<Vec<_>>();
    assert_eq!(
        positions,
        vec![
            (1, 0),
            (1, 1),
            (3, 0),
            (3, 1),
            (3, 2),
            (4, 0),
            (4, 1),
            (4, 2)
        ]
    );
    for entry in &entries {
        let op = &blocks[entry.block_number as usize][entry.ordinal as usize];
        assert_eq!(
            entry.block_hash,
            state
                .canonical_block(entry.block_number)
                .unwrap()
                .unwrap()
                .hash
        );
        assert_eq!(entry.write.address, op.address);
        assert_eq!(entry.write.published_receive_key, op.published_receive_key);
        assert_eq!(entry.write.account.receive_key_hash, op.receive_key_hash);
    }
    let rows = |write: &pcash_state::AccountWrite| {
        (
            write.account.index,
            write.account.revision,
            write.account.kind,
        )
    };
    assert_eq!(
        entries
            .iter()
            .map(|entry| rows(&entry.write))
            .collect::<Vec<_>>(),
        vec![
            (0, 1, 0),
            (1, 1, 0),
            (0, 2, 0),
            (1, 2, 0),
            (2, 1, 1),
            (0, 3, 0),
            (0, 4, 0),
            (3, 1, 1),
        ]
    );
    let resumed = snapshot
        .account_writes(3, 2, 4)
        .unwrap()
        .map(|entry| entry.map(|entry| (entry.block_number, entry.ordinal)))
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(resumed, vec![(3, 2), (4, 0), (4, 1), (4, 2)]);
    assert_eq!(snapshot.account_writes(4, 3, 3).unwrap().count(), 0);
    drop(snapshot);

    // A reorg below block 4 drops its writes with the rest of its delta, and
    // the replacement block's writes take their positions.
    state.restore_to(src.genesis_l1_block + 3).unwrap();
    let mut replacement = input(src, 4, 20);
    replacement.l1_origin.block_hash = B256::repeat_byte(0x99);
    state
        .commit(
            replacement,
            BlockUpdate {
                account_ops: vec![write_op(bob, 6, 0, cleared, None)],
                ..BlockUpdate::empty(state.issuance_state())
            },
        )
        .unwrap();
    let snapshot = state.reader().snapshot().unwrap();
    let after = snapshot
        .account_writes(4, 0, u64::MAX)
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].write.address, bob);
    assert_eq!(after[0].write.account.revision, 3);
    assert_eq!(after[0].block_hash, state.canonical_tip().unwrap().hash);
    let components = state.state_components();
    assert_eq!(
        replay_account_writes(&state, 4),
        (components.account_state_root, components.account_count)
    );
}
