//! Injectable node metrics.
//!
//! [`NoopMetrics`] is the default: every method is a no-op. [`PrometheusMetrics`]
//! records the same events into a `pcash_node_*` registry and serves them at
//! `/metrics`. Call sites take [`Arc<dyn Metrics>`] so a process that never
//! binds the operator port pays nothing on the follow and admission paths.
//!
//! A Grafana dashboard for this scrape is `dashboards/pcash-node.json` in this crate.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use prometheus_client::encoding::{EncodeLabelSet, EncodeLabelValue, LabelValueEncoder};
use prometheus_client::metrics::counter::Counter;
use prometheus_client::metrics::family::Family;
use prometheus_client::metrics::gauge::Gauge;
use prometheus_client::metrics::histogram::{exponential_buckets, Histogram};
use prometheus_client::registry::{Registry, Unit};

const EVICTION_REASONS: &[&str] = &["ttl", "finalized", "capacity"];
const SUSPEND_CAUSES: &[&str] = &["superseded", "invalidated", "state"];
const P2P_BUDGETS: &[&str] = &["publisher", "propagation", "node"];

fn intern<'a>(known: &[&'a str], value: &str) -> Option<&'a str> {
    known.iter().copied().find(|item| *item == value)
}

fn intern_or_other<'a>(known: &[&'a str], value: &str) -> &'a str {
    intern(known, value).unwrap_or("other")
}

/// Catch-up vs near-head derivation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DeriveMode {
    Catchup,
    Steady,
}

impl DeriveMode {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Catchup => "catchup",
            Self::Steady => "steady",
        }
    }
}

impl EncodeLabelValue for DeriveMode {
    fn encode(&self, encoder: &mut LabelValueEncoder<'_>) -> Result<(), std::fmt::Error> {
        EncodeLabelValue::encode(&self.as_str(), encoder)
    }
}

/// RPC vs P2P admission.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AdmissionSource {
    Rpc,
    P2p,
}

impl AdmissionSource {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Rpc => "rpc",
            Self::P2p => "p2p",
        }
    }
}

impl EncodeLabelValue for AdmissionSource {
    fn encode(&self, encoder: &mut LabelValueEncoder<'_>) -> Result<(), std::fmt::Error> {
        EncodeLabelValue::encode(&self.as_str(), encoder)
    }
}

/// Closed admission outcomes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AdmissionOutcome {
    Policy,
    Accepted,
    Duplicate,
    Invalid,
    State,
    Full,
    Verification,
    Busy,
    Unavailable,
    Storage,
}

impl AdmissionOutcome {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Duplicate => "duplicate",
            Self::Invalid => "invalid",
            Self::State => "state",
            Self::Policy => "policy",
            Self::Full => "full",
            Self::Verification => "verification",
            Self::Busy => "busy",
            Self::Unavailable => "unavailable",
            Self::Storage => "storage",
        }
    }

    const fn all() -> [Self; 10] {
        [
            Self::Policy,
            Self::Accepted,
            Self::Duplicate,
            Self::Invalid,
            Self::State,
            Self::Full,
            Self::Verification,
            Self::Busy,
            Self::Unavailable,
            Self::Storage,
        ]
    }
}

impl EncodeLabelValue for AdmissionOutcome {
    fn encode(&self, encoder: &mut LabelValueEncoder<'_>) -> Result<(), std::fmt::Error> {
        EncodeLabelValue::encode(&self.as_str(), encoder)
    }
}

/// Canonical progress gauges.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DerivationProgress {
    pub derived_l1_block: u64,
    pub l1_head: u64,
    pub finalized_l1_block: u64,
    pub pcash_tip: u64,
    pub pcash_finalized: u64,
}

/// One derivation state by its wire names. `cause` is empty while following.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DerivationStateName<'a> {
    pub state: &'a str,
    pub cause: &'a str,
}

/// One successfully derived L1 block's timing.
#[derive(Clone, Copy, Debug)]
pub struct DerivedBlockSample {
    pub mode: DeriveMode,
    pub total: Duration,
    pub prewarm: Duration,
    pub apply: Duration,
    pub prune: Duration,
}

