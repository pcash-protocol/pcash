// Shared authenticated snapshot and input openings. Each kernel keeps its own
// input grammar; these derive the input commitments, nullifiers and bounded note
// amounts its slots carry. Callers authenticate the accounts and conserve the
// returned amounts.

use crate::authorization::authentication::AccountOpening;
use crate::ledger::note::{application_nullifier, dummy_nullifier, open_owner_input};
use crate::ledger::private_value::{
    SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET, SLOT_CLASS_ASSET_CREATION, SLOT_CLASS_DUMMY,
    SLOT_CLASS_NATIVE,
};
use crate::primitives::params::{BLOCK_HEADER_TREE_DEPTH, STATE_TREE_DEPTH};
use crate::primitives::types::InputNoteWitness;
use crate::state::block::{
    block_header_fact, BLOCK_HEADER_KEY_STATE_ROOT, state_fact, STATE_KEY_ACCOUNT_STATE_ROOT,
    STATE_KEY_OUTPUT_ROOT, state_root_from_opening,
};

// Opens the output root under the recent block's header. Returns the state
// root the opening implies, which the header commits.
pub fn open_output_root(
    recent_pcash_block_hash: Field,
    block_header_state_siblings: [Field; BLOCK_HEADER_TREE_DEPTH],
    output_root: Field,
    state_output_siblings: [Field; STATE_TREE_DEPTH],
) -> Field {
    let state_root =
        state_root_from_opening(output_root, STATE_KEY_OUTPUT_ROOT, state_output_siblings);
    block_header_fact(
        recent_pcash_block_hash,
        BLOCK_HEADER_KEY_STATE_ROOT,
        state_root,
        block_header_state_siblings,
    );
    state_root
}

// Opens the output and account-state roots under the recent block's one state
// root.
pub fn open_value_state(
    recent_pcash_block_hash: Field,
    block_header_state_siblings: [Field; BLOCK_HEADER_TREE_DEPTH],
    output_root: Field,
    state_output_siblings: [Field; STATE_TREE_DEPTH],
    account_state_root: Field,
    state_account_siblings: [Field; STATE_TREE_DEPTH],
) {
    let state_root = open_output_root(
        recent_pcash_block_hash,
        block_header_state_siblings,
        output_root,
        state_output_siblings,
    );
    state_fact(
        state_root,
        STATE_KEY_ACCOUNT_STATE_ROOT,
        account_state_root,
        state_account_siblings,
    );
}

// The derived input slots, zero in every slot not yet derived, and the opened
// note totals. Every opened amount is nonzero and below 2^128, and there are at
// most 32 inputs, so a total is zero exactly when no note of its class opened.
pub struct OpenedInputs<let N_IN: u32> {
    pub input_commitments: [Field; N_IN],
    pub nullifiers: [Field; N_IN],
    pub native_amount: Field,
    pub asset_amount: Field,
}

fn no_inputs<let N_IN: u32>() -> OpenedInputs<N_IN> {
    OpenedInputs {
        input_commitments: [0; N_IN],
        nullifiers: [0; N_IN],
        native_amount: 0,
        asset_amount: 0,
    }
}

// An APPLICATION marker belongs to the primary account and its selected rule
// entry; the rule defines the replay ID.
pub fn application_marker(primary: AccountOpening, replay_id: Field) -> Field {
    application_nullifier(primary.address, primary.entry, replay_id)
}

// Opens every NATIVE input to the payer and leaves every other slot for the
// caller's own slot rules.
pub fn open_native_notes<let N_IN: u32>(
    input_slot_classes: [Field; N_IN],
    payer: AccountOpening,
    output_root: Field,
    native_inputs: [InputNoteWitness; N_IN],
) -> OpenedInputs<N_IN> {
    let mut result = no_inputs();
    for i in 0..N_IN {
        if input_slot_classes[i] == SLOT_CLASS_NATIVE {
            let opened =
                open_owner_input(native_inputs[i], payer.address, payer.nk, 0, output_root);
            result.input_commitments[i] = opened.input_commitment;
            result.nullifiers[i] = opened.nullifier;
            result.native_amount += opened.amount;
        }
    }
    result
}

