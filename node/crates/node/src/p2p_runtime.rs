//! Ownership loop connecting the non-consensus P2P transport to local admission.

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};

use pcash_derive::{KIND_PRIVATE_VALUE, KIND_USER_ACCOUNT_UPDATE};
use pcash_metrics::{AdmissionOutcome, AdmissionSource, Metrics};
use pcash_p2p::{
    CandidateOrigin, CanonicalHead, InventoryEntry, P2pConfig, P2pEvent, P2pHandle, PeerInfo,
    ValidationResult, MAX_CANONICAL_HEADS,
};
use pcash_rpc::MempoolApiError;
use pcash_state::{RedbStateReader, StateError};
use tokio::sync::{mpsc, watch};

use crate::{MempoolService, MempoolStatus};

const INVENTORY_REFRESH_INTERVAL: Duration = Duration::from_secs(5);
/// One publisher may consume a short burst, then at most one additional
/// expensive proof verification per refill interval. User-account creation
/// and unfunded contract creation carry no proof and do not consume this
/// budget. Every other candidate of a proof-bearing type is charged even when
/// its body is malformed, so malformed proof candidates cannot bypass the
/// expensive-work admission queue.
const PEER_PROOF_BURST: u32 = 4;
const PEER_ADMISSION_BURST: u32 = 32;
const PEER_BUDGET_REFILL_INTERVAL: Duration = Duration::from_secs(10);
const PEER_BUDGET_IDLE_TTL: Duration = Duration::from_mins(10);
const MAX_TRACKED_BUDGET_PEERS: usize = 1_024;
/// The swarm owner never awaits admission. Each candidate that passes the
/// budgets is admitted on its own task through the mempool's admission queue,
/// shared with RPC, and its completion returns here to settle proof charges.
const COMPLETION_CHANNEL_CAPACITY: usize = 64;
const NODE_PROOF_BURST: u32 = 8;
const NODE_PROOF_REFILL_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone, Copy)]
struct PeerRateState {
    tokens: u32,
    last_refill: Instant,
    last_seen: Instant,
}

struct PeerAdmissionBudget {
    peers: HashMap<pcash_p2p::PeerId, PeerRateState>,
    max_tracked: usize,
    burst: u32,
}

impl PeerAdmissionBudget {
    fn new(burst: u32) -> Self {
        Self::with_capacity(MAX_TRACKED_BUDGET_PEERS, burst)
    }

    fn with_capacity(max_tracked: usize, burst: u32) -> Self {
        Self {
            peers: HashMap::new(),
            max_tracked,
            burst,
        }
    }

    fn try_acquire(&mut self, peer: pcash_p2p::PeerId, now: Instant) -> bool {
        self.peers.retain(|_, state| {
            now.saturating_duration_since(state.last_seen) < PEER_BUDGET_IDLE_TTL
        });

        if let Some(state) = self.peers.get_mut(&peer) {
            if now.saturating_duration_since(state.last_refill) >= PEER_BUDGET_REFILL_INTERVAL {
                state.tokens = state.tokens.saturating_add(1).min(self.burst);
                state.last_refill = now;
            }
            if state.tokens == 0 {
                return false;
            }
            state.last_seen = now;
            state.tokens -= 1;
            return true;
        }

        if self.peers.len() >= self.max_tracked {
            if let Some(oldest) = self
                .peers
                .iter()
                .min_by_key(|(_, state)| state.last_seen)
                .map(|(peer, _)| *peer)
            {
                self.peers.remove(&oldest);
            }
        }
        self.peers.insert(
            peer,
            PeerRateState {
                tokens: self.burst - 1,
                last_refill: now,
                last_seen: now,
            },
        );
        true
    }

    fn refund(&mut self, peer: pcash_p2p::PeerId) {
        if let Some(state) = self.peers.get_mut(&peer) {
            state.tokens = state.tokens.saturating_add(1).min(self.burst);
        }
    }
}

struct PeerAdmissionBudgets {
    publishers: PeerAdmissionBudget,
    propagation_peers: PeerAdmissionBudget,
}

