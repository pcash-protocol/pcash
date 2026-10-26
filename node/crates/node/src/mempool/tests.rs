#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]

use super::service::*;
use super::store::*;
use super::*;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex, RwLock};

use alloy_primitives::{b256, keccak256, Address, Bytes, B256, U256};
use pcash_derive::private_value_profiles::PrivateValueShape;
use pcash_derive::{
    AccountCreationAuthorization, AdmittedTransaction, BlockOutcome, CarrierContext,
    ContractAccountCreation, ContractBody, ContractFunction, PrivateValueSection, ReceiveKeyUpdate,
    SectionLayout, Transaction, UserAccountCreation, UserAccountUpdate,
};
use pcash_l1::{CarrierKind, L1BlockData, L1Header, L1Receipt, L1Tx};
use pcash_metrics::{AdmissionOutcome, AdmissionSource, Metrics};
use pcash_rpc::{
    BlockId, CarrierContextRequest, CheckOutcomeDto, CheckRawTransactionRequest, MempoolApiError,
    MempoolFilter, MempoolSort, MempoolStatusFilter, MempoolTransactionDto, PrepareRelayRequest,
    TransactionCheckDto,
};
use pcash_state::{
    AcceptedEffects, CircuitWord, Codec, DecodeError, DerivationSource, ItemExclusionReason,
    StateDb, TransactionOutcome, RECENT_PCASH_BLOCK_WINDOW_SECONDS,
};
use pcash_verify::BbProcessVerifier;
use redb::{Database, TableDefinition};
use tempfile::tempdir;

fn delivery_data(payload: &[u8]) -> Vec<u8> {
    let mut data = vec![0; pcash_derive::OUTPUT_DATA_BYTES];
    data[0] = 1;
    data[1..=payload.len()].copy_from_slice(payload);
    data
}

fn arena(shape: PrivateValueShape) -> Vec<u8> {
    vec![0; shape.profile().arena_bytes]
}

/// The chain ids and inbox of [`service`], which are all a descriptor reads.
fn test_source() -> DerivationSource {
    DerivationSource {
        pcash_chain_id: crate::PCASH_CHAIN_ID,
        l1_chain_id: crate::L1_CHAIN_ID,
        inbox_address: crate::DEFAULT_INBOX,
        genesis_l1_block: 100,
        genesis_l1_block_hash: B256::ZERO,
    }
}

/// The outcome of every admitted transaction in a derived block.
fn transaction_outcomes(outcome: &BlockOutcome) -> Vec<TransactionOutcome> {
    outcome
        .committed_boundary
        .block
        .transaction_results
        .iter()
        .map(|result| result.outcome)
        .collect()
}

/// Accepted content hashes and effects from one committed outcome. Direct L1
/// user creations retain their content hash but have no conflict effects.
fn accepted_block_inputs(outcome: &BlockOutcome) -> (Vec<B256>, Vec<&AcceptedEffects>) {
    let results = &outcome.committed_boundary.block.transaction_results;
    let raw_transactions = &outcome.committed_boundary.block.transaction_bytes;
    let hashes = results
        .iter()
        .zip(raw_transactions)
        .filter(|(result, _)| result.outcome == TransactionOutcome::Succeeded)
        .map(|(_, raw)| pcash_state::content_hash(raw))
        .collect();
    let effects =
        crate::follow::mempool_conflict_effects(&outcome.transaction_effects, raw_transactions);
    (hashes, effects)
}

/// The address a contract creation's body derives.
fn contract_address(transaction: &AdmittedTransaction) -> Option<Address> {
    match transaction {
        AdmittedTransaction::ContractAccountCreation(_, check)
        | AdmittedTransaction::PrivateValue(_, Some(check)) => check.address(),
        _ => None,
    }
}

/// A pool row with arbitrary descriptor fields and no cached transaction. A
/// test that revalidates it needs [`stored_with_description`]; one that
/// reloads it needs transaction bytes, which the reload decodes.
fn stored(raw: Vec<u8>, head: u64) -> StoredEntry {
    let content_hash = pcash_state::content_hash(&raw);
    StoredEntry {
        content_hash,
        metadata: EntryMetadata {
            statement_id: content_hash,
            kind: TransactionKind::PrivateValue,
            stable_id: StableId::Nullifier(B256::repeat_byte(3)),
            conflict_keys: vec![ConflictKey::Nullifier(B256::repeat_byte(3))],
            open_fee_amount: U256::from(9u64),
            issuance_owner_commitment: B256::ZERO,
            has_publication_section: true,
            valid_until_timestamp: Some(123),
            recent_pcash_block_hash: Some(B256::repeat_byte(4)),
            public_records: Vec::new(),
        },
        prepared: CachedEntry::default(),
        raw,
        status: MempoolStatus::Ready,
        included_block: None,
        superseded_block: None,
        invalidated_block: None,
        validated_block: BlockId {
            block_number: head,
            block_hash: B256::repeat_byte(4),
        },
        received_at_unix_ms: 1,
    }
}

fn stored_with_description(raw: Vec<u8>, head: BlockId) -> StoredEntry {
    let prepared =
        CachedEntry::new(AdmittedTransaction::decode(&raw, crate::PCASH_CHAIN_ID).unwrap());
    let metadata = descriptor_admitted(&raw, prepared.get(), &test_source()).unwrap();
    StoredEntry {
        content_hash: pcash_state::content_hash(&raw),
        metadata,
        raw,
        prepared,
        status: MempoolStatus::Ready,
        included_block: None,
        superseded_block: None,
        invalidated_block: None,
        validated_block: head,
        received_at_unix_ms: now_unix_ms(),
    }
}

#[test]
fn in_memory_mempool_uses_the_persistent_schema() {
    let store = MempoolStore::open_in_memory(
        1,
        B256::repeat_byte(1),
        MempoolLimits {
            accept_unpaid_registration: true,
            ..MempoolLimits::default()
        },
    )
    .unwrap();
    assert!(store.entries.is_empty());
    validate_mempool_schema(&store.db).unwrap();
}

#[test]
fn mempool_page_matches_public_arena_records() {
    use pcash_derive::public_records::PublicRecord;
    let mut store = MempoolStore::open_in_memory(
        1,
        B256::repeat_byte(1),
        MempoolLimits {
            accept_unpaid_registration: true,
            ..MempoolLimits::default()
        },
    )
    .unwrap();
    let schema = [0x80, 1, 2, 3];
    let record = |data: &[u8]| PublicRecord {
        schema,
        data: data.to_vec(),
    };
    let mut first = stored(vec![1], 1);
    first.metadata.stable_id = StableId::Nullifier(B256::repeat_byte(1));
    first.metadata.conflict_keys = vec![ConflictKey::Nullifier(B256::repeat_byte(1))];
    first.metadata.public_records = vec![record(&[0, 7, 7, 1])];
    let mut second = stored(vec![2], 1);
    second.metadata.stable_id = StableId::Nullifier(B256::repeat_byte(2));
    second.metadata.conflict_keys = vec![ConflictKey::Nullifier(B256::repeat_byte(2))];
    second.metadata.public_records = vec![record(&[0, 8, 8])];
    let mut other = stored(vec![3], 1);
    other.metadata.stable_id = StableId::Nullifier(B256::repeat_byte(3));
    other.metadata.conflict_keys = vec![ConflictKey::Nullifier(B256::repeat_byte(3))];
    other.metadata.public_records = vec![PublicRecord {
        schema: [0x80, 9, 9, 9],
        data: vec![0, 7, 7],
    }];
    // An account update can carry public records too; the board reads only
    // private-value transactions and asks for that kind.
    let mut update = stored(vec![5], 1);
    update.metadata.kind = TransactionKind::UserAccountUpdate;
    update.metadata.stable_id = StableId::Nullifier(B256::repeat_byte(5));
    update.metadata.conflict_keys = vec![ConflictKey::Nullifier(B256::repeat_byte(5))];
    update.metadata.public_records = vec![record(&[0, 7, 7, 1])];
    for entry in [
        first.clone(),
        second.clone(),
        other,
        stored(vec![4], 1),
        update.clone(),
    ] {
        store.insert(entry).unwrap();
    }
    let matching = |data: Vec<(usize, Vec<u8>)>| {
        let mut hashes = store
            .page(&MempoolFilter {
                limit: 10,
                kind: Some(pcash_rpc::TransactionKind::PrivateValue),
                arena: Some(pcash_rpc::ArenaFilter { schema, data }),
                ..Default::default()
            })
            .unwrap()
            .0
            .iter()
            .map(|entry| entry.content_hash)
            .collect::<Vec<_>>();
        hashes.sort_unstable();
        hashes
    };
    let mut both = vec![first.content_hash, second.content_hash];
    both.sort_unstable();
    assert_eq!(matching(Vec::new()), both);
    assert_eq!(matching(vec![(1, vec![7, 7])]), vec![first.content_hash]);
    assert_eq!(
        matching(vec![(0, vec![0]), (3, vec![1])]),
        vec![first.content_hash]
    );
    // A match reaching past the record's data does not match.
    assert!(matching(vec![(2, vec![8, 8])]).is_empty());
    let any_kind = store
        .page(&MempoolFilter {
            limit: 10,
            arena: Some(pcash_rpc::ArenaFilter {
                schema,
                data: vec![(1, vec![7, 7])],
            }),
            ..Default::default()
        })
        .unwrap()
        .0;
    assert_eq!(any_kind.len(), 2);
    let dto = store.get(&first.content_hash).unwrap().to_dto(false, 0);
    assert_eq!(dto.public_records.len(), 1);
    assert_eq!(dto.public_records[0].data.as_ref(), &[0, 7, 7, 1]);
}

