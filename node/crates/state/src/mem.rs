//! In-memory [`StateDb`] using O(block-delta) undo journals.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "undo journals are paired with their committed blocks"
)]

use crate::delegate::impl_inner_reads;
use crate::inner::{InnerState, InnerStateUndo};
use crate::{
    AccountState, Address, BlockInput, BlockSummary, BlockUpdate, BoundaryRetention,
    CommittedBoundary, DerivationSource, Fr, NullifierProof, PcashBlock, PcashBlockMetadata,
    StateComponents, StateDb, StateError, StateRoot, StoredBlock, TransactionEffects, TreeId, B256,
    COMMITMENT_TREE_DEPTH, STATE_TREE_DEPTH, TREE_DEPTH,
};
use std::collections::BTreeMap;

pub struct MemState {
    inner: InnerState,
    /// Permanent canonical block history, including authenticated bodies.
    blocks: BTreeMap<u64, PcashBlock>,
    /// Per-block effects aligned with the canonical transaction results.
    transaction_effects: BTreeMap<u64, Vec<TransactionEffects>>,
    /// L1 origin number -> journal that reverts that block.
    undo: BTreeMap<u64, InnerStateUndo>,
}

impl MemState {
    pub fn new(source: DerivationSource) -> Self {
        Self {
            inner: InnerState::new(source),
            blocks: BTreeMap::new(),
            transaction_effects: BTreeMap::new(),
            undo: BTreeMap::new(),
        }
    }
}

impl StateDb for MemState {
    fn commit(
        &mut self,
        mut input: BlockInput,
        update: BlockUpdate,
    ) -> Result<(CommittedBoundary, Vec<TransactionEffects>), StateError> {
        let transaction_effects = std::mem::take(&mut input.transaction_effects);
        let l1_number = input.l1_origin.block_number;
        let (boundary, undo) = self.inner.apply_reversible(input, &update);
        self.blocks
            .insert(boundary.block.header.number, boundary.block.clone());
        self.transaction_effects
            .insert(boundary.block.header.number, transaction_effects.clone());
        self.undo.insert(l1_number, undo);
        Ok((boundary, transaction_effects))
    }

    impl_inner_reads!();

    fn canonical_stored_block(&self, number: u64) -> Result<Option<StoredBlock>, StateError> {
        Ok(self
            .inner
            .committed_boundaries
            .get(&number)
            .map(StoredBlock::from))
    }

    fn canonical_stored_block_by_hash(
        &self,
        hash: B256,
    ) -> Result<Option<StoredBlock>, StateError> {
        Ok(self
            .inner
            .committed_boundaries
            .values()
            .find(|boundary| boundary.block.hash == hash)
            .map(StoredBlock::from))
    }

    fn canonical_block_metadata(
        &self,
        number: u64,
    ) -> Result<Option<PcashBlockMetadata>, StateError> {
        Ok(self.blocks.get(&number).map(PcashBlockMetadata::from))
    }

    fn canonical_block_metadata_by_hash(
        &self,
        hash: B256,
    ) -> Result<Option<PcashBlockMetadata>, StateError> {
        Ok(self
            .blocks
            .values()
            .find(|block| block.hash == hash)
            .map(PcashBlockMetadata::from))
    }

    fn canonical_transaction_body(
        &self,
        number: u64,
        transaction_index: u64,
    ) -> Result<Option<Vec<u8>>, StateError> {
        Ok(self
            .blocks
            .get(&number)
            .and_then(|block| block.transaction_bytes.get(transaction_index as usize))
            .cloned())
    }

    fn canonical_transaction_effects(
        &self,
        number: u64,
    ) -> Result<Option<Vec<TransactionEffects>>, StateError> {
        Ok(self.transaction_effects.get(&number).cloned())
    }

    fn canonical_block(&self, number: u64) -> Result<Option<PcashBlock>, StateError> {
        Ok(self.blocks.get(&number).cloned())
    }

