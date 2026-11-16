//! Typed `pcash_*` client generated from [`PcashApi`]. [`PcashClient`] adds HTTP
//! connection settings and multi-request operations.
//!
//! Responses are returned as sent by the node. This transport client does not
//! cryptographically verify proofs in those responses.

use std::collections::HashSet;
use std::time::Duration;

use alloy_primitives::{Address, Bytes, B256};
use jsonrpsee::core::ClientError;
use jsonrpsee::http_client::{HttpClient, HttpClientBuilder};
use jsonrpsee::proc_macros::rpc;

use crate::catalog::{
    catalog_content_id, namespace_is_valid, CatalogArtifact, CatalogInfo, CatalogPage,
    CatalogRecord, CatalogStatus,
};
use crate::dto::{
    AccountChangePageDto, AccountDto, AccountProofResultDto, AddPeerResultDto, BlockDto,
    BlockHeaderDto, BlockId, BlockPayoutsDto, ContractPageDto, ContractResultDto, FeeEstimateDto,
    HistoryProofDto, L1DeliveryBatchPageDto, L1LogProofDto, L1OriginProofDto, MempoolPageDto,
    MempoolTransactionDto, NodeInfoDto, NullifierProofsDto, OutputFrontierDto, OutputPageDto,
    OutputPathDto, OutputPathsDto, PeerInfoDto, PreparedRelayDto, ReceiptDto, RemovePeerResultDto,
    StatusDto, TransactionCheckDto, TransactionDto, TransactionPageDto,
};
use crate::request::{
    AccountChangesQuery, AccountHistoryQuery, BlockRangeQuery, CatalogGetQuery, CatalogListQuery,
    CheckRawTransactionQuery, ContractsQuery, FeeEstimateQuery, L1DeliveryBatchesQuery,
    MempoolQuery, OutputQuery, PrepareRelayQuery, ReceiptQuery, SubmissionQuery, TransactionsQuery,
};
use crate::server::BlockTag;

/// A positional JSON-RPC quantity parameter.
///
/// Counts, indices, and block numbers go on the wire as minimal `0x` hex
/// strings — the encoding the TypeScript SDK, the explorer, and the shell
/// scripts all send — so a bare integer would be a second dialect of the same
/// request. [`PcashClient`] takes plain `u64`s and wraps them here.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct Quantity(pub u64);

impl serde::Serialize for Quantity {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&format!("0x{:x}", self.0))
    }
}

impl From<u64> for Quantity {
    fn from(value: u64) -> Self {
        Self(value)
    }
}

/// The `pcash_*` namespace.
///
/// Every method mirrors [`NodeApi`](crate::NodeApi), the node-facing surface the
/// server dispatches to, so the client reads the way the node is written.
#[rpc(client, namespace = "pcash")]
pub trait PcashApi {
    /// Canonical boundary, index, derivation, and fork status.
    #[method(name = "status")]
    async fn status(&self) -> RpcResult<StatusDto>;
    #[method(name = "getPayouts")]
    async fn get_payouts(
        &self,
        query: crate::request::PayoutQuery,
    ) -> RpcResult<crate::dto::PayoutPageDto>;
    #[method(name = "getBlockEconomics")]
    async fn get_block_economics(
        &self,
        query: crate::request::BlockEconomicsQuery,
    ) -> RpcResult<crate::dto::BlockEconomicsPageDto>;
    #[method(name = "getIssuanceQuote")]
    async fn get_issuance_quote(
        &self,
        query: crate::request::IssuanceQuoteQuery,
    ) -> RpcResult<Option<crate::dto::IssuanceQuoteDto>>;

    /// A depth-40 output opening against the current boundary, or `None` if the
    /// index is past `outputCount` or there is no current boundary.
    #[method(name = "getOutputPath")]
    async fn get_output_path(&self, leaf_index: Quantity) -> RpcResult<Option<OutputPathDto>>;

    /// Collect requested witnesses and the current head under one node snapshot.
    #[method(name = "getWitnessSnapshot")]
    async fn get_witness_snapshot(
        &self,
        query: crate::request::WitnessSnapshotQuery,
    ) -> RpcResult<crate::dto::WitnessSnapshotDto>;

    /// Up to 64 output openings against one root snapshot, or `None` if any
    /// index is past `outputCount` or there is no current boundary.
    #[method(name = "getOutputPaths")]
    async fn get_output_paths(
        &self,
        leaf_indices: Vec<Quantity>,
    ) -> RpcResult<Option<OutputPathsDto>>;

