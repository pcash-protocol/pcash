//! The shared node state and its `NodeApi` implementation.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "node orchestration maintains validated state and task invariants"
)]
//!
//! [`NodeInner`] holds the canonical [`RedbState`] plus the derivation-adjacent
//! metadata the client services need: head/finalized heights, the unfinalized
//! block-hash trail (for reorg walk-back), and the rebuildable derived index.
//! Derivation owns the mutable engine. RPC handlers use committed Redb read
//! transactions and do not acquire the derivation mutex.

use std::collections::{BTreeMap, BTreeSet, HashMap};
#[cfg(any(test, feature = "test-support"))]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use crate::fee_estimate::{self, FeeEstimateInputs, FeeSample};
use alloy_primitives::{Address, B256, I256, U256};
use pcash_derive::{
    BlockOutcome, ProtocolRules, Transaction, KIND_CONTRACT_ACCOUNT_CREATION, KIND_PRIVATE_VALUE,
    KIND_USER_ACCOUNT_CREATION, KIND_USER_ACCOUNT_UPDATE,
};
use pcash_l1::{L1BlockData, NormalizedLogBlock};
use pcash_p2p::{ForkCapability, Multiaddr, P2pHandle};
use pcash_pscan::dto::{
    ContractSourceStatus, SourceVerificationApiError, SourceVerificationPublication,
};
use pcash_pscan::registry::SourceVerificationService;
use pcash_rpc::catalog::{
    CatalogApiError, CatalogArtifact, CatalogGetRequest, CatalogInfo, CatalogListRequest,
    CatalogPage, CatalogRecord,
};
use pcash_rpc::dto::{
    AccountDto, AccountProofDto, AccountProofResultDto, BlockDto, BlockHashDivergenceDto,
    BlockHeaderDto, BlockId, BlockPayoutsDto, ContractDto, ContractFunctionDto, ContractPageDto,
    ContractPresent, ContractResultDto, ContractSummaryDto, ContractVerificationStatusDto,
    DerivationDto, ExplorerCursorDto, FeeEstimateDto, ForkCapabilityDto, HistoryProofDto,
    InclusionId, L1LogProofDto, L1OriginProofDto, MempoolPageDto, MempoolTransactionDto,
    NodeInfoDto, NullifierProofsDto, OutputPageDto, OutputPathDto, PeerDirectionDto, PeerInfoDto,
    PreparedRelayDto, ReceiptDto, ReceiveMaterialDto, StatusDto, TransactionDto, TransactionKind,
    TransactionPageDto, TransactionSummaryDto,
};
use pcash_rpc::handlers;
use pcash_rpc::IssuanceRoute;
use pcash_rpc::{
    AccountHistoryQuery, AddPeerResultDto, AdminApi, AdminApiError, BlockTag,
    CheckRawTransactionRequest, ContractsQuery, IndexReadError, MempoolApiError, MempoolFilter,
    NodeApi, OutputRequest, PrepareRelayRequest, ProverAssetsDto, ReceiptAccountQuery,
    ReceiptInclusionQuery, ReceiptNullifierQuery, ReceiptQuery, RemovePeerResultDto, StatusMeta,
    SubmissionQuery, TransactionCheckDto, TransactionsQuery,
};
use pcash_state::{
    AccountResult, CommittedBoundary, DerivationSource, FailureDetail, FailureDetailSeed,
    RedbState, StateDb, StateError, TransactionEffects, TransactionOutcome,
};
use tokio::sync::watch;

use crate::catalog::CatalogService;
use crate::index::{
    ContractFunctionMaterial, ContractMaterialUpdate, ContractSourceInfo,
    ContractVerificationLookup, DerivedIndexCursor, DerivedIndexLifecycle, DerivedIndexStore,
    IndexBlockId,
};
use crate::mempool::{now_unix_ms, MempoolService};

/// Cap on block summaries returned by one `pcash_getBlocks` range query.
pub(crate) const MAX_BLOCKS_PER_QUERY: usize = 1_000;

fn transaction_kind(kind: u8) -> TransactionKind {
    match kind {
        KIND_PRIVATE_VALUE => TransactionKind::PrivateValue,
        KIND_USER_ACCOUNT_CREATION => TransactionKind::UserAccountCreation,
        KIND_CONTRACT_ACCOUNT_CREATION => TransactionKind::ContractAccount,
        KIND_USER_ACCOUNT_UPDATE => TransactionKind::UserAccountUpdate,
        _ => TransactionKind::Unknown,
    }
}

fn transaction_kind_index(kind: TransactionKind) -> Option<u8> {
    match kind {
        TransactionKind::PrivateValue => Some(KIND_PRIVATE_VALUE),
        TransactionKind::UserAccountCreation => Some(KIND_USER_ACCOUNT_CREATION),
        TransactionKind::ContractAccount => Some(KIND_CONTRACT_ACCOUNT_CREATION),
        TransactionKind::UserAccountUpdate => Some(KIND_USER_ACCOUNT_UPDATE),
        TransactionKind::Unknown => None,
    }
}

/// The public open fee and `issuanceOwnerCommitment` a transaction admitted
/// on the network `pcash_chain_id` declares, or `None` for a kind with no
/// private-value section.
fn declared_publication(
    transaction: &[u8],
    pcash_chain_id: u32,
) -> Result<Option<(U256, B256)>, StateError> {
    let transaction = Transaction::decode(transaction, pcash_chain_id).map_err(|error| {
        StateError::Backend(format!("admitted transaction is malformed: {error}"))
    })?;
    Ok(declared_publication_for(&transaction))
}

fn declared_publication_for(transaction: &Transaction) -> Option<(U256, B256)> {
    let section = match transaction {
        Transaction::PrivateValue(section) => section,
        Transaction::UserAccountUpdate(update) => &update.section,
        Transaction::ContractAccountCreation(_) => return None,
        Transaction::UserAccountCreation(_) => return None,
    };
    let profile = section.shape().profile();
    Some((
        pcash_state::word_to_u256(section.public_input(profile.open_fee_amount_offset)),
        section.public_input(profile.issuance_owner_offset),
    ))
}

pub(crate) fn issuance_route(kind: u8, declared_owner: Option<B256>) -> IssuanceRoute {
    if !pcash_derive::earns_issuance(kind) {
        return IssuanceRoute::None;
    }
    match declared_owner {
        None => IssuanceRoute::None,
        Some(owner) if owner.is_zero() => IssuanceRoute::Open,
        Some(_) => IssuanceRoute::Designated,
    }
}

/// Account identity and resulting revision from a successful creation or update.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountReceiptData {
    pub address: Address,
    pub account_revision: u32,
}

pcash_state::codec::codec_struct!(AccountReceiptData {
    address,
    account_revision
});

/// One stored inclusion receipt mirroring a canonical recognized-entry result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReceiptRecord {
    pub pcash_transaction_index: u64,
    pub l1_block_number: u64,
    pub l1_block_hash: B256,
    pub l1_transaction_index: u64,
    pub l1_transaction_hash: B256,
    pub batch_item_index: u64,
    pub content_hash: B256,
    pub tx_id: B256,
    pub outcome: TransactionOutcome,
    pub failure_detail: Option<FailureDetail>,
    pub l1_sender: Address,
    /// The resolved issuance destination for an eligible action. Paid only
    /// when the outcome succeeded.
    pub issuance_owner_commitment: Option<B256>,
    pub settled_open_fee_amount: U256,
    pub settled_issuance_amount: U256,
    /// A positive explicit fee on the open route: a fee-estimation sample.
    /// Zero-fee open actions reward their poster through issuance and
    /// carry no fee signal.
    pub has_open_fee: bool,
    pub byte_size: u64,
    pub kind: u8,
    pub account_creation: u8,
    pub lifecycle_address: Option<Address>,
    pub output_leaf_start: Option<u64>,
    pub outputs_added: u64,
    /// Populated by successful private-value sections, including those in
    /// account updates; absent when none were consumed.
    pub nullifiers: Option<Vec<B256>>,
    /// Present for successful account creation or update.
    pub account: Option<AccountReceiptData>,
}

impl ReceiptRecord {
    pub const fn accepted(&self) -> bool {
        self.outcome.is_succeeded()
    }

    pub const fn inclusion(&self) -> InclusionId {
        InclusionId {
            l1_block_number: self.l1_block_number,
            l1_block_hash: self.l1_block_hash,
            l1_transaction_index: self.l1_transaction_index,
            l1_transaction_hash: self.l1_transaction_hash,
            batch_item_index: self.batch_item_index,
        }
    }

    fn to_dto(&self) -> ReceiptDto {
        ReceiptDto {
            inclusion: self.inclusion(),
            content_hash: self.content_hash,
            tx_id: self.tx_id,
            outcome: self.outcome,
            failure_detail: self.failure_detail.clone(),
            l1_sender: self.l1_sender,
            issuance_owner_commitment: self.issuance_owner_commitment,
            settled_open_fee_amount: self.settled_open_fee_amount,
            settled_issuance_amount: self.settled_issuance_amount,
            kind: transaction_kind(self.kind),
            account_creation: self.account_creation,
            output_leaf_start: self.output_leaf_start,
            outputs_added: self.outputs_added,
            nullifiers: self.nullifiers.clone(),
            account: self
                .account
                .as_ref()
                .map(|account| pcash_rpc::dto::AccountReceiptDto {
                    address: account.address,
                    account_revision: account.account_revision,
                }),
        }
    }
}

fn receipt_transaction_summary(
    state: &dyn pcash_state::StateRead,
    block_number: u64,
    pcash_transaction_index: u64,
    receipt: &ReceiptRecord,
) -> Result<TransactionSummaryDto, IndexReadError> {
    let block = state
        .canonical_stored_block(block_number)
        .map_err(|error| IndexReadError::Unavailable(error.to_string()))?
        .ok_or_else(|| IndexReadError::Unavailable("canonical block is missing".into()))?;
    let transaction = state
        .canonical_transaction_body(block_number, pcash_transaction_index)
        .map_err(|error| IndexReadError::Unavailable(error.to_string()))?
        .ok_or_else(|| {
            IndexReadError::Unavailable("canonical transaction body is missing".into())
        })?;
    let pcash_chain_id = state
        .derivation_source()
        .map_err(|error| IndexReadError::Unavailable(error.to_string()))?
        .pcash_chain_id;
    let declared = declared_publication(&transaction, pcash_chain_id)
        .map_err(|error| IndexReadError::Unavailable(error.to_string()))?;
    Ok(TransactionSummaryDto {
        l1_sender: receipt.l1_sender,
        issuance_owner_commitment: receipt.issuance_owner_commitment,
        settled_open_fee_amount: receipt.settled_open_fee_amount,
        settled_issuance_amount: receipt.settled_issuance_amount,
        tx_id: receipt.tx_id,
        content_hash: receipt.content_hash,
        outcome: receipt.outcome,
        failure_detail: receipt.failure_detail.clone(),
        declared_open_fee_amount: declared.map(|(fee, _)| fee),
        declared_issuance_owner_commitment: declared.map(|(_, owner)| owner),
        issuance_route: issuance_route(transaction[0], declared.map(|(_, owner)| owner)),
        kind: transaction_kind(transaction[0]),
        account_creation: receipt.account_creation,
        block: BlockId {
            block_number,
            block_hash: block.hash,
        },
        pcash_transaction_index,
        timestamp: block.header.timestamp,
        inclusion: receipt.inclusion(),
        byte_size: transaction.len() as u64,
        output_leaf_start: receipt.output_leaf_start,
        outputs_added: receipt.outputs_added,
        nullifiers: receipt.nullifiers.clone(),
        account: receipt
            .account
            .as_ref()
            .map(|account| pcash_rpc::AccountReceiptDto {
                address: account.address,
                account_revision: account.account_revision,
            }),
    })
}

fn contract_origin(material: &ContractMaterialUpdate) -> InclusionId {
    InclusionId {
        l1_block_number: material.l1_block_number,
        l1_block_hash: material.l1_block_hash,
        l1_transaction_index: material.l1_transaction_index,
        l1_transaction_hash: material.l1_transaction_hash,
        batch_item_index: material.batch_item_index,
    }
}

