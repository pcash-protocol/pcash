#![allow(
    clippy::unreadable_literal,
    reason = "test fixtures preserve protocol chain identifiers"
)]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]
//! Offline node-pipeline test: send a synthetic L1 block (an inbox batch plus a
//! Ethereum transaction) through the real derive → index → state → RPC path with
//! no network, and assert empty native genesis, receipt storage, and RPC reads.

mod common;

use common::{batch, item_results, receive_key, sender, word, ItemResult, SUCCEEDED};

use alloy_primitives::{b256, Address, Bytes, B256, U256};
use pcash_derive::private_value_profiles::PrivateValueShape;
use pcash_derive::{
    AccountCreationAuthorization, ContractAccountCreation, ContractBody, ContractFunction,
    PrivateValueSection, SectionLayout, Transaction, UserAccountCreation,
};
use pcash_l1::{L1BlockData, L1Header, L1Receipt, L1Tx};
use pcash_node::{build_node, NetworkConfig, NodeHandle, DEFAULT_INBOX, L1_CHAIN_ID};
use pcash_rpc::{BlockId, NodeApi, OutputLimits, OutputRequest, ReceiptQuery, TransactionKind};
use pcash_state::{CircuitWord, StateDb, TransactionOutcome};
use pcash_verify::{Verifier, VerifyError};

/// Reject every proof. User-account creation checks its signature in the node.
struct NoVerify;
impl Verifier for NoVerify {
    fn verify(&self, _: &[u8], _: &[u8], _: &[u8]) -> Result<bool, VerifyError> {
        Ok(false)
    }
}

/// Private-value tests exercise indexing rather than cryptography; public inputs
/// are still checked by derivation before this verifier seam.
struct AcceptVerify;
impl Verifier for AcceptVerify {
    fn verify(&self, _: &[u8], _: &[u8], _: &[u8]) -> Result<bool, VerifyError> {
        Ok(true)
    }
}

const PCASH_CHAIN_ID: u32 = 1346589512;
const GENESIS: u64 = 100;

/// A signed creation whose zero signature recovers no signer.
fn account_txbytes(nullifier_key_commitment: CircuitWord, rule_set: CircuitWord) -> Vec<u8> {
    Transaction::UserAccountCreation(UserAccountCreation::new(
        nullifier_key_commitment,
        rule_set,
        None,
        CircuitWord::ZERO, // unreached: bad signature
        0,
        AccountCreationAuthorization::Eip712 {
            sig_r: CircuitWord::ZERO,
            sig_s: CircuitWord::ZERO,
            y_parity: false,
        },
    ))
    .encode(PCASH_CHAIN_ID)
    .unwrap()
}

fn private_value_txbytes(
    recent_pcash_block_hash: B256,
    first_nullifier: CircuitWord,
    valid_until: u64,
    issuance_owner_commitment: CircuitWord,
    output_data_first_byte: u8,
) -> Vec<u8> {
    paid_private_value_txbytes(
        recent_pcash_block_hash,
        first_nullifier,
        valid_until,
        0,
        issuance_owner_commitment,
        output_data_first_byte,
    )
}

fn paid_private_value_txbytes(
    recent_pcash_block_hash: B256,
    first_nullifier: CircuitWord,
    valid_until: u64,
    fee: u64,
    issuance_owner_commitment: CircuitWord,
    output_data_first_byte: u8,
) -> Vec<u8> {
    Transaction::PrivateValue(paid_private_value_section(
        recent_pcash_block_hash,
        first_nullifier,
        valid_until,
        fee,
        issuance_owner_commitment,
        output_data_first_byte,
    ))
    .encode(PCASH_CHAIN_ID)
    .unwrap()
}

fn paid_private_value_section(
    recent_pcash_block_hash: B256,
    first_nullifier: CircuitWord,
    valid_until: u64,
    fee: u64,
    issuance_owner_commitment: CircuitWord,
    output_data_first_byte: u8,
) -> PrivateValueSection {
    let mut output_data = [
        vec![0x11, 0x22],
        vec![0x33, 0x44],
        vec![],
        vec![],
        vec![0x99, 0xaa],
    ]
    .map(|data| common::output_data(&data));
    output_data[0][0] = output_data_first_byte;
    let first = pcash_state::word_to_u256(first_nullifier).to::<u64>();
    PrivateValueSection::new(
        PrivateValueShape::S,
        PCASH_CHAIN_ID,
        &[
            recent_pcash_block_hash,
            first_nullifier,
            word(first + 1),
            word(first + 2),
            word(first + 3),
            word(0x101),
            word(0x102),
            word(0x103),
            word(0x104),
            word(0x105),
            word(fee),
            issuance_owner_commitment,
            CircuitWord::ZERO, // notBeforeTimestamp
            word(valid_until),
            CircuitWord::ZERO, // carrierContextHash
            word(0xe7),        // eventsCommitment
        ],
        // Inert proof accepted by AcceptVerify.
        vec![0x01; SectionLayout::PrivateValue(PrivateValueShape::S).proof_bytes()],
        output_data.into_iter().collect(),
        common::arena(),
    )
    .unwrap()
}

fn synthetic_private_value_block(
    number: u64,
    hash: B256,
    parent_hash: B256,
    private_value: Vec<u8>,
) -> L1BlockData {
    inbox_batch_block(number, hash, parent_hash, vec![private_value])
}

/// A attached contract creation paying through `fee`, the private-value
/// section of a type `0x00` fixture with its proof resized to the type's.
fn contract_txbytes(nullifier_key_commitment: u64, mut fee: PrivateValueSection) -> Vec<u8> {
    fee.proof.resize(
        SectionLayout::PrivateValue(PrivateValueShape::S).proof_bytes(),
        0x01,
    );
    Transaction::PrivateValue(
        (fee)
            .with_account_creation(pcash_derive::AccountCreationAttachment::Contract(
                ContractBody::new(
                    false,
                    word(nullifier_key_commitment),
                    None,
                    vec![ContractFunction {
                        selector: 0,
                        application_vk_hash: word(0x52),
                        configuration_commitment: word(0x53),
                    }],
                )
                .unwrap(),
            ))
            .unwrap(),
    )
    .encode(PCASH_CHAIN_ID)
    .unwrap()
}

fn inbox_batch_block(
    number: u64,
    hash: B256,
    parent_hash: B256,
    items: Vec<Vec<u8>>,
) -> L1BlockData {
    inbox_calldata_block(number, hash, parent_hash, batch(&items))
}

fn inbox_calldata_block(
    number: u64,
    hash: B256,
    parent_hash: B256,
    calldata: Vec<u8>,
) -> L1BlockData {
    L1BlockData::new(
        L1Header {
            number,
            hash,
            parent_hash,
            timestamp: 1_800_000_000 + number,
        },
        vec![(
            L1Tx {
                hash: [number as u8; 32].into(),
                from: sender(),
                to: Some(DEFAULT_INBOX),
                input: Bytes::from(calldata),
                blob_versioned_hashes: Vec::new(),
                blob_resolution: Default::default(),
                tx_index: 0,
            },
            L1Receipt { logs: Vec::new() },
        )],
    )
}

/// The empty genesis block carrying the anchored hash: seeds the state's
/// timestamp anchors (the genesis block itself mints nothing).
fn genesis_block() -> L1BlockData {
    L1BlockData::new(
        L1Header {
            number: GENESIS,
            hash: b256!("0xaa00000000000000000000000000000000000000000000000000000000000001"),
            parent_hash: b256!(
                "0xaa00000000000000000000000000000000000000000000000000000000000000"
            ),
            timestamp: 1_800_000_000,
        },
        Vec::new(),
    )
}