/// Current local mempool occupancy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MempoolOccupancy {
    pub ready: u64,
    pub included_unfinalized: u64,
    pub suspended: u64,
    pub bytes: u64,
    pub unpaid_entries: u64,
    pub max_entries: u64,
    pub max_bytes: u64,
    pub max_unpaid_entries: u64,
}

/// Events the node can record. Default methods are no-ops so [`NoopMetrics`] is
/// an empty impl and tests never have to stub unused methods.
pub trait Metrics: Send + Sync {
    fn set_info(&self, _chain_id: u32) {}
    fn set_derivation_progress(&self, _progress: DerivationProgress) {}
    /// Derivation entered a state at `since_unix_seconds`. Every state in `left`
    /// reads 0: the one just left, or at startup all of them.
    fn set_derivation_state(
        &self,
        _left: &[DerivationStateName<'_>],
        _entered: DerivationStateName<'_>,
        _since_unix_seconds: u64,
    ) {
    }
    fn set_data_dir_free_bytes(&self, _bytes: u64) {}
    fn set_index_progress(&self, _cursor: u64, _ready: bool) {}
    fn record_index_write_failure(&self) {}
    fn record_derived_block(&self, _sample: DerivedBlockSample) {}
    fn record_rpc_wait(&self, _duration: Duration) {}
    fn record_accepted_entries(&self, _count: u64) {}
    fn record_skipped_entry(&self, _reason: &str) {}
    /// Carriers, Inbox transactions and carrier events, in a derived block.
    fn record_carriers(&self, _count: u64) {}
    fn record_reorg(&self, _depth: u64) {}
    fn record_prune_failure(&self) {}
    fn set_mempool_occupancy(&self, _occupancy: MempoolOccupancy) {}
    fn set_mempool_ready(&self, _ready: bool) {}
    fn record_mempool_admission(&self, _source: AdmissionSource, _outcome: AdmissionOutcome) {}
    fn record_mempool_verify(&self, _duration: Duration) {}
    fn set_mempool_admission_queue_depth(&self, _depth: u64) {}
    fn record_mempool_eviction(&self, _reason: &'static str) {}
    fn record_mempool_included(&self, _count: u64) {}
    fn record_mempool_suspended(&self, _cause: &'static str) {}
    fn record_mempool_prepare_request(&self) {}
    fn record_mempool_prepare(&self, _selected: u64, _rejected: u64) {}
    fn set_p2p_peers(&self, _count: u64) {}
    fn record_p2p_network(&self, _sample: P2pNetworkMetrics) {}
    fn record_p2p_proof_budget_drop(&self, _budget: &'static str) {}
    fn record_p2p_block_hash_divergence(&self) {}
    fn record_rpc(&self, _method: &str, _error_code: Option<i32>, _duration: Duration) {}
}

/// Gauges are snapshots; event counts are increments since the previous sample.
#[derive(Clone, Copy, Debug, Default)]
pub struct P2pNetworkMetrics {
    pub routing_peers: u64,
    pub pending_dials: u64,
    pub relay_reservations: u64,
    pub relay_circuits: u64,
    pub public: bool,
    pub relayed: bool,
    pub discovery_success: u64,
    pub discovery_failure: u64,
    pub dial_failure: u64,
    pub hole_punch_success: u64,
    pub hole_punch_failure: u64,
}

/// A recorder that drops every event.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoopMetrics;

impl Metrics for NoopMetrics {}

/// Shared no-op handle.
#[must_use]
pub fn noop() -> Arc<dyn Metrics> {
    Arc::new(NoopMetrics)
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
struct InfoLabels {
    chain_id: String,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
struct ModeLabels {
    mode: DeriveMode,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
struct DerivationStateLabels {
    state: String,
    cause: String,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
struct ReasonLabels {
    reason: String,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
struct StatusLabels {
    status: String,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
struct AdmissionLabels {
    source: AdmissionSource,
    outcome: AdmissionOutcome,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
struct PrepareLabels {
    result: String,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
struct CauseLabels {
    cause: String,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
struct BudgetLabels {
    budget: String,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
struct MethodLabels {
    method: String,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
struct RpcErrorLabels {
    method: String,
    code: String,
}

/// Declare the recorder's metrics once each. Every entry expands into a struct
/// field, its constructor, and its registration, in declaration order — which is
/// also exposition order, so moving a line moves the metric in `/metrics`.
macro_rules! declare_metrics {
    ($($field:ident: $ty:ty = $init:expr; $name:literal, $help:literal $(, $unit:expr)?;)*) => {
        /// Prometheus recorder. One instance per process.
        #[derive(Debug)]
        pub struct PrometheusMetrics {
            registry: Registry,
            $($field: $ty,)*
        }

        impl PrometheusMetrics {
            /// Every metric constructed and registered, with no labels seeded.
            fn registered() -> Self {
                let mut registry = Registry::with_prefix("pcash_node");
                $(let $field: $ty = $init;)*
                $(declare_metrics!(@register registry, $name, $help, $field $(, $unit)?);)*
                Self { registry, $($field,)* }
            }
        }
    };
    (@register $registry:expr, $name:literal, $help:literal, $metric:expr) => {
        $registry.register($name, $help, $metric.clone());
    };
    (@register $registry:expr, $name:literal, $help:literal, $metric:expr, $unit:expr) => {
        $registry.register_with_unit($name, $help, $unit, $metric.clone());
    };
}

declare_metrics! {
    up: Gauge = Gauge::default();
        "up", "Whether the node process is running";
    info: Family<InfoLabels, Gauge> = Family::default();
        "info", "Static node identity; value is always 1";
    derived_l1_block: Gauge = Gauge::default();
        "derived_l1_block", "Highest derived L1 block number";
    l1_head: Gauge = Gauge::default();
        "l1_head", "Observed L1 latest head";
    l1_lag_blocks: Gauge = Gauge::default();
        "l1_lag_blocks", "L1 head minus the derived L1 block";
    finalized_l1_block: Gauge = Gauge::default();
        "finalized_l1_block", "Locally applied L1 finalized height";
    pcash_tip: Gauge = Gauge::default();
        "pcash_tip", "Canonical PCASH tip height";
    pcash_finalized: Gauge = Gauge::default();
        "pcash_finalized", "Canonical PCASH finalized height";
    index_cursor: Gauge = Gauge::default();
        "index_cursor", "Derived-index PCASH cursor height";
    index_ready: Gauge = Gauge::default();
        "index_ready", "Whether the derived index follows the canonical tip";
    index_write_failures: Counter = Counter::default();
        "index_write_failures", "Failed derived-index writes, at the head or during catch-up";
    derivation_state: Family<DerivationStateLabels, Gauge> = Family::default();
        "derivation_state", "Derivation state and cause; 1 for the current one, 0 for those left";
    derivation_state_start_timestamp: Gauge = Gauge::default();
        "derivation_state_start_timestamp", "Unix time the current derivation state began", Unit::Seconds;
    data_dir_free_bytes: Gauge = Gauge::default();
        "data_dir_free", "Bytes available on the data directory's filesystem", Unit::Bytes;
    l1_blocks_derived: Family<ModeLabels, Counter> = Family::default();
        "l1_blocks_derived", "Successfully derived L1 blocks";
    derive_duration: Histogram = Histogram::new(exponential_buckets(0.001, 2.0, 16));
        "derive_duration", "Wall time to derive one L1 block", Unit::Seconds;
    derive_prewarm_duration: Histogram = Histogram::new(exponential_buckets(0.001, 2.0, 16));
        "derive_prewarm_duration", "Proof prewarm time for one L1 block", Unit::Seconds;
    derive_apply_duration: Histogram = Histogram::new(exponential_buckets(0.001, 2.0, 16));
        "derive_apply_duration", "Locked apply_block time for one L1 block", Unit::Seconds;
    derive_prune_duration: Histogram = Histogram::new(exponential_buckets(0.0001, 2.0, 16));
        "derive_prune_duration", "Finality prune time after one L1 block", Unit::Seconds;
    derive_rpc_wait_duration: Histogram = Histogram::new(exponential_buckets(0.001, 2.0, 16));
        "derive_rpc_wait_duration", "L1 fetch or prefetch wait", Unit::Seconds;
    entries_accepted: Counter = Counter::default();
        "entries_accepted", "Derived entries accepted into canonical state";
    entries_skipped: Family<ReasonLabels, Counter> = Family::default();
        "entries_skipped", "Derived entries skipped, by closed reason";
    carriers: Counter = Counter::default();
        "carriers", "Batch carriers: Inbox transactions and carrier events";
    reorgs: Counter = Counter::default();
        "reorgs", "Detected L1 reorgs";
    reorg_depth: Histogram = Histogram::new(exponential_buckets(1.0, 2.0, 8));
        "reorg_depth", "Walk-back depth of an L1 reorg", Unit::Other("blocks".to_owned());
    prune_failures: Counter = Counter::default();
        "prune_failures", "Non-fatal finalized prune failures";
    mempool_entries: Family<StatusLabels, Gauge> = Family::default();
        "mempool_entries", "Retained mempool entries by status";
    mempool_bytes: Gauge = Gauge::default();
        "mempool", "Aggregate retained mempool bytes", Unit::Bytes;
    mempool_unpaid_entries: Gauge = Gauge::default();
        "mempool_unpaid_entries", "Unpaid mempool entries";
    mempool_max_entries: Gauge = Gauge::default();
        "mempool_max_entries", "Configured mempool entry limit";
    mempool_max_bytes: Gauge = Gauge::default();
        "mempool_max", "Configured mempool byte limit", Unit::Bytes;
    mempool_max_unpaid_entries: Gauge = Gauge::default();
        "mempool_max_unpaid_entries", "Configured unpaid mempool limit";
    mempool_ready: Gauge = Gauge::default();
        "mempool_ready", "Whether the mempool is admitting and listing";
    mempool_admissions: Family<AdmissionLabels, Counter> = Family::default();
        "mempool_admissions", "Mempool admission attempts by source and outcome";
    mempool_verify_duration: Histogram = Histogram::new(exponential_buckets(0.001, 2.0, 16));
        "mempool_verify_duration", "Proof verification time during admission", Unit::Seconds;
    mempool_admission_queue_depth: Gauge = Gauge::default();
        "mempool_admission_queue_depth", "Admissions waiting for a mempool verifier worker";
    mempool_evictions: Family<ReasonLabels, Counter> = Family::default();
        "mempool_evictions", "Mempool entries removed at TTL or finality";
    mempool_included: Counter = Counter::default();
        "mempool_included", "Mempool entries marked included-unfinalized";
    mempool_suspended: Family<CauseLabels, Counter> = Family::default();
        "mempool_suspended", "Mempool entries suspended by canonical conflict";
    mempool_prepare: Family<PrepareLabels, Counter> = Family::default();
        "mempool_prepare", "Transactions selected or rejected during relay preparation";
    mempool_prepare_requests: Counter = Counter::default();
        "mempool_prepare_requests", "pcash_prepareRelay calls that reached the mempool";
    p2p_peers: Gauge = Gauge::default();
        "p2p_peers", "Connected P2P peers";
    p2p_routing_peers: Gauge = Gauge::default();
        "p2p_routing_peers", "Discovery routing table peers";
    p2p_pending_dials: Gauge = Gauge::default();
        "p2p_pending_dials", "Pending outbound connections";
    p2p_relay_reservations: Gauge = Gauge::default();
        "p2p_relay_reservations", "Active client relay reservations";
    p2p_relay_circuits: Gauge = Gauge::default();
        "p2p_relay_circuits", "Active served relay circuits";
    p2p_public: Gauge = Gauge::default();
        "p2p_public", "Directly reachable endpoint available";
    p2p_relayed: Gauge = Gauge::default();
        "p2p_relayed", "Reachable through relay only";
    p2p_discovery_success: Counter = Counter::default();
        "p2p_discovery_success", "Successful discovery queries";
    p2p_discovery_failure: Counter = Counter::default();
        "p2p_discovery_failure", "Failed discovery queries";
    p2p_dial_failure: Counter = Counter::default();
        "p2p_dial_failure", "Failed outbound dials";
    p2p_hole_punch_success: Counter = Counter::default();
        "p2p_hole_punch_success", "Successful direct connection upgrades";
    p2p_hole_punch_failure: Counter = Counter::default();
        "p2p_hole_punch_failure", "Failed direct connection upgrades";
    p2p_proof_budget_drops: Family<BudgetLabels, Counter> = Family::default();
        "p2p_proof_budget_drops", "Proof-bearing P2P candidates dropped by a token budget";
    p2p_block_hash_divergences: Counter = Counter::default();
        "p2p_block_hash_divergences", "Peer reports of a different PCASH block hash for an L1 block this node derived";
    rpc_requests: Family<MethodLabels, Counter> = Family::default();
        "rpc_requests", "JSON-RPC method calls";
    rpc_errors: Family<RpcErrorLabels, Counter> = Family::default();
        "rpc_errors", "JSON-RPC method errors by registered method and code";
    rpc_duration: Family<MethodLabels, Histogram> =
        Family::new_with_constructor(|| Histogram::new(exponential_buckets(0.001, 2.0, 14)));
        "rpc_duration", "JSON-RPC method latency", Unit::Seconds;
}

impl PrometheusMetrics {
    /// Empty registry with every known label pre-created so dashboards are not
    /// empty before the first event.
    #[must_use]
    pub fn new() -> Self {
        let this = Self::registered();
        this.up.set(1);

        for mode in [DeriveMode::Catchup, DeriveMode::Steady] {
            let _ = this.l1_blocks_derived.get_or_create(&ModeLabels { mode });
        }
        for status in ["ready", "included_unfinalized", "suspended"] {
            this.mempool_entries
                .get_or_create(&StatusLabels {
                    status: status.to_owned(),
                })
                .set(0);
        }
        for source in [AdmissionSource::Rpc, AdmissionSource::P2p] {
            for outcome in AdmissionOutcome::all() {
                let _ = this
                    .mempool_admissions
                    .get_or_create(&AdmissionLabels { source, outcome });
            }
        }
        for reason in EVICTION_REASONS {
            let _ = this.mempool_evictions.get_or_create(&ReasonLabels {
                reason: (*reason).to_owned(),
            });
        }
        for cause in SUSPEND_CAUSES {
            let _ = this.mempool_suspended.get_or_create(&CauseLabels {
                cause: (*cause).to_owned(),
            });
        }
        for result in ["selected", "rejected"] {
            let _ = this.mempool_prepare.get_or_create(&PrepareLabels {
                result: result.to_owned(),
            });
        }
        for budget in P2P_BUDGETS {
            let _ = this.p2p_proof_budget_drops.get_or_create(&BudgetLabels {
                budget: (*budget).to_owned(),
            });
        }
        this
    }

    /// OpenMetrics text exposition.
    pub fn encode(&self) -> Result<String, std::fmt::Error> {
        let mut buffer = String::new();
        prometheus_client::encoding::text::encode(&mut buffer, &self.registry)?;
        Ok(buffer)
    }
}

impl Default for PrometheusMetrics {
    fn default() -> Self {
        Self::new()
    }
}

impl Metrics for PrometheusMetrics {
    fn set_info(&self, chain_id: u32) {
        self.info
            .get_or_create(&InfoLabels {
                chain_id: chain_id.to_string(),
            })
            .set(1);
    }

    fn set_derivation_progress(&self, progress: DerivationProgress) {
        self.derived_l1_block.set(progress.derived_l1_block as i64);
        self.l1_head.set(progress.l1_head as i64);
        self.l1_lag_blocks
            .set(progress.l1_head.saturating_sub(progress.derived_l1_block) as i64);
        self.finalized_l1_block
            .set(progress.finalized_l1_block as i64);
        self.pcash_tip.set(progress.pcash_tip as i64);
        self.pcash_finalized.set(progress.pcash_finalized as i64);
    }

    fn set_index_progress(&self, cursor: u64, ready: bool) {
        self.index_cursor.set(cursor as i64);
        self.index_ready.set(i64::from(ready));
    }

    fn record_index_write_failure(&self) {
        self.index_write_failures.inc();
    }

    fn set_derivation_state(
        &self,
        left: &[DerivationStateName<'_>],
        entered: DerivationStateName<'_>,
        since_unix_seconds: u64,
    ) {
        // A left state reads 0 instead of disappearing: a backend without
        // staleness handling keeps answering a removed series at its last value.
        let set = |name: DerivationStateName<'_>, value| {
            self.derivation_state
                .get_or_create(&DerivationStateLabels {
                    state: name.state.to_owned(),
                    cause: name.cause.to_owned(),
                })
                .set(value);
        };
        for left in left {
            set(*left, 0);
        }
        set(entered, 1);
        self.derivation_state_start_timestamp
            .set(since_unix_seconds as i64);
    }

    fn set_data_dir_free_bytes(&self, bytes: u64) {
        self.data_dir_free_bytes.set(bytes as i64);
    }

    fn record_derived_block(&self, sample: DerivedBlockSample) {
        self.l1_blocks_derived
            .get_or_create(&ModeLabels { mode: sample.mode })
            .inc();
        self.derive_duration.observe(sample.total.as_secs_f64());
        self.derive_prewarm_duration
            .observe(sample.prewarm.as_secs_f64());
        self.derive_apply_duration
            .observe(sample.apply.as_secs_f64());
        self.derive_prune_duration
            .observe(sample.prune.as_secs_f64());
    }

    fn record_rpc_wait(&self, duration: Duration) {
        self.derive_rpc_wait_duration
            .observe(duration.as_secs_f64());
    }

    fn record_accepted_entries(&self, count: u64) {
        self.entries_accepted.inc_by(count);
    }

    fn record_skipped_entry(&self, reason: &str) {
        self.entries_skipped
            .get_or_create(&ReasonLabels {
                reason: reason.to_owned(),
            })
            .inc();
    }

    fn record_carriers(&self, count: u64) {
        self.carriers.inc_by(count);
    }

    fn record_reorg(&self, depth: u64) {
        self.reorgs.inc();
        self.reorg_depth.observe(depth as f64);
    }

    fn record_prune_failure(&self) {
        self.prune_failures.inc();
    }

    fn set_mempool_occupancy(&self, occupancy: MempoolOccupancy) {
        self.mempool_entries
            .get_or_create(&StatusLabels {
                status: "ready".to_owned(),
            })
            .set(occupancy.ready as i64);
        self.mempool_entries
            .get_or_create(&StatusLabels {
                status: "included_unfinalized".to_owned(),
            })
            .set(occupancy.included_unfinalized as i64);
        self.mempool_entries
            .get_or_create(&StatusLabels {
                status: "suspended".to_owned(),
            })
            .set(occupancy.suspended as i64);
        self.mempool_bytes.set(occupancy.bytes as i64);
        self.mempool_unpaid_entries
            .set(occupancy.unpaid_entries as i64);
        self.mempool_max_entries.set(occupancy.max_entries as i64);
        self.mempool_max_bytes.set(occupancy.max_bytes as i64);
        self.mempool_max_unpaid_entries
            .set(occupancy.max_unpaid_entries as i64);
    }

    fn set_mempool_ready(&self, ready: bool) {
        self.mempool_ready.set(i64::from(ready));
    }

    fn record_mempool_admission(&self, source: AdmissionSource, outcome: AdmissionOutcome) {
        self.mempool_admissions
            .get_or_create(&AdmissionLabels { source, outcome })
            .inc();
    }

    fn record_mempool_verify(&self, duration: Duration) {
        self.mempool_verify_duration.observe(duration.as_secs_f64());
    }

    fn set_mempool_admission_queue_depth(&self, depth: u64) {
        self.mempool_admission_queue_depth.set(depth as i64);
    }

    fn record_mempool_eviction(&self, reason: &'static str) {
        let reason = intern_or_other(EVICTION_REASONS, reason);
        self.mempool_evictions
            .get_or_create(&ReasonLabels {
                reason: reason.to_owned(),
            })
            .inc();
    }

    fn record_mempool_included(&self, count: u64) {
        self.mempool_included.inc_by(count);
    }

    fn record_mempool_suspended(&self, cause: &'static str) {
        let cause = intern_or_other(SUSPEND_CAUSES, cause);
        self.mempool_suspended
            .get_or_create(&CauseLabels {
                cause: cause.to_owned(),
            })
            .inc();
    }

    fn record_mempool_prepare_request(&self) {
        self.mempool_prepare_requests.inc();
    }

    fn record_mempool_prepare(&self, selected: u64, rejected: u64) {
        self.mempool_prepare
            .get_or_create(&PrepareLabels {
                result: "selected".to_owned(),
            })
            .inc_by(selected);
        self.mempool_prepare
            .get_or_create(&PrepareLabels {
                result: "rejected".to_owned(),
            })
            .inc_by(rejected);
    }

    fn set_p2p_peers(&self, count: u64) {
        self.p2p_peers.set(count as i64);
    }

    fn record_p2p_network(&self, sample: P2pNetworkMetrics) {
        self.p2p_routing_peers.set(sample.routing_peers as i64);
        self.p2p_pending_dials.set(sample.pending_dials as i64);
        self.p2p_relay_reservations
            .set(sample.relay_reservations as i64);
        self.p2p_relay_circuits.set(sample.relay_circuits as i64);
        self.p2p_public.set(i64::from(sample.public));
        self.p2p_relayed.set(i64::from(sample.relayed));
        self.p2p_discovery_success.inc_by(sample.discovery_success);
        self.p2p_discovery_failure.inc_by(sample.discovery_failure);
        self.p2p_dial_failure.inc_by(sample.dial_failure);
        self.p2p_hole_punch_success
            .inc_by(sample.hole_punch_success);
        self.p2p_hole_punch_failure
            .inc_by(sample.hole_punch_failure);
    }

    fn record_p2p_proof_budget_drop(&self, budget: &'static str) {
        let budget = intern_or_other(P2P_BUDGETS, budget);
        self.p2p_proof_budget_drops
            .get_or_create(&BudgetLabels {
                budget: budget.to_owned(),
            })
            .inc();
    }

    fn record_p2p_block_hash_divergence(&self) {
        self.p2p_block_hash_divergences.inc();
    }

    fn record_rpc(&self, method: &str, error_code: Option<i32>, duration: Duration) {
        let labels = MethodLabels {
            method: method.to_owned(),
        };
        self.rpc_requests.get_or_create(&labels).inc();
        self.rpc_duration
            .get_or_create(&labels)
            .observe(duration.as_secs_f64());
        if let Some(code) = error_code {
            self.rpc_errors
                .get_or_create(&RpcErrorLabels {
                    method: method.to_owned(),
                    code: code.to_string(),
                })
                .inc();
        }
    }
}

/// Bind `/metrics` and serve until the process exits. Returns the bound address.
pub async fn spawn(
    addr: SocketAddr,
    metrics: Arc<PrometheusMetrics>,
) -> std::io::Result<SocketAddr> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let local = listener.local_addr()?;
    let app = Router::new()
        .route("/metrics", get(metrics_handler))
        .with_state(metrics);
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            tracing::error!(%error, "metrics HTTP server stopped");
        }
    });
    Ok(local)
}

async fn metrics_handler(State(metrics): State<Arc<PrometheusMetrics>>) -> Response {
    match metrics.encode() {
        Ok(body) => (
            StatusCode::OK,
            [(
                header::CONTENT_TYPE,
                "application/openmetrics-text; version=1.0.0; charset=utf-8",
            )],
            body,
        )
            .into_response(),
        Err(error) => {
            tracing::error!(%error, "could not encode metrics");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
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
    fn exposition_names_are_prefixed_and_up_is_one() {
        let metrics = PrometheusMetrics::new();
        metrics.record_rpc("pcash_status", Some(-32602), Duration::from_millis(1));
        let text = metrics.encode().unwrap();
        assert!(text.contains("pcash_node_up 1"), "{text}");
        assert!(text.contains("pcash_node_l1_lag_blocks"), "{text}");
        assert!(text.contains("pcash_node_index_write_failures"), "{text}");
        assert!(text.contains("pcash_node_mempool_bytes"), "{text}");
        assert!(text.contains("pcash_node_rpc_errors"), "{text}");
    }

    #[test]
    fn derivation_state_hands_over_from_the_state_left() {
        let metrics = PrometheusMetrics::new();
        let following = DerivationStateName {
            state: "following",
            cause: "",
        };
        let stalled = DerivationStateName {
            state: "stalled",
            cause: "l1Rpc",
        };
        let halted = DerivationStateName {
            state: "halted",
            cause: "storage",
        };
        // Startup names every state, the current one included, and it still ends at 1.
        metrics.set_derivation_state(&[following, stalled, halted], following, 1_700_000_000);
        let text = metrics.encode().unwrap();
        assert!(
            text.contains(r#"pcash_node_derivation_state{state="following",cause=""} 1"#),
            "{text}"
        );
        assert!(
            text.contains(r#"pcash_node_derivation_state{state="halted",cause="storage"} 0"#),
            "{text}"
        );

        metrics.set_derivation_state(&[following], stalled, 1_700_000_060);
        metrics.set_data_dir_free_bytes(4096);
        let text = metrics.encode().unwrap();
        assert!(
            text.contains(r#"pcash_node_derivation_state{state="following",cause=""} 0"#),
            "{text}"
        );
        assert!(
            text.contains(r#"pcash_node_derivation_state{state="stalled",cause="l1Rpc"} 1"#),
            "{text}"
        );
        assert!(
            text.contains("pcash_node_derivation_state_start_timestamp_seconds 1700000060"),
            "{text}"
        );
        assert!(
            text.contains("pcash_node_data_dir_free_bytes 4096"),
            "{text}"
        );
    }

    #[test]
    fn skip_and_admission_labels_are_wire_names() {
        let metrics = PrometheusMetrics::new();
        metrics.record_skipped_entry("proofRejected");
        metrics.record_mempool_admission(AdmissionSource::Rpc, AdmissionOutcome::Full);
        let text = metrics.encode().unwrap();
        assert!(text.contains(r#"reason="proofRejected""#), "{text}");
        assert!(text.contains(r#"source="rpc""#), "{text}");
        assert!(text.contains(r#"outcome="full""#), "{text}");
        assert!(!text.contains("ProofRejected"), "{text}");
    }

    #[test]
    fn skip_reason_is_recorded_without_a_second_inventory() {
        let metrics = PrometheusMetrics::new();
        metrics.record_skipped_entry("zeroNullifier");
        let text = metrics.encode().unwrap();
        assert!(text.contains(r#"reason="zeroNullifier""#), "{text}");
    }

    #[test]
    fn rpc_recorder_uses_supplied_method_and_numeric_code() {
        let metrics = PrometheusMetrics::new();
        metrics.record_rpc("pcash_status", Some(-32602), Duration::from_millis(3));
        metrics.record_rpc("unknown", Some(-32004), Duration::from_millis(1));
        let text = metrics.encode().unwrap();
        assert!(text.contains(r#"method="pcash_status""#), "{text}");
        assert!(text.contains(r#"code="-32602""#), "{text}");
        assert!(text.contains(r#"method="unknown""#), "{text}");
        assert!(text.contains(r#"code="-32004""#), "{text}");
    }

    #[tokio::test]
    async fn metrics_http_serves_openmetrics() {
        let metrics = Arc::new(PrometheusMetrics::new());
        metrics.set_info(7);
        let addr = spawn("127.0.0.1:0".parse().unwrap(), Arc::clone(&metrics))
            .await
            .unwrap();
        let body = reqwest::get(format!("http://{addr}/metrics"))
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(body.contains("pcash_node_up 1"), "{body}");
        assert!(body.contains(r#"chain_id="7""#), "{body}");
    }
}
