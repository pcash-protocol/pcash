// Eligibility-drop claim. A USER account that existed at the configured cutoff
// block claims exactly the configured amount, once, into a note that opens
// under its own implicit owner-change secret.
//
// Eligibility comes from PCASH history: the recent header opens its history
// root, the history tree opens the cutoff block's hash, and that block's state
// opens the account count after the cutoff block. Account indexes are assigned
// sequentially and never reused, so a current index below that count belonged
// to an account that already existed at the cutoff.

use pcash_protocol::authorization::account::{ACCOUNT_KIND_USER, account_state_commitment};
use pcash_protocol::authorization::statement::{
    authorization_commitment, contract_action_commitment, rule_statement, RULE_STATEMENT_LENGTH,
};
use pcash_protocol::generated::private_value_profiles::{S_INPUTS, S_OUTPUTS};
use pcash_protocol::ledger::note::{application_nullifier, nullifier_key_commitment};
use pcash_protocol::ledger::private_value::{
    private_value_commitment, SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET, SmallPrivateValue,
};
use pcash_protocol::primitives::hash::pcash_hash;
use pcash_protocol::primitives::params::{
    BLOCK_HEADER_TREE_DEPTH, HISTORY_TREE_DEPTH, STATE_TREE_DEPTH,
};
use pcash_protocol::primitives::range::timestamp_le;
use pcash_protocol::primitives::types::MerkleWitness;
use pcash_protocol::state::block::{
    block_header_fact, BLOCK_HEADER_KEY_HISTORY_ROOT, BLOCK_HEADER_KEY_STATE_ROOT, history_fact,
    state_fact, STATE_KEY_ACCOUNT_COUNT, STATE_KEY_ACCOUNT_STATE_ROOT,
};
use pcash_protocol::state::merkle::binary_root_from_index;
use reference_rule_common::value_rule::assert_owner_change;
use tokens_common::{assert_no_contract_native, drop_configuration_commitment, DropConfiguration};

// DROP_CLAIM_REPLAY_DOMAIN: the domain tag of context "tokens_drop_claim_replay"
pub global DROP_CLAIM_REPLAY_DOMAIN: Field =
    0x00ca2e65b236277231667c9bf62a4e31949880a58c502f1af362294f35f22243;

/// One claim per account: its address and nullifier-key root. The kernel
/// scopes the marker to this contract and entry; the secret root keeps it
/// unlinkable to the claimant.
pub fn drop_claim_replay_id(address: Field, nk_root: Field) -> Field {
    pcash_hash([DROP_CLAIM_REPLAY_DOMAIN, address, nk_root])
}

pub struct Claimant {
    pub address: Field,
    pub nk_root: Field,
    pub account_rule_set_commitment: Field,
    pub account_revision: Field,
    pub receive_key_hash: Field,
    pub account_witness: MerkleWitness,
}

/// Openings beneath the recent block.
pub struct RecentOpenings {
    pub state_root: Field,
    pub state_root_header_siblings: [Field; BLOCK_HEADER_TREE_DEPTH],
    pub account_state_root: Field,
    pub account_state_root_state_siblings: [Field; STATE_TREE_DEPTH],
    pub history_root: Field,
    pub history_root_header_siblings: [Field; BLOCK_HEADER_TREE_DEPTH],
}

/// The cutoff block beneath the recent history root, and its account count.
pub struct CutoffOpenings {
    pub block_hash: Field,
    pub history_siblings: [Field; HISTORY_TREE_DEPTH],
    pub state_root: Field,
    pub state_root_header_siblings: [Field; BLOCK_HEADER_TREE_DEPTH],
    pub account_count: Field,
    pub account_count_state_siblings: [Field; STATE_TREE_DEPTH],
}

