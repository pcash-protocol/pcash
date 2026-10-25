//! Persistent canonical state backend.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "database schema and fixed-width values are validated at backend boundaries"
)]

use crate::inner::InnerState;
use crate::{DerivationSource, StateError, B256};
use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition, TableHandle};
use std::collections::{BTreeMap, HashSet};

mod account_writes;
mod accounts;
mod impl_state_db;
mod nullifiers;
mod open;
mod persist;
mod read;
pub use read::{RedbReadSnapshot, RedbStateReader};

pub(super) type Bytes = &'static [u8];
pub(super) const T_META: TableDefinition<&[u8], &[u8]> = TableDefinition::new("meta");
pub(super) const T_TREES: TableDefinition<&[u8], &[u8]> = TableDefinition::new("poseidon_trees");
/// Every spent nullifier by its 32-byte value, holding its big-endian `u64`
/// leaf index. Keys sort as the values do, so a range read finds a value's
/// neighbours. The tree's nodes are in [`T_TREES`] under [`NULLIFIER_TREE_ID`].
pub(super) const T_NULLIFIERS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("nullifiers");
pub(super) const NULLIFIER_TREE_ID: u8 = crate::inner::NULLIFIER_TREE_ID as u8;
pub(super) const T_ADDRESSES: TableDefinition<&[u8], &[u8]> = TableDefinition::new("address_rows");
/// Every account write by `pcashBlockNumber || ordinal`, in application order.
pub(super) const T_ACCOUNT_WRITES: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("account_writes");
/// Per PCASH block: its fixed-size [`crate::StoredBlock`].
pub(super) const T_BLOCKS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("pcash_blocks");
/// Per PCASH block: its transaction results, empty for an empty block.
pub(super) const T_TRANSACTION_RESULTS: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("transaction_results");
pub(super) const T_BLOCK_BODIES: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("pcash_block_bodies");
/// Per PCASH block: its canonical history and state-transition outcome.
pub(super) const T_BLOCK_HISTORY: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("block_history");
pub(super) const T_BLOCK_HASH_INDEX: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("block_hash_index");
pub(super) const T_L1_DELIVERY_BATCHES: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("l1_delivery_batches");
pub(super) const T_SAVEPOINTS: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("rollback_savepoints");
/// Per PCASH block: the effects of every admitted transaction.
pub(super) const T_TRANSACTION_EFFECTS: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("transaction_effects");
/// Per PCASH block: its L1 origin's logs in leaf order.
pub(super) const T_L1_LOG_LEAVES: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("l1_log_leaves");

pub(super) const REQUIRED_TABLES: [&str; 14] = [
    "account_writes",
    "address_rows",
    "meta",
    "nullifiers",
    "pcash_blocks",
    "transaction_results",
    "pcash_block_bodies",
    "block_hash_index",
    "l1_delivery_batches",
    "poseidon_trees",
    "block_history",
    "rollback_savepoints",
    "transaction_effects",
    "l1_log_leaves",
];
pub(super) const REQUIRED_META_KEYS: [&[u8]; 2] = [b"adopted", b"source"];
pub(super) const ADOPTED_LEN: usize = 4 + 32;

pub(super) fn backend(error: impl std::fmt::Display) -> StateError {
    StateError::Backend(error.to_string())
}

pub(super) fn validate_table_names(
    tables: Vec<String>,
    multimap_count: usize,
) -> Result<(), StateError> {
    let present = tables.iter().map(String::as_str).collect::<HashSet<_>>();
    if multimap_count != 0
        || present.len() != tables.len()
        || present != REQUIRED_TABLES.into_iter().collect::<HashSet<_>>()
    {
        return Err(backend("incompatible state database table schema"));
    }
    Ok(())
}

pub(super) fn validate_meta_keys(keys: Vec<Vec<u8>>) -> Result<(), StateError> {
    let present = keys.iter().map(Vec::as_slice).collect::<HashSet<_>>();
    let required = REQUIRED_META_KEYS.into_iter().collect::<HashSet<_>>();
    // `checkpoint` is written only once a restart anchor exists, so it is the
    // one key that may be absent and the one extra key that may be present.
    if present.len() != keys.len()
        || !required.is_subset(&present)
        || present
            .difference(&required)
            .any(|key| *key != b"checkpoint")
    {
        return Err(backend("incompatible state database metadata schema"));
    }
    Ok(())
}

/// One required metadata value, or a backend error naming the missing key.
pub(super) fn meta_value(
    meta: &impl ReadableTable<&'static [u8], &'static [u8]>,
    key: Bytes,
    label: &str,
) -> Result<Vec<u8>, StateError> {
    Ok(meta
        .get(key)
        .map_err(backend)?
        .ok_or_else(|| backend(format!("missing {label} {key:?}")))?
        .value()
        .to_vec())
}

