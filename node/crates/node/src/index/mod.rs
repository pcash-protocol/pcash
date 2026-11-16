//! Rebuildable canonical derived index.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "index records are maintained atomically with canonical state"
)]
//!
//! This store is the sole home for receipts, retained account material, and
//! encrypted output projections. Every accepted block advances one canonical cursor
//! in the same transaction as its complete projection.
//!
//! Primary keys are big-endian cursor tuples, so lexicographic table order equals
//! derivation order and a range load reconstructs exact derivation order:
//!
//! - receipt:  `l1_block_number(8) || l1_transaction_index(8) || batch_item_index(8)`
//! - L1 log: `l1_block_number(8) || transaction_index(8) || log_index(8)`
//! - L1 log tree node: `l1_block_number(8) || height(1) || node_index(8)`
//!
//! Receipts also carry secondary index tables (by tx id / nullifier /
//! account) mapping each identifier to a primary key; `rewind_to`
//! reconciles them alongside the primary rows on reorg/resume.
//!
//! This is a SEPARATE `redb` database from the canonical state, deliberately
//! outside the state's savepoint domain: rolling the state back to a savepoint
//! (reorg / resume) reverts whole tables wholesale, which would clobber index rows
//! for the still-canonical fork block. Instead the index is reconciled explicitly
//! — [`rewind_to`](DerivedIndexStore::rewind_to) on rollback / resume — so a
//! canonical block's projection is never lost.

mod keys;
mod material;
mod outputs;
mod receipts;
mod store;
mod types;

pub use keys::BlockEconomicsRow;
pub use store::{DerivedIndexRead, DerivedIndexStore};
pub use types::{
    ContractFunctionMaterial, ContractMaterialUpdate, ContractSourceInfo,
    ContractVerificationLookup, DerivedIndexCursor, DerivedIndexLifecycle, IndexBlockId,
    IndexedL1LogProof, IndexedOutputItem, IndexedOutputMaterial, OutputContinuation, OutputError,
    OutputLimits, OutputPage, OutputTarget, ReceiveMaterialUpdate,
};

#[cfg(test)]
mod tests;
