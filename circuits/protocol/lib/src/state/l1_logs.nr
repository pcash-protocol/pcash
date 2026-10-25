// The L1 origin tree, and the proof-friendly normalization of canonical
// Ethereum logs into fixed-field leaves committed under each L1 origin leaf.

use crate::generated::pcash_constants::{L1_LOG_DOMAIN, L1_ORIGIN_DOMAIN};
use crate::primitives::hash::pcash_hash;
use crate::primitives::params::{
    BLOCK_HEADER_TREE_DEPTH, L1_LOG_TREE_DEPTH, L1_ORIGIN_INTEGER_BITS, L1_ORIGIN_TREE_DEPTH,
};
use crate::state::block::{block_header_fact, BLOCK_HEADER_KEY_L1_ORIGIN_ROOT};
use crate::state::merkle::binary_root_from_index;

// Where a log sits on L1, and the paths that open it. `assert_normalized_log`
// does not read `transaction_index` or `log_index`: the caller binds the log's
// position by hashing these two fields into the leaf it passes.
pub struct L1LogGrounding {
    pub l1_origin_root_siblings: [Field; BLOCK_HEADER_TREE_DEPTH],
    pub l1_block_number: Field,
    pub l1_block_hash_high: Field,
    pub l1_block_hash_low: Field,
    pub l1_block_timestamp: Field,
    pub l1_origin_index: Field,
    pub l1_origin_siblings: [Field; L1_ORIGIN_TREE_DEPTH],
    pub log_count: Field,
    pub log_leaf_index: Field,
    pub log_siblings: [Field; L1_LOG_TREE_DEPTH],
    pub transaction_index: Field,
    pub log_index: Field,
}

pub fn split_bytes32_128(value: [u8; 32]) -> (Field, Field) {
    let mut high: Field = 0;
    let mut low: Field = 0;
    for i in 0..16 {
        high = high * 256 + (value[i] as Field);
        low = low * 256 + (value[i + 16] as Field);
    }
    (high, low)
}

// One sponge over the log's fields. Topics are padded to four and split into
// big-endian 128-bit halves; data is split into 16-byte big-endian chunks and
// zero-padded to eight. This form covers logs with at most 128 data bytes.
// Membership under the node's logs root binds every hashed value, so callers
// open the leaf with `assert_normalized_log`.
pub fn normalized_log_leaf(
    transaction_index: Field,
    log_index: Field,
    emitter: Field,
    topic_count: Field,
    topic_limbs: [Field; 8],
    data_length: Field,
    data_limbs: [Field; 8],
) -> Field {
    pcash_hash([
        L1_LOG_DOMAIN,
        transaction_index,
        log_index,
        emitter,
        topic_count,
        topic_limbs[0],
        topic_limbs[1],
        topic_limbs[2],
        topic_limbs[3],
        topic_limbs[4],
        topic_limbs[5],
        topic_limbs[6],
        topic_limbs[7],
        data_length,
        data_limbs[0],
        data_limbs[1],
        data_limbs[2],
        data_limbs[3],
        data_limbs[4],
        data_limbs[5],
        data_limbs[6],
        data_limbs[7],
    ])
}

// The Ethereum block hash enters as its big-endian 128-bit halves.
pub fn l1_origin_leaf(
    block_number: Field,
    block_hash_high: Field,
    block_hash_low: Field,
    timestamp: Field,
    logs_root: Field,
    log_count: Field,
) -> Field {
    block_number.assert_max_bit_size::<L1_ORIGIN_INTEGER_BITS>();
    timestamp.assert_max_bit_size::<L1_ORIGIN_INTEGER_BITS>();
    log_count.assert_max_bit_size::<L1_ORIGIN_INTEGER_BITS>();
    pcash_hash([
        L1_ORIGIN_DOMAIN,
        block_number,
        block_hash_high,
        block_hash_low,
        timestamp,
        logs_root,
        log_count,
    ])
}

// Opens the log leaf up to the recent block's header: the log tree's root
// enters its L1 block's origin leaf, that leaf's path gives the L1 origin root,
// and the header must commit that root.
pub fn assert_normalized_log(
    recent_pcash_block_hash: Field,
    grounding: L1LogGrounding,
    log_leaf: Field,
) {
    assert(
        (grounding.log_leaf_index as u64) < (grounding.log_count as u64),
        "L1 log index must be below the log count",
    );
    let logs_root =
        binary_root_from_index(log_leaf, grounding.log_leaf_index, grounding.log_siblings);
    let block_leaf = l1_origin_leaf(
        grounding.l1_block_number,
        grounding.l1_block_hash_high,
        grounding.l1_block_hash_low,
        grounding.l1_block_timestamp,
        logs_root,
        grounding.log_count,
    );
    let l1_origin_root = binary_root_from_index(
        block_leaf,
        grounding.l1_origin_index,
        grounding.l1_origin_siblings,
    );
    block_header_fact(
        recent_pcash_block_hash,
        BLOCK_HEADER_KEY_L1_ORIGIN_ROOT,
        l1_origin_root,
        grounding.l1_origin_root_siblings,
    );
}

mod tests {
    use crate::generated::pcash_constants::L1_LOG_DOMAIN;
    use crate::primitives::hash::pcash_hash;
    use crate::primitives::params::{
        BLOCK_HEADER_TREE_DEPTH, L1_LOG_TREE_DEPTH, L1_ORIGIN_TREE_DEPTH,
    };
    use crate::state::block::{block_hash_from_opening, BLOCK_HEADER_KEY_L1_ORIGIN_ROOT};
    use crate::state::merkle::binary_root_from_index;
    use super::{assert_normalized_log, l1_origin_leaf, L1LogGrounding, normalized_log_leaf};

