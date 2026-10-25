use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex, RwLock, RwLockReadGuard};
use std::time::Instant;

use alloy_primitives::{B256, U256};
use pcash_derive::Batch;
#[cfg(test)]
use pcash_derive::BatchVersion;
use pcash_derive::{
    admit, validate_transactions, AdmittedTransaction, CarrierContext, DeriveError, ProofStatement,
    ProtocolRules, Transaction, MAX_BATCH_ENTRIES,
};
use pcash_metrics::{AdmissionOutcome, AdmissionSource, Metrics};
use pcash_rpc::{
    BlockId, CarrierContextRequest, CheckOutcomeDto, CheckRawTransactionRequest, MempoolApiError,
    MempoolFilter, MempoolPageDto, MempoolRejectionDto, MempoolTransactionDto, PrepareRelayRequest,
    PreparedRelayDto, TransactionCheckDto,
};
use pcash_state::{
    content_hash, AcceptedEffects, AccountResult, DerivationSource, ItemExclusionReason,
    RedbStateReader, StateDb, TransactionOutcome,
};
use pcash_verify::{BbProcessVerifier, Verifier, VerifyError};
use tokio::sync::oneshot;

use crate::node::NodeInner;

use super::admission::{AdmissionPool, Job, PeerSlot};
use super::store::{
    admission_fee, admit_at_timestamp, decode_error, descriptor_admitted, is_unpaid, now_unix_ms,
    refuse_carrier_bound, requires_unpaid_registration_opt_in, unpaid_expired,
    unpaid_registration_disabled, CachedEntry, ConflictKey, InsertResult, MempoolLimits,
    MempoolStatus, MempoolStore, StoredEntry,
};

pub(super) struct AlreadyVerified;

impl Verifier for AlreadyVerified {
    fn verify(
        &self,
        _vk: &[u8],
        _proof: &[u8],
        _public_inputs: &[u8],
    ) -> Result<bool, VerifyError> {
        Ok(true)
    }
}

/// One admitted transaction's outcome against the current derived head,
/// whose L1 timestamp is `timestamp`, as an item of `carrier`, without
/// committing it; `None` when its type is not active there. Admission at an
/// earlier head does not carry across a fork boundary.
///
/// A mempool entry executes with no carrier: the pool refuses every
/// transaction that names a carrier context and every direct-mode creation,
/// so no entry reads one.
fn check_at_head(
    guard: &NodeInner,
    timestamp: u64,
    transaction: &AdmittedTransaction,
    carrier: Option<CarrierContext>,
) -> Result<Option<TransactionOutcome>, MempoolApiError> {
    if !guard
        .rules
        .transaction_type_allowed_at(transaction.kind(), timestamp)
    {
        return Ok(None);
    }
    let mut outcomes = validation_outcome(validate_transactions(
        &guard.state,
        &guard.rules,
        &AlreadyVerified,
        timestamp,
        carrier,
        &[transaction],
    ))?;
    Ok(Some(outcomes.remove(0)))
}

pub(crate) fn validation_outcome(
    result: Result<Vec<TransactionOutcome>, DeriveError>,
) -> Result<Vec<TransactionOutcome>, MempoolApiError> {
    result.map_err(|error| MempoolApiError::Storage(error.to_string()))
}

pub(super) fn validate_against_guard(
    guard: &NodeInner,
    transaction: &AdmittedTransaction,
) -> Result<BlockId, MempoolApiError> {
    match check_at_head(guard, guard.state.last_l1_timestamp(), transaction, None)? {
        Some(TransactionOutcome::Succeeded) => Ok(guard.head_id()),
        Some(outcome) => Err(MempoolApiError::State(format!("{outcome:?}"))),
        None => Err(MempoolApiError::State(
            "transaction type is not active at the current derived head".to_owned(),
        )),
    }
}

/// RPC response and typed status captured by the same locked projection.
#[derive(Debug)]
pub struct RpcAdmission {
    pub transaction: MempoolTransactionDto,
    pub status: MempoolStatus,
}

fn rpc_projection(entry: &StoredEntry, store: &MempoolStore) -> RpcAdmission {
    RpcAdmission {
        transaction: entry.to_dto(false, store.conflict_count(entry)),
        status: entry.status,
    }
}

fn peer_projection(entry: &StoredEntry, _store: &MempoolStore) -> MempoolStatus {
    entry.status
}

/// Local admission, storage, listing, and relay-batch preparation.
pub struct MempoolService {
    pub(super) inner: Arc<Mutex<NodeInner>>,
    pub(super) source: DerivationSource,
    pub(super) state_reader: RedbStateReader,
    pub(super) store: Mutex<MempoolStore>,
    /// RPC and P2P may observe the pool only while its durable lifecycle rows
    /// are reconciled with canonical state. Startup can deliberately wait for a
    /// previously-derived unfinalized suffix to replay; a later lifecycle write
    /// failure moves the service to `Unavailable` until a full reconciliation
    /// succeeds.
    pub(super) lifecycle: RwLock<LifecycleState>,
    /// RPC and peer admissions wait here for the mempool's own verifier workers.
    pub(super) admission: AdmissionPool,
    pub(super) metrics: Arc<dyn Metrics>,
    pub(super) unpaid_budget: Mutex<(Instant, u32)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum LifecycleState {
    Ready,
    AwaitingReplay { through: u64 },
    Unavailable,
}

impl MempoolService {
    pub fn fork_capability(&self) -> pcash_p2p::ForkCapability {
        self.inner.lock().unwrap().fork_capability()
    }

    /// Committed canonical snapshots for P2P, read without the derivation lock.
    pub(crate) fn state_reader(&self) -> pcash_state::RedbStateReader {
        self.state_reader.clone()
    }

    pub fn open(
        inner: Arc<Mutex<NodeInner>>,
        path: impl AsRef<Path>,
        admission: AdmissionPool,
        limits: MempoolLimits,
    ) -> Result<Arc<Self>, MempoolApiError> {
        Self::open_with_metrics(inner, path, admission, limits, pcash_metrics::noop())
    }

