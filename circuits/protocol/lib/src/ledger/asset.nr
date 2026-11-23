// Asset identity. An asset ID is the hash of the asset's definition: its
// metadata, its mint rule, and its optional transfer rule. The creator picks
// the instance salt so that the ID lands in the class its transfer rule
// implies: below 2^252 without a rule, in [2^252, 2^253) with one. A kernel
// therefore knows from the ID alone whether a transfer rule applies, and
// spending an asset without one needs no definition.

use crate::generated::pcash_constants::{
    ASSET_CORE_DOMAIN, ASSET_ID_DOMAIN, ASSET_MINT_POLICY_DOMAIN, ASSET_MINT_RULE_DOMAIN,
    ASSET_POLICY_DOMAIN, ASSET_TRANSFER_RULE_DOMAIN, MINT_MARKER_DOMAIN,
};
use crate::generated::private_value_profiles::S_SHAPE_ID;
use crate::primitives::hash::pcash_hash;
use crate::primitives::params::ASSET_CLASS_BITS;

// 2^252, the lower bound of the restricted class.
global RESTRICTED_CLASS_BASE: Field =
    0x1000000000000000000000000000000000000000000000000000000000000000;

// A mint or transfer rule names one application VK hash per profile and the
// configuration both read. A zero hash leaves its profile unsupported: no VK
// hashes to zero, so no proof in that profile can fold the rule.
pub fn mint_rule_commitment(
    s_vk_hash: Field,
    l_vk_hash: Field,
    configuration_commitment: Field,
) -> Field {
    pcash_hash(
        [ASSET_MINT_RULE_DOMAIN, s_vk_hash, l_vk_hash, configuration_commitment],
    )
}

pub fn transfer_rule_commitment(
    s_vk_hash: Field,
    l_vk_hash: Field,
    configuration_commitment: Field,
) -> Field {
    pcash_hash(
        [ASSET_TRANSFER_RULE_DOMAIN, s_vk_hash, l_vk_hash, configuration_commitment],
    )
}

// A kernel folds a rule's application for its own profile and takes the other
// profile's VK hash from the definition. Returns (S, L).
pub fn profile_vk_hashes<let SHAPE: u32>(
    folded_vk_hash: Field,
    other_vk_hash: Field,
) -> (Field, Field) {
    if SHAPE == S_SHAPE_ID {
        (folded_vk_hash, other_vk_hash)
    } else {
        (other_vk_hash, folded_vk_hash)
    }
}

pub fn asset_core_commitment(
    instance_salt: Field,
    metadata_commitment: Field,
    mint_rule_commitment: Field,
) -> Field {
    pcash_hash(
        [ASSET_CORE_DOMAIN, instance_salt, metadata_commitment, mint_rule_commitment],
    )
}

// `transfer_rule_commitment` is zero for an asset without a transfer rule.
pub fn asset_id(core_commitment: Field, transfer_rule_commitment: Field) -> Field {
    pcash_hash([ASSET_ID_DOMAIN, core_commitment, transfer_rule_commitment])
}

// The unrestricted class, or an unused asset-ID witness of zero.
pub fn assert_unrestricted_asset_id(asset_id: Field) {
    asset_id.assert_max_bit_size::<ASSET_CLASS_BITS>();
}

// A value below 2^252 wraps under the subtraction to one at least
// p - 2^252 > 2^252, which fails the range check.
pub fn assert_restricted_asset_id(asset_id: Field) {
    (asset_id - RESTRICTED_CLASS_BASE).assert_max_bit_size::<ASSET_CLASS_BITS>();
}

// The class a definition's transfer rule implies.
pub fn assert_asset_class(asset_id: Field, restricted: bool) {
    let shifted = if restricted {
        asset_id - RESTRICTED_CLASS_BASE
    } else {
        asset_id
    };
    shifted.assert_max_bit_size::<ASSET_CLASS_BITS>();
    assert(restricted | (asset_id != 0), "asset ID must be nonzero");
}

