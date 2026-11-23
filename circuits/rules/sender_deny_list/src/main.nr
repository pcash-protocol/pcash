// Sender deny-list transfer rule of a restricted asset.
//
// The configuration names a deny-list contract, one list on it, and the
// largest `delta` a publication may carry. The rule opens one unpaused
// `Publication(listId, root, paused, delta)` log of that list through the
// recent block's L1 origin tree, requires `delta` to be at most that maximum
// and the transaction's deadline to be at most the publication's Ethereum
// block time plus `delta`, and proves that the owner whose inputs move lies
// strictly inside one gap of the published sorted list. The maximum bounds how
// long any one publication authorizes transfers, whatever `delta` the issuer
// later sets. It never opens the private value, so one circuit
// serves both profiles and both restricted kernels.

use pcash_protocol::authorization::statement::{rule_statement, RULE_STATEMENT_LENGTH};
use pcash_protocol::ledger::asset::policy_context;
use pcash_protocol::primitives::hash::pcash_hash;
use pcash_protocol::state::l1_logs::{assert_normalized_log, L1LogGrounding, normalized_log_leaf};
use pcash_protocol::state::merkle::binary_root_from_index;
use reference_rule_common::generated::reference_rule_constants::{
    REFERENCE_DENY_LIST_CONFIGURATION_DOMAIN, REFERENCE_DENY_LIST_GAP_DOMAIN,
};

pub global DENY_LIST_TREE_DEPTH: u32 = 20;

// keccak256("Publication(bytes32,uint256,bool,uint64)") as big-endian 128-bit
// halves.
global PUBLICATION_TOPIC0_HIGH: Field = 0x926351d1bdc982eb7b14f6579a5b0bba;
global PUBLICATION_TOPIC0_LOW: Field = 0x64f919d051adf326ea4cb58d3e0e1796;
// abi.encode(root, paused, delta).
global PUBLICATION_DATA_LENGTH: Field = 96;
global TWO_POW_128: Field = 0x100000000000000000000000000000000;

pub struct DenyListConfiguration {
    pub contract_address: Field,
    pub list_id_high: Field,
    pub list_id_low: Field,
    pub max_delta: Field,
}

// The publication's root as 128-bit halves and its delta, as the log's data
// chunks carry them, and the log's opening.
pub struct Publication {
    pub root_high: Field,
    pub root_low: Field,
    pub delta: Field,
    pub log: L1LogGrounding,
}

// A leaf of the published tree: the open interval between two consecutive
// denied addresses, with 0 below the first and 2^160 above the last.
pub struct DenyListGap {
    pub lower: Field,
    pub upper: Field,
    pub index: Field,
    pub siblings: [Field; DENY_LIST_TREE_DEPTH],
}

pub fn configuration_commitment(configuration: DenyListConfiguration) -> Field {
    pcash_hash([
        REFERENCE_DENY_LIST_CONFIGURATION_DOMAIN,
        configuration.contract_address,
        configuration.list_id_high,
        configuration.list_id_low,
        configuration.max_delta,
    ])
}

pub fn gap_leaf(lower: Field, upper: Field) -> Field {
    pcash_hash([REFERENCE_DENY_LIST_GAP_DOMAIN, lower, upper])
}

fn main(
    asset_id: Field,
    owner_address: Field,
    valid_until_timestamp: Field,
    action_commitment: Field,
    recent_pcash_block_hash: Field,
    event_entry: Field,
    configuration: DenyListConfiguration,
    publication: Publication,
    gap: DenyListGap,
) -> return_data [Field; RULE_STATEMENT_LENGTH] {
    // The leaf fixes the paused word to zero, so a paused publication does not
    // open. Every chunk the node commits is below 2^128.
    let log_leaf = normalized_log_leaf(
        publication.log.transaction_index,
        publication.log.log_index,
        configuration.contract_address,
        2,
        [
            PUBLICATION_TOPIC0_HIGH,
            PUBLICATION_TOPIC0_LOW,
            configuration.list_id_high,
            configuration.list_id_low,
            0,
            0,
            0,
            0,
        ],
        PUBLICATION_DATA_LENGTH,
        [publication.root_high, publication.root_low, 0, 0, 0, publication.delta, 0, 0],
    );
    assert_normalized_log(recent_pcash_block_hash, publication.log, log_leaf);

    // A delta above the maximum wraps the difference far above 2^64.
    (configuration.max_delta - publication.delta).assert_max_bit_size::<64>();

    // The L1 origin leaf bounds the block time below 2^64 and the log leaf
    // bounds delta below 2^128, so their sum is below 2^129; the kernel bounds
    // the deadline below 2^64. A deadline past the sum wraps the difference
    // above 2^129.
    (publication.log.l1_block_timestamp + publication.delta - valid_until_timestamp)
        .assert_max_bit_size::<129>();

    // The contract stores only roots below the field modulus.
    let root = publication.root_high * TWO_POW_128 + publication.root_low;
    assert(gap.lower.lt(owner_address), "owner address must be above the gap's lower bound");
    assert(owner_address.lt(gap.upper), "owner address must be below the gap's upper bound");
    assert(
        binary_root_from_index(gap_leaf(gap.lower, gap.upper), gap.index, gap.siblings) == root,
        "gap must be in the published deny list",
    );

    rule_statement(
        policy_context(
            asset_id,
            configuration_commitment(configuration),
            owner_address,
            valid_until_timestamp,
        ),
        action_commitment,
        recent_pcash_block_hash,
        event_entry,
    )
}

