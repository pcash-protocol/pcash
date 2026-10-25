//! The L1 follow loop and reorg handling.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "follower transitions preserve validated canonical-state invariants"
)]
//!
//! Derivation is a pure function of the L1 chain, so this loop just drives the
//! [`Follower`] forward and, on a parent-hash discontinuity, walks back on block
//! hashes to the most recent still-canonical block, restores the latest redb
//! savepoint at or below that height, and re-derives forward. A reorg strictly
//! below the locally finalized height has no restorable savepoint and is fatal
//! by construction; a fork point exactly at finalized reverts nothing finalized
//! and is handled normally.
//!
//! Derivation follows the L1 `latest` head. The `finalized` tag bounds reorg
//! recovery and supplies the finality reported by `pcash_status` and receipts;
//! it is not a derivation ceiling.
//!
//! The loop is bounded and interruptible for testing: pass `target = Some(n)` to
//! stop as soon as block `n` has been derived (the live Sepolia test uses this to
//! run a fixed window), or `None` to follow indefinitely.

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use pcash_derive::{DeriveError, ProtocolRules};
use pcash_l1::{Follower, L1BlockData, L1Client, L1Error, Reorg, Step};
use pcash_metrics::{DerivationProgress, DerivationStateName, DeriveMode, Metrics};
use pcash_rpc::{BlockId, DerivationDto, HaltCause, StallCause};
use pcash_state::{DerivationSource, StateDb, StateError};
use pcash_verify::{CachedVerifier, Verifier};
use tokio::sync::{mpsc, watch, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;

use crate::blob::{BeaconClient, BlobError};
use crate::index::DerivedIndexLifecycle;
use crate::mempool::now_unix_ms;
use crate::node::{NodeHandle, NodeInner};
use crate::MempoolService;

/// Distance from head at which catch-up stops and the serial path takes over.
const CATCHUP_WINDOW: u64 = 32;
/// Catch-up blocks that L1 has already finalized skip per-block fsync and
/// reorg savepoints. A durable checkpoint every this many L1 blocks (and at
/// genesis / when leaving catch-up) is the restart anchor.
pub(crate) const CATCHUP_DURABLE_INTERVAL: u64 = 32;

/// Default catch-up inventory: blocks fetched or being fetched but not yet
/// applied. The L1 client's shared request-rate limit decides how fast it fills.
pub const DEFAULT_CATCHUP_FETCH_QUEUE: usize = 100;

/// Catch-up blocks being downloaded at once. Any Ethereum sender can fill a
/// block's receipts with logs, so each fetch can be a large download; this keeps
/// a slow link from splitting its bandwidth across the whole inventory.
pub const CATCHUP_FETCH_CONCURRENCY: usize = 8;

/// Emit one operator-facing timing row per group instead of one row per block.
const DERIVATION_LOG_INTERVAL: u64 = 25;

#[derive(Default)]
struct DerivationStats {
    first_block: Option<u64>,
    last_block: u64,
    l1_head: u64,
    blocks: u64,
    total: Duration,
    rpc_wait: Duration,
    hash_wait: Duration,
    group_started: Option<Instant>,
    stall_fetch: Duration,
    stall_hash_queue: Duration,
    stall_hash: Duration,
    stall_gap: Duration,
    waited: u64,
    fetch_wait: Duration,
    logs: u64,
    prewarm: Duration,
    derive_lock: Duration,
    prune: Duration,
    index: Duration,
}

impl DerivationStats {
    fn begin_wait(&mut self) -> Instant {
        let now = Instant::now();
        if self.group_started.is_none() {
            self.group_started = Some(now);
        }
        now
    }

    fn add_rpc_wait(&mut self, elapsed: Duration) {
        self.rpc_wait += elapsed;
    }

    fn add_hash_wait(&mut self, elapsed: Duration) {
        self.hash_wait += elapsed;
    }

    fn add_fetch_wait(&mut self, elapsed: Duration) {
        self.fetch_wait += elapsed;
    }

    fn add_logs(&mut self, count: u64) {
        self.logs += count;
    }

    fn add_cursor_stall(&mut self, wait_started: Instant, block: &ReadyBlock) {
        let now = Instant::now();
        let stall = now.saturating_duration_since(wait_started);
        if stall < Duration::from_millis(1) {
            return;
        }
        self.rpc_wait += stall;
        self.waited += 1;
        let fetch = overlap(wait_started, now, block.fetch_started, block.fetch_done);
        let queue = overlap(wait_started, now, block.fetch_done, block.hash_started);
        let hash = overlap(wait_started, now, block.hash_started, block.hash_done);
        let accounted = fetch
            .checked_add(queue)
            .and_then(|d| d.checked_add(hash))
            .unwrap_or(stall);
        self.stall_fetch += fetch;
        self.stall_hash_queue += queue;
        self.stall_hash += hash;
        self.stall_gap += stall.saturating_sub(accounted);
    }

    fn record(&mut self, sample: DerivedBlock, l1_head: u64) {
        if self.group_started.is_none() {
            self.group_started = Some(Instant::now());
        }
        self.first_block.get_or_insert(sample.number);
        self.last_block = sample.number;
        self.l1_head = l1_head;
        self.blocks += 1;
        self.total += sample.total;
        self.prewarm += sample.prewarm;
        self.derive_lock += sample.apply;
        self.prune += sample.prune;
        self.index += sample.index;
        if self.blocks == DERIVATION_LOG_INTERVAL {
            self.flush();
        }
    }

    fn flush(&mut self) {
        let Some(first_block) = self.first_block else {
            return;
        };
        let active = self
            .group_started
            .map_or(self.total + self.rpc_wait + self.hash_wait, |started| {
                started.elapsed()
            });
        let remaining_blocks = self.l1_head.saturating_sub(self.last_block);
        let blocks_per_second = if active.is_zero() {
            "n/a".to_string()
        } else {
            format!("{:.2}", self.blocks as f64 / active.as_secs_f64())
        };
        let eta_ms = active
            .as_millis()
            .saturating_mul(u128::from(remaining_blocks))
            / u128::from(self.blocks);
        let eta_to_head = format_eta(eta_ms);
        tracing::info!(
            start = first_block,
            end = self.last_block,
            blocks = self.blocks,
            l1_head = self.l1_head,
            remaining_blocks,
            ms_per_l1_block = avg_ms(active, self.blocks),
            apply_ms = self.total.as_millis() as u64,
            prewarm_ms = self.prewarm.as_millis() as u64,
            derive_ms = self.derive_lock.as_millis() as u64,
            prune_ms = self.prune.as_millis() as u64,
            index_ms = self.index.as_millis() as u64,
            logs = self.logs,
            fetch_ms = self.fetch_wait.as_millis() as u64,
            rpc_wait_ms = self.rpc_wait.as_millis() as u64,
            stall_fetch_ms = self.stall_fetch.as_millis() as u64,
            stall_hash_q_ms = self.stall_hash_queue.as_millis() as u64,
            stall_hash_ms = self.stall_hash.as_millis() as u64,
            stall_gap_ms = self.stall_gap.as_millis() as u64,
            waited = self.waited,
            hash_wait_ms = self.hash_wait.as_millis() as u64,
            blocks_per_second = %blocks_per_second,
            eta_to_head = %eta_to_head,
            "derived L1 blocks"
        );
        *self = Self::default();
    }

    fn discard(&mut self) {
        *self = Self::default();
    }
}

fn receipt_log_count(data: &L1BlockData) -> u64 {
    data.txs
        .iter()
        .map(|(_, receipt)| receipt.logs.len() as u64)
        .sum()
}

fn overlap(wait: Instant, now: Instant, start: Instant, end: Instant) -> Duration {
    let lo = if wait > start { wait } else { start };
    let hi = if now < end { now } else { end };
    hi.saturating_duration_since(lo)
}

fn avg_ms(elapsed: Duration, count: u64) -> u64 {
    (elapsed.as_millis() / u128::from(count)) as u64
}

fn format_eta(milliseconds: u128) -> String {
    let seconds = (milliseconds / 1_000) as u64;
    if seconds >= 3_600 {
        format!(
            "{}h {}m {}s",
            seconds / 3_600,
            (seconds % 3_600) / 60,
            seconds % 60
        )
    } else if seconds >= 60 {
        format!("{}m {}s", seconds / 60, seconds % 60)
    } else if seconds > 0 {
        format!("{seconds}s")
    } else if milliseconds > 0 {
        "<1s".to_string()
    } else {
        "0s".to_string()
    }
}

struct DerivedBlock {
    number: u64,
    total: Duration,
    prewarm: Duration,
    apply: Duration,
    prune: Duration,
    index: Duration,
}

struct ReadyBlock {
    data: L1BlockData,
    fetch_started: Instant,
    fetch_done: Instant,
    hash_started: Instant,
    hash_done: Instant,
    hash_elapsed: Duration,
    _slot: OwnedSemaphorePermit,
}

enum PipelineMsg {
    Ready(Box<ReadyBlock>),
    Failed(eyre::Error),
}

struct CancelOnDrop(watch::Sender<bool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        let _ = self.0.send(true);
    }
}

