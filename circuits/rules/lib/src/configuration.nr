// The reference rules' configuration: the EIP-712 domain separator the owner
// signs under and the account's nullifier key commitment.
//
//   configurationCommitment = poseidon(REFERENCE_CONFIGURATION_DOMAIN,
//                                      domainSeparatorHigh128, domainSeparatorLow128,
//                                      nullifierKeyCommitment)
//
// A rule verifies every signature under the committed separator. The signer is
// not configured: the rule derives its address from the signing key. The rule
// opens the nullifier key commitment with the `nk_root` it derives owner change
// and self-issuance secrets from, so the installing wallet fixes that root.

use crate::generated::reference_rule_constants::REFERENCE_CONFIGURATION_DOMAIN;
use pcash_protocol::primitives::hash::pcash_hash;
use signature_common::eip712::{domain_separator, flat_message_signing_hash};

pub struct Configuration {
    pub domain_separator_high: Field,
    pub domain_separator_low: Field,
}

impl Configuration {
    // The EIP-712 signing hash of a flat message under the committed separator.
    pub fn signing_hash<let N: u32>(self, type_hash: [u8; 32], fields: [Field; N]) -> [u8; 32] {
        flat_message_signing_hash(
            domain_separator(self.domain_separator_high, self.domain_separator_low),
            type_hash,
            fields,
        )
    }
}

pub fn configuration_commitment(
    configuration: Configuration,
    nullifier_key_commitment: Field,
) -> Field {
    pcash_hash([
        REFERENCE_CONFIGURATION_DOMAIN,
        configuration.domain_separator_high,
        configuration.domain_separator_low,
        nullifier_key_commitment,
    ])
}