/// Block GENESIS+1, one 12 s reference interval after genesis, carrying the
/// record transaction.
fn synthetic_block(record: &[u8]) -> L1BlockData {
    let header = L1Header {
        number: GENESIS + 1,
        hash: b256!("0xaa00000000000000000000000000000000000000000000000000000000000002"),
        parent_hash: b256!("0xaa00000000000000000000000000000000000000000000000000000000000001"),
        timestamp: 1_800_000_012,
    };
    let tx = L1Tx {
        hash: b256!("0xcc00000000000000000000000000000000000000000000000000000000000001"),
        from: sender(),
        to: Some(DEFAULT_INBOX),
        input: Bytes::from(batch(&[record.to_vec()])),
        blob_versioned_hashes: Vec::new(),
        blob_resolution: Default::default(),
        tx_index: 0,
    };
    let receipt = L1Receipt { logs: Vec::new() };
    L1BlockData::new(header, vec![(tx, receipt)])
}

#[test]
fn full_pipeline_keeps_empty_genesis_and_stores_receipt() {
    let tmp = tempfile::tempdir().unwrap();
    let cfg = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        GENESIS,
        b256!("0xaa00000000000000000000000000000000000000000000000000000000000001"),
    );
    let inner = build_node(&tmp.path().join("state.redb"), &cfg).unwrap();
    let empty_root = inner.lock().unwrap().state.state_root().0;

    // One record transaction with a garbage signature (admitted, rejected at
    // derivation) so we exercise receipt indexing without changing native value.
    let mut nullifier_key_commitment = CircuitWord::ZERO;
    nullifier_key_commitment.0[31] = 9;
    let record = account_txbytes(nullifier_key_commitment, CircuitWord::ZERO);
    let block = synthetic_block(&record);
    let account_txid = pcash_state::transaction_id(block.header.hash, 0, 0);

    // Derive under the lock, exactly as the follow loop does: the empty genesis
    // block anchors the chain, then a later transaction is processed.
    {
        let mut g = inner.lock().unwrap();
        g.apply_block(&genesis_block(), &NoVerify).unwrap();
        g.apply_block(&block, &NoVerify).unwrap();
        // The finalized anchor at GENESIS is retained; nothing strictly below it.
        g.prune_finalized(GENESIS).unwrap();
    }

    let handle = NodeHandle::new(inner.clone());
    // Later Ethereum activity preserves gross issuance and advances the head.
    let status = handle.status().unwrap();
    assert_eq!(status.latest_block, 1);
    assert_eq!(status.latest_l1_block_number, GENESIS + 1);
    assert_eq!(status.latest_block_timestamp, 1_800_000_012);
    assert_eq!(status.issued_so_far, U256::ZERO);
    assert_eq!(
        status.output_count, 0,
        "skipped records do not create native notes"
    );
    assert_ne!(
        status.state_root, empty_root,
        "empty produced blocks still advance authenticated issuance lag"
    );

    // Receipt: the record transaction was indexed (failed at derivation, accepted=false).
    let receipts = handle
        .get_receipt(ReceiptQuery::tx_id(account_txid))
        .expect("derived index receipt read");
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].kind, TransactionKind::UserAccountCreation);
    assert!(
        !receipts[0].accepted(),
        "garbage-signature record must be skipped"
    );
    assert_eq!(receipts[0].issuance_owner_commitment, None);
    assert_eq!(receipts[0].settled_open_fee_amount, U256::ZERO);
    assert_eq!(receipts[0].settled_issuance_amount, U256::ZERO);
    assert_eq!(receipts[0].inclusion.l1_block_number, GENESIS + 1);
    assert_eq!(receipts[0].inclusion.batch_item_index, 0);
    // The inclusion names the L1 transaction that carried it, not just the L1
    // block it landed in, so a reader reaches the batch without a second lookup.
    let carrier = block.txs[0].0.hash;
    assert_eq!(receipts[0].inclusion.l1_transaction_hash, carrier);

    // The same coordinate reaches the block read, which builds it by joining
    // the canonical delivery manifests rather than storing it on the result.
    let indexed = handle
        .get_block(1, false)
        .expect("canonical block read")
        .expect("block 1 is canonical");
    assert_eq!(indexed.transaction_results.len(), 1);
    assert_eq!(
        indexed.transaction_results[0].inclusion.l1_transaction_hash,
        carrier
    );
    assert_eq!(
        indexed.transaction_results[0].inclusion,
        receipts[0].inclusion
    );
}

/// A rejected creation's receipt names the account its authorization names:
/// the carrier's sender for a direct creation, and no account for a signature
/// that does not recover.
#[test]
fn rejected_creation_lifecycle_address_follows_its_authorization() {
    use pcash_rpc::AccountHistoryQuery;

    let tmp = tempfile::tempdir().unwrap();
    let cfg = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        GENESIS,
        genesis_block().header.hash,
    );
    let inner = build_node(&tmp.path().join("state.redb"), &cfg).unwrap();
    inner
        .lock()
        .unwrap()
        .apply_block(&genesis_block(), &NoVerify)
        .unwrap();
    let recent = inner.lock().unwrap().state.canonical_tip().unwrap().hash;
    let unsigned = account_txbytes(word(9), CircuitWord::ZERO);
    // A nullifier-key commitment that is not a field element.
    let direct = direct_account_txbytes(CircuitWord::repeat_byte(0xff), None, recent);
    let block = inbox_batch_block(
        GENESIS + 1,
        B256::repeat_byte(0xa7),
        genesis_block().header.hash,
        vec![unsigned.clone(), direct.clone()],
    );
    let outcome = inner
        .lock()
        .unwrap()
        .apply_block(&block, &NoVerify)
        .unwrap();
    assert_eq!(
        item_results(&outcome),
        vec![
            ItemResult::Admitted(TransactionOutcome::InvalidAccountSignature),
            ItemResult::Admitted(TransactionOutcome::NonCanonicalAccountField),
        ]
    );

    let ids = [0, 1].map(|index| pcash_state::transaction_id(block.header.hash, 0, index));
    let addresses = ids.map(|id| {
        inner
            .lock()
            .unwrap()
            .index
            .receipt_by_txid(&id)
            .unwrap()
            .unwrap()
            .lifecycle_address
    });
    assert_eq!(addresses, [None, Some(sender())]);
    let history = NodeHandle::new(inner)
        .get_account_history(AccountHistoryQuery {
            address: sender(),
            cursor: None,
            limit: None,
        })
        .unwrap();
    assert_eq!(
        history
            .items
            .iter()
            .map(|item| item.tx_id)
            .collect::<Vec<_>>(),
        vec![ids[1]]
    );
}

#[test]
fn detail_free_private_value_failures_keep_receipt_index_available() {
    let cases = [(
        "proof rejection with opaque output data",
        word(1),
        2,
        TransactionOutcome::ProofRejected,
    )];

    for (
        case_index,
        (label, issuance_owner_commitment, output_data_first_byte, expected_outcome),
    ) in cases.into_iter().enumerate()
    {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = NetworkConfig::new(
            PCASH_CHAIN_ID,
            L1_CHAIN_ID,
            DEFAULT_INBOX,
            GENESIS,
            b256!("0xaa00000000000000000000000000000000000000000000000000000000000001"),
        );
        let inner = build_node(&tmp.path().join("state.redb"), &cfg).unwrap();
        inner
            .lock()
            .unwrap()
            .apply_block(&genesis_block(), &NoVerify)
            .unwrap();
        let (recent_block_hash, parent_hash) = {
            let guard = inner.lock().unwrap();
            let tip = guard.state.canonical_tip().unwrap();
            (tip.hash, tip.l1_origin.block_hash)
        };
        let transaction = private_value_txbytes(
            recent_block_hash,
            word(0x6601 + case_index as u64),
            1_800_000_500,
            issuance_owner_commitment,
            output_data_first_byte,
        );
        let block = synthetic_private_value_block(
            GENESIS + 1,
            B256::repeat_byte(0xb0 + case_index as u8),
            parent_hash,
            transaction.clone(),
        );
        let transaction_id = pcash_state::transaction_id(block.header.hash, 0, 0);

        let outcome = inner
            .lock()
            .unwrap()
            .apply_block(&block, &NoVerify)
            .unwrap();
        assert_eq!(
            item_results(&outcome),
            [ItemResult::Admitted(expected_outcome)],
            "{label} must reach its intended derivation outcome"
        );

        let receipts = NodeHandle::new(inner)
            .get_receipt(ReceiptQuery::tx_id(transaction_id))
            .unwrap_or_else(|error| panic!("{label} made the receipt index unavailable: {error}"));
        assert_eq!(receipts.len(), 1, "{label}");
        assert_eq!(receipts[0].outcome, expected_outcome, "{label}");
        assert_eq!(receipts[0].failure_detail, None, "{label}");
    }
}

