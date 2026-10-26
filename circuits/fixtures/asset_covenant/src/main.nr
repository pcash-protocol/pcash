// Smart Contract ASSET rule that permits nonzero-asset value to move only to
// one exact, already-live successor contract account.

use pcash_protocol::authorization::account::{ACCOUNT_KIND_CONTRACT, account_state_commitment};
use pcash_protocol::authorization::statement::{
    authorization_commitment, rule_statement, RULE_STATEMENT_LENGTH, transfer_action_commitment,
};
use pcash_protocol::generated::private_value_profiles::{S_INPUTS, S_OUTPUTS, S_SHAPE_ID};
use pcash_protocol::ledger::note::{note_body_commitment, owner_commitment};
use pcash_protocol::ledger::private_value::{
    private_value_commitment, PrivateValue, SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET,
    SLOT_CLASS_ASSET_CREATION, SLOT_CLASS_NATIVE,
};
use pcash_protocol::primitives::params::{BLOCK_HEADER_TREE_DEPTH, STATE_TREE_DEPTH};
use pcash_protocol::primitives::range::{assert_address, assert_amount};
use pcash_protocol::primitives::types::MerkleWitness;
use pcash_protocol::state::block::{
    block_header_fact, BLOCK_HEADER_KEY_STATE_ROOT, STATE_KEY_ACCOUNT_STATE_ROOT,
    state_root_from_opening,
};
use pcash_protocol::state::merkle::binary_root_from_index;
use reference_rule_common::asset_covenant::asset_covenant_successor_configuration_commitment;

fn assert_covenant_action<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    max_native_open_fee_amount: Field,
) {
    assert_amount(max_native_open_fee_amount);
    assert(private_value.asset_burn_amount == 0, "asset burn amount must be zero");
    assert(
        private_value.open_fee_amount as u128 <= max_native_open_fee_amount as u128,
        "open fee must not exceed the covenant's maximum fee",
    );
    for i in 0..N_IN {
        assert(
            private_value.input_slot_classes[i] != SLOT_CLASS_ASSET_CREATION,
            "input slot must not be a creation marker",
        );
        assert(
            private_value.input_slot_classes[i] != SLOT_CLASS_APPLICATION,
            "input slot must not be an application marker",
        );
    }
}

fn assert_successor_outputs<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    successor_address: Field,
    output_asset_ids: [Field; N_OUT],
    output_amounts: [Field; N_OUT],
    output_note_secrets: [Field; N_OUT],
) {
    // The kernel builds each real body under its class's namespace and a
    // nonzero amount, and each body below binds those values.
    let mut asset_output_count: Field = 0;
    for i in 0..N_OUT {
        let is_asset = private_value.output_slot_classes[i] == SLOT_CLASS_ASSET;
        let is_native = private_value.output_slot_classes[i] == SLOT_CLASS_NATIVE;
        if is_asset | is_native {
            if is_asset {
                asset_output_count += 1;
            }
            assert_amount(output_amounts[i]);
            let successor_owner_commitment =
                owner_commitment(successor_address, output_note_secrets[i]);
            assert(
                note_body_commitment(
                    successor_owner_commitment,
                    output_asset_ids[i],
                    output_amounts[i],
                )
                    == private_value.output_body_commitments[i],
                "output must target the live successor",
            );
        }
    }
    // Asset conservation then requires an asset input.
    assert(asset_output_count != 0, "covenant action must create an asset successor output");
}

// A contract function cannot derive its own address, since the address hashes
// this function's key, so it takes the address as a witness; the kernel
// compares the returned authorization commitment with the account it
// authenticated.
fn main(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    address: Field,
    private_value: PrivateValue<S_INPUTS, S_OUTPUTS, S_SHAPE_ID>,
    block_header_state_siblings: [Field; BLOCK_HEADER_TREE_DEPTH],
    state_account_siblings: [Field; STATE_TREE_DEPTH],
    successor_address: Field,
    successor_nullifier_key_commitment: Field,
    successor_rule_set_commitment: Field,
    successor_account_revision: Field,
    successor_receive_key_hash: Field,
    successor_account_witness: MerkleWitness,
    max_native_open_fee_amount: Field,
    output_asset_ids: [Field; S_OUTPUTS],
    output_amounts: [Field; S_OUTPUTS],
    output_note_secrets: [Field; S_OUTPUTS],
    event_entry: Field,
) -> return_data [Field; RULE_STATEMENT_LENGTH] {
    assert_covenant_action(private_value, max_native_open_fee_amount);

    // The successor is live: its row opens to an account-state root, which
    // opens to a state root that the recent block's header commits.
    assert_address(successor_address);
    let successor_account = account_state_commitment(
        successor_address,
        successor_nullifier_key_commitment,
        successor_rule_set_commitment,
        ACCOUNT_KIND_CONTRACT,
        successor_account_revision,
        successor_receive_key_hash,
    );
    let account_state_root = binary_root_from_index(
        successor_account,
        successor_account_witness.leaf_index,
        successor_account_witness.siblings,
    );
    let state_root = state_root_from_opening(
        account_state_root,
        STATE_KEY_ACCOUNT_STATE_ROOT,
        state_account_siblings,
    );
    block_header_fact(
        recent_pcash_block_hash,
        BLOCK_HEADER_KEY_STATE_ROOT,
        state_root,
        block_header_state_siblings,
    );
    let configuration_commitment = asset_covenant_successor_configuration_commitment(
        max_native_open_fee_amount,
        successor_address,
        successor_nullifier_key_commitment,
        successor_rule_set_commitment,
        successor_account_revision,
        successor_receive_key_hash,
    );

    assert_successor_outputs(
        private_value,
        successor_address,
        output_asset_ids,
        output_amounts,
        output_note_secrets,
    );
    rule_statement(
        authorization_commitment(address, configuration_commitment),
        transfer_action_commitment(pcash_chain_id, private_value_commitment(private_value)),
        recent_pcash_block_hash,
        event_entry,
    )
}