fn main(
    recent_pcash_block_hash: Field,
    address: Field,
    pcash_chain_id: Field,
    fee_paid: bool,
    private_value: SmallPrivateValue,
    configuration: DropConfiguration,
    creator_nullifier_key_commitment: Field,
    selected_entry_commitment: Field,
    claimant: Claimant,
    recent: RecentOpenings,
    cutoff: CutoffOpenings,
    claim_slot: u32,
    event_entry: Field,
) -> return_data [Field; RULE_STATEMENT_LENGTH] {
    assert_no_contract_native(fee_paid, private_value);
    assert(private_value.asset_burn_amount == 0, "asset burn amount must be zero");
    assert(
        timestamp_le(
            private_value.valid_until_timestamp,
            configuration.claim_end_timestamp,
        ),
        "claim must expire by the claim end",
    );

    // The claimant's current USER account and knowledge of its nullifier key.
    block_header_fact(
        recent_pcash_block_hash,
        BLOCK_HEADER_KEY_STATE_ROOT,
        recent.state_root,
        recent.state_root_header_siblings,
    );
    state_fact(
        recent.state_root,
        STATE_KEY_ACCOUNT_STATE_ROOT,
        recent.account_state_root,
        recent.account_state_root_state_siblings,
    );
    let leaf = account_state_commitment(
        claimant.address,
        nullifier_key_commitment(claimant.nk_root),
        claimant.account_rule_set_commitment,
        ACCOUNT_KIND_USER,
        claimant.account_revision,
        claimant.receive_key_hash,
    );
    assert(
        binary_root_from_index(
            leaf,
            claimant.account_witness.leaf_index,
            claimant.account_witness.siblings,
        )
            == recent.account_state_root,
        "claimant must hold a USER account at the recent block",
    );

    // The account count after the cutoff block.
    block_header_fact(
        recent_pcash_block_hash,
        BLOCK_HEADER_KEY_HISTORY_ROOT,
        recent.history_root,
        recent.history_root_header_siblings,
    );
    history_fact(
        recent.history_root,
        configuration.cutoff_block_number,
        cutoff.block_hash,
        cutoff.history_siblings,
    );
    block_header_fact(
        cutoff.block_hash,
        BLOCK_HEADER_KEY_STATE_ROOT,
        cutoff.state_root,
        cutoff.state_root_header_siblings,
    );
    state_fact(
        cutoff.state_root,
        STATE_KEY_ACCOUNT_COUNT,
        cutoff.account_count,
        cutoff.account_count_state_siblings,
    );
    // The index is below 2^40 and an authenticated count is at most 2^40, so
    // the difference is below 2^40 exactly when the index is below the count.
    assert(
        (cutoff.account_count - claimant.account_witness.leaf_index - 1).lt(0x10000000000),
        "claimant account must exist at the cutoff block",
    );

    let marker = application_nullifier(
        address,
        selected_entry_commitment,
        drop_claim_replay_id(claimant.address, claimant.nk_root),
    );
    let mut markers: Field = 0;
    for i in 0..S_INPUTS {
        if private_value.input_slot_classes[i] == SLOT_CLASS_APPLICATION {
            assert(
                private_value.nullifiers[i] == marker,
                "claim marker must be the claimant's replay marker",
            );
            markers += 1;
        }
    }
    assert(markers == 1, "claim must carry one replay marker");

    // Exactly one ASSET output, and it carries the configured amount to the
    // claimant under the secret the claimant recomputes from its own key.
    // Only an ASSET slot's body carries a nonzero asset ID.
    assert_owner_change(
        private_value,
        claim_slot,
        claimant.address,
        claimant.nk_root,
        configuration.asset_id,
        configuration.claim_amount,
    );
    for i in 0..S_OUTPUTS {
        if i != claim_slot {
            assert(
                private_value.output_slot_classes[i] != SLOT_CLASS_ASSET,
                "claim must pay one asset output",
            );
        }
    }
    rule_statement(
        authorization_commitment(
            address,
            drop_configuration_commitment(configuration, creator_nullifier_key_commitment),
        ),
        contract_action_commitment(
            pcash_chain_id,
            private_value_commitment(private_value),
            fee_paid,
        ),
        recent_pcash_block_hash,
        event_entry,
    )
}

