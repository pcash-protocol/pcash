//! Verified, persistent, non-consensus local transaction pool.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::unreadable_literal,
    reason = "mempool indexes are updated through validated internal transitions and test vectors preserve protocol constants"
)]
//!
//! The pool is deliberately separate from canonical state and the derived index.
//! Admission performs cheap state checks, verifies the proof without holding the
//! node-state lock, rechecks the current state, then durably stores exact
//! `txBytes`. RPC and peer admissions queue for the mempool's own verifier
//! workers, and a full queue refuses at once. L1 inclusion remains the only
//! source of consensus ordering.

use std::path::{Path, PathBuf};

mod admission;
mod service;
mod store;

pub use admission::AdmissionPool;
pub use service::{MempoolService, RpcAdmission};
pub(crate) use store::now_unix_ms;
pub use store::{MempoolLimits, MempoolStatus};

pub const DEFAULT_MAX_ENTRIES: usize = 4_096;
pub const DEFAULT_MAX_BYTES: usize = 64 * 1024 * 1024;
/// Sponsoring unpaid entries is Sybil-prone. Keep them from consuming
/// the entire general transaction pool even when the outer limits are larger.
pub const DEFAULT_MAX_UNPAID_ENTRIES: usize = 512;
pub const MAX_PAGE_SIZE: usize = 256;
/// Admissions that may wait for a verifier worker before submission is refused.
pub const DEFAULT_ADMISSION_QUEUE: usize = 256;
/// Local retention ceiling for all unpaid transactions, in addition to protocol expiry.
pub const UNPAID_TTL_MS: u64 = 60 * 60 * 1_000;

/// The sibling data file used by the local mempool.
pub fn mempool_path_for(state_path: &Path) -> PathBuf {
    state_path.with_extension("mempool.redb")
}

#[cfg(test)]
pub(crate) use service::validation_outcome;
#[cfg(test)]
pub(crate) mod tests;