/// The first and last big-endian `u64` height keys in a height-keyed table.
pub(super) fn height_bounds(
    table: &impl ReadableTable<&'static [u8], &'static [u8]>,
    label: &str,
) -> Result<(Option<u64>, Option<u64>), StateError> {
    let height = |key: &[u8]| {
        key.try_into()
            .map(u64::from_be_bytes)
            .map_err(|_| backend(format!("{label} height key is malformed")))
    };
    let first = table
        .first()
        .map_err(backend)?
        .map(|(key, _)| height(key.value()))
        .transpose()?;
    let last = table
        .last()
        .map_err(backend)?
        .map(|(key, _)| height(key.value()))
        .transpose()?;
    Ok((first, last))
}

pub(super) fn preflight_read_schema(db: &Database) -> Result<(), StateError> {
    let read = db.begin_read().map_err(backend)?;
    let tables = read
        .list_tables()
        .map_err(backend)?
        .map(|table| table.name().to_owned())
        .collect();
    let multimap_count = read.list_multimap_tables().map_err(backend)?.count();
    validate_table_names(tables, multimap_count)
}

pub(super) fn preflight_write_schema(write: &redb::WriteTransaction) -> Result<(), StateError> {
    let tables = write
        .list_tables()
        .map_err(backend)?
        .map(|table| table.name().to_owned())
        .collect();
    let multimap_count = write.list_multimap_tables().map_err(backend)?.count();
    validate_table_names(tables, multimap_count)
}

pub(super) fn to32(bytes: &[u8]) -> Result<[u8; 32], StateError> {
    bytes
        .try_into()
        .map_err(|_| backend("expected a 32-byte value"))
}

/// The monotonic fork-adoption floor of one state database. The network it
/// belongs to is the database's stored derivation source.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AdoptedForkCompatibility {
    pub adopted_fork_count: u32,
    pub adopted_prefix_hash: B256,
}

impl AdoptedForkCompatibility {
    pub fn base(base_prefix_hash: B256) -> Self {
        Self {
            adopted_fork_count: 0,
            adopted_prefix_hash: base_prefix_hash,
        }
    }

    pub(super) fn encode(self) -> [u8; ADOPTED_LEN] {
        let mut encoded = [0u8; ADOPTED_LEN];
        encoded[0..4].copy_from_slice(&self.adopted_fork_count.to_be_bytes());
        encoded[4..].copy_from_slice(self.adopted_prefix_hash.as_slice());
        encoded
    }

    pub(super) fn decode(bytes: &[u8]) -> Result<Self, StateError> {
        let Some((count, prefix_hash)) = bytes
            .split_first_chunk::<4>()
            .filter(|(_, prefix_hash)| prefix_hash.len() == 32)
        else {
            return Err(StateError::InvalidForkAdoption);
        };
        Ok(Self {
            adopted_fork_count: u32::from_be_bytes(*count),
            adopted_prefix_hash: B256::from_slice(prefix_hash),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersistedCheckpoint {
    pub finalized_l1_block: u64,
    pub finalized_l1_hash: B256,
    pub pcash_block_number: u64,
    pub pcash_block_hash: B256,
    pub pcash_block_timestamp: u64,
    pub fork_schedule_prefix_hash: B256,
    pub savepoint_id: u64,
}

crate::codec::codec_struct!(PersistedCheckpoint {
    finalized_l1_block,
    finalized_l1_hash,
    pcash_block_number,
    pcash_block_hash,
    pcash_block_timestamp,
    fork_schedule_prefix_hash,
    savepoint_id,
});

pub struct RedbState {
    pub(super) db: std::sync::Arc<Database>,
    pub(super) inner: InnerState,
    pub(super) savepoints: BTreeMap<u64, u64>,
    pub(super) adopted: AdoptedForkCompatibility,
    /// When true (the default), each commit fsyncs and records a reorg
    /// savepoint for the parent. Catch-up turns this off: those blocks are
    /// already L1-finalized, so a later `advance_finalized` is the durable
    /// commit.
    pub(super) persist_reorg_savepoint: bool,
    #[cfg(any(test, feature = "test-support"))]
    pub(super) fail_next_persist: std::cell::Cell<bool>,
    #[cfg(any(test, feature = "test-support"))]
    pub(super) fail_next_state_db_read: std::cell::Cell<bool>,
    #[cfg(test)]
    pub(super) fail_next_atomic_commit: std::cell::Cell<bool>,
}

#[cfg(test)]
mod tests;
