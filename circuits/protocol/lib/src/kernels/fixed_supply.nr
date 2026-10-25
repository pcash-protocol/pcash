// The fixed-supply relation of every standard fungible asset: the asset
// identity from its definition, one creation marker, no burn, and asset outputs
// that sum to the initial supply, with the creating account's native notes
// funding the fee and its application markers enforced as in a transfer. The
// asset-creation kernel adds the creating account's authentication and
// authorization.

use crate::authorization::authentication::AccountOpening;
use crate::ledger::asset::{
    asset_creation_marker, asset_secret_commitment, standard_fungible_asset_id,
};
use crate::ledger::note::dummy_nullifier;
use crate::ledger::opening::{application_marker, open_native_notes};
use crate::ledger::private_value::{
    PrivateValue, PrivateValueChoices, SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET,
    SLOT_CLASS_ASSET_CREATION, SLOT_CLASS_DUMMY, SLOT_CLASS_NATIVE,
};
use crate::ledger::section::{
    assert_native_conservation, build_private_value, output_amount_sum, output_bodies,
};
use crate::primitives::types::InputNoteWitness;

/// Returns the private value of an asset creation, its commitment, and the
/// created asset's ID.
pub fn fixed_supply<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    choices: PrivateValueChoices<N_IN, N_OUT>,
    metadata_commitment: Field,
    initial_supply: Field,
    asset_secret: Field,
    account: AccountOpening,
    output_root: Field,
    dummy_input_seed: Field,
    native_inputs: [InputNoteWitness; N_IN],
    replay_ids: [Field; N_IN],
    output_owner_commitments: [Field; N_OUT],
    output_dummy_secrets: [Field; N_OUT],
    output_amounts: [Field; N_OUT],
) -> (PrivateValue<N_IN, N_OUT, SHAPE>, Field, Field) {
    assert(choices.asset_burn_amount == 0, "asset burn amount must be zero");

    let asset_id = standard_fungible_asset_id(
        metadata_commitment,
        initial_supply,
        asset_secret_commitment(asset_secret),
    );

    // Inputs: DUMMY, NATIVE notes of the creating account, exactly one creation
    // marker, and APPLICATION markers of the creating account and its selected
    // rule entry. No ASSET input: the asset is being created.
    let mut inputs = open_native_notes(
        choices.input_slot_classes,
        account,
        output_root,
        native_inputs,
    );
    let marker = asset_creation_marker(asset_id, asset_secret);
    let mut creation_marker_count: Field = 0;
    for i in 0..N_IN {
        let class = choices.input_slot_classes[i];
        if class == SLOT_CLASS_DUMMY {
            inputs.nullifiers[i] = dummy_nullifier(dummy_input_seed, i as Field);
        } else if class == SLOT_CLASS_ASSET_CREATION {
            inputs.nullifiers[i] = marker;
            creation_marker_count += 1;
        } else if class == SLOT_CLASS_APPLICATION {
            inputs.nullifiers[i] = application_marker(account, replay_ids[i]);
        } else {
            assert(
                class == SLOT_CLASS_NATIVE,
                "asset creation input class must be dummy, native, asset creation, or application",
            );
        }
    }
    assert(creation_marker_count == 1, "asset creation must carry exactly one creation marker");

    // Every asset output is in the namespace of the asset ID derived above.
    let bodies = output_bodies(
        choices.output_slot_classes,
        asset_id,
        output_owner_commitments,
        output_dummy_secrets,
        output_amounts,
    );
    assert(
        output_amount_sum(
            choices.output_slot_classes,
            output_amounts,
            SLOT_CLASS_ASSET,
        )
            == initial_supply,
        "asset outputs must sum to the initial supply",
    );
    assert_native_conservation(
        inputs.native_amount,
        choices.output_slot_classes,
        output_amounts,
        choices.open_fee_amount,
    );
    let (private_value, commitment) =
        build_private_value(choices, inputs.input_commitments, inputs.nullifiers, bodies);
    (private_value, commitment, asset_id)
}

mod tests {
    use crate::authorization::authentication::AccountOpening;
    use crate::authorization::statement::{assert_rule_statement, asset_creation_action_commitment};
    use crate::ledger::asset::{
        asset_creation_marker, asset_secret_commitment, standard_fungible_asset_id,
    };
    use crate::ledger::note::{
        application_nullifier, full_output_commitment, note_body_commitment, nullifier,
    };
    use crate::ledger::opening::application_marker;
    use crate::ledger::private_value::{
        PrivateValue, PrivateValueChoices, SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET,
        SLOT_CLASS_ASSET_CREATION, SLOT_CLASS_DUMMY, SLOT_CLASS_NATIVE,
    };
    use crate::primitives::params::{MAX_ASSET_SUPPLY, MERKLE_DEPTH};
    use crate::primitives::types::{InputNoteWitness, Note};
    use crate::state::merkle::binary_root_from_index;
    use super::fixed_supply;

