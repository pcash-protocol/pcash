// One entry, one claim identity across S/L and the transfer and sponsored roles.
// This composite application is native-only even when its active profile is S.

use pcash_protocol::authorization::statement::{
    authorization_commitment, contract_action_commitment, rule_statement, RULE_STATEMENT_LENGTH,
};
use pcash_protocol::generated::private_value_profiles::{
    L_INPUTS, L_OUTPUTS, MAX_INPUTS, MAX_OUTPUTS, S_INPUTS, S_OUTPUTS, S_SHAPE_ID,
};
use pcash_protocol::ledger::note::{application_nullifier, note_body_commitment, owner_commitment};
use pcash_protocol::ledger::private_value::{
    SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET, SLOT_CLASS_ASSET_CREATION, SLOT_CLASS_NATIVE,
};
use pcash_protocol::primitives::hash::pcash_hash;
use pcash_protocol::primitives::range::{assert_address, assert_amount, assert_asset_aggregate};
use reference_rule_common::composite::{composite_private_value_commitment, CompositePrivateValue};
use reference_rule_common::generated::reference_rule_constants::REFERENCE_ASSET_CONFIGURATION_DOMAIN;

// The claim's sub-tags under REFERENCE_ASSET_CONFIGURATION_DOMAIN. The asset
// covenant uses 3.
global SHARED_ASSET_CLAIM_CONFIGURATION_TAG: Field = 4;
global SHARED_ASSET_CLAIM_SECRET_TAG: Field = 5;
global SHARED_ASSET_CLAIM_REPLAY_TAG: Field = 6;

pub struct Configuration {
    pub asset_id: Field,
    pub recipient: Field,
    pub amount: Field,
    pub maximum_fee: Field,
    pub secret_commitment: Field,
}

// The claim contract cannot derive its own address, since the address hashes
// this function's key, so it takes the address as a witness; the kernel
// compares the returned authorization commitment with the account it
// authenticated, which also pins the marker's account scope.
fn main(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    address: Field,
    shape: u32,
    private_value: CompositePrivateValue,
    configuration: Configuration,
    claim_secret: Field,
    selected_entry_commitment: Field,
    fee_paid: bool,
    output_amounts: [Field; MAX_OUTPUTS],
    output_note_secrets: [Field; MAX_OUTPUTS],
    event_entry: Field,
) -> return_data [Field; RULE_STATEMENT_LENGTH] {
    assert_address(configuration.recipient);
    assert_asset_aggregate(configuration.amount);
    assert(configuration.amount != 0, "claim amount must be nonzero");
    assert_amount(configuration.maximum_fee);
    assert(
        private_value.open_fee_amount as u128 <= configuration.maximum_fee as u128,
        "open fee must not exceed the claim's maximum fee",
    );
    assert(private_value.asset_burn_amount == 0, "asset burn amount must be zero");
    assert(
        configuration.secret_commitment
            == pcash_hash([
                REFERENCE_ASSET_CONFIGURATION_DOMAIN,
                SHARED_ASSET_CLAIM_SECRET_TAG,
                claim_secret,
            ]),
        "claim secret must open the secret commitment",
    );
    let configuration_commitment = pcash_hash([
        REFERENCE_ASSET_CONFIGURATION_DOMAIN,
        SHARED_ASSET_CLAIM_CONFIGURATION_TAG,
        configuration.asset_id,
        configuration.recipient,
        configuration.amount,
        configuration.maximum_fee,
        configuration.secret_commitment,
    ]);
    let replay_id = pcash_hash([
        REFERENCE_ASSET_CONFIGURATION_DOMAIN,
        SHARED_ASSET_CLAIM_REPLAY_TAG,
        claim_secret,
    ]);
    // The kernel computes this same nullifier with its authenticated account,
    // selected entry, and replay opening. Changing the installed entry keeps
    // sibling scopes independent; changing the shape does not change this scope.
    let marker = application_nullifier(address, selected_entry_commitment, replay_id);
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
        if i < inputs {
            assert(
                private_value.input_slot_classes[i] != SLOT_CLASS_ASSET_CREATION,
                "input slot must not be a creation marker",
            );
            if private_value.input_slot_classes[i] == SLOT_CLASS_APPLICATION {
                assert(
                    private_value.nullifiers[i] == marker,
                    "application marker must be the claim's replay marker",
                );
                markers += 1;
            }
        }
    }
    assert(markers == 1, "claim must carry one replay marker");
    // The kernel builds each ASSET body under its nonzero asset ID and a nonzero
    // amount, and each claim body below binds both.
    let mut total: Field = 0;
    for i in 0..MAX_OUTPUTS {
        if (i < outputs) & (private_value.output_slot_classes[i] == SLOT_CLASS_ASSET) {
            assert_amount(output_amounts[i]);
            let owner = owner_commitment(configuration.recipient, output_note_secrets[i]);
            assert(
                private_value.output_body_commitments[i]
                    == note_body_commitment(owner, configuration.asset_id, output_amounts[i]),
                "claim output must pay the claim recipient",
            );
            total += output_amounts[i];
        } else if i < outputs {
            // Only the separate fee payer may receive a native change output.
            assert(
                fee_paid | (private_value.output_slot_classes[i] != SLOT_CLASS_NATIVE),
                "unsponsored claim must not create a native output",
            );
        }
    }
    assert(total == configuration.amount, "claim outputs must total the claim amount");
    rule_statement(
        authorization_commitment(address, configuration_commitment),
        contract_action_commitment(
            pcash_chain_id,
            composite_private_value_commitment(shape, private_value),
            fee_paid,
        ),
        recent_pcash_block_hash,
        event_entry,
    )
}

