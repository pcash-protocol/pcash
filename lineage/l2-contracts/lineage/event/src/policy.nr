use pcash_protocol::primitives::hash::pcash_hash;
use pcash_protocol::state::merkle::binary_root_from_index;

pub global POLICY_TREE_DEPTH: u32 = 32;
pub global LINEAGE_CLAIM_DOMAIN: Field = 0x70636173685f6c696e656167655f636c61696d;
pub global LINEAGE_POLICY_DOMAIN: Field = 0x70636173685f6c696e656167655f706f6c696379;
pub global LINEAGE_SOURCE_DOMAIN: Field = 0x70636173685f6c696e656167655f736f75726365;
pub global LINEAGE_DENY_GAP_DOMAIN: Field = 0x70636173685f6c696e656167655f64656e795f676170;

pub struct PolicyPath {
    pub index: u32,
    pub siblings: [Field; POLICY_TREE_DEPTH],
}

pub struct DenyGap {
    pub lower_present: bool,
    pub lower: Field,
    pub upper_present: bool,
    pub upper: Field,
    pub path: PolicyPath,
}

pub fn lineage_claim(root: Field, lineage_vk_identity: Field, qualification_mask: Field) -> Field {
    pcash_hash(
        [LINEAGE_CLAIM_DOMAIN, root, lineage_vk_identity, qualification_mask],
    )
}

pub fn policy_root(provider: Field, approved_sources_root: Field, deny_gaps_root: Field) -> Field {
    pcash_hash(
        [LINEAGE_POLICY_DOMAIN, provider, approved_sources_root, deny_gaps_root],
    )
}

pub fn policy_path(leaf: Field, path: PolicyPath) -> Field {
    binary_root_from_index(leaf, path.index as Field, path.siblings)
}

pub fn approved_source(root: Field, commitment: Field, path: PolicyPath) {
    assert(
        policy_path(pcash_hash([LINEAGE_SOURCE_DOMAIN, commitment]), path) == root,
        "source must be approved by the policy",
    );
}

pub fn deny_gap_leaf(gap: DenyGap) -> Field {
    pcash_hash([
        LINEAGE_DENY_GAP_DOMAIN,
        gap.lower_present as Field,
        gap.lower,
        gap.upper_present as Field,
        gap.upper,
    ])
}

pub fn not_denied(root: Field, commitment: Field, gap: DenyGap) {
    assert(
        !gap.lower_present | gap.lower.lt(commitment),
        "input must be above the denied lower bound",
    );
    assert(
        !gap.upper_present | commitment.lt(gap.upper),
        "input must be below the denied upper bound",
    );
    assert(
        policy_path(deny_gap_leaf(gap), gap.path) == root,
        "deny gap must be authenticated by the policy",
    );
}

mod tests {
    use super::lineage_claim;
    // Deny gaps order commitments as canonical integers, as the policy builder sorts them.
    #[test]
    fn canonical_field_order() {
        assert((1 as Field).lt(2));
        assert(!(2 as Field).lt(1));
        assert(!(2 as Field).lt(2));
        assert((0 as Field).lt(-1));
        assert(!(-1 as Field).lt(0));
        assert((0xffffffffffffffffffffffffffffffff as Field).lt(0x100000000000000000000000000000000));
    }
    #[test]
    fn claims_bind_policy_application_and_slots() {
        assert(lineage_claim(1, 2, 3) != lineage_claim(2, 2, 3));
        assert(lineage_claim(1, 2, 3) != lineage_claim(1, 3, 3));
        assert(lineage_claim(1, 2, 3) != lineage_claim(1, 2, 4));
    }
}
