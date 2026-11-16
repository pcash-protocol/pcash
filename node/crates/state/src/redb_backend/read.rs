//! Canonical reads pinned to one committed redb transaction.

use super::account_writes::{
    account_write_key, decode_account_write_key, decode_account_write_row,
};
use super::nullifiers::{nullifier_above, nullifier_at_or_below, nullifier_spent};
use super::persist::{
    decode_row, indexed_block_number, persisted_append_node_at, persisted_tree_node, read_block,
    read_block_history, read_block_metadata, read_committed_boundary, read_stored_block,
    read_stored_block_by_hash, tree_node_key,
};
use super::{
    backend, meta_value, to32, Bytes, Database, DerivationSource, PersistedCheckpoint, RedbState,
    StateError, B256, NULLIFIER_TREE_ID, T_ACCOUNT_WRITES, T_ADDRESSES, T_BLOCKS, T_BLOCK_BODIES,
    T_BLOCK_HASH_INDEX, T_L1_DELIVERY_BATCHES, T_META, T_NULLIFIERS, T_TRANSACTION_EFFECTS,
    T_TREES,
};
use crate::codec::Codec;
use crate::inner::InnerState;
use crate::{
    state_root_from_components, AccountState, AccountWriteEntry, Address, BlockSummary,
    BoundaryRetention, CommittedBoundary, Fr, NullifierProof, OutputFrontier, PcashBlock,
    PcashBlockMetadata, StateComponents, StateRead, StateRoot, StoredBlock, TransactionEffects,
    TreeId, COMMITMENT_TREE_DEPTH, STATE_TREE_DEPTH, TREE_DEPTH,
};
use crate::{BlockEconomics, L1DeliveryBatch};
use redb::{ReadTransaction, ReadableDatabase, ReadableTable};
use std::sync::Arc;

/// Clonable access to canonical snapshots, independent of the derivation engine.
#[derive(Clone)]
pub struct RedbStateReader {
    db: Arc<Database>,
}

/// Current scalar state is the tip's [`StoredBlock::state`], or the initial
/// state before block zero.
pub struct RedbReadSnapshot {
    read: ReadTransaction,
    source: DerivationSource,
    state: StateComponents,
    tip: Option<StoredBlock>,
    genesis: Option<BlockSummary>,
    checkpoint: Option<PersistedCheckpoint>,
}

pub(super) fn read_account(
    table: &impl ReadableTable<&'static [u8], &'static [u8]>,
    address: Address,
) -> Result<Option<AccountState>, StateError> {
    table
        .get(address.as_slice())
        .map_err(backend)?
        .map(|value| AccountState::decode(value.value()).map_err(backend))
        .transpose()
}

impl RedbState {
    pub(super) fn account_state(
        &self,
        address: Address,
    ) -> Result<Option<AccountState>, StateError> {
        let read = self.db.begin_read().map_err(backend)?;
        let table = read.open_table(T_ADDRESSES).map_err(backend)?;
        read_account(&table, address)
    }

    pub fn reader(&self) -> RedbStateReader {
        RedbStateReader {
            db: Arc::clone(&self.db),
        }
    }
}

impl RedbStateReader {
    pub fn snapshot(&self) -> Result<RedbReadSnapshot, StateError> {
        let read = self.db.begin_read().map_err(backend)?;
        let meta = read.open_table(T_META).map_err(backend)?;
        let get = |key: Bytes| meta_value(&meta, key, "state metadata");
        let source = Codec::decode(&get(b"source")?).map_err(backend)?;
        let checkpoint = decode_row(&meta, b"checkpoint")?;
        drop(meta);
        let blocks = read.open_table(T_BLOCKS).map_err(backend)?;
        let tip = blocks
            .last()
            .map_err(backend)?
            .map(|(_, value)| StoredBlock::decode(value.value()).map_err(backend))
            .transpose()?;
        drop(blocks);
        let genesis = read_stored_block(&read, 0)?.map(|block| BlockSummary::from(&block));
        let state = match &tip {
            Some(tip) => tip.state,
            None => InnerState::new(source).state_components(),
        };
        Ok(RedbReadSnapshot {
            read,
            source,
            state,
            tip,
            genesis,
            checkpoint,
        })
    }
}