    fn committed_boundary(&self, number: u64) -> Result<Option<CommittedBoundary>, StateError> {
        Ok(self.inner.committed_boundaries.get(&number).cloned())
    }

    fn committed_boundary_by_block_hash(
        &self,
        hash: B256,
    ) -> Result<Option<CommittedBoundary>, StateError> {
        Ok(self
            .inner
            .committed_boundaries
            .values()
            .rev()
            .find(|boundary| boundary.block.hash == hash)
            .cloned())
    }

    fn l1_delivery_batches(&self, number: u64) -> Result<Vec<crate::L1DeliveryBatch>, StateError> {
        Ok(self
            .inner
            .committed_boundaries
            .get(&number)
            .map(|boundary| boundary.history.l1_delivery_batches.clone())
            .unwrap_or_default())
    }

    fn block_economics(&self, number: u64) -> Result<Option<crate::BlockEconomics>, StateError> {
        Ok(self
            .inner
            .committed_boundaries
            .get(&number)
            .map(|boundary| boundary.history.economics.clone()))
    }

    fn l1_origin_path(&self, index: u64) -> Result<Option<[Fr; TREE_DEPTH]>, StateError> {
        let Some(tip) = self.inner.canonical_tip.as_ref() else {
            return Ok(None);
        };
        Ok((index <= tip.header.number).then(|| self.inner.l1_origin_tree.path(index)))
    }

    fn output_path_at(
        &self,
        number: u64,
        index: u64,
    ) -> Result<Option<[Fr; TREE_DEPTH]>, StateError> {
        let Some(block) = self.inner.committed_boundaries.get(&number) else {
            return Ok(None);
        };
        let Some(last) = block.state.state_components().output_count.checked_sub(1) else {
            return Ok(None);
        };
        Ok(crate::inner::InnerState::append_only_path_at(
            &self.inner.output_tree,
            last,
            index,
        ))
    }
    fn l1_origin_path_at(
        &self,
        pcash_block_number: u64,
        index: u64,
    ) -> Result<Option<[Fr; TREE_DEPTH]>, StateError> {
        Ok(self.inner.l1_origin_path_at(pcash_block_number, index))
    }

    fn history_block_path_at(
        &self,
        at_block: u64,
        index: u64,
    ) -> Result<Option<[Fr; TREE_DEPTH]>, StateError> {
        Ok(self.inner.history_block_path_at(at_block, index))
    }

    fn restore_to(&mut self, l1_block_number: u64) -> Result<StateRoot, StateError> {
        if !self.undo.contains_key(&l1_block_number) {
            return Err(StateError::SavepointNotFound(l1_block_number));
        }
        while self
            .inner
            .canonical_tip
            .as_ref()
            .is_some_and(|tip| tip.l1_origin.block_number > l1_block_number)
        {
            let pcash_number = self.inner.canonical_tip.as_ref().unwrap().header.number;
            let current = self
                .inner
                .canonical_tip
                .as_ref()
                .unwrap()
                .l1_origin
                .block_number;
            let undo = self
                .undo
                .remove(&current)
                .ok_or(StateError::SavepointNotFound(current))?;
            self.inner.rollback(undo);
            self.blocks.remove(&pcash_number);
            self.transaction_effects.remove(&pcash_number);
        }
        Ok(self.inner.state_root())
    }

    fn prune(&mut self, finalized_l1_block: u64) -> Result<(), StateError> {
        let finalized_pcash = finalized_l1_block
            .checked_sub(self.inner.source.genesis_l1_block)
            .ok_or_else(|| {
                StateError::Backend("finalized block precedes derivation anchor".to_owned())
            })?;
        if !self
            .inner
            .committed_boundaries
            .contains_key(&finalized_pcash)
        {
            return Err(StateError::MissingCanonicalBoundary(finalized_pcash));
        }
        self.undo
            .retain(|&l1_block, _| l1_block >= finalized_l1_block);
        Ok(())
    }
}
