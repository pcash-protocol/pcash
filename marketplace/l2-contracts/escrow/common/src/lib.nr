// The escrow release relation shared by the claim and reclaim functions.
//
// Both functions spend the escrow note in input slot 0 and pay it out in output
// slot 0. A native escrow releases in the transfer role and may fund an open
// fee and a private relay output in slot 1 from its own value;
// `relay_fee_amount` and `relay_fee_owner_commitment` describe only that
// escrow-funded relay output. A token escrow pays out its complete value and
// funds no fee, so both are zero: in the transfer role every other slot is a
// dummy, and in the sponsored role the remaining slots may also hold the fee
// payer's native inputs, change, and the fee payer's own relay output, which
// the sponsored-transfer kernel and the payer's own rule govern.

pub mod test_support;

use pcash_protocol::generated::private_value_profiles::{S_INPUTS, S_OUTPUTS};
use pcash_protocol::ledger::note::{full_output_commitment, note_body_commitment};
use pcash_protocol::ledger::private_value::{
    SLOT_CLASS_ASSET, SLOT_CLASS_DUMMY, SLOT_CLASS_NATIVE, SmallPrivateValue,
};
use pcash_protocol::primitives::types::Note;
use reference_rule_common::value_rule::assert_relay_terms;

/// Release `escrow_note`, the note the calling function built from what it
/// knows, to `payout_owner_commitment`. Returns the escrow note's output
/// commitment and the payout amount.
pub fn assert_escrow_release(
    private_value: SmallPrivateValue,
    fee_paid: bool,
    escrow_note: Note,
    escrow_output_index: Field,
    payout_owner_commitment: Field,
    relay_fee_amount: Field,
    relay_fee_owner_commitment: Field,
) -> (Field, Field) {
    let asset_id = escrow_note.asset_id;
    let native = asset_id == 0;
    // Contract-owned native value stays in the transfer role (spec §11.5).
    assert(!(native & fee_paid), "native escrow release must not be sponsored");
    let value_class = if native {
        SLOT_CLASS_NATIVE
    } else {
        SLOT_CLASS_ASSET
    };
    assert(private_value.input_slot_classes[0] == value_class, "escrow must use input 0");
    // Only a separate fee payer contributes native inputs and receives native change.
    for i in 1..S_INPUTS {
        let class = private_value.input_slot_classes[i];
        assert(
            (class == SLOT_CLASS_DUMMY) | (fee_paid & (class == SLOT_CLASS_NATIVE)),
            "non-escrow input must be dummy or the fee payer's native input",
        );
    }
    assert(private_value.output_slot_classes[0] == value_class, "payout must use output 0");
    for i in 1..S_OUTPUTS {
        let class = private_value.output_slot_classes[i];
        if (i == 1) & (relay_fee_amount != 0) {
            assert(class == SLOT_CLASS_NATIVE, "relay slot must hold a native output");
        } else {
            assert(
                (class == SLOT_CLASS_DUMMY) | (fee_paid & (class == SLOT_CLASS_NATIVE)),
                "non-payout output must be dummy or the fee payer's native output",
            );
        }
    }

    let escrow_commitment = full_output_commitment(escrow_note, escrow_output_index);
    assert(
        private_value.input_commitments[0] == escrow_commitment,
        "escrow input must open the escrow note",
    );
    assert_relay_terms(private_value, relay_fee_amount, relay_fee_owner_commitment);
    if relay_fee_amount != 0 {
        assert(native, "token escrow must not fund a relay payment from its value");
        assert(
            private_value.output_body_commitments[1]
                == note_body_commitment(relay_fee_owner_commitment, 0, relay_fee_amount),
            "relay output must pay the relay fee to the relay owner",
        );
    }
    // All-or-nothing release: the payout is the whole escrow note less the
    // escrow-funded network fees. Only native escrow value pays the open fee; a
    // token escrow is paid out in full, so the kernel's asset conservation
    // leaves it no burn, and a native escrow has no asset input to burn.
    let escrow_open_fee = if native {
        private_value.open_fee_amount
    } else {
        0
    };
    // Every term is a note amount: the kernel bounds the opened escrow input,
    // the caller's private-value commitment bounds the open fee, and
    // `assert_relay_terms` bounds the relay fee. The kernel builds the payout
    // body from a nonzero amount of the same width, so a difference that wraps
    // below zero opens no payout.
    let payout_amount = escrow_note.amount - relay_fee_amount - escrow_open_fee;
    assert(
        private_value.output_body_commitments[0]
            == note_body_commitment(payout_owner_commitment, asset_id, payout_amount),
        "payout output must pay the payout owner",
    );
    (escrow_commitment, payout_amount)
}

