#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "tests use direct assertions for fixture setup"
)]

use super::*;
use crate::{build_node, NetworkConfig, DEFAULT_INBOX, L1_CHAIN_ID, PCASH_CHAIN_ID};
use pcash_l1::{L1BlockData, L1Header, L1Receipt, L1Tx};
use pcash_rpc::{WitnessL1LogQuery, WitnessSnapshotQuery};
use pcash_verify::{Verifier, VerifyError};

struct NoVerify;
impl Verifier for NoVerify {
    fn verify(&self, _: &[u8], _: &[u8], _: &[u8]) -> Result<bool, VerifyError> {
        Ok(false)
    }
}

fn node() -> (tempfile::TempDir, NodeHandle) {
    let dir = tempfile::tempdir().unwrap();
    let genesis = L1BlockData::new(
        L1Header {
            number: 100,
            hash: B256::repeat_byte(1),
            parent_hash: B256::ZERO,
            timestamp: 1_800_000_000,
        },
        Vec::new(),
    );
    let config = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        100,
        genesis.header.hash,
    );
    let inner = build_node(&dir.path().join("state.redb"), &config).unwrap();
    inner
        .lock()
        .unwrap()
        .apply_block(&genesis, &NoVerify)
        .unwrap();
    (dir, NodeHandle::new(inner))
}

#[test]
fn fee_estimate_reads_the_window_for_a_byte_size() {
    let (_dir, node) = node();
    let estimate = node.estimate_fee(1_000).unwrap();
    assert_eq!(estimate.head.block_number, 0);
    assert_eq!(estimate.window_blocks, 1);
    assert_eq!(estimate.byte_size, 1_000);
    let basis = estimate.basis;
    assert_eq!(basis.included_samples, 0);
    assert_eq!(basis.pending_samples, 0);
    assert_eq!(estimate.tiers.standard, U256::ZERO);
}

#[test]
fn canonical_reads_survive_index_snapshot_acquisition_failure() {
    let (_dir, mut node) = node();
    let before = node.status().unwrap();
    assert_eq!(before.index.status, "ready");
    node.fail_index_read = true;
    assert!(node.read_index().is_err());

    let status = node.status().unwrap();
    assert_eq!(status.index.status, "unavailable");
    assert!(status.index.cursor.is_none());
    assert_eq!(status.issued_so_far, U256::ZERO);
    assert_eq!(status.latest_block_hash, before.latest_block_hash);
    assert_eq!(status.state_root, before.state_root);
    assert!(node.get_block(0, true).unwrap().is_some());
    assert!(node
        .get_block_by_hash(before.latest_block_hash, false)
        .unwrap()
        .is_some());
    assert_eq!(node.get_blocks(0, 0, false).unwrap().len(), 1);
    assert!(node.get_block_header(BlockTag::Latest).unwrap().is_some());
    assert!(node
        .get_payouts(pcash_rpc::PayoutQuery::default())
        .unwrap()
        .records
        .is_empty());
    assert!(node
        .get_issuance_quote(before.latest_block_timestamp)
        .unwrap()
        .is_some());
    assert!(node.get_output_path(0).unwrap().is_none());
    assert!(node.get_output_paths(&[0]).unwrap().is_none());
    assert_eq!(
        node.are_nullifiers_spent(&[B256::ZERO]).unwrap(),
        vec![false]
    );
    node.get_nullifier_proofs(&[B256::ZERO]).unwrap();
    assert!(node
        .get_block_header(BlockTag::Hash(before.latest_block_hash))
        .unwrap()
        .is_some());
    node.get_history_proof(before.latest_block_hash, 0).unwrap();
    node.get_l1_origin_proof(before.latest_block_hash, 100)
        .unwrap();

    assert!(matches!(
        node.get_receipt(ReceiptQuery::TxId(B256::ZERO)),
        Err(IndexReadError::Unavailable(message)) if message.contains("injected index snapshot failure")
    ));
    assert!(
        node.get_l1_delivery_batches(pcash_rpc::L1DeliveryBatchesRequest {
            l1_transaction_hash: B256::ZERO,
            continuation: None,
            limits: pcash_rpc::L1DeliveryBatchLimits {
                max_batches: 1,
                max_bytes: 1,
            },
        })
        .unwrap()
        .complete
    );
    assert!(node
        .get_block_payouts(BlockId {
            block_number: 0,
            block_hash: before.latest_block_hash,
        })
        .unwrap()
        .is_some());

    node.fail_index_read = false;
    assert_eq!(node.status().unwrap().index.status, "ready");
}