    /// The §5 account proof, tagged `present` or `notFound`.
    #[method(name = "getAccountProof")]
    async fn get_account_proof(&self, address: Address) -> RpcResult<AccountProofResultDto>;

    /// The §5 user or contract account at an address.
    #[method(name = "getAccount")]
    async fn get_account(&self, address: Address) -> RpcResult<Option<AccountDto>>;

    /// §12.4 decoded type-2 smart-contract data, tagged by outcome.
    #[method(name = "getContract")]
    async fn get_contract(&self, address: Address) -> RpcResult<ContractResultDto>;

    /// The current or a retained PCASH block header, by height or hash.
    #[method(name = "getBlockHeader")]
    async fn get_block_header(&self, block: BlockTag) -> RpcResult<BlockHeaderDto>;

    /// A depth-40 L1 origin membership opening.
    #[method(name = "getL1OriginProof")]
    async fn get_l1_origin_proof(
        &self,
        block_hash: B256,
        l1_block_number: Quantity,
    ) -> RpcResult<L1OriginProofDto>;

    /// A depth-64 normalized-log opening plus its authenticated Ethereum block.
    #[method(name = "getL1LogProof")]
    async fn get_l1_log_proof(
        &self,
        block_hash: B256,
        l1_block_number: Quantity,
        transaction_index: Quantity,
        log_index: Quantity,
    ) -> RpcResult<L1LogProofDto>;

    /// A depth-40 historical PCASH block membership opening.
    #[method(name = "getResultProof")]
    async fn get_result_proof(
        &self,
        recent_pcash_block_hash: B256,
        number: Quantity,
        position: crate::dto::ResultPosition,
    ) -> RpcResult<Option<crate::dto::ResultProofDto>>;

    #[method(name = "getHistoryProof")]
    async fn get_history_proof(
        &self,
        block_hash: B256,
        historical_block_number: Quantity,
    ) -> RpcResult<HistoryProofDto>;

    /// One derived block by PCASH height, or `None` if not yet derived.
    #[method(name = "getBlockByNumber")]
    async fn get_block_by_number(
        &self,
        number: Quantity,
        full_transactions: bool,
    ) -> RpcResult<Option<BlockDto>>;

    /// Canonical block by exact PCASH hash.
    #[method(name = "getBlockByHash")]
    async fn get_block_by_hash(
        &self,
        hash: B256,
        full_transactions: bool,
    ) -> RpcResult<Option<BlockDto>>;

    /// Derived blocks for an inclusive height range, ascending.
    #[method(name = "getBlocks")]
    async fn get_blocks(&self, range: BlockRangeQuery) -> RpcResult<Vec<BlockDto>>;

    /// Newest-first indexed admitted transactions, including failed outcomes.
    #[method(name = "getTransactions")]
    async fn get_transactions(&self, query: TransactionsQuery) -> RpcResult<TransactionPageDto>;

    /// Exact admitted bytes and canonical inclusion for one transaction ID.
    #[method(name = "getTransaction")]
    async fn get_transaction(&self, tx_id: B256) -> RpcResult<Option<TransactionDto>>;

    /// Canonical admitted inclusions matching an exact-byte content hash.
    #[method(name = "getSubmission")]
    async fn get_submission(&self, query: SubmissionQuery) -> RpcResult<TransactionPageDto>;

    #[method(name = "getAccountHistory")]
    async fn get_account_history(
        &self,
        query: AccountHistoryQuery,
    ) -> RpcResult<TransactionPageDto>;

    #[method(name = "getTransactionByNullifier")]
    async fn get_transaction_by_nullifier(
        &self,
        nullifier: B256,
    ) -> RpcResult<Option<TransactionDto>>;

    /// One page of the manifests of one L1 transaction's carriers.
    #[method(name = "getL1DeliveryBatches")]
    async fn get_l1_delivery_batches(
        &self,
        query: L1DeliveryBatchesQuery,
    ) -> RpcResult<L1DeliveryBatchPageDto>;

    #[method(name = "getBlockPayouts")]
    async fn get_block_payouts(&self, block: BlockId) -> RpcResult<Option<BlockPayoutsDto>>;

    /// Public open fee to declare on an entry about to be submitted.
    #[method(name = "estimateFee")]
    async fn estimate_fee(&self, query: FeeEstimateQuery) -> RpcResult<FeeEstimateDto>;

