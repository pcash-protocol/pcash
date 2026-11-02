use super::persist::read_savepoint_links;
use super::{backend, PersistedCheckpoint, RedbState, T_META, T_SAVEPOINTS};
use crate::codec::Codec;

use crate::delegate::impl_inner_reads;
use crate::{
    AccountState, Address, BlockInput, BlockSummary, BlockUpdate, BoundaryRetention,
    CommittedBoundary, DerivationSource, Fr, NullifierProof, PcashBlock, StateComponents, StateDb,
    StateError, StateRoot, StoredBlock, TransactionEffects, TreeId, B256, COMMITMENT_TREE_DEPTH,
    STATE_TREE_DEPTH, TREE_DEPTH,
};
use redb::{Durability, ReadableDatabase};
use std::time::Instant;

impl RedbState {
    /// Canonical blocks are contiguous from zero through the tip.
    fn is_canonical_number(&self, number: u64) -> bool {
        self.inner
            .canonical_tip
            .as_ref()
            .is_some_and(|tip| number <= tip.header.number)
    }

    /// Make the next derivation-facing state read fail.
    #[cfg(any(test, feature = "test-support"))]
    pub fn fail_next_state_db_read(&self) {
        self.fail_next_state_db_read.set(true);
    }

    #[cfg(any(test, feature = "test-support"))]
    fn fail_injected_state_db_read(&self) -> Result<(), StateError> {
        if self.fail_next_state_db_read.replace(false) {
            return Err(backend("injected state read failure"));
        }
        Ok(())
    }
}

impl StateDb for RedbState {
    fn payout_records(&self, number: u64) -> Result<Option<Vec<crate::PayoutRecord>>, StateError> {
        Ok(self.history(number)?.map(|history| history.payouts))
    }
    fn commit(
        &mut self,
        mut input: BlockInput,
        update: BlockUpdate,
    ) -> Result<(CommittedBoundary, Vec<TransactionEffects>), StateError> {
        let started = Instant::now();
        let transaction_effects = std::mem::take(&mut input.transaction_effects);
        let l1_logs = std::mem::take(&mut input.l1_logs);
        let l1_number = input.l1_origin.block_number;
        let parent_l1_block = self
            .inner
            .canonical_tip
            .as_ref()
            .map(|block| block.l1_origin.block_number);
        self.hydrate_account_update(&update)?;
        self.hydrate_nullifier_update(&update)?;
        let (boundary, undo) = self.inner.apply_reversible(input, &update);
        let new_savepoint = match self.persist(
            &self.inner,
            &boundary,
            parent_l1_block,
            &transaction_effects,
            &l1_logs,
        ) {
            Ok(savepoint) => savepoint,
            Err(error) => {
                self.inner.rollback(undo);
                return Err(error);
            }
        };
        drop(undo);
        if let Some((parent_l1_block, savepoint_id)) = new_savepoint {
            self.savepoints.insert(parent_l1_block, savepoint_id);
        }
        self.inner.compact_durable_history();
        self.evict_account_working_set();
        self.evict_nullifier_working_set();
        tracing::debug!(
            l1_block = l1_number,
            persist_durable = self.persist_reorg_savepoint,
            commit_ms = started.elapsed().as_millis() as u64,
            "committed canonical state boundary"
        );
        Ok((boundary, transaction_effects))
    }

    impl_inner_reads!(common);

    fn path(&self, tree: TreeId, index: u64) -> Result<[Fr; TREE_DEPTH], StateError> {
        #[cfg(any(test, feature = "test-support"))]
        self.fail_injected_state_db_read()?;
        self.reader()
            .snapshot()
            .and_then(|read| read.path(tree, index))
    }

    fn account_of(&self, address: Address) -> Result<Option<AccountState>, StateError> {
        #[cfg(any(test, feature = "test-support"))]
        self.fail_injected_state_db_read()?;
        self.account_state(address)
    }
    fn nullifier_seen(&self, nullifier: B256) -> Result<bool, StateError> {
        #[cfg(any(test, feature = "test-support"))]
        self.fail_injected_state_db_read()?;
        self.nullifier_is_spent(nullifier)
    }
    fn nullifier_proof(&self, nullifier: B256) -> Result<NullifierProof, StateError> {
        #[cfg(any(test, feature = "test-support"))]
        self.fail_injected_state_db_read()?;
        self.reader()
            .snapshot()
            .and_then(|read| read.nullifier_proof(nullifier))
    }

    fn canonical_stored_block(&self, number: u64) -> Result<Option<StoredBlock>, StateError> {
        self.stored_block(number)
    }