#[test]
fn mempool_page_filters_relayer_status_and_sorts_for_relay() {
    let directory = tempdir().unwrap();
    let mut store = MempoolStore::open(
        directory.path().join("mempool.redb"),
        1,
        B256::repeat_byte(1),
        MempoolLimits {
            accept_unpaid_registration: true,
            ..MempoolLimits::default()
        },
    )
    .unwrap();
    let relayer = B256::repeat_byte(9);
    let mut oldest = stored(vec![1], 1);
    oldest.metadata.stable_id = StableId::Nullifier(B256::repeat_byte(1));
    oldest.metadata.conflict_keys = vec![ConflictKey::Nullifier(B256::repeat_byte(1))];
    oldest.metadata.open_fee_amount = U256::from(1u64);
    oldest.received_at_unix_ms = 10;
    let mut newest = stored(vec![2, 2], 1);
    newest.metadata.stable_id = StableId::Nullifier(B256::repeat_byte(2));
    newest.metadata.conflict_keys = vec![ConflictKey::Nullifier(B256::repeat_byte(2))];
    newest.metadata.open_fee_amount = U256::ZERO;
    newest.metadata.issuance_owner_commitment = relayer;
    newest.received_at_unix_ms = now_unix_ms();
    let mut suspended = stored(vec![3, 3, 3, 3], 1);
    suspended.metadata.stable_id = StableId::Nullifier(B256::repeat_byte(3));
    suspended.metadata.conflict_keys = vec![ConflictKey::Nullifier(B256::repeat_byte(3))];
    suspended.metadata.open_fee_amount = U256::ZERO;
    suspended.metadata.issuance_owner_commitment = B256::repeat_byte(8);
    suspended.received_at_unix_ms = newest.received_at_unix_ms - 1;
    suspended.status = MempoolStatus::Suspended;
    let mut included = stored(vec![4], 1);
    included.metadata.stable_id = StableId::Nullifier(B256::repeat_byte(4));
    included.metadata.conflict_keys = vec![ConflictKey::Nullifier(B256::repeat_byte(4))];
    included.received_at_unix_ms = 40;
    included.status = MempoolStatus::IncludedUnfinalized;
    for entry in [
        oldest.clone(),
        newest.clone(),
        suspended.clone(),
        included.clone(),
    ] {
        store.insert(entry).unwrap();
    }

    let (received, _) = store
        .page(&MempoolFilter {
            limit: 10,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        received
            .iter()
            .map(|entry| entry.content_hash)
            .collect::<Vec<_>>(),
        vec![
            newest.content_hash,
            suspended.content_hash,
            oldest.content_hash
        ]
    );
    let (ready, _) = store
        .page(&MempoolFilter {
            limit: 10,
            status: Some(MempoolStatusFilter::Ready),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(ready.len(), 2);
    assert!(ready
        .iter()
        .all(|entry| entry.status == MempoolStatus::Ready));
    assert_eq!(
        store.get(&included.content_hash).unwrap().status,
        MempoolStatus::IncludedUnfinalized
    );
    let (relayable, _) = store
        .page(&MempoolFilter {
            limit: 10,
            controlled_issuance_owner_commitments: Some(vec![relayer]),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        relayable
            .iter()
            .map(|entry| entry.content_hash)
            .collect::<Vec<_>>(),
        vec![newest.content_hash, oldest.content_hash]
    );
    let (density, _) = store
        .page(&MempoolFilter {
            limit: 10,
            sort: MempoolSort::FeeDensity,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(density[0].content_hash, oldest.content_hash);
    let remaining = [density[1].content_hash, density[2].content_hash];
    assert!(remaining.contains(&newest.content_hash));
    assert!(remaining.contains(&suspended.content_hash));
}

#[test]
fn stored_entry_rows_decode_exactly_and_hold_the_transaction_bytes_once() {
    let block = BlockId {
        block_number: 7,
        block_hash: B256::repeat_byte(4),
    };
    let raw = transfer_raw(B256::repeat_byte(5), &[1], 1_000);
    let pending = stored_with_description(raw.clone(), block);
    let mut settled = pending.clone();
    settled.metadata.valid_until_timestamp = None;
    settled.status = MempoolStatus::IncludedUnfinalized;
    settled.included_block = Some(block);
    settled.superseded_block = Some(block);
    settled.invalidated_block = Some(block);
    for entry in [pending, settled] {
        let row = entry.encode();
        assert_eq!(StoredEntry::decode(&row).unwrap(), entry);
        assert_eq!(
            StoredEntry::decode(&row[..row.len() - 1]),
            Err(DecodeError::Truncated)
        );
        assert_eq!(
            StoredEntry::decode(&[row.as_slice(), &[0]].concat()),
            Err(DecodeError::Trailing)
        );
        assert!(row.len() <= raw.len() + 1024, "row is {} bytes", row.len());
    }
}

#[test]
fn store_requires_the_exact_table_and_metadata_schema() {
    let limits = MempoolLimits {
        accept_unpaid_registration: true,
        ..MempoolLimits::default()
    };

    let metadata_dir = tempdir().unwrap();
    let metadata_path = metadata_dir.path().join("mempool.redb");
    drop(MempoolStore::open(&metadata_path, 7, B256::repeat_byte(8), limits).unwrap());
    {
        let db = Database::create(&metadata_path).unwrap();
        let write = db.begin_write().unwrap();
        {
            let mut meta = write.open_table(T_META).unwrap();
            meta.insert(b"unexpected".as_slice(), b"value".as_slice())
                .unwrap();
        }
        write.commit().unwrap();
    }
    assert!(MempoolStore::open(&metadata_path, 7, B256::repeat_byte(8), limits).is_err());

    let table_dir = tempdir().unwrap();
    let table_path = table_dir.path().join("mempool.redb");
    drop(MempoolStore::open(&table_path, 7, B256::repeat_byte(8), limits).unwrap());
    {
        let db = Database::create(&table_path).unwrap();
        let write = db.begin_write().unwrap();
        let unexpected = TableDefinition::<&[u8], &[u8]>::new("unexpected");
        write.open_table(unexpected).unwrap();
        write.commit().unwrap();
    }
    assert!(MempoolStore::open(&table_path, 7, B256::repeat_byte(8), limits).is_err());
}

#[test]
fn reopening_drops_rows_this_build_cannot_read() {
    use redb::ReadableDatabase;
    let limits = MempoolLimits {
        accept_unpaid_registration: true,
        ..MempoolLimits::default()
    };
    let directory = tempdir().unwrap();
    let path = directory.path().join("mempool.redb");
    drop(MempoolStore::open(&path, 7, B256::repeat_byte(8), limits).unwrap());
    let unreadable = B256::repeat_byte(6);
    {
        let db = Database::create(&path).unwrap();
        let write = db.begin_write().unwrap();
        {
            let mut entries = write.open_table(T_ENTRIES).unwrap();
            entries
                .insert(unreadable.as_slice(), [1u8, 2, 3].as_slice())
                .unwrap();
        }
        write.commit().unwrap();
    }
    let store = MempoolStore::open(&path, 7, B256::repeat_byte(8), limits).unwrap();
    assert!(store.get(&unreadable).is_none());
    drop(store);
    let db = Database::create(&path).unwrap();
    let read = db.begin_read().unwrap();
    assert!(read
        .open_table(T_ENTRIES)
        .unwrap()
        .get(unreadable.as_slice())
        .unwrap()
        .is_none());
}

fn word(value: u64) -> CircuitWord {
    CircuitWord::from(U256::from(value).to_be_bytes())
}

fn private_value_wire_input_offset(verifier_input: usize) -> usize {
    assert_ne!(verifier_input, 0);
    assert!(!(11..16).contains(&verifier_input));
    let wire_input = if verifier_input < 11 {
        verifier_input - 1
    } else {
        verifier_input - 6
    };
    1 + 4 + 1 + wire_input * 32
}

fn transfer_raw(recent_pcash_block_hash: B256, proof: &[u8], valid_until: u64) -> Vec<u8> {
    transfer_raw_timed(recent_pcash_block_hash, proof, 0, valid_until)
}

fn transfer_raw_timed(
    recent_pcash_block_hash: B256,
    proof: &[u8],
    not_before: u64,
    valid_until: u64,
) -> Vec<u8> {
    Transaction::PrivateValue(transfer_section(
        recent_pcash_block_hash,
        proof,
        not_before,
        valid_until,
    ))
    .encode(crate::PCASH_CHAIN_ID)
    .unwrap()
}

/// The S private-value section of [`transfer_raw_timed`]. `proof` is
/// zero-padded to the release proof size.
fn transfer_section(
    recent_pcash_block_hash: B256,
    proof: &[u8],
    not_before: u64,
    valid_until: u64,
) -> PrivateValueSection {
    let mut proof = proof.to_vec();
    proof.resize(
        SectionLayout::PrivateValue(PrivateValueShape::S).proof_bytes(),
        0,
    );
    PrivateValueSection::new(
        PrivateValueShape::S,
        crate::PCASH_CHAIN_ID,
        &[
            recent_pcash_block_hash,
            word(3),
            word(4),
            word(5),
            word(6),
            word(0x306),
            word(0x307),
            word(0x308),
            word(0x309),
            word(0x30a),
            word(0), // openFeeAmount
            // Zero open fee with designated issuance.
            word(1),
            word(not_before),
            word(valid_until),
            word(0), // carrierContextHash
            word(0), // eventsCommitment
        ],
        proof,
        vec![
            delivery_data(&[0x11u8, 0x22]),
            delivery_data(&[0x33u8, 0x44]),
            delivery_data(&[0x55u8, 0x66]),
            delivery_data(&[0x77u8, 0x88]),
            delivery_data(&[0x99u8, 0xaa]),
        ],
        arena(PrivateValueShape::S),
    )
    .unwrap()
}

fn l1_block(
    number: u64,
    hash: B256,
    parent_hash: B256,
    timestamp: u64,
    inbox_item: Option<Vec<u8>>,
) -> L1BlockData {
    let txs = inbox_item
        .map(|raw| {
            vec![(
                L1Tx {
                    hash: keccak256([number as u8]),
                    from: Address::from([0x55u8; 20]),
                    to: Some(crate::DEFAULT_INBOX),
                    input: Bytes::from(frame_batch(&[raw])),
                    blob_versioned_hashes: Vec::new(),
                    blob_resolution: Default::default(),
                    tx_index: 0,
                },
                L1Receipt { logs: Vec::new() },
            )]
        })
        .unwrap_or_default();
    L1BlockData::new(
        L1Header {
            number,
            hash,
            parent_hash,
            timestamp,
        },
        txs,
    )
}

fn service_for_config(dir: &Path, cfg: &crate::NetworkConfig) -> (MempoolService, PathBuf, B256) {
    let inner = crate::build_node_with_rules_inner(
        &dir.join("state.redb"),
        cfg,
        crate::config::compiled_rules(),
    )
    .unwrap();
    {
        let mut guard = inner.lock().unwrap();
        guard
            .apply_block(
                &l1_block(
                    cfg.genesis_l1_block,
                    cfg.genesis_l1_block_hash,
                    B256::ZERO,
                    1_000,
                    None,
                ),
                &AlreadyVerified,
            )
            .unwrap();
    }
    let genesis_hash = inner
        .lock()
        .unwrap()
        .state
        .canonical_genesis_hash()
        .unwrap();
    let path = dir.join("mempool.redb");
    let store = MempoolStore::open(
        &path,
        cfg.pcash_chain_id,
        genesis_hash,
        MempoolLimits {
            accept_unpaid_registration: true,
            ..MempoolLimits::default()
        },
    )
    .unwrap();
    let (state_reader, source) = {
        let guard = inner.lock().unwrap();
        (guard.state.reader(), guard.source)
    };
    (
        MempoolService {
            inner,
            source,
            state_reader,
            store: Mutex::new(store),
            lifecycle: RwLock::new(LifecycleState::Ready),
            admission: unused_admission(dir),
            metrics: pcash_metrics::noop(),
            unpaid_budget: Mutex::new((std::time::Instant::now(), 0)),
        },
        path,
        genesis_hash,
    )
}

/// One worker whose verifier cannot start, so any proof check fails as a tool error.
fn unused_admission(dir: &Path) -> AdmissionPool {
    AdmissionPool::new(vec![BbProcessVerifier::new(dir.join("unused-bb"))], 1).unwrap()
}

/// Run one admission to completion on this thread, as a verifier worker would.
fn admit(
    service: &MempoolService,
    raw: Vec<u8>,
    source: AdmissionSource,
) -> Result<MempoolTransactionDto, MempoolApiError> {
    service.admit_and_record(raw, source, &BbProcessVerifier::new("unused-bb"))
}

pub(crate) fn service(dir: &Path, genesis_block_hash: B256) -> (MempoolService, PathBuf, B256) {
    let cfg = crate::NetworkConfig::new(
        crate::PCASH_CHAIN_ID,
        crate::L1_CHAIN_ID,
        crate::DEFAULT_INBOX,
        100,
        genesis_block_hash,
    );
    service_for_config(dir, &cfg)
}

#[test]
fn ready_fee_samples_pool_all_fee_bearing_kinds() {
    let dir = tempdir().unwrap();
    let (service, _, _) = service(dir.path(), B256::repeat_byte(7));
    let mut ready = stored(vec![1, 2, 3], 0);
    ready.metadata.open_fee_amount = U256::from(30u64);
    let mut suspended = stored(vec![4, 4], 0);
    suspended.metadata.stable_id = StableId::Nullifier(B256::repeat_byte(4));
    suspended.metadata.conflict_keys = vec![ConflictKey::Nullifier(B256::repeat_byte(4))];
    suspended.status = MempoolStatus::Suspended;
    let mut account = stored(vec![5], 0);
    account.metadata.kind = TransactionKind::UserAccountCreation;
    account.metadata.stable_id = StableId::Account(Address::repeat_byte(5));
    account.metadata.conflict_keys = vec![ConflictKey::Account(Address::repeat_byte(5))];
    account.metadata.open_fee_amount = U256::ZERO;
    account.metadata.has_publication_section = false;
    {
        let mut store = service.store.lock().unwrap();
        store.insert(ready).unwrap();
        store.insert(suspended).unwrap();
        store.insert(account).unwrap();
        for (kind, byte) in [
            (TransactionKind::ContractAccountCreation, 6),
            (TransactionKind::UserAccountUpdate, 7),
        ] {
            let mut entry = stored(vec![byte; 4], 0);
            entry.metadata.kind = kind;
            entry.metadata.stable_id = StableId::Nullifier(B256::repeat_byte(byte));
            entry.metadata.conflict_keys = vec![ConflictKey::Nullifier(B256::repeat_byte(byte))];
            store.insert(entry).unwrap();
        }
    }
    let mut samples = service.ready_fee_samples();
    samples.sort_unstable();
    assert_eq!(
        samples,
        vec![
            (U256::from(9u64), 4),
            (U256::from(9u64), 4),
            (U256::from(30u64), 3)
        ]
    );
}

#[test]
fn designated_pending_fees_do_not_raise_an_open_quote() {
    use crate::fee_estimate::{estimate, FeeEstimateInputs, FeeSample};
    let dir = tempdir().unwrap();
    let (service, _, _) = service(dir.path(), B256::repeat_byte(7));
    let quote = || {
        let pending: Vec<_> = service
            .ready_fee_samples()
            .into_iter()
            .map(|(fee, bytes)| FeeSample { fee, bytes })
            .collect();
        estimate(
            &FeeEstimateInputs {
                included: &[],
                pending: &pending,
            },
            1_000,
        )
    };
    let baseline = quote();
    let mut entry = stored(vec![1; 1_000], 0);
    entry.metadata.open_fee_amount = U256::ZERO;
    entry.metadata.issuance_owner_commitment = B256::repeat_byte(1);
    service.store.lock().unwrap().insert(entry.clone()).unwrap();
    assert_eq!(quote(), baseline);
    {
        let mut store = service.store.lock().unwrap();
        let retained = store.entries.get_mut(&entry.content_hash).unwrap();
        retained.metadata.issuance_owner_commitment = B256::ZERO;
        retained.metadata.open_fee_amount = U256::from(1_000_000u64);
    }
    let open = quote();
    assert_eq!(open.basis.pending_samples, 1);
    assert_eq!(open.tiers.low, U256::from(1_000_000u64));
    assert_eq!(open.tiers.standard, U256::from(1_000_000u64));
    assert_eq!(open.tiers.fast, U256::from(1_000_000u64));
}

#[test]
fn store_persists_and_deduplicates_exact_transaction() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("mempool.redb");
    let genesis = B256::repeat_byte(7);
    let raw = transfer_raw(B256::ZERO, &[1], 2_000);
    let entry = stored(raw.clone(), 10);
    let content_hash = entry.content_hash;
    {
        let mut store = MempoolStore::open(
            &path,
            crate::PCASH_CHAIN_ID,
            genesis,
            MempoolLimits {
                accept_unpaid_registration: true,
                ..MempoolLimits::default()
            },
        )
        .unwrap();
        store.insert(entry.clone()).unwrap();
        store.insert(entry).unwrap();
        assert_eq!(store.entries.len(), 1);
        assert_eq!(store.total_bytes, raw.len());
    }
    let store = MempoolStore::open(
        &path,
        crate::PCASH_CHAIN_ID,
        genesis,
        MempoolLimits {
            accept_unpaid_registration: true,
            ..MempoolLimits::default()
        },
    )
    .unwrap();
    assert_eq!(store.get(&content_hash).unwrap().raw, raw);
}

struct BarrierVerifier(Arc<Barrier>);

impl pcash_verify::Verifier for BarrierVerifier {
    fn verify(
        &self,
        _vk: &[u8],
        _proof: &[u8],
        _public_inputs: &[u8],
    ) -> Result<bool, pcash_verify::VerifyError> {
        self.0.wait();
        Ok(true)
    }
}

#[derive(Default)]
struct AdmissionRecorder {
    accepted: AtomicUsize,
    duplicate: AtomicUsize,
}

impl Metrics for AdmissionRecorder {
    fn record_mempool_admission(&self, _source: AdmissionSource, outcome: AdmissionOutcome) {
        match outcome {
            AdmissionOutcome::Accepted => {
                self.accepted.fetch_add(1, Ordering::Relaxed);
            }
            AdmissionOutcome::Duplicate => {
                self.duplicate.fetch_add(1, Ordering::Relaxed);
            }
            _ => {}
        }
    }
}

#[test]
fn simultaneous_same_raw_admissions_deduplicate_after_verification() {
    let dir = tempdir().unwrap();
    let (mut service, _, _) = service(dir.path(), B256::repeat_byte(0x37));
    let recent = service
        .inner
        .lock()
        .unwrap()
        .state
        .canonical_tip()
        .unwrap()
        .hash;
    let raw = transfer_raw(recent, &[1], 2_000);
    let metrics = Arc::new(AdmissionRecorder::default());
    service.metrics = metrics.clone();
    let service = Arc::new(service);
    let barrier = Arc::new(Barrier::new(2));
    let handles = (0..2)
        .map(|_| {
            let service = Arc::clone(&service);
            let barrier = Arc::clone(&barrier);
            let raw = raw.clone();
            std::thread::spawn(move || {
                service.admit_and_record(raw, AdmissionSource::Rpc, &BarrierVerifier(barrier))
            })
        })
        .collect::<Vec<_>>();
    let admitted = handles
        .into_iter()
        .map(|handle| handle.join().unwrap().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(admitted[0].content_hash, admitted[1].content_hash);
    assert_eq!(service.store.lock().unwrap().entries.len(), 1);
    assert_eq!(metrics.accepted.load(Ordering::Relaxed), 1);
    assert_eq!(metrics.duplicate.load(Ordering::Relaxed), 1);
}

#[test]
fn store_rejects_another_genesis_and_enforces_limits() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("mempool.redb");
    let limits = MempoolLimits {
        accept_unpaid_registration: true,
        max_entries: 1,
        max_bytes: 3,
        max_unpaid_entries: 1,
    };
    let mut store = MempoolStore::open(&path, 1346589512, B256::repeat_byte(1), limits).unwrap();
    store.insert(stored(vec![1, 2, 3], 1)).unwrap();
    assert!(matches!(
        store.insert(stored(vec![4, 5, 6], 1)),
        Err(MempoolApiError::Full)
    ));
    drop(store);
    assert!(matches!(
        MempoolStore::open(&path, 1346589512, B256::repeat_byte(2), limits),
        Err(MempoolApiError::Storage(_))
    ));
}

#[test]
fn account_quota_preserves_capacity_for_fee_bearing_entries() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("mempool.redb");
    let limits = MempoolLimits {
        accept_unpaid_registration: true,
        max_entries: 2,
        max_bytes: 1024,
        max_unpaid_entries: 1,
    };
    let mut store = MempoolStore::open(&path, 1346589512, B256::repeat_byte(1), limits).unwrap();
    let mut first_account = stored(vec![1], 1);
    first_account.metadata.kind = TransactionKind::UserAccountCreation;
    first_account.metadata.open_fee_amount = U256::ZERO;
    first_account.metadata.valid_until_timestamp = None;
    first_account.received_at_unix_ms = now_unix_ms();
    store.insert(first_account).unwrap();

    let mut second_account = stored(vec![2], 1);
    second_account.metadata.kind = TransactionKind::ContractAccountCreation;
    second_account.metadata.open_fee_amount = U256::ZERO;
    second_account.metadata.valid_until_timestamp = None;
    second_account.received_at_unix_ms = now_unix_ms();
    assert!(matches!(
        store.insert(second_account),
        Err(MempoolApiError::Full)
    ));

    let transfer = stored(vec![3], 1);
    let transfer_content_hash = transfer.content_hash;
    store.insert(transfer).unwrap();
    assert!(store.get(&transfer_content_hash).is_some());
}

#[test]
fn known_transaction_type_outside_its_activation_window_is_state_dependent() {
    let raw = transfer_raw(B256::ZERO, &[], 99);
    let rules = pcash_derive::ProtocolRules::new([vec![], vec![]], vec![]).with_fork(
        pcash_derive::ForkActivation {
            name: "retire private value",
            activation_timestamp: 10,
            accepted_transaction_types: vec![
                pcash_derive::KIND_USER_ACCOUNT_CREATION,
                pcash_derive::KIND_CONTRACT_ACCOUNT_CREATION,
                pcash_derive::KIND_USER_ACCOUNT_UPDATE,
            ],
            accepted_batch_versions: pcash_derive::BASE_BATCH_VERSIONS.to_vec(),
            hiding_kernel_vks: Vec::new(),
        },
    );

    assert!(descriptor_at_timestamp(&raw, &rules, &test_source(), 9).is_ok());
    assert!(matches!(
        descriptor_at_timestamp(&raw, &rules, &test_source(), 10),
        Err(MempoolApiError::State(_))
    ));
    assert!(matches!(
        descriptor_at_timestamp(&[0xff], &rules, &test_source(), 10),
        Err(MempoolApiError::Invalid(_))
    ));
}

#[test]
fn statement_id_excludes_proof_bytes() {
    fn raw(proof_byte: u8) -> Vec<u8> {
        Transaction::PrivateValue(
            PrivateValueSection::new(
                PrivateValueShape::S,
                crate::PCASH_CHAIN_ID,
                &[CircuitWord::ZERO; pcash_derive::PRIVATE_VALUE_WIRE_INPUTS],
                vec![proof_byte; SectionLayout::PrivateValue(PrivateValueShape::S).proof_bytes()],
                vec![delivery_data(&[]); pcash_derive::PRIVATE_VALUE_OUTPUT_DATA_ITEMS],
                arena(PrivateValueShape::S),
            )
            .unwrap(),
        )
        .encode(crate::PCASH_CHAIN_ID)
        .unwrap()
    }
    let first = descriptor(&raw(1), &test_source()).unwrap();
    let second = descriptor(&raw(4), &test_source()).unwrap();
    assert_eq!(first.statement_id, second.statement_id);
    assert_ne!(
        pcash_state::content_hash(&raw(1)),
        pcash_state::content_hash(&raw(4))
    );
}

#[test]
fn account_update_statement_id_binds_its_account_update_commitment() {
    fn raw(account_update_commitment: u8, proof_byte: u8) -> Vec<u8> {
        Transaction::UserAccountUpdate(UserAccountUpdate {
            address: Address::repeat_byte(0x11),
            new_rule_set_commitment: B256::repeat_byte(2),
            receive_key_update: ReceiveKeyUpdate::Keep,
            account_update_commitment: B256::repeat_byte(account_update_commitment),
            section: PrivateValueSection::new(
                PrivateValueShape::S,
                crate::PCASH_CHAIN_ID,
                &[CircuitWord::ZERO; pcash_derive::PRIVATE_VALUE_WIRE_INPUTS],
                vec![proof_byte; pcash_derive::WIRE_PROOF_BYTES],
                vec![delivery_data(&[]); pcash_derive::PRIVATE_VALUE_OUTPUT_DATA_ITEMS],
                arena(PrivateValueShape::S),
            )
            .unwrap(),
        })
        .encode(crate::PCASH_CHAIN_ID)
        .unwrap()
    }
    // Re-proving one complete statement deduplicates; authorizing a different
    // transition over the same fee section is a different statement.
    let base = descriptor(&raw(7, 1), &test_source()).unwrap();
    assert_eq!(
        base.statement_id,
        descriptor(&raw(7, 2), &test_source()).unwrap().statement_id
    );
    assert_ne!(
        base.statement_id,
        descriptor(&raw(8, 1), &test_source()).unwrap().statement_id
    );
}

#[test]
fn applied_block_retains_exact_bytes_and_rollback_resurrects_variants() {
    let dir = tempdir().unwrap();
    let genesis_block_hash =
        b256!("0xaa00000000000000000000000000000000000000000000000000000000000064");
    let block_hash = b256!("0xbb00000000000000000000000000000000000000000000000000000000000065");
    let (service, _, _) = service(dir.path(), genesis_block_hash);
    let (recent_pcash_block_hash, pre_block_head) = {
        let guard = service.inner.lock().unwrap();
        (guard.state.canonical_tip().unwrap().hash, guard.head_id())
    };
    let included_raw = transfer_raw(recent_pcash_block_hash, &[1], 2_000);
    let variant_raw = transfer_raw(recent_pcash_block_hash, &[2], 2_000);
    let included_content_hash = pcash_state::content_hash(&included_raw);
    let variant_content_hash = pcash_state::content_hash(&variant_raw);
    {
        let mut store = service.store.lock().unwrap();
        store
            .insert(stored_with_description(
                included_raw.clone(),
                pre_block_head,
            ))
            .unwrap();
        store
            .insert(stored_with_description(variant_raw.clone(), pre_block_head))
            .unwrap();
    }

    let outcome = {
        let mut guard = service.inner.lock().unwrap();
        guard
            .apply_block(
                &l1_block(
                    101,
                    block_hash,
                    genesis_block_hash,
                    1_001,
                    Some(included_raw.clone()),
                ),
                &AlreadyVerified,
            )
            .unwrap()
    };
    assert_eq!(
        transaction_outcomes(&outcome),
        [TransactionOutcome::Succeeded]
    );
    let applied_head = service.inner.lock().unwrap().head_id();
    let (hashes, effects) = accepted_block_inputs(&outcome);
    service
        .on_applied_block(applied_head, &hashes, &effects)
        .unwrap();
    {
        let store = service.store.lock().unwrap();
        let included = store.get(&included_content_hash).unwrap();
        assert_eq!(included.status, MempoolStatus::IncludedUnfinalized);
        assert_eq!(included.included_block, Some(applied_head));
        assert_eq!(included.raw, included_raw);
        let variant = store.get(&variant_content_hash).unwrap();
        assert_eq!(variant.status, MempoolStatus::Suspended);
        assert_eq!(variant.superseded_block, Some(applied_head));
        assert_eq!(variant.raw, variant_raw);
    }
    assert!(service.ready_inventory().is_empty());

    service.inner.lock().unwrap().rollback_to(100).unwrap();
    service.on_rollback(0).unwrap();
    let ready = service.ready_inventory();
    assert_eq!(ready.len(), 2);
    let store = service.store.lock().unwrap();
    for content_hash in [included_content_hash, variant_content_hash] {
        let entry = store.get(&content_hash).unwrap();
        assert_eq!(entry.status, MempoolStatus::Ready);
        assert_eq!(entry.included_block, None);
        assert_eq!(entry.superseded_block, None);
    }
}

#[test]
fn lifecycle_callbacks_reject_a_different_applied_head_or_rollback_height() {
    let dir = tempdir().unwrap();
    let (pool, _, _) = service(dir.path(), B256::repeat_byte(0x64));
    let head = pool.inner.lock().unwrap().head_id();
    let wrong_identity = BlockId {
        block_number: head.block_number,
        block_hash: B256::repeat_byte(0xfe),
    };
    assert!(matches!(
        pool.on_applied_block(wrong_identity, &[], &[]),
        Err(MempoolApiError::Invalid(_))
    ));

    let dir = tempdir().unwrap();
    let (service, _, _) = service(dir.path(), B256::repeat_byte(0x65));
    let head = service.inner.lock().unwrap().head_id();
    assert!(matches!(
        service.on_rollback(head.block_number + 1),
        Err(MempoolApiError::Invalid(_))
    ));
}

fn creation_signing_key() -> k256::ecdsa::SigningKey {
    k256::ecdsa::SigningKey::from_slice(&[0x31; 32]).unwrap()
}

/// The account [`signed_creation`] recovers to.
fn creation_signer() -> Address {
    let point = creation_signing_key()
        .verifying_key()
        .to_encoded_point(false);
    Address::from_slice(&keccak256(&point.as_bytes()[1..]).as_slice()[12..])
}

/// A creation signed by [`creation_signing_key`], anchored at the service's
/// head. `rule_set` varies the signed payload.
fn signed_creation(service: &MempoolService, rule_set: u64) -> Vec<u8> {
    let recent = service
        .inner
        .lock()
        .unwrap()
        .state
        .canonical_tip()
        .unwrap()
        .hash;
    let mut creation = UserAccountCreation::new(
        word(1),
        word(rule_set),
        None,
        recent,
        2_000,
        AccountCreationAuthorization::DirectL1,
    );
    let digest = pcash_derive::eip712::account_signing_hash(&creation, &service.source);
    let (signature, recovery_id) = creation_signing_key()
        .sign_prehash_recoverable(digest.as_slice())
        .unwrap();
    creation.authorization = AccountCreationAuthorization::Eip712 {
        sig_r: B256::from_slice(&signature.r().to_bytes()),
        sig_s: B256::from_slice(&signature.s().to_bytes()),
        y_parity: recovery_id.is_y_odd(),
    };
    Transaction::UserAccountCreation(creation)
        .encode(crate::PCASH_CHAIN_ID)
        .unwrap()
}

#[test]
fn signed_creations_by_one_key_compete_for_its_account() {
    let dir = tempdir().unwrap();
    let genesis_block_hash =
        b256!("0xaa00000000000000000000000000000000000000000000000000000000000064");
    let (service, _, _) = service(dir.path(), genesis_block_hash);
    let signer = creation_signer();
    let included_raw = signed_creation(&service, 0x61);
    let competing_raw = signed_creation(&service, 0x62);
    let included = descriptor(&included_raw, &service.source).unwrap();
    let competing = descriptor(&competing_raw, &service.source).unwrap();
    assert_ne!(included.statement_id, competing.statement_id);
    for description in [&included, &competing] {
        assert_eq!(description.stable_id, StableId::Account(signer));
        assert_eq!(
            description.conflict_keys,
            vec![ConflictKey::Account(signer)]
        );
    }

    let included_content_hash = admit(&service, included_raw.clone(), AdmissionSource::Rpc)
        .unwrap()
        .content_hash;
    let competing_content_hash = admit(&service, competing_raw, AdmissionSource::Rpc)
        .unwrap()
        .content_hash;
    for content_hash in [included_content_hash, competing_content_hash] {
        assert_eq!(
            service
                .transaction(&content_hash)
                .unwrap()
                .unwrap()
                .conflict_count,
            1
        );
    }

    let outcome = service
        .inner
        .lock()
        .unwrap()
        .apply_block(
            &l1_block(
                101,
                B256::repeat_byte(0xbb),
                genesis_block_hash,
                1_001,
                Some(included_raw.clone()),
            ),
            &AlreadyVerified,
        )
        .unwrap();
    assert_eq!(
        transaction_outcomes(&outcome),
        [TransactionOutcome::Succeeded]
    );
    assert!(service
        .inner
        .lock()
        .unwrap()
        .state
        .account_of(signer)
        .unwrap()
        .is_some());
    let head = service.inner.lock().unwrap().head_id();
    let (hashes, effects) = accepted_block_inputs(&outcome);
    service.on_applied_block(head, &hashes, &effects).unwrap();
    let store = service.store.lock().unwrap();
    assert_eq!(
        store.get(&included_content_hash).unwrap().status,
        MempoolStatus::IncludedUnfinalized
    );
    let competing = store.get(&competing_content_hash).unwrap();
    assert_eq!(competing.status, MempoolStatus::Suspended);
    assert_eq!(competing.superseded_block, Some(head));
    assert_eq!(competing.invalidated_block, None);
}

#[test]
fn direct_l1_creation_revalidates_signed_alternatives_and_finalizes_marker() {
    let dir = tempdir().unwrap();
    let genesis_block_hash =
        b256!("0xaa00000000000000000000000000000000000000000000000000000000000064");
    let block_hash = b256!("0xbb00000000000000000000000000000000000000000000000000000000000065");
    let (service, _, _) = service(dir.path(), genesis_block_hash);
    let signer = creation_signer();
    let pending_raw = signed_creation(&service, 0x61);
    let pending_content_hash = admit(&service, pending_raw, AdmissionSource::Rpc)
        .unwrap()
        .content_hash;
    let recent = service
        .inner
        .lock()
        .unwrap()
        .state
        .canonical_tip()
        .unwrap()
        .hash;
    let direct_raw = Transaction::UserAccountCreation(UserAccountCreation::new(
        word(2),
        word(0x62),
        None,
        recent,
        2_000,
        AccountCreationAuthorization::DirectL1,
    ))
    .encode(crate::PCASH_CHAIN_ID)
    .unwrap();

    let apply_direct = || {
        let mut block = l1_block(
            101,
            block_hash,
            genesis_block_hash,
            1_001,
            Some(direct_raw.clone()),
        );
        block.txs[0].0.from = signer;
        let outcome = service
            .inner
            .lock()
            .unwrap()
            .apply_block(&block, &AlreadyVerified)
            .unwrap();
        assert_eq!(
            transaction_outcomes(&outcome),
            [TransactionOutcome::Succeeded]
        );
        let head = service.inner.lock().unwrap().head_id();
        let (hashes, effects) = accepted_block_inputs(&outcome);
        assert_eq!(hashes, [pcash_state::content_hash(&direct_raw)]);
        assert!(effects.is_empty());
        service.on_applied_block(head, &hashes, &effects).unwrap();
    };

    apply_direct();
    {
        let store = service.store.lock().unwrap();
        let pending = store.get(&pending_content_hash).unwrap();
        assert_eq!(pending.status, MempoolStatus::Suspended);
        assert_eq!(pending.superseded_block, None);
        assert_eq!(pending.invalidated_block.unwrap().block_number, 1);
    }

    service.inner.lock().unwrap().rollback_to(100).unwrap();
    service.on_rollback(0).unwrap();
    assert_eq!(
        service
            .store
            .lock()
            .unwrap()
            .get(&pending_content_hash)
            .unwrap()
            .status,
        MempoolStatus::Ready
    );

    apply_direct();
    service.on_finalized(1, 1_001).unwrap();
    assert!(service
        .store
        .lock()
        .unwrap()
        .get(&pending_content_hash)
        .is_none());
}

#[test]
fn creation_signature_that_does_not_recover_is_refused() {
    // secp256k1 group order.
    const N: U256 = U256::from_be_bytes(alloy_primitives::hex!(
        "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"
    ));
    let dir = tempdir().unwrap();
    let (service, _, _) = service(dir.path(), B256::repeat_byte(0x63));
    let Ok(Transaction::UserAccountCreation(signed)) =
        Transaction::decode(&signed_creation(&service, 0x61), crate::PCASH_CHAIN_ID)
    else {
        panic!("a signed creation");
    };
    let AccountCreationAuthorization::Eip712 {
        sig_r,
        sig_s,
        y_parity,
    } = signed.authorization
    else {
        panic!("a signed creation");
    };
    let high_s = B256::from(N - U256::from_be_bytes(sig_s.0));
    for (sig_s, y_parity) in [(B256::ZERO, y_parity), (high_s, !y_parity)] {
        let mut altered = signed.clone();
        altered.authorization = AccountCreationAuthorization::Eip712 {
            sig_r,
            sig_s,
            y_parity,
        };
        let raw = Transaction::UserAccountCreation(altered)
            .encode(crate::PCASH_CHAIN_ID)
            .unwrap();
        assert!(matches!(
            descriptor(&raw, &service.source),
            Err(MempoolApiError::Invalid(_))
        ));
        assert!(matches!(
            admit(&service, raw, AdmissionSource::Rpc),
            Err(MempoolApiError::State(outcome)) if outcome == "InvalidAccountSignature"
        ));
    }
    assert!(service.store.lock().unwrap().entries.is_empty());
}

#[test]
fn ordinary_state_invalidation_is_marked_and_rollback_resurrects() {
    let dir = tempdir().unwrap();
    let genesis_block_hash =
        b256!("0xaa00000000000000000000000000000000000000000000000000000000000064");
    let block_101_hash =
        b256!("0xbb00000000000000000000000000000000000000000000000000000000000065");
    let block_102_hash =
        b256!("0xcc00000000000000000000000000000000000000000000000000000000000066");
    let (service, _, _) = service(dir.path(), genesis_block_hash);
    let (recent_pcash_block_hash, head) = {
        let guard = service.inner.lock().unwrap();
        (guard.state.canonical_tip().unwrap().hash, guard.head_id())
    };
    let deadline = 1_000 + RECENT_PCASH_BLOCK_WINDOW_SECONDS + 1_000;
    let pending_raw = transfer_raw(recent_pcash_block_hash, &[1], deadline);
    let pending_content_hash = pcash_state::content_hash(&pending_raw);
    let mut winner_raw = transfer_raw(recent_pcash_block_hash, &[2], deadline);
    for (input, value) in [(2usize, 30u64), (3, 40), (4, 50), (5, 60), (18, 70)] {
        let start = private_value_wire_input_offset(input);
        winner_raw[start..start + 32].copy_from_slice(word(value).as_slice());
    }
    service
        .store
        .lock()
        .unwrap()
        .insert(stored_with_description(pending_raw, head))
        .unwrap();

    let outcome = {
        let mut guard = service.inner.lock().unwrap();
        let outcome = guard
            .apply_block(
                &l1_block(
                    101,
                    block_101_hash,
                    genesis_block_hash,
                    1_001,
                    Some(winner_raw.clone()),
                ),
                &AlreadyVerified,
            )
            .unwrap();
        assert_eq!(
            transaction_outcomes(&outcome),
            [TransactionOutcome::Succeeded]
        );
        outcome
    };
    let block_101 = service.inner.lock().unwrap().head_id();
    let (hashes, effects) = accepted_block_inputs(&outcome);
    service
        .on_applied_block(block_101, &hashes, &effects)
        .unwrap();
    assert_eq!(
        service
            .store
            .lock()
            .unwrap()
            .get(&pending_content_hash)
            .unwrap()
            .status,
        MempoolStatus::Ready
    );

    let outcome = {
        let mut guard = service.inner.lock().unwrap();
        guard
            .apply_block(
                &l1_block(
                    102,
                    block_102_hash,
                    block_101_hash,
                    1_001 + RECENT_PCASH_BLOCK_WINDOW_SECONDS + 1,
                    None,
                ),
                &AlreadyVerified,
            )
            .unwrap()
    };
    let block_102 = service.inner.lock().unwrap().head_id();
    let (hashes, effects) = accepted_block_inputs(&outcome);
    service
        .on_applied_block(block_102, &hashes, &effects)
        .unwrap();
    {
        let store = service.store.lock().unwrap();
        let pending = store.get(&pending_content_hash).unwrap();
        assert_eq!(pending.status, MempoolStatus::Suspended);
        assert_eq!(pending.invalidated_block, Some(block_102));
    }

    service.inner.lock().unwrap().rollback_to(101).unwrap();
    service.on_rollback(1).unwrap();
    let pending = service
        .store
        .lock()
        .unwrap()
        .get(&pending_content_hash)
        .unwrap()
        .clone();
    assert_eq!(pending.status, MempoolStatus::Ready);
    assert_eq!(pending.invalidated_block, None);
}

/// `NotYetValid` is the one transient suspension: unlike ordinary state
/// invalidation it is not monotonic, because a later block's timestamp
/// brings the entry back. Marking it would strand the entry — the marker
/// stays canonical as the replacement chain advances past
/// `notBeforeTimestamp`, and a marked entry is never re-evaluated.
#[test]
fn not_yet_valid_is_transient_and_recovers_when_the_head_reaches_the_lower_bound() {
    let dir = tempdir().unwrap();
    let genesis_block_hash =
        b256!("0xaa00000000000000000000000000000000000000000000000000000000000064");
    let block_101_hash =
        b256!("0xbb00000000000000000000000000000000000000000000000000000000000065");
    let block_102_hash =
        b256!("0xcc00000000000000000000000000000000000000000000000000000000000066");
    let (service, _, _) = service(dir.path(), genesis_block_hash);
    let (recent_pcash_block_hash, head) = {
        let guard = service.inner.lock().unwrap();
        (guard.state.canonical_tip().unwrap().hash, guard.head_id())
    };

    // Admissible at the current head, with a lower bound the head has
    // already passed.
    let not_before = 1_001;
    let deadline = 1_000 + RECENT_PCASH_BLOCK_WINDOW_SECONDS + 1_000;
    let pending_raw = transfer_raw_timed(recent_pcash_block_hash, &[1], not_before, deadline);
    let pending_content_hash = pcash_state::content_hash(&pending_raw);
    service
        .store
        .lock()
        .unwrap()
        .insert(stored_with_description(pending_raw, head))
        .unwrap();

    let outcome = {
        let mut guard = service.inner.lock().unwrap();
        guard
            .apply_block(
                &l1_block(101, block_101_hash, genesis_block_hash, not_before, None),
                &AlreadyVerified,
            )
            .unwrap()
    };
    let block_101 = service.inner.lock().unwrap().head_id();
    let (hashes, effects) = accepted_block_inputs(&outcome);
    service
        .on_applied_block(block_101, &hashes, &effects)
        .unwrap();
    assert_eq!(
        service
            .store
            .lock()
            .unwrap()
            .get(&pending_content_hash)
            .unwrap()
            .status,
        MempoolStatus::Ready
    );

    // Roll the head back below the lower bound. The entry suspends, but
    // WITHOUT a marker, so later blocks still reconsider it.
    service.inner.lock().unwrap().rollback_to(100).unwrap();
    service.on_rollback(0).unwrap();
    {
        let store = service.store.lock().unwrap();
        let pending = store.get(&pending_content_hash).unwrap();
        assert_eq!(pending.status, MempoolStatus::Suspended);
        assert_eq!(pending.invalidated_block, None);
    }

    // The replacement chain reaches the lower bound: Ready again.
    let outcome = {
        let mut guard = service.inner.lock().unwrap();
        guard
            .apply_block(
                &l1_block(101, block_102_hash, genesis_block_hash, not_before, None),
                &AlreadyVerified,
            )
            .unwrap()
    };
    let replacement = service.inner.lock().unwrap().head_id();
    let (hashes, effects) = accepted_block_inputs(&outcome);
    service
        .on_applied_block(replacement, &hashes, &effects)
        .unwrap();
    let pending = service
        .store
        .lock()
        .unwrap()
        .get(&pending_content_hash)
        .unwrap()
        .clone();
    assert_eq!(pending.status, MempoolStatus::Ready);
    assert_eq!(pending.invalidated_block, None);
}

#[test]
fn finalization_purges_only_final_facts_and_past_deadlines() {
    let dir = tempdir().unwrap();
    let genesis_block_hash =
        b256!("0xaa00000000000000000000000000000000000000000000000000000000000064");
    let (service, path, genesis_hash) = service(dir.path(), genesis_block_hash);
    let row = |proof_byte| stored(transfer_raw(B256::ZERO, &[proof_byte], 2_000), 1);
    let mut included = row(1);
    included.included_block = Some(BlockId {
        block_number: 5,
        block_hash: B256::repeat_byte(5),
    });
    included.metadata.valid_until_timestamp = None;
    let included_content_hash = included.content_hash;
    let mut superseded_later = row(2);
    superseded_later.status = MempoolStatus::Suspended;
    superseded_later.superseded_block = Some(BlockId {
        block_number: 6,
        block_hash: B256::repeat_byte(6),
    });
    superseded_later.metadata.valid_until_timestamp = None;
    let superseded_later_content_hash = superseded_later.content_hash;
    let mut expired = row(3);
    expired.metadata.valid_until_timestamp = Some(10);
    let expired_content_hash = expired.content_hash;
    let mut deadline_equal = row(4);
    deadline_equal.metadata.valid_until_timestamp = Some(11);
    let deadline_equal_content_hash = deadline_equal.content_hash;
    let mut invalidated = row(5);
    invalidated.status = MempoolStatus::Suspended;
    invalidated.invalidated_block = Some(BlockId {
        block_number: 5,
        block_hash: B256::repeat_byte(5),
    });
    invalidated.metadata.valid_until_timestamp = Some(u64::MAX);
    let invalidated_content_hash = invalidated.content_hash;
    {
        let mut store = service.store.lock().unwrap();
        for entry in [
            included,
            superseded_later,
            expired,
            deadline_equal,
            invalidated,
        ] {
            store.insert(entry).unwrap();
        }
    }

    service.on_finalized(5, 11).unwrap();
    {
        let store = service.store.lock().unwrap();
        assert!(store.get(&included_content_hash).is_none());
        assert!(store.get(&expired_content_hash).is_none());
        assert!(store.get(&invalidated_content_hash).is_none());
        assert!(store.get(&superseded_later_content_hash).is_some());
        assert!(store.get(&deadline_equal_content_hash).is_some());
    }
    drop(service);
    let reopened = MempoolStore::open(
        path,
        crate::PCASH_CHAIN_ID,
        genesis_hash,
        MempoolLimits {
            accept_unpaid_registration: true,
            ..MempoolLimits::default()
        },
    )
    .unwrap();
    assert!(reopened.get(&included_content_hash).is_none());
    assert!(reopened.get(&expired_content_hash).is_none());
    assert!(reopened.get(&invalidated_content_hash).is_none());
    assert!(reopened.get(&superseded_later_content_hash).is_some());
    assert!(reopened.get(&deadline_equal_content_hash).is_some());
}

#[test]
fn full_admission_queue_is_busy_and_peers_keep_a_share() {
    let dir = tempdir().unwrap();
    let (service, _, _) = service(dir.path(), B256::repeat_byte(0x64));
    // One worker with room for two waiting admissions, of which peers may hold one.
    let service = Arc::new(MempoolService {
        admission: AdmissionPool::new(
            vec![BbProcessVerifier::new(dir.path().join("unused-bb"))],
            2,
        )
        .unwrap(),
        ..service
    });

    // Admission starts under the node lock, so holding it stalls the worker on
    // the first job it takes.
    let node = service.inner.lock().unwrap();
    let first_peer = service.enqueue(vec![1], AdmissionSource::P2p).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while service.admission.queued() > 0 {
        assert!(
            std::time::Instant::now() < deadline,
            "worker never took the job"
        );
        std::thread::yield_now();
    }

    assert!(matches!(
        service.enqueue(vec![2], AdmissionSource::P2p),
        Err(MempoolApiError::Busy(_))
    ));
    let rpc = [
        service.enqueue(vec![3], AdmissionSource::Rpc).unwrap(),
        service.enqueue(vec![4], AdmissionSource::Rpc).unwrap(),
    ];
    assert_eq!(service.admission.queued(), 2);
    assert!(matches!(
        service.enqueue(vec![5], AdmissionSource::Rpc),
        Err(MempoolApiError::Busy(_))
    ));

    drop(node);
    // A finished peer admission frees its share before its caller hears back.
    // Queue room frees only once the worker takes the next job, so wait for it.
    first_peer.blocking_recv().unwrap().unwrap_err();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while service.admission.queued() > 1 {
        assert!(
            std::time::Instant::now() < deadline,
            "worker never took the next job"
        );
        std::thread::yield_now();
    }
    let next_peer = service.enqueue(vec![6], AdmissionSource::P2p).unwrap();
    for reply in rpc {
        reply.blocking_recv().unwrap().unwrap_err();
    }
    next_peer.blocking_recv().unwrap().unwrap_err();
}

#[test]
fn open_reconciles_a_committed_block_before_exposing_inventory() {
    let dir = tempdir().unwrap();
    let genesis_block_hash =
        b256!("0xaa00000000000000000000000000000000000000000000000000000000000064");
    let block_hash = b256!("0xbb00000000000000000000000000000000000000000000000000000000000065");
    let (service, path, _) = service(dir.path(), genesis_block_hash);
    {
        let mut guard = service.inner.lock().unwrap();
        guard.prune_finalized(100).unwrap();
    }
    let (recent_pcash_block_hash, pre_block_head) = {
        let guard = service.inner.lock().unwrap();
        (guard.state.canonical_tip().unwrap().hash, guard.head_id())
    };
    let included_raw = transfer_raw(recent_pcash_block_hash, &[1], 2_000);
    let variant_raw = transfer_raw(recent_pcash_block_hash, &[2], 2_000);
    let included_content_hash = pcash_state::content_hash(&included_raw);
    let variant_content_hash = pcash_state::content_hash(&variant_raw);
    {
        let mut store = service.store.lock().unwrap();
        store
            .insert(stored_with_description(
                included_raw.clone(),
                pre_block_head,
            ))
            .unwrap();
        store
            .insert(stored_with_description(variant_raw, pre_block_head))
            .unwrap();
    }
    {
        let mut guard = service.inner.lock().unwrap();
        guard
            .apply_block(
                &l1_block(
                    101,
                    block_hash,
                    genesis_block_hash,
                    1_001,
                    Some(included_raw),
                ),
                &AlreadyVerified,
            )
            .unwrap();
    }
    let inner = service.inner.clone();
    drop(service);

    let reopened = MempoolService::open(
        inner.clone(),
        &path,
        unused_admission(dir.path()),
        MempoolLimits {
            accept_unpaid_registration: true,
            ..MempoolLimits::default()
        },
    )
    .unwrap();
    assert!(reopened.ready_inventory().is_empty());
    {
        let store = reopened.store.lock().unwrap();
        assert_eq!(
            store.get(&included_content_hash).unwrap().status,
            MempoolStatus::IncludedUnfinalized
        );
        assert_eq!(
            store.get(&variant_content_hash).unwrap().status,
            MempoolStatus::Suspended
        );
    }

    drop(reopened);
    inner.lock().unwrap().prune_finalized(101).unwrap();
    let finalized_reopen = MempoolService::open(
        inner,
        path,
        unused_admission(dir.path()),
        MempoolLimits {
            accept_unpaid_registration: true,
            ..MempoolLimits::default()
        },
    )
    .unwrap();
    assert!(finalized_reopen
        .store
        .lock()
        .unwrap()
        .get(&included_content_hash)
        .is_none());
}

#[test]
fn open_preserves_suffix_dependent_entry_until_catchup_replays_its_validation_head() {
    let dir = tempdir().unwrap();
    let genesis_block_hash =
        b256!("0xaa00000000000000000000000000000000000000000000000000000000000064");
    let block_hash = b256!("0xbb00000000000000000000000000000000000000000000000000000000000065");
    let (service, path, _) = service(dir.path(), genesis_block_hash);
    {
        let mut guard = service.inner.lock().unwrap();
        guard.prune_finalized(100).unwrap();
    }
    let creation_raw = {
        let guard = service.inner.lock().unwrap();
        transfer_raw(guard.state.canonical_tip().unwrap().hash, &[1], 3_000)
    };
    {
        let mut guard = service.inner.lock().unwrap();
        let outcome = guard
            .apply_block(
                &l1_block(
                    101,
                    block_hash,
                    genesis_block_hash,
                    1_001,
                    Some(creation_raw.clone()),
                ),
                &AlreadyVerified,
            )
            .unwrap();
        assert_eq!(
            transaction_outcomes(&outcome),
            [TransactionOutcome::Succeeded]
        );
    }
    let (mut pending_raw, validation_head) = {
        let guard = service.inner.lock().unwrap();
        (
            transfer_raw(guard.state.canonical_tip().unwrap().hash, &[2], 3_000),
            guard.head_id(),
        )
    };
    // Do not conflict with the transaction that created the referenced
    // recent PCASH block.
    for (input, value) in [(2usize, 30u64), (3, 40), (4, 50), (5, 60), (18, 70)] {
        let start = private_value_wire_input_offset(input);
        pending_raw[start..start + 32].copy_from_slice(word(value).as_slice());
    }
    let pending_content_hash = pcash_state::content_hash(&pending_raw);
    service
        .store
        .lock()
        .unwrap()
        .insert(stored_with_description(pending_raw, validation_head))
        .unwrap();

    // Resume restores the finalized checkpoint first. At this point the
    // pending entry's roots are not in state yet, but catch-up will restore
    // them by replaying block 101.
    service.inner.lock().unwrap().rollback_to(100).unwrap();
    let inner = service.inner.clone();
    drop(service);
    let reopened = MempoolService::open(
        inner.clone(),
        path,
        unused_admission(dir.path()),
        MempoolLimits {
            accept_unpaid_registration: true,
            ..MempoolLimits::default()
        },
    )
    .unwrap();
    assert!(matches!(
        *reopened.lifecycle.read().unwrap(),
        LifecycleState::AwaitingReplay { through: 1 }
    ));
    assert!(reopened
        .store
        .lock()
        .unwrap()
        .get(&pending_content_hash)
        .is_some());
    assert!(matches!(
        reopened.list(MempoolFilter::default()),
        Err(MempoolApiError::Unavailable)
    ));
    assert!(reopened.ready_inventory().is_empty());

    let outcome = {
        let mut guard = inner.lock().unwrap();
        guard
            .apply_block(
                &l1_block(
                    101,
                    block_hash,
                    genesis_block_hash,
                    1_001,
                    Some(creation_raw.clone()),
                ),
                &AlreadyVerified,
            )
            .unwrap()
    };
    let replayed_head = inner.lock().unwrap().head_id();
    let (hashes, effects) = accepted_block_inputs(&outcome);
    reopened
        .on_applied_block(replayed_head, &hashes, &effects)
        .unwrap();
    assert_eq!(*reopened.lifecycle.read().unwrap(), LifecycleState::Ready);
    assert_eq!(reopened.ready_inventory()[0].0, pending_content_hash);
}

#[test]
fn lifecycle_write_failure_hides_pool_until_full_reconciliation_repairs_markers() {
    let dir = tempdir().unwrap();
    let genesis_block_hash =
        b256!("0xaa00000000000000000000000000000000000000000000000000000000000064");
    let block_hash = b256!("0xbb00000000000000000000000000000000000000000000000000000000000065");
    let (service, _, _) = service(dir.path(), genesis_block_hash);
    let (raw, admission_head) = {
        let guard = service.inner.lock().unwrap();
        (
            transfer_raw(guard.state.canonical_tip().unwrap().hash, &[1], 3_000),
            guard.head_id(),
        )
    };
    let content_hash = pcash_state::content_hash(&raw);
    service
        .store
        .lock()
        .unwrap()
        .insert(stored_with_description(raw.clone(), admission_head))
        .unwrap();
    let outcome = {
        let mut guard = service.inner.lock().unwrap();
        guard
            .apply_block(
                &l1_block(
                    101,
                    block_hash,
                    genesis_block_hash,
                    1_001,
                    Some(raw.clone()),
                ),
                &AlreadyVerified,
            )
            .unwrap()
    };
    service.store.lock().unwrap().fail_next_lifecycle_write = true;
    let head = service.inner.lock().unwrap().head_id();
    let (hashes, effects) = accepted_block_inputs(&outcome);
    assert!(matches!(
        service.on_applied_block(head, &hashes, &effects),
        Err(MempoolApiError::Storage(_))
    ));
    assert_eq!(
        *service.lifecycle.read().unwrap(),
        LifecycleState::Unavailable
    );
    assert!(matches!(
        service.list(MempoolFilter::default()),
        Err(MempoolApiError::Unavailable)
    ));
    assert!(matches!(
        service.transaction(&content_hash),
        Err(MempoolApiError::Unavailable)
    ));
    assert!(matches!(
        admit(&service, vec![1], AdmissionSource::P2p),
        Err(MempoolApiError::Unavailable)
    ));
    assert!(matches!(
        service.prepare(PrepareRelayRequest {
            content_hashes: vec![content_hash],
            controlled_issuance_owner_commitments: Vec::new(),
            controlled_issuance_content_hashes: Vec::new(),
            max_batch_bytes: 1_000,
        }),
        Err(MempoolApiError::Unavailable)
    ));
    assert!(service.ready_inventory().is_empty());
    assert_eq!(
        service
            .store
            .lock()
            .unwrap()
            .get(&content_hash)
            .unwrap()
            .status,
        MempoolStatus::Ready,
        "failed write leaves an unmarked canonical inclusion"
    );

    // The next lifecycle callback performs a full receipt/state
    // reconciliation before reopening RPC/P2P.
    service.on_finalized(0, 1_000).unwrap();
    assert_eq!(
        service.transaction(&content_hash).unwrap().unwrap().status,
        "included_unfinalized"
    );

    // Exercise the inverse crash window too: rollback commits, clearing the
    // now-orphaned inclusion marker fails, and a later reconciliation must
    // clear that marker before reopening the pool.
    service.inner.lock().unwrap().rollback_to(100).unwrap();
    service.store.lock().unwrap().fail_next_lifecycle_write = true;
    assert!(matches!(
        service.on_rollback(0),
        Err(MempoolApiError::Storage(_))
    ));
    assert!(service.ready_inventory().is_empty());
    assert_eq!(
        service
            .store
            .lock()
            .unwrap()
            .get(&content_hash)
            .unwrap()
            .included_block,
        Some(head),
        "failed rollback write leaves an orphaned marker"
    );
    service.on_rollback(0).unwrap();
    let repaired = service
        .store
        .lock()
        .unwrap()
        .get(&content_hash)
        .unwrap()
        .clone();
    assert_eq!(repaired.status, MempoolStatus::Ready);
    assert_eq!(repaired.included_block, None);
    assert_eq!(service.ready_inventory()[0].0, content_hash);

    // Finalization writes use the same fail-closed latch. Advance beyond the
    // transaction deadline, publish that height as finalized, and verify a
    // failed purge cannot leave the stale entry exposed.
    let final_hash = b256!("0xcc00000000000000000000000000000000000000000000000000000000000065");
    {
        let mut guard = service.inner.lock().unwrap();
        guard
            .apply_block(
                &l1_block(101, final_hash, genesis_block_hash, 4_000, None),
                &AlreadyVerified,
            )
            .unwrap();
        guard.prune_finalized(101).unwrap();
    }
    service.store.lock().unwrap().fail_next_lifecycle_write = true;
    assert!(matches!(
        service.on_finalized(1, 4_000),
        Err(MempoolApiError::Storage(_))
    ));
    assert!(matches!(
        service.transaction(&content_hash),
        Err(MempoolApiError::Unavailable)
    ));
    service.on_finalized(1, 4_000).unwrap();
    assert!(service.transaction(&content_hash).unwrap().is_none());
}

#[test]
fn expired_account_does_not_permanently_hold_the_last_slot() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("mempool.redb");
    let limits = MempoolLimits {
        accept_unpaid_registration: true,
        max_entries: 1,
        max_bytes: 1024,
        max_unpaid_entries: 1,
    };
    let mut store = MempoolStore::open(&path, 1346589512, B256::repeat_byte(1), limits).unwrap();
    let mut account = stored(vec![1], 1);
    account.metadata.kind = TransactionKind::UserAccountCreation;
    account.metadata.open_fee_amount = U256::ZERO;
    account.metadata.valid_until_timestamp = None;
    account.received_at_unix_ms = now_unix_ms().saturating_sub(UNPAID_TTL_MS + 1);
    let account_content_hash = account.content_hash;
    store.insert(account).unwrap();
    let replacement = stored(vec![2], 1);
    let replacement_content_hash = replacement.content_hash;
    store.insert(replacement).unwrap();
    assert!(store.get(&account_content_hash).is_none());
    assert!(store.get(&replacement_content_hash).is_some());
}

#[test]
fn transport_and_rpc_size_limits_match_consensus() {
    // Transport/DoS ceilings track the largest valid compiled transaction,
    // not the 131,072 batch parse bound.
    assert_eq!(
        pcash_p2p::MAX_RELAYED_TX_BYTES,
        pcash_derive::MAX_VALID_TX_BYTES
    );
    assert_eq!(
        pcash_rpc::server::MAX_MEMPOOL_TX_BYTES,
        pcash_derive::MAX_VALID_TX_BYTES
    );
}

struct SuspensionRecorder {
    total: AtomicUsize,
    state: AtomicUsize,
}
impl Metrics for SuspensionRecorder {
    fn record_mempool_suspended(&self, cause: &'static str) {
        self.total.fetch_add(1, Ordering::Relaxed);
        if cause == "state" {
            self.state.fetch_add(1, Ordering::Relaxed);
        }
    }
}

#[test]
fn retained_transient_suspensions_are_counted_once_not_per_block() {
    let dir = tempdir().unwrap();
    let genesis_block_hash =
        b256!("0xaa00000000000000000000000000000000000000000000000000000000000064");
    let (mut service, _, _) = service(dir.path(), genesis_block_hash);
    let recorder = Arc::new(SuspensionRecorder {
        total: AtomicUsize::new(0),
        state: AtomicUsize::new(0),
    });
    service.metrics = recorder.clone();
    let (recent_pcash_block_hash, head) = {
        let guard = service.inner.lock().unwrap();
        (guard.state.canonical_tip().unwrap().hash, guard.head_id())
    };

    // Inserted directly (bypassing admission): not valid until ts 5_000,
    // far past every block applied here.
    let pending_raw = transfer_raw_timed(recent_pcash_block_hash, &[1], 5_000, 9_999);
    let pending_content_hash = pcash_state::content_hash(&pending_raw);
    service
        .store
        .lock()
        .unwrap()
        .insert(stored_with_description(pending_raw, head))
        .unwrap();

    let apply = |service: &MempoolService, number: u64, hash: B256, timestamp: u64| {
        let outcome = {
            let mut guard = service.inner.lock().unwrap();
            let parent = guard.head_id().block_hash;
            guard
                .apply_block(
                    &l1_block(number, hash, parent, timestamp, None),
                    &AlreadyVerified,
                )
                .unwrap()
        };
        let block = service.inner.lock().unwrap().head_id();
        let (hashes, effects) = accepted_block_inputs(&outcome);
        service.on_applied_block(block, &hashes, &effects).unwrap();
    };
    let state_suspensions = || recorder.state.load(Ordering::Relaxed);

    apply(
        &service,
        101,
        b256!("0xbb00000000000000000000000000000000000000000000000000000000000065"),
        1_012,
    );
    assert_eq!(
        service
            .store
            .lock()
            .unwrap()
            .get(&pending_content_hash)
            .unwrap()
            .status,
        MempoolStatus::Suspended
    );
    assert_eq!(state_suspensions(), 1, "first suspension counts once");

    // The entry stays transiently suspended with no marker: each later block
    // revalidates it, but no NEW suspension occurs, so none may be counted.
    apply(
        &service,
        102,
        b256!("0xcc00000000000000000000000000000000000000000000000000000000000066"),
        1_024,
    );
    apply(
        &service,
        103,
        b256!("0xdd00000000000000000000000000000000000000000000000000000000000067"),
        1_036,
    );
    assert_eq!(
        state_suspensions(),
        1,
        "retained suspensions must not recount"
    );
    assert_eq!(
        service
            .store
            .lock()
            .unwrap()
            .get(&pending_content_hash)
            .unwrap()
            .status,
        MempoolStatus::Suspended
    );
}

#[test]
fn listing_and_lookup_do_not_wait_for_the_derivation_mutex() {
    let dir = tempdir().unwrap();
    let (service, _, _) = service(dir.path(), B256::repeat_byte(1));
    let service = Arc::new(service);
    let guard = service.inner.lock().unwrap();
    let expected = guard.head_id();
    let reader = Arc::clone(&service);
    let (send, receive) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let page = reader.list(MempoolFilter::default()).unwrap();
        assert!(reader.transaction(&B256::repeat_byte(9)).unwrap().is_none());
        send.send(page).unwrap();
    });
    let result = receive.recv_timeout(std::time::Duration::from_secs(2));
    drop(guard);
    worker.join().unwrap();
    let page = result.expect("mempool reads waited for the derivation mutex");
    assert_eq!(page.head_checked_block, expected.block_number);
    assert_eq!(page.head_checked_block_hash, expected.block_hash);
}

#[test]
fn paying_entries_atomically_displace_oldest_zero_fee_bytes() {
    let limits = MempoolLimits {
        max_entries: 4,
        max_bytes: 8,
        max_unpaid_entries: 4,
        accept_unpaid_registration: true,
    };
    let mut store = MempoolStore::open_in_memory(1, B256::repeat_byte(1), limits).unwrap();
    let mut older = stored(vec![1; 3], 1);
    older.metadata.open_fee_amount = U256::ZERO;
    older.received_at_unix_ms = now_unix_ms();
    older.status = MempoolStatus::IncludedUnfinalized;
    let mut newer = stored(vec![2; 3], 1);
    newer.metadata.open_fee_amount = U256::ZERO;
    newer.received_at_unix_ms = older.received_at_unix_ms + 1;
    store.insert(older.clone()).unwrap();
    store.insert(newer.clone()).unwrap();
    let paid = stored(vec![3; 6], 1);
    store.fail_next_lifecycle_write = true;
    assert!(matches!(
        store.insert(paid.clone()),
        Err(MempoolApiError::Storage(_))
    ));
    assert_eq!(store.total_bytes, 6);
    assert!(store.get(&older.content_hash).is_some());
    assert!(store.get(&newer.content_hash).is_some());
    store.insert(paid.clone()).unwrap();
    assert_eq!(store.total_bytes, 6);
    assert_eq!(store.entries.len(), 1);
    assert!(store.get(&paid.content_hash).is_some());
}

#[test]
fn paying_candidates_displace_only_strictly_lower_fee_density() {
    let limits = MempoolLimits {
        max_entries: 2,
        max_bytes: 64,
        max_unpaid_entries: 1,
        accept_unpaid_registration: false,
    };
    let mut store = MempoolStore::open_in_memory(1, B256::repeat_byte(1), limits).unwrap();
    let mut low = stored(vec![0, 1, 1, 1], 1);
    low.metadata.open_fee_amount = U256::from(1u64);
    let mut mid = stored(vec![0, 2, 2, 2], 1);
    mid.metadata.open_fee_amount = U256::from(5u64);
    store.insert(low.clone()).unwrap();
    store.insert(mid.clone()).unwrap();

    // Equal density to the cheapest entry is not strictly better.
    let mut equal = stored(vec![0, 3, 3, 3], 1);
    equal.metadata.open_fee_amount = U256::from(1u64);
    assert!(matches!(store.insert(equal), Err(MempoolApiError::Full)));
    assert_eq!(store.entries.len(), 2);

    // Density, not the absolute fee, decides: 4 over 32 bytes is below 1 over 4.
    let mut large = stored(vec![0; 32], 1);
    large.metadata.open_fee_amount = U256::from(4u64);
    assert!(matches!(store.insert(large), Err(MempoolApiError::Full)));

    let mut better = stored(vec![0, 5, 5, 5], 1);
    better.metadata.open_fee_amount = U256::from(3u64);
    store.insert(better.clone()).unwrap();
    assert!(store.get(&low.content_hash).is_none());
    assert!(store.get(&mid.content_hash).is_some());
    assert!(store.get(&better.content_hash).is_some());
    assert_eq!(store.total_bytes, 8);
}

#[test]
fn zero_fee_candidates_cannot_churn_or_displace_paying_entries() {
    let limits = MempoolLimits {
        max_entries: 2,
        max_bytes: 8,
        max_unpaid_entries: 2,
        accept_unpaid_registration: true,
    };
    let mut store = MempoolStore::open_in_memory(1, B256::repeat_byte(1), limits).unwrap();
    let paid = stored(vec![1; 5], 1);
    let mut free = stored(vec![2; 3], 1);
    free.metadata.open_fee_amount = U256::ZERO;
    free.received_at_unix_ms = now_unix_ms();
    store.insert(paid.clone()).unwrap();
    store.insert(free.clone()).unwrap();
    // A paying candidate that cannot fit without displacing a denser paying
    // entry is refused, and the refusal evicts nothing.
    let mut cheap = stored(vec![3; 4], 1);
    cheap.metadata.open_fee_amount = U256::from(1u64);
    assert!(matches!(store.insert(cheap), Err(MempoolApiError::Full)));
    assert!(store.get(&free.content_hash).is_some());
    let mut incoming = free.clone();
    incoming.raw = vec![4];
    incoming.content_hash = pcash_state::content_hash(&incoming.raw);
    assert!(matches!(store.insert(incoming), Err(MempoolApiError::Full)));
    store.insert(free.clone()).unwrap();
    assert_eq!(store.total_bytes, 8);
    assert_eq!(
        store.get(&free.content_hash).unwrap().received_at_unix_ms,
        free.received_at_unix_ms
    );
}

#[test]
fn disabled_registration_policy_cleans_proof_free_entries_on_restart() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("pool.redb");
    let genesis = B256::repeat_byte(1);
    let signed_creation = Transaction::UserAccountCreation(UserAccountCreation::new(
        word(1),
        word(2),
        None,
        B256::ZERO,
        2_000,
        AccountCreationAuthorization::Eip712 {
            sig_r: B256::ZERO,
            sig_s: B256::ZERO,
            y_parity: false,
        },
    ))
    .encode(crate::PCASH_CHAIN_ID)
    .unwrap();
    let mut free = stored(signed_creation, 1);
    free.metadata.kind = TransactionKind::UserAccountCreation;
    free.metadata.open_fee_amount = U256::ZERO;
    free.metadata.has_publication_section = false;
    free.received_at_unix_ms = now_unix_ms();
    let paid = stored(transfer_raw(B256::ZERO, &[1], 2_000), 1);
    let mut contract = stored(unfunded_contract_creation(B256::ZERO, 2_000, 0x51), 1);
    contract.metadata.kind = TransactionKind::ContractAccountCreation;
    contract.metadata.open_fee_amount = U256::ZERO;
    contract.metadata.has_publication_section = false;
    contract.received_at_unix_ms = now_unix_ms();
    // A zero-fee attached creation is proof-bearing, not a registration.
    let mut sponsored = stored(
        attached_contract_creation(
            &unfunded_contract_creation(B256::ZERO, 2_000, 0x52),
            B256::ZERO,
            94,
        ),
        1,
    );
    sponsored.metadata.kind = TransactionKind::PrivateValue;
    sponsored.metadata.open_fee_amount = U256::ZERO;
    sponsored.received_at_unix_ms = now_unix_ms();
    {
        let mut store = MempoolStore::open(
            &path,
            crate::PCASH_CHAIN_ID,
            genesis,
            MempoolLimits {
                accept_unpaid_registration: true,
                ..MempoolLimits::default()
            },
        )
        .unwrap();
        store.insert(free.clone()).unwrap();
        store.insert(contract.clone()).unwrap();
        store.insert(sponsored.clone()).unwrap();
        store.insert(paid.clone()).unwrap();
    }
    let mut store = MempoolStore::open(
        &path,
        crate::PCASH_CHAIN_ID,
        genesis,
        MempoolLimits::default(),
    )
    .unwrap();
    assert!(store.get(&free.content_hash).is_none());
    assert!(store.get(&paid.content_hash).is_some());
    assert!(store.get(&contract.content_hash).is_none());
    assert!(!store.get(&sponsored.content_hash).unwrap().unpaid());
    assert_eq!(store.total_bytes, paid.raw.len() + sponsored.raw.len());
    assert!(matches!(
        store.insert(free),
        Err(MempoolApiError::Policy(_))
    ));
    assert!(matches!(
        store.insert(contract),
        Err(MempoolApiError::Policy(_))
    ));
}

