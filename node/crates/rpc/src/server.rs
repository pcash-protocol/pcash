//! The jsonrpsee glue for the `pcash_*` namespace over HTTP+WS.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::struct_field_names,
    reason = "registered RPC methods and request limits are static, validated server configuration"
)]
//!
//! [`NodeApi`] is the object-safe surface the node implements (reads delegate to
//! [`crate::handlers`] over committed database reads).
//! [`build_module`] registers every method on an [`RpcModule`], and [`serve`]
//! binds a jsonrpsee [`Server`] that speaks both HTTP and WebSocket on one
//! socket. The DTO layer encodes byte strings and quantities.

use std::collections::HashSet;
use std::future::Future;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;

use alloy_primitives::{Address, B256, U256};
use jsonrpsee::server::middleware::rpc::{
    Batch, BatchEntry, Notification, Request, RpcServiceBuilder, RpcServiceT,
};
use jsonrpsee::server::{
    BatchRequestConfig, BatchResponseBuilder, MethodResponse, Server, ServerConfig, ServerHandle,
};
use jsonrpsee::types::{ErrorObject, ErrorObjectOwned, Params};
use jsonrpsee::{Methods, RpcModule};
use pcash_metrics::Metrics;
use pcash_state::StateError;
use serde_json::Value;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tower_http::cors::CorsLayer;

use crate::catalog::{
    catalog_content_id, namespace_is_valid, CatalogApiError, CatalogArtifact, CatalogGetRequest,
    CatalogInfo, CatalogLimits, CatalogListRequest, CatalogPage, CatalogRecord,
    MAX_NAMESPACE_BYTES,
};
use crate::dto::{
    AccountChangeContinuationDto, AccountChangePageDto, AccountDto, AccountProofResultDto,
    BlockDto, BlockHeaderDto, BlockId, BlockPayoutsDto, ContractPageDto, ContractResultDto,
    FeeEstimateDto, HistoryProofDto, L1DeliveryBatchContinuationDto, L1DeliveryBatchPageDto,
    L1LogProofDto, L1OriginProofDto, MempoolPageDto, MempoolSort, MempoolStatusFilter,
    MempoolTransactionDto, NullifierProofsDto, OutputContinuationDto, OutputFrontierDto,
    OutputPageDto, OutputPathDto, OutputPathsDto, PreparedRelayDto, ReceiptDto, StatusDto,
    TransactionCheckDto, TransactionDto, TransactionKind, TransactionPageDto,
};
use crate::request::{
    AccountChangesQuery, AccountHistoryQuery, BlockRangeQuery, CarrierContextQuery,
    CatalogGetQuery, CatalogListQuery, CheckRawTransactionQuery, ContractsQuery, FeeBearingKind,
    FeeEstimateQuery, L1DeliveryBatchesQuery, MempoolQuery, OutputQuery, PrepareRelayQuery,
    ReceiptNullifierQuery, ReceiptQuery, SubmissionQuery, TransactionsQuery,
};

/// The block a `pcash_getBlockHeader` request names.
///
/// Sent as one positional string: `"latest"`, a hex height, or a block hash
/// (`0x` and exactly 64 hex digits). A string of hash length is always a hash,
/// so the two hex forms cannot be confused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockTag {
    Latest,
    Number(u64),
    Hash(B256),
}

