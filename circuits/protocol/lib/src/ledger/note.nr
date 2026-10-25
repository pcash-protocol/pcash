// PCASH keys, note commitments, and nullifiers.
//
// Every formula below is a length-tagged Poseidon2 sponge (`pcash_hash`) over
// the domain tag followed by the field operands, in the exact order given by
// the spec. Order is normative. A note's owner is the uint160 address of the
// account that may spend it; padding notes belong to address zero, where no
// account exists.

use crate::generated::pcash_constants::{
    APPLICATION_NULLIFIER_DOMAIN, DUMMY_NULLIFIER_DOMAIN, NOTE_BODY_COMMITMENT_DOMAIN,
    NOTE_NULLIFIER_KEY_DOMAIN, NULLIFIER_DOMAIN, NULLIFIER_KEY_COMMITMENT_DOMAIN,
    OUTPUT_COMMITMENT_DOMAIN, OWNER_COMMITMENT_DOMAIN,
};
use crate::primitives::hash::pcash_hash;
use crate::primitives::range::assert_amount;
use crate::primitives::types::{InputNoteWitness, Note};
use crate::state::merkle::binary_root_from_index;

// ===========================================================================
// Account nullifier-key hierarchy
// ===========================================================================

// nullifierKeyCommitment = poseidon(NULLIFIER_KEY_COMMITMENT_DOMAIN, nkRoot).
// Published in every account; unrelated to the global spent-nullifier tree root.
pub fn nullifier_key_commitment(nk_root: Field) -> Field {
    pcash_hash([NULLIFIER_KEY_COMMITMENT_DOMAIN, nk_root])
}

// noteNk = poseidon(NOTE_NULLIFIER_KEY_DOMAIN, nkRoot). nk for note nullifiers.
pub fn note_nk(nk_root: Field) -> Field {
    pcash_hash([NOTE_NULLIFIER_KEY_DOMAIN, nk_root])
}

// ===========================================================================
// Note bodies and indexed output commitments
// ===========================================================================

// ownerCommitment = poseidon(OWNER_COMMITMENT_DOMAIN, uint160(owner), noteSecret).
pub fn owner_commitment(owner: Field, note_secret: Field) -> Field {
    pcash_hash([OWNER_COMMITMENT_DOMAIN, owner, note_secret])
}

// noteBodyCommitment = poseidon(
//     NOTE_BODY_COMMITMENT_DOMAIN, ownerCommitment, assetId, amount,
// ).
pub fn note_body_commitment(
    owner_commitment_value: Field,
    asset_id: Field,
    amount: Field,
) -> Field {
    pcash_hash(
        [NOTE_BODY_COMMITMENT_DOMAIN, owner_commitment_value, asset_id, amount],
    )
}

// outputCommitment = poseidon(OUTPUT_COMMITMENT_DOMAIN, outputBody, outputIndex).
// Each ordinary note body has its own indexed output commitment.
pub fn output_commitment(output_body: Field, output_index: Field) -> Field {
    pcash_hash([OUTPUT_COMMITMENT_DOMAIN, output_body, output_index])
}

// Convenience: full three-layer commitment for a note at a known output index.
pub fn full_output_commitment(note: Note, output_index: Field) -> Field {
    let oc = owner_commitment(note.owner, note.note_secret);
    let body = note_body_commitment(oc, note.asset_id, note.amount);
    output_commitment(body, output_index)
}

// ===========================================================================
// Nullifiers
// ===========================================================================

// nullifier = poseidon(NULLIFIER_DOMAIN, outputCommitment, noteNk, noteSecret).
pub fn nullifier(
    output_commitment_value: Field,
    note_nk_value: Field,
    note_secret_value: Field,
) -> Field {
    pcash_hash(
        [NULLIFIER_DOMAIN, output_commitment_value, note_nk_value, note_secret_value],
    )
}

// dummyNullifier = poseidon(DUMMY_NULLIFIER_DOMAIN, dummyInputSeed, inputIndex).
// One per DUMMY input slot. The operands name no account, so a seed shared
// with anyone else yields the same nullifiers; the wallet draws a fresh
// unpredictable seed for every action.
pub fn dummy_nullifier(dummy_input_seed: Field, input_index: Field) -> Field {
    pcash_hash([DUMMY_NULLIFIER_DOMAIN, dummy_input_seed, input_index])
}