#[test]
fn private_value_recovery_uses_generic_nullifier_receipts_and_output_data() {
    let tmp = tempfile::tempdir().unwrap();
    let cfg = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        GENESIS,
        b256!("0xaa00000000000000000000000000000000000000000000000000000000000001"),
    );
    let inner = build_node(&tmp.path().join("state.redb"), &cfg).unwrap();
    {
        inner
            .lock()
            .unwrap()
            .apply_block(&genesis_block(), &NoVerify)
            .unwrap();
    }
    let (recent_block_hash, parent_hash) = {
        let guard = inner.lock().unwrap();
        let tip = guard.state.canonical_tip().unwrap();
        (tip.hash, tip.l1_origin.block_hash)
    };
    let first_nullifier = word(0x5501);
    let transaction = private_value_txbytes(
        recent_block_hash,
        first_nullifier,
        1_800_000_500,
        word(1),
        1,
    );
    let block = synthetic_private_value_block(
        GENESIS + 1,
        B256::repeat_byte(0xa4),
        parent_hash,
        transaction.clone(),
    );
    let transaction_id = pcash_state::transaction_id(block.header.hash, 0, 0);
    inner
        .lock()
        .unwrap()
        .apply_block(&block, &AcceptVerify)
        .unwrap();

    let handle = NodeHandle::new(inner);
    for nullifier in [first_nullifier, word(0x5504)] {
        let receipts = handle
            .get_receipt(ReceiptQuery::nullifier(nullifier))
            .unwrap();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].kind, TransactionKind::PrivateValue);
        assert_eq!(receipts[0].output_leaf_start, Some(0));
        assert_eq!(receipts[0].outputs_added, 5);
        assert_eq!(receipts[0].nullifiers.as_ref().unwrap()[0], first_nullifier);
    }

    let detail = handle.get_transaction(transaction_id).unwrap().unwrap();
    assert_eq!(detail.raw_transaction.as_ref(), transaction.as_slice());
    let pcash_derive::Transaction::PrivateValue(parsed) =
        pcash_derive::Transaction::decode(&transaction, PCASH_CHAIN_ID).unwrap()
    else {
        panic!("expected private-value transaction")
    };
    assert_eq!(parsed.output_data().len(), 5);
    assert_eq!(
        parsed.output_data()[4].as_slice(),
        common::output_data(&[0x99, 0xaa])
    );

    let head = detail.summary.block;
    let page = handle
        .get_outputs(OutputRequest {
            from_output_index: 0,
            target: BlockId {
                block_number: head.block_number,
                block_hash: head.block_hash,
            },
            continuation: None,
            limits: OutputLimits {
                max_outputs: 10,
                max_bytes: 1_000_000,
            },
        })
        .unwrap();
    assert_eq!(page.outputs.len(), 6);
    assert!(
        matches!(&page.outputs[4].material, pcash_rpc::OutputMaterialDto::Ordinary { output_slot: 4, output_data, .. } if output_data.as_ref() == common::output_data(&[0x99, 0xaa]).as_slice())
    );
    // Every ordinary row names its transaction's content hash; only the
    // slot-0 row carries the section's nullifiers, in input-slot order.
    for (slot, output) in page.outputs[..5].iter().enumerate() {
        let pcash_rpc::OutputMaterialDto::Ordinary {
            output_slot,
            content_hash,
            nullifiers,
            ..
        } = &output.material
        else {
            panic!("expected an ordinary output row")
        };
        assert_eq!(usize::from(*output_slot), slot);
        assert_eq!(*content_hash, pcash_state::content_hash(&transaction));
        let expected = if slot == 0 {
            vec![first_nullifier, word(0x5502), word(0x5503), word(0x5504)]
        } else {
            Vec::new()
        };
        assert_eq!(nullifiers, &expected);
    }
    assert!(matches!(
        page.outputs[5].material,
        pcash_rpc::OutputMaterialDto::System { .. }
    ));
    // Each origin carries its canonical block header's timestamp.
    for output in &page.outputs {
        let block = handle
            .get_block(output.origin.block_number, false)
            .unwrap()
            .unwrap();
        assert_eq!(output.origin.block_hash, block.hash);
        assert_eq!(output.origin.block_timestamp, block.timestamp);
    }
    assert_eq!(
        page.outputs[0].origin.block_timestamp,
        detail.summary.timestamp
    );
}

/// A type `0x01` creation authorized by, and creating, its L1 sender.
fn direct_account_txbytes(
    nullifier_key_commitment: CircuitWord,
    key: Option<&[u8]>,
    recent_pcash_block_hash: B256,
) -> Vec<u8> {
    Transaction::UserAccountCreation(UserAccountCreation::new(
        nullifier_key_commitment,
        word(0x61),
        key.map(receive_key),
        recent_pcash_block_hash,
        1_800_000_500,
        AccountCreationAuthorization::DirectL1,
    ))
    .encode(PCASH_CHAIN_ID)
    .unwrap()
}

/// One L1 block holding one inbox batch per sender.
fn multi_sender_block(
    number: u64,
    hash: B256,
    parent_hash: B256,
    batches: Vec<(Address, Vec<Vec<u8>>)>,
) -> L1BlockData {
    L1BlockData::new(
        L1Header {
            number,
            hash,
            parent_hash,
            timestamp: 1_800_000_000 + number,
        },
        batches
            .into_iter()
            .enumerate()
            .map(|(index, (from, items))| {
                let mut hash = [0xe0 | index as u8; 32];
                hash[31] = number as u8;
                (
                    L1Tx {
                        hash: B256::from(hash),
                        from,
                        to: Some(DEFAULT_INBOX),
                        input: Bytes::from(batch(&items)),
                        blob_versioned_hashes: Vec::new(),
                        blob_resolution: Default::default(),
                        tx_index: index as u64,
                    },
                    L1Receipt { logs: Vec::new() },
                )
            })
            .collect(),
    )
}

