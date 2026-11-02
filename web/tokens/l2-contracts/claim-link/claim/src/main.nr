// Claim-link function. Whoever can open one of this contract's inventory notes
// spends it: each note secret derives from a bearer link key, and the note's
// own nullifier makes the link one-shot. The function fixes the asset and the
// role; recipients, fees, burns, issuance route, and validity are the spender's.
//
// Asset ID 0 configures native PCASH links. Their notes are contract-owned
// native value, which stays in the transfer role (spec §11.5), so a native
// claim pays its open fee or relay output and its native burn from the link
// notes themselves. A token link's transfer role has no native input, so its
// native burn is zero; under a fee payer the payer's own inputs fund it.

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
/// opening one input fixes the action's namespace. Under asset ID 0 it opens a
/// NATIVE input.
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
    if configuration.asset_id == 0 {
        assert(!fee_paid, "native link claim must not be sponsored");
    } else {
        assert_no_contract_native(fee_paid, private_value);
    }
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
            native_burn_amount: 0,
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

    // Contract-owned native value cannot fund a token link claim's native burn:
    // the transfer role spends no native input, so the kernel leaves it no burn.
    #[test(should_fail_with = "unsponsored action must not spend contract native value")]
    fn test_rejects_a_native_burn_from_contract_value() {
        let mut tx = sponsored();
        tx.open_fee_amount = 0;
        tx.native_burn_amount = 5;
        let _ = claim(tx, false, 0);
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

    global NATIVE_CONFIGURATION: Configuration =
        Configuration { configuration_salt: 0x77, asset_id: 0 };

    // A native link of 250 pays 240 to the claimant and a 10-unit open fee.
    fn native_claim() -> SmallPrivateValue {
        let mut tx = private_value();
        tx.input_slot_classes[0] = SLOT_CLASS_NATIVE;
        tx.input_commitments[0] = link_note(0);
        tx.output_slot_classes[0] = SLOT_CLASS_NATIVE;
        tx.open_fee_amount = 10;
        tx
    }

    fn run_native(tx: SmallPrivateValue, fee_paid: bool) -> [Field; RULE_STATEMENT_LENGTH] {
        main(
            RECENT_BLOCK,
            ADDRESS,
            PCASH_CHAIN_ID,
            fee_paid,
            tx,
            NATIVE_CONFIGURATION,
            opening(),
            0,
        )
    }

    #[test]
    fn test_accepts_a_native_claim_that_pays_its_fee_from_the_link() {
        let tx = native_claim();
        assert(
            run_native(tx, false)
                == rule_statement(
                    authorization_commitment(
                        ADDRESS,
                        link_configuration_commitment(NATIVE_CONFIGURATION),
                    ),
                    transfer_action_commitment(PCASH_CHAIN_ID, private_value_commitment(tx)),
                    RECENT_BLOCK,
                    0,
                ),
        );
    }

    // The link holder chooses the native burn, and it comes from the link value.
    #[test]
    fn test_accepts_a_native_claim_that_burns_from_the_link() {
        let mut tx = native_claim();
        tx.native_burn_amount = 5;
        let _ = run_native(tx, false);
    }

    #[test]
    fn test_accepts_a_native_claim_with_a_relay_output() {
        let mut tx = native_claim();
        tx.open_fee_amount = 0;
        tx.output_slot_classes[S_OUTPUTS - 1] = SLOT_CLASS_NATIVE;
        let _ = run_native(tx, false);
    }

    #[test]
    fn test_accepts_a_native_take_back_of_several_links() {
        let mut tx = native_claim();
        tx.input_slot_classes[1] = SLOT_CLASS_NATIVE;
        tx.input_commitments[1] = 0x99;
        let _ = run_native(tx, false);
    }

    #[test(should_fail_with = "native link claim must not be sponsored")]
    fn test_rejects_a_sponsored_native_claim() {
        let _ = run_native(native_claim(), true);
    }

    #[test(should_fail_with = "asset input must open in the configured asset")]
    fn test_rejects_a_token_note_under_the_native_configuration() {
        let mut tx = native_claim();
        tx.input_slot_classes[0] = SLOT_CLASS_ASSET;
        tx.input_commitments[0] = link_note(ASSET_ID);
        let _ = run_native(tx, false);
    }

    // In the sponsored role the native slots are the fee payer's, so a native
    // note can't stand in for the token link's opening.
    #[test(should_fail_with = "asset input must open in the configured asset")]
    fn test_rejects_a_native_note_under_a_token_configuration() {
        let _ = claim(native_claim(), true, 0);
    }
}
