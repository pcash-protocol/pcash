//! Transport-free reads over one committed canonical-state read transaction.

#![allow(
    clippy::expect_used,
    reason = "validated fixed-size state representations make this conversion infallible"
)]

use alloy_primitives::{Address, B256, U256};
use pcash_state::{
    fr_from_canonical_bytes, fr_to_bytes, PcashBlock, PcashBlockMetadata, StateCommitment,
    StateError, StoredBlock, TreeId,
};

use crate::dto::{
    AccountDto, AccountProofDto, AccountProofPresent, AccountProofResultDto, BlockDto,
    BlockHeaderDto, BlockId, CurrentBoundaryEnvelope, DerivationDto, ForkCapabilityDto,
    HistoryProofDto, IndexStatusDto, L1OriginDto, L1OriginProofDto, NullifierLeafDto,
    NullifierProofDto, NullifierProofsDto, OutputLeafPathDto, OutputPathDto, OutputPathsDto,
    ProverAssetsDto, ReceiveMaterialDto, StatusDto,
};

/// One field element as a wire hash.
fn fr_hash(value: pcash_state::Fr) -> B256 {
    fr_to_bytes(value)
}

#[derive(Clone, Debug)]
pub struct StatusMeta {
    pub pcash_chain_id: u32,
    pub genesis_hash: B256,
    pub accepted_transaction_types: Vec<u8>,
    pub accepted_batch_versions: Vec<u8>,
    pub l1_chain_id: u64,
    pub inbox_address: Address,
    pub genesis_l1_block: u64,
    pub genesis_l1_block_hash: B256,
    pub latest_block: u64,
    pub latest_block_hash: B256,
    pub latest_block_timestamp: u64,
    pub finalized_block: u64,
    pub finalized_block_hash: B256,
    pub finalized_block_timestamp: u64,
    pub latest_l1_block_number: u64,
    pub latest_l1_block_hash: B256,
    pub observed_l1_block_number: Option<u64>,
    pub derivation: DerivationDto,
    pub finalized_l1_block_number: u64,
    pub finalized_l1_block_hash: B256,
    pub issued_so_far: U256,
    pub supply_cap: U256,
    pub total_succeeded: Option<u64>,
    pub total_failed: Option<u64>,
    pub total_transactions: Option<u64>,
    pub index_status: String,
    pub index_cursor: Option<BlockId>,
    pub prover_assets: Option<ProverAssetsDto>,
    pub fork_capability: ForkCapabilityDto,
}

pub fn status(
    state: &dyn pcash_state::StateRead,
    meta: &StatusMeta,
) -> Result<StatusDto, StateError> {
    let tip = state.canonical_tip()?;
    Ok(StatusDto {
        latest_block: meta.latest_block,
        latest_block_hash: meta.latest_block_hash,
        latest_block_timestamp: meta.latest_block_timestamp,
        finalized_block: meta.finalized_block,
        finalized_block_hash: meta.finalized_block_hash,
        finalized_block_timestamp: meta.finalized_block_timestamp,
        latest_l1_block_number: meta.latest_l1_block_number,
        latest_l1_block_hash: meta.latest_l1_block_hash,
        observed_l1_block_number: meta.observed_l1_block_number,
        derivation: meta.derivation,
        finalized_l1_block_number: meta.finalized_l1_block_number,
        finalized_l1_block_hash: meta.finalized_l1_block_hash,
        state_root: state.state_root()?.0,
        l1_origin_root: tip
            .as_ref()
            .map_or(B256::ZERO, |block| block.header.l1_origin_root),
        history_root: tip
            .as_ref()
            .map_or(B256::ZERO, |block| block.header.history_root),
        output_count: state.output_count()?,
        issued_so_far: meta.issued_so_far,
        supply_cap: meta.supply_cap,
        total_succeeded: meta.total_succeeded,
        total_failed: meta.total_failed,
        total_transactions: meta.total_transactions,
        index: IndexStatusDto {
            status: meta.index_status.clone(),
            cursor: meta.index_cursor,
        },
        prover_assets: meta.prover_assets.clone(),
        pcash_chain_id: meta.pcash_chain_id,
        genesis_hash: meta.genesis_hash,
        accepted_transaction_types: meta.accepted_transaction_types.clone(),
        accepted_batch_versions: meta.accepted_batch_versions.clone(),
        l1_chain_id: meta.l1_chain_id,
        inbox_address: meta.inbox_address,
        genesis_l1_block: meta.genesis_l1_block,
        genesis_l1_block_hash: meta.genesis_l1_block_hash,
        fork_capability: meta.fork_capability,
    })
}

fn path_bytes(
    state: &dyn pcash_state::StateRead,
    tree: TreeId,
    index: u64,
) -> Result<[B256; 40], StateError> {
    Ok(state.path(tree, index)?.map(fr_hash))
}

pub fn boundary_envelope(block: &StoredBlock) -> CurrentBoundaryEnvelope {
    CurrentBoundaryEnvelope {
        state: block.state,
        header: block.header.clone(),
        block_hash: block.hash,
    }
}

pub fn current_boundary(
    state: &dyn pcash_state::StateRead,
) -> Result<Option<CurrentBoundaryEnvelope>, StateError> {
    Ok(state.canonical_tip()?.as_ref().map(boundary_envelope))
}

pub fn block_dto(
    state: &dyn pcash_state::StateRead,
    block: PcashBlock,
    full_transactions: bool,
) -> Result<BlockDto, StateError> {
    let metadata = PcashBlockMetadata::from(&block);
    block_metadata_dto(
        state,
        metadata,
        full_transactions.then_some(block.transaction_bytes),
    )
}

pub fn block_metadata_dto(
    state: &dyn pcash_state::StateRead,
    block: PcashBlockMetadata,
    transaction_bytes: Option<Vec<Vec<u8>>>,
) -> Result<BlockDto, StateError> {
    let transaction_result_count = block.transaction_results.len() as u64;
    let transaction_bytes =
        transaction_bytes.map(|transactions| transactions.into_iter().map(Into::into).collect());
    let batches = state.l1_delivery_batches(block.header.number)?;
    let mut transaction_results = Vec::with_capacity(block.transaction_results.len());
    for result in block.transaction_results {
        let (batch, item) = pcash_state::admitted_delivery(&batches, &result).ok_or_else(|| {
            StateError::Backend(format!(
                "block {} result at L1 transaction index {} has no delivery manifest item",
                block.header.number, result.l1_transaction_index
            ))
        })?;
        transaction_results.push(crate::dto::TransactionResultDto {
            inclusion: crate::dto::InclusionId {
                l1_block_number: block.l1_origin.block_number,
                l1_block_hash: block.l1_origin.block_hash,
                l1_transaction_index: result.l1_transaction_index,
                l1_transaction_hash: batch.l1_transaction_hash,
                batch_item_index: result.batch_item_index,
            },
            content_hash: item.content_hash,
            tx_id: pcash_state::transaction_id(
                block.l1_origin.block_hash,
                result.l1_transaction_index,
                result.batch_item_index,
            ),
            outcome: result.outcome,
        });
    }
    Ok(BlockDto {
        number: block.header.number,
        hash: block.hash,
        parent_hash: block.header.parent_hash,
        timestamp: block.header.timestamp,
        transaction_results_root: block.header.transaction_results_root,
        state_root: block.header.state_root,
        l1_origin_root: block.header.l1_origin_root,
        history_root: block.header.history_root,
        transaction_result_count,
        transaction_results,
        transaction_bytes,
        l1_origin: L1OriginDto {
            block_number: block.l1_origin.block_number,
            block_hash: block.l1_origin.block_hash,
            block_timestamp: block.l1_origin.block_timestamp,
            l1_logs_root: block.l1_origin.l1_logs_root,
            l1_log_count: block.l1_origin.l1_log_count,
        },
    })
}

