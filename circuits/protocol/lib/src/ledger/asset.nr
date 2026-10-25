// Fixed commitments for the protocol-owned standard fungible-asset relations.
// Nonzero assets have one transfer/burn law and one fixed, one-shot creation.

use crate::generated::pcash_constants::{
    ASSET_CREATION_MARKER_DOMAIN, ASSET_ID_DOMAIN, ASSET_SECRET_COMMITMENT_DOMAIN,
};
use crate::primitives::hash::pcash_hash;
use crate::primitives::params::MAX_ASSET_SUPPLY;
use crate::primitives::range::assert_asset_aggregate;

pub fn asset_secret_commitment(asset_secret: Field) -> Field {
    pcash_hash([ASSET_SECRET_COMMITMENT_DOMAIN, asset_secret])
}

pub fn standard_fungible_asset_id(
    metadata_commitment: Field,
    initial_supply: Field,
    asset_secret_commitment: Field,
) -> Field {
    assert_asset_aggregate(initial_supply);
    // The asset law is independent of the selected transaction capacity.
    assert_asset_aggregate(MAX_ASSET_SUPPLY - initial_supply);
    pcash_hash(
        [ASSET_ID_DOMAIN, metadata_commitment, initial_supply, asset_secret_commitment],
    )
}

// The asset ID fixes the asset secret through its commitment, so the
// marker is one-shot per asset.
pub fn asset_creation_marker(asset_id: Field, asset_secret: Field) -> Field {
    pcash_hash([ASSET_CREATION_MARKER_DOMAIN, asset_id, asset_secret])
}

mod tests {
    use crate::primitives::params::MAX_ASSET_SUPPLY;
    use super::{asset_creation_marker, asset_secret_commitment, standard_fungible_asset_id};

    #[test]
    fn test_asset_id_and_creation_marker_domains_are_disjoint() {
        let secret_commitment = asset_secret_commitment(0x123);
        let id = standard_fungible_asset_id(0x789, 1_000_000, secret_commitment);
        assert(id != asset_creation_marker(id, 0x789));
    }

    #[test]
    fn test_asset_id_binds_every_field() {
        let secret_commitment = asset_secret_commitment(0x123);
        let base = standard_fungible_asset_id(0x789, 1_000_000, secret_commitment);
        assert(base != standard_fungible_asset_id(0x790, 1_000_000, secret_commitment));
        assert(base != standard_fungible_asset_id(0x789, 1_000_001, secret_commitment));
        assert(base != standard_fungible_asset_id(0x789, 1_000_000, secret_commitment + 1));
    }

    // Zero is an ordinary definition value: no metadata, no supply, or a
    // secret anyone can guess. A zero supply admits no positive asset output.
    #[test]
    fn test_asset_id_accepts_zero_definition_fields() {
        let id = standard_fungible_asset_id(0, 0, asset_secret_commitment(0));
        assert(id != 0);
        assert(id != standard_fungible_asset_id(0, 1, asset_secret_commitment(0)));
    }

    #[test]
    fn test_initial_supply_accepts_asset_law_maximum() {
        let _ = standard_fungible_asset_id(2, MAX_ASSET_SUPPLY, 3);
    }

    #[test(should_fail)]
    fn test_initial_supply_rejects_more_than_the_asset_law_maximum() {
        let _ = standard_fungible_asset_id(2, MAX_ASSET_SUPPLY + 1, 3);
    }
}
