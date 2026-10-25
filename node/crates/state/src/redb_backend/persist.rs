use super::account_writes::{account_write_key, encode_account_write_row};
use super::{
    backend, to32, AdoptedForkCompatibility, PersistedCheckpoint, RedbState, NULLIFIER_TREE_ID,
    T_ACCOUNT_WRITES, T_ADDRESSES, T_BLOCKS, T_BLOCK_BODIES, T_BLOCK_HASH_INDEX, T_BLOCK_HISTORY,
    T_L1_DELIVERY_BATCHES, T_L1_LOG_LEAVES, T_META, T_NULLIFIERS, T_SAVEPOINTS,
    T_TRANSACTION_EFFECTS, T_TRANSACTION_RESULTS, T_TREES,
};

use crate::codec::{codec_struct, encode_list, Codec};
use crate::field::{fr_from_internal_word, fr_to_bytes};
use crate::inner::{recent_window_start, InnerState, RecentBlockEntry, RecentBlockHistory};
use crate::{
    l1_origin_leaf, CommittedBoundary, DerivationSource, Fr, L1LogLeaf, NullifierTree, PcashBlock,
    PcashBlockMetadata, StateCommitment, StateComponents, StateError, StateOutcome, StateRoot,
    StoredBlock, TransactionEffects, B256, TREE_DEPTH,
};
use redb::{
    Database, Durability, ReadTransaction, ReadableDatabase, ReadableTable, ReadableTableMetadata,
};
use std::collections::{BTreeMap, HashSet};

pub(super) fn tree_node_key(id: u8, level: u8, index: u64) -> [u8; 10] {
    let mut key = [0u8; 10];
    key[0] = id;
    key[1] = level;
    key[2..].copy_from_slice(&index.to_be_bytes());
    key
}

pub(super) fn block_body_key(number: u64, transaction_index: u64) -> [u8; 16] {
    let mut key = [0u8; 16];
    key[..8].copy_from_slice(&number.to_be_bytes());
    key[8..].copy_from_slice(&transaction_index.to_be_bytes());
    key
}

/// The decoded value at `key`, if the row exists.
pub(super) fn decode_row<T: Codec>(
    table: &impl ReadableTable<&'static [u8], &'static [u8]>,
    key: &[u8],
) -> Result<Option<T>, StateError> {
    table
        .get(key)
        .map_err(backend)?
        .map(|value| T::decode(value.value()).map_err(backend))
        .transpose()
}

/// The canonical height of a block hash.
pub(super) fn indexed_block_number(
    index: &impl ReadableTable<&'static [u8], &'static [u8]>,
    hash: B256,
) -> Result<Option<u64>, StateError> {
    index
        .get(hash.as_slice())
        .map_err(backend)?
        .map(|value| {
            value
                .value()
                .try_into()
                .map(u64::from_be_bytes)
                .map_err(|_| backend("block-hash index value is malformed"))
        })
        .transpose()
}

/// Every transaction body of block `number`, in ordinal order.
pub(super) fn block_bodies(
    bodies: &impl ReadableTable<&'static [u8], &'static [u8]>,
    number: u64,
) -> Result<Vec<Vec<u8>>, StateError> {
    let start = block_body_key(number, 0);
    let end = block_body_key(number, u64::MAX);
    bodies
        .range(start.as_slice()..=end.as_slice())
        .map_err(backend)?
        .map(|row| row.map(|(_, body)| body.value().to_vec()).map_err(backend))
        .collect()
}

pub(super) fn read_stored_block(
    read: &ReadTransaction,
    number: u64,
) -> Result<Option<StoredBlock>, StateError> {
    let blocks = read.open_table(T_BLOCKS).map_err(backend)?;
    decode_row(&blocks, &number.to_be_bytes())
}

pub(super) fn read_stored_block_by_hash(
    read: &ReadTransaction,
    hash: B256,
) -> Result<Option<StoredBlock>, StateError> {
    let index = read.open_table(T_BLOCK_HASH_INDEX).map_err(backend)?;
    match indexed_block_number(&index, hash)? {
        Some(number) => read_stored_block(read, number),
        None => Ok(None),
    }
}

fn with_transaction_results(
    read: &ReadTransaction,
    block: StoredBlock,
) -> Result<PcashBlockMetadata, StateError> {
    let results = read.open_table(T_TRANSACTION_RESULTS).map_err(backend)?;
    let transaction_results = decode_row(&results, &block.header.number.to_be_bytes())?
        .ok_or_else(|| backend("canonical block is missing its transaction results"))?;
    Ok(block.with_transaction_results(transaction_results))
}

fn with_transaction_bytes(
    read: &ReadTransaction,
    metadata: PcashBlockMetadata,
) -> Result<PcashBlock, StateError> {
    let bodies = read.open_table(T_BLOCK_BODIES).map_err(backend)?;
    let transaction_bytes = block_bodies(&bodies, metadata.header.number)?;
    Ok(metadata.with_transaction_bytes(transaction_bytes))
}

pub(super) fn read_block_metadata(
    read: &ReadTransaction,
    number: u64,
) -> Result<Option<PcashBlockMetadata>, StateError> {
    read_stored_block(read, number)?
        .map(|block| with_transaction_results(read, block))
        .transpose()
}