async fn wait_cancel(mut rx: watch::Receiver<bool>) {
    if *rx.borrow() {
        return;
    }
    while rx.changed().await.is_ok() {
        if *rx.borrow() {
            return;
        }
    }
}

struct FetchedBlock {
    requested: u64,
    data: L1BlockData,
    fetch_started: Instant,
    fetch_done: Instant,
    _slot: OwnedSemaphorePermit,
}

/// Fetch blocks into a `pipeline_slots`-deep unapplied inventory at the
/// client's request rate, at most [`CATCHUP_FETCH_CONCURRENCY`] at once. Hash at
/// most `hash_concurrency()` at once, lowest height first.
fn spawn_catchup_pipeline(
    client: L1Client,
    start: u64,
    end: u64,
    pipeline_slots: Arc<Semaphore>,
) -> (mpsc::UnboundedReceiver<PipelineMsg>, CancelOnDrop) {
    let (tx, rx) = mpsc::unbounded_channel();
    let (fetched_tx, mut fetched_rx) = mpsc::unbounded_channel::<FetchedBlock>();
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let producer_cancel = cancel_rx.clone();
    let hasher_cancel = cancel_rx;
    let producer_tx = tx.clone();
    let producer_fetched = fetched_tx;
    let fetch_permits = Arc::new(Semaphore::new(CATCHUP_FETCH_CONCURRENCY));
    tokio::spawn(async move {
        let mut fetches: JoinSet<()> = JoinSet::new();
        let abort_join_err = |error: tokio::task::JoinError| {
            let _ = producer_tx.send(PipelineMsg::Failed(eyre::eyre!(
                "log-fetch task failed: {error}"
            )));
        };
        for n in start..=end {
            let (slot, fetching) = loop {
                tokio::select! {
                    biased;
                    () = wait_cancel(producer_cancel.clone()) => {
                        fetches.abort_all();
                        return;
                    }
                    Some(done) = fetches.join_next(), if !fetches.is_empty() => {
                        if let Err(error) = done {
                            abort_join_err(error);
                            fetches.abort_all();
                            return;
                        }
                    }
                    permits = async {
                        let slot = pipeline_slots.clone().acquire_owned().await?;
                        let fetching = fetch_permits.clone().acquire_owned().await?;
                        Ok::<_, tokio::sync::AcquireError>((slot, fetching))
                    } => match permits {
                        Ok(permits) => break permits,
                        Err(_) => return,
                    },
                }
            };
            let client = client.clone();
            let tx = producer_tx.clone();
            let fetched_tx = producer_fetched.clone();
            let fetch_cancel = producer_cancel.clone();
            fetches.spawn(async move {
                let fetch_started = Instant::now();
                let fetched = tokio::select! {
                    biased;
                    () = wait_cancel(fetch_cancel) => return,
                    result = client.block_data_by_number(n) => result,
                };
                drop(fetching);
                let fetch_done = Instant::now();
                match fetched {
                    Ok(data) => {
                        if data.header.number != n {
                            let _ = tx.send(PipelineMsg::Failed(
                                L1Error::BlockNumberMismatch {
                                    requested: n,
                                    got: data.header.number,
                                }
                                .into(),
                            ));
                            return;
                        }
                        let _ = fetched_tx.send(FetchedBlock {
                            requested: n,
                            data,
                            fetch_started,
                            fetch_done,
                            _slot: slot,
                        });
                    }
                    Err(error) => {
                        let _ = tx.send(PipelineMsg::Failed(error.into()));
                    }
                }
            });
            while let Some(done) = fetches.try_join_next() {
                if let Err(error) = done {
                    abort_join_err(error);
                    fetches.abort_all();
                    return;
                }
            }
        }
        loop {
            tokio::select! {
                biased;
                () = wait_cancel(producer_cancel.clone()) => {
                    fetches.abort_all();
                    return;
                }
                done = fetches.join_next() => {
                    match done {
                        None => return,
                        Some(Ok(())) => {}
                        Some(Err(error)) => {
                            abort_join_err(error);
                            return;
                        }
                    }
                }
            }
        }
    });

    let hasher_tx = tx;
    let hash_in_flight = pcash_l1::hash_concurrency();
    tokio::spawn(async move {
        let mut pending: BTreeMap<u64, FetchedBlock> = BTreeMap::new();
        let mut hashing: JoinSet<ReadyBlock> = JoinSet::new();
        let mut incoming_open = true;
        loop {
            while hashing.len() < hash_in_flight {
                let Some((_, fetched)) = pending.pop_first() else {
                    break;
                };
                let FetchedBlock {
                    requested: _,
                    data,
                    fetch_started,
                    fetch_done,
                    _slot,
                } = fetched;
                let hash_started = Instant::now();
                hashing.spawn_blocking(move || {
                    let cpu_started = Instant::now();
                    pcash_l1::prepare_normalized_logs(std::slice::from_ref(&data));
                    ReadyBlock {
                        data,
                        fetch_started,
                        fetch_done,
                        hash_started,
                        hash_done: Instant::now(),
                        hash_elapsed: cpu_started.elapsed(),
                        _slot,
                    }
                });
            }
            if !incoming_open && pending.is_empty() && hashing.is_empty() {
                return;
            }
            tokio::select! {
                biased;
                () = wait_cancel(hasher_cancel.clone()) => {
                    hashing.abort_all();
                    return;
                }
                msg = fetched_rx.recv(), if incoming_open => {
                    match msg {
                        Some(block) => {
                            pending.insert(block.requested, block);
                        }
                        None => incoming_open = false,
                    }
                }
                Some(done) = hashing.join_next(), if !hashing.is_empty() => {
                    match done {
                        Ok(ready) => {
                            let _ = hasher_tx.send(PipelineMsg::Ready(Box::new(ready)));
                        }
                        Err(error) => {
                            let _ = hasher_tx.send(PipelineMsg::Failed(eyre::eyre!(
                                "log-hash task failed: {error}"
                            )));
                            return;
                        }
                    }
                }
            }
        }
    });
    (rx, CancelOnDrop(cancel_tx))
}