mod tests {
    use super::{
        configuration_commitment, DENY_LIST_TREE_DEPTH, DenyListConfiguration, DenyListGap,
        gap_leaf, main, Publication, PUBLICATION_TOPIC0_HIGH, PUBLICATION_TOPIC0_LOW,
    };
    use pcash_protocol::authorization::statement::RULE_STATEMENT_LENGTH;
    use pcash_protocol::ledger::asset::policy_context;
    use pcash_protocol::primitives::hash::pcash_hash;
    use pcash_protocol::primitives::params::{L1_LOG_TREE_DEPTH, L1_ORIGIN_TREE_DEPTH};
    use pcash_protocol::state::block::{block_hash_from_opening, BLOCK_HEADER_KEY_L1_ORIGIN_ROOT};
    use pcash_protocol::state::l1_logs::{
        l1_origin_leaf, L1LogGrounding, normalized_log_leaf, split_bytes32_128,
    };
    use pcash_protocol::state::merkle::binary_root_from_index;

    global ADDRESS_LIMIT: Field = 0x10000000000000000000000000000000000000000;
    global CONTRACT: Field = 0x5fbdb2315678afecb367f032d93f642f64180aa3;
    global LIST_ID_HIGH: Field = 0x0123456789abcdef0123456789abcdef;
    global LIST_ID_LOW: Field = 0xfedcba9876543210fedcba9876543210;
    global DENIED_A: Field = 0x1000000000000000000000000000000000000001;
    global DENIED_B: Field = 0x3000000000000000000000000000000000000003;
    global OWNER: Field = 0x2000000000000000000000000000000000000002;
    global ASSET_ID: Field = 0x1000000000000000000000000000000000000000000000000000000000000abc;
    global ACTION: Field = 0xac7;
    global EVENT_ENTRY: Field = 0xe7;
    global BLOCK_TIME: Field = 1700000000;
    global DELTA: Field = 3600;
    global MAX_DELTA: Field = 7200;

    // Frozen from the SDK (sdk/test/senderDenyList.test.ts asserts the same
    // values): the configuration above, with MAX_DELTA, the gap (DENIED_A, DENIED_B), the roots
    // of {DENIED_A, DENIED_B} and of the empty list, and the publication of the
    // former's root with DELTA at transaction 5, log 2.
    global KAT_CONFIGURATION_COMMITMENT: Field =
        0x016a1f64fcf60005031453f0546bbd3ae9d4d835bb8e3a7d337cd7f97f81913e;
    global KAT_GAP_LEAF: Field = 0x019c14ddb43c21d299d7316c9302618c1b689109d603f2f31f20f147ca8c1e98;
    global KAT_ROOT: Field = 0x0f15b8a54c25218b91735ae5541e4dd2bf8c8434619ed3d84438ac7823d7fe0a;
    global KAT_EMPTY_ROOT: Field =
        0x1bf25e297989559b9950a906acb89a45c9968cb23b309cf510055e5b22cbe282;
    global KAT_PUBLICATION_LEAF: Field =
        0x0f6e44e4309c266eabcfeb9ec5a9efe63973a6d0b501cbd6404cfd307eede3f6;