    global TEST_SECRET: Field = 0xb0b0;
    global TEST_METADATA: Field = 0xa0a0;
    global TEST_SUPPLY: Field = 1_000_000;
    global TEST_SEED: Field = 0xaaa;
    global TEST_OWNER: Field = 0x111;
    global MAX_AMOUNT: Field = 0xffffffffffffffffffffffffffffffff;
    global ACCOUNT: AccountOpening =
        AccountOpening { address: 0x0e1, nk: 0x0e2, entry: 0x0e4, authorization: 0x0e5 };

    fn asset_id_of(supply: Field) -> Field {
        standard_fungible_asset_id(TEST_METADATA, supply, asset_secret_commitment(TEST_SECRET))
    }

    struct Fixture<let N_IN: u32, let N_OUT: u32> {
        choices: PrivateValueChoices<N_IN, N_OUT>,
        owners: [Field; N_OUT],
        secrets: [Field; N_OUT],
        amounts: [Field; N_OUT],
        native_inputs: [InputNoteWitness; N_IN],
        replay_ids: [Field; N_IN],
        output_root: Field,
    }

    // Slot zero carries the marker and the other inputs are padding. An output
    // with a nonzero amount is an asset note; the rest are padding.
    fn fixture<let N_IN: u32, let N_OUT: u32>(amounts: [Field; N_OUT]) -> Fixture<N_IN, N_OUT> {
        let mut input_slot_classes = [SLOT_CLASS_DUMMY; N_IN];
        input_slot_classes[0] = SLOT_CLASS_ASSET_CREATION;
        let mut output_slot_classes = [SLOT_CLASS_DUMMY; N_OUT];
        let mut owners = [0; N_OUT];
        let mut secrets = [0; N_OUT];
        for i in 0..N_OUT {
            if amounts[i] != 0 {
                output_slot_classes[i] = SLOT_CLASS_ASSET;
                owners[i] = TEST_OWNER + i as Field;
            } else {
                secrets[i] = (i + 1) as Field;
            }
        }
        Fixture {
            choices: PrivateValueChoices {
                open_fee_amount: 0,
                issuance_owner_commitment: 0,
                not_before_timestamp: 0,
                valid_until_timestamp: 1,
                carrier_context_hash: 0,
                asset_burn_amount: 0,
                delivery_commitment: 0,
                input_slot_classes,
                output_slot_classes,
            },
            owners,
            secrets,
            amounts,
            native_inputs: [
                InputNoteWitness {
                    output_index: 0,
                    note_secret: 0,
                    amount: 0,
                    siblings: [0; MERKLE_DEPTH],
                }; N_IN
            ],
            replay_ids: [0; N_IN],
            output_root: 0,
        }
    }

    fn one_output() -> Fixture<4, 5> {
        fixture([TEST_SUPPLY, 0, 0, 0, 0])
    }