pub fn get_output_path(
    state: &dyn pcash_state::StateRead,
    output_index: u64,
) -> Result<Option<OutputPathDto>, StateError> {
    let components = state.state_components()?;
    if output_index >= components.output_count {
        return Ok(None);
    }
    let Some(boundary) = current_boundary(state)? else {
        return Ok(None);
    };
    Ok(Some(OutputPathDto {
        output_index,
        root: components.output_root,
        count: components.output_count,
        siblings: path_bytes(state, TreeId::Output, output_index)?,
        boundary,
    }))
}

pub fn get_output_paths(
    state: &dyn pcash_state::StateRead,
    indices: &[u64],
) -> Result<Option<OutputPathsDto>, StateError> {
    let components = state.state_components()?;
    if indices
        .iter()
        .any(|index| *index >= components.output_count)
    {
        return Ok(None);
    }
    let Some(boundary) = current_boundary(state)? else {
        return Ok(None);
    };
    Ok(Some(OutputPathsDto {
        root: components.output_root,
        count: components.output_count,
        paths: indices
            .iter()
            .copied()
            .map(|output_index| {
                Ok(OutputLeafPathDto {
                    output_index,
                    siblings: path_bytes(state, TreeId::Output, output_index)?,
                })
            })
            .collect::<Result<_, StateError>>()?,
        boundary,
    }))
}

pub fn get_account(
    state: &dyn pcash_state::StateRead,
    address: Address,
    material: ReceiveMaterialDto,
) -> Result<Option<AccountDto>, StateError> {
    let Some(view) = state.account_of(address)? else {
        return Ok(None);
    };
    Ok(Some(AccountDto {
        address,
        index: view.index,
        account_revision: view.revision,
        account_kind: view.kind,
        nullifier_key_commitment: fr_hash(view.nullifier_key_commitment),
        account_rule_set_commitment: fr_hash(view.account_rule_set_commitment),
        receive_key_hash: view.receive_key_hash,
        material,
    }))
}

pub fn get_account_proof(
    state: &dyn pcash_state::StateRead,
    address: Address,
    material: ReceiveMaterialDto,
) -> Result<AccountProofResultDto, StateError> {
    let Some(account) = get_account(state, address, material)? else {
        return Ok(AccountProofResultDto::not_found(address));
    };
    let components = state.state_components()?;
    let Some(tip) = state.canonical_tip()? else {
        return Ok(AccountProofResultDto::not_found(address));
    };
    let boundary = boundary_envelope(&tip);
    let Some((_, state_root_header_siblings)) =
        tip.header.path(pcash_state::BLOCK_HEADER_KEY_STATE_ROOT)
    else {
        return Ok(AccountProofResultDto::not_found(address));
    };
    let Some((_, account_state_root_state_siblings)) =
        StateCommitment::new(tip.state).path(pcash_state::STATE_KEY_ACCOUNT_STATE_ROOT)
    else {
        return Ok(AccountProofResultDto::not_found(address));
    };
    Ok(AccountProofResultDto::Present(Box::new(AccountProofDto {
        status: AccountProofPresent::Present,
        account_state_root: components.account_state_root,
        account_siblings: path_bytes(state, TreeId::Account, account.index)?,
        account_count: components.account_count,
        account,
        state_root_header_siblings: state_root_header_siblings.map(fr_hash),
        account_state_root_state_siblings: account_state_root_state_siblings.map(fr_hash),
        boundary,
    })))
}

pub fn get_block_header(
    state: &dyn pcash_state::StateRead,
    block_number: u64,
) -> Result<Option<BlockHeaderDto>, StateError> {
    Ok(state
        .canonical_stored_block(block_number)?
        .as_ref()
        .map(block_header))
}

pub fn get_block_header_by_hash(
    state: &dyn pcash_state::StateRead,
    block_hash: B256,
) -> Result<Option<BlockHeaderDto>, StateError> {
    Ok(state
        .canonical_stored_block_by_hash(block_hash)?
        .as_ref()
        .map(block_header))
}

fn block_header(block: &StoredBlock) -> BlockHeaderDto {
    BlockHeaderDto {
        recent_pcash_block_hash: block.hash,
        boundary: boundary_envelope(block),
    }
}

pub fn get_l1_origin_proof(
    state: &dyn pcash_state::StateRead,
    block_hash: B256,
    l1_block_number: u64,
) -> Result<Option<L1OriginProofDto>, StateError> {
    let Some(boundary) = state.canonical_stored_block_by_hash(block_hash)? else {
        return Ok(None);
    };
    let pcash_block_number = boundary.header.number;
    let source = state.derivation_source()?;
    let Some(leaf_index) = l1_block_number.checked_sub(source.genesis_l1_block) else {
        return Ok(None);
    };
    if leaf_index > pcash_block_number {
        return Ok(None);
    }
    let Some(requested) = state
        .canonical_stored_block(leaf_index)?
        .map(|block| block.l1_origin)
    else {
        return Ok(None);
    };
    if requested.block_number != l1_block_number {
        return Ok(None);
    }
    let Some((l1_origin_root, root_siblings)) = boundary
        .header
        .path(pcash_state::BLOCK_HEADER_KEY_L1_ORIGIN_ROOT)
    else {
        return Ok(None);
    };
    let Some(l1_origin_siblings) = state.l1_origin_path_at(pcash_block_number, leaf_index)? else {
        return Ok(None);
    };
    Ok(Some(L1OriginProofDto {
        recent_pcash_block_hash: block_hash,
        l1_origin_root: fr_hash(l1_origin_root),
        l1_origin_root_siblings: root_siblings.map(fr_hash),
        l1_block_number,
        l1_block_hash: requested.block_hash,
        l1_block_timestamp: requested.block_timestamp,
        l1_logs_root: requested.l1_logs_root,
        l1_log_count: requested.l1_log_count,
        l1_origin_index: leaf_index,
        l1_origin_siblings: l1_origin_siblings.map(fr_hash),
        boundary: boundary_envelope(&boundary),
    }))
}

pub fn get_history_proof(
    state: &dyn pcash_state::StateRead,
    block_hash: B256,
    historical_block_number: u64,
) -> Result<Option<HistoryProofDto>, StateError> {
    let Some(boundary) = state.canonical_stored_block_by_hash(block_hash)? else {
        return Ok(None);
    };
    let pcash_block_number = boundary.header.number;
    if historical_block_number >= pcash_block_number {
        return Ok(None);
    }
    let Some(historical) = state.canonical_stored_block(historical_block_number)? else {
        return Ok(None);
    };
    let Some((history_root, root_siblings)) = boundary
        .header
        .path(pcash_state::BLOCK_HEADER_KEY_HISTORY_ROOT)
    else {
        return Ok(None);
    };
    let Some(history_siblings) =
        state.history_block_path_at(pcash_block_number, historical_block_number)?
    else {
        return Ok(None);
    };
    Ok(Some(HistoryProofDto {
        recent_pcash_block_hash: block_hash,
        history_root: fr_hash(history_root),
        history_root_siblings: root_siblings.map(fr_hash),
        historical_block_number,
        historical_block_hash: historical.hash,
        history_siblings: history_siblings.map(fr_hash),
        boundary: boundary_envelope(&boundary),
    }))
}

pub fn are_nullifiers_spent(
    state: &dyn pcash_state::StateRead,
    nullifiers: &[B256],
) -> Result<Vec<bool>, StateError> {
    nullifiers
        .iter()
        .copied()
        .map(|nullifier| state.nullifier_seen(nullifier))
        .collect()
}

