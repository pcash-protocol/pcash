//! Derivation over a range of blocks that starts from a checkpoint and holds
//! only the state the range touches.
//!
//! A checkpoint is a canonical tip, named by its block hash, plus a
//! commitment to the state its header does not commit: every account by
//! address, and the recent-block window ([`aux_commitment`]). A
//! [`StateWitness`] carries that state in full, and for each tree the leaves
//! the range rewrites with their siblings as the tip holds them.
//!
//! [`WitnessState::open`] checks a witness against its checkpoint: every tree
//! root recomputed from the opened leaves and supplied siblings must equal the
//! root the tip commits. A missing sibling reads as empty, so it either is
//! empty or makes the root differ. Blocks then commit exactly as in the
//! in-memory backend, with three guards: every leaf a commit writes is one the
//! witness opened or one at or past the tree's leaf count at the checkpoint;
//! every nullifier read is answered by an opened leaf; and every inserted
//! nullifier lies in the gap of an opened leaf, so its predecessor is the true
//! one. A range therefore never reads a node or a nullifier row the checkpoint
//! does not bind.
//!
//! The same type holds a full state on the prover's host
//! ([`WitnessState::full`]), where it records what each range touches and
//! builds the range's witness from the state at the range's start.

use crate::codec::{codec_struct, Codec, DecodeError};
use crate::delegate::impl_inner_reads;
use crate::field::{fr_from_canonical_bytes, fr_to_bytes};
use crate::inner::{InnerState, RecentBlockEntry, RecentBlockHistory, TREE_DEPTHS};
use crate::nullifier_tree::{NullifierLeaf, NullifierTree};
use crate::tree::SparseTree;
use crate::{
    account_state_commitment, history_leaf, l1_origin_leaf, state_root_from_components,
    AccountState, Address, BlockInput, BlockSummary, BlockUpdate, BoundaryRetention,
    CommittedBoundary, DerivationSource, Fr, NullifierProof, PcashBlock, PcashBlockMetadata,
    StateComponents, StateDb, StateError, StateRoot, StoredBlock, TransactionEffects, TreeId, B256,
    COMMITMENT_TREE_DEPTH, STATE_TREE_DEPTH, TREE_DEPTH,
};
use alloy_primitives::keccak256;
use pcash_crypto::merkle;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};

const OUTPUT: usize = 0;
const ACCOUNT: usize = 1;
const L1_ORIGIN: usize = 2;
const HISTORY: usize = 3;
const NULLIFIER: usize = 4;
const TREES: usize = 5;

/// A canonical tip and the commitment to its uncommitted state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Checkpoint {
    pub block_hash: B256,
    pub aux: B256,
}

/// One account, keyed by address.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AccountEntry {
    pub address: Address,
    pub account: AccountState,
}

codec_struct!(AccountEntry { address, account });

/// A nullifier-tree leaf as the checkpoint holds it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NullifierOpening {
    pub index: u64,
    pub leaf: NullifierLeaf,
}

codec_struct!(NullifierLeaf {
    value,
    next_value,
    next_index
});
codec_struct!(NullifierOpening { index, leaf });
codec_struct!(RecentBlockEntry { timestamp, hash });

/// One tree node as the checkpoint holds it. `tree` is the tree's id: output,
/// account, L1 origin, PCASH history, nullifier.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TreeNode {
    pub tree: u8,
    pub height: u8,
    pub index: u64,
    pub value: Fr,
}

codec_struct!(TreeNode {
    tree,
    height,
    index,
    value
});

/// What a range needs from the state at its checkpoint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateWitness {
    pub tip: StoredBlock,
    /// Every account, in address order.
    pub accounts: Vec<AccountEntry>,
    /// The recent-block window, oldest first.
    pub recent_blocks: Vec<RecentBlockEntry>,
    /// The indices of existing accounts the range rewrites.
    pub account_leaves: Vec<u64>,
    /// The nullifier leaves the range reads or rewrites.
    pub nullifier_leaves: Vec<NullifierOpening>,
    /// Siblings on the paths of the opened leaves.
    pub siblings: Vec<TreeNode>,
}

codec_struct!(StateWitness {
    tip,
    accounts,
    recent_blocks,
    account_leaves,
    nullifier_leaves,
    siblings,
});

impl StateWitness {
    pub fn decode(bytes: &[u8]) -> Result<Self, DecodeError> {
        <Self as Codec>::decode(bytes)
    }
}

/// A held nullifier and its leaf index.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NullifierIndex {
    pub value: B256,
    pub index: u64,
}

codec_struct!(NullifierIndex { value, index });

/// A full state at a checkpoint, as a prover keeps it between ranges: what a
/// witness opens, with every tree node and every nullifier.
pub struct StateSnapshot {
    pub tip: StoredBlock,
    /// Every account, in address order.
    pub accounts: Vec<AccountEntry>,
    /// The recent-block window, oldest first.
    pub recent_blocks: Vec<RecentBlockEntry>,
    /// Every node of the five trees.
    pub nodes: Vec<TreeNode>,
    pub nullifiers: Vec<NullifierIndex>,
}

