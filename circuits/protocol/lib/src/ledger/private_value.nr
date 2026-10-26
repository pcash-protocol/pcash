// The private value: its slot classes, its commitment, and the transaction
// statement that publishes it. Operand order is normative.

use crate::generated::pcash_constants::{
    DELIVERY_COMMITMENT_DOMAIN, PRIVATE_VALUE_COMMITMENT_DOMAIN,
};
use crate::generated::private_value_profiles::{S_INPUTS, S_OUTPUTS, S_SHAPE_ID};
use crate::primitives::hash::pcash_hash;
use crate::primitives::range::{assert_amount, assert_asset_aggregate, assert_timestamp};

// Private slot classes. NATIVE and ASSET are ordinary notes; markers carry no value.
//
//   DUMMY           the kernel, from one fresh per-action seed; scoped to nothing
//   ASSET_CREATION  the fixed-supply relation;                  scoped to the asset
//   APPLICATION     the selected account rule;                   scoped to (account, entry)
pub global SLOT_CLASS_DUMMY: Field = 0;
pub global SLOT_CLASS_NATIVE: Field = 1;
pub global SLOT_CLASS_ASSET: Field = 2;
pub global SLOT_CLASS_ASSET_CREATION: Field = 3;
pub global SLOT_CLASS_APPLICATION: Field = 4;

pub type SmallPrivateValue = PrivateValue<S_INPUTS, S_OUTPUTS, S_SHAPE_ID>;

pub struct PrivateValue<let N_IN: u32, let N_OUT: u32, let SHAPE: u32> {
    pub open_fee_amount: Field,
    pub issuance_owner_commitment: Field,
    pub not_before_timestamp: Field,
    pub valid_until_timestamp: Field,
    pub carrier_context_hash: Field,
    pub asset_burn_amount: Field,
    pub delivery_commitment: Field,
    pub account_creation_commitment: Field,
    pub input_slot_classes: [Field; N_IN],
    pub input_commitments: [Field; N_IN],
    pub nullifiers: [Field; N_IN],
    pub output_slot_classes: [Field; N_OUT],
    pub output_body_commitments: [Field; N_OUT],
}

// The fields of a private value that its prover chooses freely. A kernel takes
// these as witnesses and derives the rest: input commitments and nullifiers
// from the notes, markers and seed it opens, and output bodies from each
// output's owner commitment, namespace and amount.
pub struct PrivateValueChoices<let N_IN: u32, let N_OUT: u32> {
    pub open_fee_amount: Field,
    pub issuance_owner_commitment: Field,
    pub not_before_timestamp: Field,
    pub valid_until_timestamp: Field,
    pub carrier_context_hash: Field,
    pub asset_burn_amount: Field,
    pub delivery_commitment: Field,
    pub account_creation_commitment: Field,
    pub input_slot_classes: [Field; N_IN],
    pub output_slot_classes: [Field; N_OUT],
}

fn assert_input_slot_class(slot_class: Field) {
    if slot_class == SLOT_CLASS_DUMMY {} else if slot_class == SLOT_CLASS_NATIVE {} else if slot_class
        == SLOT_CLASS_ASSET {} else if slot_class == SLOT_CLASS_ASSET_CREATION {} else if slot_class
        == SLOT_CLASS_APPLICATION {} else {
        assert(
            false,
            "input slot class must be dummy, native, asset, asset creation, or application",
        );
    }
}

fn assert_output_slot_class(slot_class: Field) {
    if slot_class == SLOT_CLASS_NATIVE {} else if slot_class == SLOT_CLASS_ASSET {} else if slot_class
        == SLOT_CLASS_DUMMY {} else {
        assert(false, "output slot class must be native, asset, or dummy");
    }
}

// One hash over the profile, the global fields, and every slot in order. A
// slot's position fixes its role, so moving or reinterpreting a slot changes
// the commitment. Classes are free choices and are checked here. The kernel
// derives every other slot field: input commitments are zero for note-free
// classes and opened from notes otherwise, and output bodies are built from
// their owner, namespace and amount.
pub fn private_value_commitment<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    value: PrivateValue<N_IN, N_OUT, SHAPE>,
) -> Field {
    assert_amount(value.open_fee_amount);
    assert_asset_aggregate(value.asset_burn_amount);
    assert_timestamp(value.not_before_timestamp);
    assert_timestamp(value.valid_until_timestamp);

    let mut operands = [0; 3 * N_IN + 2 * N_OUT + 12];
    operands[0] = PRIVATE_VALUE_COMMITMENT_DOMAIN;
    operands[1] = SHAPE as Field;
    operands[2] = N_IN as Field;
    operands[3] = N_OUT as Field;
    operands[4] = value.open_fee_amount;
    operands[5] = value.issuance_owner_commitment;
    operands[6] = value.not_before_timestamp;
    operands[7] = value.valid_until_timestamp;
    operands[8] = value.carrier_context_hash;
    operands[9] = value.asset_burn_amount;
    operands[10] = value.delivery_commitment;
    operands[11] = value.account_creation_commitment;
    for i in 0..N_IN {
        assert_input_slot_class(value.input_slot_classes[i]);
        operands[12 + 3 * i] = value.input_slot_classes[i];
        operands[13 + 3 * i] = value.input_commitments[i];
        operands[14 + 3 * i] = value.nullifiers[i];
    }
    for i in 0..N_OUT {
        assert_output_slot_class(value.output_slot_classes[i]);
        operands[12 + 3 * N_IN + 2 * i] = value.output_slot_classes[i];
        operands[13 + 3 * N_IN + 2 * i] = value.output_body_commitments[i];
    }
    pcash_hash(operands)
}

