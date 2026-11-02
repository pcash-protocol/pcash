// Shared relation fragments for the semantic value rules.
//
// Every value rule proves the same three things about the parts of a
// transaction its message does not name: that no marker class smuggles in a
// state effect the signer cannot see, that the signed asset namespace matches
// the notes the kernel authenticated, and that undisplayed real outputs return
// to the owner under a secret the owner can recompute. Sharing the source keeps
// those checks identical across rules without sharing a verification key.

use crate::payout::{note_secret, note_secret_seed};
use pcash_protocol::ledger::note::{
    note_body_commitment, note_nk, output_commitment, owner_commitment,
};
use pcash_protocol::ledger::private_value::{
    PrivateValue, SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET, SLOT_CLASS_ASSET_CREATION,
    SLOT_CLASS_NATIVE,
};
use pcash_protocol::primitives::range::{assert_address, assert_amount};

/// One input commitment binds a full burn's signed namespace when no asset
/// output can do so. The kernel already proves input ownership and amounts.
pub struct AssetNamespaceOpening {
    pub owner_commitment: Field,
    pub amount: Field,
    pub output_index: Field,
}

/// Reject both marker classes.
///
/// An application marker is durable state this rule cannot display, and a
/// creation marker mints units the message has no field for. Neither may be
/// authorized by falling through a permissive branch.
pub fn assert_ordinary_value_inputs<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
) {
    for i in 0..N_IN {
        let class = private_value.input_slot_classes[i];
        assert(class != SLOT_CLASS_APPLICATION, "input slot must not be an application marker");
        assert(class != SLOT_CLASS_ASSET_CREATION, "input slot must not be a creation marker");
    }
}

/// Bind the signed namespace for a full burn. Every asset output is opened
/// under `asset_id` by the output relation; when there are none, open just the
/// first asset input commitment. The kernel authenticates that same commitment
/// and enforces one namespace across all asset inputs and outputs. Its account
/// binding already proves ownership, so this witness needs no owner secret.
pub fn assert_asset_namespace<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    asset_id: Field,
    has_asset_output: bool,
    opening: AssetNamespaceOpening,
) {
    if (private_value.asset_burn_amount != 0) & !has_asset_output {
        let mut first_asset_commitment = 0;
        for i in 0..N_IN {
            if (private_value.input_slot_classes[i] == SLOT_CLASS_ASSET)
                & (first_asset_commitment == 0) {
                first_asset_commitment = private_value.input_commitments[i];
            }
        }
        // Positive burn and kernel conservation require an asset input. The
        // kernel opens its commitment from a note, so it is never the zero this
        // search starts from.
        assert(
            first_asset_commitment
                == output_commitment(
                    note_body_commitment(opening.owner_commitment, asset_id, opening.amount),
                    opening.output_index,
                ),
            "first asset input must open in the signed asset",
        );
    }
}

/// The secret every owner-change output carries: the owner's implicit note
/// secret for this transaction and slot with zero entropy, which the owner
/// recomputes from `nk_root` and every published nullifier. It binds change to
/// the owner. The amount is a witness: each relation that admits change fixes
/// how many change notes there are and what each holds, so the owner can
/// recompute the amounts as well.
pub fn owner_change_note_secret<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    nk_root: Field,
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    index: u32,
) -> Field {
    note_secret::<N_IN, N_OUT, SHAPE>(
        note_secret_seed(note_nk(nk_root)),
        private_value.nullifiers,
        index as Field,
        0,
    )
}

/// Prove one undisplayed real output returns to `owner`, the owner's address,
/// under `asset_id` with the owner-recoverable secret. Callers pass the asset
/// ID of the slot's class: zero for a native slot, the action's asset for an
/// asset slot. The kernel bounds a real output's amount and rejects zero, and
/// this body binds `amount` to it.
pub fn assert_owner_change<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    index: u32,
    owner: Field,
    nk_root: Field,
    asset_id: Field,
    amount: Field,
) {
    let note_secret_value = owner_change_note_secret(nk_root, private_value, index);
    assert(
        private_value.output_body_commitments[index]
            == note_body_commitment(owner_commitment(owner, note_secret_value), asset_id, amount),
        "owner change must return to the owner under the derived secret",
    );
}

/// One account's native fee contribution: every native output is either the
/// signed relay note, exactly once when the relay amount is nonzero, or owner
/// change under the owner's derived secret, exactly once when the change
/// amount is nonzero. Other output classes are left to the caller and the
/// kernel. The relay note is matched by its body, not by a slot: in a
/// sponsored transfer the contract's rule owns the output layout. Without a
/// signed relay, the kernel's relay slot would otherwise be a second change
/// note, so the change could be split in two.
pub fn assert_native_fee_outputs<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    owner: Field,
    nk_root: Field,
    relay_fee_amount: Field,
    relay_fee_owner_commitment: Field,
    native_change_amount: Field,
) {
    assert_relay_terms(private_value, relay_fee_amount, relay_fee_owner_commitment);
    let relay_body = note_body_commitment(relay_fee_owner_commitment, 0, relay_fee_amount);
    let mut relay_count: u32 = 0;
    let mut change_count: u32 = 0;
    for i in 0..N_OUT {
        if private_value.output_slot_classes[i] == SLOT_CLASS_NATIVE {
            if (relay_fee_amount != 0) & (private_value.output_body_commitments[i] == relay_body) {
                relay_count += 1;
            } else {
                assert_owner_change(private_value, i, owner, nk_root, 0, native_change_amount);
                change_count += 1;
            }
        }
    }
    assert(
        relay_count == (if relay_fee_amount == 0 { 0 } else { 1 }),
        "relay fee must pay exactly one relay output",
    );
    assert(
        change_count == (if native_change_amount == 0 { 0 } else { 1 }),
        "native change must be exactly one owner change output",
    );
}

