// A permissionless account rule for transfer actions that spend no notes.
//
// The rule opens no configuration, so it passes the authorization commitment
// through; the kernel compares it with the account and rule entry it opens.
// Every input is padding, so the kernel requires no account membership: the
// opened account need not be installed.

use pcash_protocol::authorization::statement::{
    rule_statement, RULE_STATEMENT_LENGTH, transfer_action_commitment,
};
use pcash_protocol::generated::private_value_profiles::{S_INPUTS, S_OUTPUTS, S_SHAPE_ID};
use pcash_protocol::ledger::private_value::{
    private_value_commitment, PrivateValue, SLOT_CLASS_DUMMY,
};

fn main(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    authorization_commitment: Field,
    private_value: PrivateValue<S_INPUTS, S_OUTPUTS, S_SHAPE_ID>,
    event_entry: Field,
) -> return_data [Field; RULE_STATEMENT_LENGTH] {
    for i in 0..S_INPUTS {
        assert(private_value.input_slot_classes[i] == SLOT_CLASS_DUMMY, "mine input must be dummy");
    }
    rule_statement(
        authorization_commitment,
        transfer_action_commitment(pcash_chain_id, private_value_commitment(private_value)),
        recent_pcash_block_hash,
        event_entry,
    )
}

mod tests {
    use super::main;
    use pcash_protocol::authorization::statement::transfer_action_commitment;
    use pcash_protocol::generated::private_value_profiles::{S_INPUTS, S_OUTPUTS, S_SHAPE_ID};
    use pcash_protocol::ledger::private_value::{
        private_value_commitment, PrivateValue, SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET,
        SLOT_CLASS_ASSET_CREATION, SLOT_CLASS_DUMMY, SLOT_CLASS_NATIVE,
    };

    fn dummy_transaction() -> PrivateValue<S_INPUTS, S_OUTPUTS, S_SHAPE_ID> {
        PrivateValue {
            open_fee_amount: 0,
            issuance_owner_commitment: 7,
            not_before_timestamp: 0,
            valid_until_timestamp: 2000000000,
            carrier_context_hash: 0,
            asset_burn_amount: 0,
            delivery_commitment: 0,
            account_creation_commitment: 0,
            input_slot_classes: [SLOT_CLASS_DUMMY; S_INPUTS],
            input_commitments: [0; S_INPUTS],
            nullifiers: [1; S_INPUTS],
            output_slot_classes: [SLOT_CLASS_DUMMY; S_OUTPUTS],
            output_body_commitments: [2; S_OUTPUTS],
        }
    }

    #[test]
    fn test_accepts_all_dummy_inputs() {
        let tx = dummy_transaction();
        assert(
            main(6, 4, 3, tx, 0)
                == [3, transfer_action_commitment(6, private_value_commitment(tx)), 4, 0],
        );
    }

    #[test(should_fail_with = "mine input must be dummy")]
    fn test_rejects_native_input() {
        let mut tx = dummy_transaction();
        tx.input_slot_classes[S_INPUTS - 1] = SLOT_CLASS_NATIVE;
        tx.input_commitments[S_INPUTS - 1] = 9;
        let _ = main(6, 4, 3, tx, 0);
    }

    #[test(should_fail_with = "mine input must be dummy")]
    fn test_rejects_asset_input() {
        let mut tx = dummy_transaction();
        tx.input_slot_classes[0] = SLOT_CLASS_ASSET;
        tx.input_commitments[0] = 9;
        let _ = main(6, 4, 3, tx, 0);
    }

    #[test(should_fail_with = "mine input must be dummy")]
    fn test_rejects_application_marker() {
        let mut tx = dummy_transaction();
        tx.input_slot_classes[0] = SLOT_CLASS_APPLICATION;
        let _ = main(6, 4, 3, tx, 0);
    }

    #[test(should_fail_with = "mine input must be dummy")]
    fn test_rejects_creation_marker() {
        let mut tx = dummy_transaction();
        tx.input_slot_classes[0] = SLOT_CLASS_ASSET_CREATION;
        let _ = main(6, 4, 3, tx, 0);
    }
}
