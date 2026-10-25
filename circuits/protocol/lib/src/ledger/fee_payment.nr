// A native-only account action: one account's native notes fund the open
// fee, an optional private relay output, and at most one change note.
//
// This is the value relation of every fee-bearing account action. A user
// account update funds its own fee this way, and a sponsored contract-account
// creation is funded this way by the sponsor. Both build the same private value
// as a type-0 transaction, and the node checks their fee section as it checks
// one. The section does not post issuanceOwnerCommitment: the node supplies
// zero there, and the action earns no issuance.
//
// The change secret is a free witness: change returns to a real party who
// keeps the secret, and the authorizing rule binds whichever opening it
// approved. Zero fee with every slot dummy is a valid degenerate payment.

use crate::authorization::authentication::AccountOpening;
use crate::ledger::note::{dummy_nullifier, owner_commitment};
use crate::ledger::opening::{open_native_notes, OpenedInputs};
use crate::ledger::private_value::{
    PrivateValue, PrivateValueChoices, SLOT_CLASS_DUMMY, SLOT_CLASS_NATIVE,
};
use crate::ledger::section::{build_private_value, output_bodies};
use crate::primitives::types::InputNoteWitness;

pub struct NativeChange {
    pub slot: u32,
    pub secret: Field,
    pub amount: Field,
}

pub struct NativeRelayOutput {
    pub slot: u32,
    pub amount: Field,
}

/// The output owners and amounts of the payer's change note and the optional
/// private relay note. A nonzero change or relay amount lands in its own
/// NATIVE slot, and change opens to the payer's address under the declared
/// secret; every other output keeps its witnessed owner and a zero amount.
///
/// The caller passes the result to output_bodies, which provides the nonzero
/// and range checks: it rejects a real output whose amount is zero or wider
/// than 128 bits. Every NATIVE output is therefore the change or the relay
/// note, and both amounts are bounded. With a zero asset ID, output_bodies also
/// rejects an ASSET output.
pub fn native_change_outputs<let N_OUT: u32>(
    output_slot_classes: [Field; N_OUT],
    output_owner_commitments: [Field; N_OUT],
    payer_address: Field,
    change: NativeChange,
    relay: NativeRelayOutput,
) -> ([Field; N_OUT], [Field; N_OUT]) {
    if relay.amount != 0 {
        assert(relay.slot < N_OUT, "relay slot must be an output slot");
        if change.amount != 0 {
            assert(relay.slot != change.slot, "relay and change slots must differ");
        }
        assert(
            output_slot_classes[relay.slot] == SLOT_CLASS_NATIVE,
            "relay slot must hold a native output",
        );
    }
    if change.amount != 0 {
        assert(change.slot < N_OUT, "change slot must be an output slot");
        assert(
            output_slot_classes[change.slot] == SLOT_CLASS_NATIVE,
            "change slot must hold a native output",
        );
    }
    let change_owner = owner_commitment(payer_address, change.secret);
    let mut owners = output_owner_commitments;
    let mut amounts = [0; N_OUT];
    for i in 0..N_OUT {
        let is_native = output_slot_classes[i] == SLOT_CLASS_NATIVE;
        if is_native & (i == change.slot) {
            amounts[i] = change.amount;
            if change.amount != 0 {
                owners[i] = change_owner;
            }
        }
        if (relay.amount != 0) & is_native & (i == relay.slot) {
            amounts[i] = relay.amount;
        }
    }
    (owners, amounts)
}

/// A fee payment's inputs: NATIVE notes of the payer, and DUMMY padding.
fn open_fee_payment_inputs<let N_IN: u32>(
    input_slot_classes: [Field; N_IN],
    payer: AccountOpening,
    output_root: Field,
    dummy_input_seed: Field,
    native_inputs: [InputNoteWitness; N_IN],
) -> OpenedInputs<N_IN> {
    let mut inputs = open_native_notes(input_slot_classes, payer, output_root, native_inputs);
    for i in 0..N_IN {
        let class = input_slot_classes[i];
        if class == SLOT_CLASS_DUMMY {
            inputs.nullifiers[i] = dummy_nullifier(dummy_input_seed, i as Field);
        } else {
            assert(class == SLOT_CLASS_NATIVE, "fee payment input must be native or dummy");
        }
    }
    inputs
}

pub fn assert_native_fee_conservation(
    native_sum_in: Field,
    open_fee_amount: Field,
    change_amount: Field,
    relay_amount: Field,
) {
    assert(
        native_sum_in == open_fee_amount + change_amount + relay_amount,
        "native inputs must equal native outputs plus the open fee",
    );
}