/// A reorg whose fork point this node can no longer restore.
#[derive(Debug, thiserror::Error)]
enum UnrestorableReorg {
    #[error("reorg below pcash genesis height {0}: fatal")]
    BelowGenesis(u64),
    #[error("reorg below locally finalized height {0}: fatal")]
    BelowFinalized(u64),
}

/// The closed cause `pcash_status` reports for a fatal derivation error.
fn halt_cause(error: &eyre::Report) -> HaltCause {
    if let Some(error) = error.downcast_ref::<DeriveError>() {
        return match error {
            DeriveError::Verify(_) => HaltCause::Verifier,
            DeriveError::State(_) => HaltCause::Storage,
            DeriveError::GenesisAnchorMismatch { .. } | DeriveError::TimestampRegression { .. } => {
                HaltCause::L1Input
            }
            DeriveError::BlockNumberOverflow | DeriveError::UnresolvedBlobCarrier { .. } => {
                HaltCause::Internal
            }
        };
    }
    if error.downcast_ref::<StateError>().is_some() {
        HaltCause::Storage
    } else if error.downcast_ref::<L1Error>().is_some()
        || error.downcast_ref::<UnrestorableReorg>().is_some()
    {
        HaltCause::L1Input
    } else {
        HaltCause::Internal
    }
}

