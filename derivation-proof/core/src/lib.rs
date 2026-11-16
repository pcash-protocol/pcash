//! What the derivation proof's guest and host share. The host runs the same
//! block authentication and rules natively to build each range's witness.

pub mod l1;

pub use derivation_proof_types::{
    checkpoint_root, config_hash, AggregationInput, AggregationOutputs, PublicValues, RangeStart, RawBlock, Source,
};

use pcash_derive::ProtocolRules;

/// The node's compiled rules (pcash-node `config::compiled_rules`): the Aster
/// hiding-kernel keys and an empty fork schedule.
pub fn compiled_rules() -> ProtocolRules {
    ProtocolRules::new(
        [
            include_bytes!(concat!(
                env!("PCASH_CIRCUIT_BUNDLE"),
                "/vks/private_value_hiding_kernel.chonk.vk"
            ))
            .to_vec(),
            include_bytes!(concat!(
                env!("PCASH_CIRCUIT_BUNDLE"),
                "/vks/private_value_large_hiding_kernel.chonk.vk"
            ))
            .to_vec(),
        ],
        include_bytes!(concat!(
            env!("PCASH_CIRCUIT_BUNDLE"),
            "/vks/user_account_update_hiding_kernel.chonk.vk"
        ))
        .to_vec(),
    )
}