struct NodeProofWorkBudget {
    tokens: u32,
    max_tokens: u32,
    in_flight: u32,
    last_refill: Instant,
}

impl NodeProofWorkBudget {
    fn new(now: Instant) -> Self {
        Self::with_capacity(NODE_PROOF_BURST, now)
    }

    fn with_capacity(max_tokens: u32, now: Instant) -> Self {
        Self {
            tokens: max_tokens,
            max_tokens,
            in_flight: 0,
            last_refill: now,
        }
    }

    fn try_acquire(&mut self, now: Instant) -> bool {
        if now.saturating_duration_since(self.last_refill) >= NODE_PROOF_REFILL_INTERVAL {
            self.tokens = self.tokens.saturating_add(1).min(self.max_tokens);
            self.last_refill = now;
        }
        if self.tokens == 0 || self.in_flight >= self.max_tokens {
            return false;
        }
        self.tokens -= 1;
        self.in_flight += 1;
        true
    }

    fn complete(&mut self) {
        self.in_flight = self.in_flight.saturating_sub(1);
    }

    fn refund(&mut self) {
        self.complete();
        self.tokens = self.tokens.saturating_add(1).min(self.max_tokens);
    }
}

struct AdmissionJob {
    tx_bytes: Vec<u8>,
    origin: CandidateOrigin,
    proof_bearing: bool,
}

/// Only proof-bearing jobs have a charge to settle.
struct AdmissionCompletion {
    origin: CandidateOrigin,
    disposition: ProofChargeDisposition,
}

impl PeerAdmissionBudgets {
    fn new(burst: u32) -> Self {
        Self {
            publishers: PeerAdmissionBudget::new(burst),
            propagation_peers: PeerAdmissionBudget::new(burst),
        }
    }

    fn try_acquire(
        &mut self,
        publisher: pcash_p2p::PeerId,
        propagation_peer: pcash_p2p::PeerId,
        now: Instant,
    ) -> Result<(), &'static str> {
        if !self.publishers.try_acquire(publisher, now) {
            return Err("publisher");
        }
        if !self.propagation_peers.try_acquire(propagation_peer, now) {
            self.publishers.refund(publisher);
            return Err("propagation");
        }
        Ok(())
    }

    fn refund(&mut self, publisher: pcash_p2p::PeerId, propagation_peer: pcash_p2p::PeerId) {
        self.publishers.refund(publisher);
        self.propagation_peers.refund(propagation_peer);
    }
}

/// Whether the transaction type carries a proof. The type tag charges the
/// budget before decoding untrusted bytes.
fn requires_expensive_proof(tx_bytes: &[u8]) -> bool {
    matches!(
        tx_bytes.first().copied(),
        Some(KIND_PRIVATE_VALUE | KIND_USER_ACCOUNT_UPDATE)
    )
}

pub struct RunningP2p {
    pub handle: P2pHandle,
    listen_addresses: watch::Receiver<BTreeSet<pcash_p2p::Multiaddr>>,
}

impl RunningP2p {
    /// Connected peers, ordered by peer id. The peer count is this list's
    /// length; the two are one table and cannot disagree.
    pub fn peers(&self) -> Vec<PeerInfo> {
        self.handle.peers()
    }

    pub fn peer_count(&self) -> usize {
        self.handle.peer_count()
    }

    /// Watch the current listen-address set, for callers that must report it
    /// without waiting. A wildcard bind yields one address per interface, and
    /// addresses can expire, so this is a set rather than a single value.
    pub fn listen_addresses_watch(&self) -> watch::Receiver<BTreeSet<pcash_p2p::Multiaddr>> {
        self.listen_addresses.clone()
    }

    /// The listen addresses currently bound.
    pub fn listen_addresses(&self) -> BTreeSet<pcash_p2p::Multiaddr> {
        self.listen_addresses.borrow().clone()
    }

