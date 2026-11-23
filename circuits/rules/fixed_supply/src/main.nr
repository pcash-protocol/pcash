// The fixed-supply mint rule: the asset is minted once, in full. Its one mint
// marker is keyed by a secret whose commitment the configuration names, so only
// a holder of the secret can mint it and only once, and the asset outputs total
// the configured supply. Any account may submit and pay for the mint. One
// verification key serves both profiles: the rule opens the private value in
// its composite form.

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
use reference_rule_common::composite::{composite_private_value_commitment, CompositePrivateValue};
use reference_rule_common::generated::reference_rule_constants::{
    REFERENCE_FIXED_SUPPLY_CONFIGURATION_DOMAIN, REFERENCE_FIXED_SUPPLY_SECRET_DOMAIN,
};

pub struct FixedSupplyConfiguration {
    pub supply: Field,
    pub secret_commitment: Field,
}

pub fn secret_commitment(secret: Field) -> Field {
    pcash_hash([REFERENCE_FIXED_SUPPLY_SECRET_DOMAIN, secret])
}

pub fn configuration_commitment(configuration: FixedSupplyConfiguration) -> Field {
    pcash_hash([
        REFERENCE_FIXED_SUPPLY_CONFIGURATION_DOMAIN,
        configuration.supply,
        configuration.secret_commitment,
    ])
}