pub fn get_nullifier_proofs(
    state: &dyn pcash_state::StateRead,
    nullifiers: &[B256],
) -> Result<Option<NullifierProofsDto>, StateError> {
    let components = state.state_components()?;
    let proofs = nullifiers
        .iter()
        .copied()
        .map(|nullifier| {
            let proof = state.nullifier_proof(nullifier)?;
            Ok(NullifierProofDto {
                nullifier,
                leaf: NullifierLeafDto {
                    value: proof.leaf.value,
                    next_value: proof.leaf.next_value,
                    next_index: proof.leaf.next_index,
                },
                leaf_index: proof.index,
                siblings: proof.siblings.map(fr_hash),
            })
        })
        .collect::<Result<_, StateError>>()?;
    let Some(boundary) = current_boundary(state)? else {
        return Ok(None);
    };
    Ok(Some(NullifierProofsDto {
        root: components.nullifier_root,
        proofs,
        boundary,
    }))
}

pub fn parse_block_hash(hash: B256) -> Option<B256> {
    fr_from_canonical_bytes(hash).map(|_| hash)
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]
mod tests {
    use super::*;
    use pcash_state::StateDb;
    use pcash_state::{
        receive_key_hash, AccountOp, BlockInput, BlockUpdate, DerivationSource, Fr, L1Origin,
        MemState, ML_KEM768_PUBLIC_KEY_LEN,
    };

    #[test]
    fn account_convenience_view_is_flat_and_matches_the_authenticated_proof() {
        let source = DerivationSource {
            pcash_chain_id: 7,
            l1_chain_id: 8,
            inbox_address: Address::repeat_byte(9),
            genesis_l1_block: 100,
            genesis_l1_block_hash: B256::repeat_byte(10),
        };
        let address = Address::repeat_byte(0x44);
        let key = vec![0x5a; ML_KEM768_PUBLIC_KEY_LEN];
        let key_hash = receive_key_hash(&key);
        let mut state = MemState::new(source);
        state
            .commit(
                BlockInput {
                    transaction_effects: Vec::new(),
                    l1_logs: Vec::new(),
                    history: pcash_state::CanonicalBlockHistory::default(),
                    number: 0,
                    timestamp: 1_000,
                    transaction_results: Vec::new(),
                    transaction_bytes: Vec::new(),
                    l1_origin: L1Origin {
                        block_number: source.genesis_l1_block,
                        block_hash: source.genesis_l1_block_hash,
                        block_timestamp: 1_000,
                        l1_logs_root: B256::ZERO,
                        l1_log_count: 0,
                    },
                },
                BlockUpdate {
                    account_ops: vec![AccountOp {
                        address,
                        nullifier_key_commitment: Fr::from(11u64),
                        account_rule_set_commitment: Fr::from(12u64),
                        kind: 0,
                        receive_key_hash: key_hash,
                        published_receive_key: Some(key.clone()),
                    }],
                    ..BlockUpdate::empty(state.issuance_state())
                },
            )
            .unwrap();

        let account = get_account(
            &state,
            address,
            ReceiveMaterialDto::Available {
                ml_kem768_public_key: key.clone().into(),
            },
        )
        .unwrap();
        let account = account.unwrap();
        assert_eq!(account.address, address);
        assert_eq!(account.index, 0);
        assert_eq!(account.account_revision, 1);
        assert_eq!(
            account.material,
            ReceiveMaterialDto::Available {
                ml_kem768_public_key: key.clone().into(),
            }
        );

        let proof = get_account_proof(
            &state,
            address,
            ReceiveMaterialDto::Available {
                ml_kem768_public_key: key.into(),
            },
        )
        .unwrap();
        let AccountProofResultDto::Present(proof) = proof else {
            panic!("occupied address must have an account proof");
        };
        let wire = serde_json::to_value(&proof).expect("account proof serializes");
        assert!(wire.get("deliveryRoot").is_none());
        assert!(wire.get("deliverySiblings").is_none());
        assert!(wire["account"].get("delivery").is_none());
        assert_eq!(
            wire["account"]["receiveKeyHash"],
            serde_json::to_value(key_hash).unwrap()
        );
        assert_eq!(proof.account.address, account.address);
        assert_eq!(proof.account.index, account.index);
        assert_eq!(proof.account.account_revision, account.account_revision);
        let view = state.account_of(address).unwrap().unwrap();
        let leaf = pcash_state::account_state_commitment(
            address,
            view.nullifier_key_commitment,
            view.account_rule_set_commitment,
            view.kind,
            view.revision,
            view.receive_key_hash,
        );
        assert_eq!(
            pcash_crypto::merkle::root_from_index(
                leaf,
                view.index,
                &proof
                    .account_siblings
                    .map(|sibling| pcash_state::fr_from_canonical_bytes(sibling).unwrap()),
            ),
            pcash_state::fr_from_canonical_bytes(proof.account_state_root).unwrap()
        );

        let missing = Address::repeat_byte(0x55);
        assert!(get_account(&state, missing, ReceiveMaterialDto::NotPresent)
            .unwrap()
            .is_none());
        assert!(matches!(
            get_account_proof(&state, missing, ReceiveMaterialDto::NotPresent),
            Ok(AccountProofResultDto::NotFound { address, .. }) if address == missing
        ));
    }

    #[test]
    fn output_path_reads_return_none_when_the_output_is_absent() {
        let source = DerivationSource {
            pcash_chain_id: 7,
            l1_chain_id: 8,
            inbox_address: Address::repeat_byte(9),
            genesis_l1_block: 100,
            genesis_l1_block_hash: B256::repeat_byte(10),
        };
        let mut state = MemState::new(source);
        assert!(get_output_path(&state, 0).unwrap().is_none());
        assert!(get_output_paths(&state, &[0]).unwrap().is_none());

        state
            .commit(
                BlockInput {
                    transaction_effects: Vec::new(),
                    l1_logs: Vec::new(),
                    history: pcash_state::CanonicalBlockHistory::default(),
                    number: 0,
                    timestamp: 1_000,
                    transaction_results: Vec::new(),
                    transaction_bytes: Vec::new(),
                    l1_origin: source.anchor_origin(),
                },
                BlockUpdate::empty(state.issuance_state()),
            )
            .unwrap();
        assert!(get_output_path(&state, 0).unwrap().is_none());
        assert!(get_output_paths(&state, &[0]).unwrap().is_none());

        state
            .commit(
                BlockInput {
                    transaction_effects: Vec::new(),
                    l1_logs: Vec::new(),
                    history: pcash_state::CanonicalBlockHistory::default(),
                    number: 1,
                    timestamp: 1_001,
                    transaction_results: Vec::new(),
                    transaction_bytes: Vec::new(),
                    l1_origin: L1Origin {
                        block_number: 101,
                        block_hash: B256::repeat_byte(11),
                        block_timestamp: 1_001,
                        l1_logs_root: B256::ZERO,
                        l1_log_count: 0,
                    },
                },
                BlockUpdate {
                    output_commitments: vec![Fr::from(1u64), Fr::from(2u64)],
                    ..BlockUpdate::empty(state.issuance_state())
                },
            )
            .unwrap();
        let path = get_output_path(&state, 0)
            .unwrap()
            .expect("output 0 is occupied");
        assert_eq!(path.output_index, 0);
        assert_eq!(path.count, 2);
        assert!(get_output_path(&state, 1).unwrap().is_some());
        assert!(get_output_path(&state, 2).unwrap().is_none());
        assert!(get_output_paths(&state, &[0, 1]).unwrap().is_some());
        assert!(get_output_paths(&state, &[0, 2]).unwrap().is_none());
    }

