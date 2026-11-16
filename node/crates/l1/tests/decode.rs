#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]
//! Offline decoding tests: real Sepolia block/receipt JSON (block 3000000, as
//! served by https://rpc.sepolia.ethpandaops.io) is deserialized into alloy
//! types and mapped through the domain conversions. Runs with no network.

use alloy_primitives::address;
use alloy_rpc_types_eth::{Block, BlockTransactions, TransactionReceipt};
use pcash_l1::client::{assemble_block, header_from, receipt_from, tx_from};
use pcash_l1::L1Error;

const BLOCK_JSON: &str = include_str!("fixtures/block_3000000.json");
const RECEIPTS_JSON: &str = include_str!("fixtures/receipts_3000000.json");

fn load() -> (Block, Vec<TransactionReceipt>) {
    let block: Block = serde_json::from_str(BLOCK_JSON).expect("decode block");
    let receipts: Vec<TransactionReceipt> =
        serde_json::from_str(RECEIPTS_JSON).expect("decode receipts");
    (block, receipts)
}

#[test]
fn header_decodes_expected_fields() {
    let (block, _) = load();
    let h = header_from(&block.header);
    assert_eq!(h.number, 3_000_000);
    // parent_hash and hash must differ and be nonzero.
    assert_ne!(h.hash, h.parent_hash);
    assert_ne!(h.hash, alloy_primitives::B256::ZERO);
    assert!(h.timestamp > 0);
}

#[test]
fn transactions_decode_sender_calldata_and_index() {
    let (block, _) = load();
    let txs = block.transactions.into_transactions_vec();
    assert_eq!(txs.len(), 4);
    let t0 = tx_from(&txs[0]).expect("tx0");
    assert_eq!(t0.tx_index, 0);
    assert_eq!(
        t0.from,
        address!("0x88130d3121eaf7f3285fdd7bbd3a1ef53f2d6e16")
    );
    assert_eq!(
        t0.to,
        Some(address!("0x5977bf230719fb405aaf2aadadd8e026000f2436"))
    );
    // Indices are sequential and monotonic.
    for (i, t) in txs.iter().enumerate() {
        assert_eq!(tx_from(t).unwrap().tx_index as usize, i);
    }
}

#[test]
fn captured_receipts_name_the_captured_block() {
    let (block, receipts) = load();
    for receipt in &receipts {
        assert_eq!(receipt.block_hash, Some(block.header.hash));
        assert_eq!(receipt.block_number, Some(block.header.inner.number));
    }
}

#[test]
fn assemble_aligns_txs_and_receipts() {
    let (block, receipts) = load();
    let data = assemble_block(block, receipts).expect("assemble");
    assert_eq!(data.txs.len(), 4);
    // Index alignment: pair i has tx_index i.
    for (i, (tx, _)) in data.txs.iter().enumerate() {
        assert_eq!(tx.tx_index as usize, i);
    }
}

#[test]
fn assemble_accepts_empty_full_block() {
    let (mut block, _) = load();
    block.transactions = BlockTransactions::Full(Vec::new());
    let data = assemble_block(block, Vec::new()).expect("empty full block");
    assert!(data.txs.is_empty());
}

#[test]
fn assemble_rejects_count_mismatch() {
    let (block, mut receipts) = load();
    receipts.pop();
    assert!(matches!(
        assemble_block(block, receipts),
        Err(L1Error::TxReceiptCountMismatch {
            block: 3_000_000,
            txs: 4,
            receipts: 3
        })
    ));
}

/// A captured receipt whose first log is padded to `topic_count` topics.
/// More than four cannot come from a canonical Ethereum block, but it is legal
/// JSON that a faulty or hostile RPC endpoint may return.
fn receipt_with_padded_topics(topic_count: usize) -> TransactionReceipt {
    let (_, receipts) = load();
    let mut value = serde_json::to_value(&receipts[1]).expect("serialize captured receipt");
    let topics = value["logs"][0]["topics"]
        .as_array_mut()
        .expect("captured log topics");
    let filler = topics[0].clone();
    while topics.len() < topic_count {
        topics.push(filler.clone());
    }
    serde_json::from_value(value).expect("decode padded receipt")
}

#[test]
fn receipt_from_rejects_more_than_four_topics() {
    let receipt = receipt_with_padded_topics(5);
    let err = receipt_from(&receipt, 0).unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("topics") && msg.contains('5'),
        "unexpected error: {msg}"
    );
}

#[test]
fn assemble_rejects_hostile_topic_count_receipt() {
    let (block, mut receipts) = load();
    // Keep the padded receipt at its captured index so alignment checks pass
    // and ingestion reaches the topic-count gate.
    receipts[1] = receipt_with_padded_topics(5);
    let err = assemble_block(block, receipts).unwrap_err();
    assert!(
        err.to_string().contains("topics"),
        "unexpected error: {err}"
    );
}

#[test]
fn receipt_from_accepts_canonical_four_topics() {
    let parsed =
        receipt_from(&receipt_with_padded_topics(4), 0).expect("canonical four-topic receipt");
    assert_eq!(parsed.logs[0].topics.len(), 4);
}

#[test]
fn transaction_without_an_index_is_fatal() {
    let (mut block, receipts) = load();
    let mut txs = block.transactions.clone().into_transactions_vec();
    txs[2].transaction_index = None;
    let hash = *txs[2].inner.tx_hash();
    assert!(matches!(tx_from(&txs[2]), Err(L1Error::MissingTxIndex(h)) if h == hash));
    block.transactions = BlockTransactions::Full(txs);
    assert!(matches!(
        assemble_block(block, receipts),
        Err(L1Error::MissingTxIndex(h)) if h == hash
    ));
}

#[test]
fn hash_only_and_uncle_bodies_are_not_read_as_empty_blocks() {
    let (mut block, _) = load();
    let hashes = block.transactions.hashes().collect::<Vec<_>>();
    block.transactions = BlockTransactions::Hashes(hashes);
    assert!(matches!(
        assemble_block(block.clone(), Vec::new()),
        Err(L1Error::NotFullTransactions(3_000_000))
    ));
    block.transactions = BlockTransactions::Uncle;
    assert!(matches!(
        assemble_block(block, Vec::new()),
        Err(L1Error::NotFullTransactions(3_000_000))
    ));
}

#[test]
fn reordered_transactions_are_rejected() {
    let (mut block, receipts) = load();
    let mut txs = block.transactions.clone().into_transactions_vec();
    txs.swap(1, 2);
    block.transactions = BlockTransactions::Full(txs);
    assert!(matches!(
        assemble_block(block, receipts),
        Err(L1Error::TxReceiptIndexMismatch {
            block: 3_000_000,
            position: 1,
            tx_index: 2,
            receipt_index: Some(1)
        })
    ));
}

#[test]
fn reordered_or_reindexed_receipts_are_rejected() {
    let (block, mut receipts) = load();
    receipts.swap(1, 2);
    assert!(matches!(
        assemble_block(block, receipts),
        Err(L1Error::TxReceiptIndexMismatch {
            block: 3_000_000,
            position: 1,
            tx_index: 1,
            receipt_index: Some(2)
        })
    ));

    let (block, mut receipts) = load();
    receipts[3].transaction_index = Some(0);
    assert!(matches!(
        assemble_block(block, receipts),
        Err(L1Error::TxReceiptIndexMismatch {
            block: 3_000_000,
            position: 3,
            tx_index: 3,
            receipt_index: Some(0)
        })
    ));
}
