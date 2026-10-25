// Typed PCASH block-header and state commitments, and the PCASH history tree.

use crate::generated::pcash_constants::{
    BLOCK_HEADER_DOMAIN, HISTORY_LEAF_DOMAIN, STATE_COMMITMENT_DOMAIN,
};
use crate::primitives::hash::pcash_hash;
use crate::primitives::params::{BLOCK_HEADER_TREE_DEPTH, HISTORY_TREE_DEPTH, STATE_TREE_DEPTH};
use crate::state::merkle::binary_root_from_index;

// The complete key tables of the block header and the state tree. Circuits
// open only some of these keys; the rest are listed so every key's position
// is stated in one place.
pub global BLOCK_HEADER_KEY_PARENT_HASH: u32 = 0;
pub global BLOCK_HEADER_KEY_NUMBER: u32 = 1;
pub global BLOCK_HEADER_KEY_TIMESTAMP: u32 = 2;
pub global BLOCK_HEADER_KEY_TRANSACTION_RESULTS_ROOT: u32 = 3;
pub global BLOCK_HEADER_KEY_STATE_ROOT: u32 = 4;
pub global BLOCK_HEADER_KEY_L1_ORIGIN_ROOT: u32 = 5;
pub global BLOCK_HEADER_KEY_HISTORY_ROOT: u32 = 6;

pub global STATE_KEY_OUTPUT_ROOT: u32 = 0;
pub global STATE_KEY_OUTPUT_COUNT: u32 = 1;
pub global STATE_KEY_ISSUED_SO_FAR: u32 = 2;
pub global STATE_KEY_LAG_HIGH128: u32 = 3;
pub global STATE_KEY_LAG_LOW128: u32 = 4;
pub global STATE_KEY_ACCOUNT_STATE_ROOT: u32 = 5;
pub global STATE_KEY_ACCOUNT_COUNT: u32 = 6;
pub global STATE_KEY_NULLIFIER_ROOT: u32 = 7;
pub global STATE_KEY_NULLIFIER_COUNT: u32 = 8;

// A typed sparse tree: each level hashes the tree's domain with its two
// children, and the key's bits choose the path.
fn typed_root<let DEPTH: u32>(
    domain: Field,
    value: Field,
    key: u32,
    siblings: [Field; DEPTH],
) -> Field {
    let bits: [bool; DEPTH] = (key as Field).to_le_bits();
    let mut current = value;
    for i in 0..DEPTH {
        let left = if bits[i] { siblings[i] } else { current };
        let right = if bits[i] { current } else { siblings[i] };
        current = pcash_hash([domain, left, right]);
    }
    current
}

pub fn state_root_from_opening(
    value: Field,
    key: u32,
    siblings: [Field; STATE_TREE_DEPTH],
) -> Field {
    typed_root(STATE_COMMITMENT_DOMAIN, value, key, siblings)
}

pub fn state_fact(state_root: Field, key: u32, value: Field, siblings: [Field; STATE_TREE_DEPTH]) {
    assert(
        state_root_from_opening(value, key, siblings) == state_root,
        "state field must be in the state tree",
    );
}

pub fn block_hash_from_opening(
    value: Field,
    key: u32,
    siblings: [Field; BLOCK_HEADER_TREE_DEPTH],
) -> Field {
    typed_root(BLOCK_HEADER_DOMAIN, value, key, siblings)
}

pub fn block_header_fact(
    block_hash: Field,
    key: u32,
    value: Field,
    siblings: [Field; BLOCK_HEADER_TREE_DEPTH],
) {
    assert(
        block_hash_from_opening(value, key, siblings) == block_hash,
        "block header field must be in the block header tree",
    );
}

// The path fixes the block number and the block hash commits it. The domain
// hash keeps a claimed zero block hash from matching an empty slot.
pub fn history_leaf(block_hash: Field) -> Field {
    pcash_hash([HISTORY_LEAF_DOMAIN, block_hash])
}

pub fn history_fact(
    history_root: Field,
    block_number: Field,
    block_hash: Field,
    siblings: [Field; HISTORY_TREE_DEPTH],
) {
    let leaf = history_leaf(block_hash);
    assert(
        binary_root_from_index(leaf, block_number, siblings) == history_root,
        "block hash must be in the PCASH history tree",
    );
}

mod tests {
    use crate::primitives::params::{BLOCK_HEADER_TREE_DEPTH, STATE_TREE_DEPTH};
    use super::{
        block_hash_from_opening, block_header_fact, BLOCK_HEADER_KEY_STATE_ROOT, state_fact,
        STATE_KEY_ACCOUNT_STATE_ROOT, state_root_from_opening,
    };

    #[test]
    fn test_typed_state_and_block_openings() {
        let siblings = [1, 2, 3, 4];
        let state_root = state_root_from_opening(0xfeed, STATE_KEY_ACCOUNT_STATE_ROOT, siblings);
        state_fact(state_root, STATE_KEY_ACCOUNT_STATE_ROOT, 0xfeed, siblings);
        let block_hash = block_hash_from_opening(state_root, BLOCK_HEADER_KEY_STATE_ROOT, siblings);
        block_header_fact(
            block_hash,
            BLOCK_HEADER_KEY_STATE_ROOT,
            state_root,
            siblings,
        );
        assert(state_root != block_hash);
    }

    #[test(should_fail_with = "state field must be in the state tree")]
    fn test_state_fact_rejects_wrong_value() {
        let siblings = [0; STATE_TREE_DEPTH];
        let root = state_root_from_opening(0xfeed, STATE_KEY_ACCOUNT_STATE_ROOT, siblings);
        state_fact(root, STATE_KEY_ACCOUNT_STATE_ROOT, 0xbeef, siblings);
    }

    #[test(should_fail_with = "block header field must be in the block header tree")]
    fn test_block_header_fact_rejects_wrong_value() {
        let siblings = [0; BLOCK_HEADER_TREE_DEPTH];
        let hash = block_hash_from_opening(0xfeed, BLOCK_HEADER_KEY_STATE_ROOT, siblings);
        block_header_fact(hash, BLOCK_HEADER_KEY_STATE_ROOT, 0xbeef, siblings);
    }
}