    /// Newest-first immutable contract creations.
    #[method(name = "getContracts")]
    async fn get_contracts(&self, query: ContractsQuery) -> RpcResult<ContractPageDto>;

    /// Batch latest-state double-spend check, one bool per input. The result has
    /// no block identity and may change as the canonical head changes.
    #[method(name = "areNullifiersSpent")]
    async fn are_nullifiers_spent(&self, nullifiers: Vec<B256>) -> RpcResult<Vec<bool>>;

    /// Membership or absence proofs for up to 256 nullifiers at one boundary.
    #[method(name = "getNullifierProofs")]
    async fn get_nullifier_proofs(&self, nullifiers: Vec<B256>) -> RpcResult<NullifierProofsDto>;

    /// Dense canonical encrypted output rows by output index.
    #[method(name = "getOutputs")]
    async fn get_outputs(&self, request: OutputQuery) -> RpcResult<OutputPageDto>;

    /// The output-tree count, root, and append frontier one block committed.
    #[method(name = "getOutputFrontier")]
    async fn get_output_frontier(&self, block: BlockId) -> RpcResult<OutputFrontierDto>;

    /// Every account write from `fromBlock` through one target block.
    #[method(name = "getAccountChanges")]
    async fn get_account_changes(
        &self,
        request: AccountChangesQuery,
    ) -> RpcResult<AccountChangePageDto>;

    /// Every canonical inclusion matching one receipt query key.
    #[method(name = "getReceipt")]
    async fn get_receipt(&self, query: ReceiptQuery) -> RpcResult<Vec<ReceiptDto>>;

    /// Admit exact encoded entry bytes to this node's local queue.
    #[method(name = "submitRawTransaction")]
    async fn submit_raw_transaction(&self, raw: Bytes) -> RpcResult<MempoolTransactionDto>;

    /// Check exact entry bytes as the next block would execute them from one
    /// carrier, without admitting them.
    #[method(name = "checkRawTransaction")]
    async fn check_raw_transaction(
        &self,
        query: CheckRawTransactionQuery,
    ) -> RpcResult<TransactionCheckDto>;

    /// A bounded page of this node's local, non-consensus mempool view.
    #[method(name = "getMempool")]
    async fn get_mempool(&self, query: MempoolQuery) -> RpcResult<MempoolPageDto>;

    /// One queued transaction by its content hash.
    #[method(name = "getMempoolTransaction")]
    async fn get_mempool_transaction(
        &self,
        content_hash: B256,
    ) -> RpcResult<Option<MempoolTransactionDto>>;

    /// Assemble a current-head-checked L1 batch for a relayer.
    #[method(name = "prepareRelay")]
    async fn prepare_relay(&self, request: PrepareRelayQuery) -> RpcResult<PreparedRelayDto>;

    /// Publication-catalog status, policy, and limits.
    #[method(name = "catalogInfo")]
    async fn catalog_info(&self) -> RpcResult<CatalogInfo>;

    /// One page of catalog records for a namespace.
    #[method(name = "catalogList")]
    async fn catalog_list(&self, query: CatalogListQuery) -> RpcResult<CatalogPage>;

    /// One catalog record by content ID, or `None`.
    #[method(name = "catalogGet")]
    async fn catalog_get(&self, query: CatalogGetQuery) -> RpcResult<Option<CatalogRecord>>;

    /// Store one artifact, or return the existing record unchanged.
    #[method(name = "catalogPublish")]
    async fn catalog_publish(&self, artifact: CatalogArtifact) -> RpcResult<CatalogRecord>;
}

/// Errors a [`PcashClient`] operation can fail with.
#[derive(Debug, thiserror::Error)]
pub enum PcashClientError {
    /// The endpoint could not be reached, or answered something that is not a
    /// valid JSON-RPC response.
    #[error(transparent)]
    Transport(#[from] ClientError),
    /// The node answered, but the request cannot be satisfied as asked.
    #[error("{0}")]
    Request(String),
}

/// Settings for a [`PcashClient`].
pub struct PcashClientBuilder {
    request_timeout: Duration,
    max_response_size: u32,
    max_request_size: u32,
}

impl Default for PcashClientBuilder {
    fn default() -> Self {
        Self {
            request_timeout: Duration::from_secs(30),
            // Matched to the server's own ceilings so a response the node is
            // willing to send is one this client is willing to read.
            max_request_size: crate::server::MAX_RPC_REQUEST_BODY_BYTES,
            max_response_size: crate::server::MAX_RPC_RESPONSE_BODY_BYTES,
        }
    }
}

impl PcashClientBuilder {
    pub fn request_timeout(mut self, timeout: Duration) -> Self {
        self.request_timeout = timeout;
        self
    }

