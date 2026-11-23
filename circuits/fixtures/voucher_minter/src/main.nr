// A mint rule that mints a fixed amount of its asset once per voucher. Any
// account may submit the mint and pay its fee. One verification key serves
// both profiles: the rule opens the private value in its composite form.

use pcash_protocol::authorization::statement::{
    mint_action_commitment, rule_statement, RULE_STATEMENT_LENGTH,
};
use pcash_protocol::generated::private_value_profiles::{
    L_INPUTS, L_OUTPUTS, MAX_INPUTS, MAX_OUTPUTS, S_INPUTS, S_OUTPUTS, S_SHAPE_ID,
};
use pcash_protocol::ledger::asset::{mint_context, mint_marker};
use pcash_protocol::ledger::note::note_body_commitment;
use pcash_protocol::ledger::private_value::{SLOT_CLASS_ASSET, SLOT_CLASS_MINT};
use pcash_protocol::primitives::hash::pcash_hash;
use pcash_protocol::primitives::range::{assert_amount, assert_asset_aggregate};
use pcash_protocol::state::merkle::binary_root_from_index;
use reference_rule_common::composite::{composite_private_value_commitment, CompositePrivateValue};
use reference_rule_common::generated::reference_rule_constants::REFERENCE_ASSET_CONFIGURATION_DOMAIN;

// The voucher rule's sub-tags under REFERENCE_ASSET_CONFIGURATION_DOMAIN. The
// asset covenant uses 3 and the shared asset claim 4 to 6.
global VOUCHER_MINTER_CONFIGURATION_TAG: Field = 7;
global VOUCHER_TAG: Field = 8;
global VOUCHER_REPLAY_TAG: Field = 9;
global VOUCHER_TREE_DEPTH: u32 = 4;

// The vouchers the rule honors and the amount each mints.
pub struct Configuration {
    pub voucher_root: Field,
    pub amount: Field,
}

// The kernel binds `asset_id`, `account_address`, the chain, the anchor and
// the event entry by requiring the returned statement to equal its own.
fn main(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    asset_id: Field,
    account_address: Field,
    shape: u32,
    private_value: CompositePrivateValue,
    configuration: Configuration,
    voucher_secret: Field,
    voucher_index: Field,
    voucher_siblings: [Field; VOUCHER_TREE_DEPTH],
    output_owner_commitments: [Field; MAX_OUTPUTS],
    output_amounts: [Field; MAX_OUTPUTS],
    event_entry: Field,
) -> return_data [Field; RULE_STATEMENT_LENGTH] {
    assert_asset_aggregate(configuration.amount);
    assert(configuration.amount != 0, "voucher amount must be nonzero");
    let voucher = pcash_hash(
        [REFERENCE_ASSET_CONFIGURATION_DOMAIN, VOUCHER_TAG, voucher_secret],
    );
    assert(
        binary_root_from_index(voucher, voucher_index, voucher_siblings)
            == configuration.voucher_root,
        "voucher must be in the voucher set",
    );
    let replay_id = pcash_hash([
        REFERENCE_ASSET_CONFIGURATION_DOMAIN,
        VOUCHER_REPLAY_TAG,
        voucher_secret,
    ]);
    let marker = mint_marker(asset_id, replay_id);

    let inputs = if shape == S_SHAPE_ID {
        S_INPUTS
    } else {
        L_INPUTS
    };
    let outputs = if shape == S_SHAPE_ID {
        S_OUTPUTS
    } else {
        L_OUTPUTS
    };
    let mut markers: Field = 0;
    for i in 0..MAX_INPUTS {
        if (i < inputs) & (private_value.input_slot_classes[i] == SLOT_CLASS_MINT) {
            assert(
                private_value.nullifiers[i] == marker,
                "mint marker must be the voucher's marker",
            );
            markers += 1;
        }
    }
    assert(markers == 1, "a voucher mint carries one mint marker");

    // Native outputs are the paying account's, which the kernel and its rule
    // govern. Every asset output is minted here and the voucher's amount is
    // their total.
    let mut total: Field = 0;
    for i in 0..MAX_OUTPUTS {
        if (i < outputs) & (private_value.output_slot_classes[i] == SLOT_CLASS_ASSET) {
            assert_amount(output_amounts[i]);
            assert(
                private_value.output_body_commitments[i]
                    == note_body_commitment(
                        output_owner_commitments[i],
                        asset_id,
                        output_amounts[i],
                    ),
                "asset output must open to its declared owner and amount",
            );
            total += output_amounts[i];
        }
    }
    assert(total == configuration.amount, "asset outputs must total the voucher amount");

    let configuration_commitment = pcash_hash([
        REFERENCE_ASSET_CONFIGURATION_DOMAIN,
        VOUCHER_MINTER_CONFIGURATION_TAG,
        configuration.voucher_root,
        configuration.amount,
    ]);
    rule_statement(
        mint_context(
            asset_id,
            configuration_commitment,
            account_address,
            private_value.valid_until_timestamp,
        ),
        mint_action_commitment(
            pcash_chain_id,
            composite_private_value_commitment(shape, private_value),
            asset_id,
        ),
        recent_pcash_block_hash,
        event_entry,
    )
}