fn receipt_primary(receipt: &ReceiptRecord) -> [u8; 24] {
    let mut key = [0u8; 24];
    key[..8].copy_from_slice(&receipt.l1_block_number.to_be_bytes());
    key[8..16].copy_from_slice(&receipt.l1_transaction_index.to_be_bytes());
    key[16..].copy_from_slice(&receipt.batch_item_index.to_be_bytes());
    key
}

fn indexed_receipt_page(
    node: &NodeRead,
    cursor: Option<ExplorerCursorDto>,
    limit: usize,
    cursor_matches: impl Fn(&ReceiptRecord) -> bool,
    load: impl FnOnce(Option<[u8; 24]>, usize) -> Result<Vec<ReceiptRecord>, StateError>,
) -> Result<TransactionPageDto, IndexReadError> {
    let head = explorer_head(node, cursor)?;
    let before = if let Some(cursor) = cursor {
        let receipt = node
            .index
            .receipt_by_block_ordinal(cursor.block_number, cursor.pcash_transaction_index)
            .map_err(|error| IndexReadError::Unavailable(error.to_string()))?
            .ok_or(IndexReadError::CursorMismatch)?;
        if !cursor_matches(&receipt) {
            return Err(IndexReadError::CursorMismatch);
        }
        Some(receipt_primary(&receipt))
    } else {
        None
    };
    let mut receipts =
        load(before, limit + 1).map_err(|error| IndexReadError::Unavailable(error.to_string()))?;
    let has_more = receipts.len() > limit;
    if has_more {
        receipts.pop();
    }
    let source = node.state.derivation_source()?;
    let mut items = Vec::with_capacity(receipts.len());
    for receipt in &receipts {
        let number = receipt
            .l1_block_number
            .checked_sub(source.genesis_l1_block)
            .ok_or_else(|| IndexReadError::Unavailable("receipt predates genesis".into()))?;
        items.push(receipt_transaction_summary(
            &node.state,
            number,
            receipt.pcash_transaction_index,
            receipt,
        )?);
    }
    let next_cursor = has_more.then(|| {
        let last = items.last().expect("continued page has a final item");
        ExplorerCursorDto {
            head,
            block_number: last.block.block_number,
            pcash_transaction_index: last.pcash_transaction_index,
        }
    });
    Ok(TransactionPageDto {
        items,
        next_cursor,
        head,
    })
}

fn explorer_head(
    node: &NodeRead,
    cursor: Option<ExplorerCursorDto>,
) -> Result<BlockId, IndexReadError> {
    let indexed = node.ready_index_cursor()?;
    let current = BlockId {
        block_number: indexed.pcash_number,
        block_hash: indexed.pcash_hash,
    };
    let Some(cursor) = cursor else {
        return Ok(current);
    };
    if cursor.head.block_number > current.block_number
        || cursor.block_number > cursor.head.block_number
    {
        return Err(IndexReadError::CursorMismatch);
    }
    let canonical = node
        .state
        .canonical_stored_block(cursor.head.block_number)
        .map_err(|error| IndexReadError::Unavailable(error.to_string()))?;
    if canonical.as_ref().map(|block| block.hash) != Some(cursor.head.block_hash) {
        return Err(IndexReadError::CursorMismatch);
    }
    Ok(cursor.head)
}

/// Rebuildable execution diagnostics retained with receipts in the derived index.
/// Canonical block headers, hashes, transactions, and L1 origins live in state;
/// the corresponding fields here only mirror that canonical row for indexing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DerivationSummary {
    pub pcash_number: u64,
    pub l1_number: u64,
    pub l1_hash: B256,
    pub timestamp: u64,
    pub state_root: B256,
    pub block_hash: B256,
    pub accepted_count: u64,
    pub skipped_count: u64,
    pub payout_notes: u64,
}

fn block_to_dto(
    state: &dyn pcash_state::StateRead,
    block: pcash_state::PcashBlock,
    full_transactions: bool,
) -> Result<BlockDto, StateError> {
    handlers::block_dto(state, block, full_transactions)
}

fn block_metadata_to_dto(
    state: &dyn pcash_state::StateRead,
    block: pcash_state::PcashBlockMetadata,
) -> Result<BlockDto, StateError> {
    handlers::block_metadata_dto(state, block, None)
}

fn receive_material(node: &NodeRead, address: Address) -> Result<ReceiveMaterialDto, StateError> {
    let Some(account) = node.state.account_of(address)? else {
        return Ok(ReceiveMaterialDto::Unavailable {
            lifecycle: "accountMissing".into(),
        });
    };
    if account.receive_key_hash == B256::ZERO {
        return Ok(ReceiveMaterialDto::NotPresent);
    }
    if let Err(error) = node.ready_index_cursor() {
        return Ok(ReceiveMaterialDto::Unavailable {
            lifecycle: error.to_string(),
        });
    }
    let Some(update) = node.index.receive_material(address, account.revision)? else {
        return Ok(ReceiveMaterialDto::Unavailable {
            lifecycle: "catchingUp".into(),
        });
    };
    let Some(key) = update.key else {
        return Ok(ReceiveMaterialDto::Unavailable {
            lifecycle: "materialMissing".into(),
        });
    };
    Ok(ReceiveMaterialDto::Available {
        ml_kem768_public_key: key.into(),
    })
}

fn present_account_proof(result: AccountProofResultDto) -> Option<AccountProofDto> {
    match result {
        AccountProofResultDto::Present(proof) => Some(*proof),
        AccountProofResultDto::NotFound { .. } => None,
    }
}

fn fork_capability_dto(capability: ForkCapability) -> ForkCapabilityDto {
    ForkCapabilityDto {
        chain_id: capability.chain_id,
        genesis_hash: capability.genesis_hash,
        head_timestamp: capability.head_timestamp,
        current_fork_count: capability.current_fork_count,
        current_prefix_hash: capability.current_prefix_hash,
        next_activation_timestamp: capability.next_activation_timestamp,
        next_prefix_hash: capability.next_prefix_hash,
    }
}

fn fork_capability(
    rules: &ProtocolRules,
    chain_id: u32,
    head_timestamp: u64,
    genesis_hash: B256,
) -> ForkCapability {
    let current_fork_count = rules
        .fork_schedule
        .iter()
        .take_while(|fork| head_timestamp >= fork.activation_timestamp)
        .count();
    let (next_activation_timestamp, next_prefix_hash) = rules
        .fork_schedule
        .get(current_fork_count)
        .map_or((0, B256::ZERO), |fork| {
            (
                fork.activation_timestamp,
                rules.activated_fork_schedule_prefix_hash_at(fork.activation_timestamp),
            )
        });
    ForkCapability {
        chain_id,
        genesis_hash,
        head_timestamp,
        current_fork_count: u16::try_from(current_fork_count)
            .expect("fork schedule length exceeds u16"),
        current_prefix_hash: rules.activated_fork_schedule_prefix_hash_at(head_timestamp),
        next_activation_timestamp,
        next_prefix_hash,
    }
}

/// The full shared node state.
pub struct NodeInner {
    pub state: RedbState,
    /// Rebuildable query index for receipts, wallet events, material, diagnostics,
    /// fees, and their one canonical PCASH cursor.
    pub index: DerivedIndexStore,
    pub(crate) index_reader: Arc<RwLock<DerivedIndexStore>>,
    /// Whether the index follows the canonical tip. It changes only under the
    /// node lock; RPC reads and the catch-up retry observe it without the lock.
    index_lifecycle: watch::Sender<DerivedIndexLifecycle>,
    /// The compiled rules, shared with off-lock prewarming, the mempool, and
    /// RPC reads.
    pub rules: Arc<ProtocolRules>,
    /// The derivation source of `state`, captured when it was opened. It is
    /// fixed for the life of the database, so off-lock prewarming and the
    /// mempool read it here instead of from the state.
    pub source: DerivationSource,
    /// Highest derived L1 block number (`None` before the first block).
    pub head: Option<u64>,
    /// Latest upstream L1 head observed by the follower. `None` before its first refresh.
    pub observed_l1_block_number: Arc<RwLock<Option<u64>>>,
    /// Whether the follower is deriving, retrying an input, or halted.
    pub derivation: Arc<RwLock<DerivationDto>>,
    /// The status at the last commit the follower published. A halted node
    /// serves it if its canonical store can no longer be read.
    pub(crate) published_status: Arc<RwLock<Option<StatusDto>>>,
    /// Fails every handle's canonical reads, as the store does once its backend
    /// has latched an I/O error.
    #[cfg(any(test, feature = "test-support"))]
    pub fail_canonical_reads: Arc<AtomicBool>,
    /// Latest observed L1 `finalized` height.
    pub l1_finalized: u64,
    /// Hashes of unfinalized derived blocks, for reorg walk-back.
    pub block_hashes: BTreeMap<u64, B256>,
    /// Source-verification lookup used to index contracts as they are admitted.
    pub contract_verification: Option<Arc<dyn ContractVerificationLookup>>,
}

impl NodeInner {
    pub fn new(state: RedbState, index: DerivedIndexStore, rules: ProtocolRules) -> Self {
        let index_lifecycle = match index.cursor() {
            Ok(cursor) => DerivedIndexLifecycle::CatchingUp { cursor },
            Err(_) => DerivedIndexLifecycle::Unavailable,
        };
        Self {
            source: state.derivation_source(),
            state,
            index_reader: Arc::new(RwLock::new(index.clone())),
            index,
            index_lifecycle: watch::Sender::new(index_lifecycle),
            rules: Arc::new(rules),
            head: None,
            observed_l1_block_number: Arc::new(RwLock::new(None)),
            derivation: Arc::new(RwLock::new(DerivationDto::Following {
                since_unix_ms: now_unix_ms(),
            })),
            published_status: Arc::new(RwLock::new(None)),
            #[cfg(any(test, feature = "test-support"))]
            fail_canonical_reads: Arc::new(AtomicBool::new(false)),
            l1_finalized: 0,
            block_hashes: BTreeMap::new(),
            contract_verification: None,
        }
    }

    pub fn index_lifecycle(&self) -> DerivedIndexLifecycle {
        *self.index_lifecycle.borrow()
    }

    pub fn set_index_lifecycle(&mut self, lifecycle: DerivedIndexLifecycle) {
        self.index_lifecycle.send_replace(lifecycle);
    }

    pub(crate) fn watch_index_lifecycle(&self) -> watch::Receiver<DerivedIndexLifecycle> {
        self.index_lifecycle.subscribe()
    }

    /// Client-facing PCASH height. Identity-dependent services start only after
    /// canonical block zero exists.
    pub fn latest_block(&self) -> u64 {
        self.state
            .canonical_tip_summary()
            .expect("canonical block zero must exist before node services start")
            .number
    }

    /// Answer contract verification lookups from `service`. Install this before
    /// any indexing work so contracts indexed during catch-up and newly
    /// admitted ones alike get their verification rows.
    pub fn set_contract_verification(&mut self, service: Arc<SourceVerificationService>) {
        self.contract_verification = Some(Arc::new(SourceVerificationLookup(service)));
    }

    fn finalized_l1_block(&self) -> u64 {
        self.head.map_or(self.source.genesis_l1_block, |head| {
            head.min(self.l1_finalized)
        })
    }

    /// Client-facing PCASH finalized height, derived from the finalized L1
    /// origin without exposing that coordinate as the block number.
    pub fn finalized_block(&self) -> u64 {
        self.finalized_l1_block()
            .saturating_sub(self.source.genesis_l1_block)
    }

    pub fn head_id(&self) -> BlockId {
        let tip = self
            .state
            .canonical_tip_summary()
            .expect("canonical block zero must exist before snapshot reads are served");
        BlockId {
            block_number: tip.number,
            block_hash: tip.hash,
        }
    }

