// The configuration of the asset covenant fixture: the one live contract
// account its asset value may move to, and the largest open fee it may pay.

use crate::generated::reference_rule_constants::REFERENCE_ASSET_CONFIGURATION_DOMAIN;
use pcash_protocol::primitives::hash::pcash_hash;
use pcash_protocol::primitives::range::assert_amount;

// The covenant's sub-tag under REFERENCE_ASSET_CONFIGURATION_DOMAIN. The shared
// asset claim fixture uses 4 to 6.
pub global ASSET_COVENANT_SUCCESSOR_TAG: Field = 3;

pub fn asset_covenant_successor_configuration_commitment(
    max_native_open_fee_amount: Field,
    successor_address: Field,
    successor_nullifier_key_commitment: Field,
    successor_rule_set_commitment: Field,
    successor_account_revision: Field,
    successor_receive_key_hash: Field,
) -> Field {
    assert_amount(max_native_open_fee_amount);
    // The covenant opens the successor fields from the live account leaf.
    pcash_hash([
        REFERENCE_ASSET_CONFIGURATION_DOMAIN,
        ASSET_COVENANT_SUCCESSOR_TAG,
        max_native_open_fee_amount,
        successor_address,
        successor_nullifier_key_commitment,
        successor_rule_set_commitment,
        successor_account_revision,
        successor_receive_key_hash,
    ])
}

mod tests {
    use super::asset_covenant_successor_configuration_commitment;

    #[test]
    fn test_covenant_successor_configuration_binds_the_complete_account() {
        let base =
            asset_covenant_successor_configuration_commitment(5, 0x1234, 0x2345, 0x3456, 1, 0);
        assert(
            base
                != asset_covenant_successor_configuration_commitment(
                    5,
                    0x1234,
                    0x2345,
                    0x3457,
                    1,
                    0,
                ),
        );
        assert(
            base
                != asset_covenant_successor_configuration_commitment(
                    6,
                    0x1234,
                    0x2345,
                    0x3456,
                    1,
                    0,
                ),
        );
    }

    // Zero fields are hash inputs like any other. Whether they describe a live
    // successor is the covenant's account-leaf opening, not this commitment.
    #[test]
    fn test_covenant_successor_configuration_hashes_zero_fields() {
        let zero = asset_covenant_successor_configuration_commitment(5, 0, 0, 0, 0, 0);
        assert(zero != asset_covenant_successor_configuration_commitment(5, 0x1234, 0, 0, 0, 0));
        assert(zero != asset_covenant_successor_configuration_commitment(5, 0, 0, 0, 1, 0));
    }
}