// One mint of an asset. The mint rule decides which replay IDs it accepts.
pub fn mint_marker(asset_id: Field, replay_id: Field) -> Field {
    pcash_hash([MINT_MARKER_DOMAIN, asset_id, replay_id])
}

// The opening a restricted kernel needs: the definition's core and the transfer
// rule, of which the kernel supplies the VK hash of its own profile from the
// policy application it folds.
pub struct RestrictedAssetOpening {
    pub core_commitment: Field,
    pub other_profile_vk_hash: Field,
    pub configuration_commitment: Field,
}

pub fn restricted_asset_id<let SHAPE: u32>(
    opening: RestrictedAssetOpening,
    policy_vk_hash: Field,
) -> Field {
    let (s_vk_hash, l_vk_hash) =
        profile_vk_hashes::<SHAPE>(policy_vk_hash, opening.other_profile_vk_hash);
    let id = asset_id(
        opening.core_commitment,
        transfer_rule_commitment(s_vk_hash, l_vk_hash, opening.configuration_commitment),
    );
    assert_restricted_asset_id(id);
    id
}

// The first word of the policy statement: which asset, under which
// configuration, which owner's inputs move, and until when the transaction may
// execute.
pub fn policy_context(
    asset_id: Field,
    configuration_commitment: Field,
    owner_address: Field,
    valid_until_timestamp: Field,
) -> Field {
    pcash_hash([
        ASSET_POLICY_DOMAIN,
        asset_id,
        configuration_commitment,
        owner_address,
        valid_until_timestamp,
    ])
}

// The first word of the mint rule's statement: which asset, under which
// configuration, which account authorizes and pays for the mint, and until when
// the transaction may execute.
pub fn mint_context(
    asset_id: Field,
    configuration_commitment: Field,
    account_address: Field,
    valid_until_timestamp: Field,
) -> Field {
    pcash_hash([
        ASSET_MINT_POLICY_DOMAIN,
        asset_id,
        configuration_commitment,
        account_address,
        valid_until_timestamp,
    ])
}

mod tests {
    use super::{
        assert_asset_class, assert_restricted_asset_id, assert_unrestricted_asset_id,
        asset_core_commitment, asset_id, mint_context, mint_marker, mint_rule_commitment,
        policy_context, restricted_asset_id, RESTRICTED_CLASS_BASE, RestrictedAssetOpening,
        transfer_rule_commitment,
    };

    // A restricted definition: the first core whose ID with rule (S, L, config)
    // lands in the restricted class.
    fn restricted_opening(
        s_vk_hash: Field,
        l_vk_hash: Field,
        configuration: Field,
    ) -> (RestrictedAssetOpening, Field) {
        let rule = transfer_rule_commitment(s_vk_hash, l_vk_hash, configuration);
        let mut core = 0;
        let mut found = false;
        for salt in 0..64 {
            if !found {
                let candidate =
                    asset_core_commitment(salt as Field, 1, mint_rule_commitment(2, 3, 4));
                let bits: [bool; 254] = asset_id(candidate, rule).to_le_bits();
                if bits[252] & !bits[253] {
                    core = candidate;
                    found = true;
                }
            }
        }
        assert(found);
        (
            RestrictedAssetOpening {
                core_commitment: core,
                other_profile_vk_hash: 0,
                configuration_commitment: configuration,
            }, asset_id(core, rule),
        )
    }

    // Each profile's kernel supplies its own VK hash from the policy it folds
    // and takes the other profile's from the opening.
    #[test]
    fn test_restricted_asset_id_takes_each_profiles_vk_hash_from_its_policy() {
        let (mut opening, id) = restricted_opening(0x5, 0x6, 0x7);
        opening.other_profile_vk_hash = 0x6;
        assert(restricted_asset_id::<0>(opening, 0x5) == id);
        opening.other_profile_vk_hash = 0x5;
        assert(restricted_asset_id::<1>(opening, 0x6) == id);
    }

