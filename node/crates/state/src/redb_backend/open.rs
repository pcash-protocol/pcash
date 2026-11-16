use super::persist::{
    block_bodies, decode_row, persistent_savepoint_ids, read_savepoint_links,
    reconcile_restored_savepoint_links, StoredBlockHistory,
};
use super::{
    backend, height_bounds, meta_value, preflight_read_schema, preflight_write_schema,
    validate_meta_keys, AdoptedForkCompatibility, Bytes, PersistedCheckpoint, RedbState,
    T_ACCOUNT_WRITES, T_ADDRESSES, T_BLOCKS, T_BLOCK_BODIES, T_BLOCK_HASH_INDEX, T_BLOCK_HISTORY,
    T_L1_DELIVERY_BATCHES, T_L1_LOG_LEAVES, T_META, T_NULLIFIERS, T_SAVEPOINTS,
    T_TRANSACTION_EFFECTS, T_TRANSACTION_RESULTS, T_TREES,
};

use crate::codec::Codec;
use crate::field::fr_to_bytes;
use crate::inner::InnerState;
use crate::{CommittedBoundary, DerivationSource, StateError, StoredBlock, TransactionResult};
use redb::{Database, Durability, ReadableDatabase, ReadableTable, ReadableTableMetadata};
use std::collections::{BTreeMap, HashSet};
use std::path::Path;

const EXISTING_DATABASE: &str = "refusing to create canonical state over an existing database";

pub(super) fn validate_restored_checkpoint(
    write: &redb::WriteTransaction,
    checkpoint: &PersistedCheckpoint,
    expected_source: DerivationSource,
) -> Result<(), StateError> {
    preflight_write_schema(write)?;
    {
        let meta = write.open_table(T_META).map_err(backend)?;
        validate_meta_keys(
            meta.iter()
                .map_err(backend)?
                .map(|row| row.map(|(key, _)| key.value().to_vec()).map_err(backend))
                .collect::<Result<Vec<_>, _>>()?,
        )?;
        let get = |key: Bytes| meta_value(&meta, key, "restored state metadata");
        let source: DerivationSource = Codec::decode(&get(b"source")?).map_err(backend)?;
        if source != expected_source {
            return Err(backend(
                "checkpoint savepoint derivation identity does not match the configured source",
            ));
        }
    }

    let (genesis, tip) = {
        let blocks = write.open_table(T_BLOCKS).map_err(backend)?;
        let results = write.open_table(T_TRANSACTION_RESULTS).map_err(backend)?;
        let bodies = write.open_table(T_BLOCK_BODIES).map_err(backend)?;
        let histories = write.open_table(T_BLOCK_HISTORY).map_err(backend)?;
        let hash_index = write.open_table(T_BLOCK_HASH_INDEX).map_err(backend)?;
        let expected_count = checkpoint
            .pcash_block_number
            .checked_add(1)
            .ok_or_else(|| backend("checkpoint block count overflow"))?;
        if blocks.len().map_err(backend)? != expected_count
            || results.len().map_err(backend)? != expected_count
            || histories.len().map_err(backend)? != expected_count
            || hash_index.len().map_err(backend)? != expected_count
        {
            return Err(backend(
                "checkpoint block, result, history, and hash-index counts do not match",
            ));
        }
        let expected_bounds = Some((0, checkpoint.pcash_block_number));
        for table in [&blocks, &results, &histories] {
            let (first, last) = height_bounds(table, "checkpoint")?;
            if first.zip(last) != expected_bounds {
                return Err(backend(
                    "checkpoint block, result, or history height range is not exactly zero through tip",
                ));
            }
        }
        let load = |number: u64| -> Result<CommittedBoundary, StateError> {
            let key = number.to_be_bytes();
            let missing = |row: &str| backend(format!("checkpoint is missing a canonical {row}"));
            let stored: StoredBlock = decode_row(&blocks, &key)?.ok_or_else(|| missing("block"))?;
            let transaction_results: Vec<TransactionResult> =
                decode_row(&results, &key)?.ok_or_else(|| missing("result list"))?;
            let transaction_bytes = block_bodies(&bodies, number)?;
            let state = stored.state;
            let block = stored
                .with_transaction_results(transaction_results)
                .with_transaction_bytes(transaction_bytes);
            let indexed = hash_index
                .get(block.hash.as_slice())
                .map_err(backend)?
                .ok_or_else(|| backend("checkpoint block is missing its hash index"))?;
            if indexed.value() != key {
                return Err(backend("checkpoint block hash index is inconsistent"));
            }
            Ok(decode_row::<StoredBlockHistory>(&histories, &key)?
                .ok_or_else(|| missing("history"))?
                .into_committed(block, state))
        };
        let genesis = load(0)?;
        let tip = load(checkpoint.pcash_block_number)?;
        let parent = (checkpoint.pcash_block_number > 0)
            .then(|| load(checkpoint.pcash_block_number - 1))
            .transpose()?;
        if parent.as_ref().is_some_and(|parent| {
            tip.block.header.parent_hash != parent.block.hash
                || tip.block.header.timestamp < parent.block.header.timestamp
        }) {
            return Err(backend("checkpoint tip does not extend its durable parent"));
        }
        (genesis, tip)
    };

    let expected_l1_number = expected_source
        .genesis_l1_block
        .checked_add(checkpoint.pcash_block_number)
        .ok_or_else(|| backend("checkpoint PCASH-to-L1 block number overflow"))?;
    if checkpoint.finalized_l1_block != expected_l1_number
        || genesis.block.header.number != 0
        || !genesis
            .l1_origin
            .same_block(&expected_source.anchor_origin())
        || genesis.block.header.parent_hash != fr_to_bytes(expected_source.genesis_parent_hash())
        || !genesis.block.is_well_formed(&genesis.history.payouts)
        || tip.block.header.number != checkpoint.pcash_block_number
        || tip.block.hash != checkpoint.pcash_block_hash
        || tip.block.header.timestamp != checkpoint.pcash_block_timestamp
        || tip.l1_origin.block_number != checkpoint.finalized_l1_block
        || tip.l1_origin.block_hash != checkpoint.finalized_l1_hash
        || !tip.block.is_well_formed(&tip.history.payouts)
        || tip.block.header.state_root != fr_to_bytes(tip.state.root)
    {
        return Err(backend(
            "checkpoint savepoint semantic identity does not match the checkpoint",
        ));
    }
    Ok(())
}

