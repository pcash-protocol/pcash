// Test fixtures shared by the escrow library and its function packages.

use pcash_protocol::generated::private_value_profiles::{S_INPUTS, S_OUTPUTS};
use pcash_protocol::ledger::note::{full_output_commitment, note_body_commitment};
use pcash_protocol::ledger::private_value::{
    delivery_commitment, SLOT_CLASS_ASSET, SLOT_CLASS_DUMMY, SLOT_CLASS_NATIVE, SmallPrivateValue,
};
use pcash_protocol::primitives::types::Note;

pub global ESCROW_OUTPUT_INDEX: Field = 7;

/// The output data hashes, one distinct value per slot, and the arena hash a
/// release's delivery commitment opens to.
pub fn release_output_data_hashes() -> [Field; S_OUTPUTS] {
    let mut hashes = [0; S_OUTPUTS];
    for i in 0..S_OUTPUTS {
        hashes[i] = 0x61 + i as Field;
    }
    hashes
}
pub global RELEASE_ARENA_HASH: Field = 0x66;

/// A 100-unit escrow note in `asset_id`; 0 is native PCASH.
pub fn sample_escrow_note(asset_id: Field) -> Note {
    Note { owner: 0x11, note_secret: 0x22, asset_id, amount: 100 }
}

/// A release that spends `escrow_note` in input slot 0 and pays `payout_amount`
/// of its asset to `payout_owner_commitment` in output slot 0. Every other slot
/// is a dummy.
pub fn release_transaction(
    escrow_note: Note,
    escrow_output_index: Field,
    payout_owner_commitment: Field,
    payout_amount: Field,
    open_fee_amount: Field,
) -> SmallPrivateValue {
    let value_class = if escrow_note.asset_id == 0 {
        SLOT_CLASS_NATIVE
    } else {
        SLOT_CLASS_ASSET
    };
    let mut input_slot_classes = [SLOT_CLASS_DUMMY; S_INPUTS];
    let mut input_commitments = [0; S_INPUTS];
    let mut nullifiers = [0; S_INPUTS];
    for i in 0..S_INPUTS {
        nullifiers[i] = (i + 1) as Field;
    }
    input_slot_classes[0] = value_class;
    input_commitments[0] = full_output_commitment(escrow_note, escrow_output_index);
    let mut output_slot_classes = [SLOT_CLASS_DUMMY; S_OUTPUTS];
    let mut output_body_commitments = [1; S_OUTPUTS];
    output_slot_classes[0] = value_class;
    output_body_commitments[0] =
        note_body_commitment(payout_owner_commitment, escrow_note.asset_id, payout_amount);
    SmallPrivateValue {
        open_fee_amount,
        issuance_owner_commitment: 0,
        not_before_timestamp: 0,
        valid_until_timestamp: 1,
        carrier_context_hash: 0,
        asset_burn_amount: 0,
        delivery_commitment: delivery_commitment(release_output_data_hashes(), RELEASE_ARENA_HASH),
        account_creation_commitment: 0,
        input_slot_classes,
        input_commitments,
        nullifiers,
        output_slot_classes,
        output_body_commitments,
    }
}

/// A separate fee payer's native input in the last input slot and its native
/// change in the last output slot. None of it is visible to the escrow rule.
pub fn with_sponsor_slots(private_value: SmallPrivateValue) -> SmallPrivateValue {
    let mut sponsored = private_value;
    sponsored.input_slot_classes[S_INPUTS - 1] = SLOT_CLASS_NATIVE;
    sponsored.input_commitments[S_INPUTS - 1] = 0x5151;
    sponsored.output_slot_classes[S_OUTPUTS - 1] = SLOT_CLASS_NATIVE;
    sponsored
}
