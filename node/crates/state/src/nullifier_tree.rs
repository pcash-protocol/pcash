//! The spent-nullifier set: an append-only, depth-41 indexed Poseidon tree.
//!
//! Leaf 0 is the sentinel and leaf `i > 0` holds the `i`-th nullifier
//! inserted. Every allocated leaf hashes its value with the smallest larger
//! value in the set and that value's leaf index, both zero at the end of the
//! list. For a nonzero `v`, a leaf holding `v` proves `v` spent, and a leaf
//! whose value is below `v` and whose next value is above it, or which ends
//! the list, proves `v` absent. Nullifiers are nonzero; the sentinel would
//! open 0 as spent.

use crate::field::{fr_from_canonical_bytes, fr_from_internal_word, fr_to_bytes};
use crate::tree::{SparseTree, SparseTreeUndo};
use alloy_primitives::B256;
use pcash_crypto::{domain_tags, merkle, poseidon, Fr};
use std::collections::{BTreeMap, BTreeSet};
use std::convert::Infallible;
use std::ops::Bound::{Excluded, Unbounded};

/// The sentinel takes leaf 0, and nullifiers never outnumber outputs, which
/// are capped at `2^40`.
pub const NULLIFIER_TREE_DEPTH: usize = 41;

/// The preimage of one allocated leaf.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NullifierLeaf {
    pub value: B256,
    pub next_value: B256,
    pub next_index: u64,
}

impl NullifierLeaf {
    pub const SENTINEL: Self = Self {
        value: B256::ZERO,
        next_value: B256::ZERO,
        next_index: 0,
    };

    /// The leaf of `value` whose successor in the set, with its index, is
    /// `next`.
    fn new(value: B256, next: Option<(B256, u64)>) -> Self {
        let (next_value, next_index) = next.unwrap_or_default();
        Self {
            value,
            next_value,
            next_index,
        }
    }

    pub fn hash(&self) -> Fr {
        poseidon(&[
            domain_tags::NULLIFIER_LEAF_DOMAIN,
            fr_from_internal_word(self.value),
            fr_from_internal_word(self.next_value),
            Fr::from(self.next_index),
        ])
    }

    /// Whether `value` lies in the gap after this leaf: above its value, and
    /// below its next value unless the leaf ends the list.
    pub fn is_low_leaf_of(&self, value: B256) -> bool {
        self.value < value
            && (value < self.next_value || (self.next_value == B256::ZERO && self.next_index == 0))
    }
}

/// The leaf holding `nullifier`, or its low leaf, opened at `index`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NullifierProof {
    pub nullifier: B256,
    pub leaf: NullifierLeaf,
    pub index: u64,
    pub siblings: [Fr; NULLIFIER_TREE_DEPTH],
}

impl NullifierProof {
    pub fn spent(&self) -> bool {
        self.leaf.value == self.nullifier
    }

    pub fn root(&self) -> Fr {
        merkle::root_from_index(self.leaf.hash(), self.index, &self.siblings)
    }

    /// Whether the leaf opens under `nullifier_root` and holds or brackets the
    /// nullifier. Every word must be a canonical field encoding: the leaf
    /// hash reduces modulo `p` and the comparisons do not, so `x + p` would
    /// hash as `x` while comparing above it.
    pub fn verify(&self, nullifier_root: B256) -> bool {
        [self.nullifier, self.leaf.value, self.leaf.next_value]
            .into_iter()
            .all(|word| fr_from_canonical_bytes(word).is_some())
            && self.index < 1 << NULLIFIER_TREE_DEPTH
            && (self.spent() || self.leaf.is_low_leaf_of(self.nullifier))
            && fr_to_bytes(self.root()) == nullifier_root
    }
}

/// The proof for `nullifier` given the largest value in the set not above it,
/// the smallest value above it, each with its leaf index, and the tree's
/// nodes. No value at or below means the sentinel.
pub(crate) fn prove<E>(
    nullifier: B256,
    at_or_below: Option<(B256, u64)>,
    above: Option<(B256, u64)>,
    mut node: impl FnMut(u8, u64) -> Result<Fr, E>,
) -> Result<NullifierProof, E> {
    let (value, index) = at_or_below.unwrap_or_default();
    let mut siblings = [Fr::from(0u64); NULLIFIER_TREE_DEPTH];
    for (height, sibling) in siblings.iter_mut().enumerate() {
        *sibling = node(height as u8, (index >> height) ^ 1)?;
    }
    Ok(NullifierProof {
        nullifier,
        leaf: NullifierLeaf::new(value, above),
        index,
        siblings,
    })
}