// The kernel binds `asset_id`, `account_address`, the chain, the anchor and
// the event entry by requiring the returned statement to equal its own.
fn main(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    asset_id: Field,
    account_address: Field,
    event_entry: Field,
    configuration: FixedSupplyConfiguration,
    secret: Field,
    shape: u32,
    private_value: CompositePrivateValue,
    output_owner_commitments: [Field; MAX_OUTPUTS],
    output_amounts: [Field; MAX_OUTPUTS],
) -> return_data [Field; RULE_STATEMENT_LENGTH] {
    assert_asset_aggregate(configuration.supply);
    assert(
        secret_commitment(secret) == configuration.secret_commitment,
        "secret must open the configured commitment",
    );
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

    let marker = mint_marker(asset_id, secret);
    let mut markers: Field = 0;
    for i in 0..MAX_INPUTS {
        if (i < inputs) & (private_value.input_slot_classes[i] == SLOT_CLASS_MINT) {
            assert(private_value.nullifiers[i] == marker, "mint marker must be the asset's marker");
            markers += 1;
        }
    }
    assert(markers == 1, "a fixed-supply mint carries exactly one mint marker");

    // At most MAX_OUTPUTS amounts below 2^128 sum below 2^133, so the equality
    // has its integer meaning.
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
    assert(total == configuration.supply, "asset outputs must total the fixed supply");

    rule_statement(
        mint_context(
            asset_id,
            configuration_commitment(configuration),
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
    use super::{configuration_commitment, FixedSupplyConfiguration, main, secret_commitment};
    use pcash_protocol::authorization::statement::mint_action_commitment;
    use pcash_protocol::generated::private_value_profiles::{
        L_INPUTS, L_OUTPUTS, L_SHAPE_ID, MAX_INPUTS, MAX_OUTPUTS, S_INPUTS, S_OUTPUTS, S_SHAPE_ID,
    };
    use pcash_protocol::ledger::asset::{mint_context, mint_marker};
    use pcash_protocol::ledger::note::note_body_commitment;
    use pcash_protocol::ledger::private_value::{
        SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET, SLOT_CLASS_DUMMY, SLOT_CLASS_MINT,
        SLOT_CLASS_NATIVE,
    };
    use reference_rule_common::composite::{
        composite_private_value_commitment, CompositePrivateValue,
    };

    global ASSET: Field = 0x7a55e7;
    global ACCOUNT: Field = 0x0e1;
    global SECRET: Field = 0xb0b0;
    global SUPPLY: Field = 1_000_000;
    global OWNER: Field = 0x77;
    global MAX_AMOUNT: Field = 0xffffffffffffffffffffffffffffffff;

    fn configuration(supply: Field) -> FixedSupplyConfiguration {
        FixedSupplyConfiguration { supply, secret_commitment: secret_commitment(SECRET) }
    }

    struct Mint {
        private_value: CompositePrivateValue,
        owners: [Field; MAX_OUTPUTS],
        amounts: [Field; MAX_OUTPUTS],
    }

    // An S mint whose slot 0 carries the asset's marker, slot 1 the account's
    // native note, and whose asset outputs carry `amounts`, after a native
    // change output in slot 0.
    fn mint(amounts: [Field; 4]) -> Mint {
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
            private_value.input_slot_classes[i] = SLOT_CLASS_DUMMY;
            private_value.nullifiers[i] = i as Field + 100;
        }
        for i in 0..S_OUTPUTS {
            private_value.output_slot_classes[i] = SLOT_CLASS_DUMMY;
            private_value.output_body_commitments[i] = i as Field + 200;
        }
        private_value.input_slot_classes[0] = SLOT_CLASS_MINT;
        private_value.nullifiers[0] = mint_marker(ASSET, SECRET);
        private_value.input_slot_classes[1] = SLOT_CLASS_NATIVE;
        private_value.input_commitments[1] = 1;
        private_value.output_slot_classes[0] = SLOT_CLASS_NATIVE;
        let mut owners = [0; MAX_OUTPUTS];
        let mut output_amounts = [0; MAX_OUTPUTS];
        for i in 0..4 {
            if amounts[i] != 0 {
                owners[i + 1] = OWNER + i as Field;
                output_amounts[i + 1] = amounts[i];
                private_value.output_slot_classes[i + 1] = SLOT_CLASS_ASSET;
                private_value.output_body_commitments[i + 1] =
                    note_body_commitment(owners[i + 1], ASSET, amounts[i]);
            }
        }
        Mint { private_value, owners, amounts: output_amounts }
    }

    fn run(m: Mint, shape: u32, supply: Field, secret: Field) -> [Field; 4] {
        main(
            7,
            2,
            ASSET,
            ACCOUNT,
            0,
            configuration(supply),
            secret,
            shape,
            m.private_value,
            m.owners,
            m.amounts,
        )
    }

    #[test]
    fn test_returns_the_mint_statement_for_the_complete_supply() {
        let m = mint([SUPPLY, 0, 0, 0]);
        let statement = run(m, S_SHAPE_ID, SUPPLY, SECRET);
        assert(
            statement[0]
                == mint_context(
                    ASSET,
                    configuration_commitment(configuration(SUPPLY)),
                    ACCOUNT,
                    1000,
                ),
        );
        assert(
            statement[1]
                == mint_action_commitment(
                    7,
                    composite_private_value_commitment(S_SHAPE_ID, m.private_value),
                    ASSET,
                ),
        );
        assert(statement[2] == 2);
        assert(statement[3] == 0);
    }

    #[test]
    fn test_accepts_a_split_supply() {
        let _ = run(mint([600_000, 400_000, 0, 0]), S_SHAPE_ID, SUPPLY, SECRET);
    }

    // A full profile L output set of maximal notes.
    #[test]
    fn test_accepts_the_largest_profile_l_supply() {
        let mut m = mint([0, 0, 0, 0]);
        for i in S_INPUTS..L_INPUTS {
            m.private_value.input_slot_classes[i] = SLOT_CLASS_DUMMY;
            m.private_value.nullifiers[i] = i as Field + 100;
        }
        let mut supply: Field = 0;
        for i in 0..L_OUTPUTS {
            m.owners[i] = OWNER;
            m.amounts[i] = MAX_AMOUNT;
            m.private_value.output_slot_classes[i] = SLOT_CLASS_ASSET;
            m.private_value.output_body_commitments[i] =
                note_body_commitment(OWNER, ASSET, MAX_AMOUNT);
            supply += MAX_AMOUNT;
        }
        let _ = run(m, L_SHAPE_ID, supply, SECRET);
    }

    // A zero supply mints the asset's marker but no note.
    #[test]
    fn test_accepts_a_zero_supply_without_asset_outputs() {
        let _ = run(mint([0, 0, 0, 0]), S_SHAPE_ID, 0, SECRET);
    }

    // The account's own application markers are its rule's business.
    #[test]
    fn test_ignores_the_accounts_application_markers() {
        let mut m = mint([SUPPLY, 0, 0, 0]);
        m.private_value.input_slot_classes[2] = SLOT_CLASS_APPLICATION;
        let _ = run(m, S_SHAPE_ID, SUPPLY, SECRET);
    }

    #[test(should_fail_with = "asset outputs must total the fixed supply")]
    fn test_rejects_underminting() {
        let _ = run(mint([SUPPLY - 1, 0, 0, 0]), S_SHAPE_ID, SUPPLY, SECRET);
    }

    #[test(should_fail_with = "asset outputs must total the fixed supply")]
    fn test_rejects_overminting() {
        let _ = run(mint([SUPPLY, 1, 0, 0]), S_SHAPE_ID, SUPPLY, SECRET);
    }

    #[test(should_fail_with = "secret must open the configured commitment")]
    fn test_rejects_another_secret() {
        let _ = run(mint([SUPPLY, 0, 0, 0]), S_SHAPE_ID, SUPPLY, SECRET + 1);
    }

    #[test(should_fail_with = "mint marker must be the asset's marker")]
    fn test_rejects_another_marker() {
        let mut m = mint([SUPPLY, 0, 0, 0]);
        m.private_value.nullifiers[0] = mint_marker(ASSET, SECRET + 1);
        let _ = run(m, S_SHAPE_ID, SUPPLY, SECRET);
    }

    #[test(should_fail_with = "a fixed-supply mint carries exactly one mint marker")]
    fn test_rejects_a_second_marker() {
        let mut m = mint([SUPPLY, 0, 0, 0]);
        m.private_value.input_slot_classes[2] = SLOT_CLASS_MINT;
        m.private_value.nullifiers[2] = mint_marker(ASSET, SECRET);
        let _ = run(m, S_SHAPE_ID, SUPPLY, SECRET);
    }

    #[test(should_fail_with = "a fixed-supply mint carries exactly one mint marker")]
    fn test_rejects_a_missing_marker() {
        let mut m = mint([SUPPLY, 0, 0, 0]);
        m.private_value.input_slot_classes[0] = SLOT_CLASS_DUMMY;
        let _ = run(m, S_SHAPE_ID, SUPPLY, SECRET);
    }

    #[test(should_fail_with = "asset output must open to its declared owner and amount")]
    fn test_rejects_an_output_of_another_asset() {
        let mut m = mint([SUPPLY, 0, 0, 0]);
        m.private_value.output_body_commitments[1] = note_body_commitment(OWNER, ASSET + 1, SUPPLY);
        let _ = run(m, S_SHAPE_ID, SUPPLY, SECRET);
    }
}