    pub fn fork_capability(&self) -> ForkCapability {
        fork_capability(
            &self.rules,
            self.source.pcash_chain_id,
            self.state
                .canonical_tip_summary()
                .expect("canonical block zero must exist before P2P starts")
                .timestamp,
            self.state
                .canonical_genesis_hash()
                .expect("canonical block zero must exist before P2P starts"),
        )
    }

    /// Derive one L1 block into canonical state and apply it to the derived
    /// index when the index is ready. Advances `head` and the block-hash trail.
    /// Returns the derivation outcome.
    ///
    /// This path may invoke the verifier backend while preparing proofs. The
    /// follow loop prewarms before taking the node lock and calls
    /// [`Self::apply_prepared_block`] instead.
    pub fn apply_block<V: pcash_verify::Verifier>(
        &mut self,
        data: &L1BlockData,
        verifier: &V,
    ) -> Result<BlockOutcome, pcash_derive::DeriveError> {
        let can_index = matches!(self.index_lifecycle(), DerivedIndexLifecycle::Ready(_))
            || self.state.canonical_tip_summary().is_none();
        let rules = Arc::clone(&self.rules);
        let prepared = pcash_derive::prepare_block(data, &rules, &self.source, verifier);
        let cached = pcash_verify::CachedVerifier::new_complete(prepared.cache(), verifier);
        let outcome = self.apply_prepared_block(&prepared, &cached)?;
        if can_index {
            let result = Self::apply_index_block(
                &self.index,
                &self.source,
                self.contract_verification.as_deref(),
                &outcome.committed_boundary,
                &outcome.transaction_effects.iter().collect::<Vec<_>>(),
                &outcome.l1_logs,
                true,
            );
            self.record_index_result(result);
        }
        Ok(outcome)
    }

    pub(crate) fn apply_prepared_block<V: pcash_verify::Verifier>(
        &mut self,
        prepared: &pcash_derive::PreparedBlock<'_>,
        verifier: &V,
    ) -> Result<BlockOutcome, pcash_derive::DeriveError> {
        let data = prepared.block();
        let adopted_count = self
            .rules
            .fork_schedule
            .iter()
            .take_while(|fork| data.header.timestamp >= fork.activation_timestamp)
            .count();
        let adopted_count = u32::try_from(adopted_count)
            .map_err(|_| StateError::Backend("fork schedule length exceeds u32".into()))?;
        // Fork adoption is an operator-compatibility floor, not rollbackable
        // canonical state. A replacement/replay may derive blocks older than
        // the highest fork this database has ever adopted; preserve that floor
        // until derivation reaches a later activation.
        if adopted_count > self.state.adopted_fork_compatibility().adopted_fork_count {
            self.state.advance_adopted_fork(
                adopted_count,
                self.rules
                    .activated_fork_schedule_prefix_hash_at(data.header.timestamp),
            )?;
        }
        let outcome = pcash_derive::derive_prepared_block(&mut self.state, prepared, verifier)?;
        let l1_number = data.header.number;
        self.head = Some(l1_number);
        self.block_hashes.insert(l1_number, data.header.hash);

        Ok(outcome)
    }

    /// Apply one committed block to the derived index from its canonical
    /// boundary, the stored effects of its admitted transactions, and its L1
    /// origin's logs. Head, catch-up, and rebuild all take this path.
    pub(crate) fn apply_index_block(
        index: &DerivedIndexStore,
        source: &DerivationSource,
        verification: Option<&dyn ContractVerificationLookup>,
        boundary: &CommittedBoundary,
        transactions: &[&TransactionEffects],
        l1_logs: &NormalizedLogBlock,
        durable: bool,
    ) -> Result<DerivedIndexCursor, StateError> {
        if boundary.block.header.number == 0 {
            index.bind_identity(source.pcash_chain_id, boundary.block.hash)?;
        }
        let receipts = Self::receipt_rows(index, source, boundary, transactions)?;
        index.apply_block(
            boundary,
            transactions,
            l1_logs,
            &receipts,
            verification,
            durable,
        )
    }

    pub(crate) fn record_index_result(&mut self, result: Result<DerivedIndexCursor, StateError>) {
        self.set_index_lifecycle(match result {
            Ok(cursor) => DerivedIndexLifecycle::Ready(cursor),
            Err(error) => {
                tracing::error!(%error, "derived index update failed; catch-up will retry");
                DerivedIndexLifecycle::Unavailable
            }
        });
    }

    /// One receipt per admitted transaction, from its canonical result and
    /// bytes, its stored effects, and the delivery batch that carried it.
    pub(crate) fn receipt_rows(
        index: &DerivedIndexStore,
        source: &DerivationSource,
        boundary: &CommittedBoundary,
        transactions: &[&TransactionEffects],
    ) -> Result<Vec<ReceiptRecord>, StateError> {
        let block = &boundary.block;
        let l1_origin = &boundary.l1_origin;
        let mut receipts: Vec<ReceiptRecord> = Vec::with_capacity(transactions.len());
        let mut spending_transaction_ids = HashMap::<B256, B256>::new();
        for (pcash_transaction_index, ((result, transaction), effects)) in block
            .transaction_results
            .iter()
            .zip(&block.transaction_bytes)
            .zip(transactions)
            .enumerate()
        {
            let (batch, item) =
                pcash_state::admitted_delivery(&boundary.history.l1_delivery_batches, result)
                    .expect("admitted transaction has a delivery manifest item");
            let tx_id = pcash_state::transaction_id(
                l1_origin.block_hash,
                result.l1_transaction_index,
                result.batch_item_index,
            );
            let kind = transaction[0];
            // Successful transactions carry the selected payout and account
            // result. Failed ones carry the account they address but no
            // payout, so their declared fee comes from their exact wire bytes.
            let (declared, lifecycle_address) = match effects {
                TransactionEffects::Accepted(effects) => (
                    effects.payout.as_ref().map(|payout| {
                        (
                            payout.open_fee_amount,
                            pcash_state::fr_to_bytes(payout.issuance_owner_commitment),
                        )
                    }),
                    effects.account.as_ref().map(AccountResult::address),
                ),
                TransactionEffects::Rejected(effects) => (
                    declared_publication(transaction, source.pcash_chain_id)?,
                    effects.account,
                ),
            };
            let issuance_owner_commitment = declared
                .filter(|_| pcash_derive::earns_issuance(kind))
                .map(|(_, owner)| {
                    if owner == B256::ZERO {
                        batch
                            .poster_owner_commitment
                            .expect("admitted transaction has a framed poster commitment")
                    } else {
                        owner
                    }
                });
            let (failure_detail, output_leaf_start, outputs_added, nullifiers, account) =
                match effects {
                    TransactionEffects::Accepted(effects) => (
                        None,
                        effects.output_leaf_start,
                        effects.output_commitments.len() as u64,
                        // Every kind that carries a private-value section marks
                        // its selected profile’s nullifiers; proof-free
                        // creation marks none.
                        (!effects.nullifiers.is_empty()).then(|| effects.nullifiers.clone()),
                        effects.account.as_ref().map(|account| AccountReceiptData {
                            address: account.address(),
                            account_revision: account.revision(),
                        }),
                    ),
                    TransactionEffects::Rejected(effects) => {
                        let detail = match &effects.detail {
                            Some(FailureDetailSeed::Complete(detail)) => Some(detail.clone()),
                            Some(FailureDetailSeed::NullifierAlreadySpent {
                                input_slot,
                                nullifier,
                            }) => {
                                let spending_transaction_id = if let Some(transaction_id) =
                                    spending_transaction_ids.get(nullifier)
                                {
                                    *transaction_id
                                } else {
                                    index
                                        .receipt_by_nullifier(nullifier)?
                                        .ok_or_else(|| {
                                            StateError::Backend(
                                                "spent nullifier has no canonical consuming receipt"
                                                    .into(),
                                            )
                                        })?
                                        .tx_id
                                };
                                Some(FailureDetail::NullifierAlreadySpent {
                                    input_slot: *input_slot,
                                    nullifier: *nullifier,
                                    spending_transaction_id,
                                })
                            }
                            None => None,
                        };
                        (detail, None, 0, None, None)
                    }
                };
            let outcome_code = result.outcome;
            receipts.push(ReceiptRecord {
                pcash_transaction_index: pcash_transaction_index as u64,
                l1_block_number: l1_origin.block_number,
                l1_block_hash: l1_origin.block_hash,
                l1_transaction_index: result.l1_transaction_index,
                l1_transaction_hash: batch.l1_transaction_hash,
                batch_item_index: result.batch_item_index,
                content_hash: item.content_hash,
                tx_id,
                outcome: outcome_code,
                failure_detail,
                l1_sender: batch.l1_sender,
                issuance_owner_commitment,
                has_open_fee: declared
                    .is_some_and(|(fee, owner)| owner == B256::ZERO && !fee.is_zero()),
                settled_open_fee_amount: if outcome_code.is_succeeded() {
                    declared.map_or(U256::ZERO, |(amount, _)| amount)
                } else {
                    U256::ZERO
                },
                settled_issuance_amount: if outcome_code.is_succeeded()
                    && pcash_derive::earns_issuance(kind)
                {
                    boundary.history.economics.reward_each
                } else {
                    U256::ZERO
                },
                byte_size: transaction.len() as u64,
                kind,
                account_creation: result.account_creation,
                lifecycle_address,
                output_leaf_start,
                outputs_added,
                nullifiers,
                account,
            });
            if let Some(nullifiers) = receipts
                .last()
                .and_then(|receipt| receipt.nullifiers.as_ref())
            {
                for nullifier in nullifiers {
                    spending_transaction_ids.insert(*nullifier, tx_id);
                }
            }
            let pushed = receipts.last().unwrap();
            if !pushed.accepted() {
                tracing::info!(
                    block = l1_origin.block_number,
                    l1_transaction_index = result.l1_transaction_index,
                    tx_id = %tx_id,
                    kind = ?transaction_kind(kind),
                    outcome = ?pushed.outcome,
                    "transaction failed"
                );
            } else if let Some(account) = &pushed.account {
                tracing::info!(
                    block = l1_origin.block_number,
                    l1_transaction_index = result.l1_transaction_index,
                    tx_id = %tx_id,
                    address = %account.address,
                    revision = account.account_revision,
                    "account entry accepted"
                );
            } else {
                tracing::info!(
                    block = l1_origin.block_number,
                    l1_transaction_index = result.l1_transaction_index,
                    tx_id = %tx_id,
                    kind = ?transaction_kind(kind),
                    output_leaf_start,
                    outputs_added,
                    "entry accepted"
                );
            }
        }
        Ok(receipts)
    }

    /// Prune savepoints and the block-hash trail below `finalized`, keeping the
    /// anchor AT `finalized` (a reorg whose fork point is exactly `finalized`
    /// reverts nothing finalized and must still be restorable). Derived index
    /// history is retained for serving.
    ///
    /// The replacement resume checkpoint and deletion of older savepoints commit
    /// atomically before the in-memory finality/trail fields advance. On a backend
    /// failure the state and trail are left untouched, so the next tick can retry
    /// without exposing a checkpoint that names an already-pruned savepoint.
    pub fn prune_finalized(&mut self, finalized: u64) -> Result<(), pcash_state::StateError> {
        // When this height has been derived, checkpoint it in the SAME durable
        // operation that deletes older savepoints. If it predates the derived
        // range there is no restart anchor to write and ordinary pruning is safe.
        let checkpoint_hash = self.block_hashes.get(&finalized).copied();
        if let Some(hash) = checkpoint_hash {
            let genesis = self.state.canonical_stored_block(0)?.ok_or_else(|| {
                pcash_state::StateError::Backend("canonical block zero is missing".to_owned())
            })?;
            let pcash_number = finalized
                .checked_sub(genesis.l1_origin.block_number)
                .ok_or_else(|| {
                    pcash_state::StateError::Backend(
                        "finalized L1 block precedes canonical block zero".to_owned(),
                    )
                })?;
            let checkpoint_block = self
                .state
                .canonical_stored_block(pcash_number)?
                .ok_or_else(|| {
                    pcash_state::StateError::Backend(
                        "finalized canonical PCASH block is missing".to_owned(),
                    )
                })?;
            let fork_schedule_prefix_hash = self
                .rules
                .activated_fork_schedule_prefix_hash_at(checkpoint_block.header.timestamp);
            self.state
                .advance_finalized(finalized, hash, fork_schedule_prefix_hash)?;
        } else {
            self.state.prune(finalized)?;
        }

        // Only publish the new finality boundary in memory after the durable
        // checkpoint/prune operation succeeds.
        self.block_hashes.retain(|&b, _| b >= finalized);
        self.l1_finalized = self.l1_finalized.max(finalized);
        Ok(())
    }