#[test]
fn canonical_feeds_serve_output_frontiers_and_account_changes() {
    use pcash_rpc::dto::{AccountChangeDto, AccountChangePageDto};
    use pcash_rpc::{AccountChangeLimits, AccountChangesRequest, BlockTag, IndexReadError};
    use pcash_state::{
        account_state_commitment, fr_from_canonical_bytes, fr_to_bytes, SparseTree, TREE_DEPTH,
    };

    let tmp = tempfile::tempdir().unwrap();
    let cfg = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        GENESIS,
        genesis_block().header.hash,
    );
    let inner = build_node(&tmp.path().join("state.redb"), &cfg).unwrap();
    inner
        .lock()
        .unwrap()
        .apply_block(&genesis_block(), &NoVerify)
        .unwrap();
    let (recent, parent_hash) = {
        let guard = inner.lock().unwrap();
        let tip = guard.state.canonical_tip().unwrap();
        (tip.hash, tip.l1_origin.block_hash)
    };
    let alice = sender();
    let bob = Address::repeat_byte(0x2b);
    let carol = Address::repeat_byte(0x3c);
    let alice_key = vec![0xa1; pcash_state::ML_KEM768_PUBLIC_KEY_LEN];
    let carol_key = vec![0xc3; pcash_state::ML_KEM768_PUBLIC_KEY_LEN];
    let contract_fee =
        paid_private_value_section(recent, word(0x7501), 1_800_000_500, 4, CircuitWord::ZERO, 1);
    let first = multi_sender_block(
        GENESIS + 1,
        B256::repeat_byte(0xd1),
        parent_hash,
        vec![
            (
                alice,
                vec![
                    direct_account_txbytes(word(0x51), Some(&alice_key), recent),
                    private_value_txbytes(recent, word(0x5501), 1_800_000_500, word(1), 1),
                    contract_txbytes(0x52, contract_fee),
                ],
            ),
            (bob, vec![direct_account_txbytes(word(0x53), None, recent)]),
        ],
    );
    let outcome = inner
        .lock()
        .unwrap()
        .apply_block(&first, &AcceptVerify)
        .unwrap();
    assert!(item_results(&outcome)
        .iter()
        .all(|result| *result == SUCCEEDED));
    let second = multi_sender_block(
        GENESIS + 2,
        B256::repeat_byte(0xd2),
        first.header.hash,
        vec![(
            carol,
            vec![direct_account_txbytes(word(0x54), Some(&carol_key), recent)],
        )],
    );
    inner
        .lock()
        .unwrap()
        .apply_block(&second, &AcceptVerify)
        .unwrap();

    let handle = NodeHandle::new(inner);
    let block_id = |number: u64| BlockId {
        block_number: number,
        block_hash: handle.get_block(number, false).unwrap().unwrap().hash,
    };
    let committed = |number: u64| {
        handle
            .get_block_header(BlockTag::Number(number))
            .unwrap()
            .unwrap()
            .boundary
            .state
    };

    // Frontiers at genesis (empty), after outputs, and at an unchanged count.
    for number in 0..=2 {
        let frontier = handle.get_output_frontier(block_id(number)).unwrap();
        let state = committed(number);
        assert_eq!(frontier.block, block_id(number));
        assert_eq!(frontier.output_count, state.output_count);
        assert_eq!(frontier.output_root, state.output_root);
        assert_eq!(
            frontier.ommers.len(),
            state.output_count.count_ones() as usize
        );
        let mut ommers = frontier.ommers.iter();
        let mut node = pcash_crypto::merkle::empty(0);
        for height in 0..TREE_DEPTH {
            node = if (frontier.output_count >> height) & 1 == 1 {
                let ommer = fr_from_canonical_bytes(*ommers.next().unwrap()).unwrap();
                pcash_crypto::poseidon(&[ommer, node])
            } else {
                pcash_crypto::poseidon(&[node, pcash_crypto::merkle::empty(height)])
            };
        }
        assert_eq!(fr_to_bytes(node), frontier.output_root, "block {number}");
    }
    assert_eq!(committed(0).output_count, 0);
    assert!(committed(1).output_count > 0);
    assert_eq!(committed(2).output_count, committed(1).output_count);
    let head = block_id(2);
    let beyond = BlockId {
        block_number: 3,
        block_hash: head.block_hash,
    };
    let other_branch = BlockId {
        block_number: 1,
        block_hash: B256::repeat_byte(0x77),
    };
    assert!(matches!(
        handle.get_output_frontier(beyond),
        Err(IndexReadError::Unavailable(_))
    ));
    assert!(matches!(
        handle.get_output_frontier(other_branch),
        Err(IndexReadError::CursorMismatch)
    ));

    let request = |from_block: u64, target: BlockId, max_changes: u32, max_bytes: u32| {
        AccountChangesRequest {
            from_block,
            target,
            continuation: None,
            limits: AccountChangeLimits {
                max_changes,
                max_bytes,
            },
        }
    };
    let all = |from_block: u64, target: BlockId| {
        handle
            .get_account_changes(request(from_block, target, 10_000, 4 << 20))
            .unwrap()
    };

    // Replaying every change from genesis rebuilds each block's account tree.
    for number in 0..=2 {
        let page = all(0, block_id(number));
        assert!(page.complete);
        assert!(page.continuation.is_none());
        let state = committed(number);
        assert_eq!(page.target.account_count, state.account_count);
        let mut tree = SparseTree::new(TREE_DEPTH);
        for change in &page.changes {
            tree.set_leaf(
                change.account_index,
                account_state_commitment(
                    change.address,
                    fr_from_canonical_bytes(change.nullifier_key_commitment).unwrap(),
                    fr_from_canonical_bytes(change.account_rule_set_commitment).unwrap(),
                    change.account_kind,
                    change.account_revision,
                    change.receive_key_hash,
                ),
            );
        }
        assert_eq!(
            fr_to_bytes(tree.root()),
            state.account_state_root,
            "block {number}"
        );
    }

    let full = all(0, head);
    let summary = |change: &AccountChangeDto| {
        (
            change.origin.block_number,
            change.address,
            change.account_index,
            change.account_kind,
            change.receive_key.as_ref().map(|key| key.to_vec()),
        )
    };
    let contract = full.changes[1].address;
    assert_eq!(
        full.changes.iter().map(summary).collect::<Vec<_>>(),
        vec![
            (1, alice, 0, 0, Some(alice_key.clone())),
            (1, contract, 1, 1, None),
            (1, bob, 2, 0, None),
            (2, carol, 3, 0, Some(carol_key.clone())),
        ]
    );
    for change in &full.changes {
        assert_eq!(change.origin, block_id(change.origin.block_number));
        assert_eq!(change.account_revision, 1);
        assert_eq!(
            change.receive_key_hash,
            change
                .receive_key
                .as_ref()
                .map_or(B256::ZERO, |key| pcash_state::receive_key_hash(key))
        );
    }
    assert_eq!(
        all(2, head).changes.iter().map(summary).collect::<Vec<_>>(),
        vec![(2, carol, 3, 0, Some(carol_key))]
    );
    let empty = all(3, head);
    assert!(empty.complete && empty.changes.is_empty());

    // One change per page walks the same sequence through continuations.
    let mut walked = Vec::new();
    let mut continuations = Vec::new();
    let mut page: AccountChangePageDto = handle
        .get_account_changes(request(0, head, 1, 4 << 20))
        .unwrap();
    loop {
        walked.extend(page.changes.clone());
        let Some(continuation) = page.continuation else {
            assert!(page.complete);
            break;
        };
        assert!(!page.complete);
        continuations.push((continuation.next_block, continuation.next_ordinal));
        page = handle
            .get_account_changes(AccountChangesRequest {
                continuation: Some(continuation),
                ..request(0, head, 1, 4 << 20)
            })
            .unwrap();
    }
    assert_eq!(walked, full.changes);
    assert_eq!(continuations, vec![(1, 1), (1, 2), (2, 0)]);

    // A byte ceiling that fits one keyed change stops before the next row.
    let keyed_bytes = serde_json::to_vec(&full.changes[0]).unwrap().len() as u32;
    let limited = handle
        .get_account_changes(request(0, head, 10, keyed_bytes))
        .unwrap();
    assert_eq!(limited.changes, full.changes[..1]);
    assert_eq!(
        limited
            .continuation
            .map(|continuation| (continuation.next_block, continuation.next_ordinal)),
        Some((1, 1))
    );
    assert!(matches!(
        handle.get_account_changes(request(0, head, 10, 1)),
        Err(IndexReadError::Invalid(_))
    ));

    // Targets and continuations must name the canonical branch exactly.
    assert!(matches!(
        handle.get_account_changes(request(0, beyond, 10, 4 << 20)),
        Err(IndexReadError::Unavailable(_))
    ));
    assert!(matches!(
        handle.get_account_changes(request(0, other_branch, 10, 4 << 20)),
        Err(IndexReadError::CursorMismatch)
    ));
    assert!(matches!(
        handle.get_account_changes(request(4, head, 10, 4 << 20)),
        Err(IndexReadError::CursorMismatch)
    ));
    let continuation = handle
        .get_account_changes(request(0, head, 1, 4 << 20))
        .unwrap()
        .continuation
        .unwrap();
    for tampered in [
        pcash_rpc::dto::AccountChangeContinuationDto {
            from_block: 1,
            ..continuation
        },
        pcash_rpc::dto::AccountChangeContinuationDto {
            target: block_id(1),
            ..continuation
        },
        pcash_rpc::dto::AccountChangeContinuationDto {
            next_block: 3,
            ..continuation
        },
    ] {
        assert!(matches!(
            handle.get_account_changes(AccountChangesRequest {
                continuation: Some(tampered),
                ..request(0, head, 1, 4 << 20)
            }),
            Err(IndexReadError::CursorMismatch)
        ));
    }
}

