use pcash_protocol::authorization::statement::{
    authorization_commitment, rule_statement, RULE_STATEMENT_LENGTH, transfer_action_commitment,
};
use pcash_protocol::events::event_entry;
use pcash_protocol::generated::private_value_profiles::S_OUTPUTS;
use pcash_protocol::ledger::private_value::{
    private_value_commitment, SLOT_CLASS_NATIVE, SmallPrivateValue,
};
use pcash_protocol::primitives::hash::pcash_hash;
use reference_rule_common::generated::reference_rule_constants::REFERENCE_CONFIGURATION_DOMAIN;

pub struct Configuration {
    pub salt: Field,
    pub policy_root: Field,
    pub lineage_vk: Field,
}

pub fn configuration_commitment(configuration: Configuration) -> Field {
    pcash_hash([
        REFERENCE_CONFIGURATION_DOMAIN,
        configuration.salt,
        configuration.policy_root,
        configuration.lineage_vk,
    ])
}

// A release is an ordinary native transfer whose event is the configured
// lineage application's claim over every native output. The kernel accepts
// this statement only in the transfer role and only with the entry of the
// event application it verified.
fn main(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    address: Field,
    private_value: SmallPrivateValue,
    configuration: Configuration,
) -> return_data [Field; RULE_STATEMENT_LENGTH] {
    let mut mask: u32 = 0;
    for i in 0..S_OUTPUTS {
        if private_value.output_slot_classes[i] == SLOT_CLASS_NATIVE {
            mask += 1 << i;
        }
    }
    let claim = pcash_hash([
        0x70636173685f6c696e656167655f636c61696d,
        configuration.policy_root,
        configuration.lineage_vk,
        mask as Field,
    ]);
    rule_statement(
        authorization_commitment(address, configuration_commitment(configuration)),
        transfer_action_commitment(pcash_chain_id, private_value_commitment(private_value)),
        recent_pcash_block_hash,
        event_entry(configuration.lineage_vk, claim),
    )
}