    /// Roll the derived state back to the end of block `k` after a reorg:
    /// restore the redb savepoint and drop everything derived above `k`.
    pub fn rollback_to(&mut self, k: u64) -> Result<(), pcash_state::StateError> {
        self.state.restore_to(k)?;
        self.head = Some(k);
        self.block_hashes.retain(|&b, _| b <= k);
        let tip = self
            .state
            .canonical_tip_summary()
            .ok_or_else(|| StateError::Backend("rollback restored no canonical tip".into()))?;
        let target = IndexBlockId {
            number: tip.number,
            hash: tip.hash,
        };
        let lifecycle = match self.index.cursor() {
            Ok(Some(cursor)) if cursor.pcash_number > target.number => {
                match self.index.rewind_to(target) {
                    Ok(()) => match self.index.cursor() {
                        Ok(Some(cursor)) => DerivedIndexLifecycle::Ready(cursor),
                        Ok(None) => DerivedIndexLifecycle::CatchingUp { cursor: None },
                        Err(_) => DerivedIndexLifecycle::Unavailable,
                    },
                    Err(error) => {
                        tracing::error!(%error, "derived index rewind failed after canonical rollback");
                        DerivedIndexLifecycle::Unavailable
                    }
                }
            }
            Ok(Some(cursor))
                if cursor.pcash_number == target.number && cursor.pcash_hash == target.hash =>
            {
                DerivedIndexLifecycle::Ready(cursor)
            }
            Ok(cursor) => DerivedIndexLifecycle::CatchingUp { cursor },
            Err(error) => {
                tracing::error!(%error, "derived index cursor unavailable after canonical rollback");
                DerivedIndexLifecycle::Unavailable
            }
        };
        self.set_index_lifecycle(lifecycle);
        Ok(())
    }

    /// Rebuild every contract verification row from the source registry; a node
    /// with no canonical blocks has nothing to rebuild.
    pub(crate) fn recompute_contract_verification(&self) -> Result<(), String> {
        if self.state.canonical_tip().is_none() {
            return Ok(());
        }
        if !matches!(self.index_lifecycle(), DerivedIndexLifecycle::Ready(_)) {
            return Err("derived index is not ready".to_owned());
        }
        let Some(lookup) = self.contract_verification.clone() else {
            return Ok(());
        };
        self.index
            .recompute_contract_verification(lookup.as_ref())
            .map_err(|error| error.to_string())
    }
}

/// Database transactions held only for the duration of one RPC request.
struct CanonicalRead {
    state: pcash_state::RedbReadSnapshot,
    rules: Arc<ProtocolRules>,
    source: DerivationSource,
    observed_l1_block_number: Option<u64>,
    derivation: DerivationDto,
    index_lifecycle: DerivedIndexLifecycle,
    prover_assets: Option<ProverAssetsDto>,
}

struct NodeRead {
    canonical: CanonicalRead,
    index: crate::index::DerivedIndexRead,
}

impl std::ops::Deref for NodeRead {
    type Target = CanonicalRead;

    fn deref(&self) -> &Self::Target {
        &self.canonical
    }
}

impl CanonicalRead {
    fn witness_snapshot(
        &self,
        query: &pcash_rpc::request::WitnessSnapshotQuery,
        index: Option<&crate::index::DerivedIndexRead>,
    ) -> Result<pcash_rpc::dto::WitnessSnapshotDto, StateError> {
        let block_header = handlers::get_block_header(&self.state, self.latest_block()?)?;
        let block =
            self.state
                .canonical_tip()?
                .map(|block| pcash_rpc::dto::WitnessSnapshotBlockDto {
                    number: block.header.number,
                    hash: block.hash,
                    l1_origin: pcash_rpc::dto::L1OriginDto {
                        block_number: block.l1_origin.block_number,
                        block_hash: block.l1_origin.block_hash,
                        block_timestamp: block.l1_origin.block_timestamp,
                        l1_logs_root: block.l1_origin.l1_logs_root,
                        l1_log_count: block.l1_origin.l1_log_count,
                    },
                });
        let outputs = if query.outputs.is_empty() {
            None
        } else {
            handlers::get_output_paths(&self.state, &query.outputs)?
        };
        let nullifiers = if query.nullifiers.is_empty() {
            None
        } else {
            handlers::get_nullifier_proofs(&self.state, &query.nullifiers)?
        };
        Ok(pcash_rpc::dto::WitnessSnapshotDto {
            status: handlers::status(&self.state, &self.status_meta(index)?)?,
            block_header,
            block,
            outputs,
            nullifiers,
            accounts: Vec::new(),
            contracts: Vec::new(),
            l1_logs: Vec::new(),
        })
    }

    fn latest_block(&self) -> Result<u64, StateError> {
        self.state
            .canonical_tip_summary()?
            .map(|tip| tip.number)
            .ok_or_else(|| StateError::Backend("canonical block zero is unavailable".into()))
    }

    fn finalized_block(&self) -> Result<u64, StateError> {
        Ok(self
            .state
            .checkpoint()
            .map_or(0, |checkpoint| checkpoint.pcash_block_number)
            .min(self.latest_block()?))
    }

    fn status_meta(
        &self,
        index: Option<&crate::index::DerivedIndexRead>,
    ) -> Result<StatusMeta, StateError> {
        let latest_block = self.latest_block()?;
        let finalized_block = self.finalized_block()?;
        let latest_canonical = self
            .state
            .canonical_tip_summary()?
            .ok_or_else(|| StateError::Backend("canonical block zero is unavailable".into()))?;
        let latest_block_hash = latest_canonical.hash;
        let latest_block_timestamp = latest_canonical.timestamp;
        let finalized_canonical = self.state.canonical_stored_block(finalized_block)?;
        let finalized_block_hash = finalized_canonical
            .as_ref()
            .map_or(B256::ZERO, |block| block.hash);
        let finalized_block_timestamp = finalized_canonical
            .as_ref()
            .map_or(0, |block| block.header.timestamp);
        let latest_origin = self
            .state
            .canonical_tip()?
            .ok_or_else(|| StateError::Backend("canonical tip is unavailable".into()))?
            .l1_origin;
        let latest_l1_block_number = latest_origin.block_number;
        let latest_l1_block_hash = latest_origin.block_hash;
        let finalized_l1_block_number = finalized_canonical
            .as_ref()
            .map_or(self.source.genesis_l1_block, |block| {
                block.l1_origin.block_number
            });
        let finalized_l1_block_hash = finalized_canonical
            .as_ref()
            .map_or(B256::ZERO, |block| block.l1_origin.block_hash);
        let accepted_transaction_types = self
            .rules
            .accepted_transaction_types_at(latest_block_timestamp);
        let accepted_batch_versions = self
            .rules
            .accepted_batch_versions_at(latest_block_timestamp)
            .into_iter()
            .map(|version| version.wire_byte())
            .collect();
        let (index_status, index_cursor, transaction_totals) =
            index_status(&self.state, index, self.index_lifecycle);
        let capability = self.fork_capability()?;
        Ok(StatusMeta {
            pcash_chain_id: self.source.pcash_chain_id,
            genesis_hash: self
                .state
                .canonical_genesis_hash()
                .ok_or_else(|| StateError::Backend("canonical block zero is unavailable".into()))?,
            accepted_transaction_types,
            accepted_batch_versions,
            l1_chain_id: self.source.l1_chain_id,
            inbox_address: self.source.inbox_address,
            genesis_l1_block: self.source.genesis_l1_block,
            genesis_l1_block_hash: self.source.genesis_l1_block_hash,
            latest_block,
            latest_block_hash,
            latest_block_timestamp,
            finalized_block,
            finalized_block_hash,
            finalized_block_timestamp,
            latest_l1_block_number,
            latest_l1_block_hash,
            observed_l1_block_number: self.observed_l1_block_number,
            derivation: self.derivation,
            finalized_l1_block_number,
            finalized_l1_block_hash,
            issued_so_far: pcash_state::StateRead::state_components(&self.state)?
                .issuance
                .issued_so_far,
            supply_cap: pcash_issuance::supply_cap(),
            total_succeeded: transaction_totals.map(|totals| totals.0),
            total_failed: transaction_totals.map(|totals| totals.1),
            total_transactions: transaction_totals.map(|totals| totals.2),
            index_status,
            index_cursor,
            prover_assets: self.prover_assets.clone(),
            fork_capability: fork_capability_dto(capability),
        })
    }

    fn fork_capability(&self) -> Result<ForkCapability, StateError> {
        let unavailable = || StateError::Backend("canonical block zero is unavailable".into());
        Ok(fork_capability(
            &self.rules,
            self.source.pcash_chain_id,
            self.state
                .canonical_tip_summary()?
                .ok_or_else(unavailable)?
                .timestamp,
            self.state
                .canonical_genesis_hash()
                .ok_or_else(unavailable)?,
        ))
    }
}

fn ready_index_cursor(
    state: &pcash_state::RedbReadSnapshot,
    index: &crate::index::DerivedIndexRead,
) -> Result<DerivedIndexCursor, IndexReadError> {
    let cursor = index
        .cursor()?
        .ok_or_else(|| IndexReadError::Unavailable("catchingUp".into()))?;
    // The stores advance independently. A reorg can temporarily leave the
    // index on a different branch; never combine that branch with proofs.
    let canonical = state.canonical_stored_block(cursor.pcash_number)?;
    if canonical.as_ref().map(|block| block.hash) != Some(cursor.pcash_hash) {
        return Err(IndexReadError::Unavailable("catchingUp".into()));
    }
    Ok(cursor)
}

/// The index's status, cursor, and transaction totals. `ready` is the
/// lifecycle's word that the index follows the canonical tip, backed by a
/// canonical cursor and readable totals in this response's own snapshots.
fn index_status(
    state: &pcash_state::RedbReadSnapshot,
    index: Option<&crate::index::DerivedIndexRead>,
    lifecycle: DerivedIndexLifecycle,
) -> (String, Option<BlockId>, Option<(u64, u64, u64)>) {
    let cursor = index
        .and_then(|index| index.cursor().ok().flatten())
        .map(|c| BlockId {
            block_number: c.pcash_number,
            block_hash: c.pcash_hash,
        });
    let totals = match (lifecycle, index) {
        (DerivedIndexLifecycle::Ready(_), Some(index))
            if ready_index_cursor(state, index).is_ok() =>
        {
            index.transaction_totals().ok()
        }
        _ => None,
    };
    let status = match lifecycle {
        DerivedIndexLifecycle::Ready(_) if totals.is_some() => "ready",
        DerivedIndexLifecycle::CatchingUp { .. } => "catchingUp",
        DerivedIndexLifecycle::Ready(_) | DerivedIndexLifecycle::Unavailable => "unavailable",
    };
    (status.into(), cursor, totals)
}

impl NodeRead {
    fn ready_index_cursor(&self) -> Result<DerivedIndexCursor, IndexReadError> {
        ready_index_cursor(&self.state, &self.index)
    }
}

/// Bounds on one block economics page. `bucket` never exceeds
/// `scanned_rows`: a scan starts at a bucket boundary, so it always
/// completes at least one bucket or reaches the indexed head, and every
/// continuation makes progress.
#[derive(Clone, Copy, Debug)]
pub(crate) struct BlockEconomicsLimits {
    pub(crate) records: u64,
    pub(crate) bucket: u64,
    pub(crate) scanned_rows: usize,
}

impl BlockEconomicsLimits {
    pub(crate) const DEFAULT: Self = Self {
        records: 1024,
        bucket: 32_768,
        scanned_rows: 32_768,
    };
}