mod tests {
    use super::{Configuration, main, SHARED_ASSET_CLAIM_REPLAY_TAG, SHARED_ASSET_CLAIM_SECRET_TAG};
    use pcash_protocol::generated::private_value_profiles::{
        L_INPUTS, L_OUTPUTS, L_SHAPE_ID, MAX_INPUTS, MAX_OUTPUTS, S_INPUTS, S_OUTPUTS, S_SHAPE_ID,
    };
    use pcash_protocol::ledger::note::{
        application_nullifier, note_body_commitment, owner_commitment,
    };
    use pcash_protocol::ledger::private_value::{
        SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET, SLOT_CLASS_NATIVE,
    };
    use pcash_protocol::primitives::hash::pcash_hash;
    use reference_rule_common::composite::CompositePrivateValue;
    use reference_rule_common::generated::reference_rule_constants::REFERENCE_ASSET_CONFIGURATION_DOMAIN;

    // Proves a claim of 100 units of asset 9 to 0x1234 under claim secret 11 and
    // returns the replay marker and the action commitment. `mutation` breaks one
    // part: 1 the replay marker, 2 the recipient, 5 a native output in slot 0.
    fn run_claim(shape: u32, fee_paid: bool, mutation: u32) -> (Field, Field) {
        run_claim_with(shape, fee_paid, mutation, 11, 0x1234, 0)
    }

