// Eligibility-drop reclaim. After the claim window closes, the creator returns
// unclaimed inventory to itself. Every ASSET output opens to the configured
// creator under the creator's implicit owner-change secret, so the creator's
// wallet recomputes each opening from its own key.

use pcash_protocol::authorization::statement::{
    authorization_commitment, contract_action_commitment, rule_statement, RULE_STATEMENT_LENGTH,
};
use pcash_protocol::generated::private_value_profiles::S_OUTPUTS;
use pcash_protocol::ledger::note::nullifier_key_commitment;
use pcash_protocol::ledger::private_value::{
    private_value_commitment, SLOT_CLASS_ASSET, SmallPrivateValue,
};
use pcash_protocol::primitives::range::timestamp_le;
use reference_rule_common::value_rule::{assert_ordinary_value_inputs, assert_owner_change};
use tokens_common::{assert_no_contract_native, drop_configuration_commitment, DropConfiguration};

fn main(
    recent_pcash_block_hash: Field,
    address: Field,
    pcash_chain_id: Field,
    fee_paid: bool,
    private_value: SmallPrivateValue,
    configuration: DropConfiguration,
    creator_nk_root: Field,
    output_amounts: [Field; S_OUTPUTS],
    event_entry: Field,
) -> return_data [Field; RULE_STATEMENT_LENGTH] {
    assert_ordinary_value_inputs(private_value);
    assert_no_contract_native(fee_paid, private_value);
    assert(private_value.asset_burn_amount == 0, "asset burn amount must be zero");
    assert(
        timestamp_le(
            configuration.claim_end_timestamp,
            private_value.not_before_timestamp,
        ),
        "reclaim must start at or after the claim end",
    );
    for i in 0..S_OUTPUTS {
        if private_value.output_slot_classes[i] == SLOT_CLASS_ASSET {
            assert_owner_change(
                private_value,
                i,
                configuration.creator,
                creator_nk_root,
                configuration.asset_id,
                output_amounts[i],
            );
        }
    }
    rule_statement(
        authorization_commitment(
            address,
            drop_configuration_commitment(configuration, nullifier_key_commitment(creator_nk_root)),
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
    use super::main;
    use pcash_protocol::authorization::statement::{
        authorization_commitment, rule_statement, RULE_STATEMENT_LENGTH,
        sponsored_transfer_action_commitment, transfer_action_commitment,
    };
    use pcash_protocol::generated::private_value_profiles::{S_INPUTS, S_OUTPUTS};
    use pcash_protocol::ledger::note::{
        note_body_commitment, nullifier_key_commitment, owner_commitment,
    };
    use pcash_protocol::ledger::private_value::{
        private_value_commitment, SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET,
        SLOT_CLASS_ASSET_CREATION, SLOT_CLASS_DUMMY, SLOT_CLASS_NATIVE, SmallPrivateValue,
    };
    use reference_rule_common::value_rule::owner_change_note_secret;
    use tokens_common::{drop_configuration_commitment, DropConfiguration};

    global CREATOR_NK_ROOT: Field = 0xc2ea7;
    global CREATOR: Field = 0xc0;
    global CLAIM_END: Field = 5000;
    global ASSET_ID: Field = 0xa55e7;
    global RECENT_BLOCK: Field = 0xb10c;
    global ADDRESS: Field = 0xacc0;
    global PCASH_CHAIN_ID: Field = 1;

    fn configuration() -> DropConfiguration {
        DropConfiguration {
            configuration_salt: 0x11,
            asset_id: ASSET_ID,
            claim_amount: 500,
            cutoff_block_number: 7,
            claim_end_timestamp: CLAIM_END,
            creator: CREATOR,
        }
    }

    fn creator_body(tx: SmallPrivateValue, slot: u32, amount: Field) -> Field {
        note_body_commitment(
            owner_commitment(CREATOR, owner_change_note_secret(CREATOR_NK_ROOT, tx, slot)),
            ASSET_ID,
            amount,
        )
    }

    // Four inventory notes returned as one merged note and one split note.
    fn private_value(fee_paid: bool) -> SmallPrivateValue {
        let mut nullifiers = [0; S_INPUTS];
        for i in 0..S_INPUTS {
            nullifiers[i] = 100 + i as Field;
        }
        let mut input_commitments = [0; S_INPUTS];
        for i in 0..S_INPUTS {
            input_commitments[i] = 0x1000 + i as Field;
        }
        let mut input_slot_classes = [SLOT_CLASS_ASSET; S_INPUTS];
        let mut output_slot_classes = [SLOT_CLASS_DUMMY; S_OUTPUTS];
        if fee_paid {
            input_slot_classes[3] = SLOT_CLASS_NATIVE;
            output_slot_classes[4] = SLOT_CLASS_NATIVE;
        }
        let mut bodies = [0; S_OUTPUTS];
        for i in 0..S_OUTPUTS {
            bodies[i] = 200 + i as Field;
        }
        let mut tx = SmallPrivateValue {
            open_fee_amount: if fee_paid { 5 } else { 0 },
            issuance_owner_commitment: 0,
            not_before_timestamp: CLAIM_END,
            valid_until_timestamp: 9000,
            carrier_context_hash: 0,
            asset_burn_amount: 0,
            delivery_commitment: 0,
            input_slot_classes,
            input_commitments,
            nullifiers,
            output_slot_classes,
            output_body_commitments: bodies,
        };
        tx.output_slot_classes[0] = SLOT_CLASS_ASSET;
        tx.output_body_commitments[0] = creator_body(tx, 0, 1400);
        tx.output_slot_classes[2] = SLOT_CLASS_ASSET;
        tx.output_body_commitments[2] = creator_body(tx, 2, 100);
        tx
    }

    fn amounts() -> [Field; S_OUTPUTS] {
        let mut amounts = [0; S_OUTPUTS];
        amounts[0] = 1400;
        amounts[2] = 100;
        amounts
    }

    fn run(
        tx: SmallPrivateValue,
        fee_paid: bool,
        creator_nk_root: Field,
        output_amounts: [Field; S_OUTPUTS],
        event_entry: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        main(
            RECENT_BLOCK,
            ADDRESS,
            PCASH_CHAIN_ID,
            fee_paid,
            tx,
            configuration(),
            creator_nk_root,
            output_amounts,
            event_entry,
        )
    }

    fn reclaim(
        tx: SmallPrivateValue,
        fee_paid: bool,
        event_entry: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        run(tx, fee_paid, CREATOR_NK_ROOT, amounts(), event_entry)
    }

    // The configuration commits the creator's published nullifier key commitment.
    fn authorization() -> Field {
        authorization_commitment(
            ADDRESS,
            drop_configuration_commitment(
                configuration(),
                nullifier_key_commitment(CREATOR_NK_ROOT),
            ),
        )
    }

    #[test]
    fn test_accepts_an_unsponsored_reclaim_at_the_claim_end() {
        let tx = private_value(false);
        assert(
            reclaim(tx, false, 0)
                == rule_statement(
                    authorization(),
                    transfer_action_commitment(PCASH_CHAIN_ID, private_value_commitment(tx)),
                    RECENT_BLOCK,
                    0,
                ),
        );
    }

    #[test]
    fn test_accepts_a_sponsored_reclaim() {
        let tx = private_value(true);
        assert(
            reclaim(tx, true, 0)
                == rule_statement(
                    authorization(),
                    sponsored_transfer_action_commitment(
                        PCASH_CHAIN_ID,
                        private_value_commitment(tx),
                    ),
                    RECENT_BLOCK,
                    0,
                ),
        );
    }

    #[test(should_fail_with = "reclaim must start at or after the claim end")]
    fn test_rejects_a_reclaim_valid_before_the_claim_end() {
        let mut tx = private_value(false);
        tx.not_before_timestamp = CLAIM_END - 1;
        let _ = reclaim(tx, false, 0);
    }

    #[test(should_fail_with = "reclaim must start at or after the claim end")]
    fn test_rejects_an_unconstrained_start() {
        let mut tx = private_value(false);
        tx.not_before_timestamp = 0;
        let _ = reclaim(tx, false, 0);
    }

    #[test(should_fail_with = "input slot must not be an application marker")]
    fn test_rejects_an_application_marker() {
        let mut tx = private_value(false);
        tx.input_slot_classes[3] = SLOT_CLASS_APPLICATION;
        tx.input_commitments[3] = 0;
        let _ = reclaim(tx, false, 0);
    }

    #[test(should_fail_with = "input slot must not be a creation marker")]
    fn test_rejects_a_creation_marker() {
        let mut tx = private_value(false);
        tx.input_slot_classes[3] = SLOT_CLASS_ASSET_CREATION;
        tx.input_commitments[3] = 0;
        let _ = reclaim(tx, false, 0);
    }

    #[test(should_fail_with = "unsponsored action must not spend contract native value")]
    fn test_rejects_contract_native_value_in_the_transfer_role() {
        let _ = reclaim(private_value(true), false, 0);
    }

    #[test(should_fail_with = "asset burn amount must be zero")]
    fn test_rejects_a_burn() {
        let mut tx = private_value(false);
        tx.asset_burn_amount = 1;
        let _ = reclaim(tx, false, 0);
    }

    #[test(should_fail_with = "owner change must return to the owner under the derived secret")]
    fn test_rejects_another_key() {
        let _ = run(
            private_value(false),
            false,
            CREATOR_NK_ROOT + 1,
            amounts(),
            0,
        );
    }

    // A builder that opens the outputs under another root returns an
    // authorization for a configuration the drop never installed, so the
    // kernel's comparison rejects it.
    #[test]
    fn test_another_key_does_not_open_the_installed_configuration() {
        let other = CREATOR_NK_ROOT + 1;
        let mut tx = private_value(false);
        for slot in [0, 2] {
            tx.output_body_commitments[slot] = note_body_commitment(
                owner_commitment(CREATOR, owner_change_note_secret(other, tx, slot)),
                ASSET_ID,
                amounts()[slot],
            );
        }
        let statement = run(tx, false, other, amounts(), 0);
        assert(statement[0] != authorization());
    }

    #[test(should_fail_with = "owner change must return to the owner under the derived secret")]
    fn test_rejects_an_output_to_another_owner() {
        let mut tx = private_value(false);
        tx.output_body_commitments[2] = note_body_commitment(
            owner_commitment(
                CREATOR + 1,
                owner_change_note_secret(CREATOR_NK_ROOT, tx, 2),
            ),
            ASSET_ID,
            100,
        );
        let _ = reclaim(tx, false, 0);
    }

    #[test(should_fail_with = "owner change must return to the owner under the derived secret")]
    fn test_rejects_an_output_under_a_chosen_secret() {
        let mut tx = private_value(false);
        tx.output_body_commitments[2] =
            note_body_commitment(owner_commitment(CREATOR, 0x5ec7e7), ASSET_ID, 100);
        let _ = reclaim(tx, false, 0);
    }

    #[test(should_fail_with = "owner change must return to the owner under the derived secret")]
    fn test_rejects_an_undeclared_amount() {
        let mut changed = amounts();
        changed[0] = 1399;
        let _ = run(private_value(false), false, CREATOR_NK_ROOT, changed, 0);
    }
}
