//! The Aster fork: the rule set every PCASH network launches on.
//!
//! A fork is a name and an activation timestamp. The name is a human label for
//! release notes and status output; it enters no commitment, and nothing in
//! consensus is keyed by it. Aster is active from genesis, so it has no
//! activation timestamp at all.
//!
//! Aster accepts batch version 1 and transaction types 0 through 3. A transaction
//! type identifies its payload family; private value selects an S/L subtype.
//! Each compiled subtype has its own verifier, and a later fork
//! may retire it for new blocks. Historical Aster transactions always retain their
//! original meaning.

pub(crate) const ASTER_PRIVATE_VALUE_HIDING_KERNEL_VK: &[u8] = include_bytes!(concat!(
    env!("PCASH_CIRCUIT_BUNDLE"),
    "/vks/private_value_hiding_kernel.chonk.vk"
));
pub(crate) const ASTER_LARGE_PRIVATE_VALUE_HIDING_KERNEL_VK: &[u8] = include_bytes!(concat!(
    env!("PCASH_CIRCUIT_BUNDLE"),
    "/vks/private_value_large_hiding_kernel.chonk.vk"
));
pub(crate) const ASTER_USER_ACCOUNT_UPDATE_HIDING_KERNEL_VK: &[u8] = include_bytes!(concat!(
    env!("PCASH_CIRCUIT_BUNDLE"),
    "/vks/user_account_update_hiding_kernel.chonk.vk"
));
