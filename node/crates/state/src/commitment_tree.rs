//! Fixed depth-4 commitment tree with a domain-separated internal-node hash.

use ark_ff::Zero;
use pcash_crypto::{poseidon, Fr};

pub(crate) const TYPED_COMMITMENT_TREE_DEPTH: usize = 4;
const TYPED_COMMITMENT_LEAF_COUNT: usize = 1 << TYPED_COMMITMENT_TREE_DEPTH;

#[derive(Clone)]
pub(crate) struct TypedCommitmentTree {
    leaves: [Fr; TYPED_COMMITMENT_LEAF_COUNT],
    level_one: [Fr; 8],
    level_two: [Fr; 4],
    level_three: [Fr; 2],
    root: Fr,
}

impl TypedCommitmentTree {
    pub(crate) fn new(domain: Fr, assigned_leaves: &[Fr]) -> Self {
        assert!(assigned_leaves.len() <= TYPED_COMMITMENT_LEAF_COUNT);
        let mut leaves = [Fr::zero(); TYPED_COMMITMENT_LEAF_COUNT];
        leaves[..assigned_leaves.len()].copy_from_slice(assigned_leaves);
        let level_one = std::array::from_fn(|index| {
            poseidon(&[domain, leaves[index * 2], leaves[index * 2 + 1]])
        });
        let level_two = std::array::from_fn(|index| {
            poseidon(&[domain, level_one[index * 2], level_one[index * 2 + 1]])
        });
        let level_three = std::array::from_fn(|index| {
            poseidon(&[domain, level_two[index * 2], level_two[index * 2 + 1]])
        });
        let root = poseidon(&[domain, level_three[0], level_three[1]]);
        Self {
            leaves,
            level_one,
            level_two,
            level_three,
            root,
        }
    }

    pub(crate) fn root(&self) -> Fr {
        self.root
    }

    pub(crate) fn path(&self, key: u64) -> Option<(Fr, [Fr; TYPED_COMMITMENT_TREE_DEPTH])> {
        if key >= TYPED_COMMITMENT_LEAF_COUNT as u64 {
            return None;
        }
        let key = key as usize;
        Some((
            self.leaves[key],
            [
                self.leaves[key ^ 1],
                self.level_one[(key >> 1) ^ 1],
                self.level_two[(key >> 2) ^ 1],
                self.level_three[(key >> 3) ^ 1],
            ],
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root_from_path(domain: Fr, leaf: Fr, key: u64, siblings: &[Fr; 4]) -> Fr {
        siblings
            .iter()
            .enumerate()
            .fold(leaf, |current, (height, sibling)| {
                if (key >> height) & 1 == 0 {
                    poseidon(&[domain, current, *sibling])
                } else {
                    poseidon(&[domain, *sibling, current])
                }
            })
    }

    #[test]
    fn paths_reconstruct_the_typed_root() -> Result<(), String> {
        let domain = Fr::from(99u64);
        let leaves = std::array::from_fn::<_, 9, _>(|index| Fr::from(index as u64 + 1));
        let tree = TypedCommitmentTree::new(domain, &leaves);
        for key in 0..16 {
            let (leaf, siblings) = tree
                .path(key)
                .ok_or_else(|| format!("depth-4 key {key} must open"))?;
            assert_eq!(root_from_path(domain, leaf, key, &siblings), tree.root());
        }
        Ok(())
    }

    #[test]
    fn the_domain_separates_every_internal_node() {
        let leaves = [Fr::from(7u64); 8];
        assert_ne!(
            TypedCommitmentTree::new(Fr::from(1u64), &leaves).root(),
            TypedCommitmentTree::new(Fr::from(2u64), &leaves).root()
        );
    }
}
