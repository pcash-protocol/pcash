// Claim-link function. Whoever can open one of this contract's inventory notes
// spends it: each note secret derives from a bearer link key, and the note's
// own nullifier makes the link one-shot. The function fixes the asset and the
// role; recipients, burn, issuance route, and validity are the spender's.

use pcash_protocol::authorization::statement::{
    authorization_commitment, contract_action_commitment, rule_statement, RULE_STATEMENT_LENGTH,
};
use pcash_protocol::ledger::note::{note_body_commitment, output_commitment};
use pcash_protocol::ledger::private_value::{private_value_commitment, SmallPrivateValue};
use pcash_protocol::primitives::hash::pcash_hash;
use reference_rule_common::generated::reference_rule_constants::REFERENCE_CONFIGURATION_DOMAIN;
use reference_rule_common::value_rule::assert_ordinary_value_inputs;
use tokens_common::assert_no_contract_native;

pub struct Configuration {
    pub configuration_salt: Field,
    pub asset_id: Field,
}

pub fn link_configuration_commitment(configuration: Configuration) -> Field {
    pcash_hash([
        REFERENCE_CONFIGURATION_DOMAIN,
        configuration.configuration_salt,
        configuration.asset_id,
    ])
}

/// One input's note body. Only an ASSET input opens under a nonzero asset ID,
/// and the kernel builds every ASSET input and output under one asset ID, so
/// opening one input fixes the action's namespace.
pub struct AssetInputOpening {
    pub slot: u32,
    pub owner_commitment: Field,
    pub amount: Field,
    pub output_index: Field,
}