// applicationNullifier = poseidon(
//     APPLICATION_NULLIFIER_DOMAIN, uint160(address),
//     selectedEntryCommitment, replayId).
//
// The account and the exact selected account-rule entry supply scope; `replayId`
// is defined entirely by that rule and is never interpreted here.
//
// The operand list is deliberately closed. It binds no slot index, no input note
// commitment, no output, no fee, no timestamp, no recent root, and no proof
// randomness — if it bound any of them a party could reshape the transaction and
// derive a fresh marker for the same fact, which is exactly the replay this
// prevents. It also omits pcashChainId: no PCASH nullifier binds the chain, and
// the surrounding contract identity is chain-independent by construction.
pub fn application_nullifier(
    address: Field,
    selected_entry_commitment: Field,
    replay_id: Field,
) -> Field {
    pcash_hash(
        [APPLICATION_NULLIFIER_DOMAIN, address, selected_entry_commitment, replay_id],
    )
}

// ===========================================================================
// Input openings
// ===========================================================================

// One real input note, opened against the account that owns it.
//
// The note is built from the owner the kernel authenticated, the slot's
// namespace, and the witnessed secret and amount, so it belongs to that owner and
// namespace by construction. Every relation that spends notes derives the same
// three values here: the input commitment, its membership under the
// authenticated output root, and the canonical nullifier. Native and asset note
// amounts share the same integer bound. Keeping it here makes every caller's
// conservation sum bounded; capacity is at most 64 notes, far below the field
// modulus even at the largest per-note amount.
pub struct OpenedInput {
    pub input_commitment: Field,
    pub nullifier: Field,
    pub amount: Field,
}

pub fn open_owner_input(
    witness: InputNoteWitness,
    owner: Field,
    nk: Field,
    asset_id: Field,
    output_root: Field,
) -> OpenedInput {
    assert_amount(witness.amount);
    assert(witness.amount != 0, "input amount must be nonzero");
    let note = Note { owner, note_secret: witness.note_secret, asset_id, amount: witness.amount };
    let input_commitment = full_output_commitment(note, witness.output_index);
    assert(
        binary_root_from_index(input_commitment, witness.output_index, witness.siblings)
            == output_root,
        "input note must be in the output tree",
    );
    OpenedInput {
        input_commitment,
        nullifier: nullifier(input_commitment, nk, witness.note_secret),
        amount: witness.amount,
    }
}

pub(crate) mod tests {
    use crate::generated::pcash_constants::{
        APPLICATION_NULLIFIER_DOMAIN, DUMMY_NULLIFIER_DOMAIN, NOTE_BODY_COMMITMENT_DOMAIN,
        NOTE_NULLIFIER_KEY_DOMAIN, NULLIFIER_DOMAIN, NULLIFIER_KEY_COMMITMENT_DOMAIN,
        OUTPUT_COMMITMENT_DOMAIN, OWNER_COMMITMENT_DOMAIN,
    };
    use crate::primitives::hash::pcash_hash;
    use crate::primitives::params::MERKLE_DEPTH;
    use crate::primitives::types::{InputNoteWitness, Note};
    use crate::state::merkle::binary_root_from_index;
    use super::{
        application_nullifier, dummy_nullifier, full_output_commitment, note_body_commitment,
        note_nk, nullifier, nullifier_key_commitment, open_owner_input, output_commitment,
        owner_commitment,
    };

    // A one-leaf output tree holding `note` at index 0, and the witness that opens it.
    pub(crate) fn single_note_opening(note: Note) -> (InputNoteWitness, Field) {
        let siblings = [0; MERKLE_DEPTH];
        let root = binary_root_from_index(full_output_commitment(note, 0), 0, siblings);
        (
            InputNoteWitness {
                output_index: 0,
                note_secret: note.note_secret,
                amount: note.amount,
                siblings,
            }, root,
        )
    }

    // Cross-check the module wiring against `pcash_hash` computed directly from
    // the domain tag and operands (the Poseidon agreement test in hash.nr pins
    // pcash_hash to the Rust/TS golden vectors, so these pin the formula layout).

    #[test]
    fn test_key_hierarchy_matches_formula() {
        let nk_root = 0x9999;
        assert(
            nullifier_key_commitment(nk_root)
                == pcash_hash([NULLIFIER_KEY_COMMITMENT_DOMAIN, nk_root]),
        );
        assert(note_nk(nk_root) == pcash_hash([NOTE_NULLIFIER_KEY_DOMAIN, nk_root]));
    }