// A transfer's inputs: DUMMY, NATIVE, ASSET, and APPLICATION. ASSET and
// APPLICATION belong to the primary, NATIVE belongs to the native payer.
// Passing the same account in both roles gives the transfer kernel's relation.
pub fn open_transfer_inputs<let N_IN: u32>(
    input_slot_classes: [Field; N_IN],
    primary: AccountOpening,
    native_payer: AccountOpening,
    output_root: Field,
    asset_id: Field,
    dummy_input_seed: Field,
    owner_inputs: [InputNoteWitness; N_IN],
    replay_ids: [Field; N_IN],
) -> OpenedInputs<N_IN> {
    let mut result = no_inputs();
    for i in 0..N_IN {
        let class = input_slot_classes[i];
        assert(class != SLOT_CLASS_ASSET_CREATION, "transfer input must not be a creation marker");
        if class == SLOT_CLASS_DUMMY {
            result.nullifiers[i] = dummy_nullifier(dummy_input_seed, i as Field);
        } else if class == SLOT_CLASS_APPLICATION {
            result.nullifiers[i] = application_marker(primary, replay_ids[i]);
        } else {
            // NATIVE or ASSET; the commitment rejects any other class.
            let is_asset = class == SLOT_CLASS_ASSET;
            let account = if is_asset { primary } else { native_payer };
            let namespace = if is_asset {
                assert(asset_id != 0, "asset ID must be nonzero for an asset slot");
                asset_id
            } else {
                0
            };
            let opened = open_owner_input(
                owner_inputs[i],
                account.address,
                account.nk,
                namespace,
                output_root,
            );
            result.input_commitments[i] = opened.input_commitment;
            result.nullifiers[i] = opened.nullifier;
            if is_asset {
                result.asset_amount += opened.amount;
            } else {
                result.native_amount += opened.amount;
            }
        }
    }
    result
}

mod tests {
    use crate::authorization::authentication::AccountOpening;
    use crate::generated::pcash_constants::STATE_COMMITMENT_DOMAIN;
    use crate::ledger::note::{dummy_nullifier, full_output_commitment, nullifier};
    use crate::ledger::note::tests::single_note_opening;
    use crate::ledger::private_value::{
        SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET, SLOT_CLASS_ASSET_CREATION, SLOT_CLASS_DUMMY,
        SLOT_CLASS_NATIVE,
    };
    use crate::primitives::hash::pcash_hash;
    use crate::primitives::params::{BLOCK_HEADER_TREE_DEPTH, MERKLE_DEPTH, STATE_TREE_DEPTH};
    use crate::primitives::types::{InputNoteWitness, Note};
    use crate::state::block::{block_hash_from_opening, BLOCK_HEADER_KEY_STATE_ROOT};
    use super::{
        application_marker, open_native_notes, open_output_root, open_transfer_inputs,
        open_value_state,
    };

    global PRIMARY: AccountOpening =
        AccountOpening { address: 0x0a1, nk: 0x0a2, entry: 0x0a4, authorization: 0x0a5 };
    global PAYER: AccountOpening =
        AccountOpening { address: 0x0b1, nk: 0x0b2, entry: 0x0b4, authorization: 0x0b5 };
    global SEED: Field = 0xaaa;
    global ASSET: Field = 0x5a;

    fn no_witnesses() -> [InputNoteWitness; 4] {
        [
            InputNoteWitness {
                output_index: 0,
                note_secret: 0,
                amount: 0,
                siblings: [0; MERKLE_DEPTH],
            }; 4
        ]
    }

    #[test]
    fn test_transfer_inputs_derive_every_slot() {
        let (witness, root) = single_note_opening(
            Note { owner: PRIMARY.address, note_secret: 0x5ec, asset_id: ASSET, amount: 9 },
        );
        let mut witnesses = no_witnesses();
        witnesses[1] = witness;
        let classes =
            [SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET, SLOT_CLASS_DUMMY, SLOT_CLASS_DUMMY];
        let inputs = open_transfer_inputs(
            classes,
            PRIMARY,
            PAYER,
            root,
            ASSET,
            SEED,
            witnesses,
            [0x7e, 0, 0, 0],
        );
        let leaf = full_output_commitment(
            Note { owner: PRIMARY.address, note_secret: 0x5ec, asset_id: ASSET, amount: 9 },
            0,
        );
        assert(inputs.input_commitments == [0, leaf, 0, 0]);
        assert(
            inputs.nullifiers
                == [
                    application_marker(PRIMARY, 0x7e),
                    nullifier(leaf, PRIMARY.nk, 0x5ec),
                    dummy_nullifier(SEED, 2),
                    dummy_nullifier(SEED, 3),
                ],
        );
        assert(inputs.asset_amount == 9);
        assert(inputs.native_amount == 0);
    }