/// The delivery commitment over every output's data hash and the arena hash.
pub fn delivery_commitment<let N_OUT: u32>(
    output_data_hashes: [Field; N_OUT],
    arena_hash: Field,
) -> Field {
    let mut operands = [0; N_OUT + 2];
    operands[0] = DELIVERY_COMMITMENT_DOMAIN;
    for i in 0..N_OUT {
        operands[1 + i] = output_data_hashes[i];
    }
    operands[1 + N_OUT] = arena_hash;
    pcash_hash(operands)
}

/// Verifier order for either concrete private-value shape.
pub fn transaction_statement<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    events_commitment: Field,
) -> [Field; N_IN + N_OUT + 10] {
    let mut statement = [0; N_IN + N_OUT + 10];
    statement[0] = pcash_chain_id;
    statement[1] = recent_pcash_block_hash;
    for i in 0..N_IN {
        statement[2 + i] = private_value.nullifiers[i];
    }
    for i in 0..N_OUT {
        statement[2 + N_IN + i] = private_value.output_body_commitments[i];
    }
    statement[2 + N_IN + N_OUT] = private_value.delivery_commitment;
    statement[3 + N_IN + N_OUT] = private_value.open_fee_amount;
    statement[4 + N_IN + N_OUT] = private_value.issuance_owner_commitment;
    statement[5 + N_IN + N_OUT] = private_value.not_before_timestamp;
    statement[6 + N_IN + N_OUT] = private_value.valid_until_timestamp;
    statement[7 + N_IN + N_OUT] = private_value.carrier_context_hash;
    statement[8 + N_IN + N_OUT] = events_commitment;
    statement[9 + N_IN + N_OUT] = private_value.account_creation_commitment;
    statement
}

/// An account update publishes the ordinary S fee statement followed by its
/// account update commitment.
pub fn account_action_statement<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    events_commitment: Field,
    extra_data: Field,
) -> [Field; N_IN + N_OUT + 11] {
    let value_statement = transaction_statement(
        pcash_chain_id,
        recent_pcash_block_hash,
        private_value,
        events_commitment,
    );
    let mut statement = [0; N_IN + N_OUT + 11];
    for i in 0..N_IN + N_OUT + 10 {
        statement[i] = value_statement[i];
    }
    statement[N_IN + N_OUT + 10] = extra_data;
    statement
}

mod tests {
    use crate::generated::pcash_constants::{
        DELIVERY_COMMITMENT_DOMAIN, PRIVATE_VALUE_COMMITMENT_DOMAIN,
    };
    use crate::primitives::hash::pcash_hash;
    use super::{
        account_action_statement, assert_input_slot_class, assert_output_slot_class,
        delivery_commitment, private_value_commitment, PrivateValue, SLOT_CLASS_APPLICATION,
        SLOT_CLASS_ASSET, SLOT_CLASS_ASSET_CREATION, SLOT_CLASS_DUMMY, SLOT_CLASS_NATIVE,
        transaction_statement,
    };

    fn all_dummy_private_value<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>() -> PrivateValue<N_IN, N_OUT, SHAPE> {
        PrivateValue {
            open_fee_amount: 0,
            issuance_owner_commitment: 0,
            not_before_timestamp: 0,
            valid_until_timestamp: 3,
            carrier_context_hash: 0,
            asset_burn_amount: 0,
            delivery_commitment: 0,
            account_creation_commitment: 0,
            input_slot_classes: [SLOT_CLASS_DUMMY; N_IN],
            input_commitments: [0; N_IN],
            nullifiers: [1; N_IN],
            output_slot_classes: [SLOT_CLASS_DUMMY; N_OUT],
            output_body_commitments: [2; N_OUT],
        }
    }