impl serde::Serialize for BlockTag {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Latest => serializer.serialize_str("latest"),
            Self::Number(number) => serializer.serialize_str(&format!("0x{number:x}")),
            Self::Hash(hash) => serde::Serialize::serialize(hash, serializer),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OutputLimits {
    pub max_outputs: u32,
    pub max_bytes: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputRequest {
    pub from_output_index: u64,
    pub target: BlockId,
    pub continuation: Option<OutputContinuationDto>,
    pub limits: OutputLimits,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AccountChangeLimits {
    pub max_changes: u32,
    pub max_bytes: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountChangesRequest {
    pub from_block: u64,
    pub target: BlockId,
    pub continuation: Option<AccountChangeContinuationDto>,
    pub limits: AccountChangeLimits,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct L1DeliveryBatchLimits {
    pub max_batches: u32,
    pub max_bytes: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct L1DeliveryBatchesRequest {
    pub l1_transaction_hash: B256,
    pub continuation: Option<L1DeliveryBatchContinuationDto>,
    pub limits: L1DeliveryBatchLimits,
}

/// A `pcash_checkRawTransaction` request with its byte strings decoded within
/// their bounds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckRawTransactionRequest {
    pub transaction: Vec<u8>,
    pub carrier: CarrierContextRequest,
}

/// The carrier a check assumes. The mempool worker hashes its context.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CarrierContextRequest {
    Inbox { address: Address },
    Event { address: Address, context: Vec<u8> },
}

/// Transport-independent filter for this node's local mempool view.
#[derive(Clone, Debug, Default)]
pub struct MempoolFilter {
    pub cursor: Option<B256>,
    pub limit: usize,
    pub kind: Option<TransactionKind>,
    pub min_open_fee: U256,
    pub status: Option<MempoolStatusFilter>,
    pub controlled_issuance_owner_commitments: Option<Vec<B256>>,
    pub sort: MempoolSort,
    pub arena: Option<ArenaFilter>,
}

/// Bounds on one `pcash_getMempool` arena filter, which every pool entry is
/// matched against.
pub const MAX_ARENA_DATA_MATCHES: usize = 8;
pub const MAX_ARENA_MATCH_BYTES: usize = 64;

/// Entries whose arena's public segment carries a record of `schema` whose
/// data holds each `(offset, bytes)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArenaFilter {
    pub schema: [u8; 4],
    pub data: Vec<(usize, Vec<u8>)>,
}

impl ArenaFilter {
    pub fn matches(&self, records: &[pcash_derive::public_records::PublicRecord]) -> bool {
        records.iter().any(|record| {
            record.schema == self.schema
                && self.data.iter().all(|(offset, bytes)| {
                    record.data.get(*offset..offset + bytes.len()) == Some(bytes.as_slice())
                })
        })
    }

    fn from_query(query: crate::request::ArenaRecordQuery) -> Result<Self, ErrorObjectOwned> {
        if query.schema[0] & 0x80 == 0 {
            return Err(invalid_params(
                "arena.schema must be a four-byte application id with its top bit set",
            ));
        }
        if query.data.len() > MAX_ARENA_DATA_MATCHES {
            return Err(invalid_params(format!(
                "arena.data exceeds {MAX_ARENA_DATA_MATCHES} entries"
            )));
        }
        let data = query
            .data
            .into_iter()
            .map(|item| {
                if item.bytes.is_empty() || item.bytes.len() > MAX_ARENA_MATCH_BYTES {
                    return Err(invalid_params(format!(
                        "arena.data bytes must hold 1 to {MAX_ARENA_MATCH_BYTES} bytes"
                    )));
                }
                // A record holds at most 0xffff bytes.
                let offset = usize::try_from(item.offset)
                    .ok()
                    .filter(|offset| *offset <= 0xffff)
                    .ok_or_else(|| invalid_params("arena.data offset exceeds a record"))?;
                Ok((offset, item.bytes.to_vec()))
            })
            .collect::<Result<_, _>>()?;
        Ok(Self {
            schema: query.schema.0,
            data,
        })
    }
}

/// Inputs used to build a current-head-checked relay batch.
#[derive(Clone, Debug)]
pub struct PrepareRelayRequest {
    pub content_hashes: Vec<B256>,
    pub controlled_issuance_owner_commitments: Vec<B256>,
    pub controlled_issuance_content_hashes: Vec<B256>,
    pub max_batch_bytes: usize,
}

/// Failures specific to the non-consensus local mempool service.
#[derive(Clone, Debug, thiserror::Error)]
pub enum MempoolApiError {
    /// This node's admission policy refuses the bytes. Policy is not
    /// consensus: another node, or a later release, may admit the same bytes,
    /// so P2P never treats a peer that sent them as misbehaving.
    #[error("refused by this mempool's policy: {0}")]
    Policy(String),
    #[error("mempool unavailable")]
    Unavailable,
    /// The bytes cannot be valid under any state, so the same bytes will be
    /// refused again.
    #[error("invalid transaction: {0}")]
    Invalid(String),
    /// Well-formed transaction that is not eligible against this node's
    /// current canonical view, such as a spent input or a stale recent block.
    /// The client rebuilds against current state. A peer may be ahead, so P2P
    /// must not treat this as attributable misconduct.
    #[error("transaction is ineligible at the current state: {0}")]
    State(String),
    #[error("mempool is full")]
    Full,
    /// A capacity bound refused the request before any verdict on it: the
    /// admission queue, the unpaid work budget, or the relay preparation
    /// budget. The same request may be sent again later.
    #[error("node is busy: {0}")]
    Busy(String),
    /// The node could not reach a verdict because its proof verifier, or the
    /// worker running admission or preparation, failed. The transaction may be
    /// valid; this node later, or another node, may decide it.
    #[error("verification unavailable: {0}")]
    Verification(String),
    #[error("mempool storage failure: {0}")]
    Storage(String),
}

/// The node-facing surface backing RPC: canonical state/proof reads,
/// rebuildable derived-index reads, mempool admission and relay preparation,
/// and the optional catalog and source-verification services.
/// Read methods use committed database transactions; mutations delegate to node-local services.
#[async_trait::async_trait]
pub trait NodeApi: Send + Sync + 'static {
    // ---- canonical state and proof reads ----
    fn status(&self) -> Result<StatusDto, StateError>;
    fn get_payouts(
        &self,
        query: crate::request::PayoutQuery,
    ) -> Result<crate::dto::PayoutPageDto, IndexReadError>;
    fn get_block_economics(
        &self,
        query: crate::request::BlockEconomicsQuery,
    ) -> Result<crate::dto::BlockEconomicsPageDto, IndexReadError>;
    fn get_issuance_quote(
        &self,
        candidate_timestamp: u64,
    ) -> Result<Option<crate::dto::IssuanceQuoteDto>, IssuanceQuoteError>;
    fn get_witness_snapshot(
        &self,
        query: crate::request::WitnessSnapshotQuery,
    ) -> Result<crate::dto::WitnessSnapshotDto, IndexReadError>;

    /// A depth-40 output opening, or `None` if the index is past `outputCount`
    /// or there is no current boundary.
    fn get_output_path(&self, leaf_index: u64) -> Result<Option<OutputPathDto>, StateError>;

    /// Openings for several output commitments against one consistent root snapshot,
    /// or `None` if any index is past `outputCount` or there is no current boundary.
    fn get_output_paths(&self, leaf_indices: &[u64]) -> Result<Option<OutputPathsDto>, StateError>;
    fn get_account_proof(&self, addr: Address) -> Result<AccountProofResultDto, StateError>;
    fn get_account(&self, addr: Address) -> Result<Option<AccountDto>, StateError>;
    fn get_contract(&self, addr: Address) -> Result<ContractResultDto, StateError>;
    fn get_block_header(&self, block_tag: BlockTag) -> Result<Option<BlockHeaderDto>, StateError>;
    fn get_l1_origin_proof(
        &self,
        block_hash: B256,
        l1_block_number: u64,
    ) -> Result<Option<L1OriginProofDto>, StateError>;
    fn get_l1_log_proof(
        &self,
        block_hash: B256,
        l1_block_number: u64,
        transaction_index: u64,
        log_index: u64,
    ) -> Result<Option<L1LogProofDto>, IndexReadError>;
    fn get_result_proof(
        &self,
        hash: B256,
        number: u64,
        position: crate::dto::ResultPosition,
    ) -> Result<Option<crate::dto::ResultProofDto>, StateError>;

    fn get_history_proof(
        &self,
        block_hash: B256,
        historical_block_number: u64,
    ) -> Result<Option<HistoryProofDto>, StateError>;
    /// Canonical block by PCASH number (`0` = genesis), or `None` if not yet derived.
    fn get_block(
        &self,
        number: u64,
        full_transactions: bool,
    ) -> Result<Option<BlockDto>, StateError>;
    /// Canonical block by exact PCASH hash.
    fn get_block_by_hash(
        &self,
        hash: B256,
        full_transactions: bool,
    ) -> Result<Option<BlockDto>, StateError>;
    /// Canonical blocks for the inclusive PCASH-number range `[from, to]`,
    /// ascending, capped server-side.
    fn get_blocks(
        &self,
        from: u64,
        to: u64,
        full_transactions: bool,
    ) -> Result<Vec<BlockDto>, StateError>;
    fn are_nullifiers_spent(&self, nullifiers: &[B256]) -> Result<Vec<bool>, StateError>;
    fn get_nullifier_proofs(
        &self,
        nullifiers: &[B256],
    ) -> Result<Option<NullifierProofsDto>, StateError>;
    /// The output-tree count, root, and append frontier a committed canonical
    /// block committed.
    fn get_output_frontier(&self, block: BlockId) -> Result<OutputFrontierDto, IndexReadError>;
    /// Canonical account writes from `fromBlock` through the target block.
    fn get_account_changes(
        &self,
        request: AccountChangesRequest,
    ) -> Result<AccountChangePageDto, IndexReadError>;

    // ---- derived-index reads ----
    fn get_outputs(&self, request: OutputRequest) -> Result<OutputPageDto, IndexReadError>;
    /// Inclusions matching one of the five closed `pcash_getReceipt` query keys.
    /// Content-hash lookup can return several inclusions; the other keys return zero or one.
    fn get_receipt(&self, query: ReceiptQuery) -> Result<Vec<ReceiptDto>, IndexReadError>;
    /// Newest-first accepted canonical transactions, anchored to one branch.
    fn get_transactions(
        &self,
        query: TransactionsQuery,
    ) -> Result<TransactionPageDto, IndexReadError>;
    /// Exact admitted bytes and the canonical inclusion identified by this transaction ID.
    fn get_transaction(&self, tx_id: B256) -> Result<Option<TransactionDto>, IndexReadError>;
    fn get_submission(&self, query: SubmissionQuery) -> Result<TransactionPageDto, IndexReadError>;
    fn get_account_history(
        &self,
        query: AccountHistoryQuery,
    ) -> Result<TransactionPageDto, IndexReadError>;
    fn get_transaction_by_nullifier(
        &self,
        nullifier: B256,
    ) -> Result<Option<TransactionDto>, IndexReadError>;
    /// One page of the manifests of one L1 transaction's carriers, in
    /// carrier order; empty and complete when the transaction carries none.
    fn get_l1_delivery_batches(
        &self,
        request: L1DeliveryBatchesRequest,
    ) -> Result<L1DeliveryBatchPageDto, IndexReadError>;
    fn get_block_payouts(&self, block: BlockId) -> Result<Option<BlockPayoutsDto>, IndexReadError>;

    /// Public open fee to declare on an entry about to be submitted, from
    /// recent canonical economics and this node's pool.
    fn estimate_fee(&self, byte_size: u64) -> Result<FeeEstimateDto, IndexReadError>;
    /// Newest-first immutable contract creations, anchored to one branch.
    fn get_contracts(&self, query: ContractsQuery) -> Result<ContractPageDto, IndexReadError>;

    // ---- mempool admission and relay preparation ----
    /// Verify and durably admit exact transaction bytes to this node's local pool.
    async fn submit_raw_transaction(
        &self,
        raw: Vec<u8>,
    ) -> Result<MempoolTransactionDto, MempoolApiError>;

    /// Check exact transaction bytes as the next block would execute them
    /// if the query's carrier delivered them: admission, the type's checks
    /// against the current head, and proof verification under the mempool's
    /// verifier budget. Nothing is admitted or broadcast.
    async fn check_raw_transaction(
        &self,
        request: CheckRawTransactionRequest,
    ) -> Result<TransactionCheckDto, MempoolApiError>;

    fn get_mempool(&self, filter: MempoolFilter) -> Result<MempoolPageDto, MempoolApiError>;

    fn get_mempool_transaction(
        &self,
        content_hash: &B256,
    ) -> Result<Option<MempoolTransactionDto>, MempoolApiError>;

    fn prepare_relay(
        &self,
        request: PrepareRelayRequest,
    ) -> Result<PreparedRelayDto, MempoolApiError>;

    // ---- optional publication catalog ----
    /// Capability and health of the optional publication catalog. This always
    /// answers — a backend with no catalog reports `disabled` — so capability
    /// detection never depends on the service being up.
    fn catalog_info(&self) -> CatalogInfo;

    /// One catalog record by content ID, or `None` when absent.
    fn catalog_get(
        &self,
        request: CatalogGetRequest,
    ) -> Result<Option<CatalogRecord>, CatalogApiError>;

    /// One page of catalog records. Results are untrusted and incomplete by
    /// construction; callers verify everything they act on.
    fn catalog_list(&self, request: CatalogListRequest) -> Result<CatalogPage, CatalogApiError>;

    /// Store one artifact, or return the existing record unchanged. Returns the
    /// stored record so the caller learns its server-assigned `createdAt`.
    fn catalog_publish(&self, artifact: CatalogArtifact) -> Result<CatalogRecord, CatalogApiError>;
}

#[derive(Debug, thiserror::Error)]
pub enum IndexReadError {
    #[error("derived index unavailable: {0}")]
    Unavailable(String),
    #[error("cursor does not identify the canonical indexed branch")]
    CursorMismatch,
    #[error("invalid derived-index request: {0}")]
    Invalid(String),
}

impl From<StateError> for IndexReadError {
    fn from(error: StateError) -> Self {
        Self::Unavailable(error.to_string())
    }
}

/// A `pcash_getIssuanceQuote` failure. The candidate time is checked against
/// the parent in the same snapshot the quote reads.
#[derive(Debug, thiserror::Error)]
pub enum IssuanceQuoteError {
    #[error("candidateTimestamp {candidate} is before the parent block timestamp {parent}")]
    CandidateBeforeParent { parent: u64, candidate: u64 },
    #[error(transparent)]
    State(#[from] StateError),
}

type Ctx = Arc<dyn NodeApi>;

/// Encode a response DTO onto the wire.
///
/// The DTOs are plain data, so serialization cannot fail on any value the node
/// can construct; a failure here would be a bug in a DTO definition rather than
/// bad input, so it reports as an internal error rather than invalid params.
fn encode<T: serde::Serialize>(value: &T) -> Result<Value, ErrorObjectOwned> {
    serde_json::to_value(value).map_err(|error| {
        ErrorObject::owned(
            INTERNAL_ERROR,
            format!("response serialization failed: {error}"),
            None::<()>,
        )
    })
}

/// [`encode`], mapping a semantic absence to JSON `null`.
fn encode_optional<T: serde::Serialize>(value: Option<T>) -> Result<Value, ErrorObjectOwned> {
    match value {
        Some(value) => encode(&value),
        None => Ok(Value::Null),
    }
}

const INTERNAL_ERROR: i32 = -32603;
const INVALID_PARAMS: i32 = -32602;
const CURSOR_MISMATCH: i32 = -32001;
const INDEX_UNAVAILABLE: i32 = -32002;
const STATE_UNAVAILABLE: i32 = -32003;
const MEMPOOL_UNAVAILABLE: i32 = -32010;
const MEMPOOL_INVALID: i32 = -32011;
const MEMPOOL_FULL: i32 = -32012;
const MEMPOOL_VERIFICATION: i32 = -32013;
const MEMPOOL_STORAGE: i32 = -32014;
const MEMPOOL_POLICY: i32 = -32015;
const MEMPOOL_BUSY: i32 = -32016;
const MEMPOOL_STATE: i32 = -32017;
const CATALOG_UNAVAILABLE: i32 = -32020;
const CATALOG_INVALID: i32 = -32021;
const CATALOG_EXHAUSTED: i32 = -32022;
const CATALOG_STORAGE: i32 = -32023;
/// Largest valid transaction: the widest shape the compiled transaction types
/// can produce. Taken straight from derivation rather than restated, so it
/// cannot drift when a transaction type is added or retired.
pub const MAX_MEMPOOL_TX_BYTES: usize = pcash_derive::MAX_VALID_TX_BYTES;
/// Ceiling on the carrier context a `pcash_checkRawTransaction` request may
/// name. The protocol bounds an event's context only through Ethereum gas, and
/// hashing one is linear in its length, so a check accepts at most the size of
/// the largest batch.
pub const MAX_CHECK_CONTEXT_BYTES: usize = pcash_da::MAX_BATCH_BYTES;
/// Content hashes one `pcash_prepareRelay` request may name.
///
/// Public relay preparation is an operator convenience surface, not the
/// consensus batch ceiling. Keep one request small enough to inspect and submit.
pub const MAX_PREPARE_REQUEST_IDS: usize = 64;
/// Ceiling on the `maxBatchBytes` one request may ask to have framed. Relay
/// preparation cannot construct a batch outside the consensus carrier domain.
pub const MAX_PREPARED_BATCH_BYTES: usize = pcash_da::MAX_BATCH_BYTES;
/// Bound aggregate blocking preparation work across all clients. The byte
/// budget is charged from each request's declared output ceiling before any
/// mempool revalidation or batch assembly begins.
const MAX_CONCURRENT_PREPARES: usize = 4;
const MAX_INFLIGHT_PREPARE_BYTES: usize = MAX_CONCURRENT_PREPARES * MAX_PREPARED_BATCH_BYTES;
/// An aggregate budget for one request, independent of the per-call limits. It
/// covers a full JSON-RPC batch of maximum-size hex transaction submissions,
/// but not every batch the per-call and batch-count limits allow: maximum-size
/// catalog publications reach it at about 32 per batch, and a client
/// publishing more splits the batch. Source publications travel on the admin
/// and pscan listeners, which carry their own ceiling.
pub const MAX_RPC_REQUEST_BODY_BYTES: u32 = 16 * 1024 * 1024;
/// Open connections across HTTP and WebSocket clients. With the body ceiling
/// this bounds request bytes buffered before any handler runs.
const MAX_RPC_CONNECTIONS: u32 = 256;
/// Concurrent blocking catalog publications, kept separate from the read
/// budget. Transaction admission is bounded by the mempool's own queue instead.
const MAX_CONCURRENT_CATALOG_PUBLICATIONS: usize = 8;
/// Covers maximum relay hex plus metadata and a bounded output-commitment page.
pub const MAX_RPC_RESPONSE_BODY_BYTES: u32 = 10 * 1024 * 1024;
/// Bound per-request fan-out. In particular, a caller cannot wrap hundreds of
/// proof-bearing submissions in one JSON-RPC batch to bypass edge rate limits.
const MAX_RPC_BATCH_LEN: u32 = 64;

struct PrepareBudget {
    concurrent: Arc<Semaphore>,
    bytes: Arc<Semaphore>,
}

struct PreparePermit {
    _concurrent: OwnedSemaphorePermit,
    _bytes: OwnedSemaphorePermit,
}

impl PrepareBudget {
    fn new() -> Self {
        Self::with_limits(MAX_CONCURRENT_PREPARES, MAX_INFLIGHT_PREPARE_BYTES)
    }

    fn with_limits(max_concurrent: usize, max_bytes: usize) -> Self {
        assert!(max_concurrent > 0);
        assert!(max_bytes > 0 && u32::try_from(max_bytes).is_ok());
        Self {
            concurrent: Arc::new(Semaphore::new(max_concurrent)),
            bytes: Arc::new(Semaphore::new(max_bytes)),
        }
    }

    fn try_acquire(&self, requested_bytes: usize) -> Result<PreparePermit, MempoolApiError> {
        let concurrent = self.concurrent.clone().try_acquire_owned().map_err(|_| {
            MempoolApiError::Busy("relay preparation concurrency limit reached".to_owned())
        })?;
        let charge = requested_bytes.max(1);
        let bytes = self
            .bytes
            .clone()
            .try_acquire_many_owned(charge as u32)
            .map_err(|_| {
                MempoolApiError::Busy("relay preparation byte budget exhausted".to_owned())
            })?;
        Ok(PreparePermit {
            _concurrent: concurrent,
            _bytes: bytes,
        })
    }
}

fn invalid_params(msg: impl Into<String>) -> ErrorObjectOwned {
    ErrorObject::owned(INVALID_PARAMS, msg.into(), None::<()>)
}

/// A backend failure that maps onto one JSON-RPC code, and optionally onto a
/// `kind` discriminator in the error data. Mempool errors carry no `kind`.
trait RpcError: std::fmt::Display {
    fn code_and_kind(&self) -> (i32, Option<&'static str>);
}

fn rpc_error<E: RpcError>(error: E) -> ErrorObjectOwned {
    let (code, kind) = error.code_and_kind();
    ErrorObject::owned(
        code,
        error.to_string(),
        kind.map(|kind| serde_json::json!({ "kind": kind })),
    )
}

impl RpcError for StateError {
    fn code_and_kind(&self) -> (i32, Option<&'static str>) {
        (STATE_UNAVAILABLE, Some("storage"))
    }
}

impl RpcError for IndexReadError {
    fn code_and_kind(&self) -> (i32, Option<&'static str>) {
        match self {
            Self::Unavailable(_) => (INDEX_UNAVAILABLE, Some("unavailable")),
            Self::CursorMismatch => (CURSOR_MISMATCH, Some("cursorMismatch")),
            Self::Invalid(_) => (INVALID_PARAMS, Some("invalid")),
        }
    }
}

impl RpcError for IssuanceQuoteError {
    fn code_and_kind(&self) -> (i32, Option<&'static str>) {
        match self {
            Self::CandidateBeforeParent { .. } => (INVALID_PARAMS, None),
            Self::State(error) => error.code_and_kind(),
        }
    }
}

impl RpcError for MempoolApiError {
    fn code_and_kind(&self) -> (i32, Option<&'static str>) {
        let code = match self {
            Self::Unavailable => MEMPOOL_UNAVAILABLE,
            Self::Invalid(_) => MEMPOOL_INVALID,
            Self::State(_) => MEMPOOL_STATE,
            Self::Policy(_) => MEMPOOL_POLICY,
            Self::Full => MEMPOOL_FULL,
            Self::Busy(_) => MEMPOOL_BUSY,
            Self::Verification(_) => MEMPOOL_VERIFICATION,
            Self::Storage(_) => MEMPOOL_STORAGE,
        };
        (code, None)
    }
}

impl RpcError for CatalogApiError {
    fn code_and_kind(&self) -> (i32, Option<&'static str>) {
        match self {
            Self::Unavailable => (CATALOG_UNAVAILABLE, Some("unavailable")),
            Self::Invalid(_) => (CATALOG_INVALID, Some("invalid")),
            Self::Exhausted(_) => (CATALOG_EXHAUSTED, Some("exhausted")),
            Self::Storage(_) => (CATALOG_STORAGE, Some("storage")),
        }
    }
}

/// A catalog request that fails validation at the decoder reports the same code
/// as one rejected inside the service, so a client never has to accept two codes
/// for one class of failure.
fn catalog_invalid(message: impl Into<String>) -> ErrorObjectOwned {
    rpc_error(CatalogApiError::Invalid(message.into()))
}

/// Decode a `0x`-prefixed (or bare) hex string into bytes.
fn decode_hex(s: &str) -> Result<Vec<u8>, ErrorObjectOwned> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(s).map_err(|e| invalid_params(format!("bad hex: {e}")))
}

/// Whether hex `value`, with or without its `0x` prefix, would decode to more
/// than `max_bytes` bytes. Checked before decoding, so an oversized request
/// never allocates its bytes.
fn hex_exceeds(value: &str, max_bytes: usize) -> bool {
    value.strip_prefix("0x").unwrap_or(value).len() > max_bytes.saturating_mul(2)
}

fn decode_hex_bounded(
    value: &str,
    max_bytes: usize,
    label: &str,
) -> Result<Vec<u8>, ErrorObjectOwned> {
    if hex_exceeds(value, max_bytes) {
        return Err(invalid_params(format!("{label} exceeds {max_bytes} bytes")));
    }
    decode_hex(value)
}

/// Decode one `pcash_checkRawTransaction` request. Its byte fields are hex
/// strings, each bounded before it is decoded.
fn decode_check_query(
    query: CheckRawTransactionQuery,
) -> Result<CheckRawTransactionRequest, ErrorObjectOwned> {
    let transaction = decode_hex_bounded(&query.transaction, MAX_MEMPOOL_TX_BYTES, "transaction")?;
    let carrier = match query.carrier {
        CarrierContextQuery::Inbox { address } => CarrierContextRequest::Inbox { address },
        CarrierContextQuery::Event { address, context } => CarrierContextRequest::Event {
            address,
            context: decode_hex_bounded(&context, MAX_CHECK_CONTEXT_BYTES, "carrier context")?,
        },
    };
    Ok(CheckRawTransactionRequest {
        transaction,
        carrier,
    })
}

fn decode_hex32(s: &str) -> Result<B256, ErrorObjectOwned> {
    let b = decode_hex(s)?;
    let bytes: [u8; 32] = b
        .as_slice()
        .try_into()
        .map_err(|_| invalid_params("expected 32-byte value"))?;
    Ok(B256::from(bytes))
}

fn decode_canonical_field(s: &str, label: &str, nonzero: bool) -> Result<B256, ErrorObjectOwned> {
    let hash = decode_hex32(s)?;
    if pcash_state::fr_from_canonical_bytes(hash).is_none() || (nonzero && hash.is_zero()) {
        return Err(invalid_params(format!(
            "{label} must be a {}canonical BN254 field encoding",
            if nonzero { "nonzero " } else { "" }
        )));
    }
    Ok(hash)
}

fn decode_nullifier(s: &str) -> Result<B256, ErrorObjectOwned> {
    decode_canonical_field(s, "nullifier", true)
}

/// A nullifier that already parsed as 32 bytes still has to be a nonzero
/// canonical BN254 element: serde proves the width, not the field membership.
fn canonical_nullifier(value: B256) -> Result<B256, ErrorObjectOwned> {
    if pcash_state::fr_from_canonical_bytes(value).is_none() || value.is_zero() {
        return Err(invalid_params(
            "nullifier must be a nonzero canonical BN254 field encoding",
        ));
    }
    Ok(value)
}

fn decode_address(s: &str) -> Result<Address, ErrorObjectOwned> {
    let b = decode_hex(s)?;
    if b.len() != 20 {
        return Err(invalid_params("expected 20-byte address"));
    }
    Ok(Address::from_slice(&b))
}

/// Parse a JSON-RPC hex *quantity* (`"0x1a"`) into a `u64`.
fn decode_qty(s: &str) -> Result<u64, ErrorObjectOwned> {
    let t = s.strip_prefix("0x").unwrap_or(s);
    u64::from_str_radix(t, 16).map_err(|e| invalid_params(format!("bad quantity: {e}")))
}

/// Parse an output-tree index: a quantity strictly below `2^40`.
fn decode_output_index(s: &str) -> Result<u64, ErrorObjectOwned> {
    let index = decode_qty(s)?;
    if index >= pcash_state::MAX_LEAVES {
        return Err(invalid_params("output index out of range (>= 2^40)"));
    }
    Ok(index)
}

// ---- catalog decoders -----------------------------------------------------
//
// These parse record *framing* only. The node never looks inside a payload, so
// there is deliberately no application-specific field access anywhere below.

/// A catalog request that does not deserialize.
///
/// Shape failures report the same code as a rejection from inside the service,
/// so a client never has to accept two codes for one class of failure.
fn catalog_shape(error: serde_json::Error) -> ErrorObjectOwned {
    catalog_invalid(format!("invalid catalog request: {error}"))
}

fn checked_namespace(namespace: String) -> Result<String, ErrorObjectOwned> {
    if !namespace_is_valid(&namespace) {
        return Err(catalog_invalid(format!(
            "catalog namespace must be 1..={MAX_NAMESPACE_BYTES} bytes matching [a-z0-9][a-z0-9._-]{{0,63}}"
        )));
    }
    Ok(namespace)
}

/// Decode one positional `CatalogArtifact` — what a publisher supplies.
///
/// `createdAt` is deliberately absent from the request: it is assigned by the
/// node and appears only in the response, and the artifact's closed shape
/// rejects it. Framing, the payload bound, and the recomputed content ID are all
/// checked here so a malformed or oversized request is rejected before any
/// storage work is scheduled.
fn decode_catalog_artifact(
    artifact: Value,
    limits: &CatalogLimits,
) -> Result<CatalogArtifact, ErrorObjectOwned> {
    // Bound the encoded payload before deserializing, so an oversized request
    // never allocates its decoded bytes.
    if let Some(encoded) = artifact.get("payload").and_then(Value::as_str) {
        if encoded.len().saturating_sub(2) / 2 > limits.max_payload_bytes {
            return Err(oversized_payload(limits));
        }
    }

    let artifact: CatalogArtifact = serde_json::from_value(artifact).map_err(catalog_shape)?;
    let namespace = checked_namespace(artifact.namespace)?;
    if artifact.payload.len() > limits.max_payload_bytes {
        return Err(oversized_payload(limits));
    }
    if catalog_content_id(&namespace, artifact.pcash_chain_id, &artifact.payload)
        != artifact.content_id
    {
        return Err(catalog_invalid(
            "catalog contentId does not match the artifact",
        ));
    }

    Ok(CatalogArtifact {
        namespace,
        ..artifact
    })
}

fn oversized_payload(limits: &CatalogLimits) -> ErrorObjectOwned {
    catalog_invalid(format!(
        "catalog payload exceeds {} bytes",
        limits.max_payload_bytes
    ))
}

fn decode_catalog_get_request(request: Value) -> Result<CatalogGetRequest, ErrorObjectOwned> {
    let query: CatalogGetQuery = serde_json::from_value(request).map_err(catalog_shape)?;
    Ok(CatalogGetRequest {
        namespace: checked_namespace(query.namespace)?,
        content_id: query.content_id,
    })
}

fn decode_catalog_list_request(
    request: Value,
    limits: &CatalogLimits,
) -> Result<CatalogListRequest, ErrorObjectOwned> {
    let query: CatalogListQuery = serde_json::from_value(request).map_err(catalog_shape)?;
    let limit = match query.limit {
        None => limits.default_page_items,
        Some(0) => return Err(catalog_invalid("catalog limit must be at least 1")),
        Some(requested) => usize::try_from(requested)
            .unwrap_or(limits.max_page_items)
            .min(limits.max_page_items),
    };
    Ok(CatalogListRequest {
        namespace: checked_namespace(query.namespace)?,
        cursor: query.cursor,
        limit,
    })
}

/// Max block summaries one `pcash_getBlocks` call may span; larger ranges are
/// rejected so the tail is never silently dropped (page with narrower windows).
const MAX_BLOCKS_RANGE: u64 = 1_000;

/// Page size used when `pcash_getMempool` does not ask for one.
const DEFAULT_MEMPOOL_PAGE_ITEMS: u64 = 100;
const DEFAULT_EXPLORER_PAGE_ITEMS: u64 = 25;
const MAX_EXPLORER_PAGE_ITEMS: u64 = 100;

/// Max output openings one `pcash_getOutputPaths` call may request. A spend
/// proves at most four inputs against one root; the cap leaves generous
/// headroom for client-side batching while bounding the response.
const MAX_OUTPUT_PATHS_PER_QUERY: usize = 64;
const MAX_NULLIFIERS_PER_QUERY: usize = 256;
const DEFAULT_OUTPUTS: u32 = 2_000;
const MAX_OUTPUTS: u32 = 10_000;
const DEFAULT_ACCOUNT_CHANGES: u32 = 2_000;
const MAX_ACCOUNT_CHANGES: u32 = 10_000;
const DEFAULT_DELIVERY_BATCHES: u32 = 2_000;
const MAX_DELIVERY_BATCHES: u32 = 10_000;
const DEFAULT_PAGE_BYTES: u32 = 1024 * 1024;
const MAX_PAGE_BYTES: u32 = 4 * 1024 * 1024;

fn decode_output_commitment_request(query: OutputQuery) -> Result<OutputRequest, ErrorObjectOwned> {
    let limits = query.limits.unwrap_or_default();
    let limits = OutputLimits {
        max_outputs: bounded(limits.max_outputs, DEFAULT_OUTPUTS, MAX_OUTPUTS)?,
        max_bytes: bounded(limits.max_bytes, DEFAULT_PAGE_BYTES, MAX_PAGE_BYTES)?,
    };
    Ok(OutputRequest {
        from_output_index: query.from_output_index,
        target: query.target,
        continuation: query.continuation,
        limits,
    })
}

fn decode_account_changes_request(
    query: AccountChangesQuery,
) -> Result<AccountChangesRequest, ErrorObjectOwned> {
    let limits = query.limits.unwrap_or_default();
    let limits = AccountChangeLimits {
        max_changes: bounded(
            limits.max_changes,
            DEFAULT_ACCOUNT_CHANGES,
            MAX_ACCOUNT_CHANGES,
        )?,
        max_bytes: bounded(limits.max_bytes, DEFAULT_PAGE_BYTES, MAX_PAGE_BYTES)?,
    };
    Ok(AccountChangesRequest {
        from_block: query.from_block,
        target: query.target,
        continuation: query.continuation,
        limits,
    })
}

fn decode_l1_delivery_batches_request(
    query: L1DeliveryBatchesQuery,
) -> Result<L1DeliveryBatchesRequest, ErrorObjectOwned> {
    let limits = query.limits.unwrap_or_default();
    Ok(L1DeliveryBatchesRequest {
        l1_transaction_hash: query.l1_transaction_hash,
        continuation: query.continuation,
        limits: L1DeliveryBatchLimits {
            max_batches: bounded(
                limits.max_batches,
                DEFAULT_DELIVERY_BATCHES,
                MAX_DELIVERY_BATCHES,
            )?,
            max_bytes: bounded(limits.max_bytes, DEFAULT_PAGE_BYTES, MAX_PAGE_BYTES)?,
        },
    })
}

/// A requested page ceiling, or the default when absent. Zero and over-ceiling
/// are refused rather than clamped, so a caller never silently gets a smaller
/// page than it asked for.
fn bounded<T>(requested: Option<T>, default: T, ceiling: T) -> Result<T, ErrorObjectOwned>
where
    T: Copy + PartialOrd + Default,
{
    match requested {
        None => Ok(default),
        Some(value) if value > T::default() && value <= ceiling => Ok(value),
        Some(_) => Err(invalid_params("wallet scan limits exceed protocol bounds")),
    }
}

fn decode_block_tag(value: Option<String>) -> Result<BlockTag, ErrorObjectOwned> {
    match value.as_deref() {
        None | Some("latest") => Ok(BlockTag::Latest),
        Some(value) if value.len() == 66 && value.starts_with("0x") => {
            decode_hex32(value).map(BlockTag::Hash)
        }
        Some(value) => decode_qty(value).map(BlockTag::Number),
    }
}

/// An explorer page size, refused rather than clamped when out of range.
fn explorer_limit(limit: Option<u64>) -> Result<u64, ErrorObjectOwned> {
    let limit = limit.unwrap_or(DEFAULT_EXPLORER_PAGE_ITEMS);
    if limit == 0 || limit > MAX_EXPLORER_PAGE_ITEMS {
        return Err(invalid_params(format!(
            "limit must be between 1 and {MAX_EXPLORER_PAGE_ITEMS}"
        )));
    }
    Ok(limit)
}

/// Take the single positional string parameter of a request.
fn one_string(params: Params) -> Result<String, ErrorObjectOwned> {
    params
        .one::<String>()
        .map_err(|e| invalid_params(e.to_string()))
}

/// Clients share a fixed admission limit so slow reads cannot create an unbounded
/// blocking-task queue. The permit belongs to the worker even if its caller disconnects.
pub struct BlockingReads(Arc<Semaphore>);

impl Default for BlockingReads {
    fn default() -> Self {
        Self::with_permits(32)
    }
}

impl BlockingReads {
    pub fn with_permits(permits: usize) -> Self {
        Self(Arc::new(Semaphore::new(permits)))
    }
}

pub fn register_read<Context, F>(
    reads: &BlockingReads,
    module: &mut RpcModule<Context>,
    name: &'static str,
    callback: F,
) -> Result<(), jsonrpsee::core::RegisterMethodError>
where
    Context: Send + Sync + 'static,
    F: Fn(Params<'static>, &Context, ()) -> Result<Value, ErrorObjectOwned>
        + Clone
        + Send
        + Sync
        + 'static,
{
    let budget = reads.0.clone();
    module
        .register_async_method(name, move |params, api, _| {
            let budget = budget.clone();
            let callback = callback.clone();
            async move {
                let permit = budget.try_acquire_owned().map_err(|_| {
                    ErrorObject::owned(-32004, "RPC capacity exhausted", None::<()>)
                })?;
                tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    callback(params, &api, ())
                })
                .await
                .map_err(|error| {
                    ErrorObject::owned(
                        INTERNAL_ERROR,
                        format!("read worker failed: {error}"),
                        None::<()>,
                    )
                })?
            }
        })
        .map(|_| ())
}

/// Build the `pcash_*` [`RpcModule`] over a [`NodeApi`] context.
pub fn build_module(api: Ctx) -> RpcModule<Ctx> {
    let mut m = RpcModule::new(api);
    let prepare_budget = Arc::new(PrepareBudget::new());
    let reads = BlockingReads::default();
    let publications = BlockingReads::with_permits(MAX_CONCURRENT_CATALOG_PUBLICATIONS);
    register_read(
        &reads,
        &mut m,
        "pcash_getPayouts",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let query = params
                .one::<crate::request::PayoutQuery>()
                .map_err(|e| invalid_params(e.to_string()))?;
            encode(&api.get_payouts(query).map_err(rpc_error)?)
        },
    )
    .expect("register pcash_getPayouts");
    register_read(
        &reads,
        &mut m,
        "pcash_getBlockEconomics",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let query = params
                .one::<crate::request::BlockEconomicsQuery>()
                .map_err(|e| invalid_params(e.to_string()))?;
            encode(&api.get_block_economics(query).map_err(rpc_error)?)
        },
    )
    .expect("register pcash_getBlockEconomics");
    register_read(
        &reads,
        &mut m,
        "pcash_getIssuanceQuote",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let query = params
                .one::<crate::request::IssuanceQuoteQuery>()
                .map_err(|e| invalid_params(e.to_string()))?;
            encode_optional(
                api.get_issuance_quote(query.candidate_timestamp)
                    .map_err(rpc_error)?,
            )
        },
    )
    .expect("register pcash_getIssuanceQuote");

    register_read(
        &reads,
        &mut m,
        "pcash_status",
        |_params, api, ()| -> Result<Value, ErrorObjectOwned> {
            encode(&api.status().map_err(rpc_error)?)
        },
    )
    .expect("register pcash_status");

    register_read(
        &reads,
        &mut m,
        "pcash_getOutputPath",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let output_index = decode_output_index(&one_string(params)?)?;
            encode_optional(api.get_output_path(output_index).map_err(rpc_error)?)
        },
    )
    .expect("register pcash_getOutputPath");

    register_read(
        &reads,
        &mut m,
        "pcash_getWitnessSnapshot",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let query = params
                .one::<crate::request::WitnessSnapshotQuery>()
                .map_err(|error| invalid_params(error.to_string()))?;
            if query.accounts.len() + query.contracts.len() + query.l1_logs.len() > 64
                || query.outputs.len() > MAX_OUTPUT_PATHS_PER_QUERY
                || query.nullifiers.len() > MAX_NULLIFIERS_PER_QUERY
            {
                return Err(invalid_params(
                    "witness snapshot request exceeds per-call limits",
                ));
            }
            if query
                .outputs
                .iter()
                .any(|&index| index >= pcash_state::MAX_LEAVES)
            {
                return Err(invalid_params("output index exceeds depth-40 tree"));
            }
            for &nullifier in &query.nullifiers {
                canonical_nullifier(nullifier)?;
            }
            encode(&api.get_witness_snapshot(query).map_err(rpc_error)?)
        },
    )
    .expect("register pcash_getWitnessSnapshot");

    register_read(&reads, &mut m,
        "pcash_getOutputPaths",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            // Single positional array of leaf-index quantities: `[["0x0","0x5"]]`.
            let raw = params
                .one::<Vec<String>>()
                .map_err(|e| invalid_params(e.to_string()))?;
            if raw.len() > MAX_OUTPUT_PATHS_PER_QUERY {
                return Err(invalid_params(format!(
                    "requested {} output paths exceeds the {MAX_OUTPUT_PATHS_PER_QUERY}-per-call limit",
                    raw.len()
                )));
            }
            let mut indices = Vec::with_capacity(raw.len());
            for s in &raw {
                indices.push(decode_output_index(s)?);
            }
            encode_optional(api.get_output_paths(&indices).map_err(rpc_error)?)
        },
    )
    .expect("register pcash_getOutputPaths");

    register_read(
        &reads,
        &mut m,
        "pcash_getAccountProof",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let address = decode_address(&one_string(params)?)?;
            encode(&api.get_account_proof(address).map_err(rpc_error)?)
        },
    )
    .expect("register pcash_getAccountProof");

    register_read(
        &reads,
        &mut m,
        "pcash_getAccount",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let addr = decode_address(&one_string(params)?)?;
            encode_optional(api.get_account(addr).map_err(rpc_error)?)
        },
    )
    .expect("register pcash_getAccount");

    register_read(
        &reads,
        &mut m,
        "pcash_getContract",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let addr = decode_address(&one_string(params)?)?;
            encode(&api.get_contract(addr).map_err(rpc_error)?)
        },
    )
    .expect("register pcash_getContract");

    register_read(
        &reads,
        &mut m,
        "pcash_getBlockHeader",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let value = params.sequence().optional_next::<String>()?;
            let tag = decode_block_tag(value)?;
            api.get_block_header(tag)
                .map_err(rpc_error)?
                .ok_or_else(|| invalid_params("unknown PCASH block tag"))
                .and_then(|response| encode(&response))
        },
    )
    .expect("register pcash_getBlockHeader");

    register_read(
        &reads,
        &mut m,
        "pcash_getL1OriginProof",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let (hash, number): (String, String) = params
                .parse()
                .map_err(|error| invalid_params(error.to_string()))?;
            let hash = decode_canonical_field(&hash, "recentPcashBlockHash", true)?;
            let l1_block_number = decode_qty(&number)?;
            match api
                .get_l1_origin_proof(hash, l1_block_number)
                .map_err(rpc_error)?
            {
                Some(d) => encode(&d),
                None => Err(invalid_params(
                    "unknown PCASH block or Ethereum block outside its range",
                )),
            }
        },
    )
    .expect("register pcash_getL1OriginProof");

    register_read(
        &reads,
        &mut m,
        "pcash_getL1LogProof",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let (hash, number, transaction, log): (String, String, String, String) = params
                .parse()
                .map_err(|error| invalid_params(error.to_string()))?;
            let hash = decode_canonical_field(&hash, "recentPcashBlockHash", true)?;
            let l1_block_number = decode_qty(&number)?;
            let transaction_index = decode_qty(&transaction)?;
            let log_index = decode_qty(&log)?;
            match api
                .get_l1_log_proof(hash, l1_block_number, transaction_index, log_index)
                .map_err(rpc_error)?
            {
                Some(d) => encode(&d),
                None => Err(invalid_params(
                    "unknown PCASH block, Ethereum block, or normalized log",
                )),
            }
        },
    )
    .expect("register pcash_getL1LogProof");

    register_read(
        &reads,
        &mut m,
        "pcash_getResultProof",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let (hash, number, position): (String, String, crate::dto::ResultPosition) = params
                .parse()
                .map_err(|error| invalid_params(error.to_string()))?;
            let hash = decode_canonical_field(&hash, "recentPcashBlockHash", true)?;
            let number = decode_qty(&number)?;
            encode(
                &api.get_result_proof(hash, number, position)
                    .map_err(rpc_error)?,
            )
        },
    )
    .expect("register pcash_getResultProof");

    register_read(
        &reads,
        &mut m,
        "pcash_getHistoryProof",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let (hash, number): (String, String) = params
                .parse()
                .map_err(|error| invalid_params(error.to_string()))?;
            let hash = decode_canonical_field(&hash, "recentPcashBlockHash", true)?;
            let historical_block_number = decode_qty(&number)?;
            match api
                .get_history_proof(hash, historical_block_number)
                .map_err(rpc_error)?
            {
                Some(d) => encode(&d),
                None => Err(invalid_params(
                    "unknown PCASH block or historical block outside its range",
                )),
            }
        },
    )
    .expect("register pcash_getHistoryProof");

    register_read(
        &reads,
        &mut m,
        "pcash_getBlockByNumber",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let (number, full_transactions): (String, bool) = params
                .parse()
                .map_err(|error| invalid_params(error.to_string()))?;
            let number = decode_qty(&number)?;
            encode_optional(
                api.get_block(number, full_transactions)
                    .map_err(rpc_error)?,
            )
        },
    )
    .expect("register pcash_getBlockByNumber");

    register_read(
        &reads,
        &mut m,
        "pcash_getBlockByHash",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let (hash, full_transactions): (String, bool) = params
                .parse()
                .map_err(|error| invalid_params(error.to_string()))?;
            let hash = decode_canonical_field(&hash, "blockHash", true)?;
            encode_optional(
                api.get_block_by_hash(hash, full_transactions)
                    .map_err(rpc_error)?,
            )
        },
    )
    .expect("register pcash_getBlockByHash");

    register_read(&reads, &mut m,
        "pcash_getBlocks",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            // Single positional object `[{fromBlock, toBlock}]` of PCASH block numbers; both
            // optional. Parse the first element so a malformed shape is an error, not
            // a silent default. Absent fromBlock = genesis; absent (or over-tip)
            // toBlock resolves to the current PCASH tip.
            let q: BlockRangeQuery = params
                .sequence()
                .optional_next::<BlockRangeQuery>()?
                .unwrap_or_default();
            // `from`/`to` are PCASH block numbers and `latestBlock` is the PCASH tip.
            let tip = api.status().map_err(rpc_error)?.latest_block;
            let from = q.from_block.unwrap_or(0);
            let to = q.to_block.unwrap_or(tip).min(tip);
            // A window entirely past the tip is not an error — it's just empty yet.
            if from > to {
                return Ok(Value::Array(Vec::new()));
            }
            // Reject rather than truncate: a silently dropped tail reads as "no
            // blocks there" when there are. Callers page with narrower windows.
            let span = to - from + 1;
            if span > MAX_BLOCKS_RANGE {
                return Err(invalid_params(format!(
                    "requested {span} blocks exceeds the {MAX_BLOCKS_RANGE}-block per-call limit; page with a narrower range"
                )));
            }
            if q.full_transactions && span != 1 {
                return Err(invalid_params(
                    "full transaction bodies require a single-block range",
                ));
            }
            encode(&api.get_blocks(from, to, q.full_transactions).map_err(rpc_error)?)
        },
    )
    .expect("register pcash_getBlocks");

    register_read(
        &reads,
        &mut m,
        "pcash_getTransactions",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let mut query = params
                .sequence()
                .optional_next::<TransactionsQuery>()?
                .unwrap_or_default();
            let limit = explorer_limit(query.limit)?;
            query.limit = Some(limit);
            api.get_transactions(query)
                .map_err(rpc_error)
                .and_then(|page| encode(&page))
        },
    )
    .expect("register pcash_getTransactions");

    register_read(
        &reads,
        &mut m,
        "pcash_getTransaction",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let tx_id = decode_hex32(&one_string(params)?)?;
            encode_optional(api.get_transaction(tx_id).map_err(rpc_error)?)
        },
    )
    .expect("register pcash_getTransaction");

    register_read(
        &reads,
        &mut m,
        "pcash_getSubmission",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let query = params
                .one::<SubmissionQuery>()
                .map_err(|error| invalid_params(error.to_string()))?;
            let limit = explorer_limit(query.limit)?;
            encode(
                &api.get_submission(SubmissionQuery {
                    limit: Some(limit),
                    ..query
                })
                .map_err(rpc_error)?,
            )
        },
    )
    .expect("register pcash_getSubmission");

    register_read(
        &reads,
        &mut m,
        "pcash_getAccountHistory",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let query = params
                .one::<AccountHistoryQuery>()
                .map_err(|error| invalid_params(error.to_string()))?;
            let limit = explorer_limit(query.limit)?;
            encode(
                &api.get_account_history(AccountHistoryQuery {
                    limit: Some(limit),
                    ..query
                })
                .map_err(rpc_error)?,
            )
        },
    )
    .expect("register pcash_getAccountHistory");

    register_read(
        &reads,
        &mut m,
        "pcash_getTransactionByNullifier",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let nullifier = decode_hex32(&one_string(params)?)?;
            encode_optional(
                api.get_transaction_by_nullifier(nullifier)
                    .map_err(rpc_error)?,
            )
        },
    )
    .expect("register pcash_getTransactionByNullifier");

    register_read(
        &reads,
        &mut m,
        "pcash_getL1DeliveryBatches",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let query = params
                .one::<L1DeliveryBatchesQuery>()
                .map_err(|error| invalid_params(error.to_string()))?;
            let request = decode_l1_delivery_batches_request(query)?;
            api.get_l1_delivery_batches(request)
                .map_err(rpc_error)
                .and_then(|page| encode(&page))
        },
    )
    .expect("register pcash_getL1DeliveryBatches");

    register_read(
        &reads,
        &mut m,
        "pcash_getBlockPayouts",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let block = params
                .one::<BlockId>()
                .map_err(|error| invalid_params(error.to_string()))?;
            encode_optional(api.get_block_payouts(block).map_err(rpc_error)?)
        },
    )
    .expect("register pcash_getBlockPayouts");

    register_read(
        &reads,
        &mut m,
        "pcash_estimateFee",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let query = params
                .one::<FeeEstimateQuery>()
                .map_err(|error| invalid_params(error.to_string()))?;
            let byte_size = query
                .byte_size
                .or_else(|| {
                    query.kind.map(|kind| match kind {
                        FeeBearingKind::PrivateValue => {
                            pcash_derive::PRIVATE_VALUE_MAX_TX_BYTES as u64
                        }
                        FeeBearingKind::ContractAccount => {
                            pcash_derive::CONTRACT_MAX_TX_BYTES as u64
                        }
                        FeeBearingKind::UserAccountUpdate => {
                            pcash_derive::USER_ACCOUNT_UPDATE_MAX_TX_BYTES as u64
                        }
                    })
                })
                .ok_or_else(|| invalid_params("kind or byteSize is required"))?;
            if byte_size == 0 || byte_size > MAX_MEMPOOL_TX_BYTES as u64 {
                return Err(invalid_params(format!(
                    "byteSize must be between 1 and {MAX_MEMPOOL_TX_BYTES}"
                )));
            }
            encode(&api.estimate_fee(byte_size).map_err(rpc_error)?)
        },
    )
    .expect("register pcash_estimateFee");

    register_read(
        &reads,
        &mut m,
        "pcash_getContracts",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let mut query = params
                .sequence()
                .optional_next::<ContractsQuery>()?
                .unwrap_or_default();
            let limit = explorer_limit(query.limit)?;
            query.limit = Some(limit);
            api.get_contracts(query)
                .map_err(rpc_error)
                .and_then(|page| encode(&page))
        },
    )
    .expect("register pcash_getContracts");

    register_read(
        &reads,
        &mut m,
        "pcash_areNullifiersSpent",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let raw = params
                .one::<Vec<String>>()
                .map_err(|e| invalid_params(e.to_string()))?;
            if raw.len() > MAX_NULLIFIERS_PER_QUERY {
                return Err(invalid_params(format!(
                    "nullifier request exceeds {MAX_NULLIFIERS_PER_QUERY} entries"
                )));
            }
            let mut nulls = Vec::with_capacity(raw.len());
            for s in &raw {
                nulls.push(decode_nullifier(s)?);
            }
            let bits = api.are_nullifiers_spent(&nulls).map_err(rpc_error)?;
            Ok(Value::Array(bits.into_iter().map(Value::Bool).collect()))
        },
    )
    .expect("register pcash_areNullifiersSpent");

    register_read(
        &reads,
        &mut m,
        "pcash_getNullifierProofs",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let raw = params
                .one::<Vec<String>>()
                .map_err(|error| invalid_params(error.to_string()))?;
            if raw.len() > MAX_NULLIFIERS_PER_QUERY {
                return Err(invalid_params(format!(
                    "nullifier request exceeds {MAX_NULLIFIERS_PER_QUERY} entries"
                )));
            }
            let nullifiers = raw
                .iter()
                .map(|value| decode_nullifier(value))
                .collect::<Result<Vec<_>, _>>()?;
            api.get_nullifier_proofs(&nullifiers)
                .map_err(rpc_error)?
                .ok_or_else(|| {
                    ErrorObject::owned(
                        INDEX_UNAVAILABLE,
                        "canonical boundary unavailable",
                        None::<()>,
                    )
                })
                .and_then(|found| encode(&found))
        },
    )
    .expect("register pcash_getNullifierProofs");

    register_read(
        &reads,
        &mut m,
        "pcash_getReceipt",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let query = params
                .one::<ReceiptQuery>()
                .map_err(|e| invalid_params(e.to_string()))?;
            match &query {
                ReceiptQuery::Nullifier(ReceiptNullifierQuery { nullifier }) => {
                    canonical_nullifier(*nullifier)?;
                }
                ReceiptQuery::TxId(_)
                | ReceiptQuery::Content(_)
                | ReceiptQuery::Inclusion(_)
                | ReceiptQuery::Account(_) => {}
            }
            let receipts = api.get_receipt(query).map_err(rpc_error)?;
            encode(&receipts)
        },
    )
    .expect("register pcash_getReceipt");

    // Admission waits in the mempool's bounded queue, which refuses at once
    // when full, so no runtime thread is held while it waits.
    m.register_async_method("pcash_submitRawTransaction", |params, api, _| async move {
        let raw_hex = one_string(params)?;
        let raw = decode_hex_bounded(&raw_hex, MAX_MEMPOOL_TX_BYTES, "transaction")?;
        api.submit_raw_transaction(raw)
            .await
            .map_err(rpc_error)
            .and_then(|entry| encode(&entry))
    })
    .expect("register pcash_submitRawTransaction");

    // A check waits in the same queue and runs on the same verifier workers.
    m.register_async_method("pcash_checkRawTransaction", |params, api, _| async move {
        let query = params
            .one::<CheckRawTransactionQuery>()
            .map_err(|error| invalid_params(error.to_string()))?;
        api.check_raw_transaction(decode_check_query(query)?)
            .await
            .map_err(rpc_error)
            .and_then(|check| encode(&check))
    })
    .expect("register pcash_checkRawTransaction");

    register_read(
        &reads,
        &mut m,
        "pcash_getMempool",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let q: MempoolQuery = params
                .sequence()
                .optional_next::<MempoolQuery>()?
                .unwrap_or_default();
            let limit = usize::try_from(q.limit.unwrap_or(DEFAULT_MEMPOOL_PAGE_ITEMS))
                .map_err(|_| invalid_params("limit too large"))?;
            // An unrecognized `kind` is rejected by the decoder; a recognized
            // one the mempool cannot hold is rejected here.
            if q.kind.is_some_and(|kind| !kind.is_admissible()) {
                return Err(invalid_params(
                    "kind must name a transaction type the mempool can hold",
                ));
            }
            if q.controlled_issuance_owner_commitments
                .as_ref()
                .is_some_and(|commitments| commitments.len() > MAX_PREPARE_REQUEST_IDS)
            {
                return Err(invalid_params(format!(
                    "controlledIssuanceOwnerCommitments exceeds {MAX_PREPARE_REQUEST_IDS} entries"
                )));
            }
            api.get_mempool(MempoolFilter {
                cursor: q.cursor,
                limit,
                kind: q.kind,
                min_open_fee: q.min_open_fee.unwrap_or(U256::ZERO),
                status: q.status,
                controlled_issuance_owner_commitments: q.controlled_issuance_owner_commitments,
                sort: q.sort.unwrap_or_default(),
                arena: q.arena.map(ArenaFilter::from_query).transpose()?,
            })
            .map_err(rpc_error)
            .and_then(|page| encode(&page))
        },
    )
    .expect("register pcash_getMempool");

    register_read(
        &reads,
        &mut m,
        "pcash_getMempoolTransaction",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let content_hash = decode_hex32(&one_string(params)?)?;
            encode_optional(
                api.get_mempool_transaction(&content_hash)
                    .map_err(rpc_error)?,
            )
        },
    )
    .expect("register pcash_getMempoolTransaction");

    m.register_async_method("pcash_prepareRelay", move |params, api, _| {
        let prepare_budget = prepare_budget.clone();
        async move {
            let q: PrepareRelayQuery = params.one().map_err(|e| invalid_params(e.to_string()))?;
            if q.content_hashes.len() > MAX_PREPARE_REQUEST_IDS {
                return Err(invalid_params(format!(
                    "contentHashes exceeds {MAX_PREPARE_REQUEST_IDS} entries"
                )));
            }
            let content_hashes = q.content_hashes;
            let controlled_issuance_owner_commitments = q.controlled_issuance_owner_commitments;
            let controlled_issuance_content_hashes = q.controlled_issuance_content_hashes;
            if controlled_issuance_owner_commitments.len() > MAX_PREPARE_REQUEST_IDS {
                return Err(invalid_params(
                    "too many controlled payout owner commitments",
                ));
            }
            if controlled_issuance_content_hashes.len() > MAX_PREPARE_REQUEST_IDS {
                return Err(invalid_params(format!(
                    "controlledIssuanceContentHashes exceeds {MAX_PREPARE_REQUEST_IDS} entries"
                )));
            }
            for commitment in &controlled_issuance_owner_commitments {
                if commitment.is_zero()
                    || pcash_state::fr_from_canonical_bytes(*commitment).is_none()
                {
                    return Err(invalid_params(
                        "controlled payout owner commitment must be a nonzero canonical field",
                    ));
                }
            }

            let max_batch_bytes = usize::try_from(q.max_batch_bytes)
                .map_err(|_| invalid_params("maxBatchBytes too large"))?;
            if max_batch_bytes > MAX_PREPARED_BATCH_BYTES {
                return Err(invalid_params(format!(
                    "maxBatchBytes exceeds {MAX_PREPARED_BATCH_BYTES}"
                )));
            }
            let permit = prepare_budget
                .try_acquire(max_batch_bytes)
                .map_err(rpc_error)?;
            let request = PrepareRelayRequest {
                content_hashes,
                controlled_issuance_owner_commitments,
                controlled_issuance_content_hashes,
                max_batch_bytes,
            };
            let api = api.clone();
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                api.prepare_relay(request)
            })
            .await
            .map_err(|e| {
                rpc_error(MempoolApiError::Verification(format!(
                    "prepare worker failed: {e}"
                )))
            })?
            .map_err(rpc_error)
            .and_then(|prepared| encode(&prepared))
        }
    })
    .expect("register pcash_prepareRelay");

    // All three catalog methods register whether or not the service is enabled,
    // so capability detection is stable and a disabled node answers with a
    // structured error rather than "method not found".
    register_read(
        &reads,
        &mut m,
        "pcash_catalogInfo",
        |_params, api, ()| -> Result<Value, ErrorObjectOwned> { encode(&api.catalog_info()) },
    )
    .expect("register pcash_catalogInfo");

    register_read(&reads, &mut m, "pcash_catalogList", |params, api, ()| {
        let request = params
            .one::<Value>()
            .map_err(|error| invalid_params(error.to_string()))?;
        let request = decode_catalog_list_request(request, &api.catalog_info().limits)?;
        api.catalog_list(request)
            .map_err(rpc_error)
            .and_then(|page| encode(&page))
    })
    .expect("register pcash_catalogList");

    register_read(&reads, &mut m, "pcash_catalogGet", |params, api, ()| {
        let request = params
            .one::<Value>()
            .map_err(|error| invalid_params(error.to_string()))?;
        let request = decode_catalog_get_request(request)?;
        api.catalog_get(request)
            .map_err(rpc_error)
            .and_then(encode_optional)
    })
    .expect("register pcash_catalogGet");

    register_read(
        &publications,
        &mut m,
        "pcash_catalogPublish",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let artifact = params
                .one::<Value>()
                .map_err(|error| invalid_params(error.to_string()))?;
            let artifact = decode_catalog_artifact(artifact, &api.catalog_info().limits)?;
            api.catalog_publish(artifact)
                .map_err(rpc_error)
                .and_then(|stored| encode(&stored))
        },
    )
    .expect("register pcash_catalogPublish");

    register_read(
        &reads,
        &mut m,
        "pcash_getOutputFrontier",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let block = params
                .one::<BlockId>()
                .map_err(|error| invalid_params(error.to_string()))?;
            api.get_output_frontier(block)
                .map_err(rpc_error)
                .and_then(|frontier| encode(&frontier))
        },
    )
    .expect("register pcash_getOutputFrontier");

    register_read(
        &reads,
        &mut m,
        "pcash_getAccountChanges",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let query = params
                .one::<AccountChangesQuery>()
                .map_err(|error| invalid_params(error.to_string()))?;
            let request = decode_account_changes_request(query)?;
            api.get_account_changes(request)
                .map_err(rpc_error)
                .and_then(|page| encode(&page))
        },
    )
    .expect("register pcash_getAccountChanges");

    register_read(
        &reads,
        &mut m,
        "pcash_getOutputs",
        |params, api, ()| -> Result<Value, ErrorObjectOwned> {
            let query = params
                .one::<OutputQuery>()
                .map_err(|error| invalid_params(error.to_string()))?;
            let request = decode_output_commitment_request(query)?;
            api.get_outputs(request)
                .map_err(rpc_error)
                .and_then(|page| encode(&page))
        },
    )
    .expect("register pcash_getOutputs");

    m
}