#[test]
fn path_responses_carry_block_identity() {
    let tmp = tempfile::tempdir().unwrap();
    let cfg = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        GENESIS,
        b256!("0xaa00000000000000000000000000000000000000000000000000000000000001"),
    );
    let inner = build_node(&tmp.path().join("state.redb"), &cfg).unwrap();

    let mut nullifier_key_commitment = CircuitWord::ZERO;
    nullifier_key_commitment.0[31] = 9;
    let record = account_txbytes(nullifier_key_commitment, CircuitWord::ZERO);
    let block = synthetic_block(&record);
    // Derive WITHOUT pruning so the head hash is still in the trail.
    {
        let mut g = inner.lock().unwrap();
        g.apply_block(&genesis_block(), &NoVerify).unwrap();
        g.apply_block(&block, &NoVerify).unwrap();
    }

    let recent_pcash_block_hash = {
        let g = inner.lock().unwrap();
        g.state.canonical_tip().unwrap().hash
    };
    let transfer = private_value_txbytes(
        recent_pcash_block_hash,
        word(0x5501),
        1_800_000_500,
        word(1),
        1,
    );
    let transfer_block = synthetic_private_value_block(
        GENESIS + 2,
        B256::repeat_byte(0xa4),
        block.header.hash,
        transfer,
    );
    inner
        .lock()
        .unwrap()
        .apply_block(&transfer_block, &AcceptVerify)
        .unwrap();

    let handle = NodeHandle::new(inner.clone());

    let head = handle.status().unwrap();
    let by_hash = handle
        .get_block_header(pcash_rpc::BlockTag::Hash(head.latest_block_hash))
        .unwrap()
        .unwrap();
    assert_eq!(by_hash.boundary.block_hash, head.latest_block_hash);
    assert_eq!(by_hash.boundary.header.number, 2);

    // Note path carries the same block identity.
    let np = handle
        .get_output_path(0)
        .unwrap()
        .expect("leaf 0 is in range");
    assert_eq!(np.boundary.header.number, 2);
    assert_eq!(
        np.boundary.block_hash,
        handle.get_block(2, false).unwrap().unwrap().hash
    );

    // The garbage-signature record was skipped, so no account exists.
    assert_eq!(inner.lock().unwrap().state.account_count(), 0);
}

#[test]
fn witness_snapshot_stays_coherent_while_derivation_advances() {
    use pcash_rpc::WitnessSnapshotQuery;
    use std::sync::{Arc, Barrier};

    let tmp = tempfile::tempdir().unwrap();
    let genesis = genesis_block();
    let cfg = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        GENESIS,
        genesis.header.hash,
    );
    let inner = build_node(&tmp.path().join("state.redb"), &cfg).unwrap();
    let mut funding_block = synthetic_block(&[]);
    funding_block.txs[0].1.logs.push(pcash_l1::L1Log {
        transaction_index: 0,
        log_index: 0,
        emitter: sender(),
        topics: vec![word(99)],
        data: Bytes::from(vec![1, 2, 3]),
    });
    {
        let mut node = inner.lock().unwrap();
        node.apply_block(&genesis, &NoVerify).unwrap();
        node.apply_block(&funding_block, &NoVerify).unwrap();
    }
    let spend = private_value_txbytes(
        inner.lock().unwrap().state.canonical_tip().unwrap().hash,
        word(0x5501),
        1_800_000_500,
        word(1),
        1,
    );
    let transfer =
        synthetic_private_value_block(GENESIS + 2, word(0x9002), funding_block.header.hash, spend);
    inner
        .lock()
        .unwrap()
        .apply_block(&transfer, &AcceptVerify)
        .unwrap();
    let handle = NodeHandle::new(inner.clone());
    let query = WitnessSnapshotQuery {
        accounts: vec![sender()],
        outputs: vec![0, 1],
        l1_logs: vec![pcash_rpc::WitnessL1LogQuery {
            l1_block_number: GENESIS + 1,
            transaction_index: 0,
            log_index: 0,
        }],
        nullifiers: vec![word(0x7777)],
        ..Default::default()
    };
    let before = handle.get_witness_snapshot(query.clone()).unwrap();
    let start = Arc::new(Barrier::new(2));
    let writer_start = start.clone();
    let writer_inner = inner.clone();
    let writer = std::thread::spawn(move || {
        writer_start.wait();
        let mut parent_hash = word(0x9002);
        for height in 3..12 {
            let mut block = genesis_block();
            block.header.number = GENESIS + height;
            block.header.timestamp += 100 + 12 * height;
            block.header.parent_hash = parent_hash;
            block.header.hash = word(0x9000 + height);
            parent_hash = block.header.hash;
            writer_inner
                .lock()
                .unwrap()
                .apply_block(&block, &NoVerify)
                .unwrap();
            std::thread::yield_now();
        }
    });
    start.wait();
    for _ in 0..20 {
        let snapshot = handle.get_witness_snapshot(query.clone()).unwrap();
        let hash = snapshot.status.latest_block_hash;
        let height = snapshot.status.latest_block;
        let header = snapshot.block_header.unwrap();
        assert_eq!(header.recent_pcash_block_hash, hash);
        assert_eq!(header.boundary.header.number, height);
        assert_eq!(snapshot.block.unwrap().hash, hash);
        assert_eq!(snapshot.nullifiers.unwrap().boundary.block_hash, hash);
        assert_eq!(snapshot.outputs.unwrap().boundary.block_hash, hash);
        let log = snapshot.l1_logs[0].as_ref().unwrap();
        assert_eq!(log.block.boundary.block_hash, hash);
        assert_eq!(log.block.l1_block_hash, funding_block.header.hash);
        std::thread::yield_now();
    }
    writer.join().unwrap();
    let after = handle.get_witness_snapshot(query).unwrap();
    assert!(after.status.latest_block > before.status.latest_block);
    assert_eq!(
        before.block_header.unwrap().boundary.block_hash,
        before.status.latest_block_hash
    );
}