    #[test]
    fn test_profiles_bind_every_slot_and_the_compiled_shape() {
        let base = private_value_commitment(all_dummy_private_value::<32, 32, 1>());
        let mut changed_input = all_dummy_private_value::<32, 32, 1>();
        changed_input.nullifiers[31] = 4;
        assert(base != private_value_commitment(changed_input));
        let mut changed_output = all_dummy_private_value::<32, 32, 1>();
        changed_output.output_body_commitments[31] = 5;
        assert(base != private_value_commitment(changed_output));
        let mut changed_delivery = all_dummy_private_value::<32, 32, 1>();
        changed_delivery.delivery_commitment = 6;
        assert(base != private_value_commitment(changed_delivery));
        let mut changed_carrier_context = all_dummy_private_value::<32, 32, 1>();
        changed_carrier_context.carrier_context_hash = 7;
        assert(base != private_value_commitment(changed_carrier_context));
        let mut changed_creation = all_dummy_private_value::<32, 32, 1>();
        changed_creation.account_creation_commitment = 8;
        assert(base != private_value_commitment(changed_creation));
        // Shapes with equal dimensions still have distinct identities.
        assert(base != private_value_commitment(all_dummy_private_value::<32, 32, 0>()));
    }

    #[test]
    fn test_private_value_commitment_operand_order() {
        let value: PrivateValue<4, 5, 0> = PrivateValue {
            open_fee_amount: 8,
            issuance_owner_commitment: 9,
            not_before_timestamp: 10,
            valid_until_timestamp: 11,
            carrier_context_hash: 15,
            asset_burn_amount: 12,
            delivery_commitment: 13,
            account_creation_commitment: 0,
            input_slot_classes: [
                SLOT_CLASS_ASSET,
                SLOT_CLASS_NATIVE,
                SLOT_CLASS_ASSET_CREATION,
                SLOT_CLASS_DUMMY,
            ],
            input_commitments: [20, 21, 0, 0],
            nullifiers: [30, 31, 32, 33],
            output_slot_classes: [
                SLOT_CLASS_ASSET,
                SLOT_CLASS_NATIVE,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
            ],
            output_body_commitments: [40, 41, 42, 43, 44],
        };
        assert(
            private_value_commitment(value)
                == pcash_hash([
                    PRIVATE_VALUE_COMMITMENT_DOMAIN,
                    0,
                    4,
                    5,
                    8,
                    9,
                    10,
                    11,
                    15,
                    12,
                    13,
                    0,
                    SLOT_CLASS_ASSET,
                    20,
                    30,
                    SLOT_CLASS_NATIVE,
                    21,
                    31,
                    SLOT_CLASS_ASSET_CREATION,
                    0,
                    32,
                    SLOT_CLASS_DUMMY,
                    0,
                    33,
                    SLOT_CLASS_ASSET,
                    40,
                    SLOT_CLASS_NATIVE,
                    41,
                    SLOT_CLASS_DUMMY,
                    42,
                    SLOT_CLASS_DUMMY,
                    43,
                    SLOT_CLASS_DUMMY,
                    44,
                ]),
        );
    }

    #[test]
    fn test_delivery_commitment_operand_order() {
        assert(
            delivery_commitment([50, 51, 52, 53, 54], 55)
                == pcash_hash([DELIVERY_COMMITMENT_DOMAIN, 50, 51, 52, 53, 54, 55]),
        );
    }

    #[test]
    fn test_statement_order() {
        let mut value = all_dummy_private_value::<4, 5, 0>();
        value.open_fee_amount = 8;
        value.issuance_owner_commitment = 9;
        value.not_before_timestamp = 10;
        value.valid_until_timestamp = 11;
        value.carrier_context_hash = 12;
        value.delivery_commitment = 13;
        value.nullifiers = [30, 31, 32, 33];
        value.output_body_commitments = [40, 41, 42, 43, 44];
        assert(
            transaction_statement(6, 7, value, 14)
                == [6, 7, 30, 31, 32, 33, 40, 41, 42, 43, 44, 13, 8, 9, 10, 11, 12, 14, 0],
        );
        assert(
            account_action_statement(6, 7, value, 14, 15)
                == [6, 7, 30, 31, 32, 33, 40, 41, 42, 43, 44, 13, 8, 9, 10, 11, 12, 14, 0, 15],
        );
    }

    #[test]
    fn test_application_input_class_is_committed() {
        // Class 4 is a valid input class, distinct from the other marker classes.
        assert_input_slot_class(SLOT_CLASS_APPLICATION);
        let mut application = all_dummy_private_value::<4, 5, 0>();
        application.input_slot_classes[2] = SLOT_CLASS_APPLICATION;
        let mut creation = all_dummy_private_value::<4, 5, 0>();
        creation.input_slot_classes[2] = SLOT_CLASS_ASSET_CREATION;
        let commitment = private_value_commitment(application);
        assert(commitment != private_value_commitment(creation));
        assert(commitment != private_value_commitment(all_dummy_private_value::<4, 5, 0>()));
    }

    #[test(should_fail_with = "input slot class must be dummy, native, asset, asset creation, or application")]
    fn test_input_slot_class_rejects_unassigned_value() {
        assert_input_slot_class(7);
    }

    #[test(should_fail_with = "output slot class must be native, asset, or dummy")]
    fn test_output_slot_class_rejects_input_only_application() {
        assert_output_slot_class(SLOT_CLASS_APPLICATION);
    }
}