const _: () = assert!(
    BlockEconomicsLimits::DEFAULT.bucket as usize <= BlockEconomicsLimits::DEFAULT.scanned_rows
);

/// Aggregate the index's per-block economics series into bucketed records.
/// Buckets align to multiples of `bucket`; a bucket is emitted once its last
/// block is read, or partially when it contains the indexed head.
pub(crate) fn block_economics_page(
    index: &crate::index::DerivedIndexRead,
    cursor: DerivedIndexCursor,
    query: pcash_rpc::BlockEconomicsQuery,
) -> Result<pcash_rpc::dto::BlockEconomicsPageDto, IndexReadError> {
    block_economics_page_with_limits(index, cursor, query, BlockEconomicsLimits::DEFAULT)
}

pub(crate) fn block_economics_page_with_limits(
    index: &crate::index::DerivedIndexRead,
    cursor: DerivedIndexCursor,
    query: pcash_rpc::BlockEconomicsQuery,
    limits: BlockEconomicsLimits,
) -> Result<pcash_rpc::dto::BlockEconomicsPageDto, IndexReadError> {
    use pcash_rpc::dto::{BlockEconomicsPageDto, BlockEconomicsRecordDto};
    assert!(
        limits.bucket as usize <= limits.scanned_rows,
        "a bucket must fit within one scan"
    );
    let limit = query.limit.unwrap_or(256);
    if limit == 0 || limit > limits.records {
        return Err(IndexReadError::Invalid(format!(
            "limit must be between 1 and {}",
            limits.records
        )));
    }
    let bucket = query.bucket.unwrap_or(1);
    if bucket == 0 || bucket > limits.bucket {
        return Err(IndexReadError::Invalid(format!(
            "bucket must be between 1 and {}",
            limits.bucket
        )));
    }
    let head = cursor.pcash_number;
    let from = query.from_block.unwrap_or(0);
    let mut page = BlockEconomicsPageDto {
        at_block_number: head,
        at_block_hash: cursor.pcash_hash,
        records: Vec::new(),
        next_block: None,
    };
    if from > head {
        return Ok(page);
    }
    let start = from - from % bucket;
    let rows = index
        .block_economics_from(start, limits.scanned_rows)
        .map_err(|error| IndexReadError::Unavailable(error.to_string()))?;
    let mut expected = start;
    let mut current: Option<BlockEconomicsRecordDto> = None;
    for (number, row) in rows {
        if number != expected {
            return Err(IndexReadError::Unavailable(
                "derived block economics series is not contiguous".into(),
            ));
        }
        expected = number + 1;
        let record = current.get_or_insert(BlockEconomicsRecordDto {
            first_block: number,
            last_block: number,
            first_timestamp: row.timestamp,
            last_timestamp: row.timestamp,
            blocks: 0,
            qualifying_actions: 0,
            issuance_total: U256::ZERO,
            open_fees_total: U256::ZERO,
            reward_each: U256::ZERO,
            baseline: U256::ZERO,
            internal_offer: U256::ZERO,
            block_allowance: U256::ZERO,
            lag_q: I256::ZERO,
        });
        record.last_block = number;
        record.last_timestamp = row.timestamp;
        record.blocks += 1;
        record.qualifying_actions += row.qualifying_actions;
        record.issuance_total += row.issuance_total;
        record.open_fees_total += row.open_fees_total;
        record.reward_each = row.reward_each;
        record.baseline = row.baseline;
        record.internal_offer = row.internal_offer;
        record.block_allowance = row.block_allowance;
        record.lag_q = row.lag_q;
        let bucket_end = number - number % bucket + bucket - 1;
        if number == bucket_end || number == head {
            page.records.push(current.take().unwrap());
            if number == head {
                break;
            }
            if page.records.len() as u64 == limit {
                page.next_block = Some(number + 1);
                return Ok(page);
            }
        }
    }
    if expected <= head {
        // The scan budget cut the series short. At least one bucket was
        // completed above because a bucket fits within one scan, so retrying
        // the unfinished bucket from its first block still makes progress.
        page.next_block = Some(match current {
            Some(record) => record.first_block,
            None => expected,
        });
    }
    Ok(page)
}

/// RPC handles read committed database state without acquiring the derivation lock.
#[derive(Clone)]
pub struct NodeHandle {
    #[cfg(test)]
    fail_index_read: bool,
    #[cfg(any(test, feature = "test-support"))]
    fail_canonical_reads: Arc<AtomicBool>,
    inner: Arc<Mutex<NodeInner>>,
    state_reader: pcash_state::RedbStateReader,
    index_reader: Arc<RwLock<DerivedIndexStore>>,
    index_lifecycle: watch::Receiver<DerivedIndexLifecycle>,
    observed_l1_block_number: Arc<RwLock<Option<u64>>>,
    derivation: Arc<RwLock<DerivationDto>>,
    published_status: Arc<RwLock<Option<StatusDto>>>,
    rules: Arc<ProtocolRules>,
    source: DerivationSource,
    mempool: Option<Arc<MempoolService>>,
    /// The optional publication catalog. `None` means no catalog was configured
    /// at all, which reports as `disabled` with this node's identity.
    catalog: Option<Arc<CatalogService>>,
    source_verification: Option<Arc<SourceVerificationService>>,
    p2p: Option<P2pHandle>,
    /// Every P2P listen address currently bound. Reported by `admin_nodeInfo`
    /// so an operator can hand one to another node's `admin_addPeer` without
    /// reading logs. This is a set because a wildcard bind listens on every
    /// interface and addresses can expire.
    p2p_listen: Option<watch::Receiver<BTreeSet<Multiaddr>>>,
    /// Optional deployment metadata for browser proving assets.
    prover_assets: Option<ProverAssetsDto>,
}

impl NodeHandle {
    fn read_canonical(&self) -> Result<CanonicalRead, StateError> {
        #[cfg(any(test, feature = "test-support"))]
        if self.fail_canonical_reads.load(Ordering::Relaxed) {
            return Err(StateError::Backend(
                "injected canonical snapshot failure".into(),
            ));
        }
        Ok(CanonicalRead {
            state: self.state_reader.snapshot()?,
            rules: Arc::clone(&self.rules),
            source: self.source,
            observed_l1_block_number: *self.observed_l1_block_number.read().unwrap(),
            derivation: *self.derivation.read().unwrap(),
            index_lifecycle: *self.index_lifecycle.borrow(),
            prover_assets: self.prover_assets.clone(),
        })
    }

    fn read_index(&self) -> Result<crate::index::DerivedIndexRead, StateError> {
        #[cfg(test)]
        if self.fail_index_read {
            return Err(StateError::Backend(
                "injected index snapshot failure".into(),
            ));
        }
        self.index_reader.read().unwrap().read_snapshot()
    }

    fn read_node(&self) -> Result<NodeRead, StateError> {
        // Capture the index before canonical state so forward commits cannot
        // expose indexed rows from beyond the canonical read transaction.
        let index = self.read_index()?;
        Ok(NodeRead {
            index,
            canonical: self.read_canonical()?,
        })
    }

    pub fn new(inner: Arc<Mutex<NodeInner>>) -> Self {
        let (
            state_reader,
            index_reader,
            index_lifecycle,
            observed_l1_block_number,
            derivation,
            published_status,
            rules,
            source,
        ) = {
            let guard = inner.lock().unwrap();
            (
                guard.state.reader(),
                guard.index_reader.clone(),
                guard.watch_index_lifecycle(),
                guard.observed_l1_block_number.clone(),
                guard.derivation.clone(),
                guard.published_status.clone(),
                Arc::clone(&guard.rules),
                guard.source,
            )
        };
        #[cfg(any(test, feature = "test-support"))]
        let fail_canonical_reads = inner.lock().unwrap().fail_canonical_reads.clone();
        Self {
            #[cfg(test)]
            fail_index_read: false,
            #[cfg(any(test, feature = "test-support"))]
            fail_canonical_reads,
            state_reader,
            index_reader,
            index_lifecycle,
            observed_l1_block_number,
            derivation,
            published_status,
            rules,
            source,
            inner,
            mempool: None,
            catalog: None,
            source_verification: None,
            p2p: None,
            p2p_listen: None,
            prover_assets: None,
        }
    }

    fn read_status(&self) -> Result<StatusDto, StateError> {
        let index = self.read_index().ok();
        let g = self.read_canonical()?;
        handlers::status(&g.state, &g.status_meta(index.as_ref())?)
    }

    /// Keep the status at this commit for a halted node to serve.
    pub(crate) fn publish_status(&self) {
        if let Ok(status) = self.read_status() {
            *self.published_status.write().unwrap() = Some(status);
        }
    }

    pub fn with_mempool(mut self, mempool: Arc<MempoolService>) -> Self {
        self.mempool = Some(mempool);
        self
    }

    pub fn with_p2p(
        mut self,
        p2p: P2pHandle,
        listen: watch::Receiver<BTreeSet<Multiaddr>>,
    ) -> Self {
        self.p2p = Some(p2p);
        self.p2p_listen = Some(listen);
        self
    }

    pub fn with_prover_assets(mut self, prover_assets: Option<ProverAssetsDto>) -> Self {
        self.prover_assets = prover_assets;
        self
    }

    pub fn inner(&self) -> &Arc<Mutex<NodeInner>> {
        &self.inner
    }

    pub fn with_catalog(mut self, catalog: Arc<CatalogService>) -> Self {
        self.catalog = Some(catalog);
        self
    }

    pub fn with_source_verification(
        mut self,
        source_verification: Arc<SourceVerificationService>,
    ) -> Self {
        self.inner
            .lock()
            .unwrap()
            .set_contract_verification(Arc::clone(&source_verification));
        self.source_verification = Some(source_verification);
        self
    }

    /// Refresh the derived index from the source registry: one contract for
    /// `Some(address)`, every contract for `None`.
    pub fn contract_verification_changed(&self, address: Option<Address>) -> Result<(), String> {
        let guard = self.inner.lock().unwrap();
        let Some(lookup) = guard.contract_verification.clone() else {
            return Ok(());
        };
        if !matches!(guard.index_lifecycle(), DerivedIndexLifecycle::Ready(_)) {
            tracing::warn!("derived index is not ready; contract verification was not indexed");
            return Ok(());
        }
        match address {
            Some(address) => guard
                .index
                .update_contract_verification(address, lookup.as_ref()),
            None => guard.index.recompute_contract_verification(lookup.as_ref()),
        }
        .map_err(|error| error.to_string())
    }

    /// Rebuild every contract verification row from the source registry; a node
    /// with no canonical blocks has nothing to rebuild.
    pub fn recompute_contract_verification(&self) -> Result<(), String> {
        self.inner.lock().unwrap().recompute_contract_verification()
    }

    /// The canonical contract account behind `address` for source-correspondence
    /// reads. This is the whole chain-index surface the pscan listener needs.
    /// Changes to the derived index's lifecycle, including each cursor advance.
    pub fn watch_index(&self) -> watch::Receiver<DerivedIndexLifecycle> {
        self.index_lifecycle.clone()
    }

    pub fn contract_for_source(&self, address: Address) -> Result<Option<ContractDto>, String> {
        let result = self
            .get_contract(address)
            .map_err(|error| error.to_string())?;
        match result {
            ContractResultDto::Contract(contract) => Ok(Some(contract)),
            ContractResultDto::NotFound { .. } | ContractResultDto::NotContract { .. } => Ok(None),
            ContractResultDto::Unavailable { lifecycle, .. } => {
                Err(format!("contract index {lifecycle}"))
            }
        }
    }

    fn chain_id_snapshot(&self) -> u32 {
        self.source.pcash_chain_id
    }
}