pub struct OutputDeclaration {
    pub recipient: Field,
    pub amount: Field,
    pub asset_id: Field,
}

/// The signed relay terms: either no relay note, or one positive native note
/// to the signed owner commitment, which replaces the open fee.
pub fn assert_relay_terms<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    relay_fee_amount: Field,
    relay_fee_owner_commitment: Field,
) {
    if relay_fee_amount == 0 {
        assert(
            relay_fee_owner_commitment == 0,
            "relay owner commitment must be zero without a relay fee",
        );
    } else {
        assert_amount(relay_fee_amount);
        assert(private_value.open_fee_amount == 0, "open fee must be zero with a private relay");
    }
}

/// The largest amount one note holds.
pub global MAX_NOTE_AMOUNT: Field = 0xffffffffffffffffffffffffffffffff;

/// Every output slot of a value rule: a declared payment, the signed relay
/// note in the last slot, owner change, or padding. Returns whether any slot
/// is an asset output.
///
/// Owner change has one split per namespace: every change note but the last,
/// in slot order, holds the largest note amount. The amounts then follow from
/// the total, which is the spent notes, plus the signed initial supply for
/// asset creation, less the signed outflows, so the software that builds the
/// transaction cannot choose amounts the owner cannot recompute.
pub fn assert_output_declarations<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    owner: Field,
    nk_root: Field,
    asset_id: Field,
    outputs: [OutputDeclaration; N_OUT],
    relay_fee_amount: Field,
    relay_fee_owner_commitment: Field,
    output_note_secrets: [Field; N_OUT],
    owner_change_amounts: [Field; N_OUT],
) -> bool {
    let mut has_asset_output = false;
    let mut last_native_change = 0;
    let mut last_asset_change = 0;
    for i in 0..N_OUT {
        let is_asset = private_value.output_slot_classes[i] == SLOT_CLASS_ASSET;
        has_asset_output |= is_asset;
        assert_value_output(
            private_value,
            i,
            owner,
            nk_root,
            asset_id,
            outputs[i],
            relay_fee_amount,
            relay_fee_owner_commitment,
            output_note_secrets[i],
            owner_change_amounts[i],
        );
        // Only an owner-change slot has a nonzero change amount.
        let change = owner_change_amounts[i];
        if change != 0 {
            let earlier = if is_asset {
                last_asset_change
            } else {
                last_native_change
            };
            assert(
                (earlier == 0) | (earlier == MAX_NOTE_AMOUNT),
                "owner change before the last must hold the largest note amount",
            );
            if is_asset {
                last_asset_change = change;
            } else {
                last_native_change = change;
            }
        }
    }
    has_asset_output
}

/// The authoritative directed-payment, relay, and owner-change relation.
/// Callers choose the slot roles; a nonzero relay fee takes the last slot, as
/// in every value rule. The kernel authenticates the private-value commitment
/// and enforces note validity and value conservation.
pub fn assert_value_output<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    i: u32,
    owner: Field,
    nk_root: Field,
    asset_id: Field,
    declaration: OutputDeclaration,
    relay_fee_amount: Field,
    relay_fee_owner_commitment: Field,
    output_note_secret: Field,
    owner_change_amount: Field,
) {
    let is_relay = (i == N_OUT - 1) & (relay_fee_amount != 0);
    let slot_class = private_value.output_slot_classes[i];
    let is_native = slot_class == SLOT_CLASS_NATIVE;
    let is_asset = slot_class == SLOT_CLASS_ASSET;
    if is_relay {
        assert(declaration.recipient == 0, "relay slot declaration must be all-zero");
        assert(declaration.amount == 0, "relay slot declaration must be all-zero");
        assert(declaration.asset_id == 0, "relay slot declaration must be all-zero");
        assert(owner_change_amount == 0, "relay slot owner change amount must be zero");
        assert(is_native, "relay slot must hold a native output");
        assert(
            private_value.output_body_commitments[i]
                == note_body_commitment(relay_fee_owner_commitment, 0, relay_fee_amount),
            "relay output must pay the relay fee to the relay owner",
        );
    } else if declaration.recipient == 0 {
        assert(declaration.amount == 0, "undeclared slot must be all-zero");
        assert(declaration.asset_id == 0, "undeclared slot must be all-zero");
        if is_native | is_asset {
            // The kernel builds an ASSET body under its nonzero asset ID, which
            // the owner-change body binds to `asset_id`.
            let change_asset = if is_asset { asset_id } else { 0 };
            assert_owner_change(
                private_value,
                i,
                owner,
                nk_root,
                change_asset,
                owner_change_amount,
            );
        } else {
            assert(owner_change_amount == 0, "dummy slot owner change amount must be zero");
        }
    } else {
        // The kernel takes a real output's owner commitment as given, so this is
        // what keeps the signed recipient an address.
        assert_address(declaration.recipient);
        // The slot is real: the kernel bounds its amount and rejects zero, and
        // the body below binds `declaration.amount` to it.
        assert(owner_change_amount == 0, "declared slot owner change amount must be zero");
        if declaration.asset_id == 0 {
            assert(is_native, "declared native output must use a native slot");
        } else {
            assert(
                declaration.asset_id == asset_id,
                "declared output asset ID must equal the signed asset ID",
            );
            assert(is_asset, "declared asset output must use an asset slot");
        }
        assert(
            private_value.output_body_commitments[i]
                == note_body_commitment(
                    owner_commitment(declaration.recipient, output_note_secret),
                    declaration.asset_id,
                    declaration.amount,
                ),
            "declared output must match its declaration",
        );
    }
}