mod tests {
    use super::assert_escrow_release;
    use super::test_support::{
        ESCROW_OUTPUT_INDEX, release_transaction, sample_escrow_note, with_sponsor_slots,
    };
    use pcash_protocol::generated::private_value_profiles::{S_INPUTS, S_OUTPUTS};
    use pcash_protocol::ledger::note::{note_body_commitment, owner_commitment};
    use pcash_protocol::ledger::private_value::{
        SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET, SLOT_CLASS_NATIVE, SmallPrivateValue,
    };
    use pcash_protocol::primitives::types::Note;

    global TOKEN: Field = 9;
    global PAYOUT_OWNER: Field = 0x33;
    global PAYOUT_SECRET: Field = 0x44;
    global RELAY_OWNER: Field = 0xabc;
    global ISSUANCE_OWNER: Field = 0xdef;

    fn payout_owner_commitment() -> Field {
        owner_commitment(PAYOUT_OWNER, PAYOUT_SECRET)
    }

    // A native escrow of 100 pays 90 and a 10-unit open fee; a token escrow pays 100.
    fn native_release() -> SmallPrivateValue {
        release_transaction(
            sample_escrow_note(0),
            ESCROW_OUTPUT_INDEX,
            payout_owner_commitment(),
            90,
            10,
        )
    }

    fn token_release() -> SmallPrivateValue {
        release_transaction(
            sample_escrow_note(TOKEN),
            ESCROW_OUTPUT_INDEX,
            payout_owner_commitment(),
            100,
            0,
        )
    }

    fn release(private_value: SmallPrivateValue, fee_paid: bool, escrow: Note) -> Field {
        let (_, payout_amount) = assert_escrow_release(
            private_value,
            fee_paid,
            escrow,
            ESCROW_OUTPUT_INDEX,
            payout_owner_commitment(),
            0,
            0,
        );
        payout_amount
    }

    // A native escrow of 100 pays 99 and a private relay output of 1 in slot 1.
    fn relayed_native_release(open_fee_amount: Field, payout_amount: Field) -> SmallPrivateValue {
        let mut private_value = release_transaction(
            sample_escrow_note(0),
            ESCROW_OUTPUT_INDEX,
            payout_owner_commitment(),
            payout_amount,
            open_fee_amount,
        );
        private_value.issuance_owner_commitment = ISSUANCE_OWNER;
        private_value.output_slot_classes[1] = SLOT_CLASS_NATIVE;
        private_value.output_body_commitments[1] = note_body_commitment(RELAY_OWNER, 0, 1);
        private_value
    }

    fn relayed_release(private_value: SmallPrivateValue, fee_paid: bool, escrow: Note) -> Field {
        let (_, payout_amount) = assert_escrow_release(
            private_value,
            fee_paid,
            escrow,
            ESCROW_OUTPUT_INDEX,
            payout_owner_commitment(),
            1,
            RELAY_OWNER,
        );
        payout_amount
    }

    #[test]
    fn test_release_returns_the_escrow_commitment_and_payout_amount() {
        let private_value = native_release();
        let (escrow_commitment, payout_amount) = assert_escrow_release(
            private_value,
            false,
            sample_escrow_note(0),
            ESCROW_OUTPUT_INDEX,
            payout_owner_commitment(),
            0,
            0,
        );
        assert(escrow_commitment == private_value.input_commitments[0]);
        assert(payout_amount == 90);
    }

