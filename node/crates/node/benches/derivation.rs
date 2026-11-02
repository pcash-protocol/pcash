//! Deterministic synthetic benchmark for the SparseTree catch-up workload.
//!
//! Run with:
//! `just bench-derivation`
//!
//! The target is gated behind the `benchmarks` feature so ordinary
//! `--all-targets` builds and lints do not compile it, so a direct invocation
//! needs `cargo bench -p pcash-node --features benchmarks --bench derivation`.
//!
//! The isolated cases compare 130 sequential `SparseTree::set_leaf` calls with
//! one `SparseTree::set_leaves` call for both dense new leaves and scattered
//! existing leaves. Leaves and indices are prepared before the timer so this
//! measures the Merkle-path work targeted by batching. The end-to-end case
//! measures ordinary L1 activity, canonical persistence, and index commits,
//! once with durable per-block commits (head) and once with catch-up's
//! non-durable canonical commits. These transactions create no PCASH entries;
//! each receipt carries `PCASH_BENCH_LOGS_PER_TX` logs.

#![allow(
    clippy::print_stdout,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "benchmark harness prints measurements and expects infallible fixture construction"
)]

use std::hint::black_box;
use std::time::{Duration, Instant};

use alloy_primitives::{Address, Bytes, B256};
use pcash_crypto::merkle;
use pcash_l1::{L1BlockData, L1Header, L1Log, L1Receipt, L1Tx};
use pcash_node::{build_node, NetworkConfig, NodeInner, DEFAULT_INBOX, L1_CHAIN_ID};
use pcash_state::{fr_to_bytes, SparseTree, StateDb, TREE_DEPTH};
use pcash_verify::{Verifier, VerifyError};

const PCASH_CHAIN_ID: u32 = 1346589512;
const GENESIS: u64 = 10_000_000;
const GENESIS_TIMESTAMP: u64 = 1_800_000_000;
const DEFAULT_SENDERS_PER_BLOCK: usize = 130;
const DEFAULT_WARMUP_BLOCKS: usize = 8;
const DEFAULT_MEASURE_BLOCKS: usize = 40;
const DEFAULT_LOGS_PER_TX: usize = 2;
const SCATTERED_LEAF_POOL: usize = 8_192;

struct NoVerify;

impl Verifier for NoVerify {
    fn verify(&self, _: &[u8], _: &[u8], _: &[u8]) -> Result<bool, VerifyError> {
        panic!("synthetic non-PCASH blocks must not invoke proof verification")
    }
}

#[derive(Clone, Copy)]
struct Stats {
    mean_ms: f64,
    median_ms: f64,
    p95_ms: f64,
}

impl Stats {
    fn new(samples: &[Duration]) -> Self {
        assert!(!samples.is_empty());
        let mut millis: Vec<f64> = samples
            .iter()
            .map(|sample| sample.as_secs_f64() * 1_000.0)
            .collect();
        millis.sort_by(f64::total_cmp);
        let mean_ms = millis.iter().sum::<f64>() / millis.len() as f64;
        let median_ms = if millis.len() % 2 == 0 {
            (millis[millis.len() / 2 - 1] + millis[millis.len() / 2]) / 2.0
        } else {
            millis[millis.len() / 2]
        };
        let p95_index = ((millis.len() as f64 * 0.95).ceil() as usize - 1).min(millis.len() - 1);
        Self {
            mean_ms,
            median_ms,
            p95_ms: millis[p95_index],
        }
    }

    fn print(self, label: &str) {
        println!(
            "{label}: mean_ms_per_block={:.3} median_ms={:.3} p95_ms={:.3} blocks_per_second={:.2}",
            self.mean_ms,
            self.median_ms,
            self.p95_ms,
            1_000.0 / self.mean_ms,
        );
    }
}

fn env_usize(name: &str, default: usize) -> usize {
    match std::env::var(name) {
        Ok(value) => value
            .parse::<usize>()
            .unwrap_or_else(|error| panic!("{name} must be a positive integer: {error}")),
        Err(_) => default,
    }
}

fn hash(number: u64) -> B256 {
    let mut bytes = [0u8; 32];
    bytes[24..].copy_from_slice(&number.to_be_bytes());
    B256::from(bytes)
}

fn sender(block_offset: usize, sender_offset: usize, senders_per_block: usize) -> Address {
    let ordinal = block_offset as u64 * senders_per_block as u64 + sender_offset as u64 + 1;
    let mut bytes = [0u8; 20];
    bytes[12..].copy_from_slice(&ordinal.to_be_bytes());
    Address::from(bytes)
}

fn leaf(block_offset: usize, sender_offset: usize, senders_per_block: usize) -> pcash_crypto::Fr {
    let ordinal = block_offset as u64 * senders_per_block as u64 + sender_offset as u64 + 1;
    pcash_crypto::Fr::from(ordinal)
}