#[test]
fn receipts_and_payouts_follow_each_issuance_route() {
    use pcash_rpc::{IssuanceRoute, PayoutQuery};

    let tmp = tempfile::tempdir().unwrap();
    let cfg = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        GENESIS,
        genesis_block().header.hash,
    );
    let inner = build_node(&tmp.path().join("state.redb"), &cfg).unwrap();
    inner
        .lock()
        .unwrap()
        .apply_block(&genesis_block(), &NoVerify)
        .unwrap();
    let (recent, parent_hash) = {
        let guard = inner.lock().unwrap();
        let tip = guard.state.canonical_tip().unwrap();
        (tip.hash, tip.l1_origin.block_hash)
    };
    let valid_until = 1_800_000_500;
    let open = CircuitWord::ZERO;
    let transaction = |nullifier, fee, owner| {
        paid_private_value_txbytes(recent, word(nullifier), valid_until, fee, owner, 1)
    };
    let contract = contract_txbytes(
        0x51,
        paid_private_value_section(recent, word(0x7501), valid_until, 4, open, 1),
    );
    let mut transactions = vec![
        transaction(0x7101, 0, open),
        transaction(0x7201, 5, open),
        transaction(0x7301, 0, word(0xd)),
        transaction(0x7401, 0, word(0xe)),
        contract,
    ];
    // A copy of a paid open action fails on its spent nullifiers.
    transactions.push(transactions[1].clone());
    let block = inbox_batch_block(
        GENESIS + 1,
        B256::repeat_byte(0xd1),
        parent_hash,
        transactions.clone(),
    );
    let outcome = inner
        .lock()
        .unwrap()
        .apply_block(&block, &AcceptVerify)
        .unwrap();
    assert_eq!(
        item_results(&outcome),
        [
            [SUCCEEDED; 5].as_slice(),
            &[ItemResult::Admitted(
                TransactionOutcome::NullifierAlreadySpent
            )],
        ]
        .concat()
    );
    let reward = outcome.committed_boundary.history.economics.reward_each;
    assert!(!reward.is_zero());

    let handle = NodeHandle::new(inner.clone());
    let poster = word(1);
    let failed_id = pcash_state::transaction_id(block.header.hash, 0, 5);
    let failed = handle.get_receipt(ReceiptQuery::tx_id(failed_id)).unwrap();
    assert_eq!(failed.len(), 1);
    assert!(!failed[0].accepted());
    assert_eq!(failed[0].issuance_owner_commitment, Some(poster));
    assert_eq!(failed[0].settled_open_fee_amount, U256::ZERO);
    assert_eq!(failed[0].settled_issuance_amount, U256::ZERO);
    let expected = [
        (Some(poster), open, 0, reward, IssuanceRoute::Open),
        (Some(poster), open, 5, reward, IssuanceRoute::Open),
        (
            Some(word(0xd)),
            word(0xd),
            0,
            reward,
            IssuanceRoute::Designated,
        ),
        (
            Some(word(0xe)),
            word(0xe),
            0,
            reward,
            IssuanceRoute::Designated,
        ),
        (Some(poster), open, 4, reward, IssuanceRoute::Open),
    ];
    let mut transaction_ids = Vec::new();
    for (index, (resolved, declared, fee, issuance, route)) in expected.into_iter().enumerate() {
        let tx_id = pcash_state::transaction_id(block.header.hash, 0, index as u64);
        transaction_ids.push(tx_id);
        let receipts = handle.get_receipt(ReceiptQuery::tx_id(tx_id)).unwrap();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].issuance_owner_commitment, resolved);
        assert_eq!(receipts[0].settled_open_fee_amount, U256::from(fee));
        assert_eq!(receipts[0].settled_issuance_amount, issuance);
        let summary = handle.get_transaction(tx_id).unwrap().unwrap().summary;
        let creation = u8::from(index == 4);
        assert_eq!(receipts[0].account_creation, creation);
        assert_eq!(summary.account_creation, creation);
        assert_eq!(summary.issuance_route, route);
        assert_eq!(summary.declared_issuance_owner_commitment, Some(declared));
        assert_eq!(summary.declared_open_fee_amount, Some(U256::from(fee)));
    }

    let first = BlockId {
        block_number: 1,
        block_hash: outcome.committed_boundary.block.hash,
    };
    let payout = handle.get_block_payouts(first).unwrap().unwrap();
    assert_eq!(payout.open_fees_total, U256::from(9));
    assert_eq!(payout.issuance_total, reward * U256::from(5));
    let summary = payout
        .payouts
        .iter()
        .map(|p| (p.source.clone(), p.owner_commitment, p.component, p.amount))
        .collect::<Vec<_>>();
    assert_eq!(
        summary,
        vec![
            (
                pcash_state::PayoutSource::DesignatedIssuance {
                    l1_transaction_index: 0,
                    batch_item_index: 2,
                },
                word(0xd),
                pcash_state::PayoutComponent::Issuance,
                reward,
            ),
            (
                pcash_state::PayoutSource::DesignatedIssuance {
                    l1_transaction_index: 0,
                    batch_item_index: 3,
                },
                word(0xe),
                pcash_state::PayoutComponent::Issuance,
                reward,
            ),
            (
                pcash_state::PayoutSource::PosterPayout {
                    l1_transaction_indices: vec![0],
                },
                poster,
                pcash_state::PayoutComponent::OpenFee,
                U256::from(9),
            ),
            (
                pcash_state::PayoutSource::PosterPayout {
                    l1_transaction_indices: vec![0],
                },
                poster,
                pcash_state::PayoutComponent::Issuance,
                reward * U256::from(3),
            ),
        ]
    );
    assert_eq!(payout.payouts[2].contexts, vec![word(0)]);
    assert_eq!(payout.payouts[3].contexts, vec![word(0)]);
    assert_eq!(
        payout.payouts[3].output_index,
        payout.payouts[2].output_index + 1
    );

    // A block whose only action is zero-fee and open pays its poster issuance
    // alone, retaining the batch context.
    let lone = paid_private_value_txbytes(
        outcome.committed_boundary.block.hash,
        word(0x7601),
        valid_until,
        0,
        open,
        1,
    );
    let second_block = inbox_batch_block(
        GENESIS + 2,
        B256::repeat_byte(0xd2),
        block.header.hash,
        vec![lone],
    );
    let second = inner
        .lock()
        .unwrap()
        .apply_block(&second_block, &AcceptVerify)
        .unwrap();
    let second_reward = second.committed_boundary.history.economics.reward_each;
    assert!(!second_reward.is_zero());

    let page = handle.get_payouts(PayoutQuery::default()).unwrap();
    assert_eq!(page.records.len(), 5);
    assert_eq!(
        page.records[0].payout.transaction_id,
        Some(transaction_ids[2])
    );
    assert_eq!(
        page.records[1].payout.transaction_id,
        Some(transaction_ids[3])
    );
    assert_eq!(page.records[2].payout.transaction_id, None);
    assert_eq!(page.records[3].payout.transaction_id, None);
    let issuance_only = &page.records[4];
    assert_eq!(issuance_only.block_number, 2);
    assert_eq!(issuance_only.payout.transaction_id, None);
    assert_eq!(
        issuance_only.payout.payout.source,
        pcash_state::PayoutSource::PosterPayout {
            l1_transaction_indices: vec![0],
        }
    );
    assert_eq!(
        issuance_only.payout.payout.component,
        pcash_state::PayoutComponent::Issuance
    );
    assert_eq!(issuance_only.payout.payout.amount, second_reward);
    assert_eq!(issuance_only.payout.payout.contexts, vec![word(0)]);
}

/// A batch may name the zero poster owner commitment. Its receipts resolve
/// open issuance to that commitment, and its payouts are served and indexed
/// as outputs like any other poster's.
#[test]
fn zero_poster_owner_payouts_are_receipted_and_indexed() {
    use pcash_rpc::PayoutQuery;

    let tmp = tempfile::tempdir().unwrap();
    let cfg = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        GENESIS,
        genesis_block().header.hash,
    );
    let inner = build_node(&tmp.path().join("state.redb"), &cfg).unwrap();
    inner
        .lock()
        .unwrap()
        .apply_block(&genesis_block(), &NoVerify)
        .unwrap();
    let (recent, parent_hash) = {
        let guard = inner.lock().unwrap();
        let tip = guard.state.canonical_tip().unwrap();
        (tip.hash, tip.l1_origin.block_hash)
    };
    let transaction =
        paid_private_value_txbytes(recent, word(0x7101), 1_800_000_500, 5, CircuitWord::ZERO, 1);
    let mut calldata = batch(&[transaction]);
    calldata[1..33].fill(0);
    let block = inbox_calldata_block(GENESIS + 1, B256::repeat_byte(0xd1), parent_hash, calldata);
    let outcome = inner
        .lock()
        .unwrap()
        .apply_block(&block, &AcceptVerify)
        .unwrap();
    assert_eq!(item_results(&outcome), vec![SUCCEEDED]);
    let reward = outcome.committed_boundary.history.economics.reward_each;
    assert!(!reward.is_zero());

    let handle = NodeHandle::new(inner.clone());
    let tx_id = pcash_state::transaction_id(block.header.hash, 0, 0);
    let receipts = handle.get_receipt(ReceiptQuery::tx_id(tx_id)).unwrap();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].issuance_owner_commitment, Some(B256::ZERO));
    assert_eq!(receipts[0].settled_open_fee_amount, U256::from(5));
    assert_eq!(receipts[0].settled_issuance_amount, reward);

    let head = BlockId {
        block_number: 1,
        block_hash: outcome.committed_boundary.block.hash,
    };
    let payouts = handle.get_block_payouts(head).unwrap().unwrap();
    assert_eq!(payouts.open_fees_total, U256::from(5));
    assert_eq!(payouts.issuance_total, reward);
    let poster_payout = pcash_state::PayoutSource::PosterPayout {
        l1_transaction_indices: vec![0],
    };
    assert_eq!(
        payouts
            .payouts
            .iter()
            .map(|p| (
                p.source.clone(),
                p.owner_commitment,
                p.component,
                p.amount,
                p.output_index
            ))
            .collect::<Vec<_>>(),
        vec![
            (
                poster_payout.clone(),
                B256::ZERO,
                pcash_state::PayoutComponent::OpenFee,
                U256::from(5),
                5,
            ),
            (
                poster_payout,
                B256::ZERO,
                pcash_state::PayoutComponent::Issuance,
                reward,
                6,
            ),
        ]
    );
    let page = handle.get_payouts(PayoutQuery::default()).unwrap();
    assert_eq!(page.records.len(), 2);
    assert!(page
        .records
        .iter()
        .all(|record| record.payout.payout.owner_commitment == B256::ZERO));

    let outputs = handle
        .get_outputs(OutputRequest {
            from_output_index: 0,
            target: head,
            continuation: None,
            limits: OutputLimits {
                max_outputs: 10,
                max_bytes: 1_000_000,
            },
        })
        .unwrap();
    assert_eq!(outputs.outputs.len(), 7);
    for (output, payout) in outputs.outputs[5..].iter().zip(&payouts.payouts) {
        let pcash_rpc::OutputMaterialDto::System { payout: indexed } = &output.material else {
            panic!("expected a system output row")
        };
        assert_eq!(output.output_index, payout.output_index);
        assert_eq!(&indexed.payout, payout);
    }
}