impl RedbReadSnapshot {
    pub fn checkpoint(&self) -> Option<&PersistedCheckpoint> {
        self.checkpoint.as_ref()
    }

    pub fn canonical_genesis_hash(&self) -> Option<B256> {
        self.genesis.as_ref().map(|block| block.hash)
    }

    fn is_canonical_number(&self, number: u64) -> bool {
        self.tip
            .as_ref()
            .is_some_and(|tip| number <= tip.header.number)
    }

    /// The height of a canonical block hash, or `None` off the canonical chain.
    pub fn canonical_block_number(&self, hash: B256) -> Result<Option<u64>, StateError> {
        let index = self.read.open_table(T_BLOCK_HASH_INDEX).map_err(backend)?;
        indexed_block_number(&index, hash)
    }

    fn tree_node(&self, id: u8, height: usize, index: u64) -> Result<Fr, StateError> {
        let table = self.read.open_table(T_TREES).map_err(backend)?;
        Self::read_tree_node(&table, id, height, index)
    }

    pub(super) fn read_tree_node(
        table: &redb::ReadOnlyTable<&[u8], &[u8]>,
        id: u8,
        height: usize,
        index: u64,
    ) -> Result<Fr, StateError> {
        match table
            .get(tree_node_key(id, height as u8, index).as_slice())
            .map_err(backend)?
        {
            Some(value) => Ok(crate::fr_from_internal_word(B256::from(to32(
                value.value(),
            )?))),
            None => Ok(pcash_crypto::merkle::empty(height)),
        }
    }

    pub fn history(&self, number: u64) -> Result<Option<crate::CanonicalBlockHistory>, StateError> {
        Ok(read_block_history(&self.read, number)?.map(|stored| stored.history))
    }

    fn append_path(
        &self,
        id: u8,
        last: u64,
        index: u64,
    ) -> Result<Option<[Fr; TREE_DEPTH]>, StateError> {
        if index > last {
            return Ok(None);
        }
        let table = self.read.open_table(T_TREES).map_err(backend)?;
        let mut path = [Fr::from(0u64); TREE_DEPTH];
        for (height, sibling) in path.iter_mut().enumerate() {
            *sibling =
                persisted_append_node_at(&table, id, last, height as u8, (index >> height) ^ 1)?;
        }
        Ok(Some(path))
    }

    /// The state components committed by block `number`.
    pub fn state_components_at(&self, number: u64) -> Result<Option<StateComponents>, StateError> {
        Ok(read_stored_block(&self.read, number)?.map(|block| block.state))
    }

    /// The output tree committed by block `number`, with its append frontier.
    /// A complete subtree's node never changes once written, so the current
    /// tree table holds the frontier of every committed block.
    pub fn output_frontier(&self, number: u64) -> Result<Option<OutputFrontier>, StateError> {
        let Some(components) = self.state_components_at(number)? else {
            return Ok(None);
        };
        let count = components.output_count;
        let table = self.read.open_table(T_TREES).map_err(backend)?;
        let mut ommers = Vec::new();
        for height in 0..=TREE_DEPTH as u8 {
            if (count >> height) & 1 == 1 {
                let node = persisted_tree_node(
                    &table,
                    TreeId::Output.index() as u8,
                    height,
                    (count >> height) - 1,
                )?;
                ommers.push(crate::fr_to_bytes(node));
            }
        }
        Ok(Some(OutputFrontier {
            output_count: count,
            output_root: components.output_root,
            ommers,
        }))
    }