pub(super) fn read_block(
    read: &ReadTransaction,
    number: u64,
) -> Result<Option<PcashBlock>, StateError> {
    read_block_metadata(read, number)?
        .map(|metadata| with_transaction_bytes(read, metadata))
        .transpose()
}

pub(super) fn read_block_history(
    read: &ReadTransaction,
    number: u64,
) -> Result<Option<StoredBlockHistory>, StateError> {
    let history = read.open_table(T_BLOCK_HISTORY).map_err(backend)?;
    decode_row(&history, &number.to_be_bytes())
}

pub(super) fn read_committed_boundary(
    read: &ReadTransaction,
    number: u64,
) -> Result<Option<CommittedBoundary>, StateError> {
    let Some(stored) = read_stored_block(read, number)? else {
        return Ok(None);
    };
    let state = stored.state;
    let block = with_transaction_bytes(read, with_transaction_results(read, stored)?)?;
    Ok(Some(
        read_block_history(read, number)?
            .ok_or_else(|| backend("canonical block is missing its history"))?
            .into_committed(block, state),
    ))
}

pub(super) fn persisted_tree_node(
    table: &redb::ReadOnlyTable<&[u8], &[u8]>,
    id: u8,
    height: u8,
    index: u64,
) -> Result<Fr, StateError> {
    let key = tree_node_key(id, height, index);
    let value = table
        .get(key.as_slice())
        .map_err(backend)?
        .ok_or_else(|| backend("persisted append-only tree node is missing"))?;
    Ok(fr_from_internal_word(B256::from(to32(value.value())?)))
}

pub(super) fn persisted_append_node_at(
    table: &redb::ReadOnlyTable<&[u8], &[u8]>,
    id: u8,
    last_included_index: u64,
    height: u8,
    index: u64,
) -> Result<Fr, StateError> {
    let subtree_start = index << height;
    if last_included_index < subtree_start {
        return Ok(pcash_crypto::merkle::empty(height as usize));
    }
    let subtree_end = subtree_start + (1u64 << height) - 1;
    if last_included_index >= subtree_end {
        return persisted_tree_node(table, id, height, index);
    }
    if height == 0 {
        return Err(backend("append-only prefix partially intersects a leaf"));
    }
    let child_height = height - 1;
    Ok(pcash_crypto::poseidon(&[
        persisted_append_node_at(table, id, last_included_index, child_height, index << 1)?,
        persisted_append_node_at(
            table,
            id,
            last_included_index,
            child_height,
            (index << 1) | 1,
        )?,
    ]))
}

pub(super) fn read_savepoint_links(db: &Database) -> Result<BTreeMap<u64, u64>, StateError> {
    let read = db.begin_read().map_err(backend)?;
    let table = read.open_table(T_SAVEPOINTS).map_err(backend)?;
    let mut links = BTreeMap::new();
    let mut ids = HashSet::new();
    for row in table.iter().map_err(backend)? {
        let (key, value) = row.map_err(backend)?;
        if key.value().len() != 8 || value.value().len() != 8 {
            return Err(backend("rollback-savepoint row has unexpected length"));
        }
        let l1_block = u64::from_be_bytes(key.value().try_into().unwrap());
        let savepoint_id = u64::from_be_bytes(value.value().try_into().unwrap());
        if links.insert(l1_block, savepoint_id).is_some() || !ids.insert(savepoint_id) {
            return Err(backend(
                "rollback-savepoint associations are not one-to-one",
            ));
        }
    }
    Ok(links)
}

pub(super) fn persistent_savepoint_ids(db: &Database) -> Result<HashSet<u64>, StateError> {
    let write = db.begin_write().map_err(backend)?;
    let ids = write
        .list_persistent_savepoints()
        .map_err(backend)?
        .collect::<Vec<_>>();
    for &id in &ids {
        drop(write.get_persistent_savepoint(id).map_err(backend)?);
    }
    Ok(ids.into_iter().collect())
}