codec_struct!(StateSnapshot {
    tip,
    accounts,
    recent_blocks,
    nodes,
    nullifiers,
});

impl StateSnapshot {
    pub fn decode(bytes: &[u8]) -> Result<Self, DecodeError> {
        <Self as Codec>::decode(bytes)
    }
}

/// Commitment to every account by address and the recent-block window.
pub fn aux_commitment<'a>(
    accounts: impl IntoIterator<Item = (&'a Address, &'a AccountState)>,
    recent_blocks: impl IntoIterator<Item = &'a RecentBlockEntry>,
) -> B256 {
    let accounts: BTreeMap<&Address, &AccountState> = accounts.into_iter().collect();
    let accounts: Vec<AccountEntry> = accounts
        .into_iter()
        .map(|(address, account)| AccountEntry {
            address: *address,
            account: *account,
        })
        .collect();
    let recent_blocks: Vec<RecentBlockEntry> = recent_blocks.into_iter().copied().collect();
    let mut bytes = accounts.encode();
    bytes.extend(recent_blocks.encode());
    keccak256(bytes)
}

/// Leaves below each tree's checkpoint count that a range may rewrite.
struct Opened {
    leaves: [BTreeSet<u64>; TREES],
    low_leaves: Vec<NullifierLeaf>,
}

/// What a range read and wrote, for its witness.
#[derive(Default)]
struct Recorded {
    leaves: [BTreeSet<u64>; TREES],
    /// Nullifiers read or inserted; reads come through `&self`.
    nullifiers: RefCell<BTreeSet<B256>>,
}

/// State for deriving a range of blocks. See the module docs.
pub struct WitnessState {
    inner: InnerState,
    /// Each tree's leaf count at the range's start.
    counts: [u64; TREES],
    /// `None` when the state is held in full.
    opened: Option<Opened>,
    recorded: Recorded,
}

fn witness_error(message: impl Into<String>) -> StateError {
    StateError::Backend(message.into())
}

/// Leaf counts of the five trees in `inner`.
fn leaf_counts(inner: &InnerState) -> [u64; TREES] {
    let blocks = inner
        .canonical_tip
        .as_ref()
        .map_or(0, |tip| tip.header.number + 1);
    [
        inner.output_count,
        inner.account_count,
        blocks,
        blocks,
        inner.nullifier_tree.count() + 1,
    ]
}

impl WitnessState {
    /// The full state of a network before its first block.
    pub fn genesis(source: DerivationSource) -> Self {
        Self::full(InnerState::new(source))
    }

    /// A full state, as the prover's host holds it.
    pub fn full(inner: InnerState) -> Self {
        let counts = leaf_counts(&inner);
        Self {
            inner,
            counts,
            opened: None,
            recorded: Recorded::default(),
        }
    }

    pub fn inner(&self) -> &InnerState {
        &self.inner
    }

    /// The checkpoint this state is at, or `None` before the first block.
    pub fn checkpoint(&self) -> Option<Checkpoint> {
        self.inner.canonical_tip.as_ref().map(|tip| Checkpoint {
            block_hash: tip.hash,
            aux: self.aux(),
        })
    }

    /// Commitment to this state's accounts and recent-block window.
    pub fn aux(&self) -> B256 {
        aux_commitment(
            &self.inner.accounts,
            self.inner.recent_block_history.entries(),
        )
    }

    /// The full state, or `None` before the first block.
    pub fn snapshot(&self) -> Option<StateSnapshot> {
        let inner = &self.inner;
        let tip = inner.canonical_tip.clone()?;
        let accounts: BTreeMap<&Address, &AccountState> = inner.accounts.iter().collect();
        let trees = [
            &inner.output_tree,
            &inner.account_state_tree,
            &inner.l1_origin_tree,
            &inner.history_tree,
            inner.nullifier_tree.nodes(),
        ];
        Some(StateSnapshot {
            tip,
            accounts: accounts
                .into_iter()
                .map(|(address, account)| AccountEntry {
                    address: *address,
                    account: *account,
                })
                .collect(),
            recent_blocks: inner.recent_block_history.entries().copied().collect(),
            nodes: (0u8..)
                .zip(trees)
                .flat_map(|(tree, nodes)| {
                    nodes
                        .held_entries()
                        .map(move |(height, index, value)| TreeNode {
                            tree,
                            height,
                            index,
                            value,
                        })
                })
                .collect(),
            nullifiers: inner
                .nullifier_tree
                .indices()
                .iter()
                .map(|(&value, &index)| NullifierIndex { value, index })
                .collect(),
        })
    }

