//! Deterministic proof-friendly commitment to every canonical Ethereum log.

use crate::types::L1BlockData;
use alloy_primitives::{Address, B256};
use ark_ff::{PrimeField, Zero};
use pcash_crypto::{bytes32_limbs, domain_tags, fr_to_bytes, merkle, poseidon, Fr};
use rayon::iter::{IntoParallelRefIterator, ParallelIterator};
use rayon::slice::ParallelSlice;
use rayon::ThreadPool;
use std::num::NonZeroUsize;
use std::sync::OnceLock;

/// Fewer hashes than this run serially on the calling thread.
const PARALLEL_HASH_THRESHOLD: usize = 32;

pub const NORMALIZED_LOG_TREE_DEPTH: usize = 64;

/// One log of a block in leaf order; its position is its leaf index.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NormalizedLog {
    pub transaction_index: u64,
    pub log_index: u64,
    pub leaf: B256,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NormalizedLogBlock {
    pub root: B256,
    pub logs: Vec<NormalizedLog>,
    tree: PoseidonTree,
}

impl NormalizedLogBlock {
    pub fn empty() -> Self {
        let tree = PoseidonTree::new();
        Self {
            root: fr_to_bytes(tree.root()),
            logs: Vec::new(),
            tree,
        }
    }

    /// Rebuild a block's log tree from its logs in leaf order.
    pub fn from_logs(logs: Vec<NormalizedLog>) -> Self {
        let leaves = logs
            .iter()
            .map(|log| Fr::from_be_bytes_mod_order(log.leaf.as_slice()))
            .collect();
        let tree = PoseidonTree::from_leaves(leaves);
        Self {
            root: fr_to_bytes(tree.root()),
            logs,
            tree,
        }
    }

    pub fn count(&self) -> u64 {
        self.logs.len() as u64
    }

    /// Nodes that can be returned as siblings for an opening in this block.
    /// The unpaired last node at any level, the single-node spine, and the root
    /// can never be siblings and are omitted.
    pub fn tree_nodes(&self) -> impl Iterator<Item = (u8, u64, B256)> + '_ {
        self.tree
            .levels
            .iter()
            .take(NORMALIZED_LOG_TREE_DEPTH)
            .enumerate()
            .take_while(|(_, level)| level.len() > 1)
            .flat_map(|(height, level)| {
                level
                    .iter()
                    .take(level.len() & !1)
                    .enumerate()
                    .map(move |(index, node)| (height as u8, index as u64, fr_to_bytes(*node)))
            })
    }
}

/// Rayon workers for log hashing, and catch-up in-flight block hashes.
///
/// Defaults to available parallelism until [`set_hash_concurrency`] pins a
/// value. The node CLI owns the operator default and `PCASH_HASH_THREADS`.
pub fn hash_concurrency() -> usize {
    *hash_concurrency_slots()
        .get_or_init(|| std::thread::available_parallelism().map_or(1, NonZeroUsize::get))
}

/// Pin the worker count before the first hash. Ignored if hashing has already
/// started.
pub fn set_hash_concurrency(threads: usize) {
    if threads >= 1 {
        let _ = hash_concurrency_slots().set(threads);
    }
}

fn hash_concurrency_slots() -> &'static OnceLock<usize> {
    static THREADS: OnceLock<usize> = OnceLock::new();
    &THREADS
}