    // NATIVE belongs to the native payer, so a primary's native note does not open.
    #[test(should_fail_with = "input note must be in the output tree")]
    fn test_transfer_native_input_opens_to_the_native_payer() {
        let (witness, root) = single_note_opening(
            Note { owner: PRIMARY.address, note_secret: 0x5ec, asset_id: 0, amount: 9 },
        );
        let mut witnesses = no_witnesses();
        witnesses[0] = witness;
        let classes = [SLOT_CLASS_NATIVE, SLOT_CLASS_DUMMY, SLOT_CLASS_DUMMY, SLOT_CLASS_DUMMY];
        let _ = open_transfer_inputs(
            classes,
            PRIMARY,
            PAYER,
            root,
            ASSET,
            SEED,
            witnesses,
            [0; 4],
        );
    }

    #[test(should_fail_with = "transfer input must not be a creation marker")]
    fn test_transfer_inputs_reject_a_creation_marker() {
        let classes =
            [SLOT_CLASS_ASSET_CREATION, SLOT_CLASS_DUMMY, SLOT_CLASS_DUMMY, SLOT_CLASS_DUMMY];
        let _ = open_transfer_inputs(
            classes,
            PRIMARY,
            PAYER,
            0,
            ASSET,
            SEED,
            no_witnesses(),
            [0; 4],
        );
    }

    // A zero seed derives ordinary padding markers. They name no account, so
    // another action with the same seed derives the same ones, and the node
    // admits only the first.
    #[test]
    fn test_transfer_inputs_accept_a_zero_dummy_seed() {
        let inputs = open_transfer_inputs(
            [SLOT_CLASS_DUMMY; 4],
            PRIMARY,
            PAYER,
            0,
            ASSET,
            0,
            no_witnesses(),
            [0; 4],
        );
        let other = open_transfer_inputs(
            [SLOT_CLASS_DUMMY; 4],
            PAYER,
            PRIMARY,
            0,
            ASSET,
            0,
            no_witnesses(),
            [0; 4],
        );
        assert(inputs.nullifiers[0] == dummy_nullifier(0, 0));
        assert(inputs.nullifiers == other.nullifiers);
    }

    // A zero replay ID is an ordinary marker scoped to the primary account
    // and its entry.
    #[test]
    fn test_transfer_inputs_accept_replay_id_zero() {
        let classes =
            [SLOT_CLASS_APPLICATION, SLOT_CLASS_DUMMY, SLOT_CLASS_DUMMY, SLOT_CLASS_DUMMY];
        let inputs = open_transfer_inputs(
            classes,
            PRIMARY,
            PAYER,
            0,
            ASSET,
            SEED,
            no_witnesses(),
            [0; 4],
        );
        assert(inputs.nullifiers[0] == application_marker(PRIMARY, 0));
        assert(inputs.nullifiers[0] != application_marker(PAYER, 0));
    }

    // A zero-secret asset note of the primary opens and nullifies like any other.
    #[test]
    fn test_transfer_inputs_open_a_zero_secret_asset_note() {
        let note = Note { owner: PRIMARY.address, note_secret: 0, asset_id: ASSET, amount: 9 };
        let (witness, root) = single_note_opening(note);
        let mut witnesses = no_witnesses();
        witnesses[0] = witness;
        let classes = [SLOT_CLASS_ASSET, SLOT_CLASS_DUMMY, SLOT_CLASS_DUMMY, SLOT_CLASS_DUMMY];
        let inputs = open_transfer_inputs(
            classes,
            PRIMARY,
            PAYER,
            root,
            ASSET,
            SEED,
            witnesses,
            [0; 4],
        );
        let leaf = full_output_commitment(note, 0);
        assert(inputs.input_commitments[0] == leaf);
        assert(inputs.nullifiers[0] == nullifier(leaf, PRIMARY.nk, 0));
        assert(inputs.asset_amount == 9);
    }