    #[test]
    fn test_native_release_accepts_zero_fee() {
        let private_value = release_transaction(
            sample_escrow_note(0),
            ESCROW_OUTPUT_INDEX,
            payout_owner_commitment(),
            100,
            0,
        );
        assert(release(private_value, false, sample_escrow_note(0)) == 100);
    }

    #[test(should_fail_with = "payout output must pay the payout owner")]
    fn test_native_release_rejects_leftover_escrow_value() {
        let private_value = release_transaction(
            sample_escrow_note(0),
            ESCROW_OUTPUT_INDEX,
            payout_owner_commitment(),
            89,
            10,
        );
        let _ = release(private_value, false, sample_escrow_note(0));
    }

    #[test]
    fn test_native_release_accepts_private_relay_output() {
        assert(relayed_release(relayed_native_release(0, 99), false, sample_escrow_note(0)) == 99);
    }

    #[test(should_fail_with = "open fee must be zero with a private relay")]
    fn test_native_release_rejects_private_relay_with_open_fee() {
        let _ = relayed_release(relayed_native_release(10, 89), false, sample_escrow_note(0));
    }

    #[test(should_fail_with = "native escrow release must not be sponsored")]
    fn test_native_release_rejects_sponsored_role() {
        let _ = release(native_release(), true, sample_escrow_note(0));
    }

    #[test(should_fail_with = "escrow input must open the escrow note")]
    fn test_release_rejects_another_escrow_note() {
        let mut escrow = sample_escrow_note(0);
        escrow.note_secret += 1;
        let _ = release(native_release(), false, escrow);
    }

    #[test(should_fail_with = "non-escrow input must be dummy or the fee payer's native input")]
    fn test_native_release_rejects_second_native_input() {
        let mut private_value = native_release();
        private_value.input_slot_classes[S_INPUTS - 1] = SLOT_CLASS_NATIVE;
        private_value.input_commitments[S_INPUTS - 1] = 0x99;
        let _ = release(private_value, false, sample_escrow_note(0));
    }

    #[test(should_fail_with = "non-payout output must be dummy or the fee payer's native output")]
    fn test_native_release_rejects_second_native_output() {
        let mut private_value = native_release();
        private_value.output_slot_classes[S_OUTPUTS - 1] = SLOT_CLASS_NATIVE;
        let _ = release(private_value, false, sample_escrow_note(0));
    }

    // A payout to address 0, where no account exists, burns it. The claimant
    // or the signing seller chooses the payout owner.
    #[test]
    fn test_native_release_accepts_a_payout_to_address_zero() {
        let burned = owner_commitment(0, PAYOUT_SECRET);
        let private_value =
            release_transaction(sample_escrow_note(0), ESCROW_OUTPUT_INDEX, burned, 90, 10);
        let _ = assert_escrow_release(
            private_value,
            false,
            sample_escrow_note(0),
            ESCROW_OUTPUT_INDEX,
            burned,
            0,
            0,
        );
    }

    #[test]
    fn test_token_release_accepts_transfer_role() {
        assert(release(token_release(), false, sample_escrow_note(TOKEN)) == 100);
    }

    #[test]
    fn test_token_release_accepts_sponsored_native_slots() {
        let _ = release(
            with_sponsor_slots(token_release()),
            true,
            sample_escrow_note(TOKEN),
        );
    }

    #[test(should_fail_with = "non-escrow input must be dummy or the fee payer's native input")]
    fn test_token_release_rejects_native_input_in_transfer_role() {
        let _ = release(
            with_sponsor_slots(token_release()),
            false,
            sample_escrow_note(TOKEN),
        );
    }

    #[test(should_fail_with = "non-payout output must be dummy or the fee payer's native output")]
    fn test_token_release_rejects_native_output_in_transfer_role() {
        let mut private_value = token_release();
        private_value.output_slot_classes[S_OUTPUTS - 1] = SLOT_CLASS_NATIVE;
        let _ = release(private_value, false, sample_escrow_note(TOKEN));
    }