    /// Account writes from `(from_block, from_ordinal)` through the last write
    /// of `through_block`, in canonical order.
    pub fn account_writes(
        &self,
        from_block: u64,
        from_ordinal: u32,
        through_block: u64,
    ) -> Result<impl Iterator<Item = Result<AccountWriteEntry, StateError>>, StateError> {
        let table = self.read.open_table(T_ACCOUNT_WRITES).map_err(backend)?;
        let first = account_write_key(from_block, from_ordinal);
        let last = account_write_key(through_block, u32::MAX);
        let rows = (first <= last)
            .then(|| table.range(first.as_slice()..=last.as_slice()))
            .transpose()
            .map_err(backend)?;
        Ok(rows.into_iter().flatten().map(|row| {
            let (key, value) = row.map_err(backend)?;
            let (block_number, ordinal) = decode_account_write_key(key.value())?;
            let (block_hash, write) = decode_account_write_row(value.value())?;
            Ok(AccountWriteEntry {
                block_number,
                block_hash,
                ordinal,
                write,
            })
        }))
    }
}

impl StateRead for RedbReadSnapshot {
    fn payout_records(&self, number: u64) -> Result<Option<Vec<crate::PayoutRecord>>, StateError> {
        Ok(self.history(number)?.map(|history| history.payouts))
    }
    fn state_root(&self) -> Result<StateRoot, StateError> {
        Ok(match &self.tip {
            Some(tip) => StateRoot(tip.header.state_root),
            None => state_root_from_components(self.state),
        })
    }
    fn state_components(&self) -> Result<StateComponents, StateError> {
        Ok(self.state)
    }
    fn derivation_source(&self) -> Result<DerivationSource, StateError> {
        Ok(self.source)
    }
    fn canonical_tip(&self) -> Result<Option<StoredBlock>, StateError> {
        Ok(self.tip.clone())
    }
    fn canonical_tip_summary(&self) -> Result<Option<BlockSummary>, StateError> {
        Ok(self.tip.as_ref().map(BlockSummary::from))
    }
    fn canonical_stored_block(&self, number: u64) -> Result<Option<StoredBlock>, StateError> {
        read_stored_block(&self.read, number)
    }
    fn canonical_stored_block_by_hash(
        &self,
        hash: B256,
    ) -> Result<Option<StoredBlock>, StateError> {
        read_stored_block_by_hash(&self.read, hash)
    }
    fn canonical_block_metadata(
        &self,
        number: u64,
    ) -> Result<Option<PcashBlockMetadata>, StateError> {
        read_block_metadata(&self.read, number)
    }
    fn canonical_block_metadata_by_hash(
        &self,
        hash: B256,
    ) -> Result<Option<PcashBlockMetadata>, StateError> {
        match self.canonical_block_number(hash)? {
            Some(number) => self.canonical_block_metadata(number),
            None => Ok(None),
        }
    }
    fn canonical_transaction_body(
        &self,
        number: u64,
        transaction_index: u64,
    ) -> Result<Option<Vec<u8>>, StateError> {
        let key = super::persist::block_body_key(number, transaction_index);
        let table = self.read.open_table(T_BLOCK_BODIES).map_err(backend)?;
        Ok(table
            .get(key.as_slice())
            .map_err(backend)?
            .map(|value| value.value().to_vec()))
    }
    fn canonical_transaction_effects(
        &self,
        number: u64,
    ) -> Result<Option<Vec<TransactionEffects>>, StateError> {
        let table = self
            .read
            .open_table(T_TRANSACTION_EFFECTS)
            .map_err(backend)?;
        decode_row(&table, &number.to_be_bytes())
    }
    fn canonical_block(&self, number: u64) -> Result<Option<PcashBlock>, StateError> {
        read_block(&self.read, number)
    }
    fn committed_boundary(&self, number: u64) -> Result<Option<CommittedBoundary>, StateError> {
        read_committed_boundary(&self.read, number)
    }
    fn committed_boundary_by_block_hash(
        &self,
        hash: B256,
    ) -> Result<Option<CommittedBoundary>, StateError> {
        match self.canonical_block_number(hash)? {
            Some(number) => self.committed_boundary(number),
            None => Ok(None),
        }
    }
    fn l1_delivery_batches(&self, number: u64) -> Result<Vec<crate::L1DeliveryBatch>, StateError> {
        Ok(self
            .history(number)?
            .map(|history| history.l1_delivery_batches)
            .unwrap_or_default())
    }
    fn block_economics(&self, number: u64) -> Result<Option<crate::BlockEconomics>, StateError> {
        Ok(self.history(number)?.map(|history| history.economics))
    }
    fn boundary_retention(&self) -> Result<Option<BoundaryRetention>, StateError> {
        Ok(self.tip.as_ref().map(|tip| BoundaryRetention {
            oldest_contiguous: 0,
            tip: tip.header.number,
        }))
    }
    fn last_l1_timestamp(&self) -> Result<u64, StateError> {
        Ok(self.tip.as_ref().map_or(0, |tip| tip.header.timestamp))
    }
    fn genesis_l1_timestamp(&self) -> Result<Option<u64>, StateError> {
        Ok(self.genesis.as_ref().map(|genesis| genesis.timestamp))
    }
    fn output_root(&self) -> Result<Fr, StateError> {
        Ok(crate::fr_from_internal_word(self.state.output_root))
    }

