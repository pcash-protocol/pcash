//! Pure canonical state engine shared by the in-memory and redb backends.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "internal state invariants use fixed-width encodings validated at mutation boundaries"
)]

use crate::commitment_tree::TypedCommitmentTree;
use crate::field::{addr_to_fr, fr_from_internal_word, fr_to_bytes, restore_entry, u256_to_fr};
use crate::nullifier_tree::NullifierTreeUndo;
use crate::tree::{SparseTree, SparseTreeUndo};
use crate::{
    l1_origin_leaf, AccountState, AccountWrite, Address, BlockInput, BlockUpdate,
    BoundaryRetention, CommittedBoundary, DerivationSource, NullifierTree, PcashBlock,
    StateComponents, StateOutcome, StateRoot, StoredBlock, TreeId, I256, NULLIFIER_TREE_DEPTH,
    U256,
};
use alloy_primitives::B256;
use ark_ff::Zero;
use pcash_crypto::{bytes32_limbs, domain_tags, merkle, poseidon, Fr};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

pub const TREE_DEPTH: usize = 40;
pub const STATE_TREE_DEPTH: usize = 4;
pub const STATE_LEAF_COUNT: usize = 9;

pub const STATE_KEY_OUTPUT_ROOT: u64 = 0;
pub const STATE_KEY_OUTPUT_COUNT: u64 = 1;
pub const STATE_KEY_ISSUED_SO_FAR: u64 = 2;
pub const STATE_KEY_LAG_HIGH128: u64 = 3;
pub const STATE_KEY_LAG_LOW128: u64 = 4;
pub const STATE_KEY_ACCOUNT_STATE_ROOT: u64 = 5;
pub const STATE_KEY_ACCOUNT_COUNT: u64 = 6;
pub const STATE_KEY_NULLIFIER_ROOT: u64 = 7;
pub const STATE_KEY_NULLIFIER_COUNT: u64 = 8;
pub const RECENT_PCASH_BLOCK_WINDOW_SECONDS: u64 = 3_600;
pub const MAX_LEAVES: u64 = 1u64 << TREE_DEPTH;

const L1_ORIGIN_TREE_ID: usize = 2;
const PCASH_HISTORY_TREE_ID: usize = 3;
pub(crate) const NULLIFIER_TREE_ID: usize = 4;
/// Each tree's depth, by its id.
const TREE_DEPTHS: [usize; 5] = [
    TREE_DEPTH,
    TREE_DEPTH,
    TREE_DEPTH,
    TREE_DEPTH,
    NULLIFIER_TREE_DEPTH,
];