/// Render the swarm's peer record onto the wire.
fn peer_info_dto(peer: &pcash_p2p::PeerInfo) -> PeerInfoDto {
    PeerInfoDto {
        peer_id: peer.peer_id.to_string(),
        remote_address: peer.remote_address.to_string(),
        direction: match peer.direction {
            pcash_p2p::Direction::Inbound => PeerDirectionDto::Inbound,
            pcash_p2p::Direction::Outbound => PeerDirectionDto::Outbound,
        },
        connected_seconds: peer.connected_for.as_secs(),
        connections: u64::from(peer.connections),
        compatible: peer.compatible,
        incompatible_reason: peer.incompatible_reason.clone(),
        capability: peer.capability.map(fork_capability_dto),
        agent_version: peer.agent_version.clone(),
        protocol_version: peer.protocol_version.clone(),
        rtt_millis: peer.rtt.map(|rtt| rtt.as_millis() as u64),
        payload_bytes_sent: peer.payload_bytes_sent,
        payload_bytes_received: peer.payload_bytes_received,
        tx_received: peer.tx_received,
        tx_accepted: peer.tx_accepted,
        tx_rejected: peer.tx_rejected,
        score: i64::from(peer.score),
        banned_seconds: peer.banned_for.map(|left| left.as_secs()),
        divergence: peer.divergence.map(|divergence| BlockHashDivergenceDto {
            l1_block_number: divergence.l1_block_number,
            l1_block_hash: divergence.l1_block_hash,
            local_block_hash: divergence.local_block_hash,
            peer_block_hash: divergence.peer_block_hash,
        }),
    }
}

#[async_trait::async_trait]
impl AdminApi for NodeHandle {
    async fn add_peer(&self, address: String) -> Result<AddPeerResultDto, AdminApiError> {
        let p2p = self.p2p.as_ref().ok_or(AdminApiError::Disabled)?;
        let address: Multiaddr = address
            .parse()
            .map_err(|error| AdminApiError::InvalidAddress(format!("{address}: {error}")))?;
        let peer = p2p
            .add_peer(address)
            .await
            .map_err(|error| AdminApiError::InvalidAddress(error.to_string()))?;
        Ok(AddPeerResultDto {
            peer_id: peer.to_string(),
        })
    }

    async fn remove_peer(
        &self,
        peer_id: String,
        ban: bool,
    ) -> Result<RemovePeerResultDto, AdminApiError> {
        let p2p = self.p2p.as_ref().ok_or(AdminApiError::Disabled)?;
        let peer: pcash_p2p::PeerId = peer_id
            .parse()
            .map_err(|error| AdminApiError::InvalidAddress(format!("{peer_id}: {error}")))?;
        let removed = p2p
            .remove_peer(peer, ban)
            .await
            .map_err(|error| AdminApiError::InvalidAddress(error.to_string()))?;
        Ok(RemovePeerResultDto {
            removed,
            banned: ban,
        })
    }

    fn peers(&self) -> Result<Vec<PeerInfoDto>, AdminApiError> {
        let p2p = self.p2p.as_ref().ok_or(AdminApiError::Disabled)?;
        Ok(p2p.peers().iter().map(peer_info_dto).collect())
    }

    fn node_info(&self) -> Result<NodeInfoDto, AdminApiError> {
        let p2p = self.p2p.as_ref().ok_or(AdminApiError::Disabled)?;
        let listen: Vec<Multiaddr> = self
            .p2p_listen
            .as_ref()
            .map(|listen| listen.borrow().iter().cloned().collect())
            .unwrap_or_default();
        let network = p2p.network_status();
        Ok(NodeInfoDto {
            peer_id: p2p.peer_id().to_string(),
            listen_addresses: listen.iter().map(ToString::to_string).collect(),
            bootstrap_addresses: network
                .external_addresses
                .iter()
                .map(ToString::to_string)
                .collect(),
            network: pcash_rpc::P2pNetworkDto {
                discovery_mode: network.discovery_mode.as_str().into(),
                routing_peers: network.routing_peers as u64,
                pending_dials: network.pending_dials as u64,
                target_peers: network.target_peers as u64,
                reachability: network.reachability.as_str().into(),
                relay_reservations: network
                    .relay_reservations
                    .iter()
                    .map(ToString::to_string)
                    .collect(),
                relay_circuits: network.relay_circuits as u64,
                relay_circuits_closed: network.counters.relay_circuits_closed,
                discovery_queries_succeeded: network.counters.discovery_queries_succeeded,
                discovery_queries_failed: network.counters.discovery_queries_failed,
                dial_failures: network.counters.dial_failures,
                hole_punches_succeeded: network.counters.hole_punches_succeeded,
                hole_punches_failed: network.counters.hole_punches_failed,
            },
            topic: p2p.topic().to_owned(),
            peer_count: p2p.peer_count() as u64,
        })
    }

    fn publish_source_verification(
        &self,
        publication: serde_json::Value,
    ) -> Result<serde_json::Value, AdminApiError> {
        let publication: SourceVerificationPublication = serde_json::from_value(publication)
            .map_err(|error| {
                admin_source_error(SourceVerificationApiError::Invalid(error.to_string()))
            })?;
        let info = self
            .source_verification
            .as_ref()
            .ok_or_else(|| admin_source_error(SourceVerificationApiError::Disabled))?
            .publish(publication)
            .map_err(admin_source_error)?;
        // The registry commit already happened; a stale verification index is
        // repairable and must not turn an accepted publication into an error.
        if let Err(error) = self.contract_verification_changed(None) {
            tracing::warn!(%error, "contract verification index refresh failed after publish");
        }
        serde_json::to_value(&info).map_err(|error| AdminApiError::Internal(error.to_string()))
    }
}

/// One admin error class per registry error class, so a publisher can tell a
/// malformed bundle from a conflicting one without parsing messages.
fn admin_source_error(error: SourceVerificationApiError) -> AdminApiError {
    let message = error.to_string();
    match error {
        SourceVerificationApiError::Disabled => AdminApiError::SourceDisabled(message),
        SourceVerificationApiError::Unavailable(_) => AdminApiError::SourceUnavailable(message),
        SourceVerificationApiError::Invalid(_) => AdminApiError::SourceInvalid(message),
        SourceVerificationApiError::Conflict(_) => AdminApiError::SourceConflict(message),
        SourceVerificationApiError::Storage(_) => AdminApiError::SourceStorage(message),
    }
}

/// The wire shape of a contract's committed function set.
fn contract_function_dtos(functions: &[ContractFunctionMaterial]) -> Vec<ContractFunctionDto> {
    functions
        .iter()
        .map(|function| ContractFunctionDto {
            selector: function.selector,
            application_vk_hash: function.application_vk_hash,
            configuration_commitment: function.configuration_commitment,
        })
        .collect()
}

/// Answers the derived index's verification lookups from the source registry.
/// A registry that cannot answer yields `None`, which removes the contract's
/// verification rows.
struct SourceVerificationLookup(Arc<SourceVerificationService>);

impl ContractVerificationLookup for SourceVerificationLookup {
    fn lookup(
        &self,
        address: Address,
        functions: &[ContractFunctionMaterial],
    ) -> Option<ContractSourceInfo> {
        let functions = contract_function_dtos(functions);
        let (status, opening_count) = self.0.contract_summary(address, &functions).ok()?;
        Some(ContractSourceInfo {
            verified: status == ContractSourceStatus::Verified,
            opening_count,
        })
    }
}

fn get_contract_locked(g: &NodeRead, addr: Address) -> Result<ContractResultDto, StateError> {
    let Some(account) = g.state.account_of(addr)? else {
        return Ok(ContractResultDto::not_found(addr));
    };
    let material = receive_material(g, addr)?;
    let Some(account_proof) =
        present_account_proof(handlers::get_account_proof(&g.state, addr, material)?)
    else {
        return Ok(ContractResultDto::not_found(addr));
    };
    if account.kind != 1 {
        return Ok(ContractResultDto::not_contract(account_proof));
    }
    if let Err(error) = g.ready_index_cursor() {
        return Ok(ContractResultDto::unavailable(addr, error.to_string()));
    }
    let address = addr;
    let material = match g.index.contract_material(address) {
        Ok(Some(material)) => material,
        Ok(None) => return Ok(ContractResultDto::unavailable(addr, "materialMissing")),
        Err(_) => return Ok(ContractResultDto::unavailable(addr, "unavailable")),
    };
    let transaction = g
        .state
        .canonical_transaction_body(
            material.pcash_block_number,
            material.pcash_transaction_index,
        )?
        .ok_or_else(|| StateError::Backend("canonical transaction body is missing".into()))?;
    Ok(ContractResultDto::Contract(ContractDto {
        status: ContractPresent::Contract,
        address: addr,
        account_proof,
        functions: contract_function_dtos(&material.functions),
        origin: contract_origin(&material),
        transaction: transaction.into(),
    }))
}

/// Node-facing RPC surface. Read methods use committed database transactions;
/// mutation methods delegate to node-local services.
#[async_trait::async_trait]
impl NodeApi for NodeHandle {
    // ---- canonical state and proof reads ----
    fn status(&self) -> Result<StatusDto, StateError> {
        let error = match self.read_status() {
            Ok(status) => return Ok(status),
            Err(error) => error,
        };
        // A storage failure that halts derivation can also fail this read. A
        // halted node's canonical state no longer changes, so the status its
        // follower last published is still exact. A node that is still
        // deriving reports the read failure instead of a status that may be old.
        let derivation = *self.derivation.read().unwrap();
        if !matches!(derivation, DerivationDto::Halted { .. }) {
            return Err(error);
        }
        let Some(mut status) = self.published_status.read().unwrap().clone() else {
            return Err(error);
        };
        status.derivation = derivation;
        status.observed_l1_block_number = *self.observed_l1_block_number.read().unwrap();
        status.prover_assets.clone_from(&self.prover_assets);
        Ok(status)
    }

    // Build all canonical components from one read transaction. Calling the
    // public proof getters here would open separate snapshots and could mix heads.
    fn get_witness_snapshot(
        &self,
        query: pcash_rpc::request::WitnessSnapshotQuery,
    ) -> Result<pcash_rpc::dto::WitnessSnapshotDto, IndexReadError> {
        if query.accounts.is_empty() && query.contracts.is_empty() && query.l1_logs.is_empty() {
            let index = self.read_index().ok();
            return Ok(self
                .read_canonical()?
                .witness_snapshot(&query, index.as_ref())?);
        }
        let unavailable = |error: StateError| IndexReadError::Unavailable(error.to_string());
        let g = self.read_node()?;
        let mut snapshot = g.witness_snapshot(&query, Some(&g.index))?;
        let mut accounts = Vec::with_capacity(query.accounts.len());
        for address in query.accounts {
            let material = receive_material(&g, address).map_err(unavailable)?;
            accounts.push(
                handlers::get_account_proof(&g.state, address, material).map_err(unavailable)?,
            );
        }
        let contracts = query
            .contracts
            .into_iter()
            .map(|address| get_contract_locked(&g, address))
            .collect::<Result<Vec<_>, _>>()
            .map_err(unavailable)?;
        let mut l1_logs = Vec::with_capacity(query.l1_logs.len());
        for log in query.l1_logs {
            g.ready_index_cursor()?;
            let Some(header) = &snapshot.block_header else {
                l1_logs.push(None);
                continue;
            };
            let Some(block) = handlers::get_l1_origin_proof(
                &g.state,
                header.recent_pcash_block_hash,
                log.l1_block_number,
            )
            .map_err(unavailable)?
            else {
                l1_logs.push(None);
                continue;
            };
            let Some(log) = g
                .index
                .l1_log_proof(log.l1_block_number, log.transaction_index, log.log_index)
                .map_err(unavailable)?
            else {
                l1_logs.push(None);
                continue;
            };
            let log_siblings = log.siblings.try_into().map_err(|_| {
                IndexReadError::Unavailable("normalized L1 log opening has the wrong depth".into())
            })?;
            l1_logs.push(Some(L1LogProofDto {
                block,
                log_leaf_index: log.leaf_index,
                log_siblings,
                transaction_index: log.transaction_index,
                log_index: log.log_index,
            }));
        }
        snapshot.accounts = accounts;
        snapshot.contracts = contracts;
        snapshot.l1_logs = l1_logs;
        Ok(snapshot)
    }