#[test]
fn proof_bearing_zero_fee_account_actions_reach_validation_by_default() {
    let dir = tempdir().unwrap();
    let (service, _, _) = service(dir.path(), B256::repeat_byte(0x64));
    service
        .store
        .lock()
        .unwrap()
        .limits
        .accept_unpaid_registration = false;
    // This candidate has an unusable anchor and no real proof, but its
    // proof-bearing type is not rejected by the registration policy.
    let raw = unpaid_account_update(B256::ZERO, 1);
    service.check_admission_policy(&raw).unwrap();
    assert!(matches!(
        admit(&service, raw, AdmissionSource::P2p),
        Err(MempoolApiError::State(_))
    ));
}

/// A proof-bearing candidate that fails a check execution applies before any
/// state read has no statement to verify. Admission refuses it with its
/// execution outcome and never starts the verifier, which `admit` would run
/// from a binary that does not exist.
#[test]
fn proof_bearing_candidates_without_a_statement_are_refused_before_the_verifier() {
    use pcash_derive::private_value_profiles::S;
    let dir = tempdir().unwrap();
    let (service, _, _) = service(dir.path(), B256::repeat_byte(0x64));
    let recent = service
        .inner
        .lock()
        .unwrap()
        .state
        .canonical_tip()
        .unwrap()
        .hash;
    let not_in_field = CircuitWord::repeat_byte(0xff);

    let mut non_field_input = publication_section(recent, 1, 1, CircuitWord::ZERO);
    *non_field_input.public_input_mut(S.outputs_offset).unwrap() = not_in_field;
    let non_field_input = Transaction::PrivateValue(non_field_input)
        .encode(crate::PCASH_CHAIN_ID)
        .unwrap();

    let mut section = publication_section(recent, 2, 0, CircuitWord::ZERO);
    section
        .proof
        .resize(SectionLayout::UserAccountUpdate.proof_bytes(), 0);
    let non_canonical_rule_set = Transaction::UserAccountUpdate(UserAccountUpdate {
        address: Address::ZERO,
        new_rule_set_commitment: not_in_field,
        receive_key_update: ReceiveKeyUpdate::Keep,
        account_update_commitment: CircuitWord::ZERO,
        section,
    })
    .encode(crate::PCASH_CHAIN_ID)
    .unwrap();

    // `account_action` gives a attached creation no functions, which its
    // body's static check refuses.
    let invalid_body = account_action(
        pcash_derive::KIND_CONTRACT_ACCOUNT_CREATION,
        publication_section(recent, 3, 0, CircuitWord::ZERO),
    );

    for (raw, outcome) in [
        (non_field_input, "PublicInputNotInField"),
        (non_canonical_rule_set, "NonCanonicalAccountField"),
        (invalid_body, "EmptyContractFunctionSet"),
    ] {
        let refused = admit(&service, raw, AdmissionSource::P2p).map(|_| ());
        assert!(
            matches!(&refused, Err(MempoolApiError::State(name)) if name == outcome),
            "{outcome}: {refused:?}"
        );
    }
    assert!(service.store.lock().unwrap().entries.is_empty());
}