/// The complete native fee-payment relation for one payer. Returns the private
/// value and its commitment.
pub fn native_fee_payment<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    choices: PrivateValueChoices<N_IN, N_OUT>,
    payer: AccountOpening,
    output_root: Field,
    native_inputs: [InputNoteWitness; N_IN],
    dummy_input_seed: Field,
    output_owner_commitments: [Field; N_OUT],
    output_dummy_secrets: [Field; N_OUT],
    change: NativeChange,
    relay: NativeRelayOutput,
) -> (PrivateValue<N_IN, N_OUT, SHAPE>, Field) {
    let inputs = open_fee_payment_inputs(
        choices.input_slot_classes,
        payer,
        output_root,
        dummy_input_seed,
        native_inputs,
    );
    let (owners, amounts) = native_change_outputs(
        choices.output_slot_classes,
        output_owner_commitments,
        payer.address,
        change,
        relay,
    );
    let bodies = output_bodies(
        choices.output_slot_classes,
        0,
        owners,
        output_dummy_secrets,
        amounts,
    );
    assert(choices.asset_burn_amount == 0, "asset burn amount must be zero");
    assert_native_fee_conservation(
        inputs.native_amount,
        choices.open_fee_amount,
        change.amount,
        relay.amount,
    );
    build_private_value(choices, inputs.input_commitments, inputs.nullifiers, bodies)
}

mod tests {
    use crate::authorization::authentication::AccountOpening;
    use crate::ledger::note::{
        dummy_nullifier, full_output_commitment, note_body_commitment, nullifier, owner_commitment,
    };
    use crate::ledger::note::tests::single_note_opening;
    use crate::ledger::private_value::{
        PrivateValue, PrivateValueChoices, SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET,
        SLOT_CLASS_DUMMY, SLOT_CLASS_NATIVE,
    };
    use crate::primitives::params::MERKLE_DEPTH;
    use crate::primitives::types::{InputNoteWitness, Note};
    use super::{
        assert_native_fee_conservation, native_change_outputs, native_fee_payment, NativeChange,
        NativeRelayOutput,
    };

    global OWNER: Field = 0x1111111111111111111111111111111111111111;

    fn classes(change_slot_native: bool) -> [Field; 5] {
        [
            if change_slot_native {
                SLOT_CLASS_NATIVE
            } else {
                SLOT_CLASS_DUMMY
            },
            SLOT_CLASS_DUMMY,
            SLOT_CLASS_DUMMY,
            SLOT_CLASS_DUMMY,
            SLOT_CLASS_DUMMY,
        ]
    }

    fn absent_relay() -> NativeRelayOutput {
        NativeRelayOutput { slot: 1, amount: 0 }
    }

    // A fee payment from DUMMY inputs only, with no open fee: the outputs are
    // all that is checked before conservation.
    fn pay_without_inputs(
        output_slot_classes: [Field; 5],
        change: NativeChange,
        relay: NativeRelayOutput,
    ) {
        let choices = PrivateValueChoices {
            open_fee_amount: 0,
            issuance_owner_commitment: 0,
            not_before_timestamp: 0,
            valid_until_timestamp: 2000000000,
            carrier_context_hash: 0,
            asset_burn_amount: 0,
            delivery_commitment: 0x61,
            input_slot_classes: [SLOT_CLASS_DUMMY; 4],
            output_slot_classes,
        };
        let no_inputs = [
            InputNoteWitness {
                output_index: 0,
                note_secret: 0,
                amount: 0,
                siblings: [0; MERKLE_DEPTH],
            }; 4
        ];
        let _: (PrivateValue<4, 5, 0>, Field) = native_fee_payment(
            choices,
            AccountOpening { address: OWNER, nk: 0x0b2, entry: 0x0b4, authorization: 0x0b5 },
            0,
            no_inputs,
            0xaaa,
            [0x111; 5],
            [1, 2, 3, 4, 5],
            change,
            relay,
        );
    }

    #[test]
    fn test_change_returns_to_the_payer_in_the_declared_slot() {
        let change = NativeChange { slot: 0, secret: 0x777, amount: 1500 };
        let (owners, amounts) = native_change_outputs(
            classes(true),
            [0x90, 0x91, 0x92, 0x93, 0x94],
            OWNER,
            change,
            absent_relay(),
        );
        assert(owners == [owner_commitment(OWNER, 0x777), 0x91, 0x92, 0x93, 0x94]);
        assert(amounts == [1500, 0, 0, 0, 0]);
    }

    #[test]
    fn test_relay_output_keeps_its_owner_without_change() {
        let change = NativeChange { slot: 0, secret: 0, amount: 0 };
        let relay = NativeRelayOutput { slot: 0, amount: 500 };
        let (owners, amounts) =
            native_change_outputs(classes(true), [0xabc, 0, 0, 0, 0], OWNER, change, relay);
        assert(owners == [0xabc, 0, 0, 0, 0]);
        assert(amounts == [500, 0, 0, 0, 0]);
    }