    #[test]
    fn test_native_notes_leave_other_slots_to_the_caller() {
        let note = Note { owner: PAYER.address, note_secret: 0x5ec, asset_id: 0, amount: 9 };
        let (witness, root) = single_note_opening(note);
        let mut witnesses = no_witnesses();
        witnesses[2] = witness;
        let classes = [
            SLOT_CLASS_DUMMY,
            SLOT_CLASS_APPLICATION,
            SLOT_CLASS_NATIVE,
            SLOT_CLASS_ASSET_CREATION,
        ];
        let inputs = open_native_notes(classes, PAYER, root, witnesses);
        let leaf = full_output_commitment(note, 0);
        assert(inputs.input_commitments == [0, 0, leaf, 0]);
        assert(inputs.nullifiers == [0, 0, nullifier(leaf, PAYER.nk, 0x5ec), 0]);
        assert(inputs.native_amount == 9);
    }

    global ACCOUNT_STATE_ROOT: Field = 0x0b;
    global HEADER_SIBLINGS: [Field; BLOCK_HEADER_TREE_DEPTH] = [0x21, 0x22, 0x23, 0x24];

    fn state_node(left: Field, right: Field) -> Field {
        pcash_hash([STATE_COMMITMENT_DOMAIN, left, right])
    }

    // A state tree with the output root at key 0, the account-state root at
    // key 5, and opaque subtrees elsewhere. Returns both openings and the root.
    fn state_openings(
        output_root: Field,
    ) -> ([Field; STATE_TREE_DEPTH], [Field; STATE_TREE_DEPTH], Field) {
        let keys_0_to_3 = state_node(state_node(output_root, 0x11), 0x12);
        let keys_4_to_7 = state_node(state_node(0x13, ACCOUNT_STATE_ROOT), 0x14);
        let state_root = state_node(state_node(keys_0_to_3, keys_4_to_7), 0x15);
        ([0x11, 0x12, keys_4_to_7, 0x15], [0x13, 0x14, keys_0_to_3, 0x15], state_root)
    }

    fn recent_block(state_root: Field) -> Field {
        block_hash_from_opening(state_root, BLOCK_HEADER_KEY_STATE_ROOT, HEADER_SIBLINGS)
    }

    #[test]
    fn test_value_state_opens_both_roots_under_one_state_root() {
        let (output_siblings, account_siblings, state_root) = state_openings(0x0a);
        let recent = recent_block(state_root);
        assert(open_output_root(recent, HEADER_SIBLINGS, 0x0a, output_siblings) == state_root);
        open_value_state(
            recent,
            HEADER_SIBLINGS,
            0x0a,
            output_siblings,
            ACCOUNT_STATE_ROOT,
            account_siblings,
        );
    }

    // The state root is the one the output-root opening implies, and the
    // recent header must commit it.
    #[test(should_fail_with = "block header field must be in the block header tree")]
    fn test_value_state_rejects_a_state_root_the_header_does_not_commit() {
        let (_, _, state_root) = state_openings(0x0a);
        let (output_siblings, account_siblings, _) = state_openings(0x0c);
        open_value_state(
            recent_block(state_root),
            HEADER_SIBLINGS,
            0x0c,
            output_siblings,
            ACCOUNT_STATE_ROOT,
            account_siblings,
        );
    }

    // The account-state root opens under the state root the output root
    // implies, not under another snapshot's.
    #[test(should_fail_with = "state field must be in the state tree")]
    fn test_value_state_rejects_an_account_root_of_another_state_root() {
        let (output_siblings, _, state_root) = state_openings(0x0a);
        let (_, account_siblings, _) = state_openings(0x0c);
        open_value_state(
            recent_block(state_root),
            HEADER_SIBLINGS,
            0x0a,
            output_siblings,
            ACCOUNT_STATE_ROOT,
            account_siblings,
        );
    }
}