/// What one batch of insertions wrote.
pub(crate) struct NullifierInsertion {
    /// Each inserted nullifier with its leaf index, in insertion order.
    pub(crate) inserted: Vec<(B256, u64)>,
    /// Every leaf whose hash changed: the new leaves and the predecessors.
    pub(crate) rewritten: Vec<u64>,
}

pub(crate) struct NullifierTreeUndo {
    nodes: SparseTreeUndo,
    count: u64,
    inserted: Vec<B256>,
}

/// The tree's nodes, the leaf index of each value, and the nullifier count.
/// The in-memory backend holds the whole tree; the persistent backend holds
/// the root and the rows the current block reads.
#[derive(Clone)]
pub struct NullifierTree {
    nodes: SparseTree,
    indices: BTreeMap<B256, u64>,
    count: u64,
}

impl Default for NullifierTree {
    fn default() -> Self {
        Self::new()
    }
}

impl NullifierTree {
    /// The empty set: only the sentinel.
    pub fn new() -> Self {
        let mut nodes = SparseTree::new(NULLIFIER_TREE_DEPTH);
        nodes.set_leaf(0, NullifierLeaf::SENTINEL.hash());
        Self {
            nodes,
            indices: BTreeMap::new(),
            count: 0,
        }
    }

    /// A tree whose rows are elsewhere, holding only its root and count.
    pub(crate) fn with_root(root: Fr, count: u64) -> Self {
        let mut nodes = SparseTree::new(NULLIFIER_TREE_DEPTH);
        nodes.load_node(NULLIFIER_TREE_DEPTH as u8, 0, root);
        Self {
            nodes,
            indices: BTreeMap::new(),
            count,
        }
    }

    pub fn root(&self) -> Fr {
        self.nodes.root()
    }

    /// The number of nullifiers; the sentinel is not one.
    pub fn count(&self) -> u64 {
        self.count
    }

    pub fn contains(&self, nullifier: B256) -> bool {
        self.indices.contains_key(&nullifier)
    }

    pub(crate) fn nodes(&self) -> &SparseTree {
        &self.nodes
    }

    fn below(&self, value: B256) -> Option<(B256, u64)> {
        let (&value, &index) = self.indices.range(..value).next_back()?;
        Some((value, index))
    }

    fn above(&self, value: B256) -> Option<(B256, u64)> {
        let (&value, &index) = self.indices.range((Excluded(value), Unbounded)).next()?;
        Some((value, index))
    }

    fn index_of(&self, value: B256) -> u64 {
        if value == B256::ZERO {
            0
        } else {
            self.indices[&value]
        }
    }

    pub fn proof(&self, nullifier: B256) -> NullifierProof {
        let at_or_below = self
            .indices
            .range(..=nullifier)
            .next_back()
            .map(|(&value, &index)| (value, index));
        let Ok(proof) = prove(
            nullifier,
            at_or_below,
            self.above(nullifier),
            |height, index| Ok::<_, Infallible>(self.nodes.node_value(height, index)),
        );
        proof
    }

    /// The journal that reverts every insertion made from here on.
    pub(crate) fn begin_undo(&self) -> NullifierTreeUndo {
        NullifierTreeUndo {
            nodes: SparseTreeUndo::default(),
            count: self.count,
            inserted: Vec::new(),
        }
    }

    /// Insert `nullifiers`, each new to the set, at the next leaf indices in
    /// order. Each new leaf and each predecessor whose next pointer changed is
    /// hashed once from the set after the whole batch, and their paths are
    /// recomputed together; the tree equals inserting the nullifiers one at a
    /// time.
    pub(crate) fn insert_with_undo(
        &mut self,
        nullifiers: &[B256],
        undo: &mut NullifierTreeUndo,
    ) -> NullifierInsertion {
        let mut inserted = Vec::with_capacity(nullifiers.len());
        for &nullifier in nullifiers {
            self.count += 1;
            self.indices.insert(nullifier, self.count);
            undo.inserted.push(nullifier);
            inserted.push((nullifier, self.count));
        }
        // The sentinel stands in as value zero.
        let mut changed = BTreeSet::new();
        for &nullifier in nullifiers {
            changed.insert(nullifier);
            changed.insert(self.below(nullifier).map_or(B256::ZERO, |(value, _)| value));
        }
        let leaves = changed
            .into_iter()
            .map(|value| {
                let leaf = NullifierLeaf::new(value, self.above(value));
                (self.index_of(value), leaf.hash())
            })
            .collect::<Vec<_>>();
        self.nodes.set_leaves_with_undo(&leaves, &mut undo.nodes);
        NullifierInsertion {
            inserted,
            rewritten: leaves.into_iter().map(|(index, _)| index).collect(),
        }
    }