/// Bind a jsonrpsee server (HTTP + WebSocket on one socket) serving the `pcash_*`
/// namespace and return its [`ServerHandle`]. The server runs until the handle is
/// dropped or `stop()`ed.
///
/// A permissive CORS layer (any origin/method/header) is applied as jsonrpsee HTTP
/// middleware so browser apps served from any port can call the namespace
/// cross-origin. The layer answers preflight `OPTIONS` and stamps
/// `access-control-allow-*` on responses.
pub async fn serve(addr: SocketAddr, api: Ctx) -> std::io::Result<(SocketAddr, ServerHandle)> {
    serve_with_metrics(addr, api, pcash_metrics::noop(), Methods::new()).await
}

/// [`serve`] with an injected recorder. Tests and an unconfigured node pass
/// [`pcash_metrics::NoopMetrics`].
/// `extensions` are further namespaces served beside `pcash_*` on the same
/// listener, such as the optional board index.
pub async fn serve_with_metrics(
    addr: SocketAddr,
    api: Ctx,
    metrics: Arc<dyn Metrics>,
    extensions: Methods,
) -> std::io::Result<(SocketAddr, ServerHandle)> {
    let mut module = build_module(api);
    module
        .merge(extensions)
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    let registered_methods = Arc::new(module.method_names().collect::<HashSet<_>>());
    let cors = CorsLayer::permissive();
    let http_middleware = tower::ServiceBuilder::new().layer(cors);
    let rpc_middleware = RpcServiceBuilder::new().layer_fn(move |service| RpcMetricsService {
        service,
        metrics: Arc::clone(&metrics),
        registered_methods: Arc::clone(&registered_methods),
    });
    let config = ServerConfig::builder()
        .max_request_body_size(MAX_RPC_REQUEST_BODY_BYTES)
        .max_response_body_size(MAX_RPC_RESPONSE_BODY_BYTES)
        .max_connections(MAX_RPC_CONNECTIONS)
        .set_batch_request_config(BatchRequestConfig::Limit(MAX_RPC_BATCH_LEN))
        .build();
    let server = Server::builder()
        .set_config(config)
        .set_http_middleware(http_middleware)
        .set_rpc_middleware(rpc_middleware)
        .build(addr)
        .await?;
    let local = server.local_addr()?;
    let handle = server.start(module);
    Ok((local, handle))
}