    fn account_state_root(&self) -> Result<Fr, StateError> {
        Ok(crate::fr_from_internal_word(self.state.account_state_root))
    }
    fn output_count(&self) -> Result<u64, StateError> {
        Ok(self.state.output_count)
    }

    fn account_count(&self) -> Result<u64, StateError> {
        Ok(self.state.account_count)
    }
    fn path(&self, tree: TreeId, index: u64) -> Result<[Fr; TREE_DEPTH], StateError> {
        let table = self.read.open_table(T_TREES).map_err(backend)?;
        let mut path = [Fr::from(0u64); TREE_DEPTH];
        for (height, sibling) in path.iter_mut().enumerate() {
            *sibling =
                Self::read_tree_node(&table, tree.index() as u8, height, (index >> height) ^ 1)?;
        }
        Ok(path)
    }
    fn nullifier_seen(&self, nullifier: B256) -> Result<bool, StateError> {
        let rows = self.read.open_table(T_NULLIFIERS).map_err(backend)?;
        nullifier_spent(&rows, nullifier)
    }
    fn nullifier_proof(&self, nullifier: B256) -> Result<NullifierProof, StateError> {
        let rows = self.read.open_table(T_NULLIFIERS).map_err(backend)?;
        let trees = self.read.open_table(T_TREES).map_err(backend)?;
        crate::nullifier_tree::prove(
            nullifier,
            nullifier_at_or_below(&rows, nullifier)?,
            nullifier_above(&rows, nullifier)?,
            |height, index| Self::read_tree_node(&trees, NULLIFIER_TREE_ID, height as usize, index),
        )
    }

    fn account_of(&self, address: Address) -> Result<Option<AccountState>, StateError> {
        let table = self.read.open_table(T_ADDRESSES).map_err(backend)?;
        read_account(&table, address)
    }
    fn l1_origin_root(&self) -> Result<Fr, StateError> {
        self.tree_node(2, TREE_DEPTH, 0)
    }
    fn l1_origin_path(&self, index: u64) -> Result<Option<[Fr; TREE_DEPTH]>, StateError> {
        match &self.tip {
            Some(tip) => self.append_path(2, tip.header.number, index),
            None => Ok(None),
        }
    }
    fn output_path_at(
        &self,
        number: u64,
        index: u64,
    ) -> Result<Option<[Fr; TREE_DEPTH]>, StateError> {
        let Some(block) = self.canonical_stored_block(number)? else {
            return Ok(None);
        };
        let Some(last) = block.state.output_count.checked_sub(1) else {
            return Ok(None);
        };
        self.append_path(0, last, index)
    }
    fn l1_origin_path_at(
        &self,
        number: u64,
        index: u64,
    ) -> Result<Option<[Fr; TREE_DEPTH]>, StateError> {
        if !self.is_canonical_number(number) {
            return Ok(None);
        }
        self.append_path(2, number, index)
    }
    fn history_block_path_at(
        &self,
        number: u64,
        index: u64,
    ) -> Result<Option<[Fr; TREE_DEPTH]>, StateError> {
        if number == 0 || !self.is_canonical_number(number) {
            return Ok(None);
        }
        self.append_path(3, number - 1, index)
    }
    fn block_header_path_at(
        &self,
        hash: B256,
        key: u64,
    ) -> Result<Option<(Fr, [Fr; COMMITMENT_TREE_DEPTH])>, StateError> {
        Ok(self
            .canonical_stored_block_by_hash(hash)?
            .and_then(|block| block.header.path(key)))
    }
    fn state_path_at(
        &self,
        hash: B256,
        key: u64,
    ) -> Result<Option<(Fr, [Fr; STATE_TREE_DEPTH])>, StateError> {
        match self.canonical_stored_block_by_hash(hash)? {
            Some(block) => Ok(crate::StateCommitment::new(block.state).path(key)),
            None => Ok(None),
        }
    }
}