    pub fn open_with_metrics(
        inner: Arc<Mutex<NodeInner>>,
        path: impl AsRef<Path>,
        admission: AdmissionPool,
        limits: MempoolLimits,
        metrics: Arc<dyn Metrics>,
    ) -> Result<Arc<Self>, MempoolApiError> {
        let (chain_id, genesis_hash) = {
            let guard = inner.lock().unwrap();
            let genesis_hash = guard.state.canonical_genesis_hash().ok_or_else(|| {
                MempoolApiError::Storage(
                    "canonical block zero must be derived before opening the mempool".to_owned(),
                )
            })?;
            (guard.source.pcash_chain_id, genesis_hash)
        };
        let store = MempoolStore::open(path, chain_id, genesis_hash, limits)?;
        Self::from_store(inner, store, admission, metrics)
    }

    pub fn open_in_memory_with_metrics(
        inner: Arc<Mutex<NodeInner>>,
        admission: AdmissionPool,
        limits: MempoolLimits,
        metrics: Arc<dyn Metrics>,
    ) -> Result<Arc<Self>, MempoolApiError> {
        let (chain_id, genesis_hash) = {
            let guard = inner.lock().unwrap();
            let genesis_hash = guard.state.canonical_genesis_hash().ok_or_else(|| {
                MempoolApiError::Storage(
                    "canonical block zero must be derived before opening the mempool".to_owned(),
                )
            })?;
            (guard.source.pcash_chain_id, genesis_hash)
        };
        let store = MempoolStore::open_in_memory(chain_id, genesis_hash, limits)?;
        Self::from_store(inner, store, admission, metrics)
    }

    fn from_store(
        inner: Arc<Mutex<NodeInner>>,
        store: MempoolStore,
        admission: AdmissionPool,
        metrics: Arc<dyn Metrics>,
    ) -> Result<Arc<Self>, MempoolApiError> {
        let replay_through = store
            .entries
            .values()
            .map(|entry| {
                entry
                    .validated_block
                    .block_number
                    .max(entry.included_block.map_or(0, |block| block.block_number))
                    .max(entry.superseded_block.map_or(0, |block| block.block_number))
                    .max(
                        entry
                            .invalidated_block
                            .map_or(0, |block| block.block_number),
                    )
            })
            .max();
        let (current_head, state_reader, source) = {
            let guard = inner.lock().unwrap();
            (
                guard.head_id().block_number,
                guard.state.reader(),
                guard.source,
            )
        };
        let lifecycle = replay_through
            .filter(|through| *through > current_head)
            .map_or(LifecycleState::Ready, |through| {
                LifecycleState::AwaitingReplay { through }
            });
        let service = Arc::new(Self {
            inner,
            source,
            state_reader,
            store: Mutex::new(store),
            lifecycle: RwLock::new(lifecycle),
            admission,
            metrics,
            unpaid_budget: Mutex::new((Instant::now(), 0)),
        });
        service
            .metrics
            .set_mempool_ready(lifecycle == LifecycleState::Ready);
        if lifecycle == LifecycleState::Ready {
            service.reconcile_current()?;
        }
        service.publish_occupancy();
        Ok(service)
    }

    /// Close the crash window between canonical state commit and the separate
    /// mempool lifecycle write. Startup calls this immediately when state is at
    /// least as new as every persisted entry; otherwise the service stays
    /// unavailable and calls it after the unfinalized suffix has replayed.
    pub(super) fn reconcile_current(&self) -> Result<(), MempoolApiError> {
        let guard = self.inner.lock().unwrap();
        let head = guard.head_id();
        let timestamp = guard.state.last_l1_timestamp();
        let finalized = guard.finalized_block();
        // Receipts live only in the derived index, so look up each mempool entry's
        // accepted receipt on demand (the mempool is bounded, so this is a bounded
        // number of point reads at reconcile time).
        let now = now_unix_ms();
        let mut store = self.store.lock().unwrap();
        let mut replacements = Vec::with_capacity(store.entries.len());
        let mut removals = Vec::new();
        for entry in store.entries.values() {
            if unpaid_expired(entry, now) {
                removals.push(entry.content_hash);
                continue;
            }
            if let Some(receipt) = guard
                .index
                .succeeded_receipt_by_content(entry.content_hash)
                .map_err(|error| MempoolApiError::Storage(error.to_string()))?
            {
                let block_number = receipt
                    .l1_block_number
                    .checked_sub(guard.source.genesis_l1_block)
                    .ok_or_else(|| {
                        MempoolApiError::Storage(
                            "accepted receipt precedes PCASH genesis origin".to_owned(),
                        )
                    })?;
                let canonical = guard
                    .state
                    .canonical_stored_block(block_number)
                    .map_err(|error| MempoolApiError::Storage(error.to_string()))?
                    .ok_or_else(|| {
                        MempoolApiError::Storage(
                            "accepted receipt is missing its canonical PCASH block".to_owned(),
                        )
                    })?;
                if canonical.l1_origin.block_hash != receipt.l1_block_hash {
                    return Err(MempoolApiError::Storage(
                        "accepted receipt L1 origin is not canonical".to_owned(),
                    ));
                }
                if block_number <= finalized {
                    removals.push(entry.content_hash);
                    continue;
                }
                let mut updated = entry.clone();
                updated.status = MempoolStatus::IncludedUnfinalized;
                updated.included_block = Some(BlockId {
                    block_number,
                    block_hash: canonical.hash,
                });
                updated.superseded_block = None;
                updated.invalidated_block = None;
                updated.validated_block = head;
                if updated != *entry {
                    replacements.push(updated);
                }
                continue;
            }

            let mut updated = entry.clone();
            // Exact accepted receipts determine inclusion. A marker
            // without one belongs to a state suffix not present after resume.
            updated.included_block = None;
            // A marker at or below finality is permanent, so the entry goes.
            // Above finality it survives only while it still names a canonical
            // block; otherwise it belonged to a replaced suffix and is cleared.
            let marker_is_canonical = |block: BlockId| {
                block.block_number <= head.block_number
                    && guard
                        .state
                        .canonical_stored_block(block.block_number)
                        .ok()
                        .flatten()
                        .is_some_and(|canonical| canonical.hash == block.block_hash)
            };
            if [updated.superseded_block, updated.invalidated_block]
                .into_iter()
                .flatten()
                .any(|block| block.block_number <= finalized)
            {
                removals.push(entry.content_hash);
                continue;
            }
            for marker in [
                &mut updated.superseded_block,
                &mut updated.invalidated_block,
            ] {
                if marker.is_some_and(|block| !marker_is_canonical(block)) {
                    *marker = None;
                }
            }
            if updated.superseded_block.is_some() || updated.invalidated_block.is_some() {
                updated.status = MempoolStatus::Suspended;
            } else {
                let evaluation = evaluate_against_state(&guard, timestamp, entry.prepared.get())?;
                updated.status = evaluation.status();
                // A transient suspension is re-evaluated on every applied
                // block. Marking it would strand the entry: after a reorg that
                // regresses the head below `notBeforeTimestamp`, the marker
                // stays canonical as the replacement chain advances past it,
                // so the entry would never be reconsidered.
                if evaluation == StateEvaluation::Suspended(Suspension::Monotonic) {
                    if head.block_number <= finalized {
                        removals.push(entry.content_hash);
                        continue;
                    }
                    updated.invalidated_block = Some(head);
                }
            }
            updated.validated_block = head;
            if updated != *entry {
                replacements.push(updated);
            }
        }
        store.apply_changes(replacements, removals)
    }