#[test]
fn fee_estimate_samples_only_positive_explicit_fees() {
    let tmp = tempfile::tempdir().unwrap();
    let cfg = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        GENESIS,
        genesis_block().header.hash,
    );
    let inner = build_node(&tmp.path().join("state.redb"), &cfg).unwrap();
    inner
        .lock()
        .unwrap()
        .apply_block(&genesis_block(), &NoVerify)
        .unwrap();
    let (recent, parent_hash) = {
        let guard = inner.lock().unwrap();
        let tip = guard.state.canonical_tip().unwrap();
        (tip.hash, tip.l1_origin.block_hash)
    };
    // Most open-route actions reward their poster with issuance alone; a
    // few carry an explicit tip.
    let transactions = (0..12u64)
        .map(|index| (index, 0))
        .chain([(12, 1_000), (13, 2_000)])
        .map(|(index, fee)| {
            paid_private_value_txbytes(
                recent,
                word(0x8001 + index * 16),
                1_800_000_500,
                fee,
                CircuitWord::ZERO,
                1,
            )
        })
        .collect::<Vec<_>>();
    let block = inbox_batch_block(
        GENESIS + 1,
        B256::repeat_byte(0xe1),
        parent_hash,
        transactions,
    );
    let outcome = inner
        .lock()
        .unwrap()
        .apply_block(&block, &AcceptVerify)
        .unwrap();
    assert!(item_results(&outcome)
        .iter()
        .all(|result| *result == SUCCEEDED));

    let estimate = NodeHandle::new(inner).estimate_fee(1_000).unwrap();
    assert_eq!(estimate.basis.included_samples, 2);
    assert!(!estimate.tiers.low.is_zero());
    assert!(!estimate.tiers.standard.is_zero());
}

fn unfunded_contract_txbytes(recent: B256, receive_key: &[u8], material: u64) -> Vec<u8> {
    Transaction::ContractAccountCreation(ContractAccountCreation {
        body: ContractBody::new(
            false,
            word(material),
            (!receive_key.is_empty()).then(|| common::receive_key(receive_key)),
            vec![ContractFunction {
                selector: 0,
                application_vk_hash: word(0x52),
                configuration_commitment: word(0x53),
            }],
        )
        .unwrap(),
        recent_pcash_block_hash: recent,
        valid_until_timestamp: 1_800_000_500,
    })
    .encode(PCASH_CHAIN_ID)
    .unwrap()
}

#[tokio::test]
async fn reused_attachment_preserves_creation_provenance_through_rebuild_and_reorg() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("state.redb");
    let cfg = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        GENESIS,
        genesis_block().header.hash,
    );
    let inner = build_node(&path, &cfg).unwrap();
    inner
        .lock()
        .unwrap()
        .apply_block(&genesis_block(), &NoVerify)
        .unwrap();
    let recent = inner.lock().unwrap().state.canonical_tip().unwrap().hash;
    let make = |seed| {
        contract_txbytes(
            0x914,
            paid_private_value_section(recent, word(seed), 1_800_000_500, 0, CircuitWord::ZERO, 1),
        )
    };
    let first = make(0x9140);
    let second = make(0x9150);
    let pcash_derive::AdmittedTransaction::PrivateValue(_, Some(check)) =
        pcash_derive::AdmittedTransaction::decode(&first, PCASH_CHAIN_ID).unwrap()
    else {
        panic!("contract attachment")
    };
    let address = check.address().unwrap();
    let first_block = inbox_batch_block(
        GENESIS + 1,
        B256::repeat_byte(0xd1),
        genesis_block().header.hash,
        vec![first.clone()],
    );
    let second_block = inbox_batch_block(
        GENESIS + 2,
        B256::repeat_byte(0xd2),
        first_block.header.hash,
        vec![second.clone()],
    );
    let first_result = inner
        .lock()
        .unwrap()
        .apply_block(&first_block, &AcceptVerify)
        .unwrap();
    let second_result = inner
        .lock()
        .unwrap()
        .apply_block(&second_block, &AcceptVerify)
        .unwrap();
    assert_eq!(
        first_result.committed_boundary.block.transaction_results[0].account_creation,
        1
    );
    assert_eq!(
        second_result.committed_boundary.block.transaction_results[0].account_creation,
        2
    );
    assert!(second_result.transaction_effects[0]
        .accepted()
        .unwrap()
        .account
        .is_none());
    assert_eq!(inner.lock().unwrap().state.account_count(), 1);
    let handle = NodeHandle::new(inner.clone());
    let assert_original = || {
        let pcash_rpc::ContractResultDto::Contract(contract) =
            handle.get_contract(address).unwrap()
        else {
            panic!("contract material")
        };
        assert_eq!(contract.transaction.as_ref(), first.as_slice());
    };
    assert_original();
    inner
        .lock()
        .unwrap()
        .set_index_lifecycle(pcash_node::index::DerivedIndexLifecycle::Unavailable);
    pcash_node::catch_up_derived_index(&path, &inner)
        .await
        .unwrap();
    assert_original();
    inner.lock().unwrap().rollback_to(GENESIS + 1).unwrap();
    assert_original();
    assert_eq!(inner.lock().unwrap().state.account_count(), 1);
    inner.lock().unwrap().rollback_to(GENESIS).unwrap();
    assert!(handle.get_account(address).unwrap().is_none());
    let replacement = inbox_batch_block(
        GENESIS + 1,
        B256::repeat_byte(0xd3),
        genesis_block().header.hash,
        vec![second.clone()],
    );
    let result = inner
        .lock()
        .unwrap()
        .apply_block(&replacement, &AcceptVerify)
        .unwrap();
    assert_eq!(
        result.committed_boundary.block.transaction_results[0].account_creation,
        1
    );
    let pcash_rpc::ContractResultDto::Contract(contract) = handle.get_contract(address).unwrap()
    else {
        panic!("replacement contract material")
    };
    assert_eq!(contract.transaction.as_ref(), second.as_slice());
}