impl RedbReadSnapshot {
    pub fn state_root(&self) -> Result<StateRoot, StateError> {
        StateRead::state_root(self)
    }
    pub fn state_components(&self) -> Result<StateComponents, StateError> {
        StateRead::state_components(self)
    }
    pub fn derivation_source(&self) -> Result<DerivationSource, StateError> {
        StateRead::derivation_source(self)
    }
    pub fn canonical_tip(&self) -> Result<Option<StoredBlock>, StateError> {
        StateRead::canonical_tip(self)
    }
    pub fn canonical_tip_summary(&self) -> Result<Option<BlockSummary>, StateError> {
        StateRead::canonical_tip_summary(self)
    }
    pub fn canonical_stored_block(&self, number: u64) -> Result<Option<StoredBlock>, StateError> {
        StateRead::canonical_stored_block(self, number)
    }
    pub fn canonical_stored_block_by_hash(
        &self,
        hash: B256,
    ) -> Result<Option<StoredBlock>, StateError> {
        StateRead::canonical_stored_block_by_hash(self, hash)
    }
    pub fn canonical_block_metadata(
        &self,
        number: u64,
    ) -> Result<Option<PcashBlockMetadata>, StateError> {
        StateRead::canonical_block_metadata(self, number)
    }
    pub fn canonical_block_metadata_by_hash(
        &self,
        hash: B256,
    ) -> Result<Option<PcashBlockMetadata>, StateError> {
        StateRead::canonical_block_metadata_by_hash(self, hash)
    }
    pub fn canonical_transaction_body(
        &self,
        number: u64,
        transaction_index: u64,
    ) -> Result<Option<Vec<u8>>, StateError> {
        StateRead::canonical_transaction_body(self, number, transaction_index)
    }
    pub fn canonical_transaction_effects(
        &self,
        number: u64,
    ) -> Result<Option<Vec<TransactionEffects>>, StateError> {
        StateRead::canonical_transaction_effects(self, number)
    }
    pub fn canonical_block(&self, number: u64) -> Result<Option<PcashBlock>, StateError> {
        StateRead::canonical_block(self, number)
    }
    pub fn committed_boundary(&self, number: u64) -> Result<Option<CommittedBoundary>, StateError> {
        StateRead::committed_boundary(self, number)
    }
    pub fn committed_boundary_by_block_hash(
        &self,
        hash: B256,
    ) -> Result<Option<CommittedBoundary>, StateError> {
        StateRead::committed_boundary_by_block_hash(self, hash)
    }
    /// The canonical delivery manifest of every carrier of one L1
    /// transaction, in carrier order, and the number of the PCASH block that
    /// retains them.
    pub fn transaction_delivery_batches(
        &self,
        l1_transaction_hash: B256,
    ) -> Result<Option<(u64, Vec<L1DeliveryBatch>)>, StateError> {
        let table = self
            .read
            .open_table(T_L1_DELIVERY_BATCHES)
            .map_err(backend)?;
        let Some(value) = table.get(l1_transaction_hash.as_slice()).map_err(backend)? else {
            return Ok(None);
        };
        let number = u64::from_be_bytes(value.value().try_into().map_err(backend)?);
        let batches = self
            .l1_delivery_batches(number)?
            .into_iter()
            .filter(|batch| batch.l1_transaction_hash == l1_transaction_hash)
            .collect();
        Ok(Some((number, batches)))
    }
    pub fn l1_delivery_batches(&self, number: u64) -> Result<Vec<L1DeliveryBatch>, StateError> {
        StateRead::l1_delivery_batches(self, number)
    }
    pub fn block_economics(&self, number: u64) -> Result<Option<BlockEconomics>, StateError> {
        StateRead::block_economics(self, number)
    }
    pub fn boundary_retention(&self) -> Result<Option<BoundaryRetention>, StateError> {
        StateRead::boundary_retention(self)
    }
    pub fn last_l1_timestamp(&self) -> Result<u64, StateError> {
        StateRead::last_l1_timestamp(self)
    }
    pub fn genesis_l1_timestamp(&self) -> Result<Option<u64>, StateError> {
        StateRead::genesis_l1_timestamp(self)
    }
    pub fn output_root(&self) -> Result<Fr, StateError> {
        StateRead::output_root(self)
    }

