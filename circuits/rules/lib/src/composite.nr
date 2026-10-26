// A single installed application can open either profile without changing its
// entry-scoped APPLICATION replay identity. Ordinary kernels stay monomorphic.

use pcash_protocol::generated::private_value_profiles::{
    L_INPUTS, L_OUTPUTS, L_SHAPE_ID, MAX_INPUTS, MAX_OUTPUTS, S_INPUTS, S_OUTPUTS, S_SHAPE_ID,
};
use pcash_protocol::ledger::private_value::{private_value_commitment, PrivateValue};

// Wide enough for either profile. The shape parameter is a placeholder that is
// never hashed: only project() interprets a composite value.
pub type CompositePrivateValue = PrivateValue<MAX_INPUTS, MAX_OUTPUTS, 0>;

fn project<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    private_value: CompositePrivateValue,
) -> PrivateValue<N_IN, N_OUT, SHAPE> {
    let mut input_classes = [0; N_IN];
    let mut input_commitments = [0; N_IN];
    let mut nullifiers = [0; N_IN];
    let mut output_classes = [0; N_OUT];
    let mut output_bodies = [0; N_OUT];
    for i in 0..N_IN {
        input_classes[i] = private_value.input_slot_classes[i];
        input_commitments[i] = private_value.input_commitments[i];
        nullifiers[i] = private_value.nullifiers[i];
    }
    for i in N_IN..MAX_INPUTS {
        assert(private_value.input_slot_classes[i] == 0, "inactive input class must be zero");
        assert(private_value.input_commitments[i] == 0, "inactive input commitment must be zero");
        assert(private_value.nullifiers[i] == 0, "inactive input nullifier must be zero");
    }
    for i in 0..N_OUT {
        output_classes[i] = private_value.output_slot_classes[i];
        output_bodies[i] = private_value.output_body_commitments[i];
    }
    for i in N_OUT..MAX_OUTPUTS {
        assert(private_value.output_slot_classes[i] == 0, "inactive output class must be zero");
        assert(
            private_value.output_body_commitments[i] == 0,
            "inactive output body commitment must be zero",
        );
    }
    PrivateValue {
        open_fee_amount: private_value.open_fee_amount,
        issuance_owner_commitment: private_value.issuance_owner_commitment,
        not_before_timestamp: private_value.not_before_timestamp,
        valid_until_timestamp: private_value.valid_until_timestamp,
        carrier_context_hash: private_value.carrier_context_hash,
        asset_burn_amount: private_value.asset_burn_amount,
        delivery_commitment: private_value.delivery_commitment,
        account_creation_commitment: private_value.account_creation_commitment,
        input_slot_classes: input_classes,
        input_commitments,
        nullifiers,
        output_slot_classes: output_classes,
        output_body_commitments: output_bodies,
    }
}

pub fn composite_private_value_commitment(
    shape: u32,
    private_value: CompositePrivateValue,
) -> Field {
    if shape == S_SHAPE_ID {
        private_value_commitment(project::<S_INPUTS, S_OUTPUTS, S_SHAPE_ID>(private_value))
    } else {
        assert(shape == L_SHAPE_ID, "private-value shape must be S or L");
        private_value_commitment(project::<L_INPUTS, L_OUTPUTS, L_SHAPE_ID>(private_value))
    }
}

mod tests {
    use super::{composite_private_value_commitment, CompositePrivateValue, project};
    use pcash_protocol::generated::private_value_profiles::{
        MAX_INPUTS, MAX_OUTPUTS, S_INPUTS, S_OUTPUTS, S_SHAPE_ID,
    };
    use pcash_protocol::ledger::private_value::private_value_commitment;

    fn empty_composite() -> CompositePrivateValue {
        CompositePrivateValue {
            open_fee_amount: 0,
            issuance_owner_commitment: 0,
            not_before_timestamp: 0,
            valid_until_timestamp: 1,
            carrier_context_hash: 0,
            asset_burn_amount: 0,
            delivery_commitment: 0,
            account_creation_commitment: 0,
            input_slot_classes: [0; MAX_INPUTS],
            input_commitments: [0; MAX_INPUTS],
            nullifiers: [0; MAX_INPUTS],
            output_slot_classes: [0; MAX_OUTPUTS],
            output_body_commitments: [0; MAX_OUTPUTS],
        }
    }

    #[test]
    fn test_small_projection_omits_canonically_absent_trailing_slots() {
        let mut private_value = empty_composite();
        for i in 0..S_INPUTS {
            private_value.nullifiers[i] = i as Field + 1;
        }
        for i in 0..S_OUTPUTS {
            private_value.output_body_commitments[i] = i as Field + 100;
        }
        let active = project::<S_INPUTS, S_OUTPUTS, S_SHAPE_ID>(private_value);
        assert(
            composite_private_value_commitment(S_SHAPE_ID, private_value)
                == private_value_commitment(active),
        );
    }

    #[test(should_fail_with = "inactive input nullifier must be zero")]
    fn test_small_projection_rejects_hidden_trailing_input() {
        let mut private_value = empty_composite();
        private_value.nullifiers[MAX_INPUTS - 1] = 1;
        let _ = project::<S_INPUTS, S_OUTPUTS, S_SHAPE_ID>(private_value);
    }

    #[test(should_fail_with = "inactive output body commitment must be zero")]
    fn test_small_projection_rejects_hidden_trailing_output() {
        let mut private_value = empty_composite();
        private_value.output_body_commitments[MAX_OUTPUTS - 1] = 1;
        let _ = project::<S_INPUTS, S_OUTPUTS, S_SHAPE_ID>(private_value);
    }

    #[test(should_fail_with = "private-value shape must be S or L")]
    fn test_composite_rejects_unassigned_selector() {
        let _ = composite_private_value_commitment(2, empty_composite());
    }

    #[test(should_fail_with = "inactive input class must be zero")]
    fn test_projection_rejects_hidden_input_class() {
        let mut private_value = empty_composite();
        private_value.input_slot_classes[1] = 1;
        let _ = project::<1, 1, 0>(private_value);
    }

    #[test(should_fail_with = "inactive input commitment must be zero")]
    fn test_projection_rejects_hidden_input_commitment() {
        let mut private_value = empty_composite();
        private_value.input_commitments[MAX_INPUTS - 1] = 1;
        let _ = project::<1, 1, 0>(private_value);
    }

    #[test(should_fail_with = "inactive output class must be zero")]
    fn test_projection_rejects_hidden_output_class() {
        let mut private_value = empty_composite();
        private_value.output_slot_classes[1] = 1;
        let _ = project::<1, 1, 0>(private_value);
    }
}