#[derive(Clone)]
pub struct RpcMetricsService<S> {
    pub service: S,
    pub metrics: Arc<dyn Metrics>,
    pub registered_methods: Arc<HashSet<&'static str>>,
}

impl<S> RpcServiceT for RpcMetricsService<S>
where
    S: RpcServiceT<
            MethodResponse = MethodResponse,
            BatchResponse = MethodResponse,
            NotificationResponse = MethodResponse,
        > + Send
        + Sync
        + Clone
        + 'static,
{
    type MethodResponse = S::MethodResponse;
    type BatchResponse = S::BatchResponse;
    type NotificationResponse = S::NotificationResponse;

    fn call<'a>(
        &self,
        request: Request<'a>,
    ) -> impl Future<Output = Self::MethodResponse> + Send + 'a {
        let method = if self.registered_methods.contains(request.method_name()) {
            request.method_name()
        } else {
            "unknown"
        }
        .to_owned();
        let service = self.service.clone();
        let metrics = Arc::clone(&self.metrics);
        async move {
            let started = Instant::now();
            let response = service.call(request).await;
            metrics.record_rpc(&method, response.as_error_code(), started.elapsed());
            response
        }
    }

    fn batch<'a>(&self, batch: Batch<'a>) -> impl Future<Output = Self::BatchResponse> + Send + 'a {
        let this = self.clone();
        async move {
            let mut batch_rp =
                BatchResponseBuilder::new_with_limit(MAX_RPC_RESPONSE_BODY_BYTES as usize);
            let mut got_notification = false;
            for entry in batch {
                match entry {
                    Ok(BatchEntry::Call(request)) => {
                        let response = this.call(request).await;
                        if let Err(error) = batch_rp.append(response) {
                            return error;
                        }
                    }
                    Ok(BatchEntry::Notification(notification)) => {
                        got_notification = true;
                        this.notification(notification).await;
                    }
                    Err(error) => {
                        let (error, id) = error.into_parts();
                        let started = Instant::now();
                        this.metrics
                            .record_rpc("unknown", Some(error.code()), started.elapsed());
                        if let Err(error) = batch_rp.append(MethodResponse::error(id, error)) {
                            return error;
                        }
                    }
                }
            }
            if batch_rp.is_empty() && got_notification {
                MethodResponse::notification()
            } else {
                MethodResponse::from_batch(batch_rp.finish())
            }
        }
    }

    fn notification<'a>(
        &self,
        n: Notification<'a>,
    ) -> impl Future<Output = Self::NotificationResponse> + Send + 'a {
        self.service.notification(n)
    }
}