#[tokio::test]
async fn unfunded_contract_material_receipts_rebuild_and_reorg_without_issuance() {
    use pcash_rpc::{ContractResultDto, ReceiveMaterialDto, TransactionsQuery};
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("state.redb");
    let cfg = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        GENESIS,
        genesis_block().header.hash,
    );
    let inner = build_node(&path, &cfg).unwrap();
    inner
        .lock()
        .unwrap()
        .apply_block(&genesis_block(), &NoVerify)
        .unwrap();
    let recent = inner.lock().unwrap().state.canonical_tip().unwrap().hash;
    let receive_key = vec![0x37; pcash_derive::ML_KEM768_PUBLIC_KEY_LEN];
    let creations = vec![
        unfunded_contract_txbytes(recent, &[], 0x51),
        unfunded_contract_txbytes(recent, &receive_key, 0x61),
    ];
    let addresses = creations
        .iter()
        .map(|raw| {
            let Ok(pcash_derive::AdmittedTransaction::ContractAccountCreation(_, check)) =
                pcash_derive::AdmittedTransaction::decode(raw, PCASH_CHAIN_ID)
            else {
                panic!("a contract creation");
            };
            check.address().unwrap()
        })
        .collect::<Vec<_>>();
    let block = inbox_batch_block(
        GENESIS + 1,
        B256::repeat_byte(0xf1),
        genesis_block().header.hash,
        creations.clone(),
    );
    let outcome = inner
        .lock()
        .unwrap()
        .apply_block(&block, &NoVerify)
        .unwrap();
    assert!(item_results(&outcome)
        .iter()
        .all(|result| *result == SUCCEEDED));
    let handle = NodeHandle::new(inner.clone());
    let status = handle.status().unwrap();
    assert_eq!(inner.lock().unwrap().state.account_count(), 2);
    assert_eq!(status.output_count, 0);
    assert_eq!(status.issued_so_far, U256::ZERO);
    let transactions = handle
        .get_transactions(TransactionsQuery {
            kind: Some(TransactionKind::ContractAccount),
            ..TransactionsQuery::default()
        })
        .unwrap();
    assert_eq!(transactions.items.len(), 2);
    for summary in &transactions.items {
        assert_eq!(summary.account_creation, 1);
        assert_eq!(summary.declared_open_fee_amount, None);
        assert_eq!(summary.declared_issuance_owner_commitment, None);
        assert_eq!(summary.issuance_route, pcash_rpc::IssuanceRoute::None);
        assert_eq!(summary.outputs_added, 0);
        assert_eq!(summary.nullifiers, None);
        let receipt = handle
            .get_receipt(ReceiptQuery::tx_id(summary.tx_id))
            .unwrap()
            .remove(0);
        assert!(receipt.accepted());
        assert_eq!(receipt.account_creation, 1);
        assert_eq!(receipt.issuance_owner_commitment, None);
        assert_eq!(receipt.settled_open_fee_amount, U256::ZERO);
        assert_eq!(receipt.settled_issuance_amount, U256::ZERO);
    }
    for (slot, address) in addresses.iter().enumerate() {
        let account = handle.get_account(*address).unwrap().unwrap();
        assert_eq!(account.account_kind, 1);
        assert_eq!(account.account_revision, 1);
        assert_eq!(account.receive_key_hash != B256::ZERO, slot == 1);
        assert_eq!(
            account.material,
            if slot == 1 {
                ReceiveMaterialDto::Available {
                    ml_kem768_public_key: receive_key.clone().into(),
                }
            } else {
                ReceiveMaterialDto::NotPresent
            }
        );
        let ContractResultDto::Contract(contract) = handle.get_contract(*address).unwrap() else {
            panic!("unfunded creation must retain contract material");
        };
        assert_eq!(contract.transaction.as_ref(), creations[slot].as_slice());
        assert_eq!(contract.functions.len(), 1);
        assert_eq!(contract.functions[0].application_vk_hash, word(0x52));
        assert_eq!(contract.functions[0].configuration_commitment, word(0x53));
    }
    inner
        .lock()
        .unwrap()
        .set_index_lifecycle(pcash_node::index::DerivedIndexLifecycle::Unavailable);
    pcash_node::catch_up_derived_index(&path, &inner)
        .await
        .unwrap();
    for address in &addresses {
        assert!(matches!(
            handle.get_contract(*address).unwrap(),
            ContractResultDto::Contract(_)
        ));
    }
    inner.lock().unwrap().rollback_to(GENESIS).unwrap();
    for address in &addresses {
        assert!(handle.get_account(*address).unwrap().is_none());
        assert!(matches!(
            handle.get_contract(*address).unwrap(),
            ContractResultDto::NotFound { .. }
        ));
    }
    assert!(handle
        .get_transactions(TransactionsQuery::default())
        .unwrap()
        .items
        .is_empty());
    inner
        .lock()
        .unwrap()
        .apply_block(&block, &NoVerify)
        .unwrap();
    assert_eq!(inner.lock().unwrap().state.account_count(), 2);
    assert_eq!(handle.status().unwrap().issued_so_far, U256::ZERO);
    for address in addresses {
        assert!(matches!(
            handle.get_contract(address).unwrap(),
            ContractResultDto::Contract(_)
        ));
    }
}

/// A source registry that answers every lookup with `info`, and after whose
/// first lookup the index's storage fails.
struct StorageBreakingRegistry {
    info: pcash_node::index::ContractSourceInfo,
    storage_fails: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl pcash_node::index::ContractVerificationLookup for StorageBreakingRegistry {
    fn lookup(
        &self,
        _address: Address,
        _functions: &[pcash_node::index::ContractFunctionMaterial],
    ) -> Option<pcash_node::index::ContractSourceInfo> {
        self.storage_fails
            .store(true, std::sync::atomic::Ordering::SeqCst);
        Some(self.info)
    }
}

/// A registry change made while the index is not ready is indexed by the
/// refresh that ends recovery. When that refresh's write fails, the index is
/// unavailable again and recovery repeats the refresh, with no further
/// canonical block.
#[tokio::test(start_paused = true)]
async fn failed_verification_refresh_after_index_recovery_is_retried() {
    use common::{FaultyBackend, IndexMetrics};
    use pcash_metrics::Metrics;
    use pcash_node::index::{ContractSourceInfo, DerivedIndexLifecycle};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("state.redb");
    let cfg = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        GENESIS,
        genesis_block().header.hash,
    );
    let inner = build_node(&path, &cfg).unwrap();
    inner
        .lock()
        .unwrap()
        .apply_block(&genesis_block(), &NoVerify)
        .unwrap();
    let recent = inner.lock().unwrap().state.canonical_tip().unwrap().hash;
    let creation = unfunded_contract_txbytes(recent, &[], 0x51);
    let Ok(pcash_derive::AdmittedTransaction::ContractAccountCreation(_, check)) =
        pcash_derive::AdmittedTransaction::decode(&creation, PCASH_CHAIN_ID)
    else {
        panic!("a contract creation");
    };
    let address = check.address().unwrap();
    let block = inbox_batch_block(
        GENESIS + 1,
        B256::repeat_byte(0xf1),
        genesis_block().header.hash,
        vec![creation],
    );
    inner
        .lock()
        .unwrap()
        .apply_block(&block, &NoVerify)
        .unwrap();
    let handle = NodeHandle::new(inner.clone());
    let tip = handle.status().unwrap();
    assert_eq!(tip.index.status, "ready");
    let indexed_source_info = || {
        inner
            .lock()
            .unwrap()
            .index
            .contract_source_info(address)
            .unwrap()
    };
    assert_eq!(indexed_source_info(), None);

    // The index is not ready when the registry verifies the contract, so the
    // change is not indexed.
    let storage_fails = Arc::new(AtomicBool::new(false));
    let verified = ContractSourceInfo {
        verified: true,
        opening_count: 9,
    };
    {
        let mut node = inner.lock().unwrap();
        pcash_node::reopen_index_with_backend(
            &mut node,
            FaultyBackend::open(&tmp.path().join("state.index.redb"), storage_fails.clone()),
        )
        .unwrap();
        let cursor = node.index.cursor().unwrap();
        node.set_index_lifecycle(DerivedIndexLifecycle::CatchingUp { cursor });
        node.contract_verification = Some(Arc::new(StorageBreakingRegistry {
            info: verified,
            storage_fails: storage_fails.clone(),
        }));
    }
    handle.contract_verification_changed(None).unwrap();
    assert_eq!(indexed_source_info(), None);
    assert!(!storage_fails.load(Ordering::SeqCst));

    // The first attempt finds the index at the tip and its refresh fails in
    // storage. The second, one second later, reopens the index and refreshes.
    let recorder = Arc::new(IndexMetrics::default());
    let metrics: Arc<dyn Metrics> = recorder.clone();
    let maintaining = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        pcash_node::maintain_derived_index(Some(&path), &inner, &metrics),
    )
    .await;
    assert!(maintaining.is_err());
    assert_eq!(recorder.write_failures.load(Ordering::SeqCst), 1);
    assert!(recorder.ready.load(Ordering::SeqCst));
    let status = handle.status().unwrap();
    assert_eq!(status.index.status, "ready");
    assert_eq!(status.latest_block_hash, tip.latest_block_hash);
    assert_eq!(indexed_source_info(), Some(verified));
}