    // One authenticated fixture; mutate only the opening under test.
    fn log_fixture() -> (Field, L1LogGrounding, Field) {
        let log_leaf = normalized_log_leaf(
            5,
            2,
            0x1234,
            1,
            [1, 2, 0, 0, 0, 0, 0, 0],
            32,
            [3, 4, 0, 0, 0, 0, 0, 0],
        );
        let (recent_pcash_block_hash, grounding) = log_fixture_for(log_leaf);
        (recent_pcash_block_hash, grounding, log_leaf)
    }

    fn log_fixture_for(log_leaf: Field) -> (Field, L1LogGrounding) {
        let log_siblings: [Field; L1_LOG_TREE_DEPTH] = [0; L1_LOG_TREE_DEPTH];
        let logs_root = binary_root_from_index(log_leaf, 0, log_siblings);
        let block_leaf = l1_origin_leaf(100, 0xaaaa, 0xbbbb, 200, logs_root, 1);
        let l1_origin_siblings: [Field; L1_ORIGIN_TREE_DEPTH] = [0; L1_ORIGIN_TREE_DEPTH];
        let l1_origin_root = binary_root_from_index(block_leaf, 0, l1_origin_siblings);
        let header_siblings = [7, 8, 9, 10];
        let recent_pcash_block_hash = block_hash_from_opening(
            l1_origin_root,
            BLOCK_HEADER_KEY_L1_ORIGIN_ROOT,
            header_siblings,
        );
        let grounding = L1LogGrounding {
            l1_origin_root_siblings: header_siblings,
            l1_block_number: 100,
            l1_block_hash_high: 0xaaaa,
            l1_block_hash_low: 0xbbbb,
            l1_block_timestamp: 200,
            l1_origin_index: 0,
            l1_origin_siblings,
            log_count: 1,
            log_leaf_index: 0,
            log_siblings,
            transaction_index: 5,
            log_index: 2,
        };
        (recent_pcash_block_hash, grounding)
    }

    #[test]
    fn test_normalized_log_accepts_complete_membership() {
        let (root, grounding, leaf) = log_fixture();
        assert_normalized_log(root, grounding, leaf);
    }

    // Every opening below the header changes the L1 origin root the header must
    // commit.
    #[test(should_fail_with = "block header field must be in the block header tree")]
    fn test_normalized_log_rejects_another_leaf() {
        let (root, grounding, leaf) = log_fixture();
        assert_normalized_log(root, grounding, leaf + 1);
    }

    #[test(should_fail_with = "block header field must be in the block header tree")]
    fn test_normalized_log_rejects_another_ethereum_block() {
        let (root, mut grounding, leaf) = log_fixture();
        grounding.l1_block_hash_low += 1;
        assert_normalized_log(root, grounding, leaf);
    }

    #[test(should_fail_with = "block header field must be in the block header tree")]
    fn test_normalized_log_rejects_another_block_time() {
        let (root, mut grounding, leaf) = log_fixture();
        grounding.l1_block_timestamp += 1;
        assert_normalized_log(root, grounding, leaf);
    }

    #[test(should_fail_with = "L1 log index must be below the log count")]
    fn test_normalized_log_rejects_another_log_index() {
        let (root, mut grounding, leaf) = log_fixture();
        grounding.log_leaf_index = grounding.log_count;
        assert_normalized_log(root, grounding, leaf);
    }

    #[test(should_fail_with = "block header field must be in the block header tree")]
    fn test_normalized_log_rejects_another_log_sibling() {
        let (root, mut grounding, leaf) = log_fixture();
        grounding.log_siblings[L1_LOG_TREE_DEPTH - 1] += 1;
        assert_normalized_log(root, grounding, leaf);
    }

    #[test(should_fail_with = "block header field must be in the block header tree")]
    fn test_normalized_log_rejects_another_block_sibling() {
        let (root, mut grounding, leaf) = log_fixture();
        grounding.l1_origin_siblings[L1_ORIGIN_TREE_DEPTH - 1] += 1;
        assert_normalized_log(root, grounding, leaf);
    }

    #[test(should_fail_with = "block header field must be in the block header tree")]
    fn test_normalized_log_rejects_another_header_sibling() {
        let (root, mut grounding, leaf) = log_fixture();
        grounding.l1_origin_root_siblings[BLOCK_HEADER_TREE_DEPTH - 1] += 1;
        assert_normalized_log(root, grounding, leaf);
    }

    #[test(should_fail)]
    fn test_normalized_log_rejects_oversized_block_index() {
        let (root, mut grounding, leaf) = log_fixture();
        grounding.l1_origin_index = 0x10000000000;
        assert_normalized_log(root, grounding, leaf);
    }

    // A log with more than 128 data bytes has more than eight chunk slots in the
    // node's leaf, so the fixed eight-chunk leaf cannot open it.
    #[test(should_fail_with = "block header field must be in the block header tree")]
    fn test_normalized_log_rejects_log_longer_than_eight_chunks() {
        let mut inputs: [Field; 23] = [0; 23];
        inputs[0] = L1_LOG_DOMAIN;
        inputs[1] = 5;
        inputs[2] = 2;
        inputs[3] = 0x1234;
        inputs[4] = 1;
        inputs[5] = 1;
        inputs[6] = 2;
        inputs[13] = 144;
        for i in 0..9 {
            inputs[14 + i] = (i + 1) as Field;
        }
        let (root, grounding) = log_fixture_for(pcash_hash(inputs));
        let leaf = normalized_log_leaf(
            5,
            2,
            0x1234,
            1,
            [1, 2, 0, 0, 0, 0, 0, 0],
            144,
            [1, 2, 3, 4, 5, 6, 7, 8],
        );
        assert_normalized_log(root, grounding, leaf);
    }
}