    fn get_output_path(&self, leaf_index: u64) -> Result<Option<OutputPathDto>, StateError> {
        let g = self.read_canonical()?;
        handlers::get_output_path(&g.state, leaf_index)
    }

    fn get_output_paths(
        &self,
        leaf_indices: &[u64],
    ) -> Result<Option<pcash_rpc::dto::OutputPathsDto>, StateError> {
        let g = self.read_canonical()?;
        handlers::get_output_paths(&g.state, leaf_indices)
    }

    fn get_account_proof(&self, addr: Address) -> Result<AccountProofResultDto, StateError> {
        let g = self.read_node()?;
        let material = receive_material(&g, addr)?;
        handlers::get_account_proof(&g.state, addr, material)
    }

    fn get_account(&self, addr: Address) -> Result<Option<AccountDto>, StateError> {
        let g = self.read_node()?;
        let material = receive_material(&g, addr)?;
        handlers::get_account(&g.state, addr, material)
    }

    fn get_contract(&self, addr: Address) -> Result<ContractResultDto, StateError> {
        let g = self.read_node()?;
        get_contract_locked(&g, addr)
    }

    fn get_block_header(&self, block_tag: BlockTag) -> Result<Option<BlockHeaderDto>, StateError> {
        let g = self.read_canonical()?;
        match block_tag {
            BlockTag::Latest => handlers::get_block_header(&g.state, g.latest_block()?),
            BlockTag::Number(number) => handlers::get_block_header(&g.state, number),
            BlockTag::Hash(hash) => handlers::get_block_header_by_hash(&g.state, hash),
        }
    }

    fn get_l1_origin_proof(
        &self,
        block_hash: B256,
        l1_block_number: u64,
    ) -> Result<Option<L1OriginProofDto>, StateError> {
        let g = self.read_canonical()?;
        if handlers::parse_block_hash(block_hash).is_none() {
            return Ok(None);
        }
        handlers::get_l1_origin_proof(&g.state, block_hash, l1_block_number)
    }

    fn get_l1_log_proof(
        &self,
        block_hash: B256,
        l1_block_number: u64,
        transaction_index: u64,
        log_index: u64,
    ) -> Result<Option<L1LogProofDto>, IndexReadError> {
        let unavailable = |error: StateError| IndexReadError::Unavailable(error.to_string());
        let g = self.read_node()?;
        g.ready_index_cursor()?;
        if handlers::parse_block_hash(block_hash).is_none() {
            return Ok(None);
        }
        let Some(block) = handlers::get_l1_origin_proof(&g.state, block_hash, l1_block_number)
            .map_err(unavailable)?
        else {
            return Ok(None);
        };
        let log = g
            .index
            .l1_log_proof(l1_block_number, transaction_index, log_index)
            .map_err(unavailable)?;

        let Some(log) = log else {
            return Ok(None);
        };
        let log_siblings: [B256; 64] = log.siblings.try_into().map_err(|_| {
            IndexReadError::Unavailable("normalized L1 log opening has the wrong depth".into())
        })?;
        Ok(Some(L1LogProofDto {
            block,
            log_leaf_index: log.leaf_index,
            log_siblings,
            transaction_index: log.transaction_index,
            log_index: log.log_index,
        }))
    }

    fn get_result_proof(
        &self,
        hash: B256,
        number: u64,
        position: pcash_rpc::dto::ResultPosition,
    ) -> Result<Option<pcash_rpc::dto::ResultProofDto>, StateError> {
        let g = self.read_canonical()?;
        handlers::get_result_proof(&g.state, &g.rules, hash, number, position)
    }

    fn get_history_proof(
        &self,
        block_hash: B256,
        historical_block_number: u64,
    ) -> Result<Option<HistoryProofDto>, StateError> {
        let g = self.read_canonical()?;
        if handlers::parse_block_hash(block_hash).is_none() {
            return Ok(None);
        }
        handlers::get_history_proof(&g.state, block_hash, historical_block_number)
    }

    fn get_block(
        &self,
        number: u64,
        full_transactions: bool,
    ) -> Result<Option<BlockDto>, StateError> {
        let g = self.read_canonical()?;
        if full_transactions {
            g.state
                .canonical_block(number)?
                .map(|block| block_to_dto(&g.state, block, true))
                .transpose()
        } else {
            g.state
                .canonical_block_metadata(number)?
                .map(|block| block_metadata_to_dto(&g.state, block))
                .transpose()
        }
    }

    fn get_block_by_hash(
        &self,
        hash: B256,
        full_transactions: bool,
    ) -> Result<Option<BlockDto>, StateError> {
        let g = self.read_canonical()?;
        if full_transactions {
            let Some(number) = g.state.canonical_block_number(hash)? else {
                return Ok(None);
            };
            g.state
                .canonical_block(number)?
                .map(|block| block_to_dto(&g.state, block, true))
                .transpose()
        } else {
            g.state
                .canonical_block_metadata_by_hash(hash)?
                .map(|block| block_metadata_to_dto(&g.state, block))
                .transpose()
        }
    }

    fn get_blocks(
        &self,
        from: u64,
        to: u64,
        full_transactions: bool,
    ) -> Result<Vec<BlockDto>, StateError> {
        let g = self.read_canonical()?;
        let Some(tip) = g.state.canonical_tip_summary()? else {
            return Ok(Vec::new());
        };
        (from..=to.min(tip.number))
            .take(MAX_BLOCKS_PER_QUERY)
            .map(|number| {
                if full_transactions {
                    g.state
                        .canonical_block(number)?
                        .map(|block| block_to_dto(&g.state, block, true))
                        .ok_or(StateError::MissingCanonicalBoundary(number))?
                } else {
                    g.state
                        .canonical_block_metadata(number)?
                        .map(|block| block_metadata_to_dto(&g.state, block))
                        .ok_or(StateError::MissingCanonicalBoundary(number))?
                }
            })
            .collect()
    }

    fn are_nullifiers_spent(&self, nullifiers: &[B256]) -> Result<Vec<bool>, StateError> {
        let g = self.read_canonical()?;
        handlers::are_nullifiers_spent(&g.state, nullifiers)
    }

    fn get_nullifier_proofs(
        &self,
        nullifiers: &[B256],
    ) -> Result<Option<NullifierProofsDto>, StateError> {
        let g = self.read_canonical()?;
        handlers::get_nullifier_proofs(&g.state, nullifiers)
    }

    // ---- derived-index reads ----
    fn get_receipt(&self, query: ReceiptQuery) -> Result<Vec<ReceiptDto>, IndexReadError> {
        let g = self.read_node()?;
        g.ready_index_cursor()?;
        let map_row = |row: Option<ReceiptRecord>| {
            row.as_ref()
                .map(ReceiptRecord::to_dto)
                .into_iter()
                .collect()
        };
        let unavailable =
            |error: pcash_state::StateError| IndexReadError::Unavailable(error.to_string());
        match query {
            ReceiptQuery::TxId(id) => g
                .index
                .receipt_by_txid(&id)
                .map_err(unavailable)
                .map(map_row),
            ReceiptQuery::Content(query) => {
                let rows = g
                    .index
                    .receipts_for_settlement(query.content_hash, 100)
                    .map_err(unavailable)?;
                Ok(rows.iter().map(ReceiptRecord::to_dto).collect())
            }
            ReceiptQuery::Inclusion(ReceiptInclusionQuery { inclusion_id }) => g
                .index
                .receipt_by_txid(&pcash_state::transaction_id(
                    inclusion_id.l1_block_hash,
                    inclusion_id.l1_transaction_index,
                    inclusion_id.batch_item_index,
                ))
                .map_err(unavailable)
                .map(map_row),
            ReceiptQuery::Nullifier(ReceiptNullifierQuery { nullifier }) => g
                .index
                .receipt_by_nullifier(&nullifier)
                .map_err(unavailable)
                .map(map_row),
            ReceiptQuery::Account(ReceiptAccountQuery {
                address,
                account_revision,
            }) => g
                .index
                .receipt_by_account(&address, account_revision)
                .map_err(unavailable)
                .map(map_row),
        }
    }