    pub(super) fn require_available(
        &self,
    ) -> Result<RwLockReadGuard<'_, LifecycleState>, MempoolApiError> {
        let lifecycle = self.lifecycle.read().unwrap();
        if *lifecycle != LifecycleState::Ready {
            return Err(MempoolApiError::Unavailable);
        }
        Ok(lifecycle)
    }

    /// Prepare one canonical lifecycle update while excluding RPC and P2P
    /// readers. `false` means the update is already covered by a successful
    /// full reconciliation, or is intentionally deferred until startup replay
    /// reaches the persisted validation height.
    pub(super) fn prepare_lifecycle(
        &self,
        lifecycle: &mut LifecycleState,
    ) -> Result<bool, MempoolApiError> {
        match *lifecycle {
            LifecycleState::Ready => Ok(true),
            LifecycleState::AwaitingReplay { through } => {
                if self.inner.lock().unwrap().head_id().block_number < through {
                    return Ok(false);
                }
                match self.reconcile_current() {
                    Ok(()) => {
                        *lifecycle = LifecycleState::Ready;
                        self.publish_lifecycle(*lifecycle);
                        Ok(false)
                    }
                    Err(error) => {
                        *lifecycle = LifecycleState::Unavailable;
                        self.publish_lifecycle(*lifecycle);
                        Err(error)
                    }
                }
            }
            LifecycleState::Unavailable => match self.reconcile_current() {
                Ok(()) => {
                    *lifecycle = LifecycleState::Ready;
                    self.publish_lifecycle(*lifecycle);
                    Ok(false)
                }
                Err(error) => {
                    self.publish_lifecycle(LifecycleState::Unavailable);
                    Err(error)
                }
            },
        }
    }

    fn publish_occupancy(&self) {
        let occupancy = self.store.lock().unwrap().occupancy();
        self.metrics.set_mempool_occupancy(occupancy);
    }

    fn publish_lifecycle(&self, lifecycle: LifecycleState) {
        self.metrics
            .set_mempool_ready(lifecycle == LifecycleState::Ready);
    }

    fn admission_outcome(error: &MempoolApiError) -> AdmissionOutcome {
        match error {
            MempoolApiError::Unavailable => AdmissionOutcome::Unavailable,
            MempoolApiError::Invalid(_) => AdmissionOutcome::Invalid,
            MempoolApiError::State(_) => AdmissionOutcome::State,
            MempoolApiError::Policy(_) => AdmissionOutcome::Policy,
            MempoolApiError::Full => AdmissionOutcome::Full,
            MempoolApiError::Busy(_) => AdmissionOutcome::Busy,
            MempoolApiError::Verification(_) => AdmissionOutcome::Verification,
            MempoolApiError::Storage(_) => AdmissionOutcome::Storage,
        }
    }

    pub fn check_admission_policy(&self, raw: &[u8]) -> Result<(), MempoolApiError> {
        // Peer bytes cross the admission boundary; classify the entry by
        // shape without constructing statement hashes or doing
        // current-state/proof work.
        let transaction = Transaction::decode(raw, self.source.pcash_chain_id)
            .map_err(|error| decode_error(&error))?;
        refuse_carrier_bound(transaction.section())?;
        if requires_unpaid_registration_opt_in(raw)
            && !self.store.lock().unwrap().limits.accept_unpaid_registration
        {
            return Err(unpaid_registration_disabled());
        }
        Ok(())
    }

    /// Admit exact bytes from a local RPC client.
    pub async fn submit(self: &Arc<Self>, raw: Vec<u8>) -> Result<RpcAdmission, MempoolApiError> {
        self.admit_queued(raw, AdmissionSource::Rpc, rpc_projection)
            .await
    }

    /// Admit a candidate already bounded by the P2P budgets. Peers share the
    /// admission queue with RPC but may hold only part of it.
    pub async fn submit_from_peer(
        self: &Arc<Self>,
        raw: Vec<u8>,
    ) -> Result<MempoolStatus, MempoolApiError> {
        self.admit_queued(raw, AdmissionSource::P2p, peer_projection)
            .await
    }