fn state_tree(leaves: &[Fr; STATE_LEAF_COUNT]) -> TypedCommitmentTree {
    TypedCommitmentTree::new(domain_tags::STATE_COMMITMENT_DOMAIN, leaves)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateCommitment {
    pub root: Fr,
    pub leaves: [Fr; STATE_LEAF_COUNT],
}

impl StateCommitment {
    pub fn new(components: StateComponents) -> Self {
        let lag_bytes = components.issuance.lag_q.into_raw().to_be_bytes::<32>();
        let (lag_high, lag_low) = bytes32_limbs(&lag_bytes);
        // Key order (`STATE_KEY_*`).
        let leaves = [
            fr_from_internal_word(components.output_root),
            Fr::from(components.output_count),
            u256_to_fr(components.issuance.issued_so_far),
            lag_high,
            lag_low,
            fr_from_internal_word(components.account_state_root),
            Fr::from(components.account_count),
            fr_from_internal_word(components.nullifier_root),
            Fr::from(components.nullifier_count),
        ];
        let root = state_tree(&leaves).root();
        Self { root, leaves }
    }

    pub fn path(&self, key: u64) -> Option<(Fr, [Fr; STATE_TREE_DEPTH])> {
        if key >= 1u64 << STATE_TREE_DEPTH {
            return None;
        }
        let tree = state_tree(&self.leaves);
        tree.path(key)
    }

    pub fn state_components(&self) -> StateComponents {
        let leaf = |key: u64| fr_to_bytes(self.leaves[key as usize]);
        let count = |key: u64| leaf(key)[24..].try_into().map(u64::from_be_bytes).unwrap();
        let mut lag = [0u8; 32];
        lag[..16].copy_from_slice(&leaf(STATE_KEY_LAG_HIGH128)[16..]);
        lag[16..].copy_from_slice(&leaf(STATE_KEY_LAG_LOW128)[16..]);
        StateComponents {
            output_root: leaf(STATE_KEY_OUTPUT_ROOT),
            output_count: count(STATE_KEY_OUTPUT_COUNT),
            issuance: pcash_issuance::IssuanceState {
                issued_so_far: U256::from_be_slice(leaf(STATE_KEY_ISSUED_SO_FAR).as_slice()),
                lag_q: I256::from_raw(U256::from_be_bytes(lag)),
            },
            account_state_root: leaf(STATE_KEY_ACCOUNT_STATE_ROOT),
            account_count: count(STATE_KEY_ACCOUNT_COUNT),
            nullifier_root: leaf(STATE_KEY_NULLIFIER_ROOT),
            nullifier_count: count(STATE_KEY_NULLIFIER_COUNT),
        }
    }
}

pub fn state_root_from_components(components: StateComponents) -> StateRoot {
    StateRoot(fr_to_bytes(StateCommitment::new(components).root))
}

/// `receive_key_hash` is the canonical field encoding of
/// [`crate::receive_key_hash`], or zero for no receive key.
pub fn account_state_commitment(
    address: Address,
    nullifier_key_commitment: Fr,
    account_rule_set_commitment: Fr,
    kind: u8,
    revision: u32,
    receive_key_hash: B256,
) -> Fr {
    poseidon(&[
        domain_tags::ACCOUNT_STATE_COMMITMENT_DOMAIN,
        addr_to_fr(address),
        nullifier_key_commitment,
        account_rule_set_commitment,
        Fr::from(u64::from(kind)),
        Fr::from(u64::from(revision)),
        fr_from_internal_word(receive_key_hash),
    ])
}

/// `outputCommitment = poseidon(OUTPUT_COMMITMENT_DOMAIN, body, outputIndex)`.
pub fn output_commitment(body: Fr, output_index: u64) -> Fr {
    poseidon(&[
        domain_tags::OUTPUT_COMMITMENT_DOMAIN,
        body,
        Fr::from(output_index),
    ])
}

pub fn history_leaf(block_hash: B256) -> Fr {
    poseidon(&[
        domain_tags::HISTORY_LEAF_DOMAIN,
        fr_from_internal_word(block_hash),
    ])
}

/// The oldest block timestamp the recent-block window keeps while the tip has
/// `tip_timestamp`.
pub(crate) fn recent_window_start(tip_timestamp: u64) -> u64 {
    tip_timestamp.saturating_sub(RECENT_PCASH_BLOCK_WINDOW_SECONDS)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecentBlockEntry {
    pub timestamp: u64,
    pub hash: B256,
}

/// The canonical blocks at or after [`recent_window_start`] of the tip's
/// timestamp, oldest first.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RecentBlockHistory {
    order: VecDeque<RecentBlockEntry>,
}

impl RecentBlockHistory {
    /// Append the new tip and return the entries it evicts.
    fn push(&mut self, timestamp: u64, hash: B256) -> Vec<RecentBlockEntry> {
        self.order.push_back(RecentBlockEntry { timestamp, hash });
        let start = recent_window_start(timestamp);
        let mut evicted = Vec::new();
        while self
            .order
            .front()
            .is_some_and(|entry| entry.timestamp < start)
        {
            evicted.push(self.order.pop_front().unwrap());
        }
        evicted
    }

    /// Undo the last [`Self::push`], which evicted `evicted`.
    fn restore_push(&mut self, evicted: Vec<RecentBlockEntry>) {
        self.order.pop_back();
        for entry in evicted.into_iter().rev() {
            self.order.push_front(entry);
        }
    }

    pub fn contains(&self, hash: B256, current_timestamp: u64) -> bool {
        self.order.iter().any(|entry| {
            entry.hash == hash
                && current_timestamp
                    .checked_sub(entry.timestamp)
                    .is_some_and(|age| age <= RECENT_PCASH_BLOCK_WINDOW_SECONDS)
        })
    }

    pub fn from_vec(entries: Vec<RecentBlockEntry>) -> Self {
        Self {
            order: entries.into(),
        }
    }
}

#[derive(Clone, Default)]
pub struct BlockDelta {
    /// Each inserted nullifier with its leaf index.
    pub new_nullifiers: Vec<(B256, u64)>,
    pub touched_addrs: HashSet<Address>,
    /// Every account write in application order.
    pub account_writes: Vec<AccountWrite>,
    /// Output, account, L1 origin, PCASH history, and nullifier nodes.
    pub dirty_nodes: [HashSet<(u8, u64)>; 5],
}

impl BlockDelta {
    fn mark_leaf(&mut self, id: usize, index: u64) {
        for height in 0..=TREE_DEPTHS[id] as u8 {
            self.dirty_nodes[id].insert((height, index >> height));
        }
    }
}

pub struct InnerState {
    pub source: DerivationSource,
    pub canonical_genesis_hash: Option<B256>,
    pub canonical_genesis_timestamp: Option<u64>,
    pub canonical_tip: Option<StoredBlock>,
    /// Decoded canonical boundaries. MemState keeps the full history; RedbState
    /// drops each one once it is persisted and reads boundaries from storage.
    pub committed_boundaries: BTreeMap<u64, CommittedBoundary>,

    pub output_tree: SparseTree,
    pub account_state_tree: SparseTree,
    pub l1_origin_tree: SparseTree,
    /// Post-commit accumulator. Header N contains the root before leaf N is appended.
    pub history_tree: SparseTree,
    pub nullifier_tree: NullifierTree,

    pub output_count: u64,
    pub issuance: pcash_issuance::IssuanceState,
    pub account_count: u64,

    pub accounts: HashMap<Address, AccountState>,

    pub recent_block_history: RecentBlockHistory,
    pub last_delta: BlockDelta,
}

struct AddressUndo {
    account: Option<AccountState>,
}

pub(crate) struct InnerStateUndo {
    canonical_genesis_hash: Option<B256>,
    canonical_genesis_timestamp: Option<u64>,
    canonical_tip: Option<StoredBlock>,
    output_count: u64,
    issuance: pcash_issuance::IssuanceState,
    account_count: u64,
    addresses: HashMap<Address, AddressUndo>,
    trees: [SparseTreeUndo; 4],
    nullifier_tree: NullifierTreeUndo,
    /// The entries the recent-block push evicted.
    recent_block: Option<Vec<RecentBlockEntry>>,
    inserted_pcash_number: Option<u64>,
    last_delta: BlockDelta,
}

impl InnerState {
    pub fn new(source: DerivationSource) -> Self {
        Self {
            source,
            canonical_genesis_hash: None,
            canonical_genesis_timestamp: None,
            canonical_tip: None,
            committed_boundaries: BTreeMap::new(),
            output_tree: SparseTree::new(TREE_DEPTH),
            account_state_tree: SparseTree::new(TREE_DEPTH),
            l1_origin_tree: SparseTree::new(TREE_DEPTH),
            history_tree: SparseTree::new(TREE_DEPTH),
            nullifier_tree: NullifierTree::new(),
            output_count: 0,
            issuance: pcash_issuance::initial_state(),
            account_count: 0,
            accounts: HashMap::new(),
            recent_block_history: RecentBlockHistory::default(),
            last_delta: BlockDelta::default(),
        }
    }

    fn begin_undo(&mut self, update: &BlockUpdate) -> InnerStateUndo {
        let mut touched = HashSet::new();
        touched.extend(update.account_ops.iter().map(|operation| operation.address));
        let addresses = touched
            .into_iter()
            .map(|key| {
                (
                    key,
                    AddressUndo {
                        account: self.accounts.get(&key).copied(),
                    },
                )
            })
            .collect();
        InnerStateUndo {
            canonical_genesis_hash: self.canonical_genesis_hash,
            canonical_genesis_timestamp: self.canonical_genesis_timestamp,
            canonical_tip: self.canonical_tip.clone(),
            output_count: self.output_count,
            issuance: self.issuance,
            account_count: self.account_count,
            addresses,
            trees: std::array::from_fn(|_| SparseTreeUndo::default()),
            nullifier_tree: self.nullifier_tree.begin_undo(),
            recent_block: None,
            inserted_pcash_number: None,
            last_delta: std::mem::take(&mut self.last_delta),
        }
    }

    pub(crate) fn rollback(&mut self, undo: InnerStateUndo) {
        self.canonical_genesis_hash = undo.canonical_genesis_hash;
        self.canonical_genesis_timestamp = undo.canonical_genesis_timestamp;
        self.canonical_tip = undo.canonical_tip;
        self.output_count = undo.output_count;
        self.issuance = undo.issuance;
        self.account_count = undo.account_count;
        for (key, row) in undo.addresses {
            restore_entry(&mut self.accounts, key, row.account);
        }
        for (tree, tree_undo) in [
            &mut self.output_tree,
            &mut self.account_state_tree,
            &mut self.l1_origin_tree,
            &mut self.history_tree,
        ]
        .into_iter()
        .zip(undo.trees)
        {
            tree.restore(tree_undo);
        }
        self.nullifier_tree.restore(undo.nullifier_tree);
        if let Some(evicted) = undo.recent_block {
            self.recent_block_history.restore_push(evicted);
        }
        if let Some(number) = undo.inserted_pcash_number {
            self.committed_boundaries.remove(&number);
        }
        self.last_delta = undo.last_delta;
    }

    pub fn apply(&mut self, input: BlockInput, update: &BlockUpdate) -> CommittedBoundary {
        self.apply_reversible(input, update).0
    }

    pub(crate) fn apply_reversible(
        &mut self,
        input: BlockInput,
        update: &BlockUpdate,
    ) -> (CommittedBoundary, InnerStateUndo) {
        let mut undo = self.begin_undo(update);
        let mut delta = BlockDelta::default();
        let output_leaf_start = self.output_count;
        self.issuance = update.issuance;

        let mut output_leaves = Vec::with_capacity(update.output_commitments.len());
        for &commitment in &update.output_commitments {
            let index = self.output_count;
            output_leaves.push((index, commitment));
            delta.mark_leaf(TreeId::Output.index(), index);
            self.output_count += 1;
        }
        self.output_tree
            .set_leaves_with_undo(&output_leaves, &mut undo.trees[TreeId::Output.index()]);

        let mut account_leaves = Vec::with_capacity(update.account_ops.len());
        for operation in &update.account_ops {
            let key = operation.address;
            let row = if let Some(current) = self.accounts.get(&key).copied() {
                AccountState {
                    revision: current.revision.checked_add(1).unwrap(),
                    account_rule_set_commitment: operation.account_rule_set_commitment,
                    receive_key_hash: operation.receive_key_hash,
                    ..current
                }
            } else {
                let index = self.account_count;
                self.account_count += 1;
                AccountState {
                    index,
                    revision: 1,
                    nullifier_key_commitment: operation.nullifier_key_commitment,
                    account_rule_set_commitment: operation.account_rule_set_commitment,
                    kind: operation.kind,
                    receive_key_hash: operation.receive_key_hash,
                }
            };
            self.accounts.insert(key, row);
            account_leaves.push((
                row.index,
                account_state_commitment(
                    operation.address,
                    row.nullifier_key_commitment,
                    row.account_rule_set_commitment,
                    row.kind,
                    row.revision,
                    row.receive_key_hash,
                ),
            ));
            delta.mark_leaf(TreeId::Account.index(), row.index);
            delta.touched_addrs.insert(key);
            delta.account_writes.push(AccountWrite {
                address: key,
                account: row,
                published_receive_key: operation.published_receive_key.clone(),
            });
        }
        self.account_state_tree
            .set_leaves_with_undo(&account_leaves, &mut undo.trees[TreeId::Account.index()]);

        let insertion = self
            .nullifier_tree
            .insert_with_undo(&update.nullifiers, &mut undo.nullifier_tree);
        for leaf in insertion.rewritten {
            delta.mark_leaf(NULLIFIER_TREE_ID, leaf);
        }
        delta.new_nullifiers = insertion.inserted;

        let l1_origin_index = input.number;
        let leaf = l1_origin_leaf(&input.l1_origin);
        self.l1_origin_tree.set_leaf_with_undo(
            l1_origin_index,
            leaf,
            &mut undo.trees[L1_ORIGIN_TREE_ID],
        );
        delta.mark_leaf(L1_ORIGIN_TREE_ID, l1_origin_index);
        let components = self.state_components();
        let state = StateCommitment::new(components);
        let state_root = StateRoot(fr_to_bytes(state.root));
        let parent_hash = self.canonical_tip.as_ref().map_or_else(
            || fr_to_bytes(self.source.genesis_parent_hash()),
            |tip| tip.hash,
        );
        let history_root = self.history_tree.root();
        let block = PcashBlock::new(
            parent_hash,
            &input,
            state_root.0,
            self.l1_origin_tree.root(),
            history_root,
        );
        self.history_tree.set_leaf_with_undo(
            input.number,
            history_leaf(block.hash),
            &mut undo.trees[PCASH_HISTORY_TREE_ID],
        );
        delta.mark_leaf(PCASH_HISTORY_TREE_ID, input.number);
        let state_outcome = StateOutcome {
            state_root,
            output_leaf_start,
            outputs_added: update.output_commitments.len() as u64,
            inserted_nullifiers: update.nullifiers.clone(),
        };

        if input.number == 0 {
            self.canonical_genesis_hash = Some(block.hash);
            self.canonical_genesis_timestamp = Some(block.header.timestamp);
        }
        self.canonical_tip = Some(StoredBlock {
            header: block.header.clone(),
            hash: block.hash,
            l1_origin: input.l1_origin.clone(),
            state: components,
        });
        undo.inserted_pcash_number = Some(input.number);
        undo.recent_block = Some(
            self.recent_block_history
                .push(block.header.timestamp, block.hash),
        );
        self.last_delta = delta;

        let committed = CommittedBoundary {
            block,
            history: input.history,
            state,
            l1_origin: input.l1_origin,
            state_outcome,
        };
        self.committed_boundaries
            .insert(input.number, committed.clone());
        (committed, undo)
    }

    pub fn state_components(&self) -> StateComponents {
        StateComponents {
            output_root: fr_to_bytes(self.output_tree.root()),
            output_count: self.output_count,
            issuance: self.issuance,
            account_state_root: fr_to_bytes(self.account_state_tree.root()),
            account_count: self.account_count,
            nullifier_root: fr_to_bytes(self.nullifier_tree.root()),
            nullifier_count: self.nullifier_tree.count(),
        }
    }

    pub fn state_root(&self) -> StateRoot {
        state_root_from_components(self.state_components())
    }

    pub fn tree(&self, tree: TreeId) -> &SparseTree {
        match tree {
            TreeId::Output => &self.output_tree,
            TreeId::Account => &self.account_state_tree,
        }
    }

    pub fn root(&self, tree: TreeId) -> Fr {
        self.tree(tree).root()
    }

    pub fn account_of(&self, address: Address) -> Option<AccountState> {
        self.accounts.get(&address).copied()
    }

    pub fn recent_pcash_block_hash_in_window(
        &self,
        block_hash: B256,
        current_timestamp: u64,
    ) -> bool {
        self.recent_block_history
            .contains(block_hash, current_timestamp)
    }

    pub fn boundary_retention(&self) -> Option<BoundaryRetention> {
        let tip = self.canonical_tip.as_ref()?.header.number;
        Some(BoundaryRetention {
            oldest_contiguous: 0,
            tip,
        })
    }

    /// Drop durable history from the live representation after it has been
    /// persisted. Append-only trees, the output tree included, keep only their
    /// next-leaf frontiers; their permanent nodes stay in the store for paths.
    pub(crate) fn compact_durable_history(&mut self) {
        self.committed_boundaries.clear();
        let leaf_count = self
            .canonical_tip
            .as_ref()
            .map_or(0, |tip| tip.header.number.saturating_add(1));
        self.l1_origin_tree.retain_append_frontier(leaf_count);
        self.history_tree.retain_append_frontier(leaf_count);
        self.output_tree.retain_append_frontier(self.output_count);
    }

    fn append_only_node_at(
        tree: &SparseTree,
        last_included_index: u64,
        height: u8,
        index: u64,
    ) -> Fr {
        let subtree_start = index << height;
        if last_included_index < subtree_start {
            return merkle::empty(height as usize);
        }
        let subtree_end = subtree_start + (1u64 << height) - 1;
        if last_included_index >= subtree_end {
            return tree.node_value(height, index);
        }
        debug_assert!(height > 0, "a leaf cannot partially intersect a prefix");
        let child_height = height - 1;
        poseidon(&[
            Self::append_only_node_at(tree, last_included_index, child_height, index << 1),
            Self::append_only_node_at(tree, last_included_index, child_height, (index << 1) | 1),
        ])
    }

    pub(crate) fn append_only_path_at(
        tree: &SparseTree,
        last_included_index: u64,
        index: u64,
    ) -> Option<[Fr; TREE_DEPTH]> {
        if index > last_included_index {
            return None;
        }
        let mut siblings = [Fr::zero(); TREE_DEPTH];
        let mut cursor = index;
        for (height, sibling) in siblings.iter_mut().enumerate() {
            *sibling =
                Self::append_only_node_at(tree, last_included_index, height as u8, cursor ^ 1);
            cursor >>= 1;
        }
        Some(siblings)
    }

    pub fn l1_origin_path_at(
        &self,
        pcash_block_number: u64,
        index: u64,
    ) -> Option<[Fr; TREE_DEPTH]> {
        if index > pcash_block_number
            || !self.committed_boundaries.contains_key(&pcash_block_number)
        {
            return None;
        }
        Self::append_only_path_at(&self.l1_origin_tree, pcash_block_number, index)
    }

    /// Prove block `index` under the history root in header `at_block`.
    pub fn history_block_path_at(&self, at_block: u64, index: u64) -> Option<[Fr; TREE_DEPTH]> {
        if at_block == 0 || index >= at_block || !self.committed_boundaries.contains_key(&at_block)
        {
            return None;
        }
        Self::append_only_path_at(&self.history_tree, at_block - 1, index)
    }

    #[cfg(test)]
    fn recent_block_history_is_valid(&self) -> bool {
        let Some(tip) = self.canonical_tip.as_ref() else {
            return self.recent_block_history.order.is_empty();
        };
        let start = recent_window_start(tip.header.timestamp);
        let expected = self
            .committed_boundaries
            .values()
            .filter(|boundary| boundary.block.header.timestamp >= start)
            .map(|boundary| RecentBlockEntry {
                timestamp: boundary.block.header.timestamp,
                hash: boundary.block.hash,
            });
        self.recent_block_history.order.iter().copied().eq(expected)
    }

    #[cfg(test)]
    pub(crate) fn canonical_metadata_is_valid(&self) -> bool {
        if !self.recent_block_history_is_valid() {
            return false;
        }
        let Some(tip) = self.canonical_tip.as_ref() else {
            return self.canonical_tip.is_none()
                && self.canonical_genesis_hash.is_none()
                && self.canonical_genesis_timestamp.is_none()
                && self.committed_boundaries.is_empty()
                && self.l1_origin_tree.root() == merkle::empty(TREE_DEPTH)
                && self.history_tree.root() == merkle::empty(TREE_DEPTH);
        };
        let Some(retention) = self.boundary_retention() else {
            return false;
        };
        if retention.tip != tip.header.number
            || !self.committed_boundaries.contains_key(&0)
            || self
                .committed_boundaries
                .keys()
                .copied()
                .ne(0..=retention.tip)
        {
            return false;
        }
        if self.l1_origin_tree.root()
            != Self::append_only_node_at(&self.l1_origin_tree, retention.tip, TREE_DEPTH as u8, 0)
            || self.history_tree.root()
                != Self::append_only_node_at(&self.history_tree, retention.tip, TREE_DEPTH as u8, 0)
        {
            return false;
        }
        let expected_rows = retention.tip.checked_add(1);
        if expected_rows != Some(self.committed_boundaries.len() as u64) {
            return false;
        }

        let mut previous: Option<&CommittedBoundary> = None;
        let mut retained_nullifiers = HashSet::new();
        for (&number, boundary) in &self.committed_boundaries {
            let block = &boundary.block;
            let Some(expected_l1_number) = self.source.genesis_l1_block.checked_add(number) else {
                return false;
            };
            let components = boundary.state.state_components();
            let Some(next_output_count) = boundary
                .state_outcome
                .output_leaf_start
                .checked_add(boundary.state_outcome.outputs_added)
            else {
                return false;
            };
            if block.header.number != number
                || boundary.l1_origin != block.l1_origin
                || block.l1_origin.block_number != expected_l1_number
                || (number == 0 && block.l1_origin.block_hash != self.source.genesis_l1_block_hash)
                || !block.is_well_formed(&boundary.history.payouts)
                || block.header.state_root != boundary.state_outcome.state_root.0
                || block.header.state_root != fr_to_bytes(boundary.state.root)
                || block.header.l1_origin_root
                    != fr_to_bytes(Self::append_only_node_at(
                        &self.l1_origin_tree,
                        number,
                        TREE_DEPTH as u8,
                        0,
                    ))
                || block.header.history_root
                    != fr_to_bytes(if number == 0 {
                        merkle::empty(TREE_DEPTH)
                    } else {
                        Self::append_only_node_at(
                            &self.history_tree,
                            number - 1,
                            TREE_DEPTH as u8,
                            0,
                        )
                    })
                || (number == 0
                    && block.header.parent_hash != fr_to_bytes(self.source.genesis_parent_hash()))
                || state_root_from_components(boundary.state.state_components()).0
                    != block.header.state_root
                || next_output_count != components.output_count
            {
                return false;
            }
            if let Some(previous) = previous {
                let previous_components = previous.state.state_components();
                if number != previous.block.header.number.saturating_add(1)
                    || block.header.parent_hash != previous.block.hash
                    || block.header.timestamp < previous.block.header.timestamp
                    || boundary.state_outcome.output_leaf_start != previous_components.output_count
                    || components.account_count < previous_components.account_count
                {
                    return false;
                }
            }
            previous = Some(boundary);
            for &nullifier in &boundary.state_outcome.inserted_nullifiers {
                if nullifier == B256::ZERO
                    || crate::fr_from_canonical_bytes(nullifier).is_none()
                    || !self.nullifier_tree.contains(nullifier)
                    || !retained_nullifiers.insert(nullifier)
                {
                    return false;
                }
            }
            let Some(path) = self.l1_origin_path_at(number, number) else {
                return false;
            };
            if merkle::root_from_index(l1_origin_leaf(&block.l1_origin), number, &path)
                != crate::fr_from_canonical_bytes(block.header.l1_origin_root).unwrap()
                || self.history_tree.node_value(0, number) != history_leaf(block.hash)
            {
                return false;
            }
        }
        let Some((_, last_boundary)) = self.committed_boundaries.last_key_value() else {
            return false;
        };
        self.canonical_tip.as_ref() == Some(&StoredBlock::from(last_boundary))
            && self.canonical_genesis_hash
                == self
                    .committed_boundaries
                    .get(&0)
                    .map(|boundary| boundary.block.hash)
            && self.canonical_genesis_timestamp
                == self
                    .committed_boundaries
                    .get(&0)
                    .map(|boundary| boundary.block.header.timestamp)
            && last_boundary.state.state_components() == self.state_components()
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]
mod tests {
    use super::*;
    use crate::{AccountOp, Address};

    fn source() -> DerivationSource {
        DerivationSource {
            pcash_chain_id: 1,
            l1_chain_id: 2,
            inbox_address: Address::repeat_byte(3),
            genesis_l1_block: 100,
            genesis_l1_block_hash: B256::repeat_byte(4),
        }
    }

    fn input(number: u64, timestamp: u64) -> BlockInput {
        BlockInput {
            transaction_effects: Vec::new(),
            l1_logs: Vec::new(),
            history: crate::CanonicalBlockHistory::default(),
            number,
            timestamp,
            transaction_results: Vec::new(),
            transaction_bytes: Vec::new(),
            l1_origin: crate::L1Origin {
                block_number: 100 + number,
                block_hash: if number == 0 {
                    B256::repeat_byte(4)
                } else {
                    B256::repeat_byte(number as u8)
                },
                block_timestamp: timestamp,
                l1_logs_root: B256::ZERO,
                l1_log_count: 0,
            },
        }
    }

    #[test]
    fn negative_lag_round_trips_through_its_limbs() {
        let components = StateComponents {
            output_root: B256::ZERO,
            output_count: 3,
            issuance: pcash_issuance::IssuanceState {
                issued_so_far: U256::from(7),
                lag_q: I256::from_raw(U256::from(5 * 86_400u64) << 128).wrapping_neg(),
            },
            account_state_root: B256::ZERO,
            account_count: 2,
            nullifier_root: B256::repeat_byte(0x11),
            nullifier_count: 4,
        };
        let commitment = StateCommitment::new(components);
        assert_eq!(commitment.state_components(), components);
    }

    #[test]
    fn receive_key_and_nullifier_enter_typed_state() {
        let mut state = InnerState::new(source());
        let address = Address::repeat_byte(9);
        let nullifier = fr_to_bytes(Fr::from(88u64));
        let update = BlockUpdate {
            account_ops: vec![AccountOp {
                address,
                nullifier_key_commitment: Fr::from(5u64),
                account_rule_set_commitment: Fr::from(6u64),
                kind: 0,
                receive_key_hash: crate::receive_key_hash(&[0x5a; crate::ML_KEM768_PUBLIC_KEY_LEN]),
                published_receive_key: None,
            }],
            nullifiers: vec![B256::from(nullifier)],
            ..BlockUpdate::empty(state.issuance)
        };
        let boundary = state.apply(input(0, 10), &update);
        assert_ne!(state.account_state_tree.root(), merkle::empty(TREE_DEPTH));
        assert_ne!(state.nullifier_tree.root(), NullifierTree::new().root());
        assert_eq!(
            boundary.state.leaves[STATE_KEY_ACCOUNT_STATE_ROOT as usize],
            state.account_state_tree.root()
        );
        assert_eq!(
            boundary.state.leaves[STATE_KEY_NULLIFIER_ROOT as usize],
            state.nullifier_tree.root()
        );
        assert_eq!(
            boundary.state.leaves[STATE_KEY_NULLIFIER_COUNT as usize],
            Fr::from(1u64)
        );
        assert_eq!(
            boundary.block.header.parent_hash,
            fr_to_bytes(source().genesis_parent_hash())
        );
        assert!(state
            .nullifier_tree
            .proof(B256::from(nullifier))
            .verify(fr_to_bytes(
                boundary.state.leaves[STATE_KEY_NULLIFIER_ROOT as usize]
            )));
    }

    #[test]
    fn origin_changes_genesis_header_but_not_intrinsic_state() {
        let mut first = InnerState::new(source());
        let mut other_source = source();
        other_source.genesis_l1_block_hash[31] ^= 1;
        let mut second = InnerState::new(other_source);
        let first_boundary = first.apply(input(0, 10), &BlockUpdate::empty(first.issuance));
        let mut second_input = input(0, 10);
        second_input.l1_origin.block_hash[31] ^= 1;
        let second_boundary = second.apply(second_input, &BlockUpdate::empty(second.issuance));
        assert_eq!(
            first_boundary.state_outcome.state_root,
            second_boundary.state_outcome.state_root
        );
        assert_eq!(first_boundary.state.root, second_boundary.state.root);
        assert_ne!(first_boundary.block.hash, second_boundary.block.hash);
    }

    #[test]
    fn rollback_restores_the_prior_root() {
        let mut state = InnerState::new(source());
        let before = state.state_root();
        let (_, undo) = state.apply_reversible(input(0, 10), &BlockUpdate::empty(state.issuance));
        state.rollback(undo);
        assert_eq!(state.state_root(), before);
    }

    #[test]
    fn rollback_restores_evicted_recent_blocks_in_order() {
        let mut state = InnerState::new(source());
        for (number, timestamp) in [(0, 10), (1, 20), (2, 30)] {
            state.apply(
                input(number, timestamp),
                &BlockUpdate::empty(state.issuance),
            );
        }
        let before = state.recent_block_history.clone();
        let (_, undo) = state.apply_reversible(
            input(3, 30 + RECENT_PCASH_BLOCK_WINDOW_SECONDS),
            &BlockUpdate::empty(state.issuance),
        );
        assert_eq!(state.recent_block_history.order.len(), 2);
        state.rollback(undo);
        assert_eq!(state.recent_block_history, before);
        assert!(state.canonical_metadata_is_valid());
    }

    #[test]
    fn canonical_metadata_rejects_admission_and_l1_origin_tree_corruption() {
        let mut state = InnerState::new(source());
        state.apply(input(0, 10), &BlockUpdate::empty(state.issuance));
        state.apply(input(1, 20), &BlockUpdate::empty(state.issuance));
        assert!(state.canonical_metadata_is_valid());

        let first_history = state.recent_block_history.order.pop_front().unwrap();
        assert!(!state.canonical_metadata_is_valid());
        state.recent_block_history.order.push_front(first_history);
        assert!(state.canonical_metadata_is_valid());

        let original = state.l1_origin_tree.node_value(0, 1);
        state.l1_origin_tree.set_leaf(1, Fr::from(999u64));
        assert!(!state.canonical_metadata_is_valid());
        state.l1_origin_tree.set_leaf(1, original);
        assert!(state.canonical_metadata_is_valid());

        let original = state.history_tree.node_value(0, 1);
        state.history_tree.set_leaf(1, Fr::from(999u64));
        assert!(!state.canonical_metadata_is_valid());
        state.history_tree.set_leaf(1, original);
        assert!(state.canonical_metadata_is_valid());

        state.l1_origin_tree.set_leaf(2, Fr::from(777u64));
        assert!(!state.canonical_metadata_is_valid());
        state
            .l1_origin_tree
            .set_leaf(2, pcash_crypto::merkle::empty(0));
        assert!(state.canonical_metadata_is_valid());

        state.history_tree.set_leaf(2, Fr::from(888u64));
        assert!(!state.canonical_metadata_is_valid());
        state
            .history_tree
            .set_leaf(2, pcash_crypto::merkle::empty(0));
        assert!(state.canonical_metadata_is_valid());
    }

    #[test]
    fn historical_l1_origin_and_pcash_paths_match_independent_snapshots() {
        let mut state = InnerState::new(source());
        let mut l1_origin_snapshot = SparseTree::new(TREE_DEPTH);
        let mut history_snapshot = SparseTree::new(TREE_DEPTH);
        let selected = [0u64, 1, 2, 3, 6, 7, 30];
        let mut expected = Vec::new();
        for number in 0..=30 {
            let block_input = input(number, 10 + number * 20_000);
            l1_origin_snapshot.set_leaf(number, l1_origin_leaf(&block_input.l1_origin));
            let boundary = state.apply(block_input, &BlockUpdate::empty(state.issuance));
            if selected.contains(&number) {
                expected.push((
                    number,
                    l1_origin_snapshot.root(),
                    l1_origin_snapshot.path(0),
                    l1_origin_snapshot.path(number),
                    history_snapshot.root(),
                ));
            }
            history_snapshot.set_leaf(number, history_leaf(boundary.block.hash));
        }

        for (number, root, anchor_path, newest_path, history_root) in expected {
            assert_eq!(
                InnerState::append_only_node_at(&state.l1_origin_tree, number, TREE_DEPTH as u8, 0,),
                root
            );
            assert_eq!(state.l1_origin_path_at(number, 0), Some(anchor_path));
            assert_eq!(state.l1_origin_path_at(number, number), Some(newest_path));
            assert_eq!(
                merkle::root_from_index(
                    l1_origin_leaf(&state.committed_boundaries[&0].l1_origin),
                    0,
                    &anchor_path,
                ),
                root
            );
            assert_eq!(
                state.committed_boundaries[&number]
                    .block
                    .header
                    .history_root,
                fr_to_bytes(history_root)
            );
            if number > 0 {
                let history_path = state.history_block_path_at(number, 0).unwrap();
                assert_eq!(
                    merkle::root_from_index(
                        history_leaf(state.committed_boundaries[&0].block.hash),
                        0,
                        &history_path,
                    ),
                    history_root
                );
            }
        }
        assert_eq!(state.l1_origin_path_at(6, 7), None);
        assert_eq!(
            state.boundary_retention(),
            Some(BoundaryRetention {
                oldest_contiguous: 0,
                tip: 30,
            })
        );
        assert!(state.l1_origin_path_at(0, 0).is_some());
        assert!(state.l1_origin_path_at(6, 0).is_some());
        assert!(state.l1_origin_path_at(30, 0).is_some());
        assert!(state.canonical_metadata_is_valid());
    }
}
