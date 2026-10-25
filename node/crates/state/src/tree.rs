//! Sparse Merkle tree over BN254 `Fr`, of the depth given at construction.
//!
//! Internal nodes are `poseidon(left, right)`; unset subtrees fall back to the
//! `EMPTY[h]` ladder from `pcash-crypto`. Membership paths are siblings from
//! leaf level upward and verify via `pcash_crypto::merkle::root_from_index`.

use crate::field::{fr_from_internal_word, fr_to_bytes, restore_entry};
use alloy_primitives::B256;
use ark_ff::Zero;
use pcash_crypto::{merkle, poseidon, Fr};
use std::collections::HashMap;

/// A mutable sparse Merkle tree. Height `0` is the leaf level; the root sits at
/// height `depth`.
#[derive(Clone)]
pub struct SparseTree {
    depth: usize,
    nodes: HashMap<(u8, u64), Fr>,
}

/// Original values for the nodes touched by one reversible tree mutation.
/// Each coordinate is recorded only on its first write so overlapping Merkle
/// paths remain O(block delta) to restore.
#[derive(Default)]
pub(crate) struct SparseTreeUndo {
    nodes: HashMap<(u8, u64), Option<Fr>>,
}

impl SparseTree {
    /// Empty tree of the given depth (root == `EMPTY[depth]`). Leaf indices
    /// are below `1 << depth` in a `u64`, so the depth is below 64.
    pub fn new(depth: usize) -> Self {
        assert!(depth < u64::BITS as usize);
        Self {
            depth,
            nodes: HashMap::new(),
        }
    }

    #[inline]
    fn node(&self, height: u8, index: u64) -> Fr {
        self.nodes
            .get(&(height, index))
            .copied()
            .unwrap_or_else(|| merkle::empty(height as usize))
    }

    /// Value at `(height, index)` (empty-ladder fallback when unset). Lets the
    /// redb backend read the specific nodes it must upsert for O(delta) persist.
    pub fn node_value(&self, height: u8, index: u64) -> Fr {
        self.node(height, index)
    }

    /// Retain only the completed left subtrees needed to append leaf
    /// `leaf_count`, plus the current root. This is the in-memory frontier for
    /// an append-only tree; permanent nodes remain in the backing store for
    /// historical paths.
    pub(crate) fn retain_append_frontier(&mut self, leaf_count: u64) {
        assert!(leaf_count <= (1u64 << self.depth));
        self.nodes.retain(|&(height, index), _| {
            if height as usize == self.depth && index == 0 {
                return true;
            }
            height < self.depth as u8
                && ((leaf_count >> height) & 1) == 1
                && index == ((leaf_count >> height) ^ 1)
        });
    }

    #[cfg(test)]
    pub(crate) fn held_nodes(&self) -> usize {
        self.nodes.len()
    }

    /// Hold a persisted node without recomputing its ancestors.
    pub(crate) fn load_node(&mut self, height: u8, index: u64, value: Fr) {
        self.nodes.insert((height, index), value);
    }

    /// Drop every node but the root.
    pub(crate) fn retain_root(&mut self) {
        let root = self.root();
        self.nodes.clear();
        self.nodes.insert((self.depth as u8, 0), root);
    }

    /// Current root.
    pub fn root(&self) -> Fr {
        self.node(self.depth as u8, 0)
    }

    /// Set the leaf at `index` and recompute the path to the root.
    pub fn set_leaf(&mut self, index: u64, leaf: Fr) {
        self.set_leaf_inner(index, leaf, None);
    }

    pub(crate) fn set_leaf_with_undo(&mut self, index: u64, leaf: Fr, undo: &mut SparseTreeUndo) {
        self.set_leaf_inner(index, leaf, Some(undo));
    }

    fn set_leaf_inner(&mut self, index: u64, leaf: Fr, mut undo: Option<&mut SparseTreeUndo>) {
        assert!(index < (1u64 << self.depth), "leaf index out of range");
        self.put((0, index), leaf, undo.as_deref_mut());
        let mut idx = index;
        for h in 0..self.depth as u8 {
            let cur = self.node(h, idx);
            let sib = self.node(h, idx ^ 1);
            let parent = if idx & 1 == 0 {
                poseidon(&[cur, sib])
            } else {
                poseidon(&[sib, cur])
            };
            idx >>= 1;
            self.put((h + 1, idx), parent, undo.as_deref_mut());
        }
    }

    /// Set multiple leaves and recompute each affected parent once per level.
    /// Equivalent to calling [`Self::set_leaf`] in input order, including
    /// last-write-wins behavior when an index appears more than once.
    pub fn set_leaves(&mut self, leaves: &[(u64, Fr)]) {
        self.set_leaves_inner(leaves, None);
    }

    pub(crate) fn set_leaves_with_undo(&mut self, leaves: &[(u64, Fr)], undo: &mut SparseTreeUndo) {
        self.set_leaves_inner(leaves, Some(undo));
    }

