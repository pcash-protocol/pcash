// The owner binding of the readable owner-only rules.
//
// Identity comes from the public key the signature verifies under, never from
// a witnessed address or a configured delegate. The rule's authorization
// commitment names that key's address and this rule's configuration opened
// with the rule's own `nk_root`. The kernel compares it with the account's
// address and installed configuration, so a key that does not own the account
// cannot produce it, and a builder cannot substitute another root for the one
// the rule derives owner change and self-issuance secrets from.

use crate::configuration::{Configuration, configuration_commitment};
use pcash_protocol::authorization::statement::authorization_commitment;
use pcash_protocol::ledger::note::nullifier_key_commitment;

pub struct OwnerOpening {
    pub nullifier_key_commitment: Field,
    pub authorization_commitment: Field,
}

pub fn open_owner(
    signer_address: Field,
    nk_root: Field,
    configuration: Configuration,
) -> OwnerOpening {
    let nullifier_key_commitment = nullifier_key_commitment(nk_root);
    OwnerOpening {
        nullifier_key_commitment,
        authorization_commitment: authorization_commitment(
            signer_address,
            configuration_commitment(configuration, nullifier_key_commitment),
        ),
    }
}
