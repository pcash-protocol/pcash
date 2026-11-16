// The private-value section: the parts of a private value every kernel derives
// the same way, namely its output bodies, its conservation equations, and the
// private value itself from its free choices and the derived slots. This does
// not authorize spending or open inputs: each kernel derives its input
// commitments and nullifiers under its own input grammar and account roles, and
// applies the conservation equations that hold for them. The returned
// commitment binds classes, nullifiers, bodies, and the delivery commitment; the
// node checks the time bounds, the carrier context, freshness, and that
// nullifiers are nonzero and globally unique.

use crate::ledger::note::{note_body_commitment, owner_commitment};
use crate::ledger::private_value::{
    private_value_commitment, PrivateValue, PrivateValueChoices, SLOT_CLASS_ASSET, SLOT_CLASS_DUMMY,
    SLOT_CLASS_NATIVE,
};
use crate::primitives::range::assert_amount;

// The output bodies. A DUMMY output is an empty note of address zero, where no
// account exists, under its dummy secret. A real output carries its witnessed
// owner commitment, which stays opaque to the kernel; its amount is bounded and
// nonzero, in the asset's namespace when ASSET. Output secrets are ignored for
// real outputs, and owner commitments and amounts for DUMMY outputs.
pub fn output_bodies<let N_OUT: u32>(
    output_slot_classes: [Field; N_OUT],
    asset_id: Field,
    output_owner_commitments: [Field; N_OUT],
    output_dummy_secrets: [Field; N_OUT],
    output_amounts: [Field; N_OUT],
) -> [Field; N_OUT] {
    let mut bodies = [0; N_OUT];
    for i in 0..N_OUT {
        let class = output_slot_classes[i];
        let is_dummy = class == SLOT_CLASS_DUMMY;
        let is_asset = class == SLOT_CLASS_ASSET;
        if !is_dummy {
            if is_asset {
                assert(asset_id != 0, "asset ID must be nonzero for an asset slot");
            }
            assert_amount(output_amounts[i]);
            assert(output_amounts[i] != 0, "real output amount must be nonzero");
        }
        let owner = if is_dummy {
            owner_commitment(0, output_dummy_secrets[i])
        } else {
            output_owner_commitments[i]
        };
        let namespace = if is_asset { asset_id } else { 0 };
        let amount = if is_dummy { 0 } else { output_amounts[i] };
        bodies[i] = note_body_commitment(owner, namespace, amount);
    }
    bodies
}

// The total amount of the outputs of one class.
pub fn output_amount_sum<let N_OUT: u32>(
    output_slot_classes: [Field; N_OUT],
    output_amounts: [Field; N_OUT],
    class: Field,
) -> Field {
    let mut sum = 0;
    for i in 0..N_OUT {
        if output_slot_classes[i] == class {
            sum += output_amounts[i];
        }
    }
    sum
}

// Native inputs equal the native outputs plus the open fee and the native burn.
// Bounded sums sit far below the modulus, so an action with no native input
// has no native output, open fee or burn.
pub fn assert_native_conservation<let N_OUT: u32>(
    native_amount: Field,
    output_slot_classes: [Field; N_OUT],
    output_amounts: [Field; N_OUT],
    open_fee_amount: Field,
    native_burn_amount: Field,
) {
    assert(
        native_amount
            == output_amount_sum(output_slot_classes, output_amounts, SLOT_CLASS_NATIVE)
                + open_fee_amount
                + native_burn_amount,
        "native inputs must equal native outputs plus the open fee and the native burn",
    );
}

// Asset inputs equal the asset outputs plus the burn. Bounded sums sit far
// below the modulus, so this equality has its integer meaning.
pub fn assert_asset_conservation<let N_OUT: u32>(
    asset_amount: Field,
    output_slot_classes: [Field; N_OUT],
    output_amounts: [Field; N_OUT],
    asset_burn_amount: Field,
) {
    assert(
        asset_amount
            == output_amount_sum(output_slot_classes, output_amounts, SLOT_CLASS_ASSET)
                + asset_burn_amount,
        "asset inputs must equal asset outputs plus the burn amount",
    );
}

