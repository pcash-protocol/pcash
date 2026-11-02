// PCASH address accounts and account rules.

use crate::generated::pcash_constants::{
    ACCOUNT_RULE_ENTRY_DOMAIN, ACCOUNT_STATE_COMMITMENT_DOMAIN, ACCOUNT_UPDATE_COMMITMENT_DOMAIN,
};
use crate::primitives::hash::pcash_hash;

pub global ACCOUNT_KIND_USER: Field = 0;
pub global ACCOUNT_KIND_CONTRACT: Field = 1;

// accountStateCommitment = poseidon(ACCOUNT_STATE_COMMITMENT_DOMAIN, uint160(address), nullifierKeyCommitment,
//                       accountRuleSetCommitment, accountKind, accountRevision, receiveKeyHash).
// accountKind: 0 = user, 1 = contract.
// receiveKeyHash = poseidonBytes(RECEIVE_KEY_HASH_DOMAIN, mlKem768PublicKey); zero means no receive key.
// The fields enter as given: a caller that relies on installed authority opens
// the row in the account tree or has consensus compare the commitment with one
// it derives from the live row, and a value outside its width matches no row.
// The all-padding transfer (spec §11.4) opens no row: it hashes supplied
// fields, which grant nothing.
pub fn account_state_commitment(
    address: Field,
    nullifier_key_commitment: Field,
    account_rule_set_commitment: Field,
    account_kind: Field,
    account_revision: Field,
    receive_key_hash: Field,
) -> Field {
    pcash_hash([
        ACCOUNT_STATE_COMMITMENT_DOMAIN,
        address,
        nullifier_key_commitment,
        account_rule_set_commitment,
        account_kind,
        account_revision,
        receive_key_hash,
    ])
}

// accountRuleEntryCommitment = poseidon(ACCOUNT_RULE_ENTRY_DOMAIN,
//   applicationVkHash, configurationCommitment, commitmentBlinder).
pub fn account_rule_entry_commitment(
    application_vk_hash: Field,
    configuration_commitment: Field,
    commitment_blinder: Field,
) -> Field {
    pcash_hash([
        ACCOUNT_RULE_ENTRY_DOMAIN,
        application_vk_hash,
        configuration_commitment,
        commitment_blinder,
    ])
}

// The network-independent compare-and-swap of a user-account update: the
// account state it replaces and the one it installs. The node recomputes it
// from the live row; the update's action commitment carries it as extra data.
pub fn account_update_commitment(
    current_account_state_commitment: Field,
    new_account_state_commitment: Field,
) -> Field {
    pcash_hash([
        ACCOUNT_UPDATE_COMMITMENT_DOMAIN,
        current_account_state_commitment,
        new_account_state_commitment,
    ])
}

mod tests {
    use crate::generated::pcash_constants::{
        ACCOUNT_RULE_ENTRY_DOMAIN, ACCOUNT_STATE_COMMITMENT_DOMAIN,
    };
    use crate::primitives::hash::pcash_hash;
    use super::{account_rule_entry_commitment, account_state_commitment, account_update_commitment};

    #[test]
    fn test_account_state_commitment_matches_formula() {
        let leaf = account_state_commitment(0xabc, 0xdef, 0x123, 0, 7, 0x456);
        assert(
            leaf
                == pcash_hash(
                    [ACCOUNT_STATE_COMMITMENT_DOMAIN, 0xabc, 0xdef, 0x123, 0, 7, 0x456],
                ),
        );
        assert(leaf != account_state_commitment(0xabd, 0xdef, 0x123, 0, 7, 0x456));
        assert(leaf != account_state_commitment(0xabc, 0xdf0, 0x123, 0, 7, 0x456));
        assert(leaf != account_state_commitment(0xabc, 0xdef, 0x124, 0, 7, 0x456));
        // accountKind is committed: a smart-contract (kind 1) leaf differs from a user one.
        assert(leaf != account_state_commitment(0xabc, 0xdef, 0x123, 1, 7, 0x456));
        assert(leaf != account_state_commitment(0xabc, 0xdef, 0x123, 0, 8, 0x456));
        assert(leaf != account_state_commitment(0xabc, 0xdef, 0x123, 0, 7, 0x457));
        assert(leaf != account_state_commitment(0xabc, 0xdef, 0x123, 0, 7, 0));
    }

    #[test]
    fn test_account_rule_entry_commitment_matches_formula() {
        let entry = account_rule_entry_commitment(0x111, 0x222, 0x333);
        assert(entry == pcash_hash([ACCOUNT_RULE_ENTRY_DOMAIN, 0x111, 0x222, 0x333]));
        // Every entry field is committed independently.
        assert(entry != account_rule_entry_commitment(0x112, 0x222, 0x333));
        assert(entry != account_rule_entry_commitment(0x111, 0x223, 0x333));
        assert(entry != account_rule_entry_commitment(0x111, 0x222, 0x334));
    }

    #[test]
    fn test_account_update_commitment_binds_every_operand() {
        let update = account_update_commitment(4, 5);
        assert(update != account_update_commitment(6, 5));
        assert(update != account_update_commitment(4, 6));
    }
}