    async fn admit_queued<T: Send + 'static>(
        self: &Arc<Self>,
        raw: Vec<u8>,
        source: AdmissionSource,
        project: fn(&StoredEntry, &MempoolStore) -> T,
    ) -> Result<T, MempoolApiError> {
        self.enqueue_projected(raw, source, project)?
            .await
            .map_err(|_| {
                MempoolApiError::Verification("mempool admission worker failed".to_owned())
            })?
    }

    /// Queue one admission for the next free verifier worker. A full queue, or
    /// a peer candidate beyond the peers' share of it, is refused at once.
    fn enqueue_projected<T: Send + 'static>(
        self: &Arc<Self>,
        raw: Vec<u8>,
        source: AdmissionSource,
        project: fn(&StoredEntry, &MempoolStore) -> T,
    ) -> Result<oneshot::Receiver<Result<T, MempoolApiError>>, MempoolApiError> {
        let peer_slot = match source {
            AdmissionSource::Rpc => None,
            AdmissionSource::P2p => Some(
                self.admission
                    .reserve_peer()
                    .ok_or_else(|| self.refuse_busy(source))?,
            ),
        };
        self.enqueue_work(peer_slot, move |service, verifier| {
            service.admit_and_record_projected(raw, source, verifier, project)
        })
        .ok_or_else(|| self.refuse_busy(source))
    }

    /// Queue `work` for the next free verifier worker, which holds
    /// `peer_slot` until `work` finishes; `None` means the queue is full and
    /// `work` was dropped unrun.
    fn enqueue_work<T: Send + 'static>(
        self: &Arc<Self>,
        peer_slot: Option<PeerSlot>,
        work: impl FnOnce(&Self, &BbProcessVerifier) -> Result<T, MempoolApiError> + Send + 'static,
    ) -> Option<oneshot::Receiver<Result<T, MempoolApiError>>> {
        let (reply, receiver) = oneshot::channel();
        let service = Arc::clone(self);
        let job: Job = Box::new(move |verifier| {
            service.publish_admission_queue_depth();
            let result = work(&service, verifier);
            // Release what this job holds before its caller can observe
            // completion: the caller may reopen the pool's database or queue
            // the next peer candidate.
            drop((service, peer_slot));
            let _ = reply.send(result);
        });
        if !self.admission.try_submit(job) {
            return None;
        }
        self.publish_admission_queue_depth();
        Some(receiver)
    }

    fn refuse_busy(&self, source: AdmissionSource) -> MempoolApiError {
        self.metrics
            .record_mempool_admission(source, AdmissionOutcome::Busy);
        queue_full()
    }

    /// Check exact bytes from a local RPC client as the next block would
    /// execute them from the query's carrier, without admitting or
    /// broadcasting them. The check waits in the admission queue and verifies
    /// on a mempool verifier worker, under an admission's budget.
    pub async fn check(
        self: &Arc<Self>,
        request: CheckRawTransactionRequest,
    ) -> Result<TransactionCheckDto, MempoolApiError> {
        self.enqueue_check(request)?.await.map_err(|_| {
            MempoolApiError::Verification("mempool admission worker failed".to_owned())
        })?
    }

    /// Queue one check for the next free verifier worker. A full queue
    /// refuses at once.
    pub(super) fn enqueue_check(
        self: &Arc<Self>,
        request: CheckRawTransactionRequest,
    ) -> Result<oneshot::Receiver<Result<TransactionCheckDto, MempoolApiError>>, MempoolApiError>
    {
        self.enqueue_work(None, move |service, verifier| {
            // The worker hashes the carrier context, outside the node lock.
            let carrier = match request.carrier {
                CarrierContextRequest::Inbox { address } => CarrierContext::inbox(address),
                CarrierContextRequest::Event { address, context } => {
                    CarrierContext::event(address, &context)
                }
            };
            service.check_with(&request.transaction, carrier, verifier)
        })
        .ok_or_else(queue_full)
    }

    /// Check `raw` as the next block would execute it from `carrier`:
    /// admission at the current head, the type's checks against that head,
    /// then proof verification with `verifier`. No relay policy applies, and
    /// nothing is stored or announced.
    pub(super) fn check_with(
        &self,
        raw: &[u8],
        carrier: CarrierContext,
        verifier: &dyn Verifier,
    ) -> Result<TransactionCheckDto, MempoolApiError> {
        let not_admitted = |reason| TransactionCheckDto {
            outcome: CheckOutcomeDto::NotAdmitted(reason),
        };
        let (rules, timestamp) = {
            let guard = self.inner.lock().unwrap();
            (Arc::clone(&guard.rules), guard.state.last_l1_timestamp())
        };
        let transaction = match admit(
            raw,
            &rules,
            self.source.pcash_chain_id,
            timestamp,
            carrier.kind(),
        ) {
            Ok(transaction) => transaction,
            Err(error) => return Ok(not_admitted(error.reason())),
        };
        let outcome = {
            let guard = self.inner.lock().unwrap();
            check_at_head(
                &guard,
                guard.state.last_l1_timestamp(),
                &transaction,
                Some(carrier),
            )?
        };
        // The head left the type's activation window after admission.
        let Some(mut outcome) = outcome else {
            return Ok(not_admitted(ItemExclusionReason::UnknownKind));
        };
        // Execution verifies the proof last, so only a transaction that
        // passes every other check reaches it.
        if outcome == TransactionOutcome::Succeeded {
            if let Some(statement) = ProofStatement::of(&rules, &transaction) {
                if !self.verify_proof(
                    verifier,
                    statement.vk,
                    statement.proof,
                    &statement.public_inputs,
                )? {
                    outcome = TransactionOutcome::ProofRejected;
                }
            }
        }
        Ok(TransactionCheckDto {
            outcome: CheckOutcomeDto::Executed(outcome),
        })
    }

    fn publish_admission_queue_depth(&self) {
        self.metrics
            .set_mempool_admission_queue_depth(self.admission.queued() as u64);
    }

    fn admit_and_record_projected<T>(
        &self,
        raw: Vec<u8>,
        source: AdmissionSource,
        verifier: &dyn Verifier,
        project: fn(&StoredEntry, &MempoolStore) -> T,
    ) -> Result<T, MempoolApiError> {
        match self.admit(raw, verifier, project) {
            Ok((result, duplicate)) => {
                self.metrics.record_mempool_admission(
                    source,
                    if duplicate {
                        AdmissionOutcome::Duplicate
                    } else {
                        AdmissionOutcome::Accepted
                    },
                );
                Ok(result)
            }
            Err(error) => {
                self.metrics
                    .record_mempool_admission(source, Self::admission_outcome(&error));
                Err(error)
            }
        }
    }

    fn admit<T>(
        &self,
        raw: Vec<u8>,
        verifier: &dyn Verifier,
        project: fn(&StoredEntry, &MempoolStore) -> T,
    ) -> Result<(T, bool), MempoolApiError> {
        let content_hash = content_hash(&raw);
        let (rules, admission_timestamp) = {
            let guard = self.inner.lock().unwrap();
            (Arc::clone(&guard.rules), guard.state.last_l1_timestamp())
        };
        let transaction = {
            let _available = self.require_available()?;
            let store = self.store.lock().unwrap();
            if let Some(existing) = store.get(&content_hash) {
                return Ok((project(existing, &store), true));
            }
            drop(store);
            let transaction = admit_at_timestamp(&raw, &rules, &self.source, admission_timestamp)?;
            let fee = admission_fee(&transaction)?;
            let unpaid = is_unpaid(raw[0], fee);
            {
                let mut store = self.store.lock().unwrap();
                store.purge_expired_unpaid(now_unix_ms())?;
                store.capacity_removals(&raw, fee)?;
            }
            if unpaid {
                // Anonymous RPC clients and peers share a bounded unpaid work budget.
                let mut budget = self.unpaid_budget.lock().unwrap();
                if budget.0.elapsed().as_secs() >= 1 {
                    *budget = (Instant::now(), 0);
                }
                if budget.1 >= 32 {
                    return Err(MempoolApiError::Busy(
                        "unpaid admission budget exhausted".to_owned(),
                    ));
                }
                budget.1 += 1;
            }
            transaction
        };

        let prepared = CachedEntry::new(transaction);
        {
            let _available = self.require_available()?;
            self.validate_current(prepared.get())?;
        }
        let description = descriptor_admitted(&raw, prepared.get(), &self.source)?;

        // Verify exact proof bytes without holding NodeInner.
        self.verify_candidate(verifier, prepared.get(), &rules)?;

        // The head may have advanced during proof verification. Re-run every
        // state-dependent rule and capture the exact head this admission used.
        // Reacquiring availability here keeps expensive proof verification from
        // blocking canonical lifecycle work while still forbidding a post-fault
        // insert.
        let _available = self.require_available()?;
        let guard = self.inner.lock().unwrap();
        let head_checked = validate_against_guard(&guard, prepared.get())?;
        let entry = StoredEntry {
            content_hash,
            metadata: description,
            raw,
            prepared,
            status: MempoolStatus::Ready,
            included_block: None,
            superseded_block: None,
            invalidated_block: None,
            validated_block: head_checked,
            received_at_unix_ms: now_unix_ms(),
        };
        let mut store = self.store.lock().unwrap();
        let insertion = store.insert(entry)?;
        let (duplicate, capacity_evictions) = match insertion {
            InsertResult::Duplicate => (true, 0),
            InsertResult::Inserted { capacity_evictions } => (false, capacity_evictions),
        };
        let entry = store
            .get(&content_hash)
            .expect("inserted or duplicate entry exists");
        let result = project(entry, &store);
        for _ in 0..capacity_evictions {
            self.metrics.record_mempool_eviction("capacity");
        }
        drop(store);
        if !duplicate {
            self.publish_occupancy();
        }
        Ok((result, duplicate))
    }

    #[cfg(test)]
    pub(super) fn enqueue(
        self: &Arc<Self>,
        raw: Vec<u8>,
        source: AdmissionSource,
    ) -> Result<oneshot::Receiver<Result<MempoolTransactionDto, MempoolApiError>>, MempoolApiError>
    {
        self.enqueue_projected(raw, source, |entry, store| {
            rpc_projection(entry, store).transaction
        })
    }

    #[cfg(test)]
    pub(super) fn admit_and_record(
        &self,
        raw: Vec<u8>,
        source: AdmissionSource,
        verifier: &dyn Verifier,
    ) -> Result<MempoolTransactionDto, MempoolApiError> {
        self.admit_and_record_projected(raw, source, verifier, |entry, store| {
            rpc_projection(entry, store).transaction
        })
    }

    fn verify_candidate(
        &self,
        verifier: &dyn Verifier,
        transaction: &AdmittedTransaction,
        rules: &ProtocolRules,
    ) -> Result<(), MempoolApiError> {
        // Execution at the head succeeded for this transaction, so it has no
        // statement only when it carries no proof.
        let Some(statement) = ProofStatement::of(rules, transaction) else {
            return Ok(());
        };
        if !self.verify_proof(
            verifier,
            statement.vk,
            statement.proof,
            &statement.public_inputs,
        )? {
            return Err(MempoolApiError::Invalid("proof rejected".to_owned()));
        }

        Ok(())
    }

    pub(super) fn verify_proof(
        &self,
        verifier: &dyn Verifier,
        vk: &[u8],
        proof: &[u8],
        public_inputs: &[u8],
    ) -> Result<bool, MempoolApiError> {
        let started = Instant::now();
        let result = verifier
            .verify(vk, proof, public_inputs)
            .map_err(|error| MempoolApiError::Verification(error.to_string()));
        self.metrics.record_mempool_verify(started.elapsed());
        result
    }

    pub(super) fn validate_current(
        &self,
        transaction: &AdmittedTransaction,
    ) -> Result<BlockId, MempoolApiError> {
        let guard = self.inner.lock().unwrap();
        validate_against_guard(&guard, transaction)
    }

    pub fn list(&self, filter: MempoolFilter) -> Result<MempoolPageDto, MempoolApiError> {
        let _available = self.require_available()?;
        let store = self.store.lock().unwrap();
        let (entries, next_cursor) = store.page(&filter)?;
        let items = entries
            .iter()
            .map(|entry| entry.to_dto(false, store.conflict_count(entry)))
            .collect();
        drop(store);
        let head = self
            .state_reader
            .snapshot()
            .and_then(|snapshot| snapshot.canonical_tip_summary())
            .map_err(|error| MempoolApiError::Storage(error.to_string()))?
            .ok_or_else(|| {
                MempoolApiError::Storage("canonical block zero is unavailable".into())
            })?;
        Ok(MempoolPageDto {
            items,
            next_cursor,
            head_checked_block: head.number,
            head_checked_block_hash: head.hash,
            peer_count: None,
        })
    }

    pub fn transaction(
        &self,
        content_hash: &B256,
    ) -> Result<Option<MempoolTransactionDto>, MempoolApiError> {
        let _available = self.require_available()?;
        let store = self.store.lock().unwrap();
        Ok(store.get(content_hash).map(|entry| {
            let conflicts = store.conflict_count(entry);
            entry.to_dto(true, conflicts)
        }))
    }

    /// Exact wire entries currently eligible for announcement or inventory
    /// sync. Included and suspended entries remain private until finalized or
    /// resurrected by rollback.
    pub fn ready_inventory(&self) -> Vec<(B256, Vec<u8>)> {
        let Ok(_available) = self.require_available() else {
            return Vec::new();
        };
        self.store
            .lock()
            .unwrap()
            .entries
            .values()
            .filter(|entry| entry.status == MempoolStatus::Ready)
            .map(|entry| (entry.content_hash, entry.raw.clone()))
            .collect()
    }

    /// Positive open-route fee and encoded size of every ready entry: the
    /// pending competition a fee estimate must clear. Zero-fee entries carry
    /// no fee signal.
    pub fn ready_fee_samples(&self) -> Vec<(U256, u64)> {
        let Ok(_available) = self.require_available() else {
            return Vec::new();
        };
        self.store
            .lock()
            .unwrap()
            .entries
            .values()
            .filter(|entry| {
                entry.status == MempoolStatus::Ready
                    && entry.metadata.has_publication_section
                    && entry.metadata.issuance_owner_commitment == B256::ZERO
                    && !entry.metadata.open_fee_amount.is_zero()
            })
            .map(|entry| (entry.metadata.open_fee_amount, entry.raw.len() as u64))
            .collect()
    }

    /// Run one lifecycle update under the write lock. A pool that is not
    /// serving skips the update; an update that fails takes the pool out of
    /// service and publishes that.
    fn with_lifecycle(
        &self,
        update: impl FnOnce(&Self) -> Result<(), MempoolApiError>,
    ) -> Result<(), MempoolApiError> {
        let mut lifecycle = self.lifecycle.write().unwrap();
        if !self.prepare_lifecycle(&mut lifecycle)? {
            return Ok(());
        }
        let result = update(self);
        if result.is_err() {
            *lifecycle = LifecycleState::Unavailable;
            self.publish_lifecycle(*lifecycle);
        }
        result
    }

    /// Apply committed successful content hashes and effects to the pool.
    /// Both inputs come from the same immutable canonical block. Direct L1 user
    /// creations contribute their content hash but no conflict effects: their pending
    /// alternatives are invalidated through ordinary state revalidation.
    pub fn on_applied_block(
        &self,
        block: BlockId,
        accepted_content_hashes: &[B256],
        accepted_effects: &[&AcceptedEffects],
    ) -> Result<(), MempoolApiError> {
        self.with_lifecycle(|this| {
            this.update_applied_block(block, accepted_content_hashes, accepted_effects)
        })
    }

    pub(super) fn update_applied_block(
        &self,
        block: BlockId,
        accepted_content_hashes: &[B256],
        accepted_effects: &[&AcceptedEffects],
    ) -> Result<(), MempoolApiError> {
        let accepted_content_hash_set = accepted_content_hashes
            .iter()
            .copied()
            .collect::<HashSet<_>>();
        let accepted_conflicts = accepted_effects
            .iter()
            .flat_map(|effects| {
                let account = match &effects.account {
                    Some(AccountResult::User { address, .. }) => {
                        Some(ConflictKey::Account(*address))
                    }
                    Some(AccountResult::Contract { address, .. }) => {
                        Some(ConflictKey::Contract(*address))
                    }
                    None => None,
                };
                effects
                    .nullifiers
                    .iter()
                    .copied()
                    .map(ConflictKey::Nullifier)
                    .chain(account)
            })
            .collect::<HashSet<_>>();

        let guard = self.inner.lock().unwrap();
        // The canonical state read occurs after the committed block handoff.
        // Bind it to that immutable identity before revalidating pending entries.
        if guard.head_id() != block {
            return Err(MempoolApiError::Invalid(
                "applied mempool block does not match the derived head".to_owned(),
            ));
        }

        let timestamp = guard.state.last_l1_timestamp();
        let mut store = self.store.lock().unwrap();
        let mut replacements = Vec::with_capacity(store.entries.len());
        let mut included = 0u64;
        let mut suspended = Vec::new();
        for entry in store.entries.values() {
            let mut updated = entry.clone();
            if accepted_content_hash_set.contains(&entry.content_hash) {
                if entry.status != MempoolStatus::IncludedUnfinalized {
                    included += 1;
                }
                updated.status = MempoolStatus::IncludedUnfinalized;
                updated.included_block = Some(block);
                updated.superseded_block = None;
                updated.invalidated_block = None;
                updated.validated_block = block;
            } else if entry.included_block.is_some() {
                // An earlier canonical inclusion stays retained through finality.
                continue;
            } else if entry.superseded_block.is_some() {
                // An earlier canonical winner still supersedes this variant.
                continue;
            } else if entry.invalidated_block.is_some() {
                // Ordinary state invalidation is also monotonic on one
                // canonical branch; retain the first marker through finality.
                continue;
            } else if entry
                .metadata
                .conflict_keys
                .iter()
                .any(|key| accepted_conflicts.contains(key))
            {
                updated.status = MempoolStatus::Suspended;
                updated.superseded_block = Some(block);
                updated.invalidated_block = None;
                updated.validated_block = block;
            } else {
                let evaluation = evaluate_against_state(&guard, timestamp, entry.prepared.get())?;
                updated.status = evaluation.status();
                if evaluation == StateEvaluation::Suspended(Suspension::Monotonic) {
                    updated.invalidated_block = Some(block);
                }
                updated.validated_block = block;
            }
            if updated != *entry {
                // Count a suspension only when it newly happens: a retained
                // transient suspension revalidates on every block and must
                // not inflate lifecycle accounting.
                let cause = if updated.superseded_block == Some(block) {
                    Some("superseded")
                } else if updated.invalidated_block == Some(block) {
                    Some("invalidated")
                } else if updated.status == MempoolStatus::Suspended
                    && entry.status != MempoolStatus::Suspended
                {
                    Some("state")
                } else {
                    None
                };
                if let Some(cause) = cause {
                    suspended.push(cause);
                }
                replacements.push(updated);
            }
        }
        store.apply_changes(replacements, Vec::new())?;
        drop(store);
        if included > 0 {
            self.metrics.record_mempool_included(included);
        }
        for cause in suspended {
            self.metrics.record_mempool_suspended(cause);
        }
        self.publish_occupancy();
        Ok(())
    }

    /// Purge only facts that cannot be reverted: canonical inclusions,
    /// supersessions, and ordinary state invalidations at or below finality,
    /// plus deadlines already passed by the finalized timestamp.
    pub fn on_finalized(
        &self,
        finalized_block: u64,
        finalized_timestamp: u64,
    ) -> Result<(), MempoolApiError> {
        self.with_lifecycle(|this| this.update_finalized(finalized_block, finalized_timestamp))
    }

    pub(super) fn update_finalized(
        &self,
        finalized_block: u64,
        finalized_timestamp: u64,
    ) -> Result<(), MempoolApiError> {
        let mut store = self.store.lock().unwrap();
        let now = now_unix_ms();
        let mut ttl = 0u64;
        let mut finalized = 0u64;
        let removals = store
            .entries
            .values()
            .filter(|entry| {
                let expired = unpaid_expired(entry, now)
                    || entry
                        .metadata
                        .valid_until_timestamp
                        .is_some_and(|deadline| deadline < finalized_timestamp);
                let done = entry
                    .included_block
                    .is_some_and(|block| block.block_number <= finalized_block)
                    || entry
                        .superseded_block
                        .is_some_and(|block| block.block_number <= finalized_block)
                    || entry
                        .invalidated_block
                        .is_some_and(|block| block.block_number <= finalized_block);
                if expired && !done {
                    ttl += 1;
                    true
                } else if done {
                    finalized += 1;
                    true
                } else {
                    false
                }
            })
            .map(|entry| entry.content_hash)
            .collect();
        store.apply_changes(Vec::new(), removals)?;
        drop(store);
        for _ in 0..ttl {
            self.metrics.record_mempool_eviction("ttl");
        }
        for _ in 0..finalized {
            self.metrics.record_mempool_eviction("finalized");
        }
        self.publish_occupancy();
        Ok(())
    }

    /// Reconcile retained entries after canonical state has been restored to
    /// `canonical_height`. Orphaned lifecycle markers are cleared, and every
    /// unmarked entry is revalidated against the restored state.
    pub fn on_rollback(&self, canonical_height: u64) -> Result<(), MempoolApiError> {
        self.with_lifecycle(|this| this.update_rollback(canonical_height))
    }

    pub(super) fn update_rollback(&self, canonical_height: u64) -> Result<(), MempoolApiError> {
        let guard = self.inner.lock().unwrap();
        let head = guard.head_id();
        if head.block_number != canonical_height {
            return Err(MempoolApiError::Invalid(
                "mempool rollback height does not match the derived head".to_owned(),
            ));
        }

        let timestamp = guard.state.last_l1_timestamp();
        let mut store = self.store.lock().unwrap();
        let mut replacements = Vec::with_capacity(store.entries.len());
        for entry in store.entries.values() {
            let mut updated = entry.clone();
            if updated
                .included_block
                .is_some_and(|block| block.block_number > canonical_height)
            {
                updated.included_block = None;
            }
            if updated
                .superseded_block
                .is_some_and(|block| block.block_number > canonical_height)
            {
                updated.superseded_block = None;
            }
            if updated
                .invalidated_block
                .is_some_and(|block| block.block_number > canonical_height)
            {
                updated.invalidated_block = None;
            }
            if updated.included_block.is_some() {
                updated.status = MempoolStatus::IncludedUnfinalized;
            } else if updated.superseded_block.is_some() || updated.invalidated_block.is_some() {
                updated.status = MempoolStatus::Suspended;
            } else {
                let evaluation = evaluate_against_state(&guard, timestamp, entry.prepared.get())?;
                updated.status = evaluation.status();
                if evaluation == StateEvaluation::Suspended(Suspension::Monotonic) {
                    updated.invalidated_block = Some(head);
                }
                updated.validated_block = head;
            }
            if updated != *entry {
                replacements.push(updated);
            }
        }
        store.apply_changes(replacements, Vec::new())?;
        drop(store);
        self.publish_occupancy();
        Ok(())
    }

    pub fn prepare(
        &self,
        request: PrepareRelayRequest,
    ) -> Result<PreparedRelayDto, MempoolApiError> {
        self.metrics.record_mempool_prepare_request();
        let _available = self.require_available()?;
        if request.max_batch_bytes < Batch::HEADER_LEN {
            return Err(MempoolApiError::Invalid(
                "maxBatchBytes is smaller than the batch header".to_owned(),
            ));
        }
        let mut rejected = Vec::new();
        let mut candidates = Vec::<StoredEntry>::new();
        let mut requested_content_hashes = HashSet::new();
        let mut framed_bytes = Batch::HEADER_LEN;
        {
            let store = self.store.lock().unwrap();
            for content_hash in request.content_hashes.iter().copied() {
                if !requested_content_hashes.insert(content_hash) {
                    rejected.push(rejection(content_hash, "duplicate request"));
                    continue;
                }
                if candidates.len() >= MAX_BATCH_ENTRIES {
                    rejected.push(rejection(content_hash, "batch entry limit"));
                    continue;
                }
                let Some(entry) = store.get(&content_hash) else {
                    rejected.push(rejection(content_hash, "not found"));
                    continue;
                };
                if entry.status != MempoolStatus::Ready {
                    rejected.push(rejection(content_hash, entry.status.as_str()));
                    continue;
                }
                let next_size = framed_bytes
                    .saturating_add(Batch::ITEM_PREFIX_LEN)
                    .saturating_add(entry.raw.len());
                if next_size > request.max_batch_bytes {
                    rejected.push(rejection(content_hash, "max batch bytes"));
                    continue;
                }
                framed_bytes = next_size;
                candidates.push(entry.clone());
            }
        }

        let (candidates, outcomes, head_checked) = {
            let guard = self.inner.lock().unwrap();
            let timestamp = guard.state.last_l1_timestamp();
            let mut compatible = Vec::with_capacity(candidates.len());
            for entry in candidates {
                let kind = entry.prepared.get().kind();
                if !guard.rules.transaction_type_allowed_at(kind, timestamp) {
                    rejected.push(rejection(
                        entry.content_hash,
                        format!("transaction type is not active: 0x{kind:02x}"),
                    ));
                    continue;
                }
                compatible.push(entry);
            }
            let transactions = compatible
                .iter()
                .map(|entry| entry.prepared.get())
                .collect::<Vec<_>>();
            let outcomes = validation_outcome(validate_transactions(
                &guard.state,
                &guard.rules,
                &AlreadyVerified,
                timestamp,
                None,
                &transactions,
            ))?;
            (compatible, outcomes, guard.head_id())
        };

        let mut selected_content_hashes = Vec::new();
        let mut selected_raw = Vec::new();
        let mut collectible_open_fee = U256::ZERO;
        let mut collectible_qualifying_actions = 0u64;
        let mut selected_qualifying_actions = 0u64;
        let controlled_content_hashes: HashSet<B256> = request
            .controlled_issuance_content_hashes
            .iter()
            .copied()
            .collect();
        for (entry, outcome) in candidates.into_iter().zip(outcomes) {
            match outcome {
                TransactionOutcome::Succeeded => {
                    let destination = entry.metadata.issuance_owner_commitment;
                    let controlled = destination == B256::ZERO
                        || request
                            .controlled_issuance_owner_commitments
                            .contains(&destination)
                        || controlled_content_hashes.contains(&entry.content_hash);
                    let qualifying = pcash_derive::earns_issuance(entry.raw[0]);
                    collectible_open_fee = collectible_open_fee
                        .checked_add(entry.metadata.open_fee_amount)
                        .ok_or_else(|| {
                            MempoolApiError::Invalid("collectible open fee overflow".to_owned())
                        })?;
                    selected_qualifying_actions += u64::from(qualifying);
                    collectible_qualifying_actions += u64::from(qualifying && controlled);
                    selected_content_hashes.push(entry.content_hash);
                    selected_raw.push(entry.raw);
                }
                outcome => {
                    rejected.push(rejection(entry.content_hash, format!("{outcome:?}")));
                }
            }
        }

        let batch_bytes = Batch::HEADER_LEN
            + selected_raw
                .iter()
                .map(|raw| Batch::ITEM_PREFIX_LEN + raw.len())
                .sum::<usize>();
        self.metrics
            .record_mempool_prepare(selected_content_hashes.len() as u64, rejected.len() as u64);
        Ok(PreparedRelayDto {
            batch_bytes: batch_bytes as u64,
            selected_transactions: selected_raw.into_iter().map(Into::into).collect(),
            selected_content_hashes,
            rejected,
            collectible_open_fee,
            collectible_qualifying_actions,
            selected_qualifying_actions,
            head_checked_block: head_checked.block_number,
            head_checked_block_hash: head_checked.block_hash,
        })
    }
}