    fn configuration() -> DenyListConfiguration {
        DenyListConfiguration {
            contract_address: CONTRACT,
            list_id_high: LIST_ID_HIGH,
            list_id_low: LIST_ID_LOW,
            max_delta: MAX_DELTA,
        }
    }

    // The root of a tree whose first four leaves are `leaves`, and the opening
    // of the leaf at `index` with bounds (lower, upper).
    fn gap_opening(
        leaves: [Field; 4],
        index: u32,
        lower: Field,
        upper: Field,
    ) -> (Field, DenyListGap) {
        let mut siblings: [Field; DENY_LIST_TREE_DEPTH] = [0; DENY_LIST_TREE_DEPTH];
        for i in 1..DENY_LIST_TREE_DEPTH {
            siblings[i] = pcash_hash([siblings[i - 1], siblings[i - 1]]);
        }
        let pairs = [pcash_hash([leaves[0], leaves[1]]), pcash_hash([leaves[2], leaves[3]])];
        siblings[0] = leaves[index ^ 1];
        siblings[1] = pairs[(index >> 1) ^ 1];
        let root = binary_root_from_index(leaves[index], index as Field, siblings);
        (root, DenyListGap { lower, upper, index: index as Field, siblings })
    }

    // The gaps of the list {DENIED_A, DENIED_B}.
    global BOUNDS: [Field; 4] = [0, DENIED_A, DENIED_B, ADDRESS_LIMIT];

    fn gap_of(index: u32) -> (Field, DenyListGap) {
        let leaves = [
            gap_leaf(BOUNDS[0], BOUNDS[1]),
            gap_leaf(BOUNDS[1], BOUNDS[2]),
            gap_leaf(BOUNDS[2], BOUNDS[3]),
            0,
        ];
        gap_opening(leaves, index, BOUNDS[index], BOUNDS[index + 1])
    }

    fn empty_list_gap() -> (Field, DenyListGap) {
        gap_opening([gap_leaf(0, ADDRESS_LIMIT), 0, 0, 0], 0, 0, ADDRESS_LIMIT)
    }

    // A log as the node commits it at transaction 5, log 2.
    fn log_leaf(emitter: Field, topics: [Field; 8], data: [Field; 8]) -> Field {
        normalized_log_leaf(5, 2, emitter, 2, topics, 96, data)
    }

    fn publication_topics() -> [Field; 8] {
        [PUBLICATION_TOPIC0_HIGH, PUBLICATION_TOPIC0_LOW, LIST_ID_HIGH, LIST_ID_LOW, 0, 0, 0, 0]
    }

    fn publication_data(root: Field, paused: Field) -> [Field; 8] {
        publication_data_with_delta(root, paused, DELTA)
    }

    fn publication_data_with_delta(root: Field, paused: Field, delta: Field) -> [Field; 8] {
        let (root_high, root_low) = split_bytes32_128(root.to_be_bytes());
        [root_high, root_low, 0, paused, 0, delta, 0, 0]
    }

    // The rule's publication of `root`, opened against a recent block whose
    // only L1 log is `committed_leaf`, built as the tests in
    // pcash_protocol::state::l1_logs build theirs.
    fn publication_for(root: Field, committed_leaf: Field) -> (Field, Publication) {
        publication_for_delta(root, committed_leaf, DELTA)
    }

    fn publication_for_delta(
        root: Field,
        committed_leaf: Field,
        delta: Field,
    ) -> (Field, Publication) {
        let log_siblings: [Field; L1_LOG_TREE_DEPTH] = [0; L1_LOG_TREE_DEPTH];
        let logs_root = binary_root_from_index(committed_leaf, 0, log_siblings);
        let block_leaf = l1_origin_leaf(100, 0xaaaa, 0xbbbb, BLOCK_TIME, logs_root, 1);
        let l1_origin_siblings: [Field; L1_ORIGIN_TREE_DEPTH] = [0; L1_ORIGIN_TREE_DEPTH];
        let l1_origin_root = binary_root_from_index(block_leaf, 0, l1_origin_siblings);
        let header_siblings = [7, 8, 9, 10];
        let recent = block_hash_from_opening(
            l1_origin_root,
            BLOCK_HEADER_KEY_L1_ORIGIN_ROOT,
            header_siblings,
        );
        let log = L1LogGrounding {
            l1_origin_root_siblings: header_siblings,
            l1_block_number: 100,
            l1_block_hash_high: 0xaaaa,
            l1_block_hash_low: 0xbbbb,
            l1_block_timestamp: BLOCK_TIME,
            l1_origin_index: 0,
            l1_origin_siblings,
            log_count: 1,
            log_leaf_index: 0,
            log_siblings,
            transaction_index: 5,
            log_index: 2,
        };
        let (root_high, root_low) = split_bytes32_128(root.to_be_bytes());
        (recent, Publication { root_high, root_low, delta, log })
    }