    #[test(should_fail_with = "non-escrow input must be dummy or the fee payer's native input")]
    fn test_token_release_rejects_second_asset_input() {
        let mut private_value = with_sponsor_slots(token_release());
        private_value.input_slot_classes[S_INPUTS - 1] = SLOT_CLASS_ASSET;
        let _ = release(private_value, true, sample_escrow_note(TOKEN));
    }

    #[test(should_fail_with = "non-escrow input must be dummy or the fee payer's native input")]
    fn test_token_release_rejects_application_marker() {
        let mut private_value = with_sponsor_slots(token_release());
        private_value.input_slot_classes[S_INPUTS - 1] = SLOT_CLASS_APPLICATION;
        private_value.input_commitments[S_INPUTS - 1] = 0;
        let _ = release(private_value, true, sample_escrow_note(TOKEN));
    }

    #[test(should_fail_with = "non-payout output must be dummy or the fee payer's native output")]
    fn test_token_release_rejects_second_asset_output() {
        let mut private_value = with_sponsor_slots(token_release());
        private_value.output_slot_classes[S_OUTPUTS - 1] = SLOT_CLASS_ASSET;
        let _ = release(private_value, true, sample_escrow_note(TOKEN));
    }

    // The sponsor pays the open fee; a token escrow is still paid out in full.
    #[test(should_fail_with = "payout output must pay the payout owner")]
    fn test_token_release_rejects_fee_from_token_value() {
        let private_value = with_sponsor_slots(release_transaction(
            sample_escrow_note(TOKEN),
            ESCROW_OUTPUT_INDEX,
            payout_owner_commitment(),
            95,
            5,
        ));
        let _ = release(private_value, true, sample_escrow_note(TOKEN));
    }

    #[test(should_fail_with = "token escrow must not fund a relay payment from its value")]
    fn test_token_release_rejects_escrow_relay_payment() {
        let mut private_value = token_release();
        private_value.issuance_owner_commitment = ISSUANCE_OWNER;
        private_value.output_slot_classes[1] = SLOT_CLASS_NATIVE;
        private_value.output_body_commitments[1] = note_body_commitment(RELAY_OWNER, 0, 1);
        let _ = relayed_release(private_value, false, sample_escrow_note(TOKEN));
    }

    // A burn the kernel would balance: the payout plus the burn equals the
    // escrow amount. The release must pay the full amount, so it leaves the
    // kernel's asset conservation no room for a burn.
    #[test(should_fail_with = "payout output must pay the payout owner")]
    fn test_token_release_leaves_nothing_to_burn() {
        let mut private_value = release_transaction(
            sample_escrow_note(TOKEN),
            ESCROW_OUTPUT_INDEX,
            payout_owner_commitment(),
            99,
            0,
        );
        private_value.asset_burn_amount = 1;
        let _ = release(private_value, false, sample_escrow_note(TOKEN));
    }

    #[test(should_fail_with = "payout output must pay the payout owner")]
    fn test_token_release_rejects_native_payout_body() {
        let mut private_value = token_release();
        private_value.output_body_commitments[0] =
            note_body_commitment(payout_owner_commitment(), 0, 100);
        let _ = release(private_value, false, sample_escrow_note(TOKEN));
    }

    #[test(should_fail_with = "escrow must use input 0")]
    fn test_token_release_rejects_native_escrow_slot() {
        let mut private_value = token_release();
        private_value.input_slot_classes[0] = SLOT_CLASS_NATIVE;
        let _ = release(private_value, false, sample_escrow_note(TOKEN));
    }

    #[test(should_fail_with = "payout must use output 0")]
    fn test_token_release_rejects_native_payout_slot() {
        let mut private_value = token_release();
        private_value.output_slot_classes[0] = SLOT_CLASS_NATIVE;
        let _ = release(private_value, false, sample_escrow_note(TOKEN));
    }
}