#[test]
fn proof_bearing_unpaid_capacity_is_bounded_without_enabling_registration() {
    let mut store = MempoolStore::open_in_memory(
        1,
        B256::repeat_byte(1),
        MempoolLimits {
            max_unpaid_entries: 1,
            ..MempoolLimits::default()
        },
    )
    .unwrap();
    let mut update = stored(vec![pcash_derive::KIND_USER_ACCOUNT_UPDATE, 1], 1);
    update.metadata.kind = TransactionKind::UserAccountUpdate;
    update.metadata.open_fee_amount = U256::ZERO;
    update.received_at_unix_ms = now_unix_ms();
    let mut contract = stored(vec![pcash_derive::KIND_USER_ACCOUNT_UPDATE, 2], 1);
    contract.metadata.kind = TransactionKind::UserAccountUpdate;
    contract.metadata.open_fee_amount = U256::ZERO;
    contract.received_at_unix_ms = update.received_at_unix_ms;
    store.insert(update).unwrap();
    assert!(matches!(store.insert(contract), Err(MempoolApiError::Full)));
    let mut unfunded = stored(vec![pcash_derive::KIND_CONTRACT_ACCOUNT_CREATION, 0], 1);
    unfunded.metadata.kind = TransactionKind::ContractAccountCreation;
    unfunded.metadata.open_fee_amount = U256::ZERO;
    assert!(matches!(
        store.insert(unfunded),
        Err(MempoolApiError::Policy(_))
    ));
    let mut registration = stored(vec![pcash_derive::KIND_USER_ACCOUNT_CREATION, 3], 1);
    registration.metadata.kind = TransactionKind::UserAccountCreation;
    registration.metadata.open_fee_amount = U256::ZERO;
    assert!(matches!(
        store.insert(registration),
        Err(MempoolApiError::Policy(_))
    ));
}