    // Folding another application as the policy derives another asset, which
    // owns no notes and almost surely leaves the restricted class.
    #[test]
    fn test_restricted_asset_id_binds_the_folded_policy() {
        let (mut opening, id) = restricted_opening(0x5, 0x6, 0x7);
        opening.other_profile_vk_hash = 0x6;
        let other = asset_id(
            opening.core_commitment,
            transfer_rule_commitment(0x9, 0x6, 0x7),
        );
        assert(other != id);
        let swapped = asset_id(
            opening.core_commitment,
            transfer_rule_commitment(0x6, 0x5, 0x7),
        );
        assert(swapped != id);
    }

    #[test]
    fn test_policy_context_binds_every_field() {
        let base = policy_context(1, 2, 3, 4);
        assert(base != policy_context(5, 2, 3, 4));
        assert(base != policy_context(1, 5, 3, 4));
        assert(base != policy_context(1, 2, 5, 4));
        assert(base != policy_context(1, 2, 3, 5));
    }

    #[test]
    fn test_mint_context_binds_every_field_and_differs_from_the_policy_context() {
        let base = mint_context(1, 2, 3, 4);
        assert(base != mint_context(5, 2, 3, 4));
        assert(base != mint_context(1, 5, 3, 4));
        assert(base != mint_context(1, 2, 5, 4));
        assert(base != mint_context(1, 2, 3, 5));
        assert(base != policy_context(1, 2, 3, 4));
    }

    // A mint rule and a transfer rule with the same fields commit apart.
    #[test]
    fn test_mint_and_transfer_rule_commitments_hash_apart() {
        assert(mint_rule_commitment(1, 2, 3) != transfer_rule_commitment(1, 2, 3));
        assert(mint_rule_commitment(1, 2, 3) != mint_rule_commitment(2, 1, 3));
    }

    #[test]
    fn test_asset_id_binds_core_and_rule() {
        let core = asset_core_commitment(1, 2, mint_rule_commitment(3, 4, 5));
        let rule = transfer_rule_commitment(4, 5, 6);
        assert(asset_id(core, rule) != asset_id(core, 0));
        assert(asset_id(core, rule) != asset_id(core + 1, rule));
        assert(rule != transfer_rule_commitment(5, 4, 6));
    }

    #[test]
    fn test_mint_marker_binds_asset_and_replay_id() {
        assert(mint_marker(1, 2) != mint_marker(1, 3));
        assert(mint_marker(1, 2) != mint_marker(2, 2));
    }

    #[test]
    fn test_class_bounds() {
        assert_unrestricted_asset_id(0);
        assert_unrestricted_asset_id(RESTRICTED_CLASS_BASE - 1);
        assert_restricted_asset_id(RESTRICTED_CLASS_BASE);
        assert_restricted_asset_id(2 * RESTRICTED_CLASS_BASE - 1);
        assert_asset_class(1, false);
        assert_asset_class(RESTRICTED_CLASS_BASE, true);
    }

    #[test(should_fail)]
    fn test_unrestricted_class_rejects_the_restricted_base() {
        assert_unrestricted_asset_id(RESTRICTED_CLASS_BASE);
    }

    #[test(should_fail)]
    fn test_restricted_class_rejects_an_unrestricted_id() {
        assert_restricted_asset_id(RESTRICTED_CLASS_BASE - 1);
    }

    #[test(should_fail)]
    fn test_restricted_class_rejects_zero() {
        assert_restricted_asset_id(0);
    }

    #[test(should_fail)]
    fn test_restricted_class_rejects_2_to_253() {
        assert_restricted_asset_id(2 * RESTRICTED_CLASS_BASE);
    }

    #[test(should_fail_with = "asset ID must be nonzero")]
    fn test_unrestricted_definition_rejects_zero() {
        assert_asset_class(0, false);
    }

    #[test(should_fail)]
    fn test_restricted_definition_rejects_an_unrestricted_id() {
        assert_asset_class(5, true);
    }

    #[test(should_fail)]
    fn test_unrestricted_definition_rejects_a_restricted_id() {
        assert_asset_class(RESTRICTED_CLASS_BASE + 5, false);
    }
}