    #[test]
    fn block_state_l1_origin_and_history_reads_share_one_authenticated_boundary() {
        let source = DerivationSource {
            pcash_chain_id: 7,
            l1_chain_id: 8,
            inbox_address: Address::repeat_byte(9),
            genesis_l1_block: 100,
            genesis_l1_block_hash: B256::repeat_byte(10),
        };
        let mut state = MemState::new(source);
        let (genesis, _) = state
            .commit(
                BlockInput {
                    transaction_effects: Vec::new(),
                    l1_logs: Vec::new(),
                    history: pcash_state::CanonicalBlockHistory::default(),
                    number: 0,
                    timestamp: 1_000,
                    transaction_results: Vec::new(),
                    transaction_bytes: Vec::new(),
                    l1_origin: source.anchor_origin(),
                },
                BlockUpdate::empty(state.issuance_state()),
            )
            .unwrap();
        let (tip, _) = state
            .commit(
                BlockInput {
                    transaction_effects: Vec::new(),
                    l1_logs: Vec::new(),
                    history: pcash_state::CanonicalBlockHistory::default(),
                    number: 1,
                    timestamp: 1_001,
                    transaction_results: Vec::new(),
                    transaction_bytes: Vec::new(),
                    l1_origin: L1Origin {
                        block_number: 101,
                        block_hash: B256::repeat_byte(11),
                        block_timestamp: 1_001,
                        l1_logs_root: B256::ZERO,
                        l1_log_count: 0,
                    },
                },
                BlockUpdate::empty(state.issuance_state()),
            )
            .unwrap();

        let header = get_block_header(&state, 1).unwrap().unwrap();
        assert_eq!(header.recent_pcash_block_hash, tip.block.hash);
        assert_eq!(header.boundary.block_hash, tip.block.hash);

        let by_hash = get_block_header_by_hash(&state, tip.block.hash)
            .unwrap()
            .unwrap();
        assert_eq!(by_hash.boundary.block_hash, tip.block.hash);
        assert_eq!(by_hash.boundary.header.number, 1);
        assert!(get_block_header_by_hash(&state, B256::repeat_byte(0x77))
            .unwrap()
            .is_none());

        let l1_origin = get_l1_origin_proof(&state, tip.block.hash, 100)
            .unwrap()
            .unwrap();
        assert_eq!(l1_origin.l1_origin_root, tip.block.header.l1_origin_root);
        assert_eq!(l1_origin.l1_block_hash, source.genesis_l1_block_hash);
        assert_eq!(l1_origin.l1_origin_index, 0);
        assert_eq!(l1_origin.boundary.block_hash, tip.block.hash);

        let history = get_history_proof(&state, tip.block.hash, 0)
            .unwrap()
            .unwrap();
        assert_eq!(history.history_root, tip.block.header.history_root);
        assert_eq!(history.historical_block_hash, genesis.block.hash);
        assert_eq!(history.boundary.block_hash, tip.block.hash);

        assert!(get_history_proof(&state, tip.block.hash, 1)
            .unwrap()
            .is_none());
        assert!(get_l1_origin_proof(&state, tip.block.hash, 102)
            .unwrap()
            .is_none());
    }

    #[test]
    fn published_nullifier_proofs_open_under_the_committed_root() {
        let source = DerivationSource {
            pcash_chain_id: 7,
            l1_chain_id: 8,
            inbox_address: Address::repeat_byte(9),
            genesis_l1_block: 100,
            genesis_l1_block_hash: B256::repeat_byte(10),
        };
        let mut state = MemState::new(source);
        let nullifier = fr_to_bytes(Fr::from(88u64));
        state
            .commit(
                BlockInput {
                    transaction_effects: Vec::new(),
                    l1_logs: Vec::new(),
                    history: pcash_state::CanonicalBlockHistory::default(),
                    number: 0,
                    timestamp: 1_000,
                    transaction_results: Vec::new(),
                    transaction_bytes: Vec::new(),
                    l1_origin: source.anchor_origin(),
                },
                BlockUpdate {
                    nullifiers: vec![nullifier],
                    ..BlockUpdate::empty(state.issuance_state())
                },
            )
            .unwrap();
        let absent = fr_to_bytes(Fr::from(89u64));
        let proofs = get_nullifier_proofs(&state, &[nullifier, absent])
            .unwrap()
            .unwrap();
        assert_eq!(proofs.root, state.state_components().nullifier_root);
        let spent = proofs
            .proofs
            .iter()
            .map(|published| {
                let proof = pcash_state::NullifierProof {
                    nullifier: published.nullifier,
                    leaf: pcash_state::NullifierLeaf {
                        value: published.leaf.value,
                        next_value: published.leaf.next_value,
                        next_index: published.leaf.next_index,
                    },
                    index: published.leaf_index,
                    siblings: published
                        .siblings
                        .map(|sibling| fr_from_canonical_bytes(sibling).unwrap()),
                };
                assert!(proof.verify(proofs.root));
                proof.spent()
            })
            .collect::<Vec<_>>();
        assert_eq!(spent, [true, false]);
    }
}

/// Canonical payout discovery, bounded independently of sparse payout frequency.
pub fn get_payouts(
    state: &dyn pcash_state::StateRead,
    query: crate::request::PayoutQuery,
) -> Result<crate::dto::PayoutPageDto, crate::IndexReadError> {
    use crate::{
        dto::{PayoutCursorDto, PayoutPageDto, PayoutScanRecordDto},
        IndexReadError,
    };
    let limit = query.limit.unwrap_or(100);
    if limit == 0 || limit > 1000 {
        return Err(IndexReadError::Invalid(
            "limit must be between 1 and 1000".into(),
        ));
    }
    if query.cursor.is_some() && query.from_block.is_some() {
        return Err(IndexReadError::Invalid(
            "fromBlock cannot accompany a cursor".into(),
        ));
    }
    let tip = state
        .canonical_tip_summary()?
        .ok_or_else(|| IndexReadError::Unavailable("canonical genesis is not committed".into()))?;
    let (anchor, mut number, mut payout_index) = if let Some(cursor) = query.cursor {
        if cursor.anchor.block_number > tip.number {
            return Err(IndexReadError::CursorMismatch);
        }
        let canonical = state
            .canonical_stored_block(cursor.anchor.block_number)?
            .ok_or(IndexReadError::CursorMismatch)?;
        if canonical.hash != cursor.anchor.block_hash {
            return Err(IndexReadError::CursorMismatch);
        }
        if cursor.next_block > cursor.anchor.block_number.saturating_add(1)
            || (cursor.next_block > cursor.anchor.block_number && cursor.next_payout_index != 0)
        {
            return Err(IndexReadError::Invalid(
                "payout cursor position exceeds its anchor".into(),
            ));
        }
        (cursor.anchor, cursor.next_block, cursor.next_payout_index)
    } else {
        (
            BlockId {
                block_number: tip.number,
                block_hash: tip.hash,
            },
            query.from_block.unwrap_or(0),
            0,
        )
    };
    let mut records = Vec::new();
    let mut scanned_blocks = 0;
    while number <= anchor.block_number && scanned_blocks < 256 && records.len() < limit as usize {
        let block = state.canonical_stored_block(number)?.ok_or_else(|| {
            IndexReadError::Unavailable("canonical payout block is unavailable".into())
        })?;
        let payouts = state.payout_records(number)?.ok_or_else(|| {
            IndexReadError::Unavailable("canonical payout history is unavailable".into())
        })?;
        let index = usize::try_from(payout_index)
            .map_err(|_| IndexReadError::Invalid("payout index is too large".into()))?;
        if index > payouts.len() {
            return Err(IndexReadError::Invalid(
                "payout index exceeds the block's records".into(),
            ));
        }
        let available = (limit as usize - records.len()).min(payouts.len() - index);
        records.extend(
            payouts
                .into_iter()
                .skip(index)
                .take(available)
                .map(|payout| PayoutScanRecordDto {
                    block_number: number,
                    block_hash: block.hash,
                    payout: crate::dto::PayoutOutputDto {
                        transaction_id: payout.transaction_id(block.l1_origin.block_hash),
                        payout: payout.into(),
                    },
                }),
        );
        payout_index += available as u64;
        // A full page may end exactly at a block boundary; the next request can
        // advance past that block after seeing its consumed record count.
        if records.len() == limit as usize {
            break;
        }
        number += 1;
        payout_index = 0;
        scanned_blocks += 1;
    }
    Ok(PayoutPageDto {
        at_block_number: anchor.block_number,
        at_block_hash: anchor.block_hash,
        records,
        next_cursor: (number <= anchor.block_number).then_some(PayoutCursorDto {
            anchor,
            next_block: number,
            next_payout_index: payout_index,
        }),
    })
}