    #[test]
    fn test_accepts_zero_change_with_no_native_output() {
        let (owners, amounts) = native_change_outputs(
            classes(false),
            [0x90, 0x91, 0x92, 0x93, 0x94],
            OWNER,
            NativeChange { slot: 0, secret: 0, amount: 0 },
            absent_relay(),
        );
        assert(owners == [0x90, 0x91, 0x92, 0x93, 0x94]);
        assert(amounts == [0, 0, 0, 0, 0]);
    }

    #[test(should_fail_with = "change slot must hold a native output")]
    fn test_rejects_change_in_a_slot_that_is_not_native() {
        let _ = native_change_outputs(
            classes(false),
            [0; 5],
            OWNER,
            NativeChange { slot: 0, secret: 0x777, amount: 1500 },
            absent_relay(),
        );
    }

    // Conservation counts the relay amount, so it must land in a NATIVE output.
    #[test(should_fail_with = "relay slot must hold a native output")]
    fn test_rejects_relay_in_a_slot_that_is_not_native() {
        let _ = native_change_outputs(
            classes(true),
            [0; 5],
            OWNER,
            NativeChange { slot: 0, secret: 0, amount: 0 },
            NativeRelayOutput { slot: 1, amount: 500 },
        );
    }

    #[test]
    fn test_private_relay_fee_is_funded_by_native_inputs() {
        assert_native_fee_conservation(100, 0, 60, 40);
    }

    #[test(should_fail_with = "native inputs must equal native outputs plus the open fee")]
    fn test_rejects_underfunded_private_relay_fee() {
        assert_native_fee_conservation(100, 0, 60, 41);
    }

    // A zero change secret is the payer's choice: the change still opens to
    // the payer, under a guessable owner commitment.
    #[test]
    fn test_accepts_change_under_a_zero_secret() {
        let change = NativeChange { slot: 0, secret: 0, amount: 1500 };
        let (owners, _) =
            native_change_outputs(classes(true), [0; 5], OWNER, change, absent_relay());
        assert(owners[0] == owner_commitment(OWNER, 0));
    }

    // A NATIVE output that is neither the change nor the relay note gets a zero
    // amount, which output_bodies rejects.
    #[test(should_fail_with = "real output amount must be nonzero")]
    fn test_rejects_a_native_output_without_change() {
        pay_without_inputs(
            classes(true),
            NativeChange { slot: 0, secret: 0, amount: 0 },
            absent_relay(),
        );
    }

    #[test(should_fail_with = "real output amount must be nonzero")]
    fn test_rejects_a_native_output_in_another_slot() {
        let mut output_slot_classes = classes(true);
        output_slot_classes[1] = SLOT_CLASS_NATIVE;
        pay_without_inputs(
            output_slot_classes,
            NativeChange { slot: 1, secret: 0x777, amount: 1500 },
            absent_relay(),
        );
    }

    // A fee payment has no asset ID, so output_bodies rejects an ASSET output.
    #[test(should_fail_with = "asset ID must be nonzero for an asset slot")]
    fn test_rejects_an_asset_output() {
        let mut output_slot_classes = classes(false);
        output_slot_classes[0] = SLOT_CLASS_ASSET;
        pay_without_inputs(
            output_slot_classes,
            NativeChange { slot: 1, secret: 0, amount: 0 },
            absent_relay(),
        );
    }

    fn fee_payment_fixture() -> (PrivateValueChoices<4, 5>, AccountOpening, Note) {
        let payer =
            AccountOpening { address: OWNER, nk: 0x0b2, entry: 0x0b4, authorization: 0x0b5 };
        let choices = PrivateValueChoices {
            open_fee_amount: 200,
            issuance_owner_commitment: 0,
            not_before_timestamp: 0,
            valid_until_timestamp: 2000000000,
            carrier_context_hash: 0,
            asset_burn_amount: 0,
            delivery_commitment: 0x61,
            input_slot_classes: [
                SLOT_CLASS_NATIVE,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
            ],
            output_slot_classes: classes(true),
        };
        (
            choices, payer,
            Note { owner: payer.address, note_secret: 0x5ec, asset_id: 0, amount: 1000 },
        )
    }