mod tests {
    use super::{Claimant, CutoffOpenings, drop_claim_replay_id, main, RecentOpenings};
    use pcash_protocol::authorization::account::{
        ACCOUNT_KIND_CONTRACT, ACCOUNT_KIND_USER, account_state_commitment,
    };
    use pcash_protocol::authorization::statement::{
        authorization_commitment, rule_statement, RULE_STATEMENT_LENGTH,
        sponsored_transfer_action_commitment, transfer_action_commitment,
    };
    use pcash_protocol::generated::pcash_constants::BLOCK_HEADER_DOMAIN;
    use pcash_protocol::generated::private_value_profiles::{S_INPUTS, S_OUTPUTS};
    use pcash_protocol::ledger::note::{
        application_nullifier, note_body_commitment, nullifier_key_commitment, owner_commitment,
    };
    use pcash_protocol::ledger::private_value::{
        private_value_commitment, SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET, SLOT_CLASS_DUMMY,
        SLOT_CLASS_NATIVE, SmallPrivateValue,
    };
    use pcash_protocol::primitives::hash::pcash_hash;
    use pcash_protocol::primitives::types::MerkleWitness;
    use pcash_protocol::state::block::{
        block_hash_from_opening, BLOCK_HEADER_KEY_HISTORY_ROOT, BLOCK_HEADER_KEY_STATE_ROOT,
        history_leaf, STATE_KEY_ACCOUNT_COUNT, STATE_KEY_ACCOUNT_STATE_ROOT,
        state_root_from_opening,
    };
    use pcash_protocol::state::merkle::binary_root_from_index;
    use reference_rule_common::value_rule::owner_change_note_secret;
    use tokens_common::{drop_configuration_commitment, DropConfiguration};

    global ADDRESS: Field = 0xacc0;
    global PCASH_CHAIN_ID: Field = 1;
    global CREATOR_NULLIFIER_KEY_COMMITMENT: Field = 0xc1;
    global ENTRY: Field = 0xe7;
    global CUTOFF: Field = 7;
    global CLAIM_AMOUNT: Field = 500;
    global CLAIM_END: Field = 5000;
    global CLAIMANT_ADDRESS: Field = 0xabc;
    global CLAIMANT_NK_ROOT: Field = 0x5eed;

    pub struct Fixture {
        recent_pcash_block_hash: Field,
        fee_paid: bool,
        private_value: SmallPrivateValue,
        configuration: DropConfiguration,
        entry: Field,
        claimant: Claimant,
        recent: RecentOpenings,
        cutoff: CutoffOpenings,
        claim_slot: u32,
    }

    pub struct Chain {
        account_address: Field,
        account_index: Field,
        account_kind: Field,
        cutoff_account_count: Field,
        history_block_number: Field,
    }

    fn configuration() -> DropConfiguration {
        DropConfiguration {
            configuration_salt: 0x11,
            asset_id: 0xa55e7,
            claim_amount: CLAIM_AMOUNT,
            cutoff_block_number: CUTOFF,
            claim_end_timestamp: CLAIM_END,
            creator: 0xc0,
        }
    }

    fn eligible() -> Chain {
        Chain {
            account_address: CLAIMANT_ADDRESS,
            account_index: 3,
            account_kind: ACCOUNT_KIND_USER,
            cutoff_account_count: 4,
            history_block_number: CUTOFF,
        }
    }

    // Root and siblings of one key in a typed depth-4 tree.
    fn typed_opening(domain: Field, leaves: [Field; 16], key: u32) -> (Field, [Field; 4]) {
        let mut level = leaves;
        let mut siblings = [0; 4];
        let mut index = key;
        let mut width: u32 = 16;
        for depth in 0..4 {
            siblings[depth] = level[index ^ 1];
            let mut next = [0; 16];
            for j in 0..8 {
                if j < width / 2 {
                    next[j] = pcash_hash([domain, level[2 * j], level[2 * j + 1]]);
                }
            }
            level = next;
            width /= 2;
            index /= 2;
        }
        (level[0], siblings)
    }