pub(super) fn reconcile_restored_savepoint_links(
    write: &redb::WriteTransaction,
    l1_block: u64,
    savepoint_id: u64,
) -> Result<(), StateError> {
    let valid_ids = write
        .list_persistent_savepoints()
        .map_err(backend)?
        .collect::<HashSet<_>>();
    if !valid_ids.contains(&savepoint_id) {
        return Err(backend(
            "restored rollback savepoint is no longer persistent",
        ));
    }

    let mut links = write.open_table(T_SAVEPOINTS).map_err(backend)?;
    let rows = links
        .iter()
        .map_err(backend)?
        .map(|row| {
            let (key, value) = row.map_err(backend)?;
            if key.value().len() != 8 || value.value().len() != 8 {
                return Err(backend("rollback-savepoint row has unexpected length"));
            }
            Ok((
                key.value().to_vec(),
                u64::from_be_bytes(key.value().try_into().unwrap()),
                u64::from_be_bytes(value.value().try_into().unwrap()),
            ))
        })
        .collect::<Result<Vec<_>, StateError>>()?;
    let mut retained_ids = HashSet::new();
    for (key, linked_block, linked_id) in rows {
        if linked_block > l1_block || !valid_ids.contains(&linked_id) {
            links.remove(key.as_slice()).map_err(backend)?;
        } else if !retained_ids.insert(linked_id) {
            return Err(backend(
                "rollback-savepoint associations are not one-to-one",
            ));
        }
    }
    let existing_id = links
        .get(l1_block.to_be_bytes().as_slice())
        .map_err(backend)?
        .map(|value| u64::from_be_bytes(value.value().try_into().unwrap()));
    if let Some(existing_id) = existing_id {
        if existing_id != savepoint_id {
            return Err(backend(
                "restored rollback-savepoint association names a different savepoint",
            ));
        }
    } else if retained_ids.contains(&savepoint_id) {
        return Err(backend(
            "rollback savepoint is associated with two L1 blocks",
        ));
    } else {
        links
            .insert(
                l1_block.to_be_bytes().as_slice(),
                savepoint_id.to_be_bytes().as_slice(),
            )
            .map_err(backend)?;
        retained_ids.insert(savepoint_id);
    }
    if retained_ids != valid_ids {
        return Err(backend(
            "restored rollback-savepoint associations are incomplete",
        ));
    }
    Ok(())
}

/// A block's canonical history and state-transition outcome. Its state
/// components live in the block's [`StoredBlock`].
#[derive(Debug, PartialEq, Eq)]
pub(super) struct StoredBlockHistory {
    pub(super) history: crate::CanonicalBlockHistory,
    pub(super) output_leaf_start: u64,
    pub(super) outputs_added: u64,
    pub(super) inserted_nullifiers: Vec<B256>,
}

codec_struct!(StoredBlockHistory {
    history,
    output_leaf_start,
    outputs_added,
    inserted_nullifiers,
});

impl StoredBlockHistory {
    pub(super) fn from_committed(boundary: &CommittedBoundary) -> Self {
        Self {
            history: boundary.history.clone(),
            output_leaf_start: boundary.state_outcome.output_leaf_start,
            outputs_added: boundary.state_outcome.outputs_added,
            inserted_nullifiers: boundary.state_outcome.inserted_nullifiers.clone(),
        }
    }

    pub(super) fn into_committed(
        self,
        block: PcashBlock,
        state: StateComponents,
    ) -> CommittedBoundary {
        CommittedBoundary {
            history: self.history,
            l1_origin: block.l1_origin.clone(),
            state: StateCommitment::new(state),
            state_outcome: StateOutcome {
                state_root: StateRoot(block.header.state_root),
                output_leaf_start: self.output_leaf_start,
                outputs_added: self.outputs_added,
                inserted_nullifiers: self.inserted_nullifiers,
            },
            block,
        }
    }
}

impl RedbState {
    pub fn adopted_fork_compatibility(&self) -> AdoptedForkCompatibility {
        self.adopted
    }

    pub fn advance_adopted_fork(
        &mut self,
        adopted_fork_count: u32,
        adopted_prefix_hash: B256,
    ) -> Result<(), StateError> {
        if adopted_fork_count < self.adopted.adopted_fork_count {
            return Err(StateError::ForkDowngrade);
        }
        if adopted_fork_count == self.adopted.adopted_fork_count {
            return if adopted_prefix_hash == self.adopted.adopted_prefix_hash {
                Ok(())
            } else {
                Err(StateError::InvalidForkAdoption)
            };
        }
        let next = AdoptedForkCompatibility {
            adopted_fork_count,
            adopted_prefix_hash,
        };
        let mut write = self.db.begin_write().map_err(backend)?;
        write
            .set_durability(Durability::Immediate)
            .map_err(backend)?;
        {
            let mut meta = write.open_table(T_META).map_err(backend)?;
            meta.insert(b"adopted".as_slice(), next.encode().as_slice())
                .map_err(backend)?;
        }
        write.commit().map_err(backend)?;
        self.adopted = next;
        Ok(())
    }

