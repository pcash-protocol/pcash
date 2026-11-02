//! Merkle tree node/path convention.
//!
//! - Internal node = `poseidon(left, right)`.
//! - Empty leaf = `0`; `EMPTY[0] = 0`, `EMPTY[h+1] = poseidon(EMPTY[h], EMPTY[h])`.
//! - Membership recomputation selects sides LSB-first from the tree key.

use crate::poseidon2::poseidon;
use crate::Fr;
use ark_ff::Zero;
use std::sync::OnceLock;

/// Maximum ladder depth we precompute (normalized L1 log trees use 64).
pub const MAX_DEPTH: usize = 64;

/// The empty-subtree ladder `EMPTY[0..=MAX_DEPTH]`, computed lazily once.
fn ladder() -> &'static [Fr; MAX_DEPTH + 1] {
    static LADDER: OnceLock<[Fr; MAX_DEPTH + 1]> = OnceLock::new();
    LADDER.get_or_init(|| {
        let mut l = [Fr::zero(); MAX_DEPTH + 1];
        l[0] = Fr::zero();
        for h in 0..MAX_DEPTH {
            l[h + 1] = poseidon(&[l[h], l[h]]);
        }
        l
    })
}

/// `EMPTY[height]`: the root of an all-empty subtree of the given height.
pub fn empty(height: usize) -> Fr {
    assert!(height <= MAX_DEPTH, "height {height} exceeds MAX_DEPTH");
    ladder()[height]
}

/// The levels of a depth-`depth` tree whose leaves are `leaves` at indices
/// `0..leaves.len()` and empty everywhere after. `levels[h]` holds the nodes
/// at height `h` that cover at least one leaf; an absent right child at height
/// `h` is `EMPTY[h]`, and an empty level stands for `EMPTY[h]` throughout.
pub fn dense_levels(leaves: Vec<Fr>, depth: usize) -> Vec<Vec<Fr>> {
    dense_levels_with(leaves, depth, |level, height| {
        level
            .chunks(2)
            .map(|pair| dense_parent(pair, height))
            .collect()
    })
}

/// [`dense_levels`], computing the level above `level` at `height` with
/// `parents`, which must return [`dense_parent`] of each two-node chunk in
/// order. A caller can hash large levels in parallel.
pub fn dense_levels_with(
    leaves: Vec<Fr>,
    depth: usize,
    mut parents: impl FnMut(&[Fr], usize) -> Vec<Fr>,
) -> Vec<Vec<Fr>> {
    let mut levels = Vec::with_capacity(depth + 1);
    levels.push(leaves);
    for height in 0..depth {
        let next = parents(&levels[height], height);
        levels.push(next);
    }
    levels
}

/// The parent of `pair`, one or two nodes at `height` starting at an even
/// index of a dense level; an absent right child is `EMPTY[height]`.
pub fn dense_parent(pair: &[Fr], height: usize) -> Fr {
    poseidon(&[
        pair[0],
        pair.get(1).copied().unwrap_or_else(|| empty(height)),
    ])
}

/// The root of [`dense_levels`].
pub fn dense_root(leaves: Vec<Fr>, depth: usize) -> Fr {
    dense_levels(leaves, depth)[depth]
        .first()
        .copied()
        .unwrap_or_else(|| empty(depth))
}

/// Recompute a Merkle root from a leaf, its tree-key index, and the sibling
/// path (leaf level upward). Side selection is LSB-first:
/// bit 0 => current node is the left child.
///
/// `index` must be below `2^siblings.len()`: only its low `siblings.len()`
/// bits are read, so a larger index yields the root for the truncated index.
/// Callers check it, as `NullifierProof::verify` does.
pub fn root_from_index(leaf: Fr, index: u64, siblings: &[Fr]) -> Fr {
    let mut cur = leaf;
    let mut idx = index;
    for sib in siblings {
        cur = if idx & 1 == 0 {
            poseidon(&[cur, *sib])
        } else {
            poseidon(&[*sib, cur])
        };
        idx >>= 1;
    }
    cur
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions"
)]
mod tests {
    use super::*;
    use ark_ff::Zero;

    #[test]
    fn empty_zero_and_recurrence() {
        assert_eq!(empty(0), Fr::zero());
        for height in 0..8 {
            assert_eq!(
                empty(height + 1),
                poseidon(&[empty(height), empty(height)]),
                "EMPTY[{}]",
                height + 1
            );
        }
    }

    #[test]
    fn empty_path_is_the_leaf() {
        let leaf = Fr::from(7u64);
        assert_eq!(root_from_index(leaf, 0, &[]), leaf);
    }

    #[test]
    fn depth_one_selects_left_or_right_from_lsb() {
        let leaf = Fr::from(11u64);
        let sibling = Fr::from(22u64);
        assert_eq!(
            root_from_index(leaf, 0, &[sibling]),
            poseidon(&[leaf, sibling])
        );
        assert_eq!(
            root_from_index(leaf, 1, &[sibling]),
            poseidon(&[sibling, leaf])
        );
    }

    #[test]
    fn dense_root_pads_with_empty_subtrees() {
        let leaves = [Fr::from(1u64), Fr::from(2u64), Fr::from(3u64)];
        let left = poseidon(&[leaves[0], leaves[1]]);
        let right = poseidon(&[leaves[2], empty(0)]);
        let expected = poseidon(&[poseidon(&[left, right]), empty(2)]);
        assert_eq!(dense_root(leaves.to_vec(), 3), expected);
        assert_eq!(
            root_from_index(leaves[2], 2, &[empty(0), left, empty(2)]),
            expected
        );
        assert_eq!(dense_root(Vec::new(), 3), empty(3));
    }

    #[test]
    #[should_panic(expected = "exceeds MAX_DEPTH")]
    fn empty_rejects_height_above_max_depth() {
        let _ = empty(MAX_DEPTH + 1);
    }
}
