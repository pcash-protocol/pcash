//! L1 inputs for PCASH derivation.
//!
//! This crate reads Ethereum headers, full blocks, and receipts from a configured
//! JSON-RPC endpoint and converts them into the domain form consumed by the node.
//! The follower checks continuity and supports rewind; state savepoints and
//! restoration live in the state crate.

pub mod carrier;
pub mod client;
pub mod error;
pub mod follower;
pub mod logs;
pub mod types;

pub use carrier::{
    carrier_context_hash, decode_event_data, inbox_carrier_context_hash, Carrier, CarrierKind,
    CarrierSource, EventData, PCASH_BATCH_TOPIC,
};
pub use client::L1Client;
pub use error::{L1Error, Result};
pub use follower::{Follower, Reorg, Step};
pub use logs::{
    hash_concurrency, normalized_log_empty_nodes, prepare_normalized_logs, set_hash_concurrency,
    NormalizedLog, NormalizedLogBlock, NORMALIZED_LOG_TREE_DEPTH,
};
pub use types::{BlobResolution, CarrierBatch, L1BlockData, L1Header, L1Log, L1Receipt, L1Tx};

/// Default Sepolia JSON-RPC endpoint for reference-node tooling.
pub const SEPOLIA_RPC_URL: &str = "https://rpc.sepolia.ethpandaops.io";
