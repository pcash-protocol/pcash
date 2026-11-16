//! Read-only canonical state access shared by RPC snapshots and the derivation engine.

use crate::{
    AccountState, Address, BlockEconomics, BlockSummary, BoundaryRetention, CommittedBoundary,
    DerivationSource, Fr, L1DeliveryBatch, NullifierProof, PcashBlock, PcashBlockMetadata,
    StateComponents, StateDb, StateError, StateRoot, StoredBlock, TransactionEffects, TreeId, B256,
    COMMITMENT_TREE_DEPTH, STATE_TREE_DEPTH, TREE_DEPTH,
};

/// Every read in one request uses one committed canonical database snapshot.
pub trait StateRead {
    fn state_root(&self) -> Result<StateRoot, StateError>;
    fn state_components(&self) -> Result<StateComponents, StateError>;
    fn derivation_source(&self) -> Result<DerivationSource, StateError>;
    fn canonical_tip(&self) -> Result<Option<StoredBlock>, StateError>;
    fn canonical_tip_summary(&self) -> Result<Option<BlockSummary>, StateError>;
    fn canonical_stored_block(&self, number: u64) -> Result<Option<StoredBlock>, StateError>;
    fn canonical_stored_block_by_hash(&self, hash: B256)
        -> Result<Option<StoredBlock>, StateError>;
    fn canonical_block_metadata(
        &self,
        number: u64,
    ) -> Result<Option<PcashBlockMetadata>, StateError>;
    fn canonical_block_metadata_by_hash(
        &self,
        hash: B256,
    ) -> Result<Option<PcashBlockMetadata>, StateError>;
    fn canonical_transaction_body(
        &self,
        number: u64,
        transaction_index: u64,
    ) -> Result<Option<Vec<u8>>, StateError>;
    fn canonical_transaction_effects(
        &self,
        number: u64,
    ) -> Result<Option<Vec<TransactionEffects>>, StateError>;
    fn canonical_block(&self, number: u64) -> Result<Option<PcashBlock>, StateError>;
    fn committed_boundary(&self, number: u64) -> Result<Option<CommittedBoundary>, StateError>;
    fn committed_boundary_by_block_hash(
        &self,
        hash: B256,
    ) -> Result<Option<CommittedBoundary>, StateError>;
    fn l1_delivery_batches(&self, number: u64) -> Result<Vec<L1DeliveryBatch>, StateError>;
    fn block_economics(&self, number: u64) -> Result<Option<BlockEconomics>, StateError>;
    fn payout_records(&self, number: u64) -> Result<Option<Vec<crate::PayoutRecord>>, StateError>;
    fn boundary_retention(&self) -> Result<Option<BoundaryRetention>, StateError>;
    fn last_l1_timestamp(&self) -> Result<u64, StateError>;
    fn genesis_l1_timestamp(&self) -> Result<Option<u64>, StateError>;

    fn output_root(&self) -> Result<Fr, StateError>;

    fn account_state_root(&self) -> Result<Fr, StateError>;
    fn output_count(&self) -> Result<u64, StateError>;

    fn account_count(&self) -> Result<u64, StateError>;
    fn path(&self, tree: TreeId, index: u64) -> Result<[Fr; TREE_DEPTH], StateError>;
    fn nullifier_seen(&self, nullifier: B256) -> Result<bool, StateError>;
    fn nullifier_proof(&self, nullifier: B256) -> Result<NullifierProof, StateError>;

    fn account_of(&self, addr: Address) -> Result<Option<AccountState>, StateError>;
    fn l1_origin_root(&self) -> Result<Fr, StateError>;
    fn l1_origin_path(&self, index: u64) -> Result<Option<[Fr; TREE_DEPTH]>, StateError>;
    fn output_path_at(
        &self,
        number: u64,
        index: u64,
    ) -> Result<Option<[Fr; TREE_DEPTH]>, StateError>;
    fn l1_origin_path_at(
        &self,
        pcash_block_number: u64,
        index: u64,
    ) -> Result<Option<[Fr; TREE_DEPTH]>, StateError>;
    fn history_block_path_at(
        &self,
        at_block: u64,
        index: u64,
    ) -> Result<Option<[Fr; TREE_DEPTH]>, StateError>;
    fn block_header_path_at(
        &self,
        block_hash: B256,
        key: u64,
    ) -> Result<Option<(Fr, [Fr; COMMITMENT_TREE_DEPTH])>, StateError>;
    fn state_path_at(
        &self,
        block_hash: B256,
        key: u64,
    ) -> Result<Option<(Fr, [Fr; STATE_TREE_DEPTH])>, StateError>;
}