    pub fn advance_finalized(
        &mut self,
        finalized_l1_block: u64,
        finalized_l1_hash: B256,
        fork_schedule_prefix_hash: B256,
    ) -> Result<(), StateError> {
        let pcash_number = finalized_l1_block
            .checked_sub(self.inner.source.genesis_l1_block)
            .ok_or_else(|| backend("finalized block precedes derivation anchor"))?;
        let block = self
            .stored_block(pcash_number)?
            .ok_or(StateError::MissingCanonicalBoundary(pcash_number))?;
        if block.l1_origin.block_number != finalized_l1_block
            || block.l1_origin.block_hash != finalized_l1_hash
        {
            return Err(backend(
                "finalized L1 identity does not match PCASH attachment",
            ));
        }
        let existing_savepoint_id = self.savepoints.get(&finalized_l1_block).copied();
        if existing_savepoint_id.is_none()
            && self
                .inner
                .canonical_tip
                .as_ref()
                .is_none_or(|tip| tip.l1_origin.block_number != finalized_l1_block)
        {
            return Err(StateError::SavepointNotFound(finalized_l1_block));
        }
        let obsolete: Vec<_> = self
            .savepoints
            .range(..finalized_l1_block)
            .map(|(&block, &id)| (block, id))
            .collect();
        let mut write = self.db.begin_write().map_err(backend)?;
        write
            .set_durability(Durability::Immediate)
            .map_err(backend)?;
        let savepoint_id = match existing_savepoint_id {
            Some(id) => id,
            None => write.persistent_savepoint().map_err(backend)?,
        };
        let checkpoint = PersistedCheckpoint {
            finalized_l1_block,
            finalized_l1_hash,
            pcash_block_number: pcash_number,
            pcash_block_hash: block.hash,
            pcash_block_timestamp: block.header.timestamp,
            fork_schedule_prefix_hash,
            savepoint_id,
        };
        let checkpoint_bytes = checkpoint.encode();
        {
            let mut meta = write.open_table(T_META).map_err(backend)?;
            meta.insert(b"checkpoint".as_slice(), checkpoint_bytes.as_slice())
                .map_err(backend)?;
        }
        {
            let mut savepoints = write.open_table(T_SAVEPOINTS).map_err(backend)?;
            if existing_savepoint_id.is_none() {
                savepoints
                    .insert(
                        finalized_l1_block.to_be_bytes().as_slice(),
                        savepoint_id.to_be_bytes().as_slice(),
                    )
                    .map_err(backend)?;
            }
            for (block, _) in &obsolete {
                savepoints
                    .remove(block.to_be_bytes().as_slice())
                    .map_err(backend)?;
            }
        }
        for (_, id) in &obsolete {
            write.delete_persistent_savepoint(*id).map_err(backend)?;
        }
        write.commit().map_err(backend)?;
        if existing_savepoint_id.is_none() {
            self.savepoints.insert(finalized_l1_block, savepoint_id);
        }
        for (block, _) in obsolete {
            self.savepoints.remove(&block);
        }
        Ok(())
    }

    pub fn canonical_genesis_hash(&self) -> Option<B256> {
        self.inner.canonical_genesis_hash
    }

    /// Stream the durable block rows and recheck them. Per block: the row
    /// counts of the block, result, history, hash-index and body tables; block
    /// numbering and well-formedness; the L1 origin, and at genesis the anchor
    /// origin and the source's parent hash; the hash-index entry; the append-only Ethereum and history
    /// roots; the state components' root and output count; and parent linkage
    /// and timestamp order. The stream must end at the live tip with matching
    /// append-only roots. Checkpoint resume checks only the restored tip, its
    /// parent, and genesis. Every reopen and savepoint restore rebuilds the
    /// recent-block window from the block records.
    pub fn audit_full_history(&self) -> Result<(), StateError> {
        let read = self.db.begin_read().map_err(backend)?;
        let blocks = read.open_table(T_BLOCKS).map_err(backend)?;
        let results = read.open_table(T_TRANSACTION_RESULTS).map_err(backend)?;
        let bodies = read.open_table(T_BLOCK_BODIES).map_err(backend)?;
        let histories = read.open_table(T_BLOCK_HISTORY).map_err(backend)?;
        let hash_index = read.open_table(T_BLOCK_HASH_INDEX).map_err(backend)?;
        let count = blocks.len().map_err(backend)?;
        if results.len().map_err(backend)? != count
            || histories.len().map_err(backend)? != count
            || hash_index.len().map_err(backend)? != count
        {
            return Err(backend("durable history row counts disagree"));
        }
        let mut l1_origin = crate::SparseTree::new(TREE_DEPTH);
        let mut history = crate::SparseTree::new(TREE_DEPTH);
        let mut previous: Option<StoredBlock> = None;
        let mut expected_number = 0u64;
        let mut expected_body_count = 0u64;
        for row in blocks.iter().map_err(backend)? {
            let (key, value) = row.map_err(backend)?;
            if key.value().len() != 8 {
                return Err(backend("canonical block key is malformed"));
            }
            let number = u64::from_be_bytes(key.value().try_into().unwrap());
            let stored = StoredBlock::decode(value.value()).map_err(backend)?;
            let transaction_results: Vec<crate::TransactionResult> =
                decode_row(&results, key.value())?
                    .ok_or_else(|| backend("canonical block is missing its transaction results"))?;
            let transaction_bytes = block_bodies(&bodies, number)?;
            let block = stored
                .clone()
                .with_transaction_results(transaction_results)
                .with_transaction_bytes(transaction_bytes);
            expected_body_count = expected_body_count
                .checked_add(block.transaction_bytes.len() as u64)
                .ok_or_else(|| backend("canonical body count overflow"))?;
            let boundary = decode_row::<StoredBlockHistory>(&histories, key.value())?
                .ok_or_else(|| backend("canonical block is missing its history"))?
                .into_committed(block, stored.state);
            let block = &boundary.block;
            let indexed = hash_index
                .get(block.hash.as_slice())
                .map_err(backend)?
                .ok_or_else(|| backend("canonical block is missing its hash index"))?;
            let expected_l1 = self
                .inner
                .source
                .genesis_l1_block
                .checked_add(number)
                .ok_or_else(|| backend("canonical L1 number overflow"))?;
            l1_origin.set_leaf(number, l1_origin_leaf(&block.l1_origin));
            let expected_history_root = history.root();
            if number != expected_number
                || block.header.number != number
                || !block.is_well_formed(&boundary.history.payouts)
                || block.l1_origin.block_number != expected_l1
                || (number == 0
                    && (!block
                        .l1_origin
                        .same_block(&self.inner.source.anchor_origin())
                        || block.header.parent_hash
                            != fr_to_bytes(self.inner.source.genesis_parent_hash())))
                || indexed.value() != key.value()
                || block.header.l1_origin_root != fr_to_bytes(l1_origin.root())
                || block.header.history_root != fr_to_bytes(expected_history_root)
                || block.header.state_root != fr_to_bytes(boundary.state.root)
                || boundary
                    .state_outcome
                    .output_leaf_start
                    .checked_add(boundary.state_outcome.outputs_added)
                    != Some(stored.state.output_count)
                || previous.as_ref().is_some_and(|parent| {
                    block.header.parent_hash != parent.hash
                        || block.header.timestamp < parent.header.timestamp
                })
            {
                return Err(backend("durable canonical history audit failed"));
            }
            history.set_leaf(number, crate::history_leaf(block.hash));
            let leaf_count = number + 1;
            l1_origin.retain_append_frontier(leaf_count);
            history.retain_append_frontier(leaf_count);
            previous = Some(stored);
            expected_number += 1;
        }
        if expected_number != count
            || bodies.len().map_err(backend)? != expected_body_count
            || previous.as_ref() != self.inner.canonical_tip.as_ref()
            || l1_origin.root() != self.inner.l1_origin_tree.root()
            || history.root() != self.inner.history_tree.root()
        {
            return Err(backend(
                "durable canonical history audit did not reach the live tip",
            ));
        }
        Ok(())
    }