/// A state's `state` and `cause` wire names, which are also its metric labels.
fn wire_labels(state: &DerivationDto) -> (String, String) {
    let value = serde_json::to_value(state).expect("derivation state serializes");
    let name = |key: &str| {
        value
            .get(key)
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    (name("state"), name("cause"))
}

/// Every state and cause derivation can report, with no block or time attached.
fn every_state() -> Vec<DerivationDto> {
    let stalled = StallCause::ALL.map(|cause| DerivationDto::Stalled {
        cause,
        l1_block_number: 0,
        since_unix_ms: 0,
    });
    let halted = HaltCause::ALL.map(|cause| DerivationDto::Halted {
        cause,
        l1_block_number: 0,
        since_unix_ms: 0,
    });
    std::iter::once(DerivationDto::Following { since_unix_ms: 0 })
        .chain(stalled)
        .chain(halted)
        .collect()
}

/// Publish `entered` as the current state and zero every state in `left`.
fn publish_state(metrics: &dyn Metrics, left: &[DerivationDto], entered: &DerivationDto) {
    let left: Vec<_> = left.iter().map(wire_labels).collect();
    let left: Vec<_> = left
        .iter()
        .map(|(state, cause)| DerivationStateName { state, cause })
        .collect();
    let (state, cause) = wire_labels(entered);
    metrics.set_derivation_state(
        &left,
        DerivationStateName {
            state: &state,
            cause: &cause,
        },
        entered.since_unix_ms() / 1000,
    );
}

const RPC_RETRY_DELAY: Duration = Duration::from_secs(1);

/// The derivation state `pcash_status` and the metrics report, plus the backoff
/// between L1 RPC retries. A state's clock restarts only when the state changes.
struct Derivation {
    inner: Arc<Mutex<NodeInner>>,
    reported: Arc<RwLock<DerivationDto>>,
    /// Reads the committed status this follower publishes after each commit.
    status: NodeHandle,
    metrics: Arc<dyn Metrics>,
    state: DerivationDto,
    retry_delay: Duration,
}

impl Derivation {
    /// Adopt the node's reported state and publish it. Every other state is
    /// zeroed first: a restart is how a halt is cleared, and the series the
    /// previous process left at 1 would otherwise outlive it.
    fn new(inner: &Arc<Mutex<NodeInner>>, metrics: &Arc<dyn Metrics>) -> Self {
        let reported = inner.lock().unwrap().derivation.clone();
        let state = *reported.read().unwrap();
        publish_state(metrics.as_ref(), &every_state(), &state);
        Self {
            inner: Arc::clone(inner),
            reported,
            status: NodeHandle::new(Arc::clone(inner)),
            metrics: Arc::clone(metrics),
            state,
            retry_delay: RPC_RETRY_DELAY,
        }
    }

    /// The first L1 block not yet derived.
    fn next_l1_block(&self) -> u64 {
        let g = self.inner.lock().unwrap();
        g.head
            .map_or(g.source.genesis_l1_block, |head| head.saturating_add(1))
    }

    /// Publish the progress gauges and the status at this commit. A halted node
    /// serves that status if its canonical store can no longer be read.
    fn publish_progress(&self, l1_head: u64) {
        {
            let g = self.inner.lock().unwrap();
            // The follow that derives block zero has no tip to report yet.
            let Some(tip) = g.state.canonical_tip_summary() else {
                return;
            };
            let derived = g.head.unwrap_or(g.source.genesis_l1_block);
            self.metrics.set_derivation_progress(DerivationProgress {
                derived_l1_block: derived,
                l1_head,
                finalized_l1_block: g.l1_finalized.min(derived),
                pcash_tip: tip.number,
                pcash_finalized: g.finalized_block(),
            });
            publish_index_progress(&g, &self.metrics);
        }
        self.status.publish_status();
    }

    fn enter(&mut self, next: DerivationDto) {
        *self.reported.write().unwrap() = next;
        publish_state(self.metrics.as_ref(), &[self.state], &next);
        if matches!(
            self.state,
            DerivationDto::Stalled {
                cause: StallCause::L1Rpc,
                ..
            }
        ) {
            self.retry_delay = RPC_RETRY_DELAY;
        }
        self.state = next;
    }

    fn following(&mut self) {
        match self.state {
            DerivationDto::Following { .. } => return,
            DerivationDto::Stalled {
                cause,
                l1_block_number,
                ..
            } => tracing::info!(?cause, l1_block_number, "derivation resumed"),
            DerivationDto::Halted { .. } => {}
        }
        self.enter(DerivationDto::Following {
            since_unix_ms: now_unix_ms(),
        });
    }

    fn stalled(&mut self, cause: StallCause) {
        let l1_block_number = self.next_l1_block();
        if matches!(
            self.state,
            DerivationDto::Stalled { cause: current, l1_block_number: block, .. }
                if current == cause && block == l1_block_number
        ) {
            return;
        }
        self.enter(DerivationDto::Stalled {
            cause,
            l1_block_number,
            since_unix_ms: now_unix_ms(),
        });
    }

    /// The raw error goes only to the log: its text can carry an RPC credential.
    fn halted(&mut self, error: &eyre::Report) {
        let cause = halt_cause(error);
        let l1_block_number = self.next_l1_block();
        tracing::error!(
            error = %format_args!("{error:#}"),
            ?cause,
            l1_block_number,
            "derivation halted; committed state stays readable until the node is restarted"
        );
        // A failure after the commit skipped that block's publish.
        self.status.publish_status();
        self.enter(DerivationDto::Halted {
            cause,
            l1_block_number,
            since_unix_ms: now_unix_ms(),
        });
    }

    async fn wait(&mut self, error: &eyre::Report, next_block: u64) {
        self.stalled(StallCause::L1Rpc);
        tracing::warn!(%error, next_block, retry_seconds = self.retry_delay.as_secs(),
            "L1 RPC read failed; derivation paused, retrying");
        tokio::time::sleep(self.retry_delay).await;
        self.retry_delay = (self.retry_delay * 2).min(Duration::from_mins(1));
    }
}

/// Drive `following` until it returns or `stop` resolves. A fatal derivation
/// error is held until `stop`, so the caller's listeners keep serving the halted
/// node's committed state; the error is then returned.
pub async fn follow_until_stopped(
    following: impl Future<Output = eyre::Result<()>>,
    stop: impl Future,
) -> eyre::Result<()> {
    tokio::pin!(following, stop);
    tokio::select! {
        result = &mut following => {
            if result.is_err() {
                stop.await;
            }
            result
        }
        _ = &mut stop => Ok(()),
    }
}

/// Follow the L1 `latest` head until `target` is reached, or indefinitely.
/// Upstream outages and `null` reads pause derivation and retry; malformed input
/// and derivation errors are fatal and leave the node reporting `halted`.
/// `mempool` and `metrics` are non-consensus observers.
pub async fn run_follow<V: Verifier>(
    inner: Arc<Mutex<NodeInner>>,
    follower: Follower,
    verifier: V,
    target: Option<u64>,
    poll_interval: Duration,
    beacon: Arc<BeaconClient>,
    mempool: Option<Arc<MempoolService>>,
    metrics: Arc<dyn Metrics>,
) -> eyre::Result<()> {
    run_follow_with_catchup(
        inner,
        follower,
        verifier,
        target,
        poll_interval,
        beacon,
        mempool,
        metrics,
        DEFAULT_CATCHUP_FETCH_QUEUE,
    )
    .await
}

/// [`run_follow`] with an operator catch-up fetch inventory.
pub async fn run_follow_with_catchup<V: Verifier>(
    inner: Arc<Mutex<NodeInner>>,
    mut follower: Follower,
    verifier: V,
    target: Option<u64>,
    poll_interval: Duration,
    beacon: Arc<BeaconClient>,
    mempool: Option<Arc<MempoolService>>,
    metrics: Arc<dyn Metrics>,
    fetch_queue: usize,
) -> eyre::Result<()> {
    if fetch_queue == 0 {
        eyre::bail!("catch-up fetch queue must be positive");
    }
    let mut derivation = Derivation::new(&inner, &metrics);
    tracing::info!(
        threads = pcash_l1::hash_concurrency(),
        fetch_queue,
        "catch-up pipeline"
    );
    let pipeline_slots = Arc::new(Semaphore::new(fetch_queue));
    loop {
        let result = follow_until_error(
            &inner,
            &mut follower,
            &verifier,
            target,
            poll_interval,
            &beacon,
            mempool.as_deref(),
            &metrics,
            &mut derivation,
            pipeline_slots.clone(),
        )
        .await;
        match result {
            Err(error)
                if error
                    .downcast_ref::<L1Error>()
                    .is_some_and(L1Error::is_retryable) =>
            {
                // Only RPC reads can reach this branch. Their failures leave the
                // cursor at the next unapplied block; dropping the inner future
                // also cancels speculative prefetch work before the next refresh.
                observe_l1_head(&inner, None);
                derivation.wait(&error, follower.cursor()).await;
            }
            Err(error) => {
                derivation.halted(&error);
                return Err(error);
            }
            Ok(()) => return Ok(()),
        }
    }
}

async fn follow_until_error<V: Verifier>(
    inner: &Arc<Mutex<NodeInner>>,
    follower: &mut Follower,
    verifier: &V,
    target: Option<u64>,
    poll_interval: Duration,
    beacon: &BeaconClient,
    mempool: Option<&MempoolService>,
    metrics: &Arc<dyn Metrics>,
    derivation: &mut Derivation,
    pipeline_slots: Arc<Semaphore>,
) -> eyre::Result<()> {
    // The rules and the state's derivation source are fixed for the life of the
    // node; capture them once so each block's proof prewarming (below) can run
    // without holding the node lock.
    let (rules, source) = {
        let g = inner.lock().unwrap();
        (Arc::clone(&g.rules), g.source)
    };
    let mut stats = DerivationStats::default();
    'follow: loop {
        follower.refresh_head().await?;
        // Always derive up to the unfinalized head. `finalized` is NOT advanced
        // here: raising `l1_finalized` to the freshly-observed tag before any
        // block is derived lets a stalled node wake, jump finality ahead of its
        // reconciled head, and then fatally reject a reorg whose fork point is
        // still restorable. It advances only behind a derived block, below.
        let ceiling = follower.head();
        observe_l1_head(inner, Some(ceiling));
        // Every retry re-enters here, so lag keeps moving while derivation is
        // stalled. The head is published before the finality read so that read
        // failing on its own cannot freeze it.
        derivation.publish_progress(ceiling);
        follower.refresh_finalized().await?;
        let derive_ceiling = target.map_or(ceiling, |t| ceiling.min(t));

        // Catch-up: fetch workers keep up to `fetch_queue` unapplied blocks
        // filled at the client's request rate. Hash and apply consume that
        // inventory in cursor order. A reorg or blob retry drops the pipeline.
        if follower.cursor().saturating_add(CATCHUP_WINDOW) <= derive_ceiling {
            let start = follower.cursor();
            let (mut incoming, cancel) = spawn_catchup_pipeline(
                follower.client().clone(),
                start,
                derive_ceiling,
                pipeline_slots.clone(),
            );
            let mut ready: HashMap<u64, ReadyBlock> = HashMap::new();
            enum CatchupStop {
                Reorg(Reorg),
                BlobRetry {
                    number: u64,
                    parent: alloy_primitives::B256,
                    error: BlobError,
                },
                AtHead,
            }
            let stop = loop {
                if follower.cursor() > derive_ceiling {
                    break None;
                }
                let cursor = follower.cursor();
                let wait_started = stats.begin_wait();
                let block = loop {
                    if let Some(block) = ready.remove(&cursor) {
                        break block;
                    }
                    match incoming.recv().await {
                        Some(PipelineMsg::Ready(block)) => {
                            ready.insert(block.data.header.number, *block);
                        }
                        Some(PipelineMsg::Failed(error)) => return Err(error),
                        None => {
                            eyre::bail!("catch-up pipeline closed before L1 block {cursor}")
                        }
                    }
                };
                let stall = wait_started.elapsed();
                if !stall.is_zero() {
                    metrics.record_rpc_wait(stall);
                }
                stats.add_cursor_stall(wait_started, &block);
                stats.add_hash_wait(block.hash_elapsed);
                stats.add_fetch_wait(
                    block
                        .fetch_done
                        .saturating_duration_since(block.fetch_started),
                );
                stats.add_logs(receipt_log_count(&block.data));
                let ReadyBlock {
                    data,
                    hash_elapsed: _,
                    _slot,
                    ..
                } = block;
                if data.header.number != cursor {
                    eyre::bail!(
                        "prefetched L1 block {} does not match cursor {}",
                        data.header.number,
                        cursor
                    );
                }
                match follower.accept_prefetched(data) {
                    Step::Block(mut data) => {
                        if let Err(error) =
                            beacon.resolve_block(&mut data, source.inbox_address).await
                        {
                            match error {
                                error @ BlobError::Unavailable { .. } => {
                                    break Some(CatchupStop::BlobRetry {
                                        number: data.header.number,
                                        parent: data.header.parent_hash,
                                        error,
                                    });
                                }
                                error => return Err(error.into()),
                            }
                        }
                        let derived = apply_derived_block(
                            inner,
                            verifier,
                            &rules,
                            &source,
                            &data,
                            follower.finalized(),
                            mempool,
                            DeriveMode::Catchup,
                            metrics,
                            target.is_some_and(|t| data.header.number >= t),
                        )?;
                        derivation.following();
                        let n = derived.number;
                        stats.record(derived, ceiling);
                        derivation.publish_progress(ceiling);
                        tokio::task::yield_now().await;
                        if let Some(t) = target {
                            if n >= t {
                                stats.flush();
                                return Ok(());
                            }
                        }
                    }
                    Step::Reorg(reorg) => break Some(CatchupStop::Reorg(reorg)),
                    Step::AtHead => break Some(CatchupStop::AtHead),
                }
            };
            drop(cancel);
            drop(incoming);
            drop(ready);
            match stop {
                None => {
                    // Do not hide a short final group when catch-up reaches the
                    // observed head. Steady-state blocks begin a fresh 25-block group.
                    stats.flush();
                }
                Some(CatchupStop::AtHead) => {
                    stats.flush();
                    continue 'follow;
                }
                Some(CatchupStop::Reorg(reorg)) => {
                    stats.discard();
                    handle_reorg_inner(inner, follower, reorg, mempool, metrics).await?;
                    derivation.publish_progress(follower.head());
                    continue 'follow;
                }
                Some(CatchupStop::BlobRetry {
                    number,
                    parent,
                    error,
                }) => {
                    stats.discard();
                    follower.rewind_to(number, Some(parent));
                    derivation.stalled(StallCause::Blobs);
                    tracing::warn!(
                        %error,
                        block = number,
                        "PCASH blob data unavailable; refreshing canonical L1 before retry"
                    );
                    tokio::time::sleep(poll_interval).await;
                    continue 'follow;
                }
            }
        }

        // Steady state (at / near the head): fetch and apply one block at a time.
        while follower.cursor() <= derive_ceiling {
            let fetch_started = stats.begin_wait();
            let step = follower.next().await?;
            let fetch_elapsed = fetch_started.elapsed();
            stats.add_rpc_wait(fetch_elapsed);
            metrics.record_rpc_wait(fetch_elapsed);
            match step {
                Step::Block(mut data) => {
                    if let Err(error) = beacon.resolve_block(&mut data, source.inbox_address).await
                    {
                        match error {
                            error @ BlobError::Unavailable { .. } => {
                                stats.discard();
                                follower
                                    .rewind_to(data.header.number, Some(data.header.parent_hash));
                                derivation.stalled(StallCause::Blobs);
                                tracing::warn!(
                                    %error,
                                    block = data.header.number,
                                    "PCASH blob data unavailable; refreshing canonical L1 before retry"
                                );
                                tokio::time::sleep(poll_interval).await;
                                continue 'follow;
                            }
                            error => return Err(error.into()),
                        }
                    }
                    stats.add_fetch_wait(fetch_elapsed);
                    stats.add_logs(receipt_log_count(&data));
                    let derived = apply_derived_block(
                        inner,
                        verifier,
                        &rules,
                        &source,
                        &data,
                        follower.finalized(),
                        mempool,
                        DeriveMode::Steady,
                        metrics,
                        target.is_some_and(|t| data.header.number >= t),
                    )?;
                    derivation.following();
                    let n = derived.number;
                    stats.record(derived, ceiling);
                    derivation.publish_progress(ceiling);
                    if let Some(t) = target {
                        if n >= t {
                            stats.flush();
                            return Ok(());
                        }
                    }
                }
                Step::Reorg(reorg) => {
                    stats.discard();
                    handle_reorg_inner(inner, follower, reorg, mempool, metrics).await?;
                    derivation.publish_progress(follower.head());
                }
                Step::AtHead => break,
            }
        }

        // Past the ceiling the loop above does not call `next`, and no later
        // block shows a reorg that replaced the last derived block at its own
        // height, so compare that block's hash on every poll.
        if follower.cursor() > derive_ceiling {
            if let Step::Reorg(reorg) = follower.recheck_last_yielded().await? {
                stats.discard();
                handle_reorg_inner(inner, follower, reorg, mempool, metrics).await?;
                derivation.publish_progress(follower.head());
                continue 'follow;
            }
        }

        if let Some(t) = target {
            if follower.cursor() > t {
                return Ok(());
            }
        }
        derivation.following();
        tokio::time::sleep(poll_interval).await;
    }
}