#[test]
fn rejected_paying_candidate_does_not_evict_retained_zero_fee_entry() {
    let dir = tempdir().unwrap();
    let (service, _, _) = service(dir.path(), B256::repeat_byte(0x64));
    let mut free = stored(vec![1], 1);
    free.metadata.open_fee_amount = U256::ZERO;
    free.received_at_unix_ms = now_unix_ms();
    {
        let mut store = service.store.lock().unwrap();
        store.limits.max_entries = 1;
        store.insert(free.clone()).unwrap();
    }
    let mut raw = transfer_raw(B256::ZERO, &[1], 2_000);
    // Serialized private-value fee follows the ten initial non-chain inputs.
    raw[326..358].copy_from_slice(word(1).as_slice());
    assert!(!descriptor(&raw, &test_source())
        .unwrap()
        .open_fee_amount
        .is_zero());
    assert!(admit(&service, raw, AdmissionSource::Rpc).is_err());
    assert!(service
        .store
        .lock()
        .unwrap()
        .get(&free.content_hash)
        .is_some());
}

#[test]
fn proof_bearing_account_sections_pass_zero_fee_peer_policy() {
    let dir = tempdir().unwrap();
    let (service, _, _) = service(dir.path(), B256::repeat_byte(0x65));
    service
        .store
        .lock()
        .unwrap()
        .limits
        .accept_unpaid_registration = false;
    for kind in [
        pcash_derive::KIND_USER_ACCOUNT_UPDATE,
        pcash_derive::KIND_CONTRACT_ACCOUNT_CREATION,
    ] {
        for fee in [0, 7] {
            let mut section = transfer_section(B256::ZERO, &[1], 0, 2_000);
            *section
                .public_input_mut(PrivateValueShape::S.profile().open_fee_amount_offset)
                .unwrap() = word(fee);
            service
                .check_admission_policy(&account_action(kind, section))
                .unwrap();
        }
    }
}

