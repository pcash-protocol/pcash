#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]

use alloy_primitives::{Address, Bytes, B256};
use pcash_l1::{L1BlockData, L1Header, L1Receipt, L1Tx};
use pcash_node::{
    build_node, NetworkConfig, NodeHandle, DEFAULT_INBOX, L1_CHAIN_ID, PCASH_CHAIN_ID,
};
use pcash_rpc::{request::WitnessSnapshotQuery, BlockId, NodeApi};
use pcash_verify::{Verifier, VerifyError};
use std::sync::mpsc;
use std::time::Duration;

const GENESIS: u64 = 100;

struct NoVerify;
impl Verifier for NoVerify {
    fn verify(&self, _: &[u8], _: &[u8], _: &[u8]) -> Result<bool, VerifyError> {
        Ok(false)
    }
}

fn sender() -> Address {
    Address::repeat_byte(42)
}

fn block(number: u64) -> L1BlockData {
    L1BlockData::new(
        L1Header {
            number: GENESIS + number,
            hash: B256::repeat_byte((number + 1) as u8),
            parent_hash: B256::repeat_byte(number as u8),
            timestamp: 1_800_000_000 + number * 12,
        },
        if number == 0 {
            Vec::new()
        } else {
            vec![(
                L1Tx {
                    hash: B256::repeat_byte(50),
                    from: sender(),
                    to: Some(Address::repeat_byte(43)),
                    input: Bytes::new(),
                    blob_versioned_hashes: Vec::new(),
                    blob_resolution: Default::default(),
                    tx_index: 0,
                },
                L1Receipt { logs: Vec::new() },
            )]
        },
    )
}

fn node() -> (tempfile::TempDir, NodeHandle) {
    let dir = tempfile::tempdir().unwrap();
    let config = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        GENESIS,
        block(0).header.hash,
    );
    let inner = build_node(&dir.path().join("state.redb"), &config).unwrap();
    inner
        .lock()
        .unwrap()
        .apply_block(&block(0), &NoVerify)
        .unwrap();
    let node = NodeHandle::new(inner);
    (dir, node)
}

fn while_writer_locked<T: Send + 'static>(
    node: &NodeHandle,
    read: impl FnOnce(NodeHandle) -> T + Send + 'static,
) -> T {
    let guard = node.inner().lock().unwrap();
    let reader = node.clone();
    let (send, receive) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        send.send(read(reader)).unwrap();
    });
    let result = receive.recv_timeout(Duration::from_secs(2));
    drop(guard);
    worker.join().unwrap();
    result.expect("RPC reads waited for the derivation mutex")
}

fn witnesses() -> WitnessSnapshotQuery {
    WitnessSnapshotQuery {
        accounts: vec![sender()],
        contracts: Vec::new(),
        outputs: Vec::new(),
        nullifiers: vec![B256::with_last_byte(7)],
        l1_logs: Vec::new(),
    }
}

#[test]
fn rpc_reads_complete_while_derivation_mutex_is_held() {
    let (_dir, node) = node();
    while_writer_locked(&node, |reader| {
        let status = reader.status().unwrap();
        assert_eq!(status.latest_block, 0);
        assert_eq!(status.index.status, "ready");
        let witness = reader.get_witness_snapshot(witnesses()).unwrap();
        assert!(reader
            .get_payouts(pcash_rpc::PayoutQuery::default())
            .unwrap()
            .records
            .is_empty());
        assert_eq!(
            reader
                .get_issuance_quote(status.latest_block_timestamp + 12)
                .unwrap()
                .unwrap()
                .parent
                .block_hash,
            status.latest_block_hash
        );
        assert_eq!(witness.status.state_root, status.state_root);
        assert_eq!(witness.status.latest_block_hash, status.latest_block_hash);
        assert_eq!(reader.get_blocks(0, 1, true).unwrap().len(), 1);
        assert!(reader.get_block(0, false).unwrap().is_some());
        assert!(reader
            .get_block_payouts(BlockId {
                block_number: 0,
                block_hash: status.latest_block_hash
            })
            .unwrap()
            .is_some());
    });
}

#[test]
fn canonical_rpc_reads_advance_while_the_index_retains_its_committed_prefix() {
    let (_dir, node) = node();
    let genesis = node.status().unwrap();
    let committed = {
        let mut writer = node.inner().lock().unwrap();
        let rules = std::sync::Arc::clone(&writer.rules);
        pcash_derive::derive_block(&mut writer.state, &block(1), &rules, &NoVerify)
            .unwrap()
            .committed_boundary
    };
    while_writer_locked(&node, move |reader| {
        let status = reader.status().unwrap();
        assert_eq!(status.latest_block, 1);
        assert_eq!(status.latest_block_hash, committed.block.hash);
        assert_eq!(status.state_root, committed.block.header.state_root);
        assert_eq!(status.index.status, "ready");
        let index_cursor = status.index.cursor.unwrap();
        assert_eq!(index_cursor.block_number, 0);
        assert_eq!(index_cursor.block_hash, genesis.latest_block_hash);
        let witness = reader.get_witness_snapshot(witnesses()).unwrap();
        assert!(reader
            .get_payouts(pcash_rpc::PayoutQuery::default())
            .unwrap()
            .records
            .is_empty());
        assert_eq!(
            reader
                .get_issuance_quote(status.latest_block_timestamp + 12)
                .unwrap()
                .unwrap()
                .parent
                .block_hash,
            status.latest_block_hash
        );
        assert_eq!(witness.status.latest_block_hash, committed.block.hash);
        assert_eq!(witness.status.state_root, committed.block.header.state_root);
        assert_eq!(reader.get_blocks(0, 1, true).unwrap().len(), 2);
        assert!(reader.get_block(1, false).unwrap().is_some());
        assert!(reader
            .get_block_payouts(BlockId {
                block_number: 0,
                block_hash: genesis.latest_block_hash
            })
            .unwrap()
            .is_some());
    });
}
