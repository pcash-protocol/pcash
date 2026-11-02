//! Compile-time PCASH fork rules and runtime derivation configuration.
//!
//! Protocol constants and hiding-kernel verification keys are part of the
//! executable. Runtime configuration supplies the PCASH/L1 chain ids, inbox,
//! and launch anchor.

use alloy_primitives::{Address, B256};
use pcash_derive::ProtocolRules;
use pcash_state::DerivationSource;

use crate::aster::{
    ASTER_LARGE_PRIVATE_VALUE_HIDING_KERNEL_VK, ASTER_PRIVATE_VALUE_HIDING_KERNEL_VK,
    ASTER_USER_ACCOUNT_UPDATE_HIDING_KERNEL_VK,
};
pub use crate::networks::{DEFAULT_INBOX, L1_CHAIN_ID, PCASH_CHAIN_ID};

/// Network-instance values. Consensus rules are not configurable here.
#[derive(Clone, Debug)]
pub struct NetworkConfig {
    pub pcash_chain_id: u32,
    pub l1_chain_id: u64,
    pub inbox: Address,
    pub genesis_l1_block: u64,
    /// The exact L1 hash at the anchor.
    pub genesis_l1_block_hash: B256,
}

impl NetworkConfig {
    /// A network instance using this binary's compiled protocol rules and
    /// hiding-kernel verification keys with a runtime-supplied derivation source.
    pub fn new(
        pcash_chain_id: u32,
        l1_chain_id: u64,
        inbox: Address,
        genesis_l1_block: u64,
        genesis_l1_block_hash: B256,
    ) -> Self {
        Self {
            pcash_chain_id,
            l1_chain_id,
            inbox,
            genesis_l1_block,
            genesis_l1_block_hash,
        }
    }

    /// The derivation source this configuration names. A new state database
    /// stores it; an existing one must already hold exactly this source.
    pub fn derivation_source(&self) -> DerivationSource {
        DerivationSource {
            pcash_chain_id: self.pcash_chain_id,
            l1_chain_id: self.l1_chain_id,
            inbox_address: self.inbox,
            genesis_l1_block: self.genesis_l1_block,
            genesis_l1_block_hash: self.genesis_l1_block_hash,
        }
    }
}

/// The protocol rules this binary compiles: the Aster hiding-kernel VKs and the
/// fork schedule.
///
/// The fork schedule this binary compiles is empty: Aster is the launch rule set
/// and no later fork is scheduled. A release that activates one appends it here
/// with [`ProtocolRules::with_fork`].
pub fn compiled_rules() -> ProtocolRules {
    ProtocolRules::new(
        [
            ASTER_PRIVATE_VALUE_HIDING_KERNEL_VK.to_vec(),
            ASTER_LARGE_PRIVATE_VALUE_HIDING_KERNEL_VK.to_vec(),
        ],
        ASTER_USER_ACCOUNT_UPDATE_HIDING_KERNEL_VK.to_vec(),
    )
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]
mod tests {
    use super::*;

    /// A transaction type a scheduled fork would introduce, and a fork that
    /// retires type 0 in its favour. Both are written out here so these tests
    /// exercise the fork seam without any fork being scheduled for release.
    const LATER_FORK_KIND: u8 = 0x40;

    fn later_fork(activation_timestamp: u64, vk: Vec<u8>) -> pcash_derive::ForkActivation {
        pcash_derive::ForkActivation {
            name: "Later",
            activation_timestamp,
            accepted_transaction_types: vec![
                pcash_derive::KIND_USER_ACCOUNT_CREATION,
                pcash_derive::KIND_CONTRACT_ACCOUNT_CREATION,
                pcash_derive::KIND_USER_ACCOUNT_UPDATE,
                LATER_FORK_KIND,
            ],
            accepted_batch_versions: pcash_derive::BASE_BATCH_VERSIONS.to_vec(),
            hiding_kernel_vks: vec![(LATER_FORK_KIND, vk)],
        }
    }

    #[test]
    fn restart_guard_binds_only_the_activated_fork_schedule_prefix() {
        let first = compiled_rules().with_fork(later_fork(
            100,
            ASTER_PRIVATE_VALUE_HIDING_KERNEL_VK.to_vec(),
        ));
        let rescheduled = compiled_rules().with_fork(later_fork(
            200,
            ASTER_PRIVATE_VALUE_HIDING_KERNEL_VK.to_vec(),
        ));

        assert_eq!(
            first.activated_fork_schedule_prefix_hash_at(99),
            rescheduled.activated_fork_schedule_prefix_hash_at(99),
            "an unactivated future fork must not invalidate an older checkpoint"
        );
        assert_ne!(
            first.activated_fork_schedule_prefix_hash_at(100),
            first.activated_fork_schedule_prefix_hash_at(99),
            "activation must extend the internal restart prefix"
        );
        assert_ne!(
            first.activated_fork_schedule_prefix_hash_at(200),
            rescheduled.activated_fork_schedule_prefix_hash_at(200),
            "a changed historical activation timestamp must reject checkpoint reuse"
        );
    }

    #[test]
    fn a_fork_replaces_the_private_value_type_without_changing_batch_versions() {
        let activation_timestamp = 1_900_000_000;
        let rules = compiled_rules().with_fork(later_fork(
            activation_timestamp,
            ASTER_PRIVATE_VALUE_HIDING_KERNEL_VK.to_vec(),
        ));

        // Batch encoding is a container concern; retiring and introducing a
        // transaction type must not touch it.
        assert_eq!(
            rules.accepted_batch_versions_at(activation_timestamp),
            vec![pcash_derive::BatchVersion::V1]
        );
        assert!(!rules.transaction_type_allowed_at(LATER_FORK_KIND, activation_timestamp - 1));
        assert!(rules.transaction_type_allowed_at(
            pcash_derive::KIND_PRIVATE_VALUE,
            activation_timestamp - 1
        ));
        assert!(rules.transaction_type_allowed_at(LATER_FORK_KIND, activation_timestamp));
        assert!(!rules
            .transaction_type_allowed_at(pcash_derive::KIND_PRIVATE_VALUE, activation_timestamp));
    }

    /// The release binary ships no scheduled fork: the launch transaction-type
    /// set is what a node accepts at every timestamp.
    #[test]
    fn the_release_binary_compiles_an_empty_fork_schedule() {
        let rules = compiled_rules();
        assert!(rules.fork_schedule.is_empty());
        for ts in [0, 1_900_000_000, u64::MAX] {
            assert_eq!(
                rules.accepted_transaction_types_at(ts),
                pcash_derive::BASE_TRANSACTION_TYPES.to_vec()
            );
        }
    }
}
