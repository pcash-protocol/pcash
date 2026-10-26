// Open an account and its selected rule under the exact Mega VK being folded.
// The account row commits the rule set the selected entry's path opens, so an
// opening describes installed authority only after its root is authenticated.
// The sponsored-transfer and asset-creation kernels use
// authenticate. The transfer kernel calls open_account and checks the root
// itself, because an action whose every input is DUMMY skips membership. The
// account-update kernel opens only the account row, whose current value the
// node checks through the update's account update commitment.

use crate::authorization::account::{account_rule_entry_commitment, account_state_commitment};
use crate::authorization::statement::authorization_commitment;
use crate::ledger::note::{note_nk, nullifier_key_commitment};
use crate::primitives::types::{AccountRuleMembershipWitness, MerkleWitness};
use crate::state::merkle::binary_root_from_index;

pub struct AuthorizedAccount {
    pub address: Field,
    pub nk_root: Field,
    pub account_witness: MerkleWitness,
    pub account_revision: Field,
    pub receive_key_hash: Field,
    pub configuration_commitment: Field,
    pub commitment_blinder: Field,
    pub account_rule_witness: AccountRuleMembershipWitness,
}

// An opened account: its address, which names it and owns its notes, the
// key its note nullifiers derive from, the selected rule entry, and the
// authorization commitment that entry's rule statement must name.
pub struct AccountOpening {
    pub address: Field,
    pub nk: Field,
    pub entry: Field,
    pub authorization: Field,
}

// `account_kind` is the kind the caller requires the account to be, or the
// kind it witnessed when it admits both.
pub fn authenticate(
    account: AuthorizedAccount,
    account_kind: Field,
    application_vk_hash: Field,
    account_state_root: Field,
) -> AccountOpening {
    let (root, opened) = open_account(account, account_kind, application_vk_hash);
    assert(root == account_state_root, "account must be in the account state tree");
    opened
}

// Returns the account-state root the witness path implies, and the opening.
pub fn open_account(
    account: AuthorizedAccount,
    account_kind: Field,
    application_vk_hash: Field,
) -> (Field, AccountOpening) {
    let (leaf, opened) = open_account_leaf(
        account.address,
        account.nk_root,
        account_kind,
        account.account_revision,
        account.receive_key_hash,
        application_vk_hash,
        account.configuration_commitment,
        account.commitment_blinder,
        account.account_rule_witness,
    );
    let root = binary_root_from_index(
        leaf,
        account.account_witness.leaf_index,
        account.account_witness.siblings,
    );
    (root, opened)
}

// The account-state row whose rule set the selected rule's path opens, without
// the row's position in the account tree. Returns the row commitment and the
// opening.
pub fn open_account_leaf(
    address: Field,
    nk_root: Field,
    account_kind: Field,
    account_revision: Field,
    receive_key_hash: Field,
    application_vk_hash: Field,
    configuration_commitment: Field,
    commitment_blinder: Field,
    account_rule_witness: AccountRuleMembershipWitness,
) -> (Field, AccountOpening) {
    let entry = account_rule_entry_commitment(
        application_vk_hash,
        configuration_commitment,
        commitment_blinder,
    );
    let account_rule_set_commitment = binary_root_from_index(
        entry,
        account_rule_witness.entry_index as Field,
        account_rule_witness.siblings,
    );
    let leaf = account_state_commitment(
        address,
        nullifier_key_commitment(nk_root),
        account_rule_set_commitment,
        account_kind,
        account_revision,
        receive_key_hash,
    );
    let authorization = authorization_commitment(address, configuration_commitment);
    (leaf, AccountOpening { address, nk: note_nk(nk_root), entry, authorization })
}