    pub(crate) fn restore(&mut self, undo: NullifierTreeUndo) {
        self.nodes.restore(undo.nodes);
        for nullifier in undo.inserted {
            self.indices.remove(&nullifier);
        }
        self.count = undo.count;
    }

    /// Hold a stored value's leaf index.
    pub(crate) fn load_index(&mut self, value: B256, index: u64) {
        self.indices.insert(value, index);
    }

    /// Hold a stored node.
    pub(crate) fn load_node(&mut self, height: u8, index: u64, value: Fr) {
        self.nodes.load_node(height, index, value);
    }

    /// Drop every held row, keeping the root and count.
    pub(crate) fn evict(&mut self) {
        self.indices.clear();
        self.nodes.retain_root();
    }

    #[cfg(test)]
    pub(crate) fn held_rows(&self) -> (usize, usize) {
        (self.indices.len(), self.nodes.to_entries().len())
    }

    /// The tree's definition: one insertion at a time. The new leaf takes the
    /// low leaf's successor, then the low leaf points at the new leaf, and
    /// each write recomputes its own path.
    #[cfg(test)]
    pub(crate) fn insert_sequentially(&mut self, nullifier: B256) {
        let (low_value, low_index) = self.below(nullifier).unwrap_or_default();
        let next = self.above(nullifier);
        self.count += 1;
        let index = self.count;
        self.indices.insert(nullifier, index);
        self.nodes
            .set_leaf(index, NullifierLeaf::new(nullifier, next).hash());
        self.nodes.set_leaf(
            low_index,
            NullifierLeaf::new(low_value, Some((nullifier, index))).hash(),
        );
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

    fn value(n: u64) -> B256 {
        fr_to_bytes(Fr::from(n))
    }

    /// `p - 1`, the largest canonical value.
    fn top() -> B256 {
        fr_to_bytes(-Fr::from(1u64))
    }

    fn batched(blocks: &[&[B256]]) -> NullifierTree {
        let mut tree = NullifierTree::new();
        for block in blocks {
            let mut undo = tree.begin_undo();
            tree.insert_with_undo(block, &mut undo);
        }
        tree
    }

    fn sequential(values: &[B256]) -> NullifierTree {
        let mut tree = NullifierTree::new();
        for &nullifier in values {
            tree.insert_sequentially(nullifier);
        }
        tree
    }

    fn assert_same_tree(left: &NullifierTree, right: &NullifierTree) {
        assert_eq!(left.root(), right.root());
        assert_eq!(left.count, right.count);
        assert_eq!(left.indices, right.indices);
        assert_eq!(left.nodes.to_entries(), right.nodes.to_entries());
    }

    /// Successive updates to one predecessor (100), a new minimum and maximum
    /// at the field's ends, and gaps filled from both sides.
    fn ordered_values() -> Vec<B256> {
        let mut values = [100u64, 300, 200, 150, 1, 250, 301, 299]
            .map(value)
            .to_vec();
        values.insert(4, top());
        values
    }

    #[test]
    fn batched_insertion_equals_sequential_insertion() {
        let values = ordered_values();
        let reference = sequential(&values);
        for split in 0..=values.len() {
            let (first, second) = values.split_at(split);
            assert_same_tree(&batched(&[first, second]), &reference);
        }
        assert_same_tree(&batched(&[&values]), &reference);
        let singles = values.iter().map(std::slice::from_ref).collect::<Vec<_>>();
        assert_same_tree(&batched(&singles), &reference);
    }

    #[test]
    fn the_root_depends_on_insertion_order() {
        let values = ordered_values();
        let mut reversed = values.clone();
        reversed.reverse();
        assert_ne!(sequential(&values).root(), sequential(&reversed).root());
    }

    #[test]
    fn leaves_link_the_values_in_order() {
        let tree = sequential(&ordered_values());
        let root = fr_to_bytes(tree.root());
        let mut proof = tree.proof(B256::ZERO);
        assert_eq!(proof.index, 0);
        let mut seen = 0;
        while proof.leaf.next_value != B256::ZERO {
            let next = tree.proof(proof.leaf.next_value);
            assert!(proof.leaf.value < next.leaf.value);
            assert_eq!(next.index, proof.leaf.next_index);
            assert!(next.verify(root));
            proof = next;
            seen += 1;
        }
        assert_eq!(proof.leaf.next_index, 0);
        assert_eq!(proof.leaf.value, top());
        assert_eq!(seen, tree.count);
    }

    #[test]
    fn proofs_show_membership_and_absence() {
        let tree = sequential(&ordered_values());
        let root = fr_to_bytes(tree.root());
        for spent in ordered_values() {
            let proof = tree.proof(spent);
            assert!(proof.spent());
            assert!(proof.verify(root));
        }
        for (absent, low) in [
            (value(2), value(1)),
            (value(99), value(1)),
            (value(151), value(150)),
            (value(302), value(301)),
            (fr_to_bytes(-Fr::from(2u64)), value(301)),
        ] {
            let proof = tree.proof(absent);
            assert!(!proof.spent());
            assert_eq!(proof.leaf.value, low);
            assert!(proof.verify(root));
        }
    }

    #[test]
    fn the_sentinel_is_the_low_leaf_below_the_minimum() {
        let empty = NullifierTree::new();
        let proof = empty.proof(value(7));
        assert_eq!((proof.leaf, proof.index), (NullifierLeaf::SENTINEL, 0));
        assert!(proof.verify(fr_to_bytes(empty.root())));

        let tree = sequential(&[value(100)]);
        let proof = tree.proof(value(50));
        assert_eq!(proof.index, 0);
        assert_eq!(
            proof.leaf,
            NullifierLeaf {
                value: B256::ZERO,
                next_value: value(100),
                next_index: 1,
            }
        );
        assert!(proof.verify(fr_to_bytes(tree.root())));
    }

    #[test]
    fn low_leaf_edges() {
        let leaf = NullifierLeaf {
            value: value(11),
            next_value: value(13),
            next_index: 2,
        };
        assert!(leaf.is_low_leaf_of(value(12)));
        assert!(!leaf.is_low_leaf_of(value(11)));
        assert!(!leaf.is_low_leaf_of(value(13)));
        assert!(!leaf.is_low_leaf_of(value(14)));
        assert!(!leaf.is_low_leaf_of(value(10)));
        let last = NullifierLeaf {
            next_value: B256::ZERO,
            next_index: 0,
            ..leaf
        };
        assert!(last.is_low_leaf_of(top()));
        assert!(!last.is_low_leaf_of(value(11)));
        assert!(NullifierLeaf::SENTINEL.is_low_leaf_of(value(1)));
        // The end of the list needs both pointer fields zero.
        let dangling = NullifierLeaf {
            next_index: 3,
            ..last
        };
        assert!(!dangling.is_low_leaf_of(value(12)));
    }

    #[test]
    fn forged_proofs_fail() {
        let tree = sequential(&ordered_values());
        let root = fr_to_bytes(tree.root());
        let unused = tree.count + 1;
        let siblings = |index: u64| {
            std::array::from_fn(|height| tree.nodes.node_value(height as u8, (index >> height) ^ 1))
        };
        // An unused slot holds 0, which no allocated leaf hashes to: an
        // all-zero preimage there would otherwise bracket every value.
        let forged = NullifierProof {
            nullifier: value(150),
            leaf: NullifierLeaf::SENTINEL,
            index: unused,
            siblings: siblings(unused),
        };
        assert!(forged.leaf.is_low_leaf_of(forged.nullifier));
        assert!(!forged.verify(root));

        // A real leaf whose next value is the nullifier.
        let mut forged = tree.proof(value(151));
        forged.nullifier = value(200);
        assert!(!forged.verify(root));

        // An index that differs only above the tree's depth.
        let mut aliased = tree.proof(value(150));
        assert!(aliased.verify(root));
        aliased.index += 1 << NULLIFIER_TREE_DEPTH;
        assert!(!aliased.verify(root));

        // The predecessor's leaf from before its pointer moved.
        let stale = sequential(&ordered_values()[..2]).proof(value(200));
        assert_eq!(stale.leaf.next_value, value(300));
        assert!(!stale.verify(root));
    }

    #[test]
    fn undo_restores_the_tree() {
        let values = ordered_values();
        let (first, second) = values.split_at(4);
        let mut tree = batched(&[first]);
        let before = tree.clone();
        let mut undo = tree.begin_undo();
        tree.insert_with_undo(second, &mut undo);
        tree.restore(undo);
        assert_same_tree(&tree, &before);
    }

    #[test]
    fn insertion_reports_each_rewritten_leaf() {
        let mut tree = batched(&[&[value(100), value(300)]]);
        let mut undo = tree.begin_undo();
        let mut insertion = tree.insert_with_undo(&[value(200), value(150), value(1)], &mut undo);
        assert_eq!(
            insertion.inserted,
            vec![(value(200), 3), (value(150), 4), (value(1), 5)]
        );
        insertion.rewritten.sort_unstable();
        // The sentinel, 100, and the three new leaves.
        assert_eq!(insertion.rewritten, vec![0, 1, 3, 4, 5]);
    }

    fn word(value: &serde_json::Value) -> B256 {
        value.as_str().unwrap().parse().unwrap()
    }

    fn field(value: &serde_json::Value) -> Fr {
        crate::fr_from_canonical_bytes(word(value)).unwrap()
    }

    fn published_leaf(leaf: &serde_json::Value) -> NullifierLeaf {
        NullifierLeaf {
            value: word(&leaf["value"]),
            next_value: word(&leaf["nextValue"]),
            next_index: leaf["nextIndex"].as_u64().unwrap(),
        }
    }

    fn published_proof(proof: &serde_json::Value) -> NullifierProof {
        let siblings = proof["siblings"].as_array().unwrap();
        assert_eq!(siblings.len(), NULLIFIER_TREE_DEPTH);
        NullifierProof {
            nullifier: word(&proof["nullifier"]),
            leaf: published_leaf(&proof["leaf"]),
            index: proof["leafIndex"].as_u64().unwrap(),
            siblings: std::array::from_fn(|height| field(&siblings[height])),
        }
    }

    #[test]
    fn published_vectors_match() {
        let vectors: serde_json::Value =
            serde_json::from_str(include_str!("../../../../vectors/protocol_vectors.json"))
                .unwrap();
        let published = &vectors["nullifierTree"];
        assert_eq!(
            published["depth"].as_u64(),
            Some(NULLIFIER_TREE_DEPTH as u64)
        );
        assert_eq!(
            NullifierLeaf::SENTINEL.hash(),
            field(&published["sentinel"]["leaf"])
        );
        assert_eq!(
            NullifierTree::new().root(),
            field(&published["sentinel"]["root"])
        );

        let insertions = published["insertions"].as_array().unwrap();
        let values = insertions
            .iter()
            .map(|insertion| word(&insertion["value"]))
            .collect::<Vec<_>>();
        let mut one_at_a_time = NullifierTree::new();
        for insertion in insertions {
            one_at_a_time.insert_sequentially(word(&insertion["value"]));
            assert_eq!(Some(one_at_a_time.count), insertion["index"].as_u64());
            assert_eq!(one_at_a_time.root(), field(&insertion["root"]));
        }
        let mut by_block = NullifierTree::new();
        let mut inserted = 0;
        for size in published["blockSizes"].as_array().unwrap() {
            let size = size.as_u64().unwrap() as usize;
            let mut undo = by_block.begin_undo();
            by_block.insert_with_undo(&values[inserted..inserted + size], &mut undo);
            inserted += size;
            assert_eq!(by_block.root(), field(&insertions[inserted - 1]["root"]));
        }
        assert_eq!(inserted, values.len());
        assert_same_tree(&by_block, &one_at_a_time);
        assert_eq!(by_block.root(), field(&published["root"]));
        assert_eq!(Some(by_block.count), published["count"].as_u64());

        for leaf in published["leaves"].as_array().unwrap() {
            let proof = by_block.proof(word(&leaf["value"]));
            assert_eq!(proof.leaf, published_leaf(leaf));
            assert_eq!(Some(proof.index), leaf["index"].as_u64());
            assert_eq!(proof.leaf.hash(), field(&leaf["hash"]));
        }
        for vector in published["proofs"].as_array().unwrap() {
            let at = vector["insertions"].as_u64().unwrap() as usize;
            let proof = published_proof(vector);
            assert_eq!(sequential(&values[..at]).proof(proof.nullifier), proof);
            assert_eq!(Some(proof.spent()), vector["spent"].as_bool());
            assert!(proof.verify(word(&vector["root"])));
        }
        let root = fr_to_bytes(by_block.root());
        for vector in published["forgedProofs"].as_array().unwrap() {
            assert!(!published_proof(vector).verify(root), "{}", vector["name"]);
        }
        for case in published["lowLeafCases"].as_array().unwrap() {
            assert_eq!(
                Some(published_leaf(&case["leaf"]).is_low_leaf_of(word(&case["nullifier"]))),
                case["isLowLeaf"].as_bool()
            );
        }
    }
}