fn synthetic_block(
    block_offset: usize,
    senders_per_block: usize,
    logs_per_tx: usize,
) -> L1BlockData {
    let number = GENESIS + block_offset as u64;
    let txs = (0..senders_per_block)
        .map(|sender_offset| {
            let tx = L1Tx {
                hash: hash((block_offset as u64 + 1) << 32 | sender_offset as u64),
                from: sender(block_offset, sender_offset, senders_per_block),
                // Deliberately not the inbox: these transactions exercise only
                // ordinary L1 activity without a PCASH entry.
                to: None,
                input: Bytes::new(),
                blob_versioned_hashes: Vec::new(),
                blob_resolution: Default::default(),
                tx_index: sender_offset as u64,
            };
            let receipt = L1Receipt {
                logs: (0..logs_per_tx)
                    .map(|log_offset| L1Log {
                        transaction_index: sender_offset as u64,
                        log_index: (sender_offset * logs_per_tx + log_offset) as u64,
                        emitter: sender(block_offset, sender_offset, senders_per_block),
                        topics: vec![hash(log_offset as u64 + 1)],
                        data: Bytes::from(vec![log_offset as u8; 64]),
                    })
                    .collect(),
            };
            (tx, receipt)
        })
        .collect();
    L1BlockData::new(
        L1Header {
            number,
            hash: hash(number),
            parent_hash: hash(number.saturating_sub(1)),
            timestamp: GENESIS_TIMESTAMP + block_offset as u64 * 12,
        },
        txs,
    )
}

fn benchmark_sparse_tree(
    senders_per_block: usize,
    warmup_blocks: usize,
    measure_blocks: usize,
    batched: bool,
) -> (Stats, B256) {
    let total_blocks = warmup_blocks + measure_blocks;
    let updates: Vec<Vec<_>> = (0..total_blocks)
        .map(|block| {
            (0..senders_per_block)
                .map(|sender_offset| {
                    let index = block * senders_per_block + sender_offset;
                    (index as u64, leaf(block, sender_offset, senders_per_block))
                })
                .collect()
        })
        .collect();
    let mut tree = SparseTree::new(TREE_DEPTH);
    let mut samples = Vec::with_capacity(measure_blocks);
    for (block, block_updates) in updates.iter().enumerate() {
        let started = Instant::now();
        if batched {
            tree.set_leaves(black_box(block_updates));
        } else {
            for &(index, value) in block_updates {
                tree.set_leaf(index, black_box(value));
            }
        }
        let elapsed = started.elapsed();
        black_box(tree.root());
        if block >= warmup_blocks {
            samples.push(elapsed);
        }
    }

    let final_index = total_blocks * senders_per_block - 1;
    let final_leaf = updates[total_blocks - 1][senders_per_block - 1].1;
    let path = tree.path(final_index as u64);
    assert_eq!(
        merkle::root_from_index(final_leaf, final_index as u64, &path),
        tree.root(),
        "final tree membership proof must match the measured root",
    );
    let root = fr_to_bytes(tree.root());
    (Stats::new(&samples), root)
}

fn benchmark_scattered_tree(
    senders_per_block: usize,
    warmup_blocks: usize,
    measure_blocks: usize,
    batched: bool,
) -> (Stats, B256) {
    let seed: Vec<_> = (0..SCATTERED_LEAF_POOL)
        .map(|index| (index as u64, leaf(SCATTERED_LEAF_POOL + index, 0, 1)))
        .collect();
    let total_blocks = warmup_blocks + measure_blocks;
    assert!(
        total_blocks * senders_per_block <= SCATTERED_LEAF_POOL,
        "scattered benchmark needs a larger leaf pool",
    );
    let updates: Vec<Vec<_>> = (0..total_blocks)
        .map(|block| {
            (0..senders_per_block)
                .map(|sender_offset| {
                    let ordinal = block * senders_per_block + sender_offset;
                    // Multiplication by an odd number permutes this power-of-two
                    // pool, spreading each block's touched indices across it.
                    let index = (ordinal * 4_051 + 17) % SCATTERED_LEAF_POOL;
                    (
                        index as u64,
                        leaf(block + 100_000, sender_offset, senders_per_block),
                    )
                })
                .collect()
        })
        .collect();

    let mut tree = SparseTree::new(TREE_DEPTH);
    tree.set_leaves(&seed);
    let mut samples = Vec::with_capacity(measure_blocks);
    for (block, block_updates) in updates.iter().enumerate() {
        let started = Instant::now();
        if batched {
            tree.set_leaves(black_box(block_updates));
        } else {
            for &(index, value) in block_updates {
                tree.set_leaf(index, black_box(value));
            }
        }
        let elapsed = started.elapsed();
        black_box(tree.root());
        if block >= warmup_blocks {
            samples.push(elapsed);
        }
    }

    let &(final_index, final_leaf) = updates.last().unwrap().last().unwrap();
    assert_eq!(
        merkle::root_from_index(final_leaf, final_index, &tree.path(final_index)),
        tree.root(),
        "final scattered-tree membership proof must match the measured root",
    );
    (Stats::new(&samples), fr_to_bytes(tree.root()))
}

fn apply_and_check(node: &mut NodeInner, block: &L1BlockData) {
    let outcome = node
        .apply_block(block, &NoVerify)
        .expect("synthetic block must derive");
    assert!(outcome.committed_boundary.history.payouts.is_empty());
    assert_eq!(node.head, Some(block.header.number));
    black_box(outcome.committed_boundary.block.header.state_root);
}