/// Reuse committed effects as conflict inputs. Only accepted bytes reach the
/// authorization tag read; a direct creation keeps its special state-invalidation
/// path because its account is authorized by its L1 carrier.
pub(crate) fn mempool_conflict_effects<'a>(
    effects: &'a [pcash_state::TransactionEffects],
    transaction_bytes: &[Vec<u8>],
) -> Vec<&'a pcash_state::AcceptedEffects> {
    effects
        .iter()
        .zip(transaction_bytes)
        .filter_map(|(effects, raw)| effects.accepted().map(|effects| (effects, raw)))
        .filter(|(_, raw)| !pcash_derive::transaction::is_direct_account_creation(raw))
        .map(|(effects, _)| effects)
        .collect()
}

/// Derive one already-fetched block into the canonical state and advance finality,
/// then return its block number (for the `target` check). Shared verbatim by the
/// serial and pipelined catch-up paths so their derivation is byte-for-byte
/// identical.
fn apply_derived_block<V: Verifier>(
    inner: &Arc<Mutex<NodeInner>>,
    verifier: &V,
    rules: &ProtocolRules,
    source: &DerivationSource,
    data: &L1BlockData,
    finalized: u64,
    mempool: Option<&MempoolService>,
    mode: DeriveMode,
    metrics: &Arc<dyn Metrics>,
    force_durable: bool,
) -> eyre::Result<DerivedBlock> {
    let n = data.header.number;
    let total_started = Instant::now();
    // Prewarm before the derivation lock; the complete cache below must not
    // invoke the verifier backend on a miss.
    let prewarm_started = Instant::now();
    let prepared = pcash_derive::prepare_block(data, rules, source, verifier);
    let prewarm = prewarm_started.elapsed();
    let apply_started = Instant::now();
    let (
        outcome,
        index,
        verification,
        can_index,
        apply,
        prune,
        block,
        accepted_content_hashes,
        lifecycle_finalized,
        index_durable,
    ) = {
        let mut g = inner.lock().unwrap();
        // Prewarm verified every proof execution can reach. Cache misses fail
        // closed here instead of spawning the inner verifier while the global
        // state lock is held.
        let cached = CachedVerifier::new_complete(prepared.cache(), verifier);
        let can_index = matches!(g.index_lifecycle(), DerivedIndexLifecycle::Ready(_))
            || g.state.canonical_tip_summary().is_none();
        // L1-finalized catch-up blocks cannot reorg, so skip the per-block
        // savepoint/fsync. A later prune checkpoint (or the first near-head
        // persist) makes the batch durable.
        let catchup = finalized >= n;
        g.state.set_persist_reorg_savepoint(!catchup);
        let checkpoint = !catchup
            || g.head.is_none()
            || n.saturating_sub(g.l1_finalized) >= CATCHUP_DURABLE_INTERVAL
            || force_durable;
        let outcome = g.apply_prepared_block(&prepared, &cached)?;
        let committed = &outcome.committed_boundary;
        let mut accepted = 0u64;
        for result in &committed.block.transaction_results {
            if result.outcome.is_succeeded() {
                accepted += 1;
            } else {
                metrics.record_skipped_entry(&wire_name(result.outcome));
            }
        }
        for item in committed
            .history
            .l1_delivery_batches
            .iter()
            .flat_map(|batch| &batch.items)
        {
            if let Some(reason) = item.exclusion_reason {
                metrics.record_skipped_entry(&wire_name(reason));
            }
        }
        metrics.record_accepted_entries(accepted);
        metrics.record_carriers(committed.history.l1_delivery_batches.len() as u64);
        let accepted_content_hashes: Vec<alloy_primitives::B256> = committed
            .block
            .transaction_results
            .iter()
            .filter(|result| result.outcome.is_succeeded())
            .map(|result| {
                pcash_state::admitted_delivery(&committed.history.l1_delivery_batches, result)
                    .expect("admitted transaction has a delivery manifest item")
                    .1
                    .content_hash
            })
            .collect();
        let block = BlockId {
            block_number: outcome.committed_boundary.block.header.number,
            block_hash: outcome.committed_boundary.block.hash,
        };
        let apply = apply_started.elapsed();
        // Clamp the prune height to the just-derived head: during catch-up the L1
        // `finalized` tag runs ahead of the head, and pruning to the raw finalized
        // would delete the head's own savepoint and empty the L1 block-hash trail,
        // breaking reorg recovery. This clamped height is also the ONLY place `l1_finalized`
        // advances (inside `prune_finalized`): parent-linked derivation up to `n`
        // is what reconciles the hash trail, so finality — the reorg walk-back
        // bound and the `pcash_status` report — never runs ahead of a block
        // actually derived (finalized <= head always).
        let fin = finalized.min(n);
        // A prune failure is non-fatal: the redb index is mutated only
        // post-commit, so pruning self-heals next tick. Catch-up checkpoints
        // on an interval instead of every block so persist can stay
        // non-durable between them.
        let prune = if checkpoint {
            let prune_started = Instant::now();
            if let Err(e) = g.prune_finalized(fin) {
                if force_durable {
                    return Err(e.into());
                }
                tracing::warn!(finalized = fin, error = %e, "prune failed; retrying next tick");
                metrics.record_prune_failure();
            }
            prune_started.elapsed()
        } else {
            Duration::ZERO
        };
        let finalized_pcash = g.finalized_block();
        let lifecycle_finalized = g
            .state
            .canonical_stored_block(finalized_pcash)?
            .map(|block| (block.header.number, block.header.timestamp));
        (
            outcome,
            g.index.clone(),
            g.contract_verification.clone(),
            can_index,
            apply,
            prune,
            block,
            accepted_content_hashes,
            lifecycle_finalized,
            checkpoint,
        )
    };
    let index_started = Instant::now();
    if can_index {
        let result = NodeInner::apply_index_block(
            &index,
            source,
            verification.as_deref(),
            &outcome.committed_boundary,
            &outcome.transaction_effects.iter().collect::<Vec<_>>(),
            &outcome.l1_logs,
            index_durable,
        );
        if result.is_err() {
            metrics.record_index_write_failure();
        }
        let durable_index_error = force_durable
            .then(|| result.as_ref().err().map(ToString::to_string))
            .flatten();
        inner.lock().unwrap().record_index_result(result);
        if let Some(error) = durable_index_error {
            eyre::bail!("durable index checkpoint failed: {error}");
        }
    }
    let index_ms = index_started.elapsed();
    if let Some(mempool) = mempool {
        if let Err(error) = mempool.on_applied_block(
            block,
            &accepted_content_hashes,
            &mempool_conflict_effects(
                &outcome.transaction_effects,
                &outcome.committed_boundary.block.transaction_bytes,
            ),
        ) {
            tracing::warn!(block = n, %error, "mempool applied-block update failed");
        }
        if let Some((finalized, timestamp)) = lifecycle_finalized {
            if let Err(error) = mempool.on_finalized(finalized, timestamp) {
                tracing::warn!(finalized, %error, "mempool finalization update failed");
            }
        }
    }
    let total = total_started.elapsed();
    metrics.record_derived_block(pcash_metrics::DerivedBlockSample {
        mode,
        total,
        prewarm,
        apply,
        prune,
    });
    tracing::debug!(
        block = n,
        prewarm_ms = prewarm.as_millis() as u64,
        apply_ms = apply.as_millis() as u64,
        prune_ms = prune.as_millis() as u64,
        index_ms = index_ms.as_millis() as u64,
        total_ms = total.as_millis() as u64,
        "derived L1 block"
    );
    Ok(DerivedBlock {
        number: n,
        total,
        prewarm,
        apply,
        prune,
        index: index_ms,
    })
}