mod tests {
    use crate::authorization::account::{
        ACCOUNT_KIND_CONTRACT, ACCOUNT_KIND_USER, account_rule_entry_commitment,
        account_state_commitment,
    };
    use crate::authorization::statement::authorization_commitment;
    use crate::ledger::note::{note_nk, nullifier_key_commitment};
    use crate::primitives::params::{ACCOUNT_RULE_SET_DEPTH, MERKLE_DEPTH};
    use crate::primitives::types::{AccountRuleMembershipWitness, MerkleWitness};
    use crate::state::merkle::binary_root_from_index;
    use super::{authenticate, AuthorizedAccount};

    global ADDRESS: Field = 0xabc;
    global VK_HASH: Field = 0x5555;
    global CONFIGURATION: Field = 0x4444;
    global BLINDER: Field = 0x77;

    // A user account in the first leaf with one installed rule, and the
    // account-state root it implies.
    fn installed(nk_root: Field) -> (AuthorizedAccount, Field) {
        let entry = account_rule_entry_commitment(VK_HASH, CONFIGURATION, BLINDER);
        let rule_set = binary_root_from_index(entry, 0, [0; ACCOUNT_RULE_SET_DEPTH]);
        let leaf = account_state_commitment(
            ADDRESS,
            nullifier_key_commitment(nk_root),
            rule_set,
            ACCOUNT_KIND_USER,
            1,
            0,
        );
        let account = AuthorizedAccount {
            address: ADDRESS,
            nk_root,
            account_witness: MerkleWitness { leaf_index: 0, siblings: [0; MERKLE_DEPTH] },
            account_revision: 1,
            receive_key_hash: 0,
            configuration_commitment: CONFIGURATION,
            commitment_blinder: BLINDER,
            account_rule_witness: AccountRuleMembershipWitness {
                entry_index: 0,
                siblings: [0; ACCOUNT_RULE_SET_DEPTH],
            },
        };
        (account, binary_root_from_index(leaf, 0, [0; MERKLE_DEPTH]))
    }

    // A zero root is one more root: the account authenticates, and its notes
    // nullify under the key it derives.
    #[test]
    fn test_authenticates_an_account_with_a_zero_nk_root() {
        let (account, root) = installed(0);
        let opened = authenticate(account, ACCOUNT_KIND_USER, VK_HASH, root);
        assert(opened.address == ADDRESS);
        assert(opened.nk == note_nk(0));
        assert(opened.authorization == authorization_commitment(ADDRESS, CONFIGURATION));
    }

    // The account still acts only through a rule it installed: another rule
    // opens another rule set, which no account row commits.
    #[test(should_fail_with = "account must be in the account state tree")]
    fn test_a_zero_nk_root_account_still_needs_its_rule() {
        let (account, root) = installed(0);
        let _ = authenticate(account, ACCOUNT_KIND_USER, VK_HASH + 1, root);
    }

    // The row commits the rule set the selected entry's path opens, so another
    // path opens another rule set.
    #[test(should_fail_with = "account must be in the account state tree")]
    fn test_rejects_another_rule_sibling() {
        let (mut account, root) = installed(0);
        account.account_rule_witness.siblings[ACCOUNT_RULE_SET_DEPTH - 1] = 1;
        let _ = authenticate(account, ACCOUNT_KIND_USER, VK_HASH, root);
    }

    #[test(should_fail_with = "account must be in the account state tree")]
    fn test_rejects_another_rule_entry_index() {
        let (mut account, root) = installed(0);
        account.account_rule_witness.entry_index = 1;
        let _ = authenticate(account, ACCOUNT_KIND_USER, VK_HASH, root);
    }

    #[test(should_fail_with = "account must be in the account state tree")]
    fn test_rejects_a_root_the_account_does_not_commit() {
        let (mut account, root) = installed(0);
        account.nk_root = 1;
        let _ = authenticate(account, ACCOUNT_KIND_USER, VK_HASH, root);
    }

    // The kind is the caller's: a user account does not open as a contract.
    #[test(should_fail_with = "account must be in the account state tree")]
    fn test_rejects_an_account_of_another_kind() {
        let (account, root) = installed(0);
        let _ = authenticate(account, ACCOUNT_KIND_CONTRACT, VK_HASH, root);
    }
}