    /// Wait for the swarm's first bound listen address. This is useful for
    /// callers that request an ephemeral TCP port with `/tcp/0` and need an
    /// address to hand to a peer. With a wildcard bind the choice of which
    /// address is arbitrary; callers that need all of them use
    /// [`Self::listen_addresses`].
    pub async fn listen_address(&self) -> Result<pcash_p2p::Multiaddr, pcash_p2p::Error> {
        let mut receiver = self.listen_addresses.clone();
        loop {
            if let Some(address) = receiver.borrow().iter().next().cloned() {
                return Ok(address);
            }
            receiver
                .changed()
                .await
                .map_err(|_| pcash_p2p::Error::Stopped)?;
        }
    }
}

pub async fn start_p2p(
    config: P2pConfig,
    mempool: Arc<MempoolService>,
) -> Result<RunningP2p, pcash_p2p::Error> {
    start_p2p_with_metrics(config, mempool, pcash_metrics::noop()).await
}

pub async fn start_p2p_with_metrics(
    config: P2pConfig,
    mempool: Arc<MempoolService>,
    metrics: Arc<dyn Metrics>,
) -> Result<RunningP2p, pcash_p2p::Error> {
    let initial_inventory = inventory(&mempool);
    let state = mempool.state_reader();
    let (handle, events) = pcash_p2p::start_with_inventory(config, initial_inventory).await?;
    let (listen_address_tx, listen_addresses) = watch::channel(BTreeSet::new());
    tokio::spawn(run_owner(
        handle.clone(),
        events,
        mempool,
        state,
        listen_address_tx,
        metrics,
    ));
    Ok(RunningP2p {
        handle,
        listen_addresses,
    })
}