    fn canonical_stored_block_by_hash(
        &self,
        hash: B256,
    ) -> Result<Option<StoredBlock>, StateError> {
        self.stored_block_for_hash(hash)
    }

    fn canonical_block_metadata(
        &self,
        number: u64,
    ) -> Result<Option<crate::PcashBlockMetadata>, StateError> {
        self.block_metadata(number)
    }

    fn canonical_block_metadata_by_hash(
        &self,
        hash: B256,
    ) -> Result<Option<crate::PcashBlockMetadata>, StateError> {
        self.block_metadata_for_hash(hash)
    }

    fn canonical_transaction_body(
        &self,
        number: u64,
        transaction_index: u64,
    ) -> Result<Option<Vec<u8>>, StateError> {
        self.transaction_body(number, transaction_index)
    }

    fn canonical_transaction_effects(
        &self,
        number: u64,
    ) -> Result<Option<Vec<TransactionEffects>>, StateError> {
        self.transaction_effects(number)
    }

    fn canonical_block(&self, number: u64) -> Result<Option<PcashBlock>, StateError> {
        self.block(number)
    }

    fn committed_boundary(&self, number: u64) -> Result<Option<CommittedBoundary>, StateError> {
        self.committed_boundary_at(number)
    }

    fn committed_boundary_by_block_hash(
        &self,
        hash: B256,
    ) -> Result<Option<CommittedBoundary>, StateError> {
        self.committed_boundary_for_hash(hash)
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

    fn l1_origin_path(&self, index: u64) -> Result<Option<[Fr; TREE_DEPTH]>, StateError> {
        let Some(tip) = self.inner.canonical_tip.as_ref() else {
            return Ok(None);
        };
        self.persisted_append_path(2, tip.header.number, index)
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
        self.persisted_append_path(0, last, index)
    }
    fn l1_origin_path_at(
        &self,
        pcash_block_number: u64,
        index: u64,
    ) -> Result<Option<[Fr; TREE_DEPTH]>, StateError> {
        if index > pcash_block_number || !self.is_canonical_number(pcash_block_number) {
            return Ok(None);
        }
        self.persisted_append_path(2, pcash_block_number, index)
    }

    fn history_block_path_at(
        &self,
        at_block: u64,
        index: u64,
    ) -> Result<Option<[Fr; TREE_DEPTH]>, StateError> {
        if at_block == 0 || index >= at_block || !self.is_canonical_number(at_block) {
            return Ok(None);
        }
        self.persisted_append_path(3, at_block - 1, index)
    }

    fn restore_to(&mut self, l1_block_number: u64) -> Result<StateRoot, StateError> {
        if self
            .inner
            .canonical_tip
            .as_ref()
            .is_some_and(|tip| tip.l1_origin.block_number == l1_block_number)
        {
            return Ok(self.inner.state_root());
        }
        let savepoint_id = *self
            .savepoints
            .get(&l1_block_number)
            .ok_or(StateError::SavepointNotFound(l1_block_number))?;
        self.restore_savepoint_preserving_guards(l1_block_number, savepoint_id)?;
        self.reload(self.inner.source)?;
        self.savepoints = read_savepoint_links(&self.db)?;
        Ok(self.inner.state_root())
    }

    fn prune(&mut self, finalized_l1_block: u64) -> Result<(), StateError> {
        let checkpoint = {
            let read = self.db.begin_read().map_err(backend)?;
            let meta = read.open_table(T_META).map_err(backend)?;
            let bytes = meta
                .get(b"checkpoint".as_slice())
                .map_err(backend)?
                .ok_or_else(|| backend("pruning requires a finalized checkpoint"))?
                .value()
                .to_vec();
            PersistedCheckpoint::decode(&bytes).map_err(backend)?
        };
        if checkpoint.finalized_l1_block < finalized_l1_block {
            return Err(backend(
                "pruning cannot advance beyond the persisted finalized checkpoint",
            ));
        }
        let obsolete: Vec<_> = self
            .savepoints
            .range(..finalized_l1_block)
            .map(|(&block, &id)| (block, id))
            .collect();
        if !obsolete.is_empty() {
            let mut write = self.db.begin_write().map_err(backend)?;
            write
                .set_durability(Durability::Immediate)
                .map_err(backend)?;
            {
                let mut savepoints = write.open_table(T_SAVEPOINTS).map_err(backend)?;
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
        }
        for (block, _) in obsolete {
            self.savepoints.remove(&block);
        }
        Ok(())
    }
}