    pub(super) fn committed_boundary_at(
        &self,
        number: u64,
    ) -> Result<Option<CommittedBoundary>, StateError> {
        let read = self.db.begin_read().map_err(backend)?;
        read_committed_boundary(&read, number)
    }

    pub(super) fn committed_boundary_for_hash(
        &self,
        hash: B256,
    ) -> Result<Option<CommittedBoundary>, StateError> {
        let read = self.db.begin_read().map_err(backend)?;
        let index = read.open_table(T_BLOCK_HASH_INDEX).map_err(backend)?;
        match indexed_block_number(&index, hash)? {
            Some(number) => read_committed_boundary(&read, number),
            None => Ok(None),
        }
    }

    pub(super) fn persisted_append_path(
        &self,
        tree_id: u8,
        last_included_index: u64,
        index: u64,
    ) -> Result<Option<[Fr; TREE_DEPTH]>, StateError> {
        if index > last_included_index {
            return Ok(None);
        }
        let read = self.db.begin_read().map_err(backend)?;
        let trees = read.open_table(T_TREES).map_err(backend)?;
        let mut siblings = [Fr::from(0u64); TREE_DEPTH];
        let mut cursor = index;
        for (height, sibling) in siblings.iter_mut().enumerate() {
            *sibling = persisted_append_node_at(
                &trees,
                tree_id,
                last_included_index,
                height as u8,
                cursor ^ 1,
            )?;
            cursor >>= 1;
        }
        Ok(Some(siblings))
    }

    pub fn stored_block(&self, number: u64) -> Result<Option<StoredBlock>, StateError> {
        let read = self.db.begin_read().map_err(backend)?;
        read_stored_block(&read, number)
    }

    pub fn stored_block_for_hash(&self, hash: B256) -> Result<Option<StoredBlock>, StateError> {
        let read = self.db.begin_read().map_err(backend)?;
        read_stored_block_by_hash(&read, hash)
    }

    pub fn block_metadata(&self, number: u64) -> Result<Option<PcashBlockMetadata>, StateError> {
        let read = self.db.begin_read().map_err(backend)?;
        read_block_metadata(&read, number)
    }

    pub fn transaction_body(
        &self,
        number: u64,
        transaction_index: u64,
    ) -> Result<Option<Vec<u8>>, StateError> {
        let read = self.db.begin_read().map_err(backend)?;
        let bodies = read.open_table(T_BLOCK_BODIES).map_err(backend)?;
        let key = block_body_key(number, transaction_index);
        Ok(bodies
            .get(key.as_slice())
            .map_err(backend)?
            .map(|body| body.value().to_vec()))
    }

    pub fn block_metadata_for_hash(
        &self,
        hash: B256,
    ) -> Result<Option<PcashBlockMetadata>, StateError> {
        let read = self.db.begin_read().map_err(backend)?;
        let index = read.open_table(T_BLOCK_HASH_INDEX).map_err(backend)?;
        match indexed_block_number(&index, hash)? {
            Some(number) => read_block_metadata(&read, number),
            None => Ok(None),
        }
    }

    pub fn history(&self, number: u64) -> Result<Option<crate::CanonicalBlockHistory>, StateError> {
        let read = self.db.begin_read().map_err(backend)?;
        Ok(read_block_history(&read, number)?.map(|stored| stored.history))
    }