    /// The full state a snapshot holds.
    pub fn restore(source: DerivationSource, snapshot: StateSnapshot) -> Self {
        let StateSnapshot {
            tip,
            accounts,
            recent_blocks,
            nodes,
            nullifiers,
        } = snapshot;
        let mut trees = TREE_DEPTHS.map(SparseTree::new);
        for node in nodes {
            trees[node.tree as usize].load_node(node.height, node.index, node.value);
        }
        let [output_tree, account_state_tree, l1_origin_tree, history_tree, nullifier_nodes] =
            trees;
        let indices = nullifiers
            .into_iter()
            .map(|nullifier| (nullifier.value, nullifier.index))
            .collect();
        Self::full(InnerState {
            source,
            canonical_genesis_hash: None,
            canonical_genesis_timestamp: None,
            output_count: tip.state.output_count,
            issuance: tip.state.issuance,
            fee_excess: tip.state.fee_excess,
            account_count: tip.state.account_count,
            nullifier_tree: NullifierTree::from_parts(
                nullifier_nodes,
                indices,
                tip.state.nullifier_count,
            ),
            canonical_tip: Some(tip),
            committed_boundaries: BTreeMap::new(),
            output_tree,
            account_state_tree,
            l1_origin_tree,
            history_tree,
            accounts: accounts
                .into_iter()
                .map(|entry| (entry.address, entry.account))
                .collect(),
            recent_block_history: RecentBlockHistory::from_vec(recent_blocks),
            last_delta: Default::default(),
        })
    }

    /// Start recording a new range from the current state.
    pub fn begin_range(&mut self) {
        self.counts = leaf_counts(&self.inner);
        self.recorded = Recorded::default();
    }

    /// The witness of the range recorded since [`Self::begin_range`], built
    /// from `start`, the full state at the range's start.
    pub fn witness(&self, start: &InnerState) -> Result<StateWitness, StateError> {
        let tip = start
            .canonical_tip
            .clone()
            .ok_or_else(|| witness_error("a range from genesis needs no witness"))?;
        let accounts: BTreeMap<&Address, &AccountState> = start.accounts.iter().collect();
        let accounts = accounts
            .into_iter()
            .map(|(address, account)| AccountEntry {
                address: *address,
                account: *account,
            })
            .collect();
        let account_leaves: Vec<u64> = self.recorded.leaves[ACCOUNT].iter().copied().collect();
        let mut by_index = BTreeMap::new();
        for &nullifier in self.recorded.nullifiers.borrow().iter() {
            let proof = start.nullifier_tree.proof(nullifier);
            by_index.insert(
                proof.index,
                NullifierOpening {
                    index: proof.index,
                    leaf: proof.leaf,
                },
            );
        }
        let nullifier_leaves: Vec<NullifierOpening> = by_index.into_values().collect();
        let positions = opened_positions(
            &tip,
            &start_counts(&tip),
            &account_leaves,
            &nullifier_leaves,
        );
        let mut siblings = BTreeMap::new();
        for (tree, leaves) in positions.iter().enumerate() {
            for &position in leaves.keys() {
                for height in 0..TREE_DEPTHS[tree] as u8 {
                    let index = (position >> height) ^ 1;
                    let value = match tree {
                        OUTPUT => start.output_tree.node_value(height, index),
                        ACCOUNT => start.account_state_tree.node_value(height, index),
                        L1_ORIGIN => start.l1_origin_tree.node_value(height, index),
                        HISTORY => start.history_tree.node_value(height, index),
                        _ => start.nullifier_tree.nodes().node_value(height, index),
                    };
                    siblings.insert((tree as u8, height, index), value);
                }
            }
        }
        Ok(StateWitness {
            tip,
            accounts,
            recent_blocks: start.recent_block_history.entries().copied().collect(),
            account_leaves,
            nullifier_leaves,
            siblings: siblings
                .into_iter()
                .map(|((tree, height, index), value)| TreeNode {
                    tree,
                    height,
                    index,
                    value,
                })
                .collect(),
        })
    }

