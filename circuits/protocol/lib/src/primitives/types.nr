// PCASH witness types.

use crate::primitives::params::{ACCOUNT_RULE_SET_DEPTH, MERKLE_DEPTH};

pub struct Note {
    pub owner: Field,
    pub note_secret: Field,
    pub asset_id: Field,
    pub amount: Field,
}

// The part of an input note the kernel cannot derive. The kernel builds the
// note from the owner it authenticated and the slot's namespace. Slot classes
// determine whether the kernel opens a note; note-free slots ignore this
// private witness entirely.
pub struct InputNoteWitness {
    pub output_index: Field,
    pub note_secret: Field,
    pub amount: Field,
    pub siblings: [Field; MERKLE_DEPTH],
}

pub struct MerkleWitness {
    pub leaf_index: Field,
    pub siblings: [Field; MERKLE_DEPTH],
}

pub struct AccountRuleMembershipWitness {
    pub entry_index: u32,
    pub siblings: [Field; ACCOUNT_RULE_SET_DEPTH],
}