#[test]
fn l_descriptor_includes_all_conflicts_and_profile_fee_offsets() {
    use pcash_derive::private_value_profiles::L;
    let mut wire = vec![word(900)];
    wire.extend((0..L.inputs).map(|i| word(1_000 + i as u64)));
    wire.extend((0..L.outputs).map(|i| word(2_000 + i as u64)));
    // openFeeAmount, issuanceOwnerCommitment, notBefore, validUntil,
    // carrierContextHash, eventsCommitment.
    wire.extend([word(123), word(456), word(0), word(1_234), word(0), word(0)]);
    let raw = Transaction::PrivateValue(
        PrivateValueSection::new(
            PrivateValueShape::L,
            crate::PCASH_CHAIN_ID,
            &wire,
            vec![1; SectionLayout::PrivateValue(PrivateValueShape::L).proof_bytes()],
            vec![delivery_data(&[]); L.outputs],
            arena(PrivateValueShape::L),
        )
        .unwrap(),
    )
    .encode(crate::PCASH_CHAIN_ID)
    .unwrap();
    let described = descriptor(&raw, &test_source()).unwrap();
    assert_eq!(described.conflict_keys.len(), L.inputs);
    assert_eq!(
        described.conflict_keys.last(),
        Some(&ConflictKey::Nullifier(word(1_000 + L.inputs as u64 - 1)))
    );
    assert_eq!(described.open_fee_amount, U256::from(123));
    assert_eq!(described.issuance_owner_commitment, word(456));
    assert_eq!(described.valid_until_timestamp, Some(1_234));
    let proof_offset = 6 + L.wire_inputs * 32;
    let mut reproved = raw;
    reproved[proof_offset] = 2;
    assert_eq!(
        descriptor(&reproved, &test_source()).unwrap().statement_id,
        described.statement_id
    );
    reproved[5] = 2;
    assert!(descriptor(&reproved, &test_source()).is_err());
}

/// A distinct type `0x00` relay candidate with the given publication terms.
fn publication_transfer(recent: B256, salt: u64, fee: u64, owner: CircuitWord) -> Vec<u8> {
    Transaction::PrivateValue(publication_section(recent, salt, fee, owner))
        .encode(crate::PCASH_CHAIN_ID)
        .unwrap()
}

/// The S private-value section of [`publication_transfer`].
fn publication_section(
    recent: B256,
    salt: u64,
    fee: u64,
    owner: CircuitWord,
) -> PrivateValueSection {
    use pcash_derive::private_value_profiles::S;
    let mut section = transfer_section(recent, &[1], 0, 2_000);
    for slot in 0..S.inputs {
        *section
            .public_input_mut(S.nullifiers_offset + slot)
            .unwrap() = word(salt * 16 + slot as u64 + 1);
    }
    *section.public_input_mut(S.open_fee_amount_offset).unwrap() = word(fee);
    *section.public_input_mut(S.issuance_owner_offset).unwrap() = owner;
    section
}

/// `section` as the fee section of a type `kind` account action with zero
/// account fields, its proof resized to that type's.
fn account_action(kind: u8, mut section: PrivateValueSection) -> Vec<u8> {
    let transaction = if kind == pcash_derive::KIND_USER_ACCOUNT_UPDATE {
        section
            .proof
            .resize(SectionLayout::UserAccountUpdate.proof_bytes(), 0);
        Transaction::UserAccountUpdate(UserAccountUpdate {
            address: Address::ZERO,
            new_rule_set_commitment: CircuitWord::ZERO,
            receive_key_update: ReceiveKeyUpdate::Keep,
            account_update_commitment: CircuitWord::ZERO,
            section,
        })
    } else {
        section.proof.resize(
            SectionLayout::PrivateValue(PrivateValueShape::S).proof_bytes(),
            0,
        );
        Transaction::PrivateValue(
            (section)
                .with_account_creation(pcash_derive::AccountCreationAttachment::Contract(
                    ContractBody::new(false, CircuitWord::ZERO, None, Vec::new()).unwrap(),
                ))
                .unwrap(),
        )
    };
    transaction.encode(crate::PCASH_CHAIN_ID).unwrap()
}

/// A zero-fee user-account update over a distinct section. Account operations
/// earn no issuance, so it pays no public fee.
fn unpaid_account_update(recent: B256, salt: u64) -> Vec<u8> {
    account_action(
        pcash_derive::KIND_USER_ACCOUNT_UPDATE,
        publication_section(recent, salt, 0, CircuitWord::ZERO),
    )
}

#[test]
fn designated_zero_fee_private_value_remains_paying_in_the_public_pool() {
    let dir = tempdir().unwrap();
    let (service, _, _) = service(dir.path(), B256::repeat_byte(0x66));
    service
        .store
        .lock()
        .unwrap()
        .limits
        .accept_unpaid_registration = false;
    // Both type-0 issuance routes pass the public pool policy.
    let open = publication_transfer(B256::ZERO, 1, 0, CircuitWord::ZERO);
    let designated = publication_transfer(B256::ZERO, 2, 0, word(9));
    service.check_admission_policy(&open).unwrap();
    service.check_admission_policy(&designated).unwrap();
    for owner in [CircuitWord::ZERO, word(9)] {
        for kind in [
            pcash_derive::KIND_USER_ACCOUNT_UPDATE,
            pcash_derive::KIND_CONTRACT_ACCOUNT_CREATION,
        ] {
            // Account operations never earn issuance.
            let section = publication_section(B256::ZERO, 1, 0, owner);
            service
                .check_admission_policy(&account_action(kind, section))
                .unwrap();
        }
    }

    let head = service.inner.lock().unwrap().head_id();
    let open_entry = stored_with_description(open, head);
    let designated_entry = stored_with_description(designated, head);
    let account_entry = stored_with_description(unpaid_account_update(B256::ZERO, 3), head);
    assert!(!open_entry.unpaid());
    assert!(!designated_entry.unpaid());
    assert!(account_entry.unpaid());
    let mut store = service.store.lock().unwrap();
    store.insert(open_entry.clone()).unwrap();
    store.insert(designated_entry.clone()).unwrap();
    store.insert(account_entry).unwrap();
    let open_dto = store
        .get(&open_entry.content_hash)
        .unwrap()
        .to_dto(false, 0);
    assert_eq!(open_dto.issuance_route, pcash_rpc::IssuanceRoute::Open);
    assert_eq!(open_dto.issuance_owner_commitment, B256::ZERO);
    let designated_dto = store
        .get(&designated_entry.content_hash)
        .unwrap()
        .to_dto(false, 0);
    assert_eq!(
        designated_dto.issuance_route,
        pcash_rpc::IssuanceRoute::Designated
    );
    assert_eq!(store.occupancy().unpaid_entries, 1);
}

/// A section that requires a carrier context succeeds only when that carrier
/// delivers it, so that carrier posts it and the pool's policy refuses it,
/// from RPC and peers alike, for every type that carries a section, before
/// any state or proof work. Peer bytes are refused by their shape, before
/// they take a proof budget. The same section without the condition is
/// admitted.
#[test]
fn sections_that_require_a_carrier_context_are_not_relayed() {
    use pcash_derive::private_value_profiles::S;
    let dir = tempdir().unwrap();
    let (service, _, _) = service(dir.path(), B256::repeat_byte(0x67));
    let recent = service
        .inner
        .lock()
        .unwrap()
        .state
        .canonical_tip()
        .unwrap()
        .hash;
    let requiring = |salt: u64| {
        let mut section = publication_section(recent, salt, 7, CircuitWord::ZERO);
        *section
            .public_input_mut(S.carrier_context_hash_offset)
            .unwrap() = word(0xcc);
        section
    };
    let candidates = [
        Transaction::PrivateValue(requiring(1))
            .encode(crate::PCASH_CHAIN_ID)
            .unwrap(),
        account_action(pcash_derive::KIND_USER_ACCOUNT_UPDATE, requiring(2)),
        account_action(pcash_derive::KIND_CONTRACT_ACCOUNT_CREATION, requiring(3)),
    ];
    let carrier_bound = |error: &MempoolApiError| matches!(error, MempoolApiError::Policy(message) if message.contains("requires a carrier context"));
    for raw in candidates {
        for source in [AdmissionSource::Rpc, AdmissionSource::P2p] {
            // State checks would refuse the account actions, and the unused
            // verifier would fail the transfer, if the policy came later.
            let refused = admit(&service, raw.clone(), source).unwrap_err();
            assert!(carrier_bound(&refused), "{refused:?}");
        }
        let refused = service.check_admission_policy(&raw).unwrap_err();
        assert!(carrier_bound(&refused), "{refused:?}");
        assert!(service
            .store
            .lock()
            .unwrap()
            .get(&pcash_state::content_hash(&raw))
            .is_none());
    }

    let unconditional =
        Transaction::PrivateValue(publication_section(recent, 1, 7, CircuitWord::ZERO))
            .encode(crate::PCASH_CHAIN_ID)
            .unwrap();
    assert_eq!(
        service
            .admit_and_record(unconditional, AdmissionSource::Rpc, &AlreadyVerified)
            .unwrap()
            .open_fee_amount,
        U256::from(7u64)
    );
}

#[test]
fn paying_candidates_evict_unpaid_entries_before_lower_fee_density() {
    let limits = MempoolLimits {
        max_entries: 2,
        max_bytes: 1 << 20,
        max_unpaid_entries: 2,
        accept_unpaid_registration: true,
    };
    let mut store = MempoolStore::open_in_memory(1, B256::repeat_byte(1), limits).unwrap();
    let head = BlockId {
        block_number: 1,
        block_hash: B256::repeat_byte(4),
    };
    let open = stored_with_description(
        publication_transfer(B256::ZERO, 1, 0, CircuitWord::ZERO),
        head,
    );
    let mut unpaid = stored_with_description(unpaid_account_update(B256::ZERO, 2), head);
    unpaid.received_at_unix_ms = now_unix_ms();
    store.insert(open.clone()).unwrap();
    store.insert(unpaid.clone()).unwrap();
    let paying = stored_with_description(
        publication_transfer(B256::ZERO, 3, 5, CircuitWord::ZERO),
        head,
    );
    store.insert(paying.clone()).unwrap();
    assert!(store.get(&unpaid.content_hash).is_none());
    assert!(store.get(&open.content_hash).is_some());
    assert!(store.get(&paying.content_hash).is_some());
    // With no unpaid entry left to displace, the pool is full even for a
    // zero-fee open type 0x00 action.
    assert!(matches!(
        store.insert(stored_with_description(
            publication_transfer(B256::ZERO, 4, 0, CircuitWord::ZERO),
            head,
        )),
        Err(MempoolApiError::Full)
    ));
    // The pool does not price issuance, so a zero-fee type 0x00 entry ranks
    // at density zero below any positive explicit fee.
    let tipped = stored_with_description(
        publication_transfer(B256::ZERO, 5, 1, CircuitWord::ZERO),
        head,
    );
    store.insert(tipped.clone()).unwrap();
    assert!(store.get(&open.content_hash).is_none());
    assert!(store.get(&paying.content_hash).is_some());
    assert!(store.get(&tipped.content_hash).is_some());
}

#[test]
fn prepare_counts_static_and_exact_dynamic_issuance_control() {
    let dir = tempdir().unwrap();
    let (service, _, _) = service(dir.path(), B256::repeat_byte(0x67));
    let (recent, head) = {
        let guard = service.inner.lock().unwrap();
        (guard.state.canonical_tip().unwrap().hash, guard.head_id())
    };
    let controlled = word(0xc0);
    service
        .store
        .lock()
        .unwrap()
        .limits
        .accept_unpaid_registration = true;
    let candidates = [
        publication_transfer(recent, 1, 5, CircuitWord::ZERO),
        publication_transfer(recent, 2, 0, CircuitWord::ZERO),
        publication_transfer(recent, 3, 0, controlled),
        publication_transfer(recent, 4, 0, word(0xd0)),
        publication_transfer(recent, 5, 0, word(0xd0)),
    ];
    let mut content_hashes = Vec::new();
    {
        let mut store = service.store.lock().unwrap();
        for raw in &candidates {
            let entry = stored_with_description(raw.clone(), head);
            content_hashes.push(entry.content_hash);
            store.insert(entry).unwrap();
        }
    }
    let dynamic_hash = content_hashes[3];
    let prepared = service
        .prepare(PrepareRelayRequest {
            content_hashes,
            controlled_issuance_owner_commitments: vec![controlled],
            controlled_issuance_content_hashes: vec![dynamic_hash],
            max_batch_bytes: 1 << 20,
        })
        .unwrap();
    assert!(prepared.rejected.is_empty(), "{:?}", prepared.rejected);
    assert_eq!(prepared.selected_content_hashes.len(), candidates.len());
    assert_eq!(prepared.collectible_open_fee, U256::from(5u64));
    assert_eq!(prepared.collectible_qualifying_actions, 4);
    assert_eq!(prepared.selected_qualifying_actions, 5);
}

#[test]
fn prepare_reports_state_read_failure_as_storage() {
    let dir = tempdir().unwrap();
    let (service, _, _) = service(dir.path(), B256::repeat_byte(0x68));
    let (recent, head) = {
        let guard = service.inner.lock().unwrap();
        (guard.state.canonical_tip().unwrap().hash, guard.head_id())
    };
    let entry =
        stored_with_description(publication_transfer(recent, 1, 5, CircuitWord::ZERO), head);
    let content_hash = entry.content_hash;
    service.store.lock().unwrap().insert(entry).unwrap();
    service
        .inner
        .lock()
        .unwrap()
        .state
        .fail_next_state_db_read();

    assert!(matches!(
        service.prepare(PrepareRelayRequest {
            content_hashes: vec![content_hash],
            controlled_issuance_owner_commitments: Vec::new(),
            controlled_issuance_content_hashes: Vec::new(),
            max_batch_bytes: 1 << 20,
        }),
        Err(MempoolApiError::Storage(message))
            if message.contains("injected state read failure")
    ));
}

#[test]
fn pending_fee_samples_exclude_zero_fee_entries() {
    use crate::fee_estimate::{estimate, FeeEstimateInputs, FeeSample};
    let dir = tempdir().unwrap();
    let (service, _, _) = service(dir.path(), B256::repeat_byte(0x68));
    {
        let mut store = service.store.lock().unwrap();
        // Zero-fee open type 0x00 entries reward their poster with
        // issuance; they are paying but carry no fee signal.
        for (byte, fee) in (0u8..8).map(|byte| (byte, 0u64)).chain([(8, 30), (9, 60)]) {
            let mut entry = stored(vec![pcash_derive::KIND_PRIVATE_VALUE, byte], 0);
            entry.metadata.open_fee_amount = U256::from(fee);
            entry.metadata.stable_id = StableId::Nullifier(B256::repeat_byte(0x40 + byte));
            entry.metadata.conflict_keys =
                vec![ConflictKey::Nullifier(B256::repeat_byte(0x40 + byte))];
            assert!(!entry.unpaid());
            store.insert(entry).unwrap();
        }
    }
    let pending: Vec<_> = service
        .ready_fee_samples()
        .into_iter()
        .map(|(fee, bytes)| FeeSample { fee, bytes })
        .collect();
    assert_eq!(pending.len(), 2);
    let quote = estimate(
        &FeeEstimateInputs {
            included: &[],
            pending: &pending,
        },
        1_000,
    );
    assert!(!quote.tiers.low.is_zero());
    assert!(!quote.tiers.standard.is_zero());
}