    /// Check `witness` against `checkpoint` and hold the state it opens.
    pub fn open(
        source: DerivationSource,
        checkpoint: Checkpoint,
        witness: StateWitness,
    ) -> Result<Self, StateError> {
        let StateWitness {
            tip,
            accounts,
            recent_blocks,
            account_leaves,
            nullifier_leaves,
            siblings,
        } = witness;
        if tip.hash != checkpoint.block_hash || tip.header.try_hash() != Some(tip.hash) {
            return Err(witness_error("witness tip is not the checkpoint block"));
        }
        if state_root_from_components(tip.state).0 != tip.header.state_root {
            return Err(witness_error(
                "witness state does not match the tip's state root",
            ));
        }
        // The state root holds the issued supply reduced into the field, so a
        // larger integer with the same residue would open under the same root
        // and settle differently. The cap is below the modulus.
        if tip.state.issuance.issued_so_far > pcash_issuance::supply_cap() {
            return Err(witness_error(
                "witness issued supply exceeds the supply cap",
            ));
        }

        let mut by_address = HashMap::with_capacity(accounts.len());
        let mut by_index = HashMap::with_capacity(accounts.len());
        for pair in accounts.windows(2) {
            if pair[0].address >= pair[1].address {
                return Err(witness_error("witness accounts are not in address order"));
            }
        }
        for entry in &accounts {
            by_address.insert(entry.address, entry.account);
            by_index.insert(entry.account.index, entry.address);
        }
        let recent_block_history = RecentBlockHistory::from_vec(recent_blocks);
        if aux_commitment(&by_address, recent_block_history.entries()) != checkpoint.aux {
            return Err(witness_error(
                "witness accounts or recent blocks do not match the checkpoint",
            ));
        }

        let counts = start_counts(&tip);
        if nullifier_leaves
            .windows(2)
            .any(|pair| pair[0].index >= pair[1].index)
        {
            return Err(witness_error(
                "witness nullifier leaves are not in index order",
            ));
        }
        // The first free index is authenticated as empty, so a leaf opened
        // there or beyond would reach the lookup tables unauthenticated.
        if nullifier_leaves
            .iter()
            .any(|opening| opening.index >= counts[NULLIFIER])
        {
            return Err(witness_error(
                "witness opens a nullifier leaf past the last allocated one",
            ));
        }
        for opening in &nullifier_leaves {
            let leaf = opening.leaf;
            if [leaf.value, leaf.next_value]
                .into_iter()
                .any(|word| fr_from_canonical_bytes(word).is_none())
            {
                return Err(witness_error("witness nullifier leaf is not canonical"));
            }
        }
        let positions = opened_positions(&tip, &counts, &account_leaves, &nullifier_leaves);
        let siblings: HashMap<(u8, u8, u64), Fr> = siblings
            .into_iter()
            .map(|node| ((node.tree, node.height, node.index), node.value))
            .collect();

        let mut trees: Vec<SparseTree> = Vec::with_capacity(TREES);
        for (tree, leaves) in positions.iter().enumerate() {
            let mut opened = SparseTree::new(TREE_DEPTHS[tree]);
            for &position in leaves.keys() {
                for height in 0..TREE_DEPTHS[tree] as u8 {
                    let index = (position >> height) ^ 1;
                    if let Some(&value) = siblings.get(&(tree as u8, height, index)) {
                        opened.load_node(height, index, value);
                    }
                }
            }
            let mut old = Vec::with_capacity(leaves.len());
            for (&position, leaf) in leaves {
                let value = match leaf {
                    OldLeaf::Empty => merkle::empty(0),
                    OldLeaf::Value(value) => *value,
                    OldLeaf::Account => {
                        let address = by_index.get(&position).ok_or_else(|| {
                            witness_error("witness opens an account index no account holds")
                        })?;
                        let account = by_address[address];
                        account_state_commitment(
                            *address,
                            account.nullifier_key_commitment,
                            account.account_rule_set_commitment,
                            account.kind,
                            account.revision,
                            account.receive_key_hash,
                        )
                    }
                };
                old.push((position, value));
            }
            opened.set_leaves(&old);
            let expected = match tree {
                OUTPUT => tip.state.output_root,
                ACCOUNT => tip.state.account_state_root,
                L1_ORIGIN => tip.header.l1_origin_root,
                HISTORY => tip.header.history_root,
                _ => tip.state.nullifier_root,
            };
            if fr_to_bytes(opened.root()) != expected {
                return Err(witness_error(format!(
                    "witness does not open tree {tree} at the checkpoint"
                )));
            }
            trees.push(opened);
        }

        let Ok(
            [output_tree, account_state_tree, l1_origin_tree, mut history_tree, nullifier_nodes],
        ) = <[SparseTree; TREES]>::try_from(trees)
        else {
            unreachable!("one tree per id");
        };
        // Header N holds the history root before its own leaf.
        history_tree.set_leaf(tip.header.number, history_leaf(tip.hash));
        let mut indices = BTreeMap::new();
        for opening in &nullifier_leaves {
            if opening.leaf.value != B256::ZERO {
                indices.insert(opening.leaf.value, opening.index);
            }
            if opening.leaf.next_index != 0 {
                indices.insert(opening.leaf.next_value, opening.leaf.next_index);
            }
        }
        let nullifier_tree =
            NullifierTree::from_parts(nullifier_nodes, indices, tip.state.nullifier_count);

        let mut opened_leaves: [BTreeSet<u64>; TREES] = Default::default();
        for (tree, leaves) in positions.iter().enumerate() {
            opened_leaves[tree] = leaves
                .keys()
                .copied()
                .filter(|&p| p < counts[tree])
                .collect();
        }
        let inner = InnerState {
            source,
            canonical_genesis_hash: None,
            canonical_genesis_timestamp: None,
            output_count: tip.state.output_count,
            issuance: tip.state.issuance,
            fee_excess: tip.state.fee_excess,
            account_count: tip.state.account_count,
            canonical_tip: Some(tip),
            committed_boundaries: BTreeMap::new(),
            output_tree,
            account_state_tree,
            l1_origin_tree,
            history_tree,
            nullifier_tree,
            accounts: by_address,
            recent_block_history,
            last_delta: Default::default(),
        };
        Ok(Self {
            inner,
            counts,
            opened: Some(Opened {
                leaves: opened_leaves,
                low_leaves: nullifier_leaves
                    .iter()
                    .map(|opening| opening.leaf)
                    .collect(),
            }),
            recorded: Recorded::default(),
        })
    }

