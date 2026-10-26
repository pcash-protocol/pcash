// Result openings under the recent block and the history root it commits.
use crate::generated::pcash_constants::{
    PAYOUT_RESULT_DOMAIN, TRANSACTION_RESULT_DOMAIN, TRANSACTION_RESULTS_ROOT_DOMAIN,
    TRANSACTION_STATEMENT_DOMAIN,
};
use crate::primitives::hash::pcash_hash;
use crate::primitives::params::{BLOCK_HEADER_TREE_DEPTH, HISTORY_TREE_DEPTH};
use crate::state::block::{
    block_hash_from_opening, BLOCK_HEADER_KEY_TRANSACTION_RESULTS_ROOT, history_fact,
};
use crate::state::merkle::binary_root_from_index;

global RESULT_TREE_DEPTH: u32 = 64;

pub struct ResultOpening {
    // Bound only when the result is in a history block, not the recent block.
    pub block_number: Field,
    pub history_siblings: [Field; HISTORY_TREE_DEPTH],
    pub results_header_siblings: [Field; BLOCK_HEADER_TREE_DEPTH],
    pub transaction_count: u64,
    pub payout_count: u64,
    pub result_index: u64,
    pub result_siblings: [Field; RESULT_TREE_DEPTH],
}

pub struct TransactionResult {
    pub tx_type: Field,
    pub account_creation: Field,
    pub l1_transaction_index: Field,
    pub batch_item_index: Field,
    pub outcome: Field,
    pub poster_owner_commitment: Field,
    pub output_start_index: Field,
    pub statement_hash: Field,
}

pub struct PayoutResult {
    pub output_index: Field,
    pub owner_commitment: Field,
    pub open_fee_amount: Field,
    pub issuance_amount: Field,
}

pub fn statement_hash<let N: u32>(statement: [Field; N]) -> Field {
    let mut words = [0; N + 1];
    words[0] = TRANSACTION_STATEMENT_DOMAIN;
    for i in 0..N {
        words[i + 1] = statement[i];
    }
    pcash_hash(words)
}

pub fn transaction_result_leaf(result: TransactionResult) -> Field {
    pcash_hash([
        TRANSACTION_RESULT_DOMAIN,
        result.tx_type,
        result.account_creation,
        result.l1_transaction_index,
        result.batch_item_index,
        result.outcome,
        result.poster_owner_commitment,
        result.output_start_index,
        result.statement_hash,
    ])
}

pub fn payout_result_leaf(result: PayoutResult) -> Field {
    pcash_hash([
        PAYOUT_RESULT_DOMAIN,
        result.output_index,
        result.owner_commitment,
        result.open_fee_amount,
        result.issuance_amount,
    ])
}

// Opens the result leaf up to its block: the result tree's root gives the
// block's transaction results root, whose header path gives the block hash.
// That block is the recent block, or one `history_root` commits. This function
// does not authenticate `history_root`: the caller must open it at
// BLOCK_HEADER_KEY_HISTORY_ROOT of `recent_pcash_block_hash`.
pub fn assert_result(
    recent_pcash_block_hash: Field,
    history_root: Field,
    opening: ResultOpening,
    leaf: Field,
    is_payout: bool,
) {
    if is_payout {
        assert(
            opening.result_index >= opening.transaction_count,
            "payout result must follow the transactions",
        );
        assert(
            opening.result_index - opening.transaction_count < opening.payout_count,
            "payout result index must be in range",
        );
    } else {
        assert(
            opening.result_index < opening.transaction_count,
            "transaction result index must be in range",
        );
    }
    let root = binary_root_from_index(leaf, opening.result_index as Field, opening.result_siblings);
    let results_root = pcash_hash([
        TRANSACTION_RESULTS_ROOT_DOMAIN,
        opening.transaction_count as Field,
        opening.payout_count as Field,
        root,
    ]);
    let block_hash = block_hash_from_opening(
        results_root,
        BLOCK_HEADER_KEY_TRANSACTION_RESULTS_ROOT,
        opening.results_header_siblings,
    );
    if block_hash != recent_pcash_block_hash {
        history_fact(
            history_root,
            opening.block_number,
            block_hash,
            opening.history_siblings,
        );
    }
}

