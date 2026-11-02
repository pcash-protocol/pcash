//! pcash-node — the PCASH node library.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "public node construction maintains validated internal invariants"
)]
//!
//! Wires the derivation engine, redb state, and RPC into one running node:
//!
//! - [`config`] — compiled fork rules plus runtime derivation configuration;
//! - [`node`] — the shared [`NodeInner`] state, its canonical derived index, and
//!   the [`NodeHandle`] that implements [`pcash_rpc::NodeApi`];
//! - [`index`] — the persistent rebuildable query index used across restarts;
//! - [`follow`] — the reorg-aware L1 follow loop.
//!
//! The binary (`src/main.rs`) is a thin CLI over [`resume_or_build_node`] +
//! [`follow::run_follow`] + [`pcash_rpc::serve`]; everything testable lives here.

mod aster;
mod blob;
mod canonical_feeds;
mod catalog;
pub mod config;
mod fee_estimate;
mod follow;
pub mod index;
mod mempool;
pub mod networks;
mod node;
mod outputs_rpc;
mod p2p_runtime;
mod pins;
mod prover_assets;
pub(crate) use pcash_rpc::redb_schema;

pub use blob::{BeaconClient, BlobError};
pub use catalog::{
    catalog_path_for, resolve_namespaces, CatalogService, CatalogStore, DEFAULT_CATALOG_NAMESPACES,
};
pub use config::{NetworkConfig, DEFAULT_INBOX, L1_CHAIN_ID, PCASH_CHAIN_ID};
pub use follow::{
    follow_until_stopped, handle_reorg, run_follow, run_follow_with_catchup,
    CATCHUP_FETCH_CONCURRENCY, DEFAULT_CATCHUP_FETCH_QUEUE,
};
pub use index::DerivedIndexStore;
pub use mempool::{
    mempool_path_for, AdmissionPool, MempoolLimits, MempoolService, MempoolStatus, RpcAdmission,
    DEFAULT_ADMISSION_QUEUE, DEFAULT_MAX_BYTES, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_UNPAID_ENTRIES,
};
pub use networks::Network;
pub use node::{NodeHandle, NodeInner, ReceiptRecord};
pub use p2p_runtime::{start_p2p, start_p2p_with_metrics, RunningP2p};
pub use pcash_pscan::registry::{source_registry_path_for, SourceVerificationService};
pub use pins::{release_pins, ReleasePins};
pub use prover_assets::load_prover_assets;

mod resume;
#[cfg(test)]
pub(crate) use resume::build_node_with_rules_inner;
pub use resume::{
    build_in_memory_node, build_node, catch_up_derived_index, maintain_derived_index,
    resume_or_build_node, resume_or_build_node_with_force_resync, StartPlan,
};
#[cfg(feature = "test-support")]
pub use resume::{
    build_node_with_rules, reopen_index_with_backend, resume_or_build_node_with_rules,
};