    // A fee payment spending the fixture's one native note of 1000.
    fn pay_from_note(
        choices: PrivateValueChoices<4, 5>,
        change: NativeChange,
        relay: NativeRelayOutput,
    ) -> PrivateValue<4, 5, 0> {
        let (_, payer, note) = fee_payment_fixture();
        let (witness, root) = single_note_opening(note);
        let mut inputs = [
            InputNoteWitness {
                output_index: 0,
                note_secret: 0,
                amount: 0,
                siblings: [0; MERKLE_DEPTH],
            }; 4
        ];
        inputs[0] = witness;
        let (value, _) = native_fee_payment(
            choices,
            payer,
            root,
            inputs,
            0xaaa,
            [0; 5],
            [0, 2, 3, 4, 5],
            change,
            relay,
        );
        value
    }

    #[test]
    fn test_fee_payment_derives_its_private_value() {
        let (choices, payer, note) = fee_payment_fixture();
        let value = pay_from_note(
            choices,
            NativeChange { slot: 0, secret: 0x777, amount: 800 },
            absent_relay(),
        );
        let leaf = full_output_commitment(note, 0);
        assert(value.input_commitments == [leaf, 0, 0, 0]);
        assert(value.nullifiers[0] == nullifier(leaf, payer.nk, 0x5ec));
        assert(value.nullifiers[3] == dummy_nullifier(0xaaa, 3));
        assert(
            value.output_body_commitments[0]
                == note_body_commitment(owner_commitment(payer.address, 0x777), 0, 800),
        );
    }

    // The note pays the open fee, change in slot 0 and a relay note in slot 1:
    // 1000 = 200 + 700 + 100.
    fn change_and_relay() -> (PrivateValueChoices<4, 5>, NativeChange, NativeRelayOutput) {
        let (mut choices, _, _) = fee_payment_fixture();
        choices.output_slot_classes[1] = SLOT_CLASS_NATIVE;
        (
            choices, NativeChange { slot: 0, secret: 0x777, amount: 700 },
            NativeRelayOutput { slot: 1, amount: 100 },
        )
    }

    #[test]
    fn test_fee_payment_pays_change_and_a_relay_note() {
        let (choices, change, relay) = change_and_relay();
        let value = pay_from_note(choices, change, relay);
        assert(value.output_body_commitments[1] == note_body_commitment(0, 0, 100));
    }

    // A balanced payment with a third NATIVE output: that output gets a zero
    // amount, which output_bodies rejects.
    #[test(should_fail_with = "real output amount must be nonzero")]
    fn test_fee_payment_rejects_a_native_output_beside_change_and_relay() {
        let (mut choices, change, relay) = change_and_relay();
        choices.output_slot_classes[2] = SLOT_CLASS_NATIVE;
        let _ = pay_from_note(choices, change, relay);
    }

    #[test(should_fail_with = "relay and change slots must differ")]
    fn test_fee_payment_rejects_change_and_relay_in_one_slot() {
        let (mut choices, change, mut relay) = change_and_relay();
        choices.output_slot_classes[1] = SLOT_CLASS_DUMMY;
        relay.slot = change.slot;
        let _ = pay_from_note(choices, change, relay);
    }

    // Conservation holds in the field, 1000 = 1001 + (p - 1), but the change
    // amount is not a 128-bit amount. output_bodies range-checks the amount in
    // the change slot.
    #[test(should_fail)]
    fn test_fee_payment_rejects_a_wrapped_change_amount() {
        let (mut choices, _, _) = fee_payment_fixture();
        choices.open_fee_amount = 1001;
        let _ = pay_from_note(
            choices,
            NativeChange { slot: 0, secret: 0x777, amount: -1 },
            absent_relay(),
        );
    }

    // The same with the relay amount, range-checked in the relay slot.
    #[test(should_fail)]
    fn test_fee_payment_rejects_a_wrapped_relay_amount() {
        let (mut choices, _, _) = fee_payment_fixture();
        choices.open_fee_amount = 1001;
        let _ = pay_from_note(
            choices,
            NativeChange { slot: 1, secret: 0, amount: 0 },
            NativeRelayOutput { slot: 0, amount: -1 },
        );
    }

    #[test(should_fail_with = "fee payment input must be native or dummy")]
    fn test_fee_payment_rejects_a_marker() {
        let (mut choices, payer, _) = fee_payment_fixture();
        choices.input_slot_classes[0] = SLOT_CLASS_APPLICATION;
        choices.output_slot_classes = classes(false);
        choices.open_fee_amount = 0;
        let inputs = [
            InputNoteWitness {
                output_index: 0,
                note_secret: 0,
                amount: 0,
                siblings: [0; MERKLE_DEPTH],
            }; 4
        ];
        let _: (PrivateValue<4, 5, 0>, Field) = native_fee_payment(
            choices,
            payer,
            0,
            inputs,
            0xaaa,
            [0; 5],
            [1, 2, 3, 4, 5],
            NativeChange { slot: 0, secret: 0, amount: 0 },
            absent_relay(),
        );
    }
}