    pub fn account_state_root(&self) -> Result<Fr, StateError> {
        StateRead::account_state_root(self)
    }
    pub fn output_count(&self) -> Result<u64, StateError> {
        StateRead::output_count(self)
    }

    pub fn account_count(&self) -> Result<u64, StateError> {
        StateRead::account_count(self)
    }
    pub fn path(&self, tree: TreeId, index: u64) -> Result<[Fr; TREE_DEPTH], StateError> {
        StateRead::path(self, tree, index)
    }
    pub fn nullifier_seen(&self, nullifier: B256) -> Result<bool, StateError> {
        StateRead::nullifier_seen(self, nullifier)
    }
    pub fn nullifier_proof(&self, nullifier: B256) -> Result<NullifierProof, StateError> {
        StateRead::nullifier_proof(self, nullifier)
    }

    pub fn account_of(&self, addr: Address) -> Result<Option<AccountState>, StateError> {
        StateRead::account_of(self, addr)
    }
    pub fn l1_origin_root(&self) -> Result<Fr, StateError> {
        StateRead::l1_origin_root(self)
    }
    pub fn l1_origin_path(&self, index: u64) -> Result<Option<[Fr; TREE_DEPTH]>, StateError> {
        StateRead::l1_origin_path(self, index)
    }
    pub fn output_path_at(
        &self,
        number: u64,
        index: u64,
    ) -> Result<Option<[Fr; TREE_DEPTH]>, StateError> {
        StateRead::output_path_at(self, number, index)
    }
    pub fn l1_origin_path_at(
        &self,
        pcash_block_number: u64,
        index: u64,
    ) -> Result<Option<[Fr; TREE_DEPTH]>, StateError> {
        StateRead::l1_origin_path_at(self, pcash_block_number, index)
    }
    pub fn history_block_path_at(
        &self,
        at_block: u64,
        index: u64,
    ) -> Result<Option<[Fr; TREE_DEPTH]>, StateError> {
        StateRead::history_block_path_at(self, at_block, index)
    }
    pub fn block_header_path_at(
        &self,
        block_hash: B256,
        key: u64,
    ) -> Result<Option<(Fr, [Fr; COMMITMENT_TREE_DEPTH])>, StateError> {
        StateRead::block_header_path_at(self, block_hash, key)
    }
    pub fn state_path_at(
        &self,
        block_hash: B256,
        key: u64,
    ) -> Result<Option<(Fr, [Fr; STATE_TREE_DEPTH])>, StateError> {
        StateRead::state_path_at(self, block_hash, key)
    }
}

impl RedbReadSnapshot {}
