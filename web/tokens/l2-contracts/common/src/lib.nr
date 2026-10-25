// Relation fragments shared by the token claim templates.
//
// Every template function is a published-root Contract Account function whose
// notes are spendable in two roles: the transfer role, where the contract owns
// every real input, or the sponsored role, under a distinct USER fee payer
// through the sponsored-transfer kernel (spec §11.7).

use pcash_protocol::generated::private_value_profiles::S_INPUTS;
use pcash_protocol::ledger::private_value::{SLOT_CLASS_NATIVE, SmallPrivateValue};
use pcash_protocol::primitives::hash::pcash_hash;
use reference_rule_common::generated::reference_rule_constants::REFERENCE_CONFIGURATION_DOMAIN;

/// In the transfer role every real input belongs to the contract, so a NATIVE
/// input would spend contract-owned PCASH. With no native input, native
/// conservation leaves zero fee and no native output. Under a fee payer every
/// NATIVE input is the payer's own and its kernel bounds that contribution.
pub fn assert_no_contract_native(fee_paid: bool, private_value: SmallPrivateValue) {
    if !fee_paid {
        for i in 0..S_INPUTS {
            assert(
                private_value.input_slot_classes[i] != SLOT_CLASS_NATIVE,
                "unsponsored action must not spend contract native value",
            );
        }
    }
}

pub struct DropConfiguration {
    pub configuration_salt: Field,
    pub asset_id: Field,
    pub claim_amount: Field,
    pub cutoff_block_number: Field,
    pub claim_end_timestamp: Field,
    pub creator: Field,
}

/// One commitment configures both drop functions; each function's entry
/// differs by its application VK. The claim takes the creator's nullifier
/// key commitment as a witness; the reclaim derives it from the creator's key.
pub fn drop_configuration_commitment(
    configuration: DropConfiguration,
    creator_nullifier_key_commitment: Field,
) -> Field {
    pcash_hash([
        REFERENCE_CONFIGURATION_DOMAIN,
        configuration.configuration_salt,
        configuration.asset_id,
        configuration.claim_amount,
        configuration.cutoff_block_number,
        configuration.claim_end_timestamp,
        configuration.creator,
        creator_nullifier_key_commitment,
    ])
}