    /// The effects of every admitted transaction in block `number`, aligned
    /// with its transaction results.
    pub fn transaction_effects(
        &self,
        number: u64,
    ) -> Result<Option<Vec<TransactionEffects>>, StateError> {
        let read = self.db.begin_read().map_err(backend)?;
        let table = read.open_table(T_TRANSACTION_EFFECTS).map_err(backend)?;
        decode_row(&table, &number.to_be_bytes())
    }

    /// Every log of block `number`'s L1 origin, in leaf order.
    pub fn l1_log_leaves(&self, number: u64) -> Result<Option<Vec<L1LogLeaf>>, StateError> {
        let read = self.db.begin_read().map_err(backend)?;
        let table = read.open_table(T_L1_LOG_LEAVES).map_err(backend)?;
        decode_row(&table, &number.to_be_bytes())
    }

    pub fn block(&self, number: u64) -> Result<Option<PcashBlock>, StateError> {
        let read = self.db.begin_read().map_err(backend)?;
        read_block(&read, number)
    }

    pub fn blocks(&self, from: u64, to: u64, limit: usize) -> Result<Vec<PcashBlock>, StateError> {
        if from > to || limit == 0 {
            return Ok(Vec::new());
        }
        let Some(tip) = self.inner.canonical_tip.as_ref() else {
            return Ok(Vec::new());
        };
        if from > tip.header.number {
            return Ok(Vec::new());
        }
        let effective_to = to.min(tip.header.number);
        let mut result = Vec::new();
        for number in (from..=effective_to).take(limit) {
            let Some(block) = self.block(number)? else {
                break;
            };
            result.push(block);
        }
        Ok(result)
    }

    /// Catch-up turns this off so per-block persist can skip the reorg
    /// savepoint and fsync. Near-head and tests leave it on.
    pub fn set_persist_reorg_savepoint(&mut self, enabled: bool) {
        self.persist_reorg_savepoint = enabled;
    }

    /// Highest L1 height at or below `l1_block` that still has a rollback
    /// savepoint. Used when a catch-up reorg lands between durable checkpoints.
    pub fn latest_savepoint_at_or_below(&self, l1_block: u64) -> Option<u64> {
        self.savepoints
            .range(..=l1_block)
            .next_back()
            .map(|(&block, _)| block)
    }