    fn fixture(chain: Chain, fee_paid: bool) -> Fixture {
        let claimant = Claimant {
            address: chain.account_address,
            nk_root: CLAIMANT_NK_ROOT,
            account_rule_set_commitment: 0x71,
            account_revision: 2,
            receive_key_hash: 0x72,
            account_witness: MerkleWitness {
                leaf_index: chain.account_index,
                siblings: [0x31; 40],
            },
        };
        let leaf = account_state_commitment(
            claimant.address,
            nullifier_key_commitment(claimant.nk_root),
            claimant.account_rule_set_commitment,
            chain.account_kind,
            claimant.account_revision,
            0x72,
        );
        let account_state_root = binary_root_from_index(leaf, chain.account_index, [0x31; 40]);
        let recent_state_siblings = [0x41, 0x42, 0x43, 0x44];
        let recent_state_root = state_root_from_opening(
            account_state_root,
            STATE_KEY_ACCOUNT_STATE_ROOT,
            recent_state_siblings,
        );

        let cutoff_count_siblings = [0x51, 0x52, 0x53, 0x54];
        let cutoff_state_root = state_root_from_opening(
            chain.cutoff_account_count,
            STATE_KEY_ACCOUNT_COUNT,
            cutoff_count_siblings,
        );
        let cutoff_header_siblings = [0x61, 0x62, 0x63, 0x64];
        let cutoff_hash = block_hash_from_opening(
            cutoff_state_root,
            BLOCK_HEADER_KEY_STATE_ROOT,
            cutoff_header_siblings,
        );
        let history_siblings = [0x81; 40];
        let history_root = binary_root_from_index(
            history_leaf(cutoff_hash),
            chain.history_block_number,
            history_siblings,
        );

        let mut header = [0; 16];
        header[1] = 9;
        header[2] = 4500;
        header[BLOCK_HEADER_KEY_STATE_ROOT] = recent_state_root;
        header[BLOCK_HEADER_KEY_HISTORY_ROOT] = history_root;
        let (recent_hash, state_root_header_siblings) =
            typed_opening(BLOCK_HEADER_DOMAIN, header, BLOCK_HEADER_KEY_STATE_ROOT);
        let (_, history_root_header_siblings) =
            typed_opening(BLOCK_HEADER_DOMAIN, header, BLOCK_HEADER_KEY_HISTORY_ROOT);

        let marker = application_nullifier(
            ADDRESS,
            ENTRY,
            drop_claim_replay_id(chain.account_address, CLAIMANT_NK_ROOT),
        );
        let mut input_slot_classes = [SLOT_CLASS_DUMMY; S_INPUTS];
        let mut input_commitments = [0; S_INPUTS];
        let mut nullifiers = [0; S_INPUTS];
        for i in 0..S_INPUTS {
            nullifiers[i] = 100 + i as Field;
        }
        input_slot_classes[0] = SLOT_CLASS_ASSET;
        input_commitments[0] = 0x1111;
        input_slot_classes[1] = SLOT_CLASS_APPLICATION;
        nullifiers[1] = marker;
        let mut output_slot_classes = [SLOT_CLASS_DUMMY; S_OUTPUTS];
        let mut bodies = [0; S_OUTPUTS];
        for i in 0..S_OUTPUTS {
            bodies[i] = 200 + i as Field;
        }
        if fee_paid {
            input_slot_classes[2] = SLOT_CLASS_NATIVE;
            input_commitments[2] = 0x2222;
            output_slot_classes[3] = SLOT_CLASS_NATIVE;
        }
        let mut private_value = SmallPrivateValue {
            open_fee_amount: if fee_paid { 5 } else { 0 },
            issuance_owner_commitment: 0,
            not_before_timestamp: 0,
            valid_until_timestamp: 4000,
            carrier_context_hash: 0,
            asset_burn_amount: 0,
            delivery_commitment: 0,
            input_slot_classes,
            input_commitments,
            nullifiers,
            output_slot_classes,
            output_body_commitments: bodies,
        };
        let claim_slot = 1;
        private_value.output_slot_classes[claim_slot] = SLOT_CLASS_ASSET;
        private_value.output_body_commitments[claim_slot] = note_body_commitment(
            owner_commitment(
                chain.account_address,
                owner_change_note_secret(CLAIMANT_NK_ROOT, private_value, claim_slot),
            ),
            configuration().asset_id,
            CLAIM_AMOUNT,
        );
        Fixture {
            recent_pcash_block_hash: recent_hash,
            fee_paid,
            private_value,
            configuration: configuration(),
            entry: ENTRY,
            claimant,
            recent: RecentOpenings {
                state_root: recent_state_root,
                state_root_header_siblings,
                account_state_root,
                account_state_root_state_siblings: recent_state_siblings,
                history_root,
                history_root_header_siblings,
            },
            cutoff: CutoffOpenings {
                block_hash: cutoff_hash,
                history_siblings,
                state_root: cutoff_state_root,
                state_root_header_siblings: cutoff_header_siblings,
                account_count: chain.cutoff_account_count,
                account_count_state_siblings: cutoff_count_siblings,
            },
            claim_slot,
        }
    }