// The private value from its free choices and the slots its kernel derived,
// and its commitment.
pub fn build_private_value<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    choices: PrivateValueChoices<N_IN, N_OUT>,
    input_commitments: [Field; N_IN],
    nullifiers: [Field; N_IN],
    output_body_commitments: [Field; N_OUT],
) -> (PrivateValue<N_IN, N_OUT, SHAPE>, Field) {
    assert(
        (choices.issuance_owner_commitment == 0) | (choices.open_fee_amount == 0),
        "open fee must be zero with a designated issuance owner",
    );
    let value = PrivateValue {
        open_fee_amount: choices.open_fee_amount,
        native_burn_amount: choices.native_burn_amount,
        issuance_owner_commitment: choices.issuance_owner_commitment,
        not_before_timestamp: choices.not_before_timestamp,
        valid_until_timestamp: choices.valid_until_timestamp,
        carrier_context_hash: choices.carrier_context_hash,
        asset_burn_amount: choices.asset_burn_amount,
        delivery_commitment: choices.delivery_commitment,
        account_creation_commitment: choices.account_creation_commitment,
        input_slot_classes: choices.input_slot_classes,
        input_commitments,
        nullifiers,
        output_slot_classes: choices.output_slot_classes,
        output_body_commitments,
    };
    (value, private_value_commitment(value))
}

mod tests {
    use crate::authorization::authentication::AccountOpening;
    use crate::generated::private_value_profiles::{
        L_INPUTS, L_OUTPUTS, L_SHAPE_ID, S_INPUTS, S_OUTPUTS, S_SHAPE_ID,
    };
    use crate::ledger::note::{dummy_nullifier, note_body_commitment, owner_commitment};
    use crate::ledger::opening::open_transfer_inputs;
    use crate::ledger::private_value::{
        PrivateValue, PrivateValueChoices, SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET,
        SLOT_CLASS_DUMMY, SLOT_CLASS_NATIVE,
    };
    use crate::primitives::params::MERKLE_DEPTH;
    use crate::primitives::types::InputNoteWitness;
    use super::{assert_native_conservation, build_private_value, output_amount_sum, output_bodies};

    global SEED: Field = 0xaaa;

    // Every slot DUMMY; output i has dummy secret i + 1.
    fn all_dummy<let N_IN: u32, let N_OUT: u32>() -> (PrivateValueChoices<N_IN, N_OUT>, [Field; N_OUT]) {
        let choices = PrivateValueChoices {
            open_fee_amount: 1,
            native_burn_amount: 0,
            issuance_owner_commitment: 0,
            not_before_timestamp: 0,
            valid_until_timestamp: 1,
            carrier_context_hash: 0,
            asset_burn_amount: 0,
            delivery_commitment: 0,
            account_creation_commitment: 0,
            input_slot_classes: [SLOT_CLASS_DUMMY; N_IN],
            output_slot_classes: [SLOT_CLASS_DUMMY; N_OUT],
        };
        let mut secrets = [0; N_OUT];
        for i in 0..N_OUT {
            secrets[i] = (i + 1) as Field;
        }
        (choices, secrets)
    }

    fn padding_nullifiers<let N_IN: u32>() -> [Field; N_IN] {
        let mut nullifiers = [0; N_IN];
        for i in 0..N_IN {
            nullifiers[i] = dummy_nullifier(SEED, i as Field);
        }
        nullifiers
    }