/// A suspension is either monotonic — the state moved past this entry and no
/// later block brings it back — or transient. `NotYetValid` is the only
/// transient reason: the entry becomes admissible again once the head
/// timestamp reaches its `notBeforeTimestamp`. Only monotonic suspensions may
/// install an `invalidated_block` marker, because that marker suppresses
/// re-evaluation for as long as it stays canonical.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Suspension {
    Monotonic,
    Transient,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum StateEvaluation {
    Ready,
    Suspended(Suspension),
}

impl StateEvaluation {
    fn status(self) -> MempoolStatus {
        match self {
            Self::Ready => MempoolStatus::Ready,
            Self::Suspended(_) => MempoolStatus::Suspended,
        }
    }
}

pub(super) fn evaluate_against_state(
    guard: &NodeInner,
    timestamp: u64,
    transaction: &AdmittedTransaction,
) -> Result<StateEvaluation, MempoolApiError> {
    Ok(match check_at_head(guard, timestamp, transaction, None)? {
        Some(TransactionOutcome::Succeeded) => StateEvaluation::Ready,
        Some(TransactionOutcome::NotYetValid) => StateEvaluation::Suspended(Suspension::Transient),
        Some(_) | None => StateEvaluation::Suspended(Suspension::Monotonic),
    })
}

fn queue_full() -> MempoolApiError {
    MempoolApiError::Busy("mempool admission queue is full".to_owned())
}

pub(super) fn rejection(content_hash: B256, reason: impl Into<String>) -> MempoolRejectionDto {
    MempoolRejectionDto {
        content_hash,
        reason: reason.into(),
    }
}

#[cfg(test)]
pub(super) fn frame_batch(items: &[Vec<u8>]) -> Vec<u8> {
    Batch {
        version: BatchVersion::V1,
        poster_owner_commitment: pcash_state::Fr::from(1u64),
        poster_context: B256::ZERO,
        items: items.iter().map(Vec::as_slice).collect(),
    }
    .encode()
    .unwrap()
}