#[test]
fn controlled_filter_keeps_only_entries_with_a_payout_section() {
    let mut store = MempoolStore::open_in_memory(
        1,
        B256::repeat_byte(1),
        MempoolLimits {
            accept_unpaid_registration: true,
            ..MempoolLimits::default()
        },
    )
    .unwrap();
    let controlled = B256::repeat_byte(9);
    let entry = |raw: Vec<u8>, owner: B256| {
        let mut entry = stored(raw.clone(), 1);
        entry.metadata.stable_id = StableId::Nullifier(keccak256(&raw));
        entry.metadata.conflict_keys = vec![ConflictKey::Nullifier(keccak256(&raw))];
        entry.metadata.issuance_owner_commitment = owner;
        if !owner.is_zero() {
            entry.metadata.open_fee_amount = U256::ZERO;
        }
        entry.received_at_unix_ms = now_unix_ms();
        entry
    };
    let open = entry(vec![1], B256::ZERO);
    let designated = entry(vec![2], controlled);
    let foreign = entry(vec![3], B256::repeat_byte(8));
    let mut account = entry(vec![4], B256::ZERO);
    account.metadata.kind = TransactionKind::UserAccountCreation;
    account.metadata.has_publication_section = false;
    account.metadata.open_fee_amount = U256::ZERO;
    for entry in [&open, &designated, &foreign, &account] {
        store.insert(entry.clone()).unwrap();
    }
    let content_hashes = |filter: MempoolFilter| {
        let mut content_hashes = store
            .page(&filter)
            .unwrap()
            .0
            .into_iter()
            .map(|entry| entry.content_hash)
            .collect::<Vec<_>>();
        content_hashes.sort_unstable();
        content_hashes
    };
    let mut expected = vec![open.content_hash, designated.content_hash];
    expected.sort_unstable();
    assert_eq!(
        content_hashes(MempoolFilter {
            limit: 10,
            controlled_issuance_owner_commitments: Some(vec![controlled]),
            ..Default::default()
        }),
        expected
    );
    assert_eq!(
        content_hashes(MempoolFilter {
            limit: 10,
            ..Default::default()
        })
        .len(),
        4
    );
}

#[test]
fn both_zero_fee_type_zero_routes_skip_unpaid_budget_and_ttl() {
    let dir = tempdir().unwrap();
    let (service, _, genesis) = service(dir.path(), B256::repeat_byte(0x69));
    let (recent, head) = {
        let guard = service.inner.lock().unwrap();
        (guard.state.canonical_tip().unwrap().hash, guard.head_id())
    };
    let open = publication_transfer(recent, 1, 0, CircuitWord::ZERO);
    let designated = publication_transfer(recent, 3, 0, word(9));
    let unpaid = unpaid_account_update(recent, 2);

    // Both type-0 routes reach proof verification. Account operations consume
    // the bounded unpaid work budget even when registration is disabled.
    service
        .store
        .lock()
        .unwrap()
        .limits
        .accept_unpaid_registration = false;
    assert!(matches!(
        admit(&service, open.clone(), AdmissionSource::Rpc),
        Err(MempoolApiError::Verification(_))
    ));
    assert!(matches!(
        admit(&service, designated.clone(), AdmissionSource::Rpc),
        Err(MempoolApiError::Verification(_))
    ));
    assert_eq!(service.unpaid_budget.lock().unwrap().1, 0);
    assert!(admit(&service, unpaid.clone(), AdmissionSource::Rpc).is_err());
    assert_eq!(service.unpaid_budget.lock().unwrap().1, 1);

    // The retention TTL removes only the account entry.
    let expired_at = now_unix_ms().saturating_sub(UNPAID_TTL_MS + 1);
    let mut open_entry = stored_with_description(open, head);
    open_entry.received_at_unix_ms = expired_at;
    let mut designated_entry = stored_with_description(designated, head);
    designated_entry.received_at_unix_ms = expired_at;
    let mut unpaid_entry = stored_with_description(unpaid, head);
    unpaid_entry.received_at_unix_ms = expired_at;
    {
        let mut store = service.store.lock().unwrap();
        store.insert(open_entry.clone()).unwrap();
        store.insert(designated_entry.clone()).unwrap();
        store.insert(unpaid_entry.clone()).unwrap();
        store.purge_expired_unpaid(now_unix_ms()).unwrap();
        assert!(store.get(&open_entry.content_hash).is_some());
        assert!(store.get(&designated_entry.content_hash).is_some());
        assert!(store.get(&unpaid_entry.content_hash).is_none());
    }

    // Reopening with registration disabled retains proof-bearing unpaid entries.
    let path = dir.path().join("trim.redb");
    open_entry.received_at_unix_ms = now_unix_ms();
    designated_entry.received_at_unix_ms = now_unix_ms();
    unpaid_entry.received_at_unix_ms = now_unix_ms();
    {
        let mut store = MempoolStore::open(
            &path,
            crate::PCASH_CHAIN_ID,
            genesis,
            MempoolLimits {
                accept_unpaid_registration: true,
                ..MempoolLimits::default()
            },
        )
        .unwrap();
        store.insert(open_entry.clone()).unwrap();
        store.insert(designated_entry.clone()).unwrap();
        store.insert(unpaid_entry.clone()).unwrap();
    }
    let store = MempoolStore::open(
        &path,
        crate::PCASH_CHAIN_ID,
        genesis,
        MempoolLimits::default(),
    )
    .unwrap();
    assert!(store.get(&open_entry.content_hash).is_some());
    assert!(store.get(&designated_entry.content_hash).is_some());
    assert!(store.get(&unpaid_entry.content_hash).is_some());
    assert_eq!(store.occupancy().unpaid_entries, 1);
}

fn unfunded_contract_creation(recent: B256, deadline: u64, material: u64) -> Vec<u8> {
    unfunded_contract_creation_with_functions(recent, deadline, material, 1)
}

fn unfunded_contract_creation_with_functions(
    recent: B256,
    deadline: u64,
    material: u64,
    functions: u8,
) -> Vec<u8> {
    Transaction::ContractAccountCreation(ContractAccountCreation {
        body: ContractBody::new(
            false,
            word(material),
            None,
            (0..functions)
                .map(|selector| ContractFunction {
                    selector,
                    application_vk_hash: word(0x52),
                    configuration_commitment: word(0x53),
                })
                .collect(),
        )
        .unwrap(),
        recent_pcash_block_hash: recent,
        valid_until_timestamp: deadline,
    })
    .encode(crate::PCASH_CHAIN_ID)
    .unwrap()
}

/// The body of `unfunded`, attached to a zero-fee value action.
fn attached_contract_creation(unfunded: &[u8], recent: B256, salt: u64) -> Vec<u8> {
    let Ok(Transaction::ContractAccountCreation(creation)) =
        Transaction::decode(unfunded, crate::PCASH_CHAIN_ID)
    else {
        panic!("a contract creation");
    };
    let mut fee = publication_section(recent, salt, 0, CircuitWord::ZERO);
    fee.proof.resize(
        SectionLayout::PrivateValue(PrivateValueShape::S).proof_bytes(),
        0,
    );
    Transaction::PrivateValue(
        (fee)
            .with_account_creation(pcash_derive::AccountCreationAttachment::Contract(
                creation.body,
            ))
            .unwrap(),
    )
    .encode(crate::PCASH_CHAIN_ID)
    .unwrap()
}

#[test]
fn unfunded_contract_admission_requires_opt_in_and_skips_the_verifier() {
    let dir = tempdir().unwrap();
    let (service, _, _) = service(dir.path(), B256::repeat_byte(0x70));
    let recent = service
        .inner
        .lock()
        .unwrap()
        .state
        .canonical_tip()
        .unwrap()
        .hash;
    let raw = unfunded_contract_creation(recent, 2_000, 0x51);
    service
        .store
        .lock()
        .unwrap()
        .limits
        .accept_unpaid_registration = false;
    for source in [AdmissionSource::Rpc, AdmissionSource::P2p] {
        assert!(matches!(
            admit(&service, raw.clone(), source),
            Err(MempoolApiError::Policy(_))
        ));
    }
    assert!(matches!(
        service.check_admission_policy(&raw),
        Err(MempoolApiError::Policy(_))
    ));
    service
        .store
        .lock()
        .unwrap()
        .limits
        .accept_unpaid_registration = true;
    service.check_admission_policy(&raw).unwrap();
    // admit() uses a nonexistent bb binary; successful admission proves no verifier was started.
    let admitted = admit(&service, raw.clone(), AdmissionSource::P2p).unwrap();
    assert_eq!(admitted.kind, pcash_rpc::TransactionKind::ContractAccount);
    assert_eq!(admitted.valid_until, Some(2_000));
    assert_eq!(admitted.open_fee_amount, U256::ZERO);
    assert_eq!(admitted.issuance_route, pcash_rpc::IssuanceRoute::None);
    let page = service
        .list(MempoolFilter {
            kind: Some(pcash_rpc::TransactionKind::ContractAccount),
            ..MempoolFilter::default()
        })
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].content_hash, pcash_state::content_hash(&raw));
    assert_eq!(service.store.lock().unwrap().occupancy().unpaid_entries, 1);
    service.store.lock().unwrap().limits.max_unpaid_entries = 1;
    assert!(matches!(
        admit(
            &service,
            unfunded_contract_creation(recent, 2_000, 0x61),
            AdmissionSource::Rpc
        ),
        Err(MempoolApiError::Full)
    ));
}

#[test]
fn funding_byte_classifies_registration_opt_in_through_revalidation_and_restart() {
    let dir = tempdir().unwrap();
    let genesis = B256::repeat_byte(0x78);
    let (service, path, _) = service(dir.path(), genesis);
    let recent = service
        .inner
        .lock()
        .unwrap()
        .state
        .canonical_tip()
        .unwrap()
        .hash;
    let unfunded = unfunded_contract_creation(recent, 2_000, 0x51);
    let sponsored = attached_contract_creation(&unfunded, recent, 95);
    // Neither pays a public fee; only the funding byte tells them apart.
    assert_eq!(unfunded[0], pcash_derive::KIND_CONTRACT_ACCOUNT_CREATION);
    assert_eq!(sponsored[0], pcash_derive::KIND_PRIVATE_VALUE);
    assert!(requires_unpaid_registration_opt_in(&unfunded));
    assert!(!requires_unpaid_registration_opt_in(&sponsored));
    service
        .store
        .lock()
        .unwrap()
        .limits
        .accept_unpaid_registration = false;
    assert!(matches!(
        service.check_admission_policy(&unfunded),
        Err(MempoolApiError::Policy(_))
    ));
    service.check_admission_policy(&sponsored).unwrap();
    assert!(matches!(
        service.admit_and_record(unfunded, AdmissionSource::Rpc, &AlreadyVerified),
        Err(MempoolApiError::Policy(_))
    ));
    let admitted = service
        .admit_and_record(sponsored, AdmissionSource::P2p, &AlreadyVerified)
        .unwrap();
    assert_eq!(admitted.kind, pcash_rpc::TransactionKind::PrivateValue);
    assert_eq!(admitted.open_fee_amount, U256::ZERO);
    assert_eq!(admitted.issuance_route, pcash_rpc::IssuanceRoute::Open);
    assert_eq!(service.store.lock().unwrap().occupancy().unpaid_entries, 0);

    // A head refresh revalidates the entry and keeps it.
    let outcome = service
        .inner
        .lock()
        .unwrap()
        .apply_block(
            &l1_block(101, B256::repeat_byte(0x79), genesis, 1_001, None),
            &AlreadyVerified,
        )
        .unwrap();
    let head = service.inner.lock().unwrap().head_id();
    let (hashes, effects) = accepted_block_inputs(&outcome);
    service.on_applied_block(head, &hashes, &effects).unwrap();
    service.reconcile_current().unwrap();
    assert_eq!(
        service
            .store
            .lock()
            .unwrap()
            .get(&admitted.content_hash)
            .unwrap()
            .status,
        MempoolStatus::Ready
    );

    // A restart with registration still disabled keeps it too.
    let inner = service.inner.clone();
    drop(service);
    let reopened = MempoolService::open(
        inner,
        path,
        unused_admission(dir.path()),
        MempoolLimits::default(),
    )
    .unwrap();
    let reloaded = reopened
        .transaction(&admitted.content_hash)
        .unwrap()
        .unwrap();
    assert_eq!(reloaded.kind, pcash_rpc::TransactionKind::PrivateValue);
}

#[test]
fn unfunded_contract_deadline_and_unpaid_ttl_bound_retention() {
    let dir = tempdir().unwrap();
    let (service, _, _) = service(dir.path(), B256::repeat_byte(0x71));
    let recent = service
        .inner
        .lock()
        .unwrap()
        .state
        .canonical_tip()
        .unwrap()
        .hash;
    let raw = unfunded_contract_creation(recent, 1_001, 0x51);
    let admitted = admit(&service, raw, AdmissionSource::Rpc).unwrap();
    service.on_finalized(0, 1_001).unwrap();
    assert!(service
        .transaction(&admitted.content_hash)
        .unwrap()
        .is_some());
    service.on_finalized(0, 1_002).unwrap();
    assert!(service
        .transaction(&admitted.content_hash)
        .unwrap()
        .is_none());
    let raw = unfunded_contract_creation(recent, 2_000, 0x61);
    let admitted = admit(&service, raw, AdmissionSource::Rpc).unwrap();
    let mut store = service.store.lock().unwrap();
    let mut expired = store.get(&admitted.content_hash).unwrap().clone();
    expired.received_at_unix_ms = now_unix_ms().saturating_sub(UNPAID_TTL_MS + 1);
    store.apply_changes(vec![expired], Vec::new()).unwrap();
    store.purge_expired_unpaid(now_unix_ms()).unwrap();
    assert!(store.get(&admitted.content_hash).is_none());
}

#[test]
fn unfunded_contract_inclusion_and_reorg_restore_deadline_variants() {
    let dir = tempdir().unwrap();
    let genesis_block_hash = B256::repeat_byte(0x72);
    let (service, _, _) = service(dir.path(), genesis_block_hash);
    let recent = service
        .inner
        .lock()
        .unwrap()
        .state
        .canonical_tip()
        .unwrap()
        .hash;
    let included_raw = unfunded_contract_creation(recent, 2_000, 0x51);
    let variant_raw = unfunded_contract_creation(recent, 2_001, 0x51);
    let included_content_hash = admit(&service, included_raw.clone(), AdmissionSource::Rpc)
        .unwrap()
        .content_hash;
    let variant_content_hash = admit(&service, variant_raw.clone(), AdmissionSource::Rpc)
        .unwrap()
        .content_hash;
    let sponsored_raw = attached_contract_creation(&included_raw, recent, 93);
    let sponsored_content_hash = service
        .admit_and_record(sponsored_raw, AdmissionSource::Rpc, &AlreadyVerified)
        .unwrap()
        .content_hash;
    let descriptions = [
        included_content_hash,
        variant_content_hash,
        sponsored_content_hash,
    ]
    .map(|content_hash| service.transaction(&content_hash).unwrap().unwrap());
    assert_eq!(descriptions[0].stable_id, descriptions[1].stable_id);
    assert_eq!(descriptions[0].conflict_count, 1);
    assert_eq!(descriptions[1].conflict_count, 1);
    assert_ne!(descriptions[2].stable_id, descriptions[0].stable_id);
    assert_eq!(descriptions[2].conflict_count, 0);
    let prepared = service
        .prepare(PrepareRelayRequest {
            content_hashes: vec![
                included_content_hash,
                variant_content_hash,
                sponsored_content_hash,
            ],
            controlled_issuance_owner_commitments: vec![],
            controlled_issuance_content_hashes: vec![],
            max_batch_bytes: 1 << 20,
        })
        .unwrap();
    assert_eq!(
        prepared.selected_content_hashes,
        vec![included_content_hash, sponsored_content_hash]
    );
    assert_eq!(prepared.rejected.len(), 1);
    let outcome = service
        .inner
        .lock()
        .unwrap()
        .apply_block(
            &l1_block(
                101,
                B256::repeat_byte(0x73),
                genesis_block_hash,
                1_001,
                Some(included_raw.clone()),
            ),
            &AlreadyVerified,
        )
        .unwrap();
    assert_eq!(
        transaction_outcomes(&outcome),
        [TransactionOutcome::Succeeded]
    );
    let head = service.inner.lock().unwrap().head_id();
    let (hashes, effects) = accepted_block_inputs(&outcome);
    service.on_applied_block(head, &hashes, &effects).unwrap();
    {
        let store = service.store.lock().unwrap();
        assert_eq!(
            store.get(&included_content_hash).unwrap().status,
            MempoolStatus::IncludedUnfinalized
        );
        assert_eq!(
            store.get(&sponsored_content_hash).unwrap().status,
            MempoolStatus::Ready
        );
        let entry = store.get(&variant_content_hash).unwrap();
        assert_eq!(entry.status, MempoolStatus::Suspended);
        assert_eq!(entry.superseded_block.unwrap().block_number, 1);
        assert_eq!(entry.invalidated_block, None);
    }
    service.inner.lock().unwrap().rollback_to(100).unwrap();
    service.on_rollback(0).unwrap();
    assert_eq!(service.ready_inventory().len(), 3);
    let store = service.store.lock().unwrap();
    for content_hash in [
        included_content_hash,
        variant_content_hash,
        sponsored_content_hash,
    ] {
        let entry = store.get(&content_hash).unwrap();
        assert_eq!(entry.status, MempoolStatus::Ready);
        assert_eq!(entry.included_block, None);
        assert_eq!(entry.invalidated_block, None);
        assert_eq!(entry.superseded_block, None);
    }
}