    pub(super) fn persist(
        &self,
        inner: &InnerState,
        committed: &CommittedBoundary,
        parent_l1_block: Option<u64>,
        transaction_effects: &[TransactionEffects],
        l1_logs: &[L1LogLeaf],
    ) -> Result<Option<(u64, u64)>, StateError> {
        let delta = &inner.last_delta;
        let mut write = self.db.begin_write().map_err(backend)?;
        let durability = if self.persist_reorg_savepoint {
            Durability::Immediate
        } else {
            Durability::None
        };
        write.set_durability(durability).map_err(backend)?;
        let new_savepoint = if self.persist_reorg_savepoint {
            if let Some(parent_l1_block) =
                parent_l1_block.filter(|block| !self.savepoints.contains_key(block))
            {
                let savepoint_id = write.persistent_savepoint().map_err(backend)?;
                {
                    let mut savepoints = write.open_table(T_SAVEPOINTS).map_err(backend)?;
                    savepoints
                        .insert(
                            parent_l1_block.to_be_bytes().as_slice(),
                            savepoint_id.to_be_bytes().as_slice(),
                        )
                        .map_err(backend)?;
                }
                Some((parent_l1_block, savepoint_id))
            } else {
                None
            }
        } else {
            None
        };
        #[cfg(any(test, feature = "test-support"))]
        if self.fail_next_persist.replace(false) {
            write.abort().map_err(backend)?;
            return Err(backend("injected persist failure"));
        }
        {
            let mut trees = write.open_table(T_TREES).map_err(backend)?;
            for (id, tree) in [
                (0u8, &inner.output_tree),
                (1u8, &inner.account_state_tree),
                (2u8, &inner.l1_origin_tree),
                (3u8, &inner.history_tree),
                (NULLIFIER_TREE_ID, inner.nullifier_tree.nodes()),
            ] {
                for &(level, index) in &delta.dirty_nodes[id as usize] {
                    let key = tree_node_key(id, level, index);
                    let value = fr_to_bytes(tree.node_value(level, index));
                    trees
                        .insert(key.as_slice(), value.as_slice())
                        .map_err(backend)?;
                }
            }
        }
        {
            let mut nullifiers = write.open_table(T_NULLIFIERS).map_err(backend)?;
            for (nullifier, index) in &delta.new_nullifiers {
                nullifiers
                    .insert(nullifier.as_slice(), index.to_be_bytes().as_slice())
                    .map_err(backend)?;
            }
        }
        {
            let mut addresses = write.open_table(T_ADDRESSES).map_err(backend)?;
            for key in &delta.touched_addrs {
                let bytes = inner.accounts[key].encode();
                addresses
                    .insert(key.as_slice(), bytes.as_slice())
                    .map_err(backend)?;
            }
        }
        {
            let mut account_writes = write.open_table(T_ACCOUNT_WRITES).map_err(backend)?;
            for (ordinal, account_write) in delta.account_writes.iter().enumerate() {
                let ordinal = u32::try_from(ordinal)
                    .map_err(|_| backend("account-write ordinal exceeds u32"))?;
                let key = account_write_key(committed.block.header.number, ordinal);
                let row = encode_account_write_row(committed.block.hash, account_write);
                account_writes
                    .insert(key.as_slice(), row.as_slice())
                    .map_err(backend)?;
            }
        }
        {
            let key = committed.block.header.number.to_be_bytes();
            let mut blocks = write.open_table(T_BLOCKS).map_err(backend)?;
            blocks
                .insert(
                    key.as_slice(),
                    StoredBlock::from(committed).encode().as_slice(),
                )
                .map_err(backend)?;
            let mut results = write.open_table(T_TRANSACTION_RESULTS).map_err(backend)?;
            results
                .insert(
                    key.as_slice(),
                    encode_list(&committed.block.transaction_results).as_slice(),
                )
                .map_err(backend)?;
        }
        {
            let mut bodies = write.open_table(T_BLOCK_BODIES).map_err(backend)?;
            for (transaction_index, body) in committed.block.transaction_bytes.iter().enumerate() {
                let key = block_body_key(
                    committed.block.header.number,
                    u64::try_from(transaction_index)
                        .map_err(|_| backend("transaction index exceeds u64"))?,
                );
                bodies
                    .insert(key.as_slice(), body.as_slice())
                    .map_err(backend)?;
            }
        }
        {
            let mut index = write.open_table(T_BLOCK_HASH_INDEX).map_err(backend)?;
            if let Some(existing) = index
                .get(committed.block.hash.as_slice())
                .map_err(backend)?
            {
                if existing.value() != committed.block.header.number.to_be_bytes() {
                    return Err(backend("canonical block hash collision"));
                }
            }
            index
                .insert(
                    committed.block.hash.as_slice(),
                    committed.block.header.number.to_be_bytes().as_slice(),
                )
                .map_err(backend)?;
        }
        {
            let mut histories = write.open_table(T_BLOCK_HISTORY).map_err(backend)?;
            let bytes = StoredBlockHistory::from_committed(committed).encode();
            histories
                .insert(
                    committed.block.header.number.to_be_bytes().as_slice(),
                    bytes.as_slice(),
                )
                .map_err(backend)?;
        }
        {
            // A transaction's manifests are consecutive, one per carrier.
            let mut deliveries = write.open_table(T_L1_DELIVERY_BATCHES).map_err(backend)?;
            for carriers in committed
                .history
                .l1_delivery_batches
                .chunk_by(|a, b| a.l1_transaction_hash == b.l1_transaction_hash)
            {
                deliveries
                    .insert(
                        carriers[0].l1_transaction_hash.as_slice(),
                        committed.block.header.number.to_be_bytes().as_slice(),
                    )
                    .map_err(backend)?;
            }
        }
        {
            let key = committed.block.header.number.to_be_bytes();
            let mut effects = write.open_table(T_TRANSACTION_EFFECTS).map_err(backend)?;
            let value = encode_list(transaction_effects);
            effects
                .insert(key.as_slice(), value.as_slice())
                .map_err(backend)?;
            let mut logs = write.open_table(T_L1_LOG_LEAVES).map_err(backend)?;
            logs.insert(key.as_slice(), encode_list(l1_logs).as_slice())
                .map_err(backend)?;
        }
        #[cfg(test)]
        if self.fail_next_atomic_commit.replace(false) {
            write.abort().map_err(backend)?;
            return Err(backend("injected atomic commit failure"));
        }
        write.commit().map_err(backend)?;
        Ok(new_savepoint)
    }

