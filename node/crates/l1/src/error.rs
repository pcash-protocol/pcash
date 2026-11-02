//! Error type for the L1 follower.

use alloy_primitives::B256;

/// Errors from L1 ingestion and conversion.
///
/// Parse/shape failures are fatal: a
/// block/transaction/receipt the node cannot map into the domain form must halt
/// derivation, never be skipped, because skipping would drop inbox
/// transactions or logs from derivation. An outage or a missing block is not a
/// shape failure; see [`L1Error::is_retryable`].
#[derive(Debug, thiserror::Error)]
pub enum L1Error {
    /// The upstream endpoint remained unavailable after bounded request retries.
    #[error("l1 rpc unavailable: {0}")]
    RpcUnavailable(String),
    /// Transport/JSON-RPC failure talking to the configured Ethereum endpoint.
    #[error("l1 rpc error: {0}")]
    Rpc(String),
    /// The RPC answered `null` for a block, its receipts, or the `finalized`
    /// tag. The head and each block are separate requests, so a provider whose
    /// backends lag one another can report a head it cannot yet serve.
    #[error("l1 block not found: {0}")]
    BlockNotFound(String),
    /// The RPC answered a by-number fetch with a header for a different height.
    #[error("l1 block number {requested} returned header number {got}")]
    BlockNumberMismatch { requested: u64, got: u64 },
    /// Block came back without a full transaction list (hash-only or uncle
    /// body) where full bodies were required.
    #[error("l1 block {0} did not return a full transaction list")]
    NotFullTransactions(u64),
    /// Transaction count and receipt count disagreed for one block. Fatal:
    /// alignment by index would otherwise file logs under the wrong transaction.
    #[error("l1 block {block} has {txs} transactions but {receipts} receipts")]
    TxReceiptCountMismatch {
        block: u64,
        txs: usize,
        receipts: usize,
    },
    /// A transaction's `transactionIndex`, or its receipt's, differed from its
    /// position in the block. Fatal: the L1 log tree would otherwise file logs
    /// under the wrong transaction.
    #[error(
        "l1 block {block} position {position} has transaction index {tx_index} and receipt index {}",
        receipt_index.map_or_else(|| "absent".to_owned(), |index| index.to_string())
    )]
    TxReceiptIndexMismatch {
        block: u64,
        position: u64,
        tx_index: u64,
        receipt_index: Option<u64>,
    },
    /// A transaction lacked a `transactionIndex` (only pending txs do; a mined
    /// block must not contain one).
    #[error("l1 transaction {0} has no transactionIndex")]
    MissingTxIndex(B256),
    /// A receipt log carried more than four topics. Canonical Ethereum logs
    /// have at most four; anything else is a malformed receipt from a faulty
    /// or hostile endpoint. Fatal: log-leaf hashing is defined only for the
    /// canonical topic count and must never run on out-of-contract input.
    #[error(
        "l1 block receipt log (tx {transaction_index}, log {log_index}) has {count} topics; canonical maximum is 4"
    )]
    LogTopicCount {
        transaction_index: u64,
        log_index: u64,
        count: usize,
    },
}

impl L1Error {
    /// Whether a running follower should pause and retry this upstream failure.
    pub fn is_retryable(&self) -> bool {
        matches!(self, Self::RpcUnavailable(_) | Self::BlockNotFound(_))
    }
}

pub type Result<T> = std::result::Result<T, L1Error>;