/// Walk back on block hashes to the deepest still-canonical block, restore the
/// latest savepoint at or below that height, and rewind the follower to re-derive
/// forward.
///
/// `pub` so the integrated reorg test can drive one step of the loop with full
/// determinism; it is otherwise an internal helper of [`run_follow`].
pub async fn handle_reorg(
    inner: &Arc<Mutex<NodeInner>>,
    follower: &mut Follower,
    reorg: Reorg,
) -> eyre::Result<()> {
    let metrics = pcash_metrics::noop();
    handle_reorg_inner(inner, follower, reorg, None, &metrics).await
}

async fn handle_reorg_inner(
    inner: &Arc<Mutex<NodeInner>>,
    follower: &mut Follower,
    reorg: Reorg,
    mempool: Option<&MempoolService>,
    metrics: &Arc<dyn Metrics>,
) -> eyre::Result<()> {
    let (finalized, genesis) = {
        let g = inner.lock().unwrap();
        (g.l1_finalized, g.source.genesis_l1_block)
    };
    tracing::warn!(
        at = reorg.at_number,
        expected_parent = %reorg.expected_parent,
        actual_parent = %reorg.actual_parent,
        "L1 reorg detected; walking back on block hashes"
    );

    let mut k = reorg.at_number.saturating_sub(1);
    let anchor = loop {
        // Nothing below the pcash genesis height was ever derived, so there is no
        // stored block hash to match and no savepoint to restore; walking below
        // genesis is a fatal halt, not an underflowing loop of sub-genesis
        // block fetches (`k -= 1` on a `u64`). This bound matters when the L1
        // `finalized` tag is below genesis (e.g. a fresh chain reporting 0).
        if k < genesis {
            return Err(UnrestorableReorg::BelowGenesis(genesis).into());
        }
        // The savepoint (and block hash) AT finalized is retained, so a fork
        // point exactly at finalized is restorable; only strictly-below-finalized
        // has nothing to restore and is fatal.
        if k < finalized {
            return Err(UnrestorableReorg::BelowFinalized(finalized).into());
        }
        // Header-only fetch: the walk-back reads only this height's hash to compare
        // against the stored trail, so pulling full transaction bodies + receipts
        // (`block_by_number`) would be pure waste.
        let canonical_hash = follower.client().block_hash_by_number(k).await?;
        let stored = { inner.lock().unwrap().block_hashes.get(&k).copied() };
        if stored == Some(canonical_hash) {
            break canonical_hash;
        }
        k -= 1;
    };

    let (restore, restore_hash, restored_pcash_height) = {
        let mut g = inner.lock().unwrap();
        let (restore, restore_hash) =
            if g.head == Some(k) {
                (k, anchor)
            } else {
                let restore = g.state.latest_savepoint_at_or_below(k).ok_or_else(|| {
                    eyre::eyre!("reorg has no restorable savepoint at or below {k}")
                })?;
                let hash = g.block_hashes.get(&restore).copied().ok_or_else(|| {
                    eyre::eyre!("missing block hash for restore height {restore}")
                })?;
                (restore, hash)
            };
        g.rollback_to(restore)?;
        (restore, restore_hash, g.latest_block())
    };
    if let Some(mempool) = mempool {
        if let Err(error) = mempool.on_rollback(restored_pcash_height) {
            tracing::warn!(restored_to = restore, %error, "mempool rollback update failed");
        }
    }
    follower.rewind_to(restore + 1, Some(restore_hash));
    metrics.record_reorg(reorg.at_number.saturating_sub(k));
    tracing::warn!(restored_to = restore, "reorg handled; re-deriving forward");
    Ok(())
}