    // The publication the contract emits for `root`.
    fn published(root: Field) -> (Field, Publication) {
        publication_for(
            root,
            log_leaf(CONTRACT, publication_topics(), publication_data(root, 0)),
        )
    }

    fn run(
        owner: Field,
        valid_until: Field,
        recent: Field,
        publication: Publication,
        gap: DenyListGap,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        main(
            ASSET_ID,
            owner,
            valid_until,
            ACTION,
            recent,
            EVENT_ENTRY,
            configuration(),
            publication,
            gap,
        )
    }

    // A valid publication of the two-address list and OWNER's gap.
    fn fixture() -> (Field, Publication, DenyListGap) {
        let (root, gap) = gap_of(1);
        let (recent, publication) = published(root);
        (recent, publication, gap)
    }

    #[test]
    fn test_formulas_match_the_sdk() {
        assert(configuration_commitment(configuration()) == KAT_CONFIGURATION_COMMITMENT);
        assert(gap_leaf(DENIED_A, DENIED_B) == KAT_GAP_LEAF);
        assert(gap_of(1).0 == KAT_ROOT);
        assert(empty_list_gap().0 == KAT_EMPTY_ROOT);
        assert(
            log_leaf(
                CONTRACT,
                publication_topics(),
                publication_data(KAT_ROOT, 0),
            )
                == KAT_PUBLICATION_LEAF,
        );
    }

    #[test]
    fn test_accepts_a_valid_publication() {
        let (recent, publication, gap) = fixture();
        let statement = run(OWNER, BLOCK_TIME + 60, recent, publication, gap);
        let context = policy_context(
            ASSET_ID,
            KAT_CONFIGURATION_COMMITMENT,
            OWNER,
            BLOCK_TIME + 60,
        );
        assert(statement == [context, ACTION, recent, EVENT_ENTRY]);
    }

    #[test]
    fn test_accepts_a_deadline_at_the_end_of_the_window() {
        let (recent, publication, gap) = fixture();
        let _ = run(OWNER, BLOCK_TIME + DELTA, recent, publication, gap);
    }

    // The publication the contract emits for `root` with another delta.
    fn published_with_delta(root: Field, delta: Field) -> (Field, Publication) {
        publication_for_delta(
            root,
            log_leaf(
                CONTRACT,
                publication_topics(),
                publication_data_with_delta(root, 0, delta),
            ),
            delta,
        )
    }

    #[test]
    fn test_accepts_a_delta_at_the_configured_maximum() {
        let (root, gap) = gap_of(1);
        let (recent, publication) = published_with_delta(root, MAX_DELTA);
        let _ = run(OWNER, BLOCK_TIME + MAX_DELTA, recent, publication, gap);
    }

    #[test(should_fail_with = "call to assert_max_bit_size")]
    fn test_rejects_a_delta_above_the_configured_maximum() {
        let (root, gap) = gap_of(1);
        let (recent, publication) = published_with_delta(root, MAX_DELTA + 1);
        let _ = run(OWNER, BLOCK_TIME, recent, publication, gap);
    }

    #[test(should_fail_with = "call to assert_max_bit_size")]
    fn test_rejects_a_deadline_past_the_window() {
        let (recent, publication, gap) = fixture();
        let _ = run(OWNER, BLOCK_TIME + DELTA + 1, recent, publication, gap);
    }

    // A paused publication carries paused = 1 where the rule's leaf has 0.
    #[test(should_fail_with = "block header field must be in the block header tree")]
    fn test_rejects_a_paused_publication() {
        let (root, gap) = gap_of(1);
        let (recent, publication) = publication_for(
            root,
            log_leaf(CONTRACT, publication_topics(), publication_data(root, 1)),
        );
        let _ = run(OWNER, BLOCK_TIME, recent, publication, gap);
    }