    #[test]
    fn test_note_commitment_layers_match_formula() {
        let owner = 0xabc;
        let ns = 0xbeef;
        let amount = 1000;
        let oc = owner_commitment(owner, ns);
        assert(oc == pcash_hash([OWNER_COMMITMENT_DOMAIN, owner, ns]));
        let body = note_body_commitment(oc, 0, amount);
        assert(body == pcash_hash([NOTE_BODY_COMMITMENT_DOMAIN, oc, 0, amount]));
        let nc = output_commitment(body, 7);
        assert(nc == pcash_hash([OUTPUT_COMMITMENT_DOMAIN, body, 7]));

        let note = Note { owner, note_secret: ns, asset_id: 0, amount };
        assert(full_output_commitment(note, 7) == nc);
        // output index is a structural uniqueness source.
        assert(full_output_commitment(note, 8) != nc);
    }

    #[test]
    fn test_nullifier_vs_dummy_differ() {
        let nk = note_nk(0x9999);
        let secret = 0xbeef;
        let real = nullifier(0x1234, nk, secret);
        assert(real == pcash_hash([NULLIFIER_DOMAIN, 0x1234, nk, secret]));
        let dummy = dummy_nullifier(0xaaaa, 0);
        assert(dummy == pcash_hash([DUMMY_NULLIFIER_DOMAIN, 0xaaaa, 0]));
        assert(real != dummy);
    }

    // A zero seed is an ordinary operand: its markers are well defined and
    // nonzero, and like any seed known to others, they collide with theirs.
    #[test]
    fn test_dummy_nullifier_accepts_a_zero_seed() {
        let dummy = dummy_nullifier(0, 0);
        assert(dummy == pcash_hash([DUMMY_NULLIFIER_DOMAIN, 0, 0]));
        assert(dummy != 0);
        assert(dummy != dummy_nullifier(0, 1));
    }

    #[test]
    fn test_application_nullifier_binds_address_entry_and_replay() {
        let base = application_nullifier(0x111, 0x222, 0x333);
        assert(base == pcash_hash([APPLICATION_NULLIFIER_DOMAIN, 0x111, 0x222, 0x333]));
        // Every operand is load-bearing scope.
        assert(base != application_nullifier(0x112, 0x222, 0x333));
        assert(base != application_nullifier(0x111, 0x223, 0x333));
        assert(base != application_nullifier(0x111, 0x222, 0x334));
        // Disjoint from the other note-free markers and from a real note nullifier.
        assert(base != dummy_nullifier(0x111, 0));
        assert(base != nullifier(0x111, note_nk(0x222), 0x333));
    }

    // Replay ID zero is an ordinary one-shot marker, still scoped to the
    // account and the rule entry.
    #[test]
    fn test_application_nullifier_accepts_replay_id_zero() {
        let marker = application_nullifier(0x111, 0x222, 0);
        assert(marker == pcash_hash([APPLICATION_NULLIFIER_DOMAIN, 0x111, 0x222, 0]));
        assert(marker != 0);
        assert(marker == application_nullifier(0x111, 0x222, 0));
        assert(marker != application_nullifier(0x112, 0x222, 0));
        assert(marker != application_nullifier(0x111, 0x223, 0));
    }

    // A zero note secret is one more operand: the owner commitment, the output
    // commitment, and the nullifier are all ordinary values, and the nullifier
    // is not zero.
    #[test]
    fn test_zero_note_secret_is_an_ordinary_operand() {
        let note = Note { owner: 0x1234, note_secret: 0, asset_id: 0, amount: 1 };
        let leaf = full_output_commitment(note, 0);
        assert(
            leaf == output_commitment(note_body_commitment(owner_commitment(0x1234, 0), 0, 1), 0),
        );
        let spent = nullifier(leaf, note_nk(0x9999), 0);
        assert(spent == pcash_hash([NULLIFIER_DOMAIN, leaf, note_nk(0x9999), 0]));
        assert(spent != 0);
    }