async fn run_owner(
    handle: P2pHandle,
    mut events: tokio::sync::mpsc::Receiver<P2pEvent>,
    mempool: Arc<MempoolService>,
    state: RedbStateReader,
    listen_addresses: watch::Sender<BTreeSet<pcash_p2p::Multiaddr>>,
    metrics: Arc<dyn Metrics>,
) {
    let mut previous_network = pcash_p2p::NetworkCounters::default();
    let mut refresh = tokio::time::interval(INVENTORY_REFRESH_INTERVAL);
    refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // `start_with_inventory` installed the initial snapshot synchronously.
    refresh.tick().await;
    refresh_heads(&handle, &state);
    let mut proof_budgets = PeerAdmissionBudgets::new(PEER_PROOF_BURST);
    let mut admission_budgets = PeerAdmissionBudgets::new(PEER_ADMISSION_BURST);
    let mut node_proof_budget = NodeProofWorkBudget::new(Instant::now());
    let (completion_tx, mut completion_rx) =
        mpsc::channel::<AdmissionCompletion>(COMPLETION_CHANNEL_CAPACITY);

    loop {
        tokio::select! {
            _ = refresh.tick() => {
                // The peer table is the swarm's own, so the gauge is sampled
                // from it rather than tracked alongside it.
                metrics.set_p2p_peers(handle.peer_count() as u64);
                sample_network_metrics(handle.network_status(), &mut previous_network, metrics.as_ref());
                let next_capability = mempool.fork_capability();
                // Never await the swarm from this loop: it is the sole
                // consumer of the bounded event channel, and a oneshot wait
                // deadlocks if that channel fills while the swarm is emitting.
                if let Err(error) = handle.try_update_fork_capability(next_capability) {
                    tracing::warn!(%error, "failed to refresh P2P fork capability");
                }
                if let Err(error) = handle.try_replace_inventory(inventory(&mempool)) {
                    tracing::warn!(%error, "failed to refresh P2P mempool inventory");
                }
                refresh_heads(&handle, &state);
            }
            Some(completion) = completion_rx.recv() => {
                if completion.disposition == ProofChargeDisposition::Refund {
                    node_proof_budget.refund();
                    proof_budgets.refund(
                        completion.origin.publisher(),
                        completion.origin.propagation_peer(),
                    );
                } else {
                    node_proof_budget.complete();
                }
            }
            event = events.recv() => {
                let Some(event) = event else {
                    metrics.set_p2p_peers(0);
                    break;
                };
                match event {
                    P2pEvent::Listening(address) => {
                        listen_addresses.send_modify(|set| {
                            set.insert(address.clone());
                        });
                        tracing::info!(%address, peer_id = %handle.peer_id(), "PCASH P2P listening");
                    }
                    P2pEvent::ListeningExpired(address) => {
                        listen_addresses.send_modify(|set| {
                            set.remove(&address);
                        });
                        tracing::info!(%address, "PCASH P2P listen address expired");
                    }
                    P2pEvent::Warning(message) => {
                        tracing::warn!(message, "PCASH P2P warning");
                    }
                    P2pEvent::BlockHashDivergence { peer, divergence } => {
                        metrics.record_p2p_block_hash_divergence();
                        tracing::error!(
                            %peer,
                            l1_block_number = divergence.l1_block_number,
                            l1_block_hash = %divergence.l1_block_hash,
                            local_block_hash = %divergence.local_block_hash,
                            peer_block_hash = %divergence.peer_block_hash,
                            "peer advertises a different PCASH block hash for an L1 block this node derived"
                        );
                    }
                    P2pEvent::Candidate { tx_bytes, origin } => {
                        let source = origin.publisher();
                        if matches!(mempool.check_admission_policy(&tx_bytes), Err(MempoolApiError::Policy(_))) {
                            metrics.record_mempool_admission(AdmissionSource::P2p, AdmissionOutcome::Policy);
                            try_ignore_gossip(&handle, origin);
                            continue;
                        }
                        let propagation_peer = origin.propagation_peer();
                        if let Err(budget) = admission_budgets.try_acquire(source, propagation_peer, Instant::now()) {
                            metrics.record_p2p_proof_budget_drop(budget);
                            try_ignore_gossip(&handle, origin);
                            continue;
                        }
                        let proof_bearing = requires_expensive_proof(&tx_bytes);
                        if proof_bearing {
                            if let Err(budget) = proof_budgets.try_acquire(
                                source,
                                propagation_peer,
                                Instant::now(),
                            ) {
                                metrics.record_p2p_proof_budget_drop(budget);
                                try_ignore_gossip(&handle, origin);
                                tracing::debug!(%source, "temporarily suppressed peer proof candidate");
                                continue;
                            }
                        }
                        if proof_bearing && !node_proof_budget.try_acquire(Instant::now()) {
                            proof_budgets.refund(source, propagation_peer);
                            metrics.record_p2p_proof_budget_drop("node");
                            try_ignore_gossip(&handle, origin);
                            tracing::debug!(%source, "node-wide proof queue is full");
                            continue;
                        }
                        tokio::spawn(admit_candidate(
                            handle.clone(),
                            mempool.clone(),
                            completion_tx.clone(),
                            AdmissionJob {
                                tx_bytes,
                                origin,
                                proof_bearing,
                            },
                        ));
                    }
                }
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ProofChargeDisposition {
    Keep,
    Refund,
}

/// Admit one candidate and report its proof charge back to the swarm owner.
async fn admit_candidate(
    handle: P2pHandle,
    mempool: Arc<MempoolService>,
    completions: mpsc::Sender<AdmissionCompletion>,
    job: AdmissionJob,
) {
    let AdmissionJob {
        tx_bytes,
        origin,
        proof_bearing,
    } = job;
    let disposition = settle_candidate(&handle, &mempool, tx_bytes, &origin).await;
    if proof_bearing {
        let _ = completions
            .send(AdmissionCompletion {
                origin,
                disposition,
            })
            .await;
    }
}

async fn settle_candidate(
    handle: &P2pHandle,
    mempool: &Arc<MempoolService>,
    tx_bytes: Vec<u8>,
    origin: &CandidateOrigin,
) -> ProofChargeDisposition {
    let sync_bytes = (!origin.is_gossip()).then(|| tx_bytes.clone());
    let result = mempool.submit_from_peer(tx_bytes).await;
    settle_admission(handle, result, sync_bytes, origin).await
}

async fn settle_admission(
    handle: &P2pHandle,
    result: Result<MempoolStatus, MempoolApiError>,
    sync_bytes: Option<Vec<u8>>,
    origin: &CandidateOrigin,
) -> ProofChargeDisposition {
    let (verdict, disposition) = match result {
        Ok(status) => (
            if status == MempoolStatus::Ready {
                ValidationResult::Accept
            } else {
                ValidationResult::Ignore
            },
            ProofChargeDisposition::Keep,
        ),
        Err(error) => {
            // State preflight and a busy refusal did not use the verifier.
            // Refund their proof charge so later sync candidates can use this
            // refill.
            let disposition =
                if matches!(&error, MempoolApiError::State(_) | MempoolApiError::Busy(_)) {
                    ProofChargeDisposition::Refund
                } else {
                    ProofChargeDisposition::Keep
                };
            tracing::debug!(source = %origin.publisher(), %error, "P2P candidate admission failed");
            (validation_result(&error), disposition)
        }
    };

    // Sync has no pending mesh validation to release for Ignore. Accept and
    // Reject still account for the immediate peer's contribution and misconduct.
    if verdict != ValidationResult::Ignore || origin.is_gossip() {
        let _ = handle.report_validation(origin.clone(), verdict).await;
    }
    if let (ValidationResult::Accept, Some(tx_bytes)) = (verdict, sync_bytes) {
        if let Err(error) = handle.announce(tx_bytes).await {
            tracing::debug!(%error, "failed to announce admitted sync candidate");
        }
    }
    disposition
}

/// Release pending gossip validation without waiting on the swarm's queue.
/// Sync candidates have no pending mesh state and Ignore does not affect score.
fn try_ignore_gossip(handle: &P2pHandle, origin: CandidateOrigin) {
    if origin.is_gossip() {
        let _ = handle.try_report_validation(origin, ValidationResult::Ignore);
    }
}

fn validation_result(error: &MempoolApiError) -> ValidationResult {
    match error {
        MempoolApiError::Invalid(_) => ValidationResult::Reject,
        MempoolApiError::State(_)
        | MempoolApiError::Policy(_)
        | MempoolApiError::Full
        | MempoolApiError::Busy(_)
        | MempoolApiError::Verification(_)
        | MempoolApiError::Storage(_)
        | MempoolApiError::Unavailable => ValidationResult::Ignore,
    }
}

/// Hand the swarm this node's newest canonical heads to advertise and compare.
fn refresh_heads(handle: &P2pHandle, state: &RedbStateReader) {
    match recent_heads(state) {
        Ok(heads) => {
            if let Err(error) = handle.try_replace_heads(heads) {
                tracing::warn!(%error, "failed to refresh P2P canonical heads");
            }
        }
        Err(error) => tracing::warn!(%error, "failed to read canonical heads for P2P"),
    }
}

/// The newest [`MAX_CANONICAL_HEADS`] canonical blocks, oldest first, from one
/// committed snapshot.
fn recent_heads(state: &RedbStateReader) -> Result<Vec<CanonicalHead>, StateError> {
    let snapshot = state.snapshot()?;
    let Some(tip) = snapshot.canonical_tip_summary()? else {
        return Ok(Vec::new());
    };
    let first = (tip.number + 1).saturating_sub(MAX_CANONICAL_HEADS as u64);
    let mut heads = Vec::with_capacity(MAX_CANONICAL_HEADS);
    for number in first..=tip.number {
        if let Some(block) = snapshot.canonical_stored_block(number)? {
            heads.push(CanonicalHead {
                l1_block_number: block.l1_origin.block_number,
                l1_block_hash: block.l1_origin.block_hash,
                block_hash: block.hash,
            });
        }
    }
    Ok(heads)
}

fn inventory(mempool: &MempoolService) -> Vec<InventoryEntry> {
    mempool
        .ready_inventory()
        .into_iter()
        .map(|(content_hash, tx_bytes)| InventoryEntry {
            content_hash,
            tx_bytes,
        })
        .collect()
}

fn sample_network_metrics(
    network: pcash_p2p::NetworkStatus,
    previous: &mut pcash_p2p::NetworkCounters,
    metrics: &dyn Metrics,
) {
    let delta = network.counters.since(*previous);
    metrics.record_p2p_network(pcash_metrics::P2pNetworkMetrics {
        routing_peers: network.routing_peers as u64,
        pending_dials: network.pending_dials as u64,
        relay_reservations: network.relay_reservations.len() as u64,
        relay_circuits: network.relay_circuits as u64,
        public: network.reachability == pcash_p2p::Reachability::Public,
        relayed: network.reachability == pcash_p2p::Reachability::Relayed,
        discovery_success: delta.discovery_queries_succeeded,
        discovery_failure: delta.discovery_queries_failed,
        dial_failure: delta.dial_failures,
        hole_punch_success: delta.hole_punches_succeeded,
        hole_punch_failure: delta.hole_punches_failed,
    });
    *previous = network.counters;
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

    #[test]
    fn admission_failures_map_to_gossip_results() {
        assert_eq!(
            validation_result(&MempoolApiError::Invalid("bad".into())),
            ValidationResult::Reject
        );
        assert_eq!(
            validation_result(&MempoolApiError::Policy("node policy".into())),
            ValidationResult::Ignore
        );
        assert_eq!(
            validation_result(&MempoolApiError::Full),
            ValidationResult::Ignore
        );
        assert_eq!(
            validation_result(&MempoolApiError::Busy("queue".into())),
            ValidationResult::Ignore
        );
        assert_eq!(
            validation_result(&MempoolApiError::Verification("verifier timed out".into())),
            ValidationResult::Ignore
        );
        assert_eq!(
            validation_result(&MempoolApiError::State(
                "transaction type is not active at the current derived head".into()
            )),
            ValidationResult::Ignore
        );
        assert_eq!(
            validation_result(&MempoolApiError::Storage("disk".into())),
            ValidationResult::Ignore
        );
    }

    #[tokio::test]
    async fn local_validation_failures_do_not_penalize_gossip_or_sync_peers() {
        use alloy_primitives::B256;
        use pcash_state::StateError;

        for gossip in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let (service, _, genesis_hash) =
                crate::mempool::tests::service(dir.path(), B256::repeat_byte(7));
            let service = Arc::new(service);
            let config = || P2pConfig {
                connectivity: pcash_p2p::ConnectivityConfig::disabled(),
                chain_id: crate::PCASH_CHAIN_ID,
                genesis_hash,
                identity: pcash_p2p::Keypair::generate_ed25519(),
                listen: "/ip4/127.0.0.1/tcp/0".parse().unwrap(),
                bootstrap: Vec::new(),
                max_inventory: 8,
                anti_entropy_interval: Duration::from_mins(1),
                fork_capability: service.fork_capability(),
                peer_ban_duration: pcash_p2p::PEER_BAN_DURATION,
            };
            let (handle, _events) = pcash_p2p::start(config()).await.unwrap();
            let (remote, mut remote_events) = pcash_p2p::start(config()).await.unwrap();
            let address = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if let Some(P2pEvent::Listening(address)) = remote_events.recv().await {
                        break address;
                    }
                }
            })
            .await
            .unwrap();
            handle
                .add_peer(
                    format!("{address}/p2p/{}", remote.peer_id())
                        .parse()
                        .unwrap(),
                )
                .await
                .unwrap();
            tokio::time::timeout(Duration::from_secs(5), async {
                while !handle
                    .peer(remote.peer_id())
                    .is_some_and(|peer| peer.compatible)
                {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            let origin = if gossip {
                CandidateOrigin::Gossip {
                    publisher: remote.peer_id(),
                    propagation_source: remote.peer_id(),
                    message_id: vec![1].into(),
                }
            } else {
                CandidateOrigin::Sync {
                    peer: remote.peer_id(),
                }
            };

            // Inject at validate_transactions' Result boundary. A full
            // sync-sized burst must not turn a local failure into a ban.
            for _ in 0..32 {
                let result =
                    crate::mempool::validation_outcome(Err(pcash_derive::DeriveError::State(
                        StateError::Backend("injected canonical read failure".into()),
                    )));
                assert!(matches!(&result, Err(MempoolApiError::Storage(message))
                    if message.contains("injected canonical read failure")));
                assert_eq!(
                    validation_result(result.as_ref().unwrap_err()),
                    ValidationResult::Ignore
                );
                settle_admission(&handle, result.map(|_| MempoolStatus::Ready), None, &origin)
                    .await;
            }

            // Real malformed peer bytes still take the rejection path. This
            // last verdict also proves that all preceding queued verdicts have
            // been processed before inspecting the published peer score.
            let invalid = service.submit_from_peer(vec![0xff]).await;
            assert!(matches!(&invalid, Err(MempoolApiError::Invalid(_))));
            assert_eq!(
                validation_result(invalid.as_ref().unwrap_err()),
                ValidationResult::Reject
            );
            settle_admission(&handle, invalid, None, &origin).await;
            let peer = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if let Some(peer) = handle.peer(remote.peer_id()) {
                        if peer.tx_rejected > 0 {
                            break peer;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("peer must remain connected after local failures");
            assert_eq!(peer.tx_rejected, 1);
            assert_eq!(peer.tx_accepted, 0);
            assert_eq!(peer.score, -20);
            assert!(peer.banned_for.is_none());
            handle.shutdown().await.unwrap();
            remote.shutdown().await.unwrap();
        }
    }

    #[test]
    fn proof_budget_survives_peer_reuse_without_blocking_another() {
        let dir = tempfile::tempdir().unwrap();
        let first = pcash_p2p::load_or_create_identity(&dir.path().join("first.key"))
            .unwrap()
            .public()
            .to_peer_id();
        let second = pcash_p2p::load_or_create_identity(&dir.path().join("second.key"))
            .unwrap()
            .public()
            .to_peer_id();
        let start = Instant::now();
        let mut budgets = PeerAdmissionBudgets::new(PEER_PROOF_BURST);

        for _ in 0..PEER_PROOF_BURST {
            assert!(budgets.try_acquire(first, first, start).is_ok());
        }
        // Reusing the same peer identity does not create a fresh burst. Budget
        // state is retained for its idle TTL rather than cleared on disconnect.
        assert!(budgets.try_acquire(first, first, start).is_err());
        assert!(budgets.try_acquire(second, second, start).is_ok());
        assert!(budgets
            .try_acquire(first, first, start + PEER_BUDGET_REFILL_INTERVAL)
            .is_ok());
        assert!(budgets
            .try_acquire(first, first, start + PEER_BUDGET_REFILL_INTERVAL)
            .is_err());
    }

    #[test]
    fn state_preflight_refund_allows_the_next_candidate() {
        let dir = tempfile::tempdir().unwrap();
        let peer = pcash_p2p::load_or_create_identity(&dir.path().join("peer.key"))
            .unwrap()
            .public()
            .to_peer_id();
        let start = Instant::now();
        let mut budgets = PeerAdmissionBudgets::new(PEER_PROOF_BURST);
        for _ in 0..PEER_PROOF_BURST {
            assert!(budgets.try_acquire(peer, peer, start).is_ok());
        }

        let refill = start + PEER_BUDGET_REFILL_INTERVAL;
        assert!(budgets.try_acquire(peer, peer, refill).is_ok());
        budgets.refund(peer, peer);
        assert!(budgets.try_acquire(peer, peer, refill).is_ok());
    }

    #[test]
    fn publisher_table_evicts_oldest_instead_of_locking_out_unseen_peers() {
        let dir = tempfile::tempdir().unwrap();
        let first = pcash_p2p::load_or_create_identity(&dir.path().join("first.key"))
            .unwrap()
            .public()
            .to_peer_id();
        let second = pcash_p2p::load_or_create_identity(&dir.path().join("second.key"))
            .unwrap()
            .public()
            .to_peer_id();
        let third = pcash_p2p::load_or_create_identity(&dir.path().join("third.key"))
            .unwrap()
            .public()
            .to_peer_id();
        let start = Instant::now();
        let mut budget = PeerAdmissionBudget::with_capacity(2, PEER_PROOF_BURST);
        assert!(budget.try_acquire(first, start));
        assert!(budget.try_acquire(second, start + Duration::from_millis(1)));
        assert!(budget.try_acquire(third, start + Duration::from_millis(2)));
        assert_eq!(budget.peers.len(), 2);
        assert!(!budget.peers.contains_key(&first));
        assert!(budget.peers.contains_key(&third));
    }

    #[test]
    fn forwarded_publishers_share_the_propagation_peer_budget() {
        let dir = tempfile::tempdir().unwrap();
        let relay = pcash_p2p::load_or_create_identity(&dir.path().join("relay.key"))
            .unwrap()
            .public()
            .to_peer_id();
        let publishers = (0..=PEER_PROOF_BURST)
            .map(|index| {
                pcash_p2p::load_or_create_identity(
                    &dir.path().join(format!("publisher-{index}.key")),
                )
                .unwrap()
                .public()
                .to_peer_id()
            })
            .collect::<Vec<_>>();
        let start = Instant::now();
        let mut budgets = PeerAdmissionBudgets::new(PEER_PROOF_BURST);
        for publisher in publishers.iter().take(PEER_PROOF_BURST as usize) {
            assert!(budgets.try_acquire(*publisher, relay, start).is_ok());
        }
        assert!(budgets
            .try_acquire(publishers[PEER_PROOF_BURST as usize], relay, start)
            .is_err());
    }

    #[test]
    fn node_proof_budget_caps_work_across_sybil_peer_ids() {
        let start = Instant::now();
        let mut budget = NodeProofWorkBudget::with_capacity(2, start);
        assert!(budget.try_acquire(start));
        assert!(budget.try_acquire(start));
        assert!(!budget.try_acquire(start));

        // Completing proof work frees queue capacity but does not refund the
        // node-wide rate token. Rotating peer IDs cannot create a fresh burst.
        budget.complete();
        assert!(!budget.try_acquire(start));
        assert!(budget.try_acquire(start + NODE_PROOF_REFILL_INTERVAL));

        // A current-state preflight rejection did not use the verifier and may
        // safely refund both its queue slot and its rate token.
        budget.refund();
        assert!(budget.try_acquire(start + NODE_PROOF_REFILL_INTERVAL));
    }

    #[test]
    fn proof_kind_tags_consume_budget_independent_of_wire_profile() {
        fn proof_entry(entry_kind: u8, public_inputs: usize, output_data: usize) -> Vec<u8> {
            let mut raw = vec![entry_kind];
            raw.resize(1 + public_inputs * 32, 0);
            raw.extend_from_slice(&0u32.to_be_bytes());
            for _ in 0..output_data {
                raw.extend_from_slice(&0u16.to_be_bytes());
            }
            raw
        }

        let transfer = proof_entry(
            pcash_derive::KIND_PRIVATE_VALUE,
            pcash_derive::PRIVATE_VALUE_WIRE_INPUTS,
            pcash_derive::params::PRIVATE_VALUE_OUTPUT_DATA_ITEMS,
        );
        let mut account = vec![pcash_derive::KIND_USER_ACCOUNT_CREATION];
        account.resize(1 + 20 + 32 + 32, 0);
        account.push(0);
        account.extend_from_slice(&[0; 64]);
        account.push(0);

        assert!(requires_expensive_proof(&transfer));
        assert!(requires_expensive_proof(&[
            pcash_derive::KIND_USER_ACCOUNT_UPDATE
        ]));
        assert!(!requires_expensive_proof(&account));
        assert!(requires_expensive_proof(&[
            pcash_derive::KIND_PRIVATE_VALUE
        ]));
        // Every standalone contract creation is proof-free, including malformed bytes.
        for rest in [&[][..], &[0x11; 40], &[0x22; 1000]] {
            let mut contract = vec![pcash_derive::KIND_CONTRACT_ACCOUNT_CREATION];
            contract.extend_from_slice(rest);
            assert!(!requires_expensive_proof(&contract));
        }
        assert!(!requires_expensive_proof(&[]));
        assert!(!requires_expensive_proof(&[0xff]));
    }
}