    /// Whether the witness opened the leaf whose gap holds `nullifier`.
    fn bracketed(&self, nullifier: B256) -> bool {
        self.opened.as_ref().is_none_or(|opened| {
            opened
                .low_leaves
                .iter()
                .any(|leaf| leaf.is_low_leaf_of(nullifier))
        })
    }

    /// Every leaf the last commit wrote below a tree's count must be opened.
    fn check_written(&self) -> Result<(), StateError> {
        let Some(opened) = &self.opened else {
            return Ok(());
        };
        for tree in 0..TREES {
            for &(height, index) in &self.inner.last_delta.dirty_nodes[tree] {
                if height == 0 && index < self.counts[tree] && !opened.leaves[tree].contains(&index)
                {
                    return Err(witness_error(format!(
                        "range writes leaf {index} of tree {tree}, which the witness does not open"
                    )));
                }
            }
        }
        Ok(())
    }

    fn record_written(&mut self) {
        for tree in 0..TREES {
            let written: Vec<u64> = self.inner.last_delta.dirty_nodes[tree]
                .iter()
                .filter(|&&(height, index)| height == 0 && index < self.counts[tree])
                .map(|&(_, index)| index)
                .collect();
            self.recorded.leaves[tree].extend(written);
        }
    }
}

/// Each tree's leaf count at a checkpoint.
fn start_counts(tip: &StoredBlock) -> [u64; TREES] {
    let blocks = tip.header.number + 1;
    [
        tip.state.output_count,
        tip.state.account_count,
        blocks,
        blocks,
        tip.state.nullifier_count + 1,
    ]
}

/// The value a leaf held at the checkpoint.
enum OldLeaf {
    Empty,
    Value(Fr),
    /// The account whose index is the leaf's position.
    Account,
}

/// The leaves a witness opens in each tree, with the value each held: the
/// rewritten leaves it names, the first free leaf of each tree, and the tip's
/// own leaves in the L1 origin and history trees. The history tree is opened
/// as the tip's header commits it, before the tip's own leaf.
fn opened_positions(
    tip: &StoredBlock,
    counts: &[u64; TREES],
    account_leaves: &[u64],
    nullifier_leaves: &[NullifierOpening],
) -> [BTreeMap<u64, OldLeaf>; TREES] {
    let tip_number = tip.header.number;
    let mut positions: [BTreeMap<u64, OldLeaf>; TREES] = Default::default();
    positions[OUTPUT].insert(counts[OUTPUT], OldLeaf::Empty);
    for &index in account_leaves {
        positions[ACCOUNT].insert(index, OldLeaf::Account);
    }
    positions[ACCOUNT].insert(counts[ACCOUNT], OldLeaf::Empty);
    positions[L1_ORIGIN].insert(tip_number, OldLeaf::Value(l1_origin_leaf(&tip.l1_origin)));
    positions[L1_ORIGIN].insert(tip_number + 1, OldLeaf::Empty);
    positions[HISTORY].insert(tip_number, OldLeaf::Empty);
    positions[HISTORY].insert(tip_number + 1, OldLeaf::Empty);
    for opening in nullifier_leaves {
        positions[NULLIFIER].insert(opening.index, OldLeaf::Value(opening.leaf.hash()));
    }
    positions[NULLIFIER].insert(counts[NULLIFIER], OldLeaf::Empty);
    positions
}

impl StateDb for WitnessState {
    fn commit(
        &mut self,
        mut input: BlockInput,
        update: BlockUpdate,
    ) -> Result<(CommittedBoundary, Vec<TransactionEffects>), StateError> {
        let transaction_effects = std::mem::take(&mut input.transaction_effects);
        // The tree links each insertion to its predecessor among the rows it
        // holds; an opened gap makes that the true predecessor.
        if let Some(&nullifier) = update
            .nullifiers
            .iter()
            .find(|&&nullifier| !self.bracketed(nullifier))
        {
            return Err(witness_error(format!(
                "witness does not open the gap of inserted nullifier {nullifier}"
            )));
        }
        self.recorded
            .nullifiers
            .borrow_mut()
            .extend(update.nullifiers.iter().copied());
        let boundary = self.inner.apply(input, &update);
        self.check_written()?;
        self.record_written();
        Ok((boundary, transaction_effects))
    }