    fn build<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
        f: Fixture<N_IN, N_OUT>,
        supply: Field,
        secret: Field,
    ) -> (PrivateValue<N_IN, N_OUT, SHAPE>, Field, Field) {
        fixed_supply(
            f.choices,
            TEST_METADATA,
            supply,
            secret,
            ACCOUNT,
            f.output_root,
            TEST_SEED,
            f.native_inputs,
            f.replay_ids,
            f.owners,
            f.secrets,
            f.amounts,
        )
    }

    fn run<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
        f: Fixture<N_IN, N_OUT>,
        supply: Field,
        secret: Field,
    ) -> PrivateValue<N_IN, N_OUT, SHAPE> {
        let (private_value, _, _) = build(f, supply, secret);
        private_value
    }

    #[test]
    fn test_fixed_supply_accepts_complete_initial_supply_in_one_output() {
        let _: PrivateValue<4, 5, 0> = run(one_output(), TEST_SUPPLY, TEST_SECRET);
    }

    #[test]
    fn test_fixed_supply_accepts_valid_split_across_outputs() {
        let _: PrivateValue<4, 5, 0> = run(
            fixture([600_000, 400_000, 0, 0, 0]),
            TEST_SUPPLY,
            TEST_SECRET,
        );
    }

    #[test]
    fn test_fixed_supply_accepts_the_asset_law_maximum_in_the_large_shape() {
        let mut amounts = [0; 32];
        for i in 27..32 {
            amounts[i] = MAX_AMOUNT;
        }
        let _: PrivateValue<32, 32, 1> = run(fixture(amounts), MAX_ASSET_SUPPLY, TEST_SECRET);
    }

    // The marker and every asset output derive from the asset the secret
    // defines, whose ID the relation returns. Another secret defines another
    // asset with another marker.
    #[test]
    fn test_fixed_supply_derives_the_marker_and_outputs_from_the_asset() {
        let (value, _, asset_id): (PrivateValue<4, 5, 0>, Field, Field) =
            build(one_output(), TEST_SUPPLY, TEST_SECRET);
        assert(asset_id == asset_id_of(TEST_SUPPLY));
        assert(value.nullifiers[0] == asset_creation_marker(asset_id, TEST_SECRET));
        assert(
            value.output_body_commitments[0]
                == note_body_commitment(TEST_OWNER, asset_id, TEST_SUPPLY),
        );
        let other: PrivateValue<4, 5, 0> = run(one_output(), TEST_SUPPLY, TEST_SECRET + 1);
        assert(other.nullifiers[0] != value.nullifiers[0]);
        assert(other.output_body_commitments[0] != value.output_body_commitments[0]);
    }

    // A native output is no part of the supply; the creating account's native
    // notes fund it.
    #[test]
    fn test_fixed_supply_does_not_count_a_native_output_toward_supply() {
        let mut f = one_output();
        let note = Note { owner: ACCOUNT.address, note_secret: 0x5ec, asset_id: 0, amount: 7 };
        let leaf = full_output_commitment(note, 0);
        f.output_root = binary_root_from_index(leaf, 0, [0; MERKLE_DEPTH]);
        f.choices.input_slot_classes[1] = SLOT_CLASS_NATIVE;
        f.native_inputs[1] = InputNoteWitness {
            output_index: 0,
            note_secret: 0x5ec,
            amount: 7,
            siblings: [0; MERKLE_DEPTH],
        };
        f.choices.output_slot_classes[1] = SLOT_CLASS_NATIVE;
        f.owners[1] = TEST_OWNER;
        f.amounts[1] = 7;
        let value: PrivateValue<4, 5, 0> = run(f, TEST_SUPPLY, TEST_SECRET);
        assert(value.input_commitments[1] == leaf);
        assert(value.nullifiers[1] == nullifier(leaf, ACCOUNT.nk, 0x5ec));
    }

    #[test(should_fail_with = "native inputs must equal native outputs plus the open fee")]
    fn test_fixed_supply_rejects_an_unfunded_native_output() {
        let mut f = one_output();
        f.choices.output_slot_classes[1] = SLOT_CLASS_NATIVE;
        f.owners[1] = TEST_OWNER;
        f.amounts[1] = 7;
        let _: PrivateValue<4, 5, 0> = run(f, TEST_SUPPLY, TEST_SECRET);
    }

    #[test(should_fail_with = "asset creation must carry exactly one creation marker")]
    fn test_fixed_supply_rejects_missing_creation_marker() {
        let mut f = one_output();
        f.choices.input_slot_classes[0] = SLOT_CLASS_DUMMY;
        let _: PrivateValue<4, 5, 0> = run(f, TEST_SUPPLY, TEST_SECRET);
    }

    #[test(should_fail_with = "asset creation must carry exactly one creation marker")]
    fn test_fixed_supply_rejects_duplicate_creation_marker() {
        let mut f = one_output();
        f.choices.input_slot_classes[1] = SLOT_CLASS_ASSET_CREATION;
        let _: PrivateValue<4, 5, 0> = run(f, TEST_SUPPLY, TEST_SECRET);
    }

    #[test(should_fail_with = "asset creation input class must be dummy, native, asset creation, or application")]
    fn test_fixed_supply_rejects_asset_input() {
        let mut f = one_output();
        f.choices.input_slot_classes[1] = SLOT_CLASS_ASSET;
        let _: PrivateValue<4, 5, 0> = run(f, TEST_SUPPLY, TEST_SECRET);
    }

    fn with_marker(replay_id: Field) -> Fixture<4, 5> {
        let mut f = one_output();
        f.choices.input_slot_classes[1] = SLOT_CLASS_APPLICATION;
        f.replay_ids[1] = replay_id;
        f
    }

    // The marker is the creating account's, scoped to its selected rule entry,
    // exactly as in a transfer.
    #[test]
    fn test_fixed_supply_derives_the_application_marker_of_the_creating_account() {
        let value: PrivateValue<4, 5, 0> = run(with_marker(0x7e), TEST_SUPPLY, TEST_SECRET);
        assert(value.nullifiers[1] == application_marker(ACCOUNT, 0x7e));
        assert(value.nullifiers[1] == application_nullifier(ACCOUNT.address, ACCOUNT.entry, 0x7e));
    }

    // A rule approved the private value with its marker; one built from
    // another replay ID is another private value, so the rule's statement does
    // not match it.
    #[test(should_fail_with = "rule statement must match the kernel's statement")]
    fn test_fixed_supply_rejects_a_marker_the_rule_did_not_approve() {
        let (_, approved, asset_id): (PrivateValue<4, 5, 0>, Field, Field) =
            build(with_marker(0x7e), TEST_SUPPLY, TEST_SECRET);
        let (_, built, _): (PrivateValue<4, 5, 0>, Field, Field) =
            build(with_marker(0x7f), TEST_SUPPLY, TEST_SECRET);
        assert_rule_statement(
            [1, asset_creation_action_commitment(7, approved, asset_id), 2, 0],
            1,
            asset_creation_action_commitment(7, built, asset_id),
            2,
            0,
        );
    }

    #[test]
    fn test_fixed_supply_accepts_replay_id_zero() {
        let value: PrivateValue<4, 5, 0> = run(with_marker(0), TEST_SUPPLY, TEST_SECRET);
        assert(value.nullifiers[1] == application_marker(ACCOUNT, 0));
    }

    // One fact authorizes at most one asset creation per account and rule
    // entry: another asset secret creates another asset under the same
    // marker, which the node's nullifier uniqueness then rejects.
    #[test]
    fn test_fixed_supply_application_marker_is_the_same_for_another_asset() {
        let first: PrivateValue<4, 5, 0> = run(with_marker(0x7e), TEST_SUPPLY, TEST_SECRET);
        let second: PrivateValue<4, 5, 0> = run(with_marker(0x7e), TEST_SUPPLY, TEST_SECRET + 1);
        assert(first.nullifiers[0] != second.nullifiers[0]);
        assert(first.nullifiers[1] == second.nullifiers[1]);
    }

    #[test(should_fail_with = "asset burn amount must be zero")]
    fn test_fixed_supply_rejects_nonzero_burn() {
        let mut f = one_output();
        f.choices.asset_burn_amount = 1;
        let _: PrivateValue<4, 5, 0> = run(f, TEST_SUPPLY, TEST_SECRET);
    }

    #[test(should_fail_with = "asset outputs must sum to the initial supply")]
    fn test_fixed_supply_rejects_underminting() {
        let _: PrivateValue<4, 5, 0> = run(
            fixture([TEST_SUPPLY - 1, 0, 0, 0, 0]),
            TEST_SUPPLY,
            TEST_SECRET,
        );
    }

    #[test(should_fail_with = "asset outputs must sum to the initial supply")]
    fn test_fixed_supply_rejects_overminting() {
        let _: PrivateValue<4, 5, 0> = run(
            fixture([TEST_SUPPLY + 1, 0, 0, 0, 0]),
            TEST_SUPPLY,
            TEST_SECRET,
        );
    }

    #[test(should_fail_with = "asset outputs must sum to the initial supply")]
    fn test_fixed_supply_rejects_no_asset_outputs() {
        let _: PrivateValue<4, 5, 0> = run(fixture([0; 5]), TEST_SUPPLY, TEST_SECRET);
    }

    // A zero supply creates the asset and its marker but no note.
    #[test]
    fn test_fixed_supply_accepts_a_zero_supply_without_asset_outputs() {
        let (value, _, asset_id): (PrivateValue<4, 5, 0>, Field, Field) =
            build(fixture([0; 5]), 0, TEST_SECRET);
        assert(asset_id == asset_id_of(0));
        assert(value.nullifiers[0] == asset_creation_marker(asset_id, TEST_SECRET));
        assert(value.output_slot_classes == [SLOT_CLASS_DUMMY; 5]);
    }

    // Real outputs are positive, so a zero supply cannot mint a unit.
    #[test(should_fail_with = "asset outputs must sum to the initial supply")]
    fn test_fixed_supply_rejects_a_positive_asset_output_under_a_zero_supply() {
        let _: PrivateValue<4, 5, 0> = run(fixture([1, 0, 0, 0, 0]), 0, TEST_SECRET);
    }

    #[test(should_fail_with = "real output amount must be nonzero")]
    fn test_fixed_supply_rejects_zero_amount_asset_output() {
        let mut f = one_output();
        f.choices.output_slot_classes[1] = SLOT_CLASS_ASSET;
        f.owners[1] = TEST_OWNER;
        let _: PrivateValue<4, 5, 0> = run(f, TEST_SUPPLY, TEST_SECRET);
    }

    #[test(should_fail)]
    fn test_fixed_supply_rejects_asset_output_above_the_note_amount_range() {
        let supply = MAX_AMOUNT + 1;
        let _: PrivateValue<4, 5, 0> = run(fixture([supply, 0, 0, 0, 0]), supply, TEST_SECRET);
    }
}