    fn get_transactions(
        &self,
        query: TransactionsQuery,
    ) -> Result<TransactionPageDto, IndexReadError> {
        let g = self.read_node()?;
        let head = explorer_head(&g, query.cursor)?;
        let limit = query.limit.unwrap_or(25).clamp(1, 100) as usize;
        let requested_block = query.block_number;
        if requested_block.is_some_and(|number| number > head.block_number) {
            return Ok(TransactionPageDto {
                items: Vec::new(),
                next_cursor: None,
                head,
            });
        }
        if let (Some(cursor), Some(number)) = (query.cursor, requested_block) {
            if cursor.block_number != number {
                return Err(IndexReadError::Invalid(
                    "cursor does not belong to the requested block".into(),
                ));
            }
        }

        let kind = query.kind.and_then(transaction_kind_index);
        if query.kind.is_some() && kind.is_none() {
            return Ok(TransactionPageDto {
                items: Vec::new(),
                next_cursor: None,
                head,
            });
        }
        if let Some(cursor) = query.cursor {
            let receipt = g
                .index
                .receipt_by_block_ordinal(cursor.block_number, cursor.pcash_transaction_index)
                .map_err(|error| IndexReadError::Unavailable(error.to_string()))?
                .ok_or(IndexReadError::CursorMismatch)?;
            if kind.is_some_and(|expected| receipt.kind != expected) {
                return Err(IndexReadError::CursorMismatch);
            }
        }
        let before = query
            .cursor
            .map(|cursor| (cursor.block_number, cursor.pcash_transaction_index));
        let rows = g
            .index
            .receipts_by_block_ordinal(requested_block, kind, before, limit + 1)
            .map_err(|error| IndexReadError::Unavailable(error.to_string()))?;
        let mut items = rows
            .iter()
            .map(|(block_number, pcash_transaction_index, receipt)| {
                receipt_transaction_summary(
                    &g.state,
                    *block_number,
                    *pcash_transaction_index,
                    receipt,
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = items.len() > limit;
        if has_more {
            items.pop();
        }
        let next_cursor = has_more.then(|| {
            let last = items
                .last()
                .expect("a page with a continuation contains its requested limit");
            ExplorerCursorDto {
                head,
                block_number: last.block.block_number,
                pcash_transaction_index: last.pcash_transaction_index,
            }
        });
        Ok(TransactionPageDto {
            items,
            next_cursor,
            head,
        })
    }

    fn get_transaction(&self, tx_id: B256) -> Result<Option<TransactionDto>, IndexReadError> {
        let g = self.read_node()?;
        g.ready_index_cursor()?;
        let receipt = g
            .index
            .receipt_by_txid(&tx_id)
            .map_err(|error| IndexReadError::Unavailable(error.to_string()))?;
        let Some(receipt) = receipt else {
            return Ok(None);
        };
        let source = g.state.derivation_source()?;
        let block_number = receipt
            .l1_block_number
            .checked_sub(source.genesis_l1_block)
            .ok_or_else(|| {
                IndexReadError::Unavailable(
                    "accepted transaction predates the canonical PCASH genesis".into(),
                )
            })?;
        let pcash_transaction_index = receipt.pcash_transaction_index;
        let transaction = g
            .state
            .canonical_transaction_body(block_number, pcash_transaction_index)
            .map_err(|error| IndexReadError::Unavailable(error.to_string()))?
            .ok_or_else(|| {
                IndexReadError::Unavailable("canonical transaction body is missing".into())
            })?;
        let summary =
            receipt_transaction_summary(&g.state, block_number, pcash_transaction_index, &receipt)?;
        Ok(Some(TransactionDto {
            summary,
            raw_transaction: transaction.into(),
        }))
    }

    fn get_submission(&self, query: SubmissionQuery) -> Result<TransactionPageDto, IndexReadError> {
        let g = self.read_node()?;
        let limit = query.limit.unwrap_or(25).clamp(1, 100) as usize;
        indexed_receipt_page(
            &g,
            query.cursor,
            limit,
            |receipt| receipt.content_hash == query.content_hash,
            |before, fetch| {
                g.index
                    .receipts_by_content(query.content_hash, before, fetch)
            },
        )
    }

    fn get_account_history(
        &self,
        query: AccountHistoryQuery,
    ) -> Result<TransactionPageDto, IndexReadError> {
        let g = self.read_node()?;
        let limit = query.limit.unwrap_or(25).clamp(1, 100) as usize;
        indexed_receipt_page(
            &g,
            query.cursor,
            limit,
            |receipt| receipt.lifecycle_address == Some(query.address),
            |before, fetch| {
                g.index
                    .receipts_by_lifecycle_address(query.address, before, fetch)
            },
        )
    }

    fn get_transaction_by_nullifier(
        &self,
        nullifier: B256,
    ) -> Result<Option<TransactionDto>, IndexReadError> {
        let tx_id = {
            let g = self.read_node()?;
            g.ready_index_cursor()?;
            g.index
                .receipt_by_nullifier(&nullifier)
                .map_err(|error| IndexReadError::Unavailable(error.to_string()))?
                .map(|receipt| receipt.tx_id)
        };
        match tx_id {
            Some(tx_id) => self.get_transaction(tx_id),
            None => Ok(None),
        }
    }

    fn get_l1_delivery_batches(
        &self,
        request: pcash_rpc::L1DeliveryBatchesRequest,
    ) -> Result<pcash_rpc::L1DeliveryBatchPageDto, IndexReadError> {
        let g = self.read_canonical()?;
        crate::canonical_feeds::get_l1_delivery_batches(&g.state, request)
    }

    fn get_block_payouts(
        &self,
        requested: BlockId,
    ) -> Result<Option<BlockPayoutsDto>, IndexReadError> {
        let g = self.read_canonical()?;
        let canonical = g
            .state
            .canonical_stored_block(requested.block_number)
            .map_err(|error| IndexReadError::Unavailable(error.to_string()))?;
        let Some(canonical) = canonical else {
            return Ok(None);
        };
        if canonical.hash != requested.block_hash {
            return Err(IndexReadError::CursorMismatch);
        }
        let row = g
            .state
            .block_economics(requested.block_number)
            .map_err(|error| IndexReadError::Unavailable(error.to_string()))?
            .ok_or_else(|| IndexReadError::Unavailable("block economics row is missing".into()))?;
        let payouts = pcash_state::StateRead::payout_records(&g.state, requested.block_number)?
            .unwrap_or_default()
            .into_iter()
            .map(Into::into)
            .collect();
        Ok(Some(BlockPayoutsDto {
            block: requested,
            open_fees_total: row.open_fees_total,
            issuance_total: row.issuance_total,
            payouts,
        }))
    }

    fn get_payouts(
        &self,
        query: pcash_rpc::PayoutQuery,
    ) -> Result<pcash_rpc::dto::PayoutPageDto, IndexReadError> {
        let g = self.read_canonical()?;
        handlers::get_payouts(&g.state, query)
    }

    fn get_block_economics(
        &self,
        query: pcash_rpc::BlockEconomicsQuery,
    ) -> Result<pcash_rpc::dto::BlockEconomicsPageDto, IndexReadError> {
        let g = self.read_node()?;
        let cursor = g.ready_index_cursor()?;
        block_economics_page(&g.index, cursor, query)
    }

    fn get_issuance_quote(
        &self,
        candidate_timestamp: u64,
    ) -> Result<Option<pcash_rpc::dto::IssuanceQuoteDto>, pcash_rpc::IssuanceQuoteError> {
        let g = self.read_canonical()?;
        handlers::get_issuance_quote(&g.state, candidate_timestamp)
    }

    fn estimate_fee(&self, byte_size: u64) -> Result<FeeEstimateDto, IndexReadError> {
        let g = self.read_node()?;
        let ready = g.ready_index_cursor()?;
        let head = BlockId {
            block_number: ready.pcash_number,
            block_hash: ready.pcash_hash,
        };
        let window_start = ready
            .pcash_number
            .saturating_sub(fee_estimate::WINDOW_BLOCKS - 1);
        let window_blocks = ready.pcash_number - window_start + 1;
        let unavailable = |error: StateError| IndexReadError::Unavailable(error.to_string());
        let included: Vec<FeeSample> = g
            .index
            .open_fee_receipts(
                window_start,
                ready.pcash_number,
                fee_estimate::MAX_INCLUSION_SAMPLES,
            )
            .map_err(unavailable)?
            .into_iter()
            .map(|receipt| FeeSample {
                fee: receipt.settled_open_fee_amount,
                bytes: receipt.byte_size,
            })
            .collect();
        let pending: Vec<FeeSample> = self
            .mempool
            .as_ref()
            .map(|mempool| mempool.ready_fee_samples())
            .unwrap_or_default()
            .into_iter()
            .map(|(fee, bytes)| FeeSample { fee, bytes })
            .collect();
        let estimate = fee_estimate::estimate(
            &FeeEstimateInputs {
                included: &included,
                pending: &pending,
            },
            byte_size,
        );
        Ok(FeeEstimateDto {
            head,
            window_blocks,
            byte_size: estimate.byte_size,
            tiers: estimate.tiers,
            basis: estimate.basis,
        })
    }

    fn get_contracts(&self, query: ContractsQuery) -> Result<ContractPageDto, IndexReadError> {
        let g = self.read_node()?;
        let head = explorer_head(&g, query.cursor)?;
        let limit = query.limit.unwrap_or(25).clamp(1, 100) as usize;
        let verified_only = query.verified_only == Some(true);
        if verified_only && self.source_verification.is_none() {
            return Err(IndexReadError::Unavailable(
                "source verification is disabled".into(),
            ));
        }
        let cursor = query
            .cursor
            .map(|cursor| (cursor.block_number, cursor.pcash_transaction_index));
        if let Some((block_number, pcash_transaction_index)) = cursor {
            let indexed = if verified_only {
                g.index
                    .verified_contract_at(block_number, pcash_transaction_index)
                    .map_err(|error| IndexReadError::Unavailable(error.to_string()))?
                    .is_some()
            } else {
                g.index
                    .contract_material_at(block_number, pcash_transaction_index)
                    .map_err(|error| IndexReadError::Unavailable(error.to_string()))?
                    .is_some()
            };
            if !indexed {
                return Err(IndexReadError::CursorMismatch);
            }
        }
        let creations = if verified_only {
            g.index
                .verified_contract_page(head.block_number, cursor, limit + 1)
        } else {
            g.index
                .contract_material_page(head.block_number, cursor, limit + 1)
        }
        .map_err(|error| IndexReadError::Unavailable(error.to_string()))?;
        let mut items = Vec::with_capacity(creations.len());
        for material in creations {
            let functions = contract_function_dtos(&material.functions);
            let (source_verification, configuration_opening_count) = match g
                .index
                .contract_source_info(material.address)
                .map_err(|error| IndexReadError::Unavailable(error.to_string()))?
            {
                Some(info) => (
                    Some(if info.verified {
                        ContractVerificationStatusDto::Verified
                    } else {
                        ContractVerificationStatusDto::NotVerified
                    }),
                    Some(info.opening_count),
                ),
                None => (None, None),
            };
            items.push(ContractSummaryDto {
                address: material.address,
                block: BlockId {
                    block_number: material.pcash_block_number,
                    block_hash: material.pcash_block_hash,
                },
                pcash_transaction_index: material.pcash_transaction_index,
                timestamp: material.timestamp,
                transaction_id: material.transaction_id,
                origin: contract_origin(&material),
                functions,
                source_verification,
                configuration_opening_count,
            });
        }
        let has_more = items.len() > limit;
        if has_more {
            items.pop();
        }
        let next_cursor = has_more.then(|| {
            let last = items
                .last()
                .expect("a page with a continuation contains its requested limit");
            ExplorerCursorDto {
                head,
                block_number: last.block.block_number,
                pcash_transaction_index: last.pcash_transaction_index,
            }
        });
        Ok(ContractPageDto {
            items,
            next_cursor,
            head,
        })
    }

    fn get_outputs(&self, request: OutputRequest) -> Result<OutputPageDto, IndexReadError> {
        let g = self.read_node()?;
        g.ready_index_cursor()?;
        crate::outputs_rpc::get_outputs(&g.state, &g.index, request)
    }

    fn get_output_frontier(
        &self,
        block: BlockId,
    ) -> Result<pcash_rpc::dto::OutputFrontierDto, IndexReadError> {
        let g = self.read_canonical()?;
        crate::canonical_feeds::get_output_frontier(&g.state, block)
    }

    fn get_account_changes(
        &self,
        request: pcash_rpc::AccountChangesRequest,
    ) -> Result<pcash_rpc::dto::AccountChangePageDto, IndexReadError> {
        let g = self.read_canonical()?;
        crate::canonical_feeds::get_account_changes(&g.state, request)
    }

    // ---- mempool admission and relay preparation ----
    async fn submit_raw_transaction(
        &self,
        raw: Vec<u8>,
    ) -> Result<MempoolTransactionDto, MempoolApiError> {
        let mempool = self.mempool.clone().ok_or(MempoolApiError::Unavailable)?;
        let p2p = self.p2p.clone();
        // Admission and its announcement finish even if the RPC client disconnects.
        tokio::spawn(async move {
            let admitted = mempool.submit(raw.clone()).await?;
            if admitted.status == crate::MempoolStatus::Ready {
                if let Some(p2p) = p2p {
                    if let Err(error) = p2p.try_announce(raw) {
                        tracing::warn!(%error, "admitted RPC transaction was not queued for P2P announcement");
                    }
                }
            }
            Ok(admitted.transaction)
        })
        .await
        .map_err(|error| MempoolApiError::Verification(format!("admission task failed: {error}")))?
    }

    async fn check_raw_transaction(
        &self,
        request: CheckRawTransactionRequest,
    ) -> Result<TransactionCheckDto, MempoolApiError> {
        self.mempool
            .clone()
            .ok_or(MempoolApiError::Unavailable)?
            .check(request)
            .await
    }

    fn get_mempool(&self, filter: MempoolFilter) -> Result<MempoolPageDto, MempoolApiError> {
        let mut page = self
            .mempool
            .as_ref()
            .ok_or(MempoolApiError::Unavailable)?
            .list(filter)?;
        page.peer_count = self.p2p.as_ref().map(|p2p| p2p.peer_count() as u64);
        Ok(page)
    }

    fn get_mempool_transaction(
        &self,
        content_hash: &B256,
    ) -> Result<Option<MempoolTransactionDto>, MempoolApiError> {
        self.mempool
            .as_ref()
            .ok_or(MempoolApiError::Unavailable)?
            .transaction(content_hash)
    }

    fn prepare_relay(
        &self,
        request: PrepareRelayRequest,
    ) -> Result<PreparedRelayDto, MempoolApiError> {
        self.mempool
            .as_ref()
            .ok_or(MempoolApiError::Unavailable)?
            .prepare(request)
    }

    // ---- optional publication catalog ----
    fn catalog_info(&self) -> CatalogInfo {
        match &self.catalog {
            Some(catalog) => catalog.info(),
            None => CatalogInfo::disabled(self.chain_id_snapshot()),
        }
    }

    fn catalog_get(
        &self,
        request: CatalogGetRequest,
    ) -> Result<Option<CatalogRecord>, CatalogApiError> {
        self.catalog
            .as_ref()
            .ok_or(CatalogApiError::Unavailable)?
            .get(&request)
    }

    fn catalog_list(&self, request: CatalogListRequest) -> Result<CatalogPage, CatalogApiError> {
        self.catalog
            .as_ref()
            .ok_or(CatalogApiError::Unavailable)?
            .list(&request)
    }

    fn catalog_publish(&self, artifact: CatalogArtifact) -> Result<CatalogRecord, CatalogApiError> {
        self.catalog
            .as_ref()
            .ok_or(CatalogApiError::Unavailable)?
            .publish(&artifact)
    }
}

#[cfg(test)]
#[path = "read_isolation_tests.rs"]
mod read_isolation_tests;
