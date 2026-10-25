//! Shared `StateDb` read wrappers over [`crate::inner::InnerState`].

macro_rules! impl_inner_reads {
    () => {
        $crate::delegate::impl_inner_reads!(common);
        fn path(&self, tree: TreeId, index: u64) -> Result<[Fr; TREE_DEPTH], StateError> {
            Ok(self.inner.tree(tree).path(index))
        }

        fn nullifier_seen(&self, nullifier: B256) -> Result<bool, StateError> {
            Ok(self.inner.nullifier_tree.contains(nullifier))
        }

        fn nullifier_proof(&self, nullifier: B256) -> Result<NullifierProof, StateError> {
            Ok(self.inner.nullifier_tree.proof(nullifier))
        }

        fn account_of(&self, address: Address) -> Result<Option<AccountState>, StateError> {
            Ok(self.inner.account_of(address))
        }
    };
    (common) => {
        fn issuance_state(&self) -> pcash_issuance::IssuanceState {
            self.inner.issuance
        }
        fn state_root(&self) -> StateRoot {
            self.inner.state_root()
        }

        fn state_components(&self) -> StateComponents {
            self.inner.state_components()
        }

        fn derivation_source(&self) -> DerivationSource {
            self.inner.source
        }

        fn canonical_tip(&self) -> Option<StoredBlock> {
            self.inner.canonical_tip.clone()
        }

        fn canonical_tip_summary(&self) -> Option<BlockSummary> {
            self.inner.canonical_tip.as_ref().map(BlockSummary::from)
        }

        fn boundary_retention(&self) -> Option<BoundaryRetention> {
            self.inner.boundary_retention()
        }

        fn last_l1_timestamp(&self) -> u64 {
            self.inner
                .canonical_tip
                .as_ref()
                .map_or(0, |block| block.header.timestamp)
        }

        fn genesis_l1_timestamp(&self) -> Option<u64> {
            self.inner.canonical_genesis_timestamp
        }

        fn output_root(&self) -> Fr {
            self.inner.root(TreeId::Output)
        }

        fn account_state_root(&self) -> Fr {
            self.inner.root(TreeId::Account)
        }

        fn output_count(&self) -> u64 {
            self.inner.output_count
        }

        fn account_count(&self) -> u64 {
            self.inner.account_count
        }

        fn l1_origin_root(&self) -> Fr {
            self.inner.l1_origin_tree.root()
        }

        fn block_header_path_at(
            &self,
            block_hash: B256,
            key: u64,
        ) -> Result<Option<(Fr, [Fr; COMMITMENT_TREE_DEPTH])>, StateError> {
            Ok(self
                .canonical_stored_block_by_hash(block_hash)?
                .and_then(|block| block.header.path(key)))
        }

        fn state_path_at(
            &self,
            block_hash: B256,
            key: u64,
        ) -> Result<Option<(Fr, [Fr; STATE_TREE_DEPTH])>, StateError> {
            match self.canonical_stored_block_by_hash(block_hash)? {
                Some(block) => Ok($crate::StateCommitment::new(block.state).path(key)),
                None => Ok(None),
            }
        }

        fn recent_pcash_block_hash_in_window(
            &self,
            block_hash: B256,
            current_timestamp: u64,
        ) -> bool {
            self.inner
                .recent_pcash_block_hash_in_window(block_hash, current_timestamp)
        }
    };
}

pub(crate) use impl_inner_reads;