    fn claim(fixture: Fixture, event_entry: Field) -> [Field; RULE_STATEMENT_LENGTH] {
        main(
            fixture.recent_pcash_block_hash,
            ADDRESS,
            PCASH_CHAIN_ID,
            fixture.fee_paid,
            fixture.private_value,
            fixture.configuration,
            CREATOR_NULLIFIER_KEY_COMMITMENT,
            fixture.entry,
            fixture.claimant,
            fixture.recent,
            fixture.cutoff,
            fixture.claim_slot,
            event_entry,
        )
    }

    // The statement for the fixture's configuration, transaction and role.
    fn expected_statement(fixture: Fixture, event_entry: Field) -> [Field; RULE_STATEMENT_LENGTH] {
        let commitment = private_value_commitment(fixture.private_value);
        rule_statement(
            authorization_commitment(
                ADDRESS,
                drop_configuration_commitment(
                    fixture.configuration,
                    CREATOR_NULLIFIER_KEY_COMMITMENT,
                ),
            ),
            if fixture.fee_paid {
                sponsored_transfer_action_commitment(PCASH_CHAIN_ID, commitment)
            } else {
                transfer_action_commitment(PCASH_CHAIN_ID, commitment)
            },
            fixture.recent_pcash_block_hash,
            event_entry,
        )
    }

    // Replace the claim output's body for a changed transaction, keeping it valid.
    fn repay(fixture: Fixture) -> Fixture {
        let mut changed = fixture;
        changed.private_value.output_body_commitments[fixture.claim_slot] = note_body_commitment(
            owner_commitment(
                fixture.claimant.address,
                owner_change_note_secret(
                    CLAIMANT_NK_ROOT,
                    fixture.private_value,
                    fixture.claim_slot,
                ),
            ),
            fixture.configuration.asset_id,
            fixture.configuration.claim_amount,
        );
        changed
    }

    #[test]
    fn test_accepts_an_eligible_unsponsored_claim() {
        let f = fixture(eligible(), false);
        assert(claim(f, 0) == expected_statement(f, 0));
    }

    #[test]
    fn test_accepts_an_eligible_sponsored_claim() {
        let f = fixture(eligible(), true);
        assert(claim(f, 0) == expected_statement(f, 0));
    }

    #[test]
    fn test_accepts_the_last_account_at_the_cutoff() {
        let mut chain = eligible();
        chain.account_index = 0;
        chain.cutoff_account_count = 1;
        let _ = claim(fixture(chain, false), 0);
    }

    #[test]
    fn test_accepts_a_claim_expiring_at_the_claim_end() {
        let mut f = fixture(eligible(), false);
        f.private_value.valid_until_timestamp = CLAIM_END;
        let _ = claim(f, 0);
    }

    #[test(should_fail_with = "claimant account must exist at the cutoff block")]
    fn test_rejects_an_account_created_after_the_cutoff() {
        let mut chain = eligible();
        chain.account_index = 4;
        let _ = claim(fixture(chain, false), 0);
    }

    #[test(should_fail_with = "claimant account must exist at the cutoff block")]
    fn test_rejects_every_account_before_the_first_at_the_cutoff() {
        let mut chain = eligible();
        chain.account_index = 0;
        chain.cutoff_account_count = 0;
        let _ = claim(fixture(chain, false), 0);
    }

    #[test(should_fail_with = "claimant account must exist at the cutoff block")]
    fn test_rejects_an_account_far_after_the_cutoff() {
        let mut chain = eligible();
        chain.account_index = 0xffffffffff;
        let _ = claim(fixture(chain, false), 0);
    }