    pub(super) fn reload(&mut self, expected_source: DerivationSource) -> Result<(), StateError> {
        let (source, adopted) = Self::read_identity(&self.db)?;
        if source != expected_source || adopted != self.adopted {
            return Err(StateError::ForkDowngrade);
        }
        let read = self.db.begin_read().map_err(backend)?;
        let tree_rows = read.open_table(T_TREES).map_err(backend)?;
        // The account tree changes leaves in place, so it loads whole. The
        // append-only trees load below as the frontier their next leaf needs.
        let mut account_entries = Vec::new();
        let start = tree_node_key(1, 0, 0);
        let end = tree_node_key(1, u8::MAX, u64::MAX);
        for row in tree_rows
            .range(start.as_slice()..=end.as_slice())
            .map_err(backend)?
        {
            let (key, value) = row.map_err(backend)?;
            if key.value().len() != 10 || value.value().len() != 32 {
                return Err(backend("Poseidon-tree row has unexpected length"));
            }
            account_entries.push((
                key.value()[1],
                u64::from_be_bytes(key.value()[2..].try_into().unwrap()),
                to32(value.value())?,
            ));
        }
        let account_state_tree = crate::SparseTree::from_entries(TREE_DEPTH, &account_entries);

        let block_rows = read.open_table(T_BLOCKS).map_err(backend)?;
        let block_count = block_rows.len().map_err(backend)?;
        let read_block = |number: u64| -> Result<StoredBlock, StateError> {
            decode_row(&block_rows, &number.to_be_bytes())?
                .ok_or_else(|| backend("canonical block history has a gap"))
        };
        let (genesis, canonical_tip) = match block_count.checked_sub(1) {
            None => (None, None),
            Some(tip_number) => (Some(read_block(0)?), Some(read_block(tip_number)?)),
        };
        let read_frontier = |id: u8, leaf_count: u64| -> Result<crate::SparseTree, StateError> {
            if leaf_count == 0 {
                return Ok(crate::SparseTree::new(TREE_DEPTH));
            }
            let mut rows = Vec::new();
            for height in 0..TREE_DEPTH as u8 {
                if ((leaf_count >> height) & 1) == 0 {
                    continue;
                }
                let index = (leaf_count >> height) ^ 1;
                let key = tree_node_key(id, height, index);
                let value = tree_rows
                    .get(key.as_slice())
                    .map_err(backend)?
                    .ok_or_else(|| backend("append-only tree frontier node is missing"))?;
                rows.push((height, index, to32(value.value())?));
            }
            let key = tree_node_key(id, TREE_DEPTH as u8, 0);
            let value = tree_rows
                .get(key.as_slice())
                .map_err(backend)?
                .ok_or_else(|| backend("append-only tree root is missing"))?;
            rows.push((TREE_DEPTH as u8, 0, to32(value.value())?));
            Ok(crate::SparseTree::from_entries(TREE_DEPTH, &rows))
        };
        let output_tree = read_frontier(
            0,
            canonical_tip
                .as_ref()
                .map_or(0, |tip| tip.state.output_count),
        )?;
        let l1_origin_tree = read_frontier(2, block_count)?;
        let history_tree = read_frontier(3, block_count)?;
        let nullifier_tree = canonical_tip
            .as_ref()
            .map_or_else(NullifierTree::new, |tip| {
                NullifierTree::with_root(
                    fr_from_internal_word(tip.state.nullifier_root),
                    tip.state.nullifier_count,
                )
            });

        let mut recent_block_entries = Vec::new();
        if let Some(tip) = &canonical_tip {
            let start = recent_window_start(tip.header.timestamp);
            for number in (0..=tip.header.number).rev() {
                let block = read_block(number)?;
                if block.header.timestamp < start {
                    break;
                }
                recent_block_entries.push(RecentBlockEntry {
                    timestamp: block.header.timestamp,
                    hash: block.hash,
                });
            }
            recent_block_entries.reverse();
        }
        let mut inner = InnerState::new(source);
        inner.output_tree = output_tree;
        inner.account_state_tree = account_state_tree;
        inner.l1_origin_tree = l1_origin_tree;
        inner.history_tree = history_tree;
        inner.nullifier_tree = nullifier_tree;
        if let Some(tip) = &canonical_tip {
            inner.output_count = tip.state.output_count;
            inner.account_count = tip.state.account_count;
            inner.issuance = tip.state.issuance;
        }
        inner.recent_block_history = RecentBlockHistory::from_vec(recent_block_entries);
        inner.canonical_genesis_hash = genesis.as_ref().map(|block| block.hash);
        inner.canonical_genesis_timestamp = genesis.as_ref().map(|block| block.header.timestamp);
        inner.canonical_tip = canonical_tip;

        self.inner = inner;
        Ok(())
    }

    pub(super) fn restore_savepoint_preserving_guards(
        &self,
        l1_block: u64,
        id: u64,
    ) -> Result<(), StateError> {
        let mut write = self.db.begin_write().map_err(backend)?;
        write
            .set_durability(Durability::Immediate)
            .map_err(backend)?;
        let (checkpoint, adopted) = {
            let meta = write.open_table(T_META).map_err(backend)?;
            let checkpoint = meta
                .get(b"checkpoint".as_slice())
                .map_err(backend)?
                .map(|value| value.value().to_vec());
            let adopted = meta
                .get(b"adopted".as_slice())
                .map_err(backend)?
                .ok_or(StateError::InvalidForkAdoption)?
                .value()
                .to_vec();
            AdoptedForkCompatibility::decode(&adopted)?;
            (checkpoint, adopted)
        };
        let savepoint = write.get_persistent_savepoint(id).map_err(backend)?;
        write.restore_savepoint(&savepoint).map_err(backend)?;
        reconcile_restored_savepoint_links(&write, l1_block, id)?;
        {
            let mut meta = write.open_table(T_META).map_err(backend)?;
            meta.insert(b"adopted".as_slice(), adopted.as_slice())
                .map_err(backend)?;
            if let Some(checkpoint) = checkpoint {
                meta.insert(b"checkpoint".as_slice(), checkpoint.as_slice())
                    .map_err(backend)?;
            }
        }
        write.commit().map_err(backend)
    }

    /// Make the next commit fail before it writes, as a full disk would.
    #[cfg(any(test, feature = "test-support"))]
    pub fn fail_next_persist(&self) {
        self.fail_next_persist.set(true);
    }

    #[cfg(test)]
    pub(crate) fn fail_next_atomic_commit(&self) {
        self.fail_next_atomic_commit.set(true);
    }
}