impl<T: StateDb + ?Sized> StateRead for T {
    fn payout_records(&self, number: u64) -> Result<Option<Vec<crate::PayoutRecord>>, StateError> {
        StateDb::payout_records(self, number)
    }
    fn state_root(&self) -> Result<StateRoot, StateError> {
        Ok(StateDb::state_root(self))
    }
    fn state_components(&self) -> Result<StateComponents, StateError> {
        Ok(StateDb::state_components(self))
    }
    fn derivation_source(&self) -> Result<DerivationSource, StateError> {
        Ok(StateDb::derivation_source(self))
    }
    fn canonical_tip(&self) -> Result<Option<StoredBlock>, StateError> {
        Ok(StateDb::canonical_tip(self))
    }
    fn canonical_tip_summary(&self) -> Result<Option<BlockSummary>, StateError> {
        Ok(StateDb::canonical_tip_summary(self))
    }
    fn canonical_stored_block(&self, number: u64) -> Result<Option<StoredBlock>, StateError> {
        StateDb::canonical_stored_block(self, number)
    }
    fn canonical_stored_block_by_hash(
        &self,
        hash: B256,
    ) -> Result<Option<StoredBlock>, StateError> {
        StateDb::canonical_stored_block_by_hash(self, hash)
    }
    fn canonical_block_metadata(
        &self,
        number: u64,
    ) -> Result<Option<PcashBlockMetadata>, StateError> {
        StateDb::canonical_block_metadata(self, number)
    }
    fn canonical_block_metadata_by_hash(
        &self,
        hash: B256,
    ) -> Result<Option<PcashBlockMetadata>, StateError> {
        StateDb::canonical_block_metadata_by_hash(self, hash)
    }
    fn canonical_transaction_body(
        &self,
        number: u64,
        transaction_index: u64,
    ) -> Result<Option<Vec<u8>>, StateError> {
        StateDb::canonical_transaction_body(self, number, transaction_index)
    }
    fn canonical_transaction_effects(
        &self,
        number: u64,
    ) -> Result<Option<Vec<TransactionEffects>>, StateError> {
        StateDb::canonical_transaction_effects(self, number)
    }
    fn canonical_block(&self, number: u64) -> Result<Option<PcashBlock>, StateError> {
        StateDb::canonical_block(self, number)
    }
    fn committed_boundary(&self, number: u64) -> Result<Option<CommittedBoundary>, StateError> {
        StateDb::committed_boundary(self, number)
    }
    fn committed_boundary_by_block_hash(
        &self,
        hash: B256,
    ) -> Result<Option<CommittedBoundary>, StateError> {
        StateDb::committed_boundary_by_block_hash(self, hash)
    }
    fn l1_delivery_batches(&self, number: u64) -> Result<Vec<L1DeliveryBatch>, StateError> {
        StateDb::l1_delivery_batches(self, number)
    }
    fn block_economics(&self, number: u64) -> Result<Option<BlockEconomics>, StateError> {
        StateDb::block_economics(self, number)
    }
    fn boundary_retention(&self) -> Result<Option<BoundaryRetention>, StateError> {
        Ok(StateDb::boundary_retention(self))
    }
    fn last_l1_timestamp(&self) -> Result<u64, StateError> {
        Ok(StateDb::last_l1_timestamp(self))
    }

    fn genesis_l1_timestamp(&self) -> Result<Option<u64>, StateError> {
        Ok(StateDb::genesis_l1_timestamp(self))
    }
    fn output_root(&self) -> Result<Fr, StateError> {
        Ok(StateDb::output_root(self))
    }

    fn account_state_root(&self) -> Result<Fr, StateError> {
        Ok(StateDb::account_state_root(self))
    }
    fn output_count(&self) -> Result<u64, StateError> {
        Ok(StateDb::output_count(self))
    }

    fn account_count(&self) -> Result<u64, StateError> {
        Ok(StateDb::account_count(self))
    }
    fn path(&self, tree: TreeId, index: u64) -> Result<[Fr; TREE_DEPTH], StateError> {
        StateDb::path(self, tree, index)
    }
    fn nullifier_seen(&self, nullifier: B256) -> Result<bool, StateError> {
        StateDb::nullifier_seen(self, nullifier)
    }
    fn nullifier_proof(&self, nullifier: B256) -> Result<NullifierProof, StateError> {
        StateDb::nullifier_proof(self, nullifier)
    }

    fn account_of(&self, addr: Address) -> Result<Option<AccountState>, StateError> {
        StateDb::account_of(self, addr)
    }
    fn l1_origin_root(&self) -> Result<Fr, StateError> {
        Ok(StateDb::l1_origin_root(self))
    }
    fn l1_origin_path(&self, index: u64) -> Result<Option<[Fr; TREE_DEPTH]>, StateError> {
        StateDb::l1_origin_path(self, index)
    }
    fn output_path_at(
        &self,
        number: u64,
        index: u64,
    ) -> Result<Option<[Fr; TREE_DEPTH]>, StateError> {
        StateDb::output_path_at(self, number, index)
    }
    fn l1_origin_path_at(
        &self,
        pcash_block_number: u64,
        index: u64,
    ) -> Result<Option<[Fr; TREE_DEPTH]>, StateError> {
        StateDb::l1_origin_path_at(self, pcash_block_number, index)
    }
    fn history_block_path_at(
        &self,
        at_block: u64,
        index: u64,
    ) -> Result<Option<[Fr; TREE_DEPTH]>, StateError> {
        StateDb::history_block_path_at(self, at_block, index)
    }
    fn block_header_path_at(
        &self,
        block_hash: B256,
        key: u64,
    ) -> Result<Option<(Fr, [Fr; COMMITMENT_TREE_DEPTH])>, StateError> {
        StateDb::block_header_path_at(self, block_hash, key)
    }
    fn state_path_at(
        &self,
        block_hash: B256,
        key: u64,
    ) -> Result<Option<(Fr, [Fr; STATE_TREE_DEPTH])>, StateError> {
        StateDb::state_path_at(self, block_hash, key)
    }
}