    /// Connect to a `pcash_*` endpoint, e.g. `http://127.0.0.1:8645`.
    pub fn build(self, url: &str) -> Result<PcashClient, PcashClientError> {
        let inner = HttpClientBuilder::default()
            .request_timeout(self.request_timeout)
            .max_request_size(self.max_request_size)
            .max_response_size(self.max_response_size)
            .build(url)?;
        Ok(PcashClient { inner })
    }
}

/// A connected `pcash_*` endpoint.
///
/// Deref gives every [`PcashApiClient`] method; the inherent methods below are
/// the operations that take more than one round trip.
pub struct PcashClient {
    inner: HttpClient,
}

impl PcashClient {
    /// Connect with the default settings.
    pub fn new(url: &str) -> Result<Self, PcashClientError> {
        Self::builder().build(url)
    }

    pub fn builder() -> PcashClientBuilder {
        PcashClientBuilder::default()
    }

    /// The underlying transport, for callers that want batching or WebSocket.
    pub fn inner(&self) -> &HttpClient {
        &self.inner
    }

    /// Publish `payload` under `namespace`, deriving the content ID from the
    /// node's own chain id.
    ///
    /// The content ID commits to the chain id, so it cannot be computed without
    /// asking the node which chain it is on; doing both steps here is what keeps
    /// callers from having to hash anything by hand.
    pub async fn publish_catalog_artifact(
        &self,
        namespace: &str,
        payload: Vec<u8>,
    ) -> Result<CatalogRecord, PcashClientError> {
        if !namespace_is_valid(namespace) {
            return Err(PcashClientError::Request(format!(
                "namespace `{namespace}` must match [a-z0-9][a-z0-9._-]{{0,63}}"
            )));
        }
        let info = self.catalog_info().await?;
        match info.status {
            CatalogStatus::Available => {}
            other => {
                return Err(PcashClientError::Request(format!(
                    "node catalog is {}; publishing needs --enable-catalog",
                    serde_json::to_value(other)
                        .ok()
                        .and_then(|value| value.as_str().map(str::to_owned))
                        .unwrap_or_default()
                )))
            }
        }
        if !info.namespaces.iter().any(|known| known == namespace) {
            return Err(PcashClientError::Request(format!(
                "node does not accept namespace `{namespace}`"
            )));
        }
        if payload.len() > info.limits.max_payload_bytes {
            return Err(PcashClientError::Request(format!(
                "payload is {} bytes; the node accepts at most {}",
                payload.len(),
                info.limits.max_payload_bytes
            )));
        }
        let artifact = CatalogArtifact {
            namespace: namespace.to_owned(),
            pcash_chain_id: info.pcash_chain_id,
            content_id: catalog_content_id(namespace, info.pcash_chain_id, &payload),
            payload: Bytes::from(payload),
        };
        Ok(self.catalog_publish(artifact).await?)
    }

    /// [`PcashApiClient::get_output_path`] taking a plain height.
    pub async fn get_output_path(
        &self,
        leaf_index: u64,
    ) -> Result<Option<OutputPathDto>, ClientError> {
        PcashApiClient::get_output_path(&self.inner, leaf_index.into()).await
    }

    /// [`PcashApiClient::get_output_paths`] taking plain heights.
    pub async fn get_output_paths(
        &self,
        leaf_indices: impl IntoIterator<Item = u64>,
    ) -> Result<Option<OutputPathsDto>, ClientError> {
        let leaf_indices = leaf_indices.into_iter().map(Quantity::from).collect();
        PcashApiClient::get_output_paths(&self.inner, leaf_indices).await
    }

    pub async fn get_l1_origin_proof(
        &self,
        block_hash: B256,
        l1_block_number: u64,
    ) -> Result<L1OriginProofDto, ClientError> {
        PcashApiClient::get_l1_origin_proof(&self.inner, block_hash, l1_block_number.into()).await
    }

    pub async fn get_result_proof(
        &self,
        block_hash: B256,
        number: u64,
        position: crate::dto::ResultPosition,
    ) -> Result<Option<crate::dto::ResultProofDto>, ClientError> {
        PcashApiClient::get_result_proof(&self.inner, block_hash, number.into(), position).await
    }