#[cfg(test)]
mod resource_limit_tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn blocking_reads_leave_runtime_free_and_bound_cancelled_work() {
        let mut module = RpcModule::new(Arc::new(crate::test_support::StubNode::absent()) as Ctx);
        let reads = BlockingReads(Arc::new(Semaphore::new(1)));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let started_tx = Arc::new(std::sync::Mutex::new(Some(started_tx)));
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let release_rx = Arc::new(std::sync::Mutex::new(release_rx));
        register_read(&reads, &mut module, "slow_read", move |_, _, ()| {
            if let Some(started) = started_tx.lock().unwrap().take() {
                started.send(()).unwrap();
                release_rx
                    .lock()
                    .unwrap()
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
            }
            Ok(Value::Null)
        })
        .unwrap();
        let module = Arc::new(module);
        let first_module = module.clone();
        let first = tokio::spawn(async move {
            first_module
                .call::<_, Value>("slow_read", jsonrpsee::rpc_params![])
                .await
        });
        started_rx.await.unwrap();
        // This runs on the only async worker while the read remains blocked.
        first.abort();
        let _ = first.await;
        let error = module
            .call::<_, Value>("slow_read", jsonrpsee::rpc_params![])
            .await
            .unwrap_err();
        assert!(error.to_string().contains("RPC capacity exhausted"));
        release_tx.send(()).unwrap();
        let permit = reads.0.acquire().await.unwrap();
        drop(permit);
        assert_eq!(
            module
                .call::<_, Value>("slow_read", jsonrpsee::rpc_params![])
                .await
                .unwrap(),
            Value::Null
        );
    }

    #[test]
    fn prepare_budget_bounds_concurrency_and_declared_byte_work() {
        let budget = PrepareBudget::with_limits(2, 100);
        let first = budget.try_acquire(60).expect("first request");
        assert!(
            matches!(budget.try_acquire(50), Err(MempoolApiError::Busy(_))),
            "aggregate byte budget"
        );
        let second = budget.try_acquire(40).expect("remaining byte budget");
        assert!(
            matches!(budget.try_acquire(1), Err(MempoolApiError::Busy(_))),
            "concurrency budget"
        );

        drop(first);
        assert!(budget.try_acquire(60).is_ok());
        drop(second);
    }

    #[test]
    fn rpc_response_limit_covers_max_hex_batch_and_selection_metadata() {
        let minimum = 2 * MAX_PREPARED_BATCH_BYTES + MAX_PREPARE_REQUEST_IDS * 256;
        assert!(MAX_RPC_RESPONSE_BODY_BYTES as usize >= minimum);
    }

    #[test]
    fn output_commitment_request_uses_a_dense_output_index_cursor() {
        let hash = format!("0x{}", "11".repeat(32));
        let query: OutputQuery = serde_json::from_value(serde_json::json!({
            "fromOutputIndex": "0x12",
            "target": { "blockNumber": "0x0", "blockHash": hash },
            "limits": { "maxOutputs": "0x20", "maxBytes": "0x1000" },
        }))
        .unwrap();
        let request = decode_output_commitment_request(query).unwrap();
        assert_eq!(request.from_output_index, 0x12);
        assert_eq!(request.limits.max_outputs, 0x20);
        assert_eq!(request.limits.max_bytes, 0x1000);
    }

    #[test]
    fn output_commitment_continuation_is_a_closed_shape() {
        let hash = format!("0x{}", "11".repeat(32));
        assert!(serde_json::from_value::<BlockId>(serde_json::json!({
            "blockNumber": "0x5",
            "blockHash": hash,
            "surprise": "0x1",
        }))
        .is_err());
        assert!(
            serde_json::from_value::<OutputContinuationDto>(serde_json::json!({
                "fromOutputIndex": "0x0",
                "target": { "blockNumber": "0x5", "blockHash": hash },
                "targetOutputCount": "0x2",
                "nextOutputIndex": "0x1",
                "surprise": "0x1",
            }))
            .is_err()
        );
    }

    #[test]
    fn catalog_shape_failures_keep_the_catalog_error_code() {
        // A malformed catalog request reports the catalog's own code, not the
        // generic -32602, so a client never has to accept two codes for one
        // class of failure.
        let limits = CatalogLimits::default();
        let error = decode_catalog_list_request(
            serde_json::json!({ "namespace": "pcash.marketplace.offer.v1", "surprise": 1 }),
            &limits,
        )
        .unwrap_err();
        assert_eq!(error.code(), CATALOG_INVALID);

        let error =
            decode_catalog_get_request(serde_json::json!({ "namespace": "x" })).unwrap_err();
        assert_eq!(error.code(), CATALOG_INVALID);

        let error = decode_catalog_artifact(serde_json::json!([]), &limits).unwrap_err();
        assert_eq!(error.code(), CATALOG_INVALID);
    }

    #[test]
    fn rpc_query_objects_reject_unknown_fields() {
        assert!(
            serde_json::from_value::<BlockRangeQuery>(serde_json::json!({
                "from": "0x1"
            }))
            .is_err()
        );
        assert!(serde_json::from_value::<MempoolQuery>(serde_json::json!({
            "unexpected": "0x1"
        }))
        .is_err());
        assert!(
            serde_json::from_value::<PrepareRelayQuery>(serde_json::json!({
                "contentHashes": [],
                "relayerAddress": format!("0x{}", "00".repeat(20)),
                "maxBatchBytes": "0x1",
                "unexpectedMaxBytes": "0x1"
            }))
            .is_err()
        );
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions"
)]
mod error_mapping_tests {
    use super::*;
    use pcash_state::StateError;