    // `run_claim` under any claim secret and recipient. `stray` is written into
    // the amount and secret witnesses of absent output slot 0.
    fn run_claim_with(
        shape: u32,
        fee_paid: bool,
        mutation: u32,
        claim_secret: Field,
        recipient: Field,
        stray: Field,
    ) -> (Field, Field) {
        let configuration = Configuration {
            asset_id: 9,
            recipient,
            amount: 100,
            maximum_fee: 5,
            secret_commitment: pcash_hash([
                REFERENCE_ASSET_CONFIGURATION_DOMAIN,
                SHARED_ASSET_CLAIM_SECRET_TAG,
                claim_secret,
            ]),
        };
        let replay = pcash_hash([
            REFERENCE_ASSET_CONFIGURATION_DOMAIN,
            SHARED_ASSET_CLAIM_REPLAY_TAG,
            claim_secret,
        ]);
        let marker = application_nullifier(33, 22, replay);
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
        let mut private_value = CompositePrivateValue {
            open_fee_amount: 0,
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
        for i in 0..MAX_INPUTS {
            if i < inputs {
                private_value.nullifiers[i] = i as Field + 100;
            }
        }
        private_value.input_slot_classes[0] = SLOT_CLASS_ASSET;
        private_value.input_commitments[0] = 1;
        private_value.input_slot_classes[inputs - 1] = SLOT_CLASS_APPLICATION;
        private_value.nullifiers[inputs - 1] = if mutation == 1 { marker + 1 } else { marker };
        let mut amounts = [0; MAX_OUTPUTS];
        let mut secrets = [0; MAX_OUTPUTS];
        for i in 0..MAX_OUTPUTS {
            if i < outputs {
                private_value.output_body_commitments[i] = i as Field + 200;
            }
        }
        private_value.output_slot_classes[outputs - 1] = SLOT_CLASS_ASSET;
        amounts[outputs - 1] = 100;
        secrets[outputs - 1] = 55;
        amounts[0] = stray;
        secrets[0] = stray;
        let paid = if mutation == 2 {
            recipient + 1
        } else {
            recipient
        };
        private_value.output_body_commitments[outputs - 1] =
            note_body_commitment(owner_commitment(paid, 55), 9, 100);
        if mutation == 5 {
            private_value.output_slot_classes[0] = SLOT_CLASS_NATIVE;
        }
        let statement = main(
            1,
            1,
            33,
            shape,
            private_value,
            configuration,
            claim_secret,
            22,
            fee_paid,
            amounts,
            secrets,
            0,
        );
        (marker, statement[1])
    }

    #[test]
    fn test_shares_replay_scope_across_profiles_and_roles() {
        let (transfer_s, _) = run_claim(S_SHAPE_ID, false, 0);
        let (transfer_l, _) = run_claim(L_SHAPE_ID, false, 0);
        let (sponsored_s, _) = run_claim(S_SHAPE_ID, true, 0);
        let (sponsored_l, _) = run_claim(L_SHAPE_ID, true, 0);
        assert(transfer_s == transfer_l);
        assert(sponsored_s == sponsored_l);
    }

    // The deployer chooses the secret and the recipient, zero included.
    #[test]
    fn test_accepts_a_zero_claim_secret() {
        let _ = run_claim_with(S_SHAPE_ID, false, 0, 0, 0x1234, 0);
    }

    #[test]
    fn test_accepts_a_claim_to_address_zero() {
        let _ = run_claim_with(S_SHAPE_ID, false, 0, 11, 0, 0);
    }

    // An absent output slot opens nothing, so its witnesses are unread.
    #[test]
    fn test_ignores_absent_output_witnesses() {
        let (_, action) = run_claim(S_SHAPE_ID, false, 0);
        let (_, stray_action) = run_claim_with(S_SHAPE_ID, false, 0, 11, 0x1234, 7);
        assert(stray_action == action);
    }

    #[test(should_fail_with = "application marker must be the claim's replay marker")]
    fn test_rejects_fresh_replay_identity() {
        let _ = run_claim(S_SHAPE_ID, false, 1);
    }

    #[test(should_fail_with = "claim output must pay the claim recipient")]
    fn test_checks_large_last_output_recipient() {
        let _ = run_claim(L_SHAPE_ID, false, 2);
    }

    // The same private value approved for the transfer role does not approve the
    // sponsored-transfer role.
    #[test]
    fn test_transfer_authorization_is_not_a_sponsored_authorization() {
        let (_, transfer) = run_claim(S_SHAPE_ID, false, 0);
        let (_, sponsored) = run_claim(S_SHAPE_ID, true, 0);
        assert(transfer != sponsored);
    }

    #[test(should_fail_with = "unsponsored claim must not create a native output")]
    fn test_transfer_role_cannot_exempt_native_outputs() {
        let _ = run_claim(S_SHAPE_ID, false, 5);
    }

    #[test]
    fn test_sponsored_role_delegates_native_change_to_sponsored_transfer_kernel() {
        let _ = run_claim(S_SHAPE_ID, true, 5);
    }
}