#[test]
fn attached_contract_nullifier_conflict_restores_on_rollback_and_purges_on_finalization() {
    use pcash_derive::private_value_profiles::S;

    let dir = tempdir().unwrap();
    let genesis_block_hash = B256::repeat_byte(0x78);
    let (service, _, recent) = service(dir.path(), genesis_block_hash);
    let unfunded = unfunded_contract_creation(recent, 2_000, 0x51);
    let committed_raw = attached_contract_creation(&unfunded, recent, 93);
    let committed_content_hash = pcash_state::content_hash(&committed_raw);
    let shared_nullifier = word(93 * 16 + 1);
    let mut pending_section = publication_section(recent, 94, 0, CircuitWord::ZERO);
    *pending_section
        .public_input_mut(S.nullifiers_offset)
        .unwrap() = shared_nullifier;
    let pending_raw = Transaction::PrivateValue(pending_section)
        .encode(crate::PCASH_CHAIN_ID)
        .unwrap();
    let committed = descriptor(&committed_raw, &service.source).unwrap();
    let pending = descriptor(&pending_raw, &service.source).unwrap();
    assert_eq!(committed.kind, TransactionKind::PrivateValue);
    assert_eq!(pending.kind, TransactionKind::PrivateValue);
    assert_ne!(committed.statement_id, pending.statement_id);
    assert!(pending
        .conflict_keys
        .iter()
        .all(|key| matches!(key, ConflictKey::Nullifier(_))));
    assert_eq!(
        committed
            .conflict_keys
            .iter()
            .filter(|key| pending.conflict_keys.contains(key))
            .cloned()
            .collect::<Vec<_>>(),
        vec![ConflictKey::Nullifier(shared_nullifier)]
    );
    let pending_content_hash = service
        .admit_and_record(pending_raw.clone(), AdmissionSource::Rpc, &AlreadyVerified)
        .unwrap()
        .content_hash;
    assert_ne!(pending_content_hash, committed_content_hash);
    assert_eq!(service.ready_inventory().len(), 1);

    let apply_creation = || {
        // The winner arrives only through L1, so its effects cannot come from
        // a cached mempool descriptor or exact inclusion of the pending row.
        assert!(service
            .store
            .lock()
            .unwrap()
            .get(&committed_content_hash)
            .is_none());
        let outcome = service
            .inner
            .lock()
            .unwrap()
            .apply_block(
                &l1_block(
                    101,
                    B256::repeat_byte(0x79),
                    genesis_block_hash,
                    1_001,
                    Some(committed_raw.clone()),
                ),
                &AlreadyVerified,
            )
            .unwrap();
        assert_eq!(
            transaction_outcomes(&outcome),
            [TransactionOutcome::Succeeded]
        );
        let head = service.inner.lock().unwrap().head_id();
        let (hashes, effects) = accepted_block_inputs(&outcome);
        assert_eq!(hashes, [committed_content_hash]);
        assert_eq!(effects.len(), 1);
        assert!(matches!(
            &effects[0].account,
            Some(pcash_state::AccountResult::Contract { .. })
        ));
        assert!(effects[0].nullifiers.contains(&shared_nullifier));
        service.on_applied_block(head, &hashes, &effects).unwrap();

        let store = service.store.lock().unwrap();
        assert!(store.get(&committed_content_hash).is_none());
        let pending = store.get(&pending_content_hash).unwrap();
        assert_eq!(pending.raw, pending_raw);
        assert_eq!(pending.status, MempoolStatus::Suspended);
        assert_eq!(pending.included_block, None);
        // State revalidation also suspends a spent nullifier. These markers
        // ensure conflict extraction, rather than that fallback, caused it.
        assert_eq!(pending.superseded_block, Some(head));
        assert_eq!(pending.invalidated_block, None);
    };

    apply_creation();
    service.inner.lock().unwrap().rollback_to(100).unwrap();
    service.on_rollback(0).unwrap();
    assert_eq!(service.ready_inventory().len(), 1);
    {
        let store = service.store.lock().unwrap();
        let pending = store.get(&pending_content_hash).unwrap();
        assert_eq!(pending.raw, pending_raw);
        assert_eq!(pending.status, MempoolStatus::Ready);
        assert_eq!(pending.included_block, None);
        assert_eq!(pending.superseded_block, None);
        assert_eq!(pending.invalidated_block, None);
    }

    apply_creation();
    service.on_finalized(1, 1_001).unwrap();
    assert!(service
        .store
        .lock()
        .unwrap()
        .get(&pending_content_hash)
        .is_none());
}

#[test]
fn maximum_contract_body_is_cached_across_snapshots_and_reload() {
    for sponsored in [false, true] {
        let dir = tempdir().unwrap();
        let genesis = B256::repeat_byte(0x75);
        let (service, path, _) = service(dir.path(), genesis);
        let recent = service
            .inner
            .lock()
            .unwrap()
            .state
            .canonical_tip()
            .unwrap()
            .hash;
        let free = unfunded_contract_creation_with_functions(recent, 2_000, 0x51, 255);
        let raw = if sponsored {
            attached_contract_creation(&free, recent, 91)
        } else {
            free
        };
        let admitted = service
            .admit_and_record(raw.clone(), AdmissionSource::Rpc, &AlreadyVerified)
            .unwrap();
        let cached = service
            .store
            .lock()
            .unwrap()
            .get(&admitted.content_hash)
            .unwrap()
            .prepared
            .clone();
        assert_eq!(
            contract_address(cached.get()).unwrap(),
            "0x98eed164c952a4b342cd475c8062fdf5806139f6"
                .parse::<Address>()
                .unwrap()
        );
        service
            .admit_and_record(raw, AdmissionSource::P2p, &AlreadyVerified)
            .unwrap();

        let request = || PrepareRelayRequest {
            content_hashes: vec![admitted.content_hash],
            controlled_issuance_owner_commitments: vec![],
            controlled_issuance_content_hashes: vec![],
            max_batch_bytes: 1 << 20,
        };
        assert_eq!(
            service.prepare(request()).unwrap().selected_content_hashes,
            vec![admitted.content_hash]
        );
        let outcome = service
            .inner
            .lock()
            .unwrap()
            .apply_block(
                &l1_block(101, B256::repeat_byte(0x76), genesis, 1_001, None),
                &AlreadyVerified,
            )
            .unwrap();
        let head = service.inner.lock().unwrap().head_id();
        let (hashes, effects) = accepted_block_inputs(&outcome);
        service.on_applied_block(head, &hashes, &effects).unwrap();
        service.reconcile_current().unwrap();
        service.inner.lock().unwrap().rollback_to(100).unwrap();
        service.on_rollback(0).unwrap();
        let retained = service
            .store
            .lock()
            .unwrap()
            .get(&admitted.content_hash)
            .unwrap()
            .prepared
            .clone();
        assert!(std::ptr::eq(cached.get(), retained.get()));

        let inner = service.inner.clone();
        drop(service);
        let reopened = MempoolService::open(
            inner,
            path,
            unused_admission(dir.path()),
            MempoolLimits {
                accept_unpaid_registration: true,
                ..MempoolLimits::default()
            },
        )
        .unwrap();
        reopened.reconcile_current().unwrap();
        assert_eq!(
            reopened.prepare(request()).unwrap().selected_content_hashes,
            vec![admitted.content_hash]
        );
        reopened.on_rollback(0).unwrap();
        let loaded = reopened
            .store
            .lock()
            .unwrap()
            .get(&admitted.content_hash)
            .unwrap()
            .prepared
            .clone();
        assert!(!std::ptr::eq(cached.get(), loaded.get()));
        assert_eq!(
            contract_address(loaded.get()),
            contract_address(cached.get())
        );
    }
}

#[test]
fn exhausted_unpaid_budget_refuses_invalid_contract_bodies() {
    let dir = tempdir().unwrap();
    let (service, _, _) = service(dir.path(), B256::repeat_byte(0x77));
    let recent = service
        .inner
        .lock()
        .unwrap()
        .state
        .canonical_tip()
        .unwrap()
        .hash;
    let Ok(Transaction::ContractAccountCreation(mut creation)) = Transaction::decode(
        &unfunded_contract_creation_with_functions(recent, 2_000, 0x51, 2),
        crate::PCASH_CHAIN_ID,
    ) else {
        panic!("a contract creation");
    };
    creation.body.functions.reverse();
    let free = Transaction::ContractAccountCreation(creation)
        .encode(crate::PCASH_CHAIN_ID)
        .unwrap();
    let invalid_bodies = [free.clone(), attached_contract_creation(&free, recent, 92)];
    for raw in &invalid_bodies {
        assert!(matches!(
            service.admit_and_record(raw.clone(), AdmissionSource::Rpc, &AlreadyVerified),
            Err(MempoolApiError::State(name)) if name == "SelectorsNotStrictlyIncreasing"
        ));
    }
    // Keep the exhausted window fixed while exercising both input shapes.
    *service.unpaid_budget.lock().unwrap() = (
        std::time::Instant::now() + std::time::Duration::from_hours(1),
        32,
    );
    assert!(
        matches!(service.admit_and_record(invalid_bodies[0].clone(), AdmissionSource::Rpc, &AlreadyVerified), Err(MempoolApiError::Busy(message)) if message == "unpaid admission budget exhausted")
    );
    assert!(
        matches!(service.admit_and_record(invalid_bodies[1].clone(), AdmissionSource::Rpc, &AlreadyVerified), Err(MempoolApiError::State(name)) if name == "SelectorsNotStrictlyIncreasing")
    );
}

/// A verifier that rejects every proof.
struct RejectingVerifier;

impl pcash_verify::Verifier for RejectingVerifier {
    fn verify(
        &self,
        _vk: &[u8],
        _proof: &[u8],
        _public_inputs: &[u8],
    ) -> Result<bool, pcash_verify::VerifyError> {
        Ok(false)
    }
}

fn executed(outcome: TransactionOutcome) -> TransactionCheckDto {
    TransactionCheckDto {
        outcome: CheckOutcomeDto::Executed(outcome),
    }
}

fn not_admitted(reason: ItemExclusionReason) -> TransactionCheckDto {
    TransactionCheckDto {
        outcome: CheckOutcomeDto::NotAdmitted(reason),
    }
}

/// A fee-free S transfer anchored at `recent` that requires the carrier
/// context of `emitter`'s `PcashBatch` event with `context`.
fn event_bound_transfer(recent: B256, emitter: Address, context: &[u8]) -> Vec<u8> {
    use pcash_derive::private_value_profiles::S;
    let mut section = publication_section(recent, 1, 0, CircuitWord::ZERO);
    *section
        .public_input_mut(S.carrier_context_hash_offset)
        .unwrap() = pcash_state::fr_to_bytes(pcash_l1::carrier_context_hash(
        CarrierKind::Event,
        emitter.into_array(),
        context,
    ));
    Transaction::PrivateValue(section)
        .encode(crate::PCASH_CHAIN_ID)
        .unwrap()
}

#[test]
fn dry_run_checks_a_carrier_bound_transaction_against_the_given_carrier() {
    use TransactionOutcome::{CarrierContextMismatch, ProofRejected, Succeeded};
    let dir = tempdir().unwrap();
    let (service, _, _) = service(dir.path(), B256::repeat_byte(0x68));
    let recent = service
        .inner
        .lock()
        .unwrap()
        .state
        .canonical_tip()
        .unwrap()
        .hash;
    let router = Address::repeat_byte(0x7a);
    let context = [0x5c; 128];
    let raw = event_bound_transfer(recent, router, &context);
    let check = |carrier, verifier: &dyn pcash_verify::Verifier| {
        service.check_with(&raw, carrier, verifier).unwrap()
    };

    // The relay policy refuses the transaction; a dry run does not apply it.
    assert!(matches!(
        admit(&service, raw.clone(), AdmissionSource::Rpc),
        Err(MempoolApiError::Policy(_))
    ));
    let named = CarrierContext::event(router, &context);
    assert_eq!(check(named, &AlreadyVerified), executed(Succeeded));
    assert_eq!(check(named, &RejectingVerifier), executed(ProofRejected));
    let inbox = CarrierContext::inbox(router);
    for other in [
        CarrierContext::event(router, &context[1..]),
        CarrierContext::event(Address::repeat_byte(0x7b), &context),
        inbox,
    ] {
        assert_eq!(
            check(other, &AlreadyVerified),
            executed(CarrierContextMismatch)
        );
    }

    // A transaction that requires no carrier context succeeds from any
    // carrier.
    let unconditional = publication_transfer(recent, 2, 0, CircuitWord::ZERO);
    for carrier in [named, inbox] {
        assert_eq!(
            service
                .check_with(&unconditional, carrier, &AlreadyVerified)
                .unwrap(),
            executed(Succeeded)
        );
    }
    // Bytes that admission excludes report their non-admission class.
    let mut wrong_chain = unconditional;
    wrong_chain[4] ^= 1;
    assert_eq!(
        service
            .check_with(&wrong_chain, named, &AlreadyVerified)
            .unwrap(),
        not_admitted(ItemExclusionReason::WrongChainId)
    );

    // Nothing was stored, so nothing is announced or offered to peers.
    assert!(service.store.lock().unwrap().entries.is_empty());
    assert!(service.ready_inventory().is_empty());
}

#[test]
fn dry_run_of_a_direct_creation_needs_the_inbox_sender_it_registers() {
    use TransactionOutcome::{AccountAlreadyExists, Succeeded};
    let dir = tempdir().unwrap();
    let genesis_block_hash =
        b256!("0xaa00000000000000000000000000000000000000000000000000000000000064");
    let (service, _, _) = service(dir.path(), genesis_block_hash);
    let recent = service
        .inner
        .lock()
        .unwrap()
        .state
        .canonical_tip()
        .unwrap()
        .hash;
    let direct = |rule_set: u64| {
        Transaction::UserAccountCreation(UserAccountCreation::new(
            word(2),
            word(rule_set),
            None,
            recent,
            2_000,
            AccountCreationAuthorization::DirectL1,
        ))
        .encode(crate::PCASH_CHAIN_ID)
        .unwrap()
    };
    // Register `registered` with a direct creation it sends.
    let registered = Address::repeat_byte(0x56);
    let mut block = l1_block(
        101,
        b256!("0xbb00000000000000000000000000000000000000000000000000000000000065"),
        genesis_block_hash,
        1_001,
        Some(direct(0x61)),
    );
    block.txs[0].0.from = registered;
    let applied = service
        .inner
        .lock()
        .unwrap()
        .apply_block(&block, &AlreadyVerified)
        .unwrap();
    assert_eq!(transaction_outcomes(&applied), [Succeeded]);

    let raw = direct(0x62);
    let check = |carrier| service.check_with(&raw, carrier, &AlreadyVerified).unwrap();
    // The relay policy refuses direct creations; a dry run does not apply it.
    assert!(matches!(
        admit(&service, raw.clone(), AdmissionSource::Rpc),
        Err(MempoolApiError::Invalid(_))
    ));
    assert_eq!(
        check(CarrierContext::inbox(Address::repeat_byte(0x57))),
        executed(Succeeded)
    );
    assert_eq!(
        check(CarrierContext::inbox(registered)),
        executed(AccountAlreadyExists)
    );
    assert_eq!(
        check(CarrierContext::event(registered, &[])),
        not_admitted(ItemExclusionReason::DirectModeOutsideInbox)
    );

    // A signed creation names its own account, from any carrier.
    let signed = signed_creation(&service, 0x63);
    for carrier in [
        CarrierContext::inbox(registered),
        CarrierContext::event(registered, &[]),
    ] {
        assert_eq!(
            service
                .check_with(&signed, carrier, &AlreadyVerified)
                .unwrap(),
            executed(Succeeded)
        );
    }
    assert!(service.store.lock().unwrap().entries.is_empty());
}

#[test]
fn dry_runs_share_the_admission_queue_and_its_verifiers() {
    use TransactionOutcome::{CarrierContextMismatch, Succeeded};
    let dir = tempdir().unwrap();
    let (service, _, _) = service(dir.path(), B256::repeat_byte(0x69));
    // One worker whose verifier cannot start, with room for one waiting job.
    let service = Arc::new(MempoolService {
        admission: AdmissionPool::new(
            vec![BbProcessVerifier::new(dir.path().join("unused-bb"))],
            1,
        )
        .unwrap(),
        ..service
    });
    let recent = service
        .inner
        .lock()
        .unwrap()
        .state
        .canonical_tip()
        .unwrap()
        .hash;
    let router = Address::repeat_byte(0x7a);
    let context = vec![0x5c; 128];
    let bound = event_bound_transfer(recent, router, &context);
    let direct = Transaction::UserAccountCreation(UserAccountCreation::new(
        word(2),
        word(0x64),
        None,
        recent,
        2_000,
        AccountCreationAuthorization::DirectL1,
    ))
    .encode(crate::PCASH_CHAIN_ID)
    .unwrap();
    let query = |raw: &[u8], carrier| CheckRawTransactionRequest {
        transaction: raw.to_vec(),
        carrier,
    };
    let event = |context: &[u8]| CarrierContextRequest::Event {
        address: router,
        context: context.to_vec(),
    };

    // A dry run starts under the node lock, so holding it stalls the worker
    // on the first job it takes.
    let node = service.inner.lock().unwrap();
    let first = service
        .enqueue_check(query(
            &direct,
            CarrierContextRequest::Inbox {
                address: Address::repeat_byte(0x57),
            },
        ))
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while service.admission.queued() > 0 {
        assert!(
            std::time::Instant::now() < deadline,
            "worker never took the job"
        );
        std::thread::yield_now();
    }
    let waiting = service
        .enqueue_check(query(&bound, event(&context[1..])))
        .unwrap();
    assert!(matches!(
        service.enqueue_check(query(&bound, event(&context))),
        Err(MempoolApiError::Busy(_))
    ));
    assert!(matches!(
        service.enqueue(bound.clone(), AdmissionSource::Rpc),
        Err(MempoolApiError::Busy(_))
    ));
    drop(node);

    assert_eq!(first.blocking_recv().unwrap().unwrap(), executed(Succeeded));
    assert_eq!(
        waiting.blocking_recv().unwrap().unwrap(),
        executed(CarrierContextMismatch)
    );
    // The matching carrier reaches the worker's own verifier, which here
    // cannot start: no verdict, rather than an outcome.
    let verified = service
        .enqueue_check(query(&bound, event(&context)))
        .unwrap();
    assert!(matches!(
        verified.blocking_recv().unwrap(),
        Err(MempoolApiError::Verification(_))
    ));
    assert!(service.store.lock().unwrap().entries.is_empty());
}