    #[test]
    fn state_errors_map_to_the_storage_code() {
        let (code, kind) = StateError::Backend("x".into()).code_and_kind();
        assert_eq!(code, STATE_UNAVAILABLE);
        assert_eq!(kind, Some("storage"));
    }

    #[test]
    fn index_read_errors_split_unavailable_cursor_and_invalid_codes() {
        let (unavailable, kind) = IndexReadError::Unavailable("x".into()).code_and_kind();
        assert_eq!(
            (unavailable, kind),
            (INDEX_UNAVAILABLE, Some("unavailable"))
        );

        let (cursor, kind) = IndexReadError::CursorMismatch.code_and_kind();
        assert_eq!((cursor, kind), (CURSOR_MISMATCH, Some("cursorMismatch")));

        let (invalid, kind) = IndexReadError::Invalid("x".into()).code_and_kind();
        assert_eq!((invalid, kind), (INVALID_PARAMS, Some("invalid")));
    }

    #[test]
    fn issuance_quote_errors_split_invalid_params_and_storage() {
        let early = IssuanceQuoteError::CandidateBeforeParent {
            parent: 12,
            candidate: 11,
        };
        assert_eq!(early.code_and_kind(), (INVALID_PARAMS, None));
        let storage = IssuanceQuoteError::State(StateError::Backend("x".into()));
        assert_eq!(
            storage.code_and_kind(),
            (STATE_UNAVAILABLE, Some("storage"))
        );
    }