    // Golden vectors: absolute hex values (not recomputed inline), pinning the full
    // commitment pipeline byte-for-byte. Regenerate only on an intentional formula
    // change and update the reference implementation to match.
    #[test]
    fn test_golden_vectors() {
        // output commitment for owner=0xabc, noteSecret=0xbeef, amount=1000,
        // outputIndex=7.
        let oc = owner_commitment(0xabc, 0xbeef);
        let body = note_body_commitment(oc, 0, 1000);
        assert(body == 0x164a08339c97307e73f91488b75b97cdf0a64d56e2bc7358fe24a4fd7aee46d0);
        assert(
            output_commitment(body, 7)
                == 0x1957bef470681eed3110232bed1596f9af88dd24991d58b8e27231c0ba4e53aa,
        );
    }

    fn check_opened_amount(amount: Field) {
        let (witness, root) =
            single_note_opening(Note { owner: 11, note_secret: 12, asset_id: 0, amount });
        assert(open_owner_input(witness, 11, 13, 0, root).amount == amount);
    }

    #[test]
    fn test_opened_note_accepts_maximum_amount() {
        check_opened_amount(0xffffffffffffffffffffffffffffffff);
    }

    #[test(should_fail)]
    fn test_opened_note_rejects_oversized_amount_even_with_valid_membership() {
        check_opened_amount(0x100000000000000000000000000000000);
    }

    #[test(should_fail)]
    fn test_opened_note_rejects_negative_amount_even_with_valid_membership() {
        check_opened_amount(-1);
    }

    #[test]
    fn test_open_owner_input_derives_commitment_and_nullifier() {
        let note = Note { owner: 0xabc, note_secret: 0xbeef, asset_id: 0, amount: 1000 };
        let (witness, root) = single_note_opening(note);
        let nk = note_nk(0x9999);
        let opened = open_owner_input(witness, 0xabc, nk, 0, root);
        let leaf = full_output_commitment(note, 0);
        assert(opened.input_commitment == leaf);
        assert(opened.nullifier == nullifier(leaf, nk, 0xbeef));
        assert(opened.amount == 1000);
    }

    // A positive note under a zero secret opens under its owner and has one
    // canonical nullifier, so the node's spent-nullifier check rejects a
    // second spend. Native and asset namespaces alike.
    #[test]
    fn test_open_owner_input_spends_a_zero_secret_note_once() {
        let nk = note_nk(0x9999);
        for asset_id in [0, 0x5a] {
            let note = Note { owner: 0xabc, note_secret: 0, asset_id, amount: 1000 };
            let (witness, root) = single_note_opening(note);
            let first = open_owner_input(witness, 0xabc, nk, asset_id, root);
            let second = open_owner_input(witness, 0xabc, nk, asset_id, root);
            assert(first.input_commitment == full_output_commitment(note, 0));
            assert(first.nullifier == nullifier(first.input_commitment, nk, 0));
            assert(first.nullifier != 0);
            assert(second.nullifier == first.nullifier);
        }
    }

    // A note of another owner or namespace is not in the tree the kernel opens.
    #[test(should_fail_with = "input note must be in the output tree")]
    fn test_open_owner_input_rejects_foreign_owner() {
        let (witness, root) = single_note_opening(
            Note { owner: 0xabc, note_secret: 0xbeef, asset_id: 0, amount: 1000 },
        );
        let _ = open_owner_input(witness, 0xabd, note_nk(0x9999), 0, root);
    }

    // The zero-secret note of one owner is not another owner's note.
    #[test(should_fail_with = "input note must be in the output tree")]
    fn test_open_owner_input_rejects_another_owners_zero_secret_note() {
        let (witness, root) = single_note_opening(
            Note { owner: 0xabc, note_secret: 0, asset_id: 0, amount: 1000 },
        );
        let _ = open_owner_input(witness, 0xabd, note_nk(0x9999), 0, root);
    }

    #[test(should_fail_with = "input note must be in the output tree")]
    fn test_open_owner_input_rejects_namespace_mismatch() {
        let (witness, root) = single_note_opening(
            Note { owner: 0xabc, note_secret: 0xbeef, asset_id: 0, amount: 1000 },
        );
        let _ = open_owner_input(witness, 0xabc, note_nk(0x9999), 1, root);
    }

    #[test(should_fail_with = "input amount must be nonzero")]
    fn test_open_owner_input_rejects_zero_amount() {
        let (witness, root) = single_note_opening(
            Note { owner: 0xabc, note_secret: 0xbeef, asset_id: 0, amount: 0 },
        );
        let _ = open_owner_input(witness, 0xabc, note_nk(0x9999), 0, root);
    }
}