    impl_inner_reads!(common);

    fn path(&self, tree: TreeId, index: u64) -> Result<[Fr; TREE_DEPTH], StateError> {
        if self.opened.is_some() {
            return Err(witness_error("a range state holds no paths"));
        }
        Ok(self.inner.tree(tree).path(index))
    }

    /// Answered by the full state, or by a leaf the witness opened: the
    /// nullifier's own leaf, or the leaf whose gap holds it.
    fn nullifier_seen(&self, nullifier: B256) -> Result<bool, StateError> {
        self.recorded.nullifiers.borrow_mut().insert(nullifier);
        let spent = self.inner.nullifier_tree.contains(nullifier);
        if !spent && !self.bracketed(nullifier) {
            return Err(witness_error(format!(
                "witness does not open nullifier {nullifier}"
            )));
        }
        Ok(spent)
    }

    fn nullifier_proof(&self, nullifier: B256) -> Result<NullifierProof, StateError> {
        if self.opened.is_some() {
            return Err(witness_error("a range state holds no nullifier proofs"));
        }
        Ok(self.inner.nullifier_tree.proof(nullifier))
    }

    fn account_of(&self, address: Address) -> Result<Option<AccountState>, StateError> {
        Ok(self.inner.account_of(address))
    }

    fn canonical_stored_block(&self, number: u64) -> Result<Option<StoredBlock>, StateError> {
        Ok(self
            .inner
            .committed_boundaries
            .get(&number)
            .map(StoredBlock::from))
    }

    fn canonical_stored_block_by_hash(
        &self,
        hash: B256,
    ) -> Result<Option<StoredBlock>, StateError> {
        Ok(self
            .inner
            .committed_boundaries
            .values()
            .find(|boundary| boundary.block.hash == hash)
            .map(StoredBlock::from))
    }

    fn canonical_block_metadata(
        &self,
        number: u64,
    ) -> Result<Option<PcashBlockMetadata>, StateError> {
        Ok(self
            .canonical_block(number)?
            .as_ref()
            .map(PcashBlockMetadata::from))
    }

    fn canonical_block_metadata_by_hash(
        &self,
        hash: B256,
    ) -> Result<Option<PcashBlockMetadata>, StateError> {
        Ok(self
            .inner
            .committed_boundaries
            .values()
            .find(|boundary| boundary.block.hash == hash)
            .map(|boundary| PcashBlockMetadata::from(&boundary.block)))
    }

    fn canonical_transaction_body(
        &self,
        number: u64,
        transaction_index: u64,
    ) -> Result<Option<Vec<u8>>, StateError> {
        Ok(self.canonical_block(number)?.and_then(|block| {
            block
                .transaction_bytes
                .get(transaction_index as usize)
                .cloned()
        }))
    }

    fn canonical_transaction_effects(
        &self,
        _number: u64,
    ) -> Result<Option<Vec<TransactionEffects>>, StateError> {
        Ok(None)
    }

    fn canonical_block(&self, number: u64) -> Result<Option<PcashBlock>, StateError> {
        Ok(self
            .inner
            .committed_boundaries
            .get(&number)
            .map(|boundary| boundary.block.clone()))
    }

    fn committed_boundary(&self, number: u64) -> Result<Option<CommittedBoundary>, StateError> {
        Ok(self.inner.committed_boundaries.get(&number).cloned())
    }

    fn committed_boundary_by_block_hash(
        &self,
        hash: B256,
    ) -> Result<Option<CommittedBoundary>, StateError> {
        Ok(self
            .inner
            .committed_boundaries
            .values()
            .find(|boundary| boundary.block.hash == hash)
            .cloned())
    }

    fn l1_delivery_batches(&self, number: u64) -> Result<Vec<crate::L1DeliveryBatch>, StateError> {
        Ok(self
            .inner
            .committed_boundaries
            .get(&number)
            .map(|boundary| boundary.history.l1_delivery_batches.clone())
            .unwrap_or_default())
    }

    fn block_economics(&self, number: u64) -> Result<Option<crate::BlockEconomics>, StateError> {
        Ok(self
            .inner
            .committed_boundaries
            .get(&number)
            .map(|boundary| boundary.history.economics.clone()))
    }

    fn l1_origin_path(&self, _index: u64) -> Result<Option<[Fr; TREE_DEPTH]>, StateError> {
        Err(witness_error("a range state holds no paths"))
    }

    fn output_path_at(
        &self,
        _number: u64,
        _index: u64,
    ) -> Result<Option<[Fr; TREE_DEPTH]>, StateError> {
        Err(witness_error("a range state holds no paths"))
    }

    fn l1_origin_path_at(
        &self,
        _pcash_block_number: u64,
        _index: u64,
    ) -> Result<Option<[Fr; TREE_DEPTH]>, StateError> {
        Err(witness_error("a range state holds no paths"))
    }