    pub async fn get_l1_log_proof(
        &self,
        block_hash: B256,
        l1_block_number: u64,
        transaction_index: u64,
        log_index: u64,
    ) -> Result<L1LogProofDto, ClientError> {
        PcashApiClient::get_l1_log_proof(
            &self.inner,
            block_hash,
            l1_block_number.into(),
            transaction_index.into(),
            log_index.into(),
        )
        .await
    }

    pub async fn get_history_proof(
        &self,
        block_hash: B256,
        historical_block_number: u64,
    ) -> Result<HistoryProofDto, ClientError> {
        PcashApiClient::get_history_proof(&self.inner, block_hash, historical_block_number.into())
            .await
    }

    pub async fn get_block_by_number(
        &self,
        number: u64,
        full_transactions: bool,
    ) -> Result<Option<BlockDto>, ClientError> {
        PcashApiClient::get_block_by_number(&self.inner, number.into(), full_transactions).await
    }

    /// Scan a changing node-local view, deduplicating by content hash.
    /// `max_pages` bounds work even if an endpoint cycles cursors; this is not
    /// a snapshot-completeness guarantee.
    pub async fn mempool_pages(
        &self,
        query: MempoolQuery,
        max_pages: usize,
    ) -> Result<Vec<MempoolTransactionDto>, PcashClientError> {
        let mut query = query;
        let mut seen = HashSet::new();
        let mut all = Vec::new();
        for _ in 0..max_pages {
            let page = self.get_mempool(query.clone()).await?;
            let advanced = page.next_cursor.is_some()
                && page.next_cursor != query.cursor
                && !page.items.is_empty();
            all.extend(
                page.items
                    .into_iter()
                    .filter(|entry| seen.insert(entry.content_hash)),
            );
            if !advanced {
                return Ok(all);
            }
            query.cursor = page.next_cursor;
        }
        Ok(all)
    }
}

impl std::ops::Deref for PcashClient {
    type Target = HttpClient;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

/// The operator-only `admin_*` namespace.
///
/// This is a separate trait, and a separate client, because it is a separate
/// listener: see [`crate::admin`] for why peer management does not live on the
/// public port.
#[rpc(client, namespace = "admin")]
pub trait AdminRpc {
    /// Dial a peer and keep it in the redial set. `address` is a multiaddress
    /// ending in `/p2p/<peer-id>`; `admin_nodeInfo` reports one.
    #[method(name = "addPeer")]
    async fn add_peer(&self, address: String) -> RpcResult<AddPeerResultDto>;

    /// Disconnect a peer and drop it from the redial set, optionally banning it.
    #[method(name = "removePeer")]
    async fn remove_peer(&self, peer_id: String, ban: bool) -> RpcResult<RemovePeerResultDto>;

    /// Connected peers with their addresses, uptime, traffic, and scores.
    #[method(name = "peers")]
    async fn peers(&self) -> RpcResult<Vec<PeerInfoDto>>;

    /// This node's own transport identity and its bootstrap address.
    #[method(name = "nodeInfo")]
    async fn node_info(&self) -> RpcResult<NodeInfoDto>;

    /// Validate and persist an operator source-verification publication, and
    /// answer with the registry status afterwards. Both sides cross as JSON:
    /// the source-verification crate depends on this one, so its publication
    /// and info types cannot be named here.
    #[method(name = "publishSourceVerification")]
    async fn publish_source_verification(
        &self,
        publication: serde_json::Value,
    ) -> RpcResult<serde_json::Value>;
}

/// A connected `admin_*` endpoint. Deref gives every [`AdminRpcClient`] method.
pub struct AdminClient {
    inner: HttpClient,
}

impl AdminClient {
    /// Connect to an admin endpoint, e.g. `http://127.0.0.1:8647`.
    pub fn new(url: &str) -> Result<Self, PcashClientError> {
        Self::with_timeout(url, Duration::from_secs(30))
    }

    pub fn with_timeout(url: &str, request_timeout: Duration) -> Result<Self, PcashClientError> {
        let inner = HttpClientBuilder::default()
            .request_timeout(request_timeout)
            // Matched to the admin listener's own ceilings: a publication the
            // node is willing to accept is one this client is willing to send.
            .max_request_size(crate::admin::SOURCE_PUBLICATION_MAX_BODY_BYTES)
            .max_response_size(crate::admin::SOURCE_PUBLICATION_MAX_BODY_BYTES)
            .build(url)?;
        Ok(Self { inner })
    }
}

impl std::ops::Deref for AdminClient {
    type Target = HttpClient;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}