impl RedbState {
    /// A handle over an already-opened database, before any canonical rows are
    /// loaded. `open` paths follow this with `reload`.
    fn fresh(db: Database, source: DerivationSource, adopted: AdoptedForkCompatibility) -> Self {
        Self {
            db: std::sync::Arc::new(db),
            inner: InnerState::new(source),
            savepoints: BTreeMap::new(),
            adopted,
            persist_reorg_savepoint: true,
            #[cfg(any(test, feature = "test-support"))]
            fail_next_persist: std::cell::Cell::new(false),
            #[cfg(any(test, feature = "test-support"))]
            fail_next_state_db_read: std::cell::Cell::new(false),
            #[cfg(test)]
            fail_next_atomic_commit: std::cell::Cell::new(false),
        }
    }

    /// Create canonical state at `path`.
    pub fn create(
        path: impl AsRef<Path>,
        source: DerivationSource,
        base_prefix_hash: crate::B256,
    ) -> Result<Self, StateError> {
        let path = path.as_ref();
        if path.exists() {
            return Err(backend(EXISTING_DATABASE));
        }
        Self::create_and_publish(path, source, base_prefix_hash)
    }

    /// Commit the schema in a hidden staging file that only this call
    /// creates, then hard-link it to `path`. The link fails if `path` exists,
    /// so a concurrent creator never replaces another's live database, and a
    /// crash during creation leaves nothing at `path`: at most a staging file,
    /// which nothing reads.
    pub(super) fn create_and_publish(
        path: &Path,
        source: DerivationSource,
        base_prefix_hash: crate::B256,
    ) -> Result<Self, StateError> {
        let mut name = std::ffi::OsString::from(".");
        name.push(
            path.file_name()
                .ok_or_else(|| backend("state database path has no file name"))?,
        );
        let started = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(backend)?;
        name.push(format!(
            ".create.{}.{}",
            std::process::id(),
            started.as_nanos()
        ));
        let staging = path.with_file_name(name);
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&staging)
            .map_err(backend)?;
        let published = Database::builder()
            .create_file(file)
            .map_err(backend)
            .and_then(|db| Self::create_with_database(db, source, base_prefix_hash))
            .and_then(|state| match std::fs::hard_link(&staging, path) {
                Ok(()) => Ok(state),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    Err(backend(EXISTING_DATABASE))
                }
                Err(error) => Err(backend(error)),
            });
        let removed = std::fs::remove_file(&staging).map_err(backend);
        let state = published?;
        removed?;
        let parent = match path.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent,
            _ => Path::new("."),
        };
        std::fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(backend)?;
        Ok(state)
    }

    /// Create canonical state over redb's process-local in-memory backend.
    pub fn create_in_memory(
        source: DerivationSource,
        base_prefix_hash: crate::B256,
    ) -> Result<Self, StateError> {
        let db = Database::builder()
            .create_with_backend(redb::backends::InMemoryBackend::new())
            .map_err(backend)?;
        Self::create_with_database(db, source, base_prefix_hash)
    }

    pub(super) fn create_with_database(
        db: Database,
        source: DerivationSource,
        base_prefix_hash: crate::B256,
    ) -> Result<Self, StateError> {
        let adopted = AdoptedForkCompatibility::base(base_prefix_hash);
        {
            let mut write = db.begin_write().map_err(backend)?;
            write
                .set_durability(Durability::Immediate)
                .map_err(backend)?;
            {
                let mut meta = write.open_table(T_META).map_err(backend)?;
                let source_bytes = source.encode();
                meta.insert(b"source".as_slice(), source_bytes.as_slice())
                    .map_err(backend)?;
                meta.insert(b"adopted".as_slice(), adopted.encode().as_slice())
                    .map_err(backend)?;
            }
            write.open_table(T_TREES).map_err(backend)?;
            write.open_table(T_NULLIFIERS).map_err(backend)?;
            write.open_table(T_ADDRESSES).map_err(backend)?;
            write.open_table(T_ACCOUNT_WRITES).map_err(backend)?;
            write.open_table(T_BLOCKS).map_err(backend)?;
            write.open_table(T_TRANSACTION_RESULTS).map_err(backend)?;
            write.open_table(T_BLOCK_BODIES).map_err(backend)?;
            write.open_table(T_BLOCK_HISTORY).map_err(backend)?;
            write.open_table(T_BLOCK_HASH_INDEX).map_err(backend)?;
            write.open_table(T_L1_DELIVERY_BATCHES).map_err(backend)?;
            write.open_table(T_SAVEPOINTS).map_err(backend)?;
            write.open_table(T_TRANSACTION_EFFECTS).map_err(backend)?;
            write.open_table(T_L1_LOG_LEAVES).map_err(backend)?;
            write.commit().map_err(backend)?;
        }
        Ok(Self::fresh(db, source, adopted))
    }

    pub(super) fn read_identity(
        db: &Database,
    ) -> Result<(DerivationSource, AdoptedForkCompatibility), StateError> {
        preflight_read_schema(db)?;
        let read = db.begin_read().map_err(backend)?;
        let meta = read.open_table(T_META).map_err(backend)?;
        validate_meta_keys(
            meta.iter()
                .map_err(backend)?
                .map(|row| row.map(|(key, _)| key.value().to_vec()).map_err(backend))
                .collect::<Result<Vec<_>, _>>()?,
        )?;
        let get = |key: Bytes| meta_value(&meta, key, "state metadata");
        let source: DerivationSource = Codec::decode(&get(b"source")?).map_err(backend)?;
        let adopted = AdoptedForkCompatibility::decode(&get(b"adopted")?)?;
        Ok((source, adopted))
    }

    /// The stored identity, checked against the configured derivation source
    /// and the adopted fork marker the caller validated against this binary.
    fn read_expected_identity(
        db: &Database,
        expected_source: DerivationSource,
        expected_adopted: AdoptedForkCompatibility,
    ) -> Result<AdoptedForkCompatibility, StateError> {
        let (source, adopted) = Self::read_identity(db)?;
        if source != expected_source {
            return Err(backend(
                "state database derivation source does not match the configured source",
            ));
        }
        if adopted != expected_adopted {
            return Err(StateError::ForkDowngrade);
        }
        Ok(adopted)
    }

    /// The adopted fork marker and the stored derivation source it belongs
    /// to, or `None` when the database has no marker.
    pub fn peek_adopted(
        path: impl AsRef<Path>,
    ) -> Result<Option<(DerivationSource, AdoptedForkCompatibility)>, StateError> {
        let path = path.as_ref();
        if !path.exists() {
            return Ok(None);
        }
        let db = Database::open(path).map_err(backend)?;
        // The adopted marker is the monotonic guard that force-resync must
        // preserve even when the surrounding derived-state schema is obsolete
        // or corrupt. Decode it and its source independently; callers validate
        // the network and accepted prefix against the current binary before
        // reuse.
        let read = db.begin_read().map_err(backend)?;
        let meta = read.open_table(T_META).map_err(backend)?;
        let Some(adopted) = meta.get(b"adopted".as_slice()).map_err(backend)? else {
            return Ok(None);
        };
        let adopted = AdoptedForkCompatibility::decode(adopted.value())?;
        let source: DerivationSource =
            Codec::decode(&meta_value(&meta, b"source", "adopted fork marker source")?)
                .map_err(backend)?;
        Ok(Some((source, adopted)))
    }

    pub fn peek_checkpoint(
        path: impl AsRef<Path>,
    ) -> Result<Option<PersistedCheckpoint>, StateError> {
        let path = path.as_ref();
        if !path.exists() {
            return Ok(None);
        }
        let db = Database::open(path).map_err(backend)?;
        Self::read_identity(&db)?;
        let read = db.begin_read().map_err(backend)?;
        let meta = read.open_table(T_META).map_err(backend)?;
        decode_row(&meta, b"checkpoint")
    }

    pub fn resume(
        path: impl AsRef<Path>,
        expected_source: DerivationSource,
        expected_adopted: AdoptedForkCompatibility,
    ) -> Result<Self, StateError> {
        let db = Database::open(path).map_err(backend)?;
        let adopted = Self::read_expected_identity(&db, expected_source, expected_adopted)?;
        let checkpoint = {
            let read = db.begin_read().map_err(backend)?;
            let meta = read.open_table(T_META).map_err(backend)?;
            let bytes = meta
                .get(b"checkpoint".as_slice())
                .map_err(backend)?
                .ok_or_else(|| backend("resume requires a finalized checkpoint"))?
                .value()
                .to_vec();
            PersistedCheckpoint::decode(&bytes).map_err(backend)?
        };
        let checkpoint_bytes = checkpoint.encode();
        let adopted_bytes = adopted.encode();
        {
            let mut write = db.begin_write().map_err(backend)?;
            write
                .set_durability(Durability::Immediate)
                .map_err(backend)?;
            let savepoint = write
                .get_persistent_savepoint(checkpoint.savepoint_id)
                .map_err(backend)?;
            write.restore_savepoint(&savepoint).map_err(backend)?;
            if let Err(error) = validate_restored_checkpoint(&write, &checkpoint, expected_source) {
                write.abort().map_err(backend)?;
                return Err(error);
            }
            reconcile_restored_savepoint_links(
                &write,
                checkpoint.finalized_l1_block,
                checkpoint.savepoint_id,
            )?;
            {
                let mut meta = write.open_table(T_META).map_err(backend)?;
                meta.insert(b"checkpoint".as_slice(), checkpoint_bytes.as_slice())
                    .map_err(backend)?;
                meta.insert(b"adopted".as_slice(), adopted_bytes.as_slice())
                    .map_err(backend)?;
            }
            write.commit().map_err(backend)?;
        }
        let mut state = Self::fresh(db, expected_source, adopted);
        state.reload(expected_source)?;
        state.savepoints = read_savepoint_links(&state.db)?;
        Ok(state)
    }

    /// Opens an existing canonical store that has not yet reached finality.
    ///
    /// Unlike [`Self::resume`], this does not restore a checkpoint. It checks
    /// the store's identity, reloads the in-memory state, and checks that the
    /// rollback-savepoint links match redb's savepoints and the stored blocks,
    /// keeping the L1-to-savepoint map needed for subsequent rewind and replay.
    /// It does not revalidate block rows.
    pub fn open(
        path: impl AsRef<Path>,
        expected_source: DerivationSource,
        expected_adopted: AdoptedForkCompatibility,
    ) -> Result<Self, StateError> {
        let db = Database::open(path).map_err(backend)?;
        let adopted = Self::read_expected_identity(&db, expected_source, expected_adopted)?;
        {
            let read = db.begin_read().map_err(backend)?;
            let meta = read.open_table(T_META).map_err(backend)?;
            if meta
                .get(b"checkpoint".as_slice())
                .map_err(backend)?
                .is_some()
            {
                return Err(backend(
                    "open requires a store without a finalized checkpoint",
                ));
            }
        }

        let mut state = Self::fresh(db, expected_source, adopted);
        state.reload(expected_source)?;

        let links = read_savepoint_links(&state.db)?;
        let persistent_ids = persistent_savepoint_ids(&state.db)?;
        if links.values().copied().collect::<HashSet<_>>() != persistent_ids {
            return Err(backend(
                "rollback-savepoint associations do not match persistent savepoints",
            ));
        }
        match state.inner.canonical_tip.as_ref() {
            None if !links.is_empty() => {
                return Err(backend("an empty canonical store has rollback savepoints"));
            }
            Some(tip) => {
                for number in 0..tip.header.number {
                    let l1_block = expected_source
                        .genesis_l1_block
                        .checked_add(number)
                        .ok_or_else(|| backend("canonical PCASH-to-L1 number overflow"))?;
                    if !links.contains_key(&l1_block) {
                        return Err(backend(
                            "a non-tip canonical boundary has no rollback savepoint",
                        ));
                    }
                }
                for &l1_block in links.keys() {
                    let number = l1_block
                        .checked_sub(expected_source.genesis_l1_block)
                        .ok_or_else(|| backend("rollback savepoint precedes derivation anchor"))?;
                    if number > tip.header.number
                        || state
                            .stored_block(number)?
                            .is_none_or(|block| block.l1_origin.block_number != l1_block)
                    {
                        return Err(backend(
                            "rollback savepoint does not identify a canonical boundary",
                        ));
                    }
                }
            }
            None => {}
        }
        state.savepoints = links;
        Ok(state)
    }
}
