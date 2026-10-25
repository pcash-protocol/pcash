//! Immutable derivation configuration and the L1 origin leaf formula.

use crate::{addr_to_fr, fr_from_internal_word, L1Origin};
use alloy_primitives::{Address, B256};
use pcash_crypto::{bytes32_limbs, domain_tags, poseidon, Fr};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DerivationSource {
    pub pcash_chain_id: u32,
    pub l1_chain_id: u64,
    pub inbox_address: Address,
    pub genesis_l1_block: u64,
    pub genesis_l1_block_hash: B256,
}

crate::codec::codec_struct!(DerivationSource {
    pcash_chain_id,
    l1_chain_id,
    inbox_address,
    genesis_l1_block,
    genesis_l1_block_hash,
});

impl DerivationSource {
    /// Block-zero `parentHash`, committing the chain IDs and inbox. L1 origin
    /// leaf 0 commits the anchor.
    pub fn genesis_parent_hash(&self) -> Fr {
        poseidon(&[
            domain_tags::GENESIS_PARENT_DOMAIN,
            Fr::from(u64::from(self.pcash_chain_id)),
            Fr::from(self.l1_chain_id),
            addr_to_fr(self.inbox_address),
        ])
    }

    pub fn anchor_origin(&self) -> L1Origin {
        L1Origin {
            block_number: self.genesis_l1_block,
            block_hash: self.genesis_l1_block_hash,
            block_timestamp: 0,
            l1_logs_root: B256::ZERO,
            l1_log_count: 0,
        }
    }
}

pub fn l1_origin_leaf(origin: &L1Origin) -> Fr {
    let (block_hash_high, block_hash_low) = bytes32_limbs(&origin.block_hash.0);
    let logs_root = fr_from_internal_word(origin.l1_logs_root);
    poseidon(&[
        domain_tags::L1_ORIGIN_DOMAIN,
        Fr::from(origin.block_number),
        block_hash_high,
        block_hash_low,
        Fr::from(origin.block_timestamp),
        logs_root,
        Fr::from(origin.l1_log_count),
    ])
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

    fn source() -> DerivationSource {
        DerivationSource {
            pcash_chain_id: 0x5043_5348,
            l1_chain_id: 11_155_111,
            inbox_address: Address::repeat_byte(0x22),
            genesis_l1_block: 11_264_180,
            genesis_l1_block_hash: B256::repeat_byte(0x80),
        }
    }

    #[test]
    fn every_committed_source_field_changes_genesis_parent_hash() {
        let original = source();
        let original_parent_hash = original.genesis_parent_hash();
        let mut variants = Vec::new();
        let mut value = original;
        value.pcash_chain_id += 1;
        variants.push(value);
        let mut value = original;
        value.l1_chain_id += 1;
        variants.push(value);
        let mut value = original;
        value.inbox_address = Address::repeat_byte(0x23);
        variants.push(value);
        for variant in variants {
            assert_ne!(variant.genesis_parent_hash(), original_parent_hash);
        }
    }

    #[test]
    fn l1_origin_leaf_binds_normalized_logs_timestamp_and_count() {
        let origin = L1Origin {
            block_number: 7,
            block_hash: B256::repeat_byte(1),
            block_timestamp: 8,
            l1_logs_root: crate::fr_to_bytes(Fr::from(9u64)),
            l1_log_count: 10,
        };
        let leaf = l1_origin_leaf(&origin);
        let mut changed = origin.clone();
        changed.l1_logs_root = crate::fr_to_bytes(Fr::from(11u64));
        assert_ne!(l1_origin_leaf(&changed), leaf);
        changed = origin.clone();
        changed.l1_log_count += 1;
        assert_ne!(l1_origin_leaf(&changed), leaf);
        changed = origin;
        changed.block_timestamp += 1;
        assert_ne!(l1_origin_leaf(&changed), leaf);
    }
}