mod tests {
    use super::{Configuration, main, VOUCHER_REPLAY_TAG, VOUCHER_TAG, VOUCHER_TREE_DEPTH};
    use pcash_protocol::generated::private_value_profiles::{
        MAX_INPUTS, MAX_OUTPUTS, S_INPUTS, S_OUTPUTS, S_SHAPE_ID,
    };
    use pcash_protocol::ledger::asset::mint_marker;
    use pcash_protocol::ledger::note::note_body_commitment;
    use pcash_protocol::ledger::private_value::{
        SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET, SLOT_CLASS_MINT, SLOT_CLASS_NATIVE,
    };
    use pcash_protocol::primitives::hash::pcash_hash;
    use pcash_protocol::state::merkle::binary_root_from_index;
    use reference_rule_common::composite::CompositePrivateValue;
    use reference_rule_common::generated::reference_rule_constants::REFERENCE_ASSET_CONFIGURATION_DOMAIN;

    global ADDRESS: Field = 33;
    global ASSET: Field = 0x7a55e7;
    global SECRET: Field = 11;
    global INDEX: Field = 5;

    // A mint of 100 units under voucher SECRET at INDEX, with a native input and
    // output of the paying account. `mutation` changes one part: 1 the marker,
    // 2 the total, 3 adds the account's application marker, 4 opens another
    // voucher, 5 adds a second mint marker.
    fn run(mutation: u32) -> Field {
        let siblings: [Field; VOUCHER_TREE_DEPTH] = [41, 42, 43, 44];
        let voucher = pcash_hash([REFERENCE_ASSET_CONFIGURATION_DOMAIN, VOUCHER_TAG, SECRET]);
        let configuration = Configuration {
            voucher_root: binary_root_from_index(voucher, INDEX, siblings),
            amount: 100,
        };
        let minted = ASSET;
        let replay = pcash_hash(
            [REFERENCE_ASSET_CONFIGURATION_DOMAIN, VOUCHER_REPLAY_TAG, SECRET],
        );
        let marker = mint_marker(minted, replay);
        let mut private_value = CompositePrivateValue {
            open_fee_amount: 1,
            native_burn_amount: 0,
            issuance_owner_commitment: 0,
            not_before_timestamp: 0,
            valid_until_timestamp: 1000,
            carrier_context_hash: 0,
            asset_burn_amount: 0,
            delivery_commitment: 0,
            account_creation_commitment: 0,
            input_slot_classes: [0; MAX_INPUTS],
            input_commitments: [0; MAX_INPUTS],
            nullifiers: [0; MAX_INPUTS],
            output_slot_classes: [0; MAX_OUTPUTS],
            output_body_commitments: [0; MAX_OUTPUTS],
        };
        for i in 0..S_INPUTS {
            private_value.nullifiers[i] = i as Field + 100;
        }
        for i in 0..S_OUTPUTS {
            private_value.output_body_commitments[i] = i as Field + 200;
        }
        private_value.input_slot_classes[0] = SLOT_CLASS_MINT;
        private_value.nullifiers[0] = if mutation == 1 { marker + 1 } else { marker };
        private_value.input_slot_classes[1] = SLOT_CLASS_NATIVE;
        private_value.input_commitments[1] = 1;
        if mutation == 3 {
            private_value.input_slot_classes[2] = SLOT_CLASS_APPLICATION;
        }
        if mutation == 5 {
            private_value.input_slot_classes[2] = SLOT_CLASS_MINT;
            private_value.nullifiers[2] = marker;
        }
        private_value.output_slot_classes[0] = SLOT_CLASS_NATIVE;
        let mut owners = [0; MAX_OUTPUTS];
        let mut amounts = [0; MAX_OUTPUTS];
        owners[1] = 0x77;
        amounts[1] = if mutation == 2 { 99 } else { 100 };
        private_value.output_slot_classes[1] = SLOT_CLASS_ASSET;
        private_value.output_body_commitments[1] = note_body_commitment(0x77, minted, amounts[1]);
        let secret = if mutation == 4 { SECRET + 1 } else { SECRET };
        let statement = main(
            1,
            1,
            ASSET,
            ADDRESS,
            S_SHAPE_ID,
            private_value,
            configuration,
            secret,
            INDEX,
            siblings,
            owners,
            amounts,
            0,
        );
        statement[1]
    }

    #[test]
    fn test_mints_once_per_voucher() {
        let _ = run(0);
    }

    #[test(should_fail_with = "mint marker must be the voucher's marker")]
    fn test_rejects_another_marker() {
        let _ = run(1);
    }

    #[test(should_fail_with = "asset outputs must total the voucher amount")]
    fn test_rejects_another_amount() {
        let _ = run(2);
    }

    // The paying account's application markers are its rule's business.
    #[test]
    fn test_accepts_the_accounts_application_marker() {
        let _ = run(3);
    }

    #[test(should_fail_with = "voucher must be in the voucher set")]
    fn test_rejects_a_voucher_outside_the_set() {
        let _ = run(4);
    }

    #[test(should_fail_with = "a voucher mint carries one mint marker")]
    fn test_rejects_a_second_marker() {
        let _ = run(5);
    }
}