fn observe_l1_head(inner: &Arc<Mutex<NodeInner>>, l1_head: Option<u64>) {
    let g = inner.lock().unwrap();
    *g.observed_l1_block_number.write().unwrap() = l1_head;
}

/// Publish the derived index's cursor height and whether it follows the tip.
pub(crate) fn publish_index_progress(node: &NodeInner, metrics: &Arc<dyn Metrics>) {
    let cursor = node
        .index
        .cursor()
        .ok()
        .flatten()
        .map_or(0, |cursor| cursor.pcash_number);
    let ready = matches!(node.index_lifecycle(), DerivedIndexLifecycle::Ready(_));
    metrics.set_index_progress(cursor, ready);
}

/// The camelCase wire name of a unit enum variant. Skip labels come from the
/// closed outcome and exclusion enums, so the label set stays bounded.
fn wire_name(value: impl serde::Serialize) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(name)) => name,
        _ => unreachable!("unit enum variants serialize as strings"),
    }
}

#[cfg(test)]
mod halt_cause_tests {
    use super::{halt_cause, UnrestorableReorg};
    use eyre::WrapErr;
    use pcash_derive::DeriveError;
    use pcash_l1::L1Error;
    use pcash_rpc::HaltCause;
    use pcash_state::StateError;
    use pcash_verify::VerifyError;