    fn set_leaves_inner(&mut self, leaves: &[(u64, Fr)], mut undo: Option<&mut SparseTreeUndo>) {
        // Validate the whole batch before mutation, matching apply's atomic
        // validation boundary if this method is used outside InnerState.
        for &(index, _) in leaves {
            assert!(index < (1u64 << self.depth), "leaf index out of range");
        }

        let mut affected = Vec::with_capacity(leaves.len());
        for &(index, leaf) in leaves {
            self.put((0, index), leaf, undo.as_deref_mut());
            affected.push(index);
        }
        affected.sort_unstable();
        affected.dedup();

        for h in 0..self.depth as u8 {
            for index in &mut affected {
                *index >>= 1;
            }
            affected.dedup();

            for &parent_index in &affected {
                let left = self.node(h, parent_index << 1);
                let right = self.node(h, (parent_index << 1) | 1);
                self.put(
                    (h + 1, parent_index),
                    poseidon(&[left, right]),
                    undo.as_deref_mut(),
                );
            }
        }
    }

    pub(crate) fn restore(&mut self, undo: SparseTreeUndo) {
        for (key, value) in undo.nodes {
            restore_entry(&mut self.nodes, key, value);
        }
    }

    fn put(&mut self, key: (u8, u64), value: Fr, undo: Option<&mut SparseTreeUndo>) {
        if let Some(undo) = undo {
            undo.nodes
                .entry(key)
                .or_insert_with(|| self.nodes.get(&key).copied());
        }
        self.nodes.insert(key, value);
    }

    /// Sibling path (leaf level upward) of a depth-40 tree. Verifies via
    /// `root_from_index(leaf, index, &path)`. Trees of other depths do not use
    /// it: the depth-41 nullifier tree builds its own opening.
    pub fn path(&self, index: u64) -> [Fr; 40] {
        assert!(index < (1u64 << self.depth), "leaf index out of range");
        let mut out = [Fr::zero(); 40];
        let mut idx = index;
        for (h, sibling) in out.iter_mut().enumerate().take(self.depth) {
            *sibling = self.node(h as u8, idx ^ 1);
            idx >>= 1;
        }
        out
    }

    /// Serialize all populated nodes for persistence.
    pub fn to_entries(&self) -> Vec<(u8, u64, [u8; 32])> {
        let mut v: Vec<(u8, u64, [u8; 32])> = self
            .nodes
            .iter()
            .map(|(&(h, i), &f)| (h, i, fr_to_bytes(f).0))
            .collect();
        v.sort_unstable_by_key(|&(h, i, _)| (h, i));
        v
    }

    /// Load persisted nodes without recomputing their parent hashes.
    pub(crate) fn from_entries(depth: usize, entries: &[(u8, u64, [u8; 32])]) -> Self {
        let mut tree = Self::new(depth);
        for &(height, index, bytes) in entries {
            tree.nodes
                .insert((height, index), fr_from_internal_word(B256::from(bytes)));
        }
        tree
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
    use std::panic::{catch_unwind, AssertUnwindSafe};

    fn value(n: u64) -> Fr {
        Fr::from(n)
    }

    fn assert_same_tree(expected: &SparseTree, actual: &SparseTree, paths: &[u64]) {
        assert_eq!(actual.root(), expected.root());
        assert_eq!(actual.to_entries(), expected.to_entries());
        for &index in paths {
            assert_eq!(actual.path(index), expected.path(index));
        }
    }

    #[test]
    fn persisted_entries_restore_nodes_and_paths() {
        let mut original = SparseTree::new(8);
        original.set_leaves(&[(0, value(10)), (1, value(20)), (2, value(30))]);
        let entries = original.to_entries();
        let reloaded = SparseTree::from_entries(8, &entries);
        assert_same_tree(&original, &reloaded, &[0, 1, 2]);
    }

    #[test]
    fn batch_matches_ordered_leaf_updates() {
        let mut sequential = SparseTree::new(8);
        let mut batched = SparseTree::new(8);
        for (index, leaf) in [(2, value(20)), (7, value(70)), (200, value(200))] {
            sequential.set_leaf(index, leaf);
            batched.set_leaf(index, leaf);
        }

        let updates = [
            (3, value(30)),
            (7, value(71)),
            (128, value(128)),
            (3, value(31)),
            (7, Fr::zero()),
            (199, value(199)),
        ];
        for &(index, leaf) in &updates {
            sequential.set_leaf(index, leaf);
        }
        batched.set_leaves(&updates);

        assert_same_tree(&sequential, &batched, &[0, 2, 3, 7, 128, 199, 200, 255]);
    }

    #[test]
    fn empty_batch_is_a_noop_and_distinct_order_does_not_matter() {
        let mut a = SparseTree::new(8);
        a.set_leaf(9, value(9));
        let before = a.to_entries();
        a.set_leaves(&[]);
        assert_eq!(a.to_entries(), before);

        let mut b = SparseTree::new(8);
        b.set_leaf(9, value(9));
        a.set_leaves(&[(1, value(1)), (127, value(127)), (42, value(42))]);
        b.set_leaves(&[(42, value(42)), (1, value(1)), (127, value(127))]);
        assert_same_tree(&a, &b, &[1, 9, 42, 127]);
    }

    #[test]
    fn invalid_batch_does_not_partially_mutate() {
        let mut tree = SparseTree::new(8);
        tree.set_leaf(4, value(4));
        let before = tree.to_entries();

        let result = catch_unwind(AssertUnwindSafe(|| {
            tree.set_leaves(&[(5, value(5)), (256, value(6))]);
        }));

        assert!(result.is_err());
        assert_eq!(tree.to_entries(), before);
    }

    #[test]
    fn depth_leaves_a_u64_leaf_range() {
        let mut tree = SparseTree::new(63);
        tree.set_leaf((1 << 63) - 1, value(1));
        assert!(catch_unwind(|| SparseTree::new(64)).is_err());
    }
}