mod tests {
    use crate::generated::pcash_constants::TRANSACTION_RESULTS_ROOT_DOMAIN;
    use crate::primitives::hash::pcash_hash;
    use crate::primitives::params::{BLOCK_HEADER_TREE_DEPTH, HISTORY_TREE_DEPTH};
    use crate::state::block::{
        block_hash_from_opening, BLOCK_HEADER_KEY_TRANSACTION_RESULTS_ROOT, history_leaf,
    };
    use crate::state::merkle::binary_root_from_index;
    use super::{assert_result, RESULT_TREE_DEPTH, ResultOpening};

    global LEAF: Field = 0x1eaf;

    // Transaction result 1 of a block with 3 transactions and 2 payouts, at
    // block number 9. Returns its opening, the block's hash, and a history root
    // that commits the block.
    fn result_fixture() -> (ResultOpening, Field, Field) {
        let mut result_siblings = [0; RESULT_TREE_DEPTH];
        result_siblings[0] = 0x51;
        result_siblings[5] = 0x52;
        let root = binary_root_from_index(LEAF, 1, result_siblings);
        let results_root = pcash_hash([TRANSACTION_RESULTS_ROOT_DOMAIN, 3, 2, root]);
        let header_siblings: [Field; BLOCK_HEADER_TREE_DEPTH] = [0x61, 0x62, 0x63, 0x64];
        let block_hash = block_hash_from_opening(
            results_root,
            BLOCK_HEADER_KEY_TRANSACTION_RESULTS_ROOT,
            header_siblings,
        );
        let mut history_siblings = [0; HISTORY_TREE_DEPTH];
        history_siblings[2] = 0x71;
        let history_root = binary_root_from_index(history_leaf(block_hash), 9, history_siblings);
        let opening = ResultOpening {
            block_number: 9,
            history_siblings,
            results_header_siblings: header_siblings,
            transaction_count: 3,
            payout_count: 2,
            result_index: 1,
            result_siblings,
        };
        (opening, block_hash, history_root)
    }

    // The recent block's header opens the result, so no history opening runs.
    #[test]
    fn test_result_in_the_recent_block_needs_no_history() {
        let (opening, block_hash, _) = result_fixture();
        assert_result(block_hash, 0xdead, opening, LEAF, false);
    }

    #[test]
    fn test_result_in_an_earlier_block_opens_under_history() {
        let (opening, _, history_root) = result_fixture();
        assert_result(0xbeef, history_root, opening, LEAF, false);
    }

    #[test(should_fail_with = "block hash must be in the PCASH history tree")]
    fn test_result_in_an_earlier_block_rejects_another_history_root() {
        let (opening, _, history_root) = result_fixture();
        assert_result(0xbeef, history_root + 1, opening, LEAF, false);
    }

    // Every opening below the header moves the block hash off the recent block,
    // so the result must then open under history, which commits only the
    // genuine block.
    #[test(should_fail_with = "block hash must be in the PCASH history tree")]
    fn test_result_rejects_another_leaf() {
        let (opening, block_hash, history_root) = result_fixture();
        assert_result(block_hash, history_root, opening, LEAF + 1, false);
    }

    #[test(should_fail_with = "block hash must be in the PCASH history tree")]
    fn test_result_rejects_another_result_sibling() {
        let (mut opening, block_hash, history_root) = result_fixture();
        opening.result_siblings[5] = 0x53;
        assert_result(block_hash, history_root, opening, LEAF, false);
    }

    #[test(should_fail_with = "block hash must be in the PCASH history tree")]
    fn test_result_rejects_another_payout_count() {
        let (mut opening, block_hash, history_root) = result_fixture();
        opening.payout_count = 3;
        assert_result(block_hash, history_root, opening, LEAF, false);
    }

    #[test(should_fail_with = "block hash must be in the PCASH history tree")]
    fn test_result_rejects_another_header_sibling() {
        let (mut opening, block_hash, history_root) = result_fixture();
        opening.results_header_siblings[BLOCK_HEADER_TREE_DEPTH - 1] = 0x65;
        assert_result(block_hash, history_root, opening, LEAF, false);
    }

    #[test(should_fail_with = "transaction result index must be in range")]
    fn test_transaction_result_rejects_an_index_past_the_transactions() {
        let (mut opening, block_hash, history_root) = result_fixture();
        opening.transaction_count = 1;
        assert_result(block_hash, history_root, opening, LEAF, false);
    }

    #[test(should_fail_with = "payout result must follow the transactions")]
    fn test_payout_result_rejects_a_transaction_index() {
        let (opening, block_hash, history_root) = result_fixture();
        assert_result(block_hash, history_root, opening, LEAF, true);
    }
}