mod tests {
    use super::{assert_covenant_action, assert_successor_outputs};
    use pcash_protocol::ledger::note::{note_body_commitment, owner_commitment};
    use pcash_protocol::ledger::private_value::{
        SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET, SLOT_CLASS_ASSET_CREATION, SLOT_CLASS_NATIVE,
    };
    use reference_rule_common::test_support::TestPrivateValue;

    fn covenant_transaction() -> TestPrivateValue {
        TestPrivateValue {
            open_fee_amount: 0,
            issuance_owner_commitment: 0,
            not_before_timestamp: 0,
            valid_until_timestamp: 1,
            carrier_context_hash: 0,
            asset_burn_amount: 0,
            delivery_commitment: 0,
            account_creation_commitment: 0,
            input_slot_classes: [SLOT_CLASS_ASSET, SLOT_CLASS_NATIVE, 0, 0],
            input_commitments: [1, 2, 0, 0],
            nullifiers: [1, 2, 3, 4],
            output_slot_classes: [SLOT_CLASS_ASSET, SLOT_CLASS_NATIVE, 0, 0, 0],
            output_body_commitments: [1, 2, 3, 4, 5],
        }
    }

    #[test]
    fn test_asset_covenant_accepts_same_account_native_fee_reserve() {
        let mut private_value = covenant_transaction();
        private_value.open_fee_amount = 5;
        assert_covenant_action(private_value, 5);
    }

    #[test(should_fail_with = "asset burn amount must be zero")]
    fn test_asset_covenant_rejects_nonzero_burn() {
        let mut private_value = covenant_transaction();
        private_value.asset_burn_amount = 1;
        assert_covenant_action(private_value, 5);
    }

    #[test(should_fail_with = "open fee must not exceed the covenant's maximum fee")]
    fn test_asset_covenant_rejects_fee_above_configured_maximum() {
        let mut private_value = covenant_transaction();
        private_value.open_fee_amount = 6;
        assert_covenant_action(private_value, 5);
    }

    #[test(should_fail_with = "input slot must not be a creation marker")]
    fn test_asset_covenant_rejects_asset_creation() {
        let mut private_value = covenant_transaction();
        private_value.input_slot_classes = [SLOT_CLASS_ASSET_CREATION, SLOT_CLASS_NATIVE, 0, 0];
        private_value.input_commitments[0] = 0;
        assert_covenant_action(private_value, 5);
    }

    #[test(should_fail_with = "input slot must not be an application marker")]
    fn test_asset_covenant_rejects_application_marker() {
        let mut private_value = covenant_transaction();
        private_value.input_slot_classes = [SLOT_CLASS_ASSET, SLOT_CLASS_APPLICATION, 0, 0];
        private_value.input_commitments[1] = 0;
        assert_covenant_action(private_value, 5);
    }

    #[test]
    fn test_asset_covenant_requires_asset_and_native_outputs_to_target_successor() {
        let successor = 0x1234;
        let asset_secret = 0x51;
        let native_secret = 0x52;
        let asset_id = 0x99;
        let asset_amount = 1000;
        let native_amount = 20;
        let mut private_value = covenant_transaction();
        private_value.output_body_commitments[0] = note_body_commitment(
            owner_commitment(successor, asset_secret),
            asset_id,
            asset_amount,
        );
        private_value.output_body_commitments[1] =
            note_body_commitment(owner_commitment(successor, native_secret), 0, native_amount);
        assert_successor_outputs(
            private_value,
            successor,
            [asset_id, 0, 0, 0, 0],
            [asset_amount, native_amount, 0, 0, 0],
            [asset_secret, native_secret, 0, 0, 0],
        );
    }

    // An absent slot opens nothing, so its witnesses are unread.
    #[test]
    fn test_asset_covenant_ignores_absent_output_witnesses() {
        let successor = 0x1234;
        let mut private_value = covenant_transaction();
        private_value.output_body_commitments[0] =
            note_body_commitment(owner_commitment(successor, 0x51), 0x99, 1000);
        private_value.output_body_commitments[1] =
            note_body_commitment(owner_commitment(successor, 0x52), 0, 20);
        assert_successor_outputs(
            private_value,
            successor,
            [0x99, 0, 0x98, 0, 0],
            [1000, 20, 7, 0, 0],
            [0x51, 0x52, 0x53, 0, 0],
        );
    }

    #[test(should_fail_with = "output must target the live successor")]
    fn test_asset_covenant_rejects_native_change_to_another_owner() {
        let successor = 0x1234;
        let asset_secret = 0x51;
        let native_secret = 0x52;
        let asset_id = 0x99;
        let mut private_value = covenant_transaction();
        private_value.output_body_commitments[0] =
            note_body_commitment(owner_commitment(successor, asset_secret), asset_id, 1000);
        private_value.output_body_commitments[1] =
            note_body_commitment(owner_commitment(0x5678, native_secret), 0, 20);
        assert_successor_outputs(
            private_value,
            successor,
            [asset_id, 0, 0, 0, 0],
            [1000, 20, 0, 0, 0],
            [asset_secret, native_secret, 0, 0, 0],
        );
    }
}