    #[test]
    fn fatal_errors_map_to_the_closed_cause_set() {
        let verifier = DeriveError::Verify(VerifyError::Abnormal {
            exit: "1".into(),
            stdout: String::new(),
            stderr: String::new(),
        });
        assert_eq!(halt_cause(&verifier.into()), HaltCause::Verifier);

        let commit = DeriveError::State(StateError::Backend("no space left on device".into()));
        assert_eq!(halt_cause(&commit.into()), HaltCause::Storage);
        let rollback = StateError::SavepointNotFound(7);
        assert_eq!(halt_cause(&rollback.into()), HaltCause::Storage);

        let regression = DeriveError::TimestampRegression {
            block: 7,
            parent_ts: 2,
            ts: 1,
        };
        assert_eq!(halt_cause(&regression.into()), HaltCause::L1Input);
        let reorg = UnrestorableReorg::BelowFinalized(7);
        assert_eq!(halt_cause(&reorg.into()), HaltCause::L1Input);
        // A context added on the way up does not hide the cause.
        let malformed: eyre::Result<()> = Err(L1Error::Rpc("bad response".into()).into());
        let malformed = malformed.wrap_err("fetch L1 block").unwrap_err();
        assert_eq!(halt_cause(&malformed), HaltCause::L1Input);

        let pipeline = eyre::eyre!("catch-up pipeline closed before L1 block 7");
        assert_eq!(halt_cause(&pipeline), HaltCause::Internal);
        assert_eq!(
            halt_cause(&DeriveError::BlockNumberOverflow.into()),
            HaltCause::Internal
        );
    }
}

#[cfg(test)]
mod mempool_effect_tests {
    use super::mempool_conflict_effects;
    use alloy_primitives::{Address, B256};
    use pcash_derive::{KIND_CONTRACT_ACCOUNT_CREATION, KIND_USER_ACCOUNT_CREATION};
    use pcash_state::{
        AcceptedEffects, AccountResult, ReceiveKeyOperation, RejectedEffects, TransactionEffects,
    };

    #[test]
    fn committed_effects_exclude_direct_creations_and_skip_short_rejections() {
        let creation = |kind| AcceptedEffects {
            kind,
            output_leaf_start: None,
            output_commitments: Vec::new(),
            nullifiers: vec![B256::repeat_byte(1)],
            account: Some(AccountResult::User {
                address: Address::repeat_byte(2),
                revision: 1,
                receive_key: ReceiveKeyOperation::Keep,
                prior_state: None,
            }),
            payout: None,
        };
        let rejected = || {
            TransactionEffects::Rejected(RejectedEffects {
                account: None,
                detail: None,
            })
        };
        let effects = vec![
            rejected(),
            rejected(),
            TransactionEffects::Accepted(creation(KIND_USER_ACCOUNT_CREATION)),
            TransactionEffects::Accepted(creation(KIND_USER_ACCOUNT_CREATION)),
            TransactionEffects::Accepted(creation(KIND_CONTRACT_ACCOUNT_CREATION)),
        ];
        let raw = |kind, authorization| {
            let mut raw = vec![0; pcash_derive::transaction::ENVELOPE_BYTES + 1];
            raw[0] = kind;
            raw[pcash_derive::transaction::ENVELOPE_BYTES] = authorization;
            raw
        };
        let bytes = vec![
            Vec::new(),
            vec![KIND_USER_ACCOUNT_CREATION],
            raw(KIND_USER_ACCOUNT_CREATION, 0),
            raw(KIND_USER_ACCOUNT_CREATION, 1),
            raw(KIND_CONTRACT_ACCOUNT_CREATION, 1),
        ];
        let retained = mempool_conflict_effects(&effects, &bytes);
        assert_eq!(retained.len(), 2);
        assert!(std::ptr::eq(retained[0], effects[3].accepted().unwrap()));
        assert!(std::ptr::eq(retained[1], effects[4].accepted().unwrap()));
    }
}