    fn build<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
        choices: PrivateValueChoices<N_IN, N_OUT>,
        asset_id: Field,
        owners: [Field; N_OUT],
        secrets: [Field; N_OUT],
        amounts: [Field; N_OUT],
    ) -> (PrivateValue<N_IN, N_OUT, SHAPE>, Field) {
        let bodies = output_bodies(
            choices.output_slot_classes,
            asset_id,
            owners,
            secrets,
            amounts,
        );
        build_private_value(choices, [0; N_IN], padding_nullifiers(), bodies)
    }

    #[test]
    fn test_dummy_outputs_are_empty_notes_of_address_zero() {
        let (choices, secrets) = all_dummy::<S_INPUTS, S_OUTPUTS>();
        // Owner commitments and amounts of DUMMY outputs are ignored.
        let bodies = output_bodies(
            choices.output_slot_classes,
            0,
            [7; S_OUTPUTS],
            secrets,
            [9; S_OUTPUTS],
        );
        for i in 0..S_OUTPUTS {
            assert(bodies[i] == note_body_commitment(owner_commitment(0, secrets[i]), 0, 0));
        }
    }

    // A zero dummy secret gives a padding output the constant empty body.
    #[test]
    fn test_accepts_a_zero_dummy_output_secret() {
        let (choices, mut secrets) = all_dummy::<S_INPUTS, S_OUTPUTS>();
        secrets[0] = 0;
        let bodies = output_bodies(
            choices.output_slot_classes,
            0,
            [0; S_OUTPUTS],
            secrets,
            [0; S_OUTPUTS],
        );
        assert(bodies[0] == note_body_commitment(owner_commitment(0, 0), 0, 0));
    }

    // The kernel does not open a real output's owner commitment: zero, or the
    // issuance owner's commitment, is the sender's choice. The output keeps
    // its own body, which the node indexes separately from the payout.
    #[test]
    fn test_real_outputs_take_any_owner_commitment() {
        let (mut choices, secrets) = all_dummy::<4, 5>();
        choices.issuance_owner_commitment = 0x111;
        choices.open_fee_amount = 0;
        choices.output_slot_classes[0] = SLOT_CLASS_NATIVE;
        choices.output_slot_classes[1] = SLOT_CLASS_NATIVE;
        let mut owners = [0; 5];
        owners[1] = 0x111;
        let bodies = output_bodies(choices.output_slot_classes, 0, owners, secrets, [1; 5]);
        assert(bodies[0] == note_body_commitment(0, 0, 1));
        assert(bodies[1] == note_body_commitment(0x111, 0, 1));
    }

    #[test]
    fn test_accepts_dummy_padding_small() {
        let (choices, secrets) = all_dummy::<S_INPUTS, S_OUTPUTS>();
        let _ = build::<S_INPUTS, S_OUTPUTS, S_SHAPE_ID>(
            choices,
            0,
            [0; S_OUTPUTS],
            secrets,
            [0; S_OUTPUTS],
        );
    }

    #[test]
    fn test_accepts_dummy_padding_large() {
        let (choices, secrets) = all_dummy::<L_INPUTS, L_OUTPUTS>();
        let _ = build::<L_INPUTS, L_OUTPUTS, L_SHAPE_ID>(
            choices,
            0,
            [0; L_OUTPUTS],
            secrets,
            [0; L_OUTPUTS],
        );
    }

    #[test]
    fn test_real_outputs_carry_their_owner_namespace_and_amount() {
        let (mut choices, secrets) = all_dummy::<4, 5>();
        choices.output_slot_classes[0] = SLOT_CLASS_NATIVE;
        choices.output_slot_classes[1] = SLOT_CLASS_ASSET;
        let mut owners = [0; 5];
        owners[0] = 0x111;
        owners[1] = 0x222;
        let mut amounts = [0; 5];
        amounts[0] = 100;
        amounts[1] = 200;
        let bodies = output_bodies(choices.output_slot_classes, 0x55, owners, secrets, amounts);
        assert(bodies[0] == note_body_commitment(0x111, 0, 100));
        assert(bodies[1] == note_body_commitment(0x222, 0x55, 200));
        assert(output_amount_sum(choices.output_slot_classes, amounts, SLOT_CLASS_NATIVE) == 100);
        assert(output_amount_sum(choices.output_slot_classes, amounts, SLOT_CLASS_ASSET) == 200);
    }

    #[test(should_fail_with = "open fee must be zero with a designated issuance owner")]
    fn test_rejects_designated_issuance_with_open_fee() {
        let (mut choices, secrets) = all_dummy::<S_INPUTS, S_OUTPUTS>();
        choices.issuance_owner_commitment = 0x123;
        let _ = build::<S_INPUTS, S_OUTPUTS, S_SHAPE_ID>(
            choices,
            0,
            [0; S_OUTPUTS],
            secrets,
            [0; S_OUTPUTS],
        );
    }

    #[test]
    fn test_leaves_nullifier_uniqueness_to_the_node() {
        let (mut choices, secrets) = all_dummy::<4, 5>();
        choices.input_slot_classes[0] = SLOT_CLASS_APPLICATION;
        choices.input_slot_classes[1] = SLOT_CLASS_APPLICATION;
        let bodies = output_bodies(choices.output_slot_classes, 0, [0; 5], secrets, [0; 5]);
        let mut nullifiers = padding_nullifiers::<4>();
        nullifiers[0] = 0x111;
        nullifiers[1] = 0x111;
        let _: (PrivateValue<4, 5, 0>, Field) =
            build_private_value(choices, [0; 4], nullifiers, bodies);
    }

    #[test(should_fail_with = "real output amount must be nonzero")]
    fn test_rejects_real_native_output_with_zero_amount() {
        let (mut choices, secrets) = all_dummy::<S_INPUTS, S_OUTPUTS>();
        choices.output_slot_classes[0] = SLOT_CLASS_NATIVE;
        let _ = output_bodies(
            choices.output_slot_classes,
            0,
            [0x111; S_OUTPUTS],
            secrets,
            [0; S_OUTPUTS],
        );
    }

    #[test(should_fail_with = "asset ID must be nonzero for an asset slot")]
    fn test_rejects_asset_output_without_asset() {
        let (mut choices, secrets) = all_dummy::<S_INPUTS, S_OUTPUTS>();
        choices.output_slot_classes[0] = SLOT_CLASS_ASSET;
        let _ = output_bodies(
            choices.output_slot_classes,
            0,
            [0x111; S_OUTPUTS],
            secrets,
            [1; S_OUTPUTS],
        );
    }

    #[test(should_fail_with = "input slot class must be dummy, native, asset, asset creation, or application")]
    fn test_rejects_invalid_input_class() {
        let (mut choices, secrets) = all_dummy::<S_INPUTS, S_OUTPUTS>();
        choices.input_slot_classes[0] = 99;
        let _ = build::<S_INPUTS, S_OUTPUTS, S_SHAPE_ID>(
            choices,
            0,
            [0; S_OUTPUTS],
            secrets,
            [0; S_OUTPUTS],
        );
    }

    #[test(should_fail_with = "output slot class must be native, asset, or dummy")]
    fn test_rejects_invalid_output_class() {
        let (mut choices, secrets) = all_dummy::<S_INPUTS, S_OUTPUTS>();
        choices.output_slot_classes[0] = 99;
        let _ = build::<S_INPUTS, S_OUTPUTS, S_SHAPE_ID>(
            choices,
            0,
            [0x111; S_OUTPUTS],
            secrets,
            [1; S_OUTPUTS],
        );
    }

    // A native payment of 100: one native output, an open fee of 15, and the
    // given burn, conserved as in a transfer.
    fn native_payment(
        native_burn_amount: Field,
        output_amount: Field,
    ) -> PrivateValue<S_INPUTS, S_OUTPUTS, S_SHAPE_ID> {
        let (mut choices, secrets) = all_dummy::<S_INPUTS, S_OUTPUTS>();
        choices.open_fee_amount = 15;
        choices.native_burn_amount = native_burn_amount;
        choices.output_slot_classes[0] = SLOT_CLASS_NATIVE;
        let mut amounts = [0; S_OUTPUTS];
        amounts[0] = output_amount;
        assert_native_conservation(
            100,
            choices.output_slot_classes,
            amounts,
            choices.open_fee_amount,
            choices.native_burn_amount,
        );
        let (value, _) = build(choices, 0, [0x111; S_OUTPUTS], secrets, amounts);
        value
    }

    #[test]
    fn test_native_inputs_fund_the_burn() {
        let value = native_payment(25, 60);
        assert(value.native_burn_amount == 25);
    }

    #[test(should_fail_with = "native inputs must equal native outputs plus the open fee and the native burn")]
    fn test_rejects_a_burn_above_the_native_inputs() {
        let _ = native_payment(26, 60);
    }

    // Conservation holds in the field, 100 = 86 + 15 + (p - 1), but the
    // commitment range-checks the burn.
    #[test(should_fail)]
    fn test_rejects_a_wrapped_burn() {
        let _ = native_payment(-1, 86);
    }

    // An all-padding transfer opens no note, so conservation forces its burn
    // to zero.
    #[test(should_fail_with = "native inputs must equal native outputs plus the open fee and the native burn")]
    fn test_all_padding_transfer_cannot_burn() {
        let account =
            AccountOpening { address: 0x0a1, nk: 0x0a2, entry: 0x0a4, authorization: 0x0a5 };
        let inputs = open_transfer_inputs(
            [SLOT_CLASS_DUMMY; S_INPUTS],
            account,
            account,
            0,
            0,
            SEED,
            [
                InputNoteWitness {
                    output_index: 0,
                    note_secret: 0,
                    amount: 0,
                    siblings: [0; MERKLE_DEPTH],
                }; S_INPUTS
            ],
            [0; S_INPUTS],
        );
        assert_native_conservation(
            inputs.native_amount,
            [SLOT_CLASS_DUMMY; S_OUTPUTS],
            [0; S_OUTPUTS],
            0,
            1,
        );
    }

    // Frozen: deriving the slots does not change the commitment of the same
    // private value.
    #[test]
    fn test_returns_the_private_value_commitment() {
        let (choices, secrets) = all_dummy::<S_INPUTS, S_OUTPUTS>();
        let (_, commitment) = build::<S_INPUTS, S_OUTPUTS, S_SHAPE_ID>(
            choices,
            0,
            [0; S_OUTPUTS],
            secrets,
            [0; S_OUTPUTS],
        );
        assert(commitment == 0x0eca368cc96ac78e67768f1ff45cc860c1fa9ffb2888b9df0c1c86efbbdb90fb);
    }
}