    fn history_block_path_at(
        &self,
        _at_block: u64,
        _index: u64,
    ) -> Result<Option<[Fr; TREE_DEPTH]>, StateError> {
        Err(witness_error("a range state holds no paths"))
    }

    fn restore_to(&mut self, _l1_block_number: u64) -> Result<StateRoot, StateError> {
        Err(witness_error("a range state does not reorganize"))
    }

    fn prune(&mut self, _finalized_l1_block: u64) -> Result<(), StateError> {
        Ok(())
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "tests use direct assertions for fixture setup"
)]
mod tests {
    use super::*;
    use crate::{AccountOp, L1Origin};

    fn source() -> DerivationSource {
        DerivationSource {
            pcash_chain_id: 1,
            l1_chain_id: 2,
            inbox_address: Address::repeat_byte(3),
            genesis_l1_block: 100,
            genesis_l1_block_hash: B256::repeat_byte(4),
        }
    }

    fn input(number: u64) -> BlockInput {
        BlockInput {
            transaction_effects: Vec::new(),
            l1_logs: Vec::new(),
            history: crate::CanonicalBlockHistory::default(),
            number,
            timestamp: 10 + 12 * number,
            transaction_results: Vec::new(),
            transaction_bytes: Vec::new(),
            l1_origin: L1Origin {
                block_number: 100 + number,
                block_hash: if number == 0 {
                    B256::repeat_byte(4)
                } else {
                    B256::with_last_byte(number as u8)
                },
                block_timestamp: 10 + 12 * number,
                l1_logs_root: B256::ZERO,
                l1_log_count: 0,
            },
        }
    }

    /// Distinct small nonzero nullifiers, spread so later ones land between
    /// earlier ones.
    fn nullifier(number: u64, slot: u64) -> B256 {
        B256::left_padding_from(&((number * 7_919 + slot * 104_729) % 999_983 + 1).to_be_bytes())
    }

    /// Two outputs, one account write (five addresses, so writes after the
    /// fifth block rewrite existing accounts), two nullifiers.
    fn update(number: u64, state: &WitnessState) -> BlockUpdate {
        BlockUpdate {
            output_commitments: vec![Fr::from(number * 10 + 1), Fr::from(number * 10 + 2)],
            issuance: state.inner().issuance,
            fee_excess: number * 3,
            account_ops: vec![AccountOp {
                address: Address::repeat_byte((number % 5) as u8 + 1),
                nullifier_key_commitment: Fr::from(7u64),
                account_rule_set_commitment: Fr::from(number),
                kind: 0,
                receive_key_hash: B256::ZERO,
                published_receive_key: None,
            }],
            nullifiers: vec![nullifier(number, 0), nullifier(number, 1)],
        }
    }

    /// Commit block `number` as derivation would: read its nullifiers and an
    /// earlier block's, then insert its own.
    fn derive(state: &mut WitnessState, number: u64) -> Result<(), StateError> {
        for slot in 0..2 {
            assert!(!state.nullifier_seen(nullifier(number, slot))?);
        }
        if number > 0 {
            assert!(state.nullifier_seen(nullifier(number - 1, 0))?);
        }
        let update = update(number, state);
        state.commit(input(number), update).map(|_| ())
    }

    /// A full state through `checkpoint`, and the witness and full state of
    /// the range after it through `end`.
    fn range(checkpoint: u64, end: u64) -> (Checkpoint, StateWitness, WitnessState) {
        let mut full = WitnessState::genesis(source());
        for number in 0..=checkpoint {
            derive(&mut full, number).unwrap();
        }
        let start = full.inner().clone();
        let at = full.checkpoint().unwrap();
        full.begin_range();
        for number in checkpoint + 1..=end {
            derive(&mut full, number).unwrap();
        }
        let witness = full.witness(&start).unwrap();
        (at, witness, full)
    }

    #[test]
    fn a_range_from_its_witness_reaches_the_full_state() {
        let (at, witness, full) = range(7, 13);
        let bytes = witness.encode();
        let mut opened =
            WitnessState::open(source(), at, StateWitness::decode(&bytes).unwrap()).unwrap();
        for number in 8..=13 {
            derive(&mut opened, number).unwrap();
        }
        assert_eq!(opened.checkpoint(), full.checkpoint());
        assert_eq!(
            opened.inner().state_components(),
            full.inner().state_components()
        );
    }