#[allow(
    clippy::expect_used,
    reason = "catch-up cannot hash logs without a rayon pool"
)]
fn hash_pool() -> &'static ThreadPool {
    static POOL: OnceLock<ThreadPool> = OnceLock::new();
    POOL.get_or_init(|| {
        rayon::ThreadPoolBuilder::new()
            .num_threads(hash_concurrency())
            .thread_name(|index| format!("pcash-hash-{index}"))
            .build()
            .expect("normalized-log hash pool")
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PoseidonTree {
    levels: Vec<Vec<Fr>>,
}

impl PoseidonTree {
    fn new() -> Self {
        Self::from_leaves(Vec::new())
    }

    /// Large levels are hashed on the hash pool, like the leaves.
    fn from_leaves(leaves: Vec<Fr>) -> Self {
        let levels =
            merkle::dense_levels_with(leaves, NORMALIZED_LOG_TREE_DEPTH, |level, height| {
                let parent = |pair: &[Fr]| merkle::dense_parent(pair, height);
                if level.len().div_ceil(2) < PARALLEL_HASH_THRESHOLD {
                    level.chunks(2).map(parent).collect()
                } else {
                    on_hash_pool(|| level.par_chunks(2).map(parent).collect())
                }
            });
        Self { levels }
    }

    fn node(&self, height: usize, index: u64) -> Fr {
        usize::try_from(index)
            .ok()
            .and_then(|index| self.levels[height].get(index))
            .copied()
            .unwrap_or_else(|| merkle::empty(height))
    }

    fn root(&self) -> Fr {
        self.node(NORMALIZED_LOG_TREE_DEPTH, 0)
    }

    #[cfg(test)]
    fn path(&self, index: u64) -> Vec<Fr> {
        let mut current_index = index;
        let mut path = Vec::with_capacity(NORMALIZED_LOG_TREE_DEPTH);
        for height in 0..NORMALIZED_LOG_TREE_DEPTH {
            path.push(self.node(height, current_index ^ 1));
            current_index >>= 1;
        }
        path
    }

    #[cfg(test)]
    fn hash_count(&self) -> usize {
        self.levels.iter().skip(1).map(Vec::len).sum()
    }
}

/// Canonical empty node at every normalized-log tree height. Index proof reads
/// use this shared table when the requested sibling was not materialized.
pub fn normalized_log_empty_nodes() -> &'static [B256; NORMALIZED_LOG_TREE_DEPTH + 1] {
    static EMPTY: OnceLock<[B256; NORMALIZED_LOG_TREE_DEPTH + 1]> = OnceLock::new();
    EMPTY.get_or_init(|| std::array::from_fn(|height| fr_to_bytes(merkle::empty(height))))
}

fn address_field(value: Address) -> Fr {
    Fr::from_be_bytes_mod_order(value.as_slice())
}

/// Hash inputs before the data chunks: domain, transaction index, log index,
/// emitter, topic count, eight topic limbs, data length.
const LOG_LEAF_HEADER_INPUTS: usize = 14;
const MIN_DATA_CHUNKS: usize = 8;

/// Chunk slots for `len` bytes of log data or carrier context.
pub(crate) fn data_chunk_slots(len: usize) -> usize {
    len.div_ceil(16).max(MIN_DATA_CHUNKS)
}

/// Append `data` as 16-byte big-endian chunks, the last the integer of its own
/// bytes, zero-padded to at least eight (§7.2).
pub(crate) fn push_data_chunks(inputs: &mut Vec<Fr>, data: &[u8]) {
    let start = inputs.len();
    inputs.extend(data.chunks(16).map(Fr::from_be_bytes_mod_order));
    inputs.resize(start + data_chunk_slots(data.len()), Fr::zero());
}

fn log_leaf(
    transaction_index: u64,
    log_index: u64,
    emitter: Address,
    topics: &[B256],
    data: &[u8],
) -> Fr {
    poseidon(&log_leaf_inputs(
        transaction_index,
        log_index,
        emitter,
        topics,
        data,
    ))
}

fn log_leaf_inputs(
    transaction_index: u64,
    log_index: u64,
    emitter: Address,
    topics: &[B256],
    data: &[u8],
) -> Vec<Fr> {
    let mut inputs = Vec::with_capacity(LOG_LEAF_HEADER_INPUTS + data_chunk_slots(data.len()));
    inputs.extend([
        domain_tags::L1_LOG_DOMAIN,
        Fr::from(transaction_index),
        Fr::from(log_index),
        address_field(emitter),
        Fr::from(topics.len() as u64),
    ]);
    let mut topic_limbs = [Fr::zero(); 8];
    for (index, topic) in topics.iter().enumerate() {
        let (high, low) = bytes32_limbs(topic.as_ref());
        topic_limbs[index * 2] = high;
        topic_limbs[index * 2 + 1] = low;
    }
    inputs.extend(topic_limbs);
    inputs.push(Fr::from(data.len() as u64));
    push_data_chunks(&mut inputs, data);
    inputs
}

fn log_refs(block: &L1BlockData) -> Vec<&crate::types::L1Log> {
    block
        .txs
        .iter()
        .flat_map(|(_, receipt)| receipt.logs.iter())
        .collect()
}

fn leaf_for(log: &crate::types::L1Log) -> Fr {
    log_leaf(
        log.transaction_index,
        log.log_index,
        log.emitter,
        &log.topics,
        &log.data,
    )
}

fn hash_leaves(logs: &[&crate::types::L1Log]) -> Vec<Fr> {
    if logs.len() < PARALLEL_HASH_THRESHOLD {
        return logs.iter().copied().map(leaf_for).collect();
    }
    on_hash_pool(|| logs.par_iter().copied().map(leaf_for).collect())
}

/// Run `job` on the hash pool, or in place when already on a pool thread.
fn on_hash_pool<T: Send>(job: impl FnOnce() -> T + Send) -> T {
    if rayon::current_thread_index().is_some() {
        job()
    } else {
        hash_pool().install(job)
    }
}

/// Hash receipt logs in `blocks` on the shared pool so a later
/// [`L1BlockData::normalized_logs`] call is a cache hit. Safe to call more
/// than once.
pub fn prepare_normalized_logs(blocks: &[L1BlockData]) {
    if blocks.is_empty() {
        return;
    }
    hash_pool().install(|| {
        blocks.par_iter().for_each(|block| {
            let _ = block.normalized_logs();
        });
    });
}

pub fn normalize_block(block: &L1BlockData) -> NormalizedLogBlock {
    let refs = log_refs(block);
    let leaves = hash_leaves(&refs);
    let logs = refs
        .iter()
        .zip(&leaves)
        .map(|(log, leaf)| NormalizedLog {
            transaction_index: log.transaction_index,
            log_index: log.log_index,
            leaf: fr_to_bytes(*leaf),
        })
        .collect();
    let tree = PoseidonTree::from_leaves(leaves);
    NormalizedLogBlock {
        root: fr_to_bytes(tree.root()),
        logs,
        tree,
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    reason = "tests use direct assertions for fixture setup"
)]
mod tests {
    use super::*;
    use crate::types::{L1Header, L1Log, L1Receipt, L1Tx};
    use alloy_primitives::{address, b256, hex, Bytes};
    use pcash_crypto::merkle;

    #[test]
    fn default_hash_concurrency_is_at_least_one() {
        assert!(hash_concurrency() >= 1);
    }

    fn fixture() -> L1BlockData {
        let log = L1Log {
            transaction_index: 0,
            log_index: 0,
            emitter: address!("1111111111111111111111111111111111111111"),
            topics: vec![b256!(
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            )],
            data: Bytes::from_static(&[1, 2, 3]),
        };
        L1BlockData::new(
            L1Header {
                number: 9,
                hash: b256!("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
                parent_hash: B256::ZERO,
                timestamp: 123,
            },
            vec![(
                L1Tx {
                    hash: B256::ZERO,
                    from: Address::ZERO,
                    to: None,
                    input: Bytes::new(),
                    blob_versioned_hashes: Vec::new(),
                    blob_resolution: Default::default(),
                    tx_index: 0,
                },
                L1Receipt { logs: vec![log] },
            )],
        )
    }

    #[test]
    fn normalized_log_proof_rebuilds_root() {
        let block = fixture();
        let normalized = block.normalized_logs();
        let leaf = normalized.tree.node(0, 0);
        let siblings = normalized.tree.path(0);
        assert_eq!(siblings.len(), 64);
        assert_eq!(
            fr_to_bytes(merkle::root_from_index(leaf, 0, &siblings)),
            normalized.root,
        );
    }

    #[test]
    fn marketplace_payment_leaf_matches_the_browser_and_noir_vector() {
        let topics = vec![
            b256!("c02c8dd7548cf1c2910d8245edc9a318c696615c2bd0d630c6d0e9a130754b0c"),
            b256!("0000000000000000000000000000000000000000000000000ffe100000000001"),
            b256!("000000000000000000000000000000000000000000000000000000000000d0d0"),
            b256!("000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266"),
        ];
        let data = hex!(
            "0000000000000000000000000000000000000000000000000000000050435348"
            "0000000000000000000000000000000000000000000000000de0b6b3a7640000"
            "0000000000000000000000000000000000000000000000000000000077359400"
            "23881371056048ee03fb4e8941cc78741871ed41c13e31684712d985e69c57e2"
        );
        assert_eq!(
            fr_to_bytes(log_leaf(
                1,
                1,
                address!("5fbdb2315678afecb367f032d93f642f64180aa3"),
                &topics,
                &data,
            )),
            b256!("045d9f041cb3d786fb8f1bfe2e1fa41e448a40180259f5b9630817a8f180cb4f")
        );
    }

    #[test]
    fn log_leaves_match_published_vectors() {
        let vectors: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../vectors/protocol_vectors.json"
        )))
        .unwrap();
        let word = |value: &serde_json::Value| value.as_str().unwrap().parse::<B256>().unwrap();
        let mut shapes = Vec::new();
        for log in vectors["l1Logs"].as_array().unwrap() {
            let transaction_index = log["transactionIndex"].as_u64().unwrap();
            let log_index = log["logIndex"].as_u64().unwrap();
            let emitter: Address = log["emitter"].as_str().unwrap().parse().unwrap();
            let topics: Vec<B256> = log["topics"].as_array().unwrap().iter().map(word).collect();
            let data = hex::decode(log["data"].as_str().unwrap()).unwrap();
            let expected_inputs: Vec<Fr> = log["inputs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|input| Fr::from_be_bytes_mod_order(word(input).as_slice()))
                .collect();
            assert_eq!(
                log_leaf_inputs(transaction_index, log_index, emitter, &topics, &data),
                expected_inputs
            );
            assert_eq!(
                fr_to_bytes(log_leaf(
                    transaction_index,
                    log_index,
                    emitter,
                    &topics,
                    &data
                )),
                word(&log["leaf"])
            );
            shapes.push((
                data.len(),
                expected_inputs.len(),
                log["inputCount"].as_u64().unwrap(),
            ));
        }
        assert_eq!(shapes, [(128, 22, 22), (200, 27, 27)]);
    }

    #[test]
    fn unrelated_logs_change_only_the_path_and_root() {
        let block = fixture();
        let target = block.txs[0].1.logs[0].clone();
        let mut wrapped = block;
        wrapped.txs[0].1.logs.insert(
            0,
            L1Log {
                transaction_index: 0,
                log_index: 0,
                emitter: address!("2222222222222222222222222222222222222222"),
                topics: vec![],
                data: Bytes::new(),
            },
        );
        wrapped.txs[0].1.logs[1].log_index = 1;
        let normalized = wrapped.normalized_logs();
        assert_eq!(normalized.logs[1].transaction_index, 0);
        assert_eq!(normalized.logs[1].log_index, 1);
        let target_leaf = log_leaf(0, 1, target.emitter, &target.topics, &target.data);
        let siblings = normalized.tree.path(1);
        assert_eq!(normalized.tree.node(0, 1), target_leaf);
        assert_eq!(siblings.len(), NORMALIZED_LOG_TREE_DEPTH);
        assert_eq!(
            merkle::root_from_index(target_leaf, 1, &siblings),
            Fr::from_be_bytes_mod_order(normalized.root.as_slice()),
        );
    }

    #[test]
    fn logs_rebuild_the_tree_they_were_normalized_into() {
        let mut block = fixture();
        block.txs[0].1.logs = (0..5)
            .map(|log_index| L1Log {
                transaction_index: 0,
                log_index,
                emitter: Address::repeat_byte(log_index as u8 + 1),
                topics: vec![],
                data: Bytes::new(),
            })
            .collect();
        let normalized = block.normalized_logs();
        assert_eq!(
            &NormalizedLogBlock::from_logs(normalized.logs.clone()),
            normalized
        );
    }

    #[test]
    fn dense_tree_construction_is_linear_in_its_leaf_count() {
        for count in [0usize, 1, 3, 64, 4_097] {
            let leaves = (0..count).map(|value| Fr::from(value as u64 + 1)).collect();
            let tree = PoseidonTree::from_leaves(leaves);
            assert!(tree.hash_count() <= count + NORMALIZED_LOG_TREE_DEPTH);
        }
    }

    #[test]
    fn stored_nodes_exclude_the_unused_single_node_spine() {
        for count in [1usize, 2, 3, 64, 4_097] {
            let leaves = (0..count).map(|value| Fr::from(value as u64 + 1)).collect();
            let tree = PoseidonTree::from_leaves(leaves);
            let block = NormalizedLogBlock {
                root: fr_to_bytes(tree.root()),
                logs: Vec::new(),
                tree,
            };
            let stored = block.tree_nodes().count();
            assert!(stored < count * 2, "{count} leaves stored {stored} nodes");
        }
    }

    #[test]
    fn many_logs_with_large_data_produce_valid_openings() {
        let mut block = fixture();
        block.txs[0].1.logs = (0..64)
            .map(|index| L1Log {
                transaction_index: 0,
                log_index: index,
                emitter: Address::repeat_byte(index as u8),
                topics: vec![B256::repeat_byte(index as u8)],
                data: Bytes::from(vec![index as u8; 4_097]),
            })
            .collect();
        let normalized = block.normalized_logs();
        let leaf = normalized.tree.node(0, 63);
        let siblings = normalized.tree.path(63);
        assert_eq!(normalized.count(), 64);
        assert_eq!(siblings.len(), NORMALIZED_LOG_TREE_DEPTH);
        assert_eq!(
            fr_to_bytes(merkle::root_from_index(leaf, 63, &siblings)),
            normalized.root,
        );
    }

    #[test]
    fn parallel_tree_levels_match_serial() {
        let threshold = 2 * PARALLEL_HASH_THRESHOLD;
        for count in [0, 1, threshold - 1, threshold, threshold + 1, 1000] {
            let leaves: Vec<Fr> = (0..count as u64).map(Fr::from).collect();
            assert_eq!(
                PoseidonTree::from_leaves(leaves.clone()).levels,
                merkle::dense_levels(leaves, NORMALIZED_LOG_TREE_DEPTH),
            );
        }
    }

    #[test]
    fn parallel_leaf_hashing_matches_serial() {
        let mut block = fixture();
        block.txs[0].1.logs = (0..128)
            .map(|log_index| L1Log {
                transaction_index: 0,
                log_index,
                emitter: Address::repeat_byte((log_index % 250) as u8 + 1),
                topics: vec![B256::repeat_byte(log_index as u8)],
                data: Bytes::from(vec![log_index as u8; 32]),
            })
            .collect();
        let serial: Vec<_> = block.txs[0].1.logs.iter().map(leaf_for).collect();
        let parallel = hash_leaves(&log_refs(&block));
        assert_eq!(serial, parallel);
        let normalized = block.normalized_logs();
        assert_eq!(normalized.count(), 128);
        let leaf = normalized.tree.node(0, 127);
        let siblings = normalized.tree.path(127);
        assert_eq!(
            fr_to_bytes(merkle::root_from_index(leaf, 127, &siblings)),
            normalized.root,
        );
    }
}