/// A candidate-timestamp estimate over one authenticated canonical parent.
pub fn get_issuance_quote(
    state: &dyn pcash_state::StateRead,
    candidate_timestamp: u64,
) -> Result<Option<crate::dto::IssuanceQuoteDto>, crate::IssuanceQuoteError> {
    let Some(parent) = state.canonical_tip_summary()? else {
        return Ok(None);
    };
    if candidate_timestamp < parent.timestamp {
        return Err(crate::IssuanceQuoteError::CandidateBeforeParent {
            parent: parent.timestamp,
            candidate: candidate_timestamp,
        });
    }
    let issuance = state.state_components()?.issuance;
    let elapsed = candidate_timestamp - parent.timestamp;
    let quote = pcash_issuance::quote(issuance, elapsed);
    Ok(Some(crate::dto::IssuanceQuoteDto {
        parent: crate::dto::IssuanceParentDto {
            block_number: parent.number,
            block_hash: parent.hash,
            timestamp: parent.timestamp,
        },
        candidate_timestamp,
        supply_cap: pcash_issuance::supply_cap(),
        issued_so_far: issuance.issued_so_far,
        baseline: quote.baseline,
        internal_offer: quote.internal_offer,
        block_allowance: quote.block_allowance,
        max_single_action_reward: quote.max_single_action_reward,
        multiplier_q: quote.multiplier_q,
        lag_q: issuance.lag_q,
        exhausted: quote.exhausted,
        reward_possible: quote.reward_possible(),
    }))
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct fixture assertions"
)]
mod payout_tests {
    use super::*;
    use pcash_state::{
        BlockInput, BlockUpdate, DerivationSource, L1Origin, MemState, StateDb, TransactionOutcome,
        TransactionResult,
    };

    fn source() -> DerivationSource {
        DerivationSource {
            pcash_chain_id: 7,
            l1_chain_id: 1,
            inbox_address: Address::ZERO,
            genesis_l1_block: 100,
            genesis_l1_block_hash: B256::repeat_byte(1),
        }
    }

    fn append(state: &mut MemState, number: u64, count: u64, timestamp: u64) {
        let payouts = (0..count)
            .map(|index| pcash_state::PayoutRecord {
                source: pcash_state::PayoutSource::DesignatedIssuance {
                    l1_transaction_index: 0,
                    batch_item_index: index,
                },
                component: pcash_state::PayoutComponent::Issuance,
                amount: U256::from(10),
                owner_commitment: fr_to_bytes(pcash_state::Fr::from(3u64)),
                output_index: number * 10 + index,
                contexts: vec![fr_to_bytes(pcash_state::Fr::from(4u64 + index))],
            })
            .collect();
        append_payouts(state, number, count, timestamp, payouts);
    }

    fn append_payouts(
        state: &mut MemState,
        number: u64,
        count: u64,
        timestamp: u64,
        payouts: Vec<pcash_state::PayoutRecord>,
    ) {
        let source = source();
        let hash = if number == 0 {
            source.genesis_l1_block_hash
        } else {
            B256::from(U256::from(timestamp).to_be_bytes::<32>())
        };
        let origin = L1Origin {
            block_number: source.genesis_l1_block + number,
            block_hash: hash,
            block_timestamp: timestamp,
            l1_logs_root: B256::ZERO,
            l1_log_count: 0,
        };
        let transaction_bytes = (0..count)
            .map(|index| vec![index as u8])
            .collect::<Vec<_>>();
        let results = (0..count)
            .map(|index| TransactionResult {
                tx_type: 1,
                funding_mode: 0,
                l1_transaction_index: 0,
                batch_item_index: index,
                outcome: TransactionOutcome::Succeeded,
                poster_owner_commitment: B256::repeat_byte(0x0a),
                output_start_index: 0,
                statement_hash: B256::repeat_byte(0x0b),
            })
            .collect();
        state
            .commit(
                BlockInput {
                    transaction_effects: Vec::new(),
                    l1_logs: Vec::new(),
                    number,
                    timestamp,
                    l1_origin: origin,
                    transaction_results: results,
                    transaction_bytes,
                    history: pcash_state::CanonicalBlockHistory {
                        payouts,
                        ..Default::default()
                    },
                },
                BlockUpdate::empty(state.issuance_state()),
            )
            .unwrap();
    }