    #[test]
    fn mempool_errors_keep_distinct_lifecycle_codes() {
        // Literal codes: the SDK's admission refusal set names these numbers.
        let cases: Vec<(MempoolApiError, i32)> = vec![
            (MempoolApiError::Unavailable, -32010),
            (MempoolApiError::Invalid("x".into()), -32011),
            (MempoolApiError::Full, -32012),
            (MempoolApiError::Verification("x".into()), -32013),
            (MempoolApiError::Storage("x".into()), -32014),
            (MempoolApiError::Policy("x".into()), -32015),
            (MempoolApiError::Busy("x".into()), -32016),
            (MempoolApiError::State("x".into()), -32017),
        ];
        for (error, expected) in cases {
            let (code, _) = error.code_and_kind();
            assert_eq!(code, expected);
        }
    }

    #[test]
    fn rpc_error_carries_the_display_message_and_kind_data() {
        let object = rpc_error(IndexReadError::CursorMismatch);
        assert_eq!(object.code(), CURSOR_MISMATCH);
        let data = object.data().expect("kind data").get();
        let data: serde_json::Value = serde_json::from_str(data).expect("json kind object");
        assert_eq!(data["kind"], "cursorMismatch");
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "tests use direct assertions"
)]
mod block_tag_tests {
    use super::*;

    #[test]
    fn every_block_tag_decodes_from_its_own_wire_form() {
        for tag in [
            BlockTag::Latest,
            BlockTag::Number(5),
            BlockTag::Number(u64::MAX),
            BlockTag::Hash(B256::with_last_byte(5)),
        ] {
            let Value::String(wire) = serde_json::to_value(tag).unwrap() else {
                panic!("{tag:?} is not sent as a string");
            };
            assert_eq!(decode_block_tag(Some(wire)).unwrap(), tag);
        }
        assert!(decode_block_tag(Some(format!("0x{}", "zz".repeat(32)))).is_err());
    }
}