    #[test(should_fail_with = "block hash must be in the PCASH history tree")]
    fn test_rejects_eligibility_at_another_block() {
        let mut chain = eligible();
        chain.history_block_number = CUTOFF + 1;
        let _ = claim(fixture(chain, false), 0);
    }

    #[test(should_fail_with = "state field must be in the state tree")]
    fn test_rejects_another_account_count_at_the_cutoff() {
        let mut f = fixture(eligible(), false);
        f.cutoff.account_count = 5;
        let _ = claim(f, 0);
    }

    #[test(should_fail_with = "block header field must be in the block header tree")]
    fn test_rejects_another_cutoff_state() {
        let mut f = fixture(eligible(), false);
        f.cutoff.state_root += 1;
        let _ = claim(f, 0);
    }

    #[test(should_fail_with = "block header field must be in the block header tree")]
    fn test_rejects_another_history_root() {
        let mut f = fixture(eligible(), false);
        f.recent.history_root += 1;
        let _ = claim(f, 0);
    }

    #[test(should_fail_with = "block header field must be in the block header tree")]
    fn test_rejects_another_recent_state() {
        let mut f = fixture(eligible(), false);
        f.recent.state_root += 1;
        let _ = claim(f, 0);
    }

    #[test(should_fail_with = "state field must be in the state tree")]
    fn test_rejects_another_account_tree() {
        let mut f = fixture(eligible(), false);
        f.recent.account_state_root += 1;
        let _ = claim(f, 0);
    }

    #[test(should_fail_with = "claimant must hold a USER account at the recent block")]
    fn test_rejects_a_contract_account() {
        let mut chain = eligible();
        chain.account_kind = ACCOUNT_KIND_CONTRACT;
        let _ = claim(fixture(chain, false), 0);
    }

    #[test(should_fail_with = "claimant must hold a USER account at the recent block")]
    fn test_rejects_a_claimant_without_its_nullifier_key() {
        let mut f = fixture(eligible(), false);
        f.claimant.nk_root += 1;
        let _ = claim(f, 0);
    }

    #[test(should_fail_with = "claimant must hold a USER account at the recent block")]
    fn test_rejects_another_claimant_address() {
        let mut f = fixture(eligible(), false);
        f.claimant.address += 1;
        let _ = claim(f, 0);
    }

    #[test(should_fail_with = "unsponsored action must not spend contract native value")]
    fn test_rejects_contract_native_value_in_the_transfer_role() {
        let mut f = fixture(eligible(), true);
        f.fee_paid = false;
        let _ = claim(f, 0);
    }

    #[test(should_fail_with = "asset burn amount must be zero")]
    fn test_rejects_a_burn() {
        let mut f = fixture(eligible(), false);
        f.private_value.asset_burn_amount = 1;
        let _ = claim(repay(f), 0);
    }

    #[test(should_fail_with = "claim must expire by the claim end")]
    fn test_rejects_a_claim_valid_after_the_claim_end() {
        let mut f = fixture(eligible(), false);
        f.private_value.valid_until_timestamp = CLAIM_END + 1;
        let _ = claim(repay(f), 0);
    }

    #[test(should_fail_with = "claim marker must be the claimant's replay marker")]
    fn test_rejects_a_fresh_replay_identity() {
        let mut f = fixture(eligible(), false);
        f.private_value.nullifiers[1] = application_nullifier(
            ADDRESS,
            ENTRY,
            drop_claim_replay_id(CLAIMANT_ADDRESS, CLAIMANT_NK_ROOT + 1),
        );
        let _ = claim(repay(f), 0);
    }

    #[test(should_fail_with = "claim marker must be the claimant's replay marker")]
    fn test_rejects_a_marker_in_another_entry() {
        let mut f = fixture(eligible(), false);
        f.private_value.nullifiers[1] = application_nullifier(
            ADDRESS,
            ENTRY + 1,
            drop_claim_replay_id(CLAIMANT_ADDRESS, CLAIMANT_NK_ROOT),
        );
        let _ = claim(repay(f), 0);
    }