    #[test]
    fn payout_pages_hold_their_anchor_and_reject_orphaned_cursors() {
        let mut state = MemState::new(source());
        append(&mut state, 0, 2, 1);
        append(&mut state, 1, 1, 2);
        let first = get_payouts(
            &state,
            crate::PayoutQuery {
                limit: Some(1),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(first.records.len(), 1);
        assert_eq!(first.records[0].payout.payout.output_index, 0);
        let cursor = first.next_cursor.unwrap();
        append(&mut state, 2, 2, 3);
        let rest = get_payouts(
            &state,
            crate::PayoutQuery {
                cursor: Some(cursor),
                limit: Some(100),
                from_block: None,
            },
        )
        .unwrap();
        assert_eq!(rest.at_block_number, 1);
        assert_eq!(rest.at_block_hash, first.at_block_hash);
        assert_eq!(rest.records.len(), 2);
        assert!(rest.next_cursor.is_none());
        state.restore_to(source().genesis_l1_block).unwrap();
        append(&mut state, 1, 1, 4);
        assert!(matches!(
            get_payouts(
                &state,
                crate::PayoutQuery {
                    cursor: Some(cursor),
                    ..Default::default()
                }
            ),
            Err(crate::IndexReadError::CursorMismatch)
        ));
    }

    #[test]
    fn payout_pages_carry_both_kinds_with_their_components() {
        let mut state = MemState::new(source());
        let designated = pcash_state::PayoutRecord {
            source: pcash_state::PayoutSource::DesignatedIssuance {
                l1_transaction_index: 0,
                batch_item_index: 0,
            },
            component: pcash_state::PayoutComponent::Issuance,
            amount: U256::from(10),
            owner_commitment: fr_to_bytes(pcash_state::Fr::from(3u64)),
            output_index: 1,
            contexts: vec![fr_to_bytes(pcash_state::Fr::from(4u64))],
        };
        let poster_source = pcash_state::PayoutSource::PosterPayout {
            l1_transaction_indices: vec![0],
        };
        let poster_fee = pcash_state::PayoutRecord {
            source: poster_source.clone(),
            component: pcash_state::PayoutComponent::OpenFee,
            amount: U256::from(5),
            owner_commitment: fr_to_bytes(pcash_state::Fr::from(5u64)),
            output_index: 2,
            contexts: vec![fr_to_bytes(pcash_state::Fr::from(6u64))],
        };
        let poster_issuance = pcash_state::PayoutRecord {
            source: poster_source,
            component: pcash_state::PayoutComponent::Issuance,
            amount: U256::from(10),
            output_index: 3,
            ..poster_fee.clone()
        };
        append_payouts(
            &mut state,
            0,
            3,
            1,
            vec![
                designated.clone(),
                poster_fee.clone(),
                poster_issuance.clone(),
            ],
        );
        let page = get_payouts(&state, crate::PayoutQuery::default()).unwrap();
        let block = state.canonical_stored_block(0).unwrap().unwrap();
        assert_eq!(page.records.len(), 3);
        assert_eq!(
            page.records[0].payout.transaction_id,
            designated.transaction_id(block.l1_origin.block_hash)
        );
        assert!(page.records[0].payout.transaction_id.is_some());
        assert_eq!(page.records[0].payout.payout, designated.into());
        assert_eq!(page.records[1].payout.transaction_id, None);
        assert_eq!(page.records[1].payout.payout, poster_fee.into());
        assert_eq!(page.records[2].payout.transaction_id, None);
        assert_eq!(page.records[2].payout.payout, poster_issuance.into());
        let wire = serde_json::to_value(&page.records[1]).unwrap();
        assert_eq!(wire["source"]["kind"], "posterPayout");
        assert_eq!(
            wire["source"]["l1TransactionIndices"],
            serde_json::json!([0])
        );
        assert_eq!(wire["component"], "openFee");
        assert_eq!(wire["amount"], "0x5");
        let issuance_wire = serde_json::to_value(&page.records[2]).unwrap();
        assert_eq!(issuance_wire["component"], "issuance");
        assert_eq!(issuance_wire["amount"], "0xa");
        assert!(wire.get("kind").is_none());
    }

    #[test]
    fn sparse_scan_returns_progress_and_never_claims_future_completion() {
        let mut state = MemState::new(source());
        for number in 0..257 {
            append(&mut state, number, 0, number + 1);
        }
        let first = get_payouts(&state, crate::PayoutQuery::default()).unwrap();
        assert!(first.records.is_empty());
        let cursor = first.next_cursor.unwrap();
        assert_eq!(cursor.next_block, 256);
        let last = get_payouts(
            &state,
            crate::PayoutQuery {
                cursor: Some(cursor),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(last.records.is_empty());
        assert!(last.next_cursor.is_none());
    }

    #[test]
    fn quote_keeps_the_parent_and_candidate_timestamp_distinct() {
        let mut state = MemState::new(source());
        assert!(get_issuance_quote(&state, 86400).unwrap().is_none());
        append(&mut state, 0, 0, 12);
        assert!(matches!(
            get_issuance_quote(&state, 11),
            Err(crate::IssuanceQuoteError::CandidateBeforeParent {
                parent: 12,
                candidate: 11
            })
        ));
        let at_parent = get_issuance_quote(&state, 12).unwrap().unwrap();
        assert_eq!(at_parent.parent.timestamp, 12);
        assert_eq!(at_parent.candidate_timestamp, 12);
        assert!(at_parent.reward_possible);
        assert_eq!(at_parent.issued_so_far, U256::ZERO);
        assert_eq!(at_parent.internal_offer, at_parent.max_single_action_reward);
        assert!(at_parent.block_allowance > at_parent.max_single_action_reward);
        let later = get_issuance_quote(&state, 12 + 365 * 86400)
            .unwrap()
            .unwrap();
        assert!(later.reward_possible);
        assert!(!later.exhausted);
        assert!(later.internal_offer >= at_parent.internal_offer);
    }
}

/// All components are read through the caller's single committed snapshot.
pub fn get_result_proof(
    state: &dyn pcash_state::StateRead,
    rules: &pcash_derive::ProtocolRules,
    recent_hash: B256,
    number: u64,
    position: crate::dto::ResultPosition,
) -> Result<Option<crate::dto::ResultProofDto>, StateError> {
    use crate::dto::{
        AccountUpdateCurrentAccountStateDto, AccountUpdateOpeningDto, PayoutResultLeafDto,
        ResultLeafDto, ResultPosition, ResultProofDto, ResultStatementDto,
    };
    let Some(recent) = state.canonical_stored_block_by_hash(recent_hash)? else {
        return Ok(None);
    };
    if number > recent.header.number {
        return Ok(None);
    }
    let Some(block) = state.canonical_block_metadata(number)? else {
        return Ok(None);
    };
    let payouts = state.payout_records(number)?.unwrap_or_default();
    let transaction_count = block.transaction_results.len() as u64;
    let payout_count = payouts.len() as u64;
    let leaf_index = match position {
        ResultPosition::PcashTransactionIndex(index) if index < transaction_count => index,
        ResultPosition::PayoutIndex(index) if index < payout_count => transaction_count + index,
        _ => return Ok(None),
    };
    let (root, siblings) =
        pcash_state::result_tree_path(&block.transaction_results, &payouts, leaf_index)
            .expect("position is in range");
    let leaf = match position {
        ResultPosition::PcashTransactionIndex(index) => {
            let result = &block.transaction_results[index as usize];
            let statement = if result.outcome.is_succeeded() {
                let source = state.derivation_source()?;
                let bytes = state
                    .canonical_transaction_body(number, index)?
                    .expect("canonical transaction has bytes");
                let transaction = pcash_derive::admission::AdmittedTransaction::decode(
                    &bytes,
                    source.pcash_chain_id,
                )
                .expect("canonical transaction was admitted");
                let l1_sender = if matches!(
                    &transaction,
                    pcash_derive::admission::AdmittedTransaction::UserAccountCreation(creation)
                        if matches!(creation.authorization, pcash_derive::transaction::AccountCreationAuthorization::DirectL1)
                ) {
                    let batches = state.l1_delivery_batches(number)?;
                    pcash_state::admitted_delivery(&batches, result)
                        .expect("canonical transaction has delivery")
                        .0
                        .l1_sender
                } else {
                    Address::ZERO
                };
                let words = pcash_derive::engine::successful_statement_words(
                    rules,
                    &source,
                    &transaction,
                    l1_sender,
                )
                .into_iter()
                .map(fr_hash)
                .collect();
                let account_update_opening =
                    if result.tx_type == pcash_derive::KIND_USER_ACCOUNT_UPDATE {
                        let effects = state
                            .canonical_transaction_effects(number)?
                            .expect("canonical block has transaction effects");
                        let effect = effects
                            .get(index as usize)
                            .expect("canonical transaction has aligned effects");
                        let accepted = effect
                            .accepted()
                            .expect("successful transaction has accepted effects");
                        let current = accepted
                            .account
                            .as_ref()
                            .and_then(|account| match account {
                                pcash_state::AccountResult::User {
                                    prior_state: Some(current),
                                    ..
                                } => Some(current),
                                _ => None,
                            })
                            .expect("successful account update has its prior account state");
                        Some(AccountUpdateOpeningDto {
                            current_account_state: AccountUpdateCurrentAccountStateDto {
                                nullifier_key_commitment: fr_hash(current.nullifier_key_commitment),
                                rule_set_commitment: fr_hash(current.account_rule_set_commitment),
                                revision: current.revision,
                                receive_key_hash: current.receive_key_hash,
                            },
                        })
                    } else {
                        None
                    };
                Some(Box::new(ResultStatementDto {
                    words,
                    account_update_opening,
                }))
            } else {
                None
            };
            ResultLeafDto::Transaction {
                tx_type: result.tx_type,
                funding_mode: result.funding_mode,
                l1_transaction_index: result.l1_transaction_index,
                batch_item_index: result.batch_item_index,
                outcome: result.outcome.as_u16(),
                poster_owner_commitment: result.poster_owner_commitment,
                output_start_index: result.output_start_index,
                statement_hash: result.statement_hash,
                statement,
            }
        }
        ResultPosition::PayoutIndex(index) => {
            let payout = &payouts[index as usize];
            let (open_fee_amount, issuance_amount) = payout.result_components();
            ResultLeafDto::Payout(Box::new(PayoutResultLeafDto {
                output_index: payout.output_index,
                owner_commitment: payout.owner_commitment,
                open_fee_amount,
                issuance_amount,
                output_siblings: state
                    .output_path_at(recent.header.number, payout.output_index)?
                    .expect("canonical payout output exists")
                    .map(fr_hash),
            }))
        }
    };
    Ok(Some(ResultProofDto {
        recent_pcash_block_hash: recent_hash,
        block: get_block_header(state, number)?.expect("canonical block exists"),
        history: if number == recent.header.number {
            None
        } else {
            get_history_proof(state, recent_hash, number)?
        },
        results_root_siblings: block
            .header
            .path(pcash_state::BLOCK_HEADER_KEY_TRANSACTION_RESULTS_ROOT)
            .expect("header key exists")
            .1
            .map(fr_hash),
        transaction_count,
        payout_count,
        results_tree_root: fr_hash(root),
        leaf_index,
        siblings: siblings.map(fr_hash),
        leaf,
        recent_boundary: boundary_envelope(&recent),
    }))
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "fixture assertions"
)]
mod result_proof_tests {
    use super::*;
    use crate::dto::{ResultLeafDto, ResultPosition};
    use pcash_state::{
        AcceptedEffects, AccountOp, AccountResult, AccountState, BlockInput, BlockUpdate, Fr,
        MemState, ReceiveKeyOperation, RejectedEffects, StateDb, TransactionEffects,
    };

    fn field_word(value: u64) -> B256 {
        pcash_state::fr_to_bytes(Fr::from(value))
    }

    fn account_update_bytes(
        chain_id: u32,
        address: Address,
        rule_set: B256,
        account_update_commitment: B256,
    ) -> Vec<u8> {
        let mut bytes = vec![pcash_derive::KIND_USER_ACCOUNT_UPDATE];
        bytes.extend_from_slice(&chain_id.to_be_bytes());
        bytes.extend_from_slice(address.as_slice());
        bytes.extend_from_slice(rule_set.as_slice());
        bytes.push(pcash_derive::RECEIVE_KEY_UPDATE_KEEP);
        bytes.extend_from_slice(account_update_commitment.as_slice());
        bytes.extend(std::iter::repeat_n(
            0,
            pcash_derive::SectionLayout::UserAccountUpdate.section_bytes(),
        ));
        bytes
    }

    fn private_value_bytes(chain_id: u32) -> Vec<u8> {
        let shape = pcash_derive::private_value_profiles::PrivateValueShape::S;
        let layout = pcash_derive::SectionLayout::PrivateValue(shape);
        let mut bytes = vec![pcash_derive::KIND_PRIVATE_VALUE];
        bytes.extend_from_slice(&chain_id.to_be_bytes());
        bytes.push(shape as u8);
        bytes.extend(std::iter::repeat_n(0, layout.section_bytes()));
        bytes
    }

    fn successful_result(
        rules: &pcash_derive::ProtocolRules,
        source: &pcash_state::DerivationSource,
        bytes: &[u8],
        l1_transaction_index: u64,
    ) -> pcash_state::TransactionResult {
        let transaction = pcash_derive::AdmittedTransaction::decode(bytes, source.pcash_chain_id)
            .expect("fixture transaction decodes");
        let words = pcash_derive::engine::successful_statement_words(
            rules,
            source,
            &transaction,
            Address::ZERO,
        );
        pcash_state::TransactionResult {
            tx_type: transaction.kind(),
            funding_mode: 0,
            l1_transaction_index,
            batch_item_index: 0,
            outcome: pcash_state::TransactionOutcome::Succeeded,
            poster_owner_commitment: field_word(9),
            output_start_index: 0,
            statement_hash: pcash_state::fr_to_bytes(pcash_state::transaction_statement_hash(
                &words,
            )),
        }
    }

    fn accepted_effects(kind: u8, account: Option<AccountResult>) -> TransactionEffects {
        TransactionEffects::Accepted(AcceptedEffects {
            kind,
            output_leaf_start: None,
            output_commitments: Vec::new(),
            nullifiers: Vec::new(),
            account,
            payout: None,
        })
    }

    #[test]
    fn results_open_under_current_and_historical_headers_with_payout_outputs() {
        let source = pcash_state::DerivationSource {
            pcash_chain_id: 7,
            l1_chain_id: 1,
            inbox_address: Address::ZERO,
            genesis_l1_block: 100,
            genesis_l1_block_hash: B256::repeat_byte(1),
        };
        let mut state = MemState::new(source);
        let rules = pcash_derive::ProtocolRules::new([vec![1], vec![2]], vec![3], vec![4]);
        let poster_source = pcash_state::PayoutSource::PosterPayout {
            l1_transaction_indices: vec![0],
        };
        let payouts = vec![
            pcash_state::PayoutRecord {
                source: pcash_state::PayoutSource::DesignatedIssuance {
                    l1_transaction_index: 0,
                    batch_item_index: 0,
                },
                component: pcash_state::PayoutComponent::Issuance,
                amount: U256::from(5),
                owner_commitment: fr_hash(Fr::from(9u64)),
                output_index: 0,
                contexts: vec![fr_hash(Fr::from(11u64))],
            },
            pcash_state::PayoutRecord {
                source: poster_source.clone(),
                component: pcash_state::PayoutComponent::OpenFee,
                amount: U256::from(3),
                owner_commitment: fr_hash(Fr::from(10u64)),
                output_index: 1,
                contexts: vec![fr_hash(Fr::from(12u64))],
            },
            pcash_state::PayoutRecord {
                source: poster_source,
                component: pcash_state::PayoutComponent::Issuance,
                amount: U256::from(7),
                owner_commitment: fr_hash(Fr::from(10u64)),
                output_index: 2,
                contexts: vec![fr_hash(Fr::from(12u64))],
            },
        ];
        let result = pcash_state::TransactionResult {
            tx_type: 0,
            funding_mode: 0,
            l1_transaction_index: 0,
            batch_item_index: 0,
            outcome: pcash_state::TransactionOutcome::ProofRejected,
            poster_owner_commitment: payouts[1].owner_commitment,
            output_start_index: 0,
            statement_hash: B256::ZERO,
        };
        let mut first_hash = B256::ZERO;
        for number in 0..2 {
            let mut update = BlockUpdate::empty(state.issuance_state());
            update.output_commitments = if number == 0 {
                payouts
                    .iter()
                    .map(pcash_state::PayoutRecord::output_commitment)
                    .collect()
            } else {
                vec![Fr::from(44u64)]
            };
            let (boundary, _) = state
                .commit(
                    BlockInput {
                        number,
                        timestamp: number + 1,
                        transaction_results: if number == 0 {
                            vec![result.clone()]
                        } else {
                            vec![]
                        },
                        transaction_bytes: if number == 0 { vec![vec![0]] } else { vec![] },
                        transaction_effects: vec![],
                        l1_logs: vec![],
                        l1_origin: pcash_state::L1Origin {
                            block_number: 100 + number,
                            block_hash: source.genesis_l1_block_hash,
                            block_timestamp: number + 1,
                            l1_logs_root: B256::ZERO,
                            l1_log_count: 0,
                        },
                        history: pcash_state::CanonicalBlockHistory {
                            payouts: if number == 0 { payouts.clone() } else { vec![] },
                            ..Default::default()
                        },
                    },
                    update,
                )
                .unwrap();
            if number == 0 {
                first_hash = boundary.block.hash;
            }
            let proof = get_result_proof(
                &state,
                &rules,
                boundary.block.hash,
                0,
                ResultPosition::PcashTransactionIndex(0),
            )
            .unwrap()
            .unwrap();
            assert_eq!(proof.history.is_some(), number != 0);
            assert_eq!(proof.block.recent_pcash_block_hash, first_hash);
            let wire = serde_json::to_value(&proof.leaf).unwrap();
            assert!(wire.get("statementWords").is_none());
            assert!(wire["statement"].is_null());
            assert!(matches!(
                proof.leaf,
                ResultLeafDto::Transaction {
                    statement: None,
                    ..
                }
            ));
            for (payout_index, payout) in payouts.iter().enumerate() {
                let proof = get_result_proof(
                    &state,
                    &rules,
                    boundary.block.hash,
                    0,
                    ResultPosition::PayoutIndex(payout_index as u64),
                )
                .unwrap()
                .unwrap();
                let wire = serde_json::to_value(&proof.leaf).unwrap();
                assert_eq!(wire["kind"], "payout");
                assert_eq!(wire["outputIndex"], format!("0x{payout_index:x}"));
                let ResultLeafDto::Payout(payout_leaf) = proof.leaf else {
                    panic!("payout expected");
                };
                assert_eq!(
                    (payout_leaf.open_fee_amount, payout_leaf.issuance_amount),
                    payout.result_components()
                );
                let siblings = payout_leaf
                    .output_siblings
                    .map(|word| fr_from_canonical_bytes(word).unwrap());
                assert_eq!(
                    fr_hash(pcash_crypto::merkle::root_from_index(
                        payout.output_commitment(),
                        payout_index as u64,
                        &siblings
                    )),
                    boundary.state.state_components().output_root
                );
            }
        }
        assert!(get_result_proof(
            &state,
            &rules,
            first_hash,
            0,
            ResultPosition::PayoutIndex(3)
        )
        .unwrap()
        .is_none());
        assert!(get_result_proof(
            &state,
            &rules,
            first_hash,
            1,
            ResultPosition::PayoutIndex(0)
        )
        .unwrap()
        .is_none());
        assert!(get_result_proof(
            &state,
            &rules,
            B256::ZERO,
            0,
            ResultPosition::PayoutIndex(0)
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn successful_account_update_results_open_the_exact_in_block_predecessor_rows() {
        let source = pcash_state::DerivationSource {
            pcash_chain_id: 7,
            l1_chain_id: 1,
            inbox_address: Address::ZERO,
            genesis_l1_block: 100,
            genesis_l1_block_hash: field_word(1),
        };
        let rules = pcash_derive::ProtocolRules::new([vec![1], vec![2]], vec![3], vec![4]);
        let address = Address::repeat_byte(0x44);
        let receive_key_hash = field_word(13);
        let mut state = MemState::new(source);
        state
            .commit(
                BlockInput {
                    number: 0,
                    timestamp: 1,
                    transaction_results: Vec::new(),
                    transaction_bytes: Vec::new(),
                    transaction_effects: Vec::new(),
                    l1_logs: Vec::new(),
                    l1_origin: source.anchor_origin(),
                    history: pcash_state::CanonicalBlockHistory::default(),
                },
                BlockUpdate {
                    account_ops: vec![AccountOp {
                        address,
                        nullifier_key_commitment: Fr::from(11u64),
                        account_rule_set_commitment: Fr::from(12u64),
                        kind: 0,
                        receive_key_hash,
                        published_receive_key: None,
                    }],
                    ..BlockUpdate::empty(state.issuance_state())
                },
            )
            .unwrap();
        let first_prior = state.account_of(address).unwrap().unwrap();
        let after_first = AccountState {
            revision: 2,
            account_rule_set_commitment: Fr::from(20u64),
            ..first_prior
        };
        let after_second = AccountState {
            revision: 3,
            account_rule_set_commitment: Fr::from(21u64),
            ..after_first
        };
        let first_bytes = account_update_bytes(7, address, field_word(20), field_word(30));
        let second_bytes = account_update_bytes(7, address, field_word(21), field_word(31));
        let ordinary_bytes = private_value_bytes(7);
        let failed_bytes = account_update_bytes(7, address, field_word(22), field_word(32));
        let mut results = vec![
            successful_result(&rules, &source, &first_bytes, 0),
            successful_result(&rules, &source, &second_bytes, 1),
            successful_result(&rules, &source, &ordinary_bytes, 2),
        ];
        results.push(pcash_state::TransactionResult {
            tx_type: pcash_derive::KIND_USER_ACCOUNT_UPDATE,
            funding_mode: 0,
            l1_transaction_index: 3,
            batch_item_index: 0,
            outcome: pcash_state::TransactionOutcome::ProofRejected,
            poster_owner_commitment: field_word(9),
            output_start_index: 0,
            statement_hash: B256::ZERO,
        });
        let effects = vec![
            accepted_effects(
                pcash_derive::KIND_USER_ACCOUNT_UPDATE,
                Some(AccountResult::User {
                    address,
                    revision: 2,
                    receive_key: ReceiveKeyOperation::Keep,
                    prior_state: Some(Box::new(first_prior)),
                }),
            ),
            accepted_effects(
                pcash_derive::KIND_USER_ACCOUNT_UPDATE,
                Some(AccountResult::User {
                    address,
                    revision: 3,
                    receive_key: ReceiveKeyOperation::Keep,
                    prior_state: Some(Box::new(after_first)),
                }),
            ),
            accepted_effects(pcash_derive::KIND_PRIVATE_VALUE, None),
            TransactionEffects::Rejected(RejectedEffects {
                account: Some(address),
                detail: None,
            }),
        ];
        let (boundary, _) = state
            .commit(
                BlockInput {
                    number: 1,
                    timestamp: 2,
                    transaction_results: results,
                    transaction_bytes: vec![
                        first_bytes,
                        second_bytes,
                        ordinary_bytes,
                        failed_bytes,
                    ],
                    transaction_effects: effects,
                    l1_logs: Vec::new(),
                    l1_origin: pcash_state::L1Origin {
                        block_number: 101,
                        block_hash: field_word(2),
                        block_timestamp: 2,
                        l1_logs_root: B256::ZERO,
                        l1_log_count: 0,
                    },
                    history: pcash_state::CanonicalBlockHistory::default(),
                },
                BlockUpdate {
                    account_ops: vec![
                        AccountOp {
                            address,
                            nullifier_key_commitment: after_first.nullifier_key_commitment,
                            account_rule_set_commitment: after_first.account_rule_set_commitment,
                            kind: after_first.kind,
                            receive_key_hash: after_first.receive_key_hash,
                            published_receive_key: None,
                        },
                        AccountOp {
                            address,
                            nullifier_key_commitment: after_second.nullifier_key_commitment,
                            account_rule_set_commitment: after_second.account_rule_set_commitment,
                            kind: after_second.kind,
                            receive_key_hash: after_second.receive_key_hash,
                            published_receive_key: None,
                        },
                    ],
                    ..BlockUpdate::empty(state.issuance_state())
                },
            )
            .unwrap();

        let opening = |index| {
            let proof = get_result_proof(
                &state,
                &rules,
                boundary.block.hash,
                1,
                ResultPosition::PcashTransactionIndex(index),
            )
            .unwrap()
            .unwrap();
            let ResultLeafDto::Transaction { statement, .. } = proof.leaf else {
                panic!("transaction result expected")
            };
            statement
        };
        let first_statement = opening(0).unwrap();
        let wire = serde_json::to_value(&first_statement).unwrap();
        assert_eq!(
            wire["accountUpdateOpening"]["currentAccountState"]["revision"],
            "0x1"
        );
        assert!(wire.get("statementWords").is_none());
        let first = first_statement.account_update_opening.unwrap();
        assert_eq!(first.current_account_state.revision, 1);
        assert_eq!(
            first.current_account_state.rule_set_commitment,
            field_word(12)
        );
        let second = opening(1).unwrap().account_update_opening.unwrap();
        assert_eq!(second.current_account_state.revision, 2);
        assert_eq!(
            second.current_account_state.rule_set_commitment,
            field_word(20)
        );
        assert!(opening(2).unwrap().account_update_opening.is_none());
        assert!(opening(3).is_none());
    }
}