fn benchmark_node_apply(
    senders_per_block: usize,
    logs_per_tx: usize,
    warmup_blocks: usize,
    measure_blocks: usize,
    durable: bool,
) -> Stats {
    let temp = tempfile::tempdir().expect("create benchmark directory");
    let genesis_hash = hash(GENESIS);
    let cfg = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        GENESIS,
        genesis_hash,
    );
    let shared = build_node(&temp.path().join("state.redb"), &cfg).expect("build benchmark node");
    let mut node = shared.lock().expect("benchmark node lock");

    let genesis = L1BlockData::new(
        L1Header {
            number: GENESIS,
            hash: genesis_hash,
            parent_hash: hash(GENESIS - 1),
            timestamp: GENESIS_TIMESTAMP,
        },
        Vec::new(),
    );
    let genesis_outcome = node
        .apply_block(&genesis, &NoVerify)
        .expect("synthetic genesis must derive");
    assert!(genesis_outcome
        .committed_boundary
        .history
        .payouts
        .is_empty());
    node.state.set_persist_reorg_savepoint(durable);

    let mut samples = Vec::with_capacity(measure_blocks);
    for block_offset in 1..=warmup_blocks + measure_blocks {
        let block = synthetic_block(block_offset, senders_per_block, logs_per_tx);
        let started = Instant::now();
        apply_and_check(&mut node, &block);
        let elapsed = started.elapsed();
        if block_offset > warmup_blocks {
            samples.push(elapsed);
        }
    }

    assert_eq!(
        node.index
            .get_block(GENESIS + (warmup_blocks + measure_blocks) as u64)
            .expect("read final derived-index row")
            .expect("final derived-index row must exist")
            .payout_notes,
        0,
    );
    println!(
        "node_state_root=0x{}",
        hex::encode(node.state.state_root().as_bytes()),
    );
    Stats::new(&samples)
}

fn main() {
    let senders_per_block = env_usize("PCASH_BENCH_SENDERS", DEFAULT_SENDERS_PER_BLOCK);
    let warmup_blocks = env_usize("PCASH_BENCH_WARMUP_BLOCKS", DEFAULT_WARMUP_BLOCKS);
    let measure_blocks = env_usize("PCASH_BENCH_MEASURE_BLOCKS", DEFAULT_MEASURE_BLOCKS);
    let logs_per_tx = env_usize("PCASH_BENCH_LOGS_PER_TX", DEFAULT_LOGS_PER_TX);
    assert!(
        senders_per_block > 0,
        "PCASH_BENCH_SENDERS must be positive"
    );
    assert!(
        measure_blocks > 0,
        "PCASH_BENCH_MEASURE_BLOCKS must be positive"
    );
    assert!(
        (warmup_blocks + measure_blocks) * senders_per_block < 1usize << TREE_DEPTH,
        "benchmark workload exceeds the tree capacity",
    );
    println!(
        "pcash_derivation_benchmark senders_per_block={senders_per_block} logs_per_tx={logs_per_tx} warmup_blocks={warmup_blocks} measure_blocks={measure_blocks}"
    );
    let (sequential, sequential_root) =
        benchmark_sparse_tree(senders_per_block, warmup_blocks, measure_blocks, false);
    sequential.print("sparse_merkle_sequential");
    let (batched, batched_root) =
        benchmark_sparse_tree(senders_per_block, warmup_blocks, measure_blocks, true);
    batched.print("sparse_merkle_batched");
    assert_eq!(batched_root, sequential_root);
    println!(
        "sparse_merkle_dense_root=0x{} dense_sparse_speedup={:.2}x",
        hex::encode(batched_root),
        sequential.mean_ms / batched.mean_ms,
    );
    let (scattered_sequential, scattered_sequential_root) =
        benchmark_scattered_tree(senders_per_block, warmup_blocks, measure_blocks, false);
    scattered_sequential.print("sparse_merkle_scattered_sequential");
    let (scattered_batched, scattered_batched_root) =
        benchmark_scattered_tree(senders_per_block, warmup_blocks, measure_blocks, true);
    scattered_batched.print("sparse_merkle_scattered_batched");
    assert_eq!(scattered_batched_root, scattered_sequential_root);
    println!(
        "sparse_merkle_scattered_root=0x{} scattered_sparse_speedup={:.2}x",
        hex::encode(scattered_batched_root),
        scattered_sequential.mean_ms / scattered_batched.mean_ms,
    );
    let full = benchmark_node_apply(
        senders_per_block,
        logs_per_tx,
        warmup_blocks,
        measure_blocks,
        true,
    );
    full.print("node_inner_apply");
    benchmark_node_apply(
        senders_per_block,
        logs_per_tx,
        warmup_blocks,
        measure_blocks,
        false,
    )
    .print("node_inner_apply_catchup");
    println!(
        "node_minus_batched_sparse_mean_ms={:.3} batched_sparse_share_of_node_mean_pct={:.1}",
        full.mean_ms - batched.mean_ms,
        batched.mean_ms / full.mean_ms * 100.0,
    );
}