    #[test]
    fn a_restored_snapshot_derives_and_proves_as_the_full_state() {
        let mut full = WitnessState::genesis(source());
        for number in 0..=7 {
            derive(&mut full, number).unwrap();
        }
        let bytes = full.snapshot().unwrap().encode();
        let mut restored = WitnessState::restore(source(), StateSnapshot::decode(&bytes).unwrap());
        assert_eq!(restored.checkpoint(), full.checkpoint());

        let at = restored.checkpoint().unwrap();
        let start = restored.inner().clone();
        restored.begin_range();
        for number in 8..=13 {
            derive(&mut full, number).unwrap();
            derive(&mut restored, number).unwrap();
        }
        assert_eq!(restored.checkpoint(), full.checkpoint());
        let witness = restored.witness(&start).unwrap();
        let mut opened = WitnessState::open(source(), at, witness).unwrap();
        for number in 8..=13 {
            derive(&mut opened, number).unwrap();
        }
        assert_eq!(opened.checkpoint(), full.checkpoint());
    }

    #[test]
    fn a_wrong_or_missing_sibling_fails_to_open() {
        let (at, witness, _) = range(7, 9);
        let mut wrong = witness.clone();
        let nonempty = wrong
            .siblings
            .iter()
            .position(|node| node.value != merkle::empty(node.height as usize))
            .unwrap();
        wrong.siblings[nonempty].value += Fr::from(1u64);
        assert!(WitnessState::open(source(), at, wrong).is_err());
        let mut missing = witness;
        missing.siblings.remove(nonempty);
        assert!(WitnessState::open(source(), at, missing).is_err());
    }

    #[test]
    fn altered_accounts_or_tip_fail_to_open() {
        let (at, witness, _) = range(7, 9);
        let mut accounts = witness.clone();
        accounts.accounts[0].account.revision += 1;
        assert!(WitnessState::open(source(), at, accounts).is_err());
        let mut recent = witness.clone();
        recent.recent_blocks.pop();
        assert!(WitnessState::open(source(), at, recent).is_err());
        let other = Checkpoint {
            block_hash: B256::repeat_byte(9),
            ..at
        };
        assert!(WitnessState::open(source(), other, witness).is_err());
    }

    #[test]
    fn a_forged_nullifier_leaf_fails_to_open() {
        let (at, mut witness, _) = range(7, 9);
        let opening = witness
            .nullifier_leaves
            .iter_mut()
            .find(|opening| opening.leaf.next_index != 0)
            .unwrap();
        opening.leaf.next_value = B256::left_padding_from(&u64::MAX.to_be_bytes());
        assert!(WitnessState::open(source(), at, witness).is_err());
    }

    #[test]
    fn a_nullifier_leaf_opened_at_the_first_free_index_fails_to_open() {
        let (at, mut witness, _) = range(7, 9);
        let first_free = witness.tip.state.nullifier_count + 1;
        // Claims an unspent nullifier is spent; the leaf at the first free
        // index authenticates as empty whatever the opening holds.
        witness.nullifier_leaves.push(NullifierOpening {
            index: first_free,
            leaf: NullifierLeaf {
                value: nullifier(100, 0),
                next_value: B256::ZERO,
                next_index: 0,
            },
        });
        assert!(WitnessState::open(source(), at, witness).is_err());
    }

    #[test]
    fn an_issued_supply_above_the_cap_fails_to_open() {
        let (at, mut witness, _) = range(7, 9);
        let modulus: alloy_primitives::U256 =
            "21888242871839275222246405745257275088548364400416034343698204186575808495617"
                .parse()
                .unwrap();
        // The same residue, so the same state root.
        witness.tip.state.issuance.issued_so_far += modulus;
        assert!(WitnessState::open(source(), at, witness).is_err());
    }

    #[test]
    fn an_unopened_account_rewrite_is_refused() {
        let (at, mut witness, _) = range(7, 9);
        witness.account_leaves.clear();
        let mut opened = WitnessState::open(source(), at, witness).unwrap();
        assert!(derive(&mut opened, 8).is_err());
    }

    #[test]
    fn a_read_never_answers_unspent_for_a_spent_nullifier() {
        let (at, mut witness, _) = range(7, 9);
        let spent = nullifier(7, 0);
        witness
            .nullifier_leaves
            .retain(|opening| opening.leaf.value != spent);
        let opened = WitnessState::open(source(), at, witness).unwrap();
        // Held as some opened leaf's successor, or refused.
        assert!(!matches!(opened.nullifier_seen(spent), Ok(false)));
    }

    #[test]
    fn an_insertion_outside_every_opened_gap_is_refused() {
        let (at, mut witness, _) = range(7, 9);
        let inserted = nullifier(8, 0);
        witness
            .nullifier_leaves
            .retain(|opening| !opening.leaf.is_low_leaf_of(inserted));
        let mut opened = WitnessState::open(source(), at, witness).unwrap();
        let update = update(8, &opened);
        assert!(opened.commit(input(8), update).is_err());
    }

    #[test]
    fn duplicate_nullifier_openings_fail_to_open() {
        let (at, mut witness, _) = range(7, 9);
        let mut forged = witness.nullifier_leaves[0];
        forged.leaf.value = B256::with_last_byte(1);
        witness.nullifier_leaves.insert(1, forged);
        assert!(WitnessState::open(source(), at, witness).is_err());
    }
}