    #[test(should_fail_with = "claim marker must be the claimant's replay marker")]
    fn test_rejects_a_marker_of_another_account() {
        let mut f = fixture(eligible(), false);
        f.private_value.nullifiers[1] = application_nullifier(
            ADDRESS + 1,
            ENTRY,
            drop_claim_replay_id(CLAIMANT_ADDRESS, CLAIMANT_NK_ROOT),
        );
        let _ = claim(repay(f), 0);
    }

    // An account at another address may carry the claimant's nullifier-key
    // commitment; it claims under its own marker, not the claimant's.
    #[test(should_fail_with = "claim marker must be the claimant's replay marker")]
    fn test_rejects_the_marker_of_another_address_with_the_same_key() {
        let mut chain = eligible();
        chain.account_address = CLAIMANT_ADDRESS + 1;
        let mut f = fixture(chain, false);
        f.private_value.nullifiers[1] = application_nullifier(
            ADDRESS,
            ENTRY,
            drop_claim_replay_id(CLAIMANT_ADDRESS, CLAIMANT_NK_ROOT),
        );
        let _ = claim(repay(f), 0);
    }

    #[test(should_fail_with = "claim must carry one replay marker")]
    fn test_rejects_a_claim_without_a_marker() {
        let mut f = fixture(eligible(), false);
        f.private_value.input_slot_classes[1] = SLOT_CLASS_DUMMY;
        let _ = claim(repay(f), 0);
    }

    #[test(should_fail_with = "claim must carry one replay marker")]
    fn test_rejects_a_second_marker() {
        let mut f = fixture(eligible(), false);
        f.private_value.input_slot_classes[3] = SLOT_CLASS_APPLICATION;
        f.private_value.nullifiers[3] = f.private_value.nullifiers[1];
        let _ = claim(repay(f), 0);
    }

    #[test(should_fail_with = "owner change must return to the owner under the derived secret")]
    fn test_rejects_a_claim_to_another_owner() {
        let mut f = fixture(eligible(), false);
        f.private_value.output_body_commitments[f.claim_slot] = note_body_commitment(
            owner_commitment(
                CLAIMANT_ADDRESS + 1,
                owner_change_note_secret(CLAIMANT_NK_ROOT, f.private_value, f.claim_slot),
            ),
            f.configuration.asset_id,
            CLAIM_AMOUNT,
        );
        let _ = claim(f, 0);
    }

    #[test(should_fail_with = "owner change must return to the owner under the derived secret")]
    fn test_rejects_a_claim_under_a_chosen_secret() {
        let mut f = fixture(eligible(), false);
        f.private_value.output_body_commitments[f.claim_slot] = note_body_commitment(
            owner_commitment(CLAIMANT_ADDRESS, 0x5ec7e7),
            f.configuration.asset_id,
            CLAIM_AMOUNT,
        );
        let _ = claim(f, 0);
    }

    #[test(should_fail_with = "owner change must return to the owner under the derived secret")]
    fn test_rejects_another_amount() {
        let mut f = fixture(eligible(), false);
        f.private_value.output_body_commitments[f.claim_slot] = note_body_commitment(
            owner_commitment(
                CLAIMANT_ADDRESS,
                owner_change_note_secret(CLAIMANT_NK_ROOT, f.private_value, f.claim_slot),
            ),
            f.configuration.asset_id,
            CLAIM_AMOUNT + 1,
        );
        let _ = claim(f, 0);
    }

    #[test(should_fail_with = "owner change must return to the owner under the derived secret")]
    fn test_rejects_an_output_whose_secret_names_another_slot() {
        let mut f = fixture(eligible(), false);
        f.claim_slot = 2;
        f.private_value.output_slot_classes[1] = SLOT_CLASS_DUMMY;
        f.private_value.output_slot_classes[2] = SLOT_CLASS_ASSET;
        f.private_value.output_body_commitments[2] = f.private_value.output_body_commitments[1];
        let _ = claim(f, 0);
    }

    #[test(should_fail_with = "claim must pay one asset output")]
    fn test_rejects_a_second_asset_output() {
        let mut f = fixture(eligible(), false);
        f.private_value.output_slot_classes[4] = SLOT_CLASS_ASSET;
        let _ = claim(repay(f), 0);
    }
}