#[test]
fn canonical_witness_snapshots_survive_index_snapshot_acquisition_failure() {
    let sender = Address::repeat_byte(42);
    let (_dir, mut node) = node();
    node.inner()
        .lock()
        .unwrap()
        .apply_block(
            &L1BlockData::new(
                L1Header {
                    number: 101,
                    hash: B256::repeat_byte(2),
                    parent_hash: B256::repeat_byte(1),
                    timestamp: 1_800_000_012,
                },
                vec![(
                    L1Tx {
                        hash: B256::repeat_byte(50),
                        from: sender,
                        to: Some(Address::repeat_byte(43)),
                        input: Default::default(),
                        blob_versioned_hashes: Vec::new(),
                        blob_resolution: Default::default(),
                        tx_index: 0,
                    },
                    L1Receipt { logs: Vec::new() },
                )],
            ),
            &NoVerify,
        )
        .unwrap();

    for query in [
        WitnessSnapshotQuery::default(),
        WitnessSnapshotQuery {
            nullifiers: vec![B256::with_last_byte(7)],
            ..Default::default()
        },
        WitnessSnapshotQuery {
            outputs: vec![0],
            nullifiers: vec![B256::with_last_byte(7)],
            ..Default::default()
        },
    ] {
        let before = node.get_witness_snapshot(query.clone()).unwrap();
        assert_eq!(before.status.index.status, "ready");
        node.fail_index_read = true;
        let during = node.get_witness_snapshot(query.clone()).unwrap();
        assert_eq!(during.status.index.status, "unavailable");
        assert!(during.status.index.cursor.is_none());
        assert_eq!(during.status.issued_so_far, U256::ZERO);
        assert_eq!(
            during.status.latest_block_hash,
            before.status.latest_block_hash
        );
        assert_eq!(during.status.state_root, before.status.state_root);
        let hash = during.status.latest_block_hash;
        assert_eq!(during.block.as_ref().unwrap().hash, hash);
        assert_eq!(
            during.block_header.as_ref().unwrap().boundary.block_hash,
            hash
        );
        if let Some(nullifiers) = &during.nullifiers {
            assert_eq!(nullifiers.boundary.block_hash, hash);
        }
        let mut expected = serde_json::to_value(&before).unwrap();
        let mut actual = serde_json::to_value(&during).unwrap();
        expected.as_object_mut().unwrap().remove("status");
        actual.as_object_mut().unwrap().remove("status");
        assert_eq!(actual, expected);

        node.fail_index_read = false;
        let after = node.get_witness_snapshot(query).unwrap();
        assert_eq!(
            serde_json::to_value(after).unwrap(),
            serde_json::to_value(before).unwrap()
        );
    }
}

#[test]
fn indexed_witness_components_require_an_index_snapshot() {
    let (_dir, mut node) = node();
    for query in [
        WitnessSnapshotQuery {
            accounts: vec![Address::ZERO],
            ..Default::default()
        },
        WitnessSnapshotQuery {
            contracts: vec![Address::ZERO],
            ..Default::default()
        },
        WitnessSnapshotQuery {
            l1_logs: vec![WitnessL1LogQuery {
                l1_block_number: 100,
                transaction_index: 0,
                log_index: 0,
            }],
            ..Default::default()
        },
    ] {
        let query = WitnessSnapshotQuery {
            nullifiers: vec![B256::with_last_byte(7)],
            ..query
        };
        let before = node.get_witness_snapshot(query.clone()).unwrap();
        node.fail_index_read = true;
        assert!(matches!(
            node.get_witness_snapshot(query.clone()),
            Err(IndexReadError::Unavailable(message)) if message.contains("injected index snapshot failure")
        ));
        node.fail_index_read = false;
        let after = node.get_witness_snapshot(query).unwrap();
        assert_eq!(
            serde_json::to_value(after).unwrap(),
            serde_json::to_value(before).unwrap()
        );
    }
}

#[test]
fn a_halted_node_serves_its_published_status_when_canonical_reads_fail() {
    let (_dir, node) = node();
    let before = node.status().unwrap();
    let fail_reads = |fail| node.fail_canonical_reads.store(fail, Ordering::Relaxed);
    let halted = DerivationDto::Halted {
        cause: pcash_rpc::HaltCause::Storage,
        l1_block_number: 101,
        since_unix_ms: 7,
    };

    // With nothing published, the read failure is all there is to report.
    *node.derivation.write().unwrap() = halted;
    fail_reads(true);
    assert!(node.status().is_err());

    // A publish that cannot read the store keeps what was published before it.
    fail_reads(false);
    node.publish_status();
    fail_reads(true);
    node.publish_status();
    let status = node.status().unwrap();
    assert_eq!(status.derivation, halted);
    assert_eq!(status.latest_block, before.latest_block);
    assert_eq!(status.latest_block_hash, before.latest_block_hash);
    assert_eq!(status.latest_l1_block_number, before.latest_l1_block_number);
    assert_eq!(status.state_root, before.state_root);

    // A node that is still deriving reports the failure, not a status that may be old.
    *node.derivation.write().unwrap() = before.derivation;
    assert!(node.status().is_err());
    fail_reads(false);
    assert!(node.status().is_ok());
}