fn main(
    recent_pcash_block_hash: Field,
    address: Field,
    pcash_chain_id: Field,
    fee_paid: bool,
    private_value: SmallPrivateValue,
    configuration: Configuration,
    asset_input: AssetInputOpening,
    event_entry: Field,
) -> return_data [Field; RULE_STATEMENT_LENGTH] {
    assert_ordinary_value_inputs(private_value);
    assert_no_contract_native(fee_paid, private_value);
    assert(
        private_value.input_commitments[asset_input.slot]
            == output_commitment(
                note_body_commitment(
                    asset_input.owner_commitment,
                    configuration.asset_id,
                    asset_input.amount,
                ),
                asset_input.output_index,
            ),
        "asset input must open in the configured asset",
    );
    rule_statement(
        authorization_commitment(address, link_configuration_commitment(configuration)),
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
    use super::{AssetInputOpening, Configuration, link_configuration_commitment, main};
    use pcash_protocol::authorization::statement::{
        authorization_commitment, rule_statement, RULE_STATEMENT_LENGTH,
        sponsored_transfer_action_commitment, transfer_action_commitment,
    };
    use pcash_protocol::generated::private_value_profiles::{S_INPUTS, S_OUTPUTS};
    use pcash_protocol::ledger::note::{note_body_commitment, output_commitment};
    use pcash_protocol::ledger::private_value::{
        private_value_commitment, SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET,
        SLOT_CLASS_ASSET_CREATION, SLOT_CLASS_DUMMY, SLOT_CLASS_NATIVE, SmallPrivateValue,
    };

    global ASSET_ID: Field = 0x5151;
    global CONFIGURATION: Configuration =
        Configuration { configuration_salt: 0x77, asset_id: ASSET_ID };
    global LINK_OWNER_COMMITMENT: Field = 0x1234;
    global LINK_AMOUNT: Field = 250;
    global LINK_LEAF: Field = 9;
    global RECENT_BLOCK: Field = 0xb10c;
    global ADDRESS: Field = 0xacc0;
    global PCASH_CHAIN_ID: Field = 1;

    fn link_note(asset_id: Field) -> Field {
        output_commitment(
            note_body_commitment(LINK_OWNER_COMMITMENT, asset_id, LINK_AMOUNT),
            LINK_LEAF,
        )
    }

    fn private_value() -> SmallPrivateValue {
        let mut nullifiers = [0; S_INPUTS];
        for i in 0..S_INPUTS {
            nullifiers[i] = 100 + i as Field;
        }
        let mut bodies = [0; S_OUTPUTS];
        for i in 0..S_OUTPUTS {
            bodies[i] = 200 + i as Field;
        }
        let mut output_slot_classes = [SLOT_CLASS_DUMMY; S_OUTPUTS];
        output_slot_classes[0] = SLOT_CLASS_ASSET;
        let mut input_slot_classes = [SLOT_CLASS_DUMMY; S_INPUTS];
        input_slot_classes[0] = SLOT_CLASS_ASSET;
        let mut input_commitments = [0; S_INPUTS];
        input_commitments[0] = link_note(ASSET_ID);
        SmallPrivateValue {
            open_fee_amount: 0,
            issuance_owner_commitment: 0,
            not_before_timestamp: 0,
            valid_until_timestamp: 1000,
            carrier_context_hash: 0,
            asset_burn_amount: 0,
            delivery_commitment: 0,
            account_creation_commitment: 0,
            input_slot_classes,
            input_commitments,
            nullifiers,
            output_slot_classes,
            output_body_commitments: bodies,
        }
    }

    fn sponsored() -> SmallPrivateValue {
        let mut tx = private_value();
        tx.input_slot_classes[1] = SLOT_CLASS_NATIVE;
        tx.input_commitments[1] = 0x99;
        tx.output_slot_classes[1] = SLOT_CLASS_NATIVE;
        tx.open_fee_amount = 3;
        tx
    }

    fn opening() -> AssetInputOpening {
        AssetInputOpening {
            slot: 0,
            owner_commitment: LINK_OWNER_COMMITMENT,
            amount: LINK_AMOUNT,
            output_index: LINK_LEAF,
        }
    }

    fn run(
        tx: SmallPrivateValue,
        fee_paid: bool,
        input: AssetInputOpening,
        event_entry: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        main(
            RECENT_BLOCK,
            ADDRESS,
            PCASH_CHAIN_ID,
            fee_paid,
            tx,
            CONFIGURATION,
            input,
            event_entry,
        )
    }

    fn claim(
        tx: SmallPrivateValue,
        fee_paid: bool,
        event_entry: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        run(tx, fee_paid, opening(), event_entry)
    }

    #[test]
    fn test_accepts_an_unsponsored_claim() {
        let tx = private_value();
        assert(
            claim(tx, false, 0)
                == rule_statement(
                    authorization_commitment(ADDRESS, link_configuration_commitment(CONFIGURATION)),
                    transfer_action_commitment(PCASH_CHAIN_ID, private_value_commitment(tx)),
                    RECENT_BLOCK,
                    0,
                ),
        );
    }

    #[test]
    fn test_accepts_a_sponsored_claim_with_payer_native_value() {
        let tx = sponsored();
        let statement = claim(tx, true, 0);
        assert(
            statement[1]
                == sponsored_transfer_action_commitment(
                    PCASH_CHAIN_ID,
                    private_value_commitment(tx),
                ),
        );
    }

    #[test]
    fn test_accepts_a_claim_that_burns_the_link_value() {
        let mut tx = private_value();
        tx.output_slot_classes[0] = SLOT_CLASS_DUMMY;
        tx.asset_burn_amount = LINK_AMOUNT;
        let _ = claim(tx, false, 0);
    }

    #[test]
    fn test_opens_an_asset_input_in_any_slot() {
        let mut tx = private_value();
        tx.input_slot_classes[0] = SLOT_CLASS_DUMMY;
        tx.input_commitments[0] = 0;
        tx.input_slot_classes[S_INPUTS - 1] = SLOT_CLASS_ASSET;
        tx.input_commitments[S_INPUTS - 1] = link_note(ASSET_ID);
        let mut input = opening();
        input.slot = S_INPUTS - 1;
        let _ = run(tx, false, input, 0);
    }

    #[test(should_fail_with = "input slot must not be an application marker")]
    fn test_rejects_an_application_marker() {
        let mut tx = private_value();
        tx.input_slot_classes[S_INPUTS - 1] = SLOT_CLASS_APPLICATION;
        let _ = claim(tx, false, 0);
    }

    #[test(should_fail_with = "input slot must not be a creation marker")]
    fn test_rejects_a_creation_marker() {
        let mut tx = private_value();
        tx.input_slot_classes[S_INPUTS - 1] = SLOT_CLASS_ASSET_CREATION;
        let _ = claim(tx, false, 0);
    }

    #[test(should_fail_with = "unsponsored action must not spend contract native value")]
    fn test_rejects_contract_native_value_in_the_transfer_role() {
        let _ = claim(sponsored(), false, 0);
    }

    #[test(should_fail_with = "asset input must open in the configured asset")]
    fn test_rejects_an_opening_of_a_note_free_slot() {
        let mut input = opening();
        input.slot = 1;
        let _ = run(private_value(), false, input, 0);
    }

    #[test(should_fail_with = "asset input must open in the configured asset")]
    fn test_rejects_another_asset() {
        let mut tx = private_value();
        tx.input_commitments[0] = link_note(ASSET_ID + 1);
        let _ = claim(tx, false, 0);
    }

    #[test(should_fail_with = "asset input must open in the configured asset")]
    fn test_rejects_a_wrong_note_opening() {
        let mut input = opening();
        input.amount = LINK_AMOUNT + 1;
        let _ = run(private_value(), false, input, 0);
    }
}