    #[test(should_fail_with = "block header field must be in the block header tree")]
    fn test_rejects_another_emitter() {
        let (root, gap) = gap_of(1);
        let (recent, publication) = publication_for(
            root,
            log_leaf(
                CONTRACT + 1,
                publication_topics(),
                publication_data(root, 0),
            ),
        );
        let _ = run(OWNER, BLOCK_TIME, recent, publication, gap);
    }

    #[test(should_fail_with = "block header field must be in the block header tree")]
    fn test_rejects_another_event() {
        let (root, gap) = gap_of(1);
        let mut topics = publication_topics();
        topics[1] += 1;
        let (recent, publication) =
            publication_for(root, log_leaf(CONTRACT, topics, publication_data(root, 0)));
        let _ = run(OWNER, BLOCK_TIME, recent, publication, gap);
    }

    #[test(should_fail_with = "block header field must be in the block header tree")]
    fn test_rejects_another_list() {
        let (root, gap) = gap_of(1);
        let mut topics = publication_topics();
        topics[3] += 1;
        let (recent, publication) =
            publication_for(root, log_leaf(CONTRACT, topics, publication_data(root, 0)));
        let _ = run(OWNER, BLOCK_TIME, recent, publication, gap);
    }

    // The rule's root must be the one the log carries.
    #[test(should_fail_with = "block header field must be in the block header tree")]
    fn test_rejects_another_root() {
        let (root, gap) = gap_of(1);
        let (recent, publication) = publication_for(
            root,
            log_leaf(
                CONTRACT,
                publication_topics(),
                publication_data(root + 1, 0),
            ),
        );
        let _ = run(OWNER, BLOCK_TIME, recent, publication, gap);
    }

    #[test(should_fail_with = "gap must be in the published deny list")]
    fn test_rejects_an_invented_gap() {
        let (recent, publication, mut gap) = fixture();
        gap.lower = DENIED_A + 1;
        let _ = run(OWNER, BLOCK_TIME, recent, publication, gap);
    }

    // A denied owner is the upper bound of the gap below it and the lower bound
    // of the gap above it.
    #[test(should_fail_with = "owner address must be below the gap's upper bound")]
    fn test_rejects_a_denied_owner_from_the_gap_below() {
        let (root, gap) = gap_of(0);
        let (recent, publication) = published(root);
        let _ = run(DENIED_A, BLOCK_TIME, recent, publication, gap);
    }

    #[test(should_fail_with = "owner address must be above the gap's lower bound")]
    fn test_rejects_a_denied_owner_from_the_gap_above() {
        let (recent, publication, gap) = fixture();
        let _ = run(DENIED_A, BLOCK_TIME, recent, publication, gap);
    }

    #[test]
    fn test_accepts_neighbors_of_denied_addresses() {
        let (recent, publication, gap) = fixture();
        let _ = run(DENIED_A + 1, BLOCK_TIME, recent, publication, gap);
        let _ = run(DENIED_B - 1, BLOCK_TIME, recent, publication, gap);
        let (root, gap) = gap_of(0);
        let (recent, publication) = published(root);
        let _ = run(1, BLOCK_TIME, recent, publication, gap);
        let (root, gap) = gap_of(2);
        let (recent, publication) = published(root);
        let _ = run(DENIED_B + 1, BLOCK_TIME, recent, publication, gap);
        let _ = run(ADDRESS_LIMIT - 1, BLOCK_TIME, recent, publication, gap);
    }

    #[test]
    fn test_empty_list_admits_every_owner() {
        let (root, gap) = empty_list_gap();
        let (recent, publication) = published(root);
        let _ = run(1, BLOCK_TIME, recent, publication, gap);
        let _ = run(ADDRESS_LIMIT - 1, BLOCK_TIME, recent, publication, gap);
    }

    // Address zero owns nothing and lies in no gap.
    #[test(should_fail_with = "owner address must be above the gap's lower bound")]
    fn test_empty_list_has_no_gap_for_address_zero() {
        let (root, gap) = empty_list_gap();
        let (recent, publication) = published(root);
        let _ = run(0, BLOCK_TIME, recent, publication, gap);
    }

    // The index binds the gap's position: a real gap opened at an unused leaf
    // fails.
    #[test(should_fail_with = "gap must be in the published deny list")]
    fn test_rejects_a_gap_at_another_index() {
        let (recent, publication, _) = fixture();
        let (_, mut gap) = gap_of(2);
        gap.index = 3;
        let _ = run(DENIED_B + 1, BLOCK_TIME, recent, publication, gap);
    }
}
