//! Ethereum JSON-RPC L1 client over alloy HTTP.
//!
//! This adapter reads headers, full blocks, and receipts from the configured
//! endpoint and maps them into the [`crate::types`] domain form. Parse and shape
//! failures are surfaced as [`L1Error`], like transport failures and `null`
//! results ([`L1Error::BlockNotFound`]), and the follower retries the read.
//!
//! Retries and request pacing are transport concerns: failed requests are
//! retried with exponential backoff and jitter ([`backon`]), and alloy's
//! [`ThrottleLayer`] paces every attempt, so the RPC methods below are plain
//! provider calls. An attempt fails after a period with no data, so an endpoint
//! that stops answering fails the attempt rather than hanging it, while a
//! large response that keeps arriving is read to the end.

use alloy_consensus::Transaction as _;
use alloy_json_rpc::{RequestPacket, ResponsePacket};
use alloy_network_primitives::TransactionResponse as _;
use alloy_primitives::B256;
use alloy_provider::{Provider, RootProvider};
use alloy_rpc_client::ClientBuilder;
use alloy_rpc_types_eth::{
    Block, BlockId, BlockNumberOrTag, Header as RpcHeader, Transaction as RpcTx, TransactionReceipt,
};
use alloy_transport::{
    layers::{RateLimitRetryPolicy, RetryPolicy, ThrottleLayer},
    BoxTransport, IntoBoxTransport, TransportError, TransportFut,
};
use alloy_transport_http::reqwest::Url;
use backon::{ExponentialBuilder, Retryable};
use futures::{StreamExt as _, TryStreamExt as _};
use std::num::NonZeroU32;
use std::task::{Context, Poll};
use std::time::Duration;
use tower::{Layer, Service};

use crate::error::{L1Error, Result};
use crate::types::{L1BlockData, L1Header, L1Receipt, L1Tx};

/// How many retries one request gets before the caller sees its failure. The
/// follow loop then pauses and retries on its own schedule.
const MAX_RETRIES: usize = 6;

/// Exponential backoff between attempts: 1 s doubling to at most 30 s, each
/// wait lengthened by up to 100% jitter.
fn backoff() -> ExponentialBuilder {
    ExponentialBuilder::default()
        .with_min_delay(Duration::from_secs(1))
        .with_max_delay(Duration::from_secs(30))
        .with_max_times(MAX_RETRIES)
        .with_jitter()
}

/// Limits on connecting and on waiting for data: for the response to start,
/// then between reads of its body. reqwest sets neither by default.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// Per-transaction receipt reads in flight when a block's receipts are read one
/// transaction at a time.
const RECEIPT_FALLBACK_CONCURRENCY: usize = 8;

/// HTTP client bound to one configured Ethereum JSON-RPC endpoint.
#[derive(Clone)]
pub struct L1Client {
    provider: RootProvider,
}

/// Every failed attempt is retried except a JSON-RPC error the endpoint
/// answered with, which is retried only when alloy's [`RateLimitRetryPolicy`]
/// classifies it as a rate limit. Receipt reads fall back to per-transaction
/// reads on such an answer without waiting out the backoff.
fn should_retry(error: &TransportError) -> bool {
    !matches!(error, TransportError::ErrorResp(_))
        || RateLimitRetryPolicy::default().should_retry(error)
}

/// Retries each request per [`should_retry`].
#[derive(Clone)]
struct RetryLayer {
    backoff: ExponentialBuilder,
}

fn retry_layer() -> RetryLayer {
    RetryLayer { backoff: backoff() }
}

impl<T: IntoBoxTransport> Layer<T> for RetryLayer {
    type Service = RetryTransport;

    fn layer(&self, inner: T) -> Self::Service {
        RetryTransport {
            inner: inner.into_box_transport(),
            backoff: self.backoff,
        }
    }
}

#[derive(Clone)]
struct RetryTransport {
    inner: BoxTransport,
    backoff: ExponentialBuilder,
}

impl Service<RequestPacket> for RetryTransport {
    type Response = ResponsePacket;
    type Error = TransportError;
    type Future = TransportFut<'static>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<std::result::Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, request: RequestPacket) -> Self::Future {
        let inner = self.inner.clone();
        let backoff = self.backoff;
        Box::pin(async move {
            let attempt = || {
                let mut inner = inner.clone();
                let request = request.clone();
                async move {
                    let response = inner.call(request).await?;
                    // Providers commonly report rate limits as a JSON-RPC
                    // error body, which the HTTP transport returns as `Ok`.
                    match response.as_error() {
                        Some(error) => Err(TransportError::ErrorResp(error.clone())),
                        None => Ok(response),
                    }
                }
            };
            attempt
                .retry(backoff)
                .when(should_retry)
                // A provider-supplied backoff hint can only lengthen the wait.
                .adjust(|error, delay| {
                    delay.map(|delay| {
                        RateLimitRetryPolicy::default()
                            .backoff_hint(error)
                            .map_or(delay, |hint| hint.max(delay))
                    })
                })
                .await
        })
    }
}

/// Build the layered provider: retry outermost so each attempt also passes
/// through the throttle, throttle innermost so retries consume rate budget.
fn build_provider(
    url: Url,
    max_requests_per_second: Option<NonZeroU32>,
    read_timeout: Duration,
) -> Result<RootProvider> {
    let http = alloy_transport_http::reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(read_timeout)
        .gzip(true)
        .build()
        .map_err(|e| L1Error::Rpc(format!("build http client: {e}")))?;
    let builder = ClientBuilder::default().layer(retry_layer());
    let client = match max_requests_per_second {
        Some(rps) => builder
            .layer(ThrottleLayer::new_with_burst(rps.get(), rps))
            .http_with_client(http, url),
        None => builder.http_with_client(http, url),
    };
    Ok(RootProvider::new(client))
}

impl L1Client {
    /// Connect to `rpc_url` (e.g. `https://rpc.sepolia.ethpandaops.io`)
    /// without a request-rate limit.
    ///
    /// This does not perform any network I/O; the HTTP connection is lazy.
    pub fn new(rpc_url: &str) -> Result<Self> {
        Ok(Self {
            provider: build_provider(parse_url(rpc_url)?, None, READ_TIMEOUT)?,
        })
    }

    /// Like [`Self::new`], but caps outbound JSON-RPC requests at
    /// `requests_per_second` across every clone of the client, so serial
    /// follow, catch-up fetches, and retries share one aggregate rate. Burst
    /// equals that cap; sustained rate is unchanged.
    pub fn with_max_requests_per_second(rpc_url: &str, requests_per_second: u32) -> Result<Self> {
        let rps = NonZeroU32::new(requests_per_second)
            .ok_or_else(|| L1Error::Rpc("max requests per second must be positive".to_string()))?;
        Ok(Self {
            provider: build_provider(parse_url(rpc_url)?, Some(rps), READ_TIMEOUT)?,
        })
    }

    /// Build over an arbitrary transport (used to inject a mock transport in
    /// tests). The retry layer is applied exactly as for a real endpoint;
    /// throttling is not, since a mock has no rate limit to respect.
    pub fn from_transport<T: IntoBoxTransport>(transport: T, is_local: bool) -> Self {
        let client = ClientBuilder::default()
            .layer(retry_layer())
            .transport(transport, is_local);
        Self {
            provider: RootProvider::new(client),
        }
    }

    /// The error's text followed by each cause's not already in it. reqwest
    /// leaves the cause out of its own text, and alloy's errors repeat the text
    /// of what they wrap.
    fn rpc_err(e: TransportError) -> L1Error {
        let mut message = e.to_string();
        let mut source = std::error::Error::source(&e);
        while let Some(cause) = source {
            let text = cause.to_string();
            if !message.contains(&text) {
                message.push_str(": ");
                message.push_str(&text);
            }
            source = cause.source();
        }
        L1Error::Rpc(message)
    }

    /// `eth_chainId`: the EIP-155 identity of the configured L1 endpoint.
    /// Startup compares this with the configured `l1_chain_id` before opening state.
    pub async fn chain_id(&self) -> Result<u64> {
        self.provider.get_chain_id().await.map_err(Self::rpc_err)
    }

    /// `eth_blockNumber`: the current L1 head height (client-facing `latest`).
    pub async fn latest_block_number(&self) -> Result<u64> {
        self.provider
            .get_block_number()
            .await
            .map_err(Self::rpc_err)
    }

    /// The RPC's `finalized`-tag block number (client-facing `finalized`).
    pub async fn finalized_block_number(&self) -> Result<u64> {
        let block = self
            .provider
            .get_block_by_number(BlockNumberOrTag::Finalized)
            .await
            .map_err(Self::rpc_err)?
            .ok_or_else(|| L1Error::BlockNotFound("finalized".to_string()))?;
        Ok(block.header.inner.number)
    }

    /// Fetch a full block (with full transactions) by number.
    async fn block_by_number(&self, number: u64) -> Result<Block> {
        self.provider
            .get_block_by_number(BlockNumberOrTag::Number(number))
            .full()
            .await
            .map_err(Self::rpc_err)?
            .ok_or_else(|| L1Error::BlockNotFound(format!("number {number}")))
    }

    /// Fetch a full block (with full transactions) by hash.
    async fn block_by_hash(&self, hash: B256) -> Result<Block> {
        self.provider
            .get_block_by_hash(hash)
            .full()
            .await
            .map_err(Self::rpc_err)?
            .ok_or_else(|| L1Error::BlockNotFound(format!("hash {hash}")))
    }

    /// `eth_getBlockReceipts` for a block id.
    async fn block_receipts(&self, block: BlockId) -> Result<Vec<TransactionReceipt>> {
        self.provider
            .get_block_receipts(block)
            .await
            .map_err(Self::rpc_err)?
            .ok_or_else(|| L1Error::BlockNotFound(format!("receipts for {block:?}")))
    }

    /// Fetch only a block's hash by number — a header/number call, NOT the full
    /// block body or receipts. Used by the reorg walk-back, which
    /// compares the canonical hash at each height against the stored trail and
    /// needs nothing else, and by the restart-resume checkpoint cross-check. Like
    /// [`Self::finalized_block_number`] this omits `.full()`, so the RPC returns
    /// the header and tx-hash list rather than full transaction bodies.
    pub async fn block_hash_by_number(&self, number: u64) -> Result<B256> {
        let block = self
            .provider
            .get_block_by_number(BlockNumberOrTag::Number(number))
            .await
            .map_err(Self::rpc_err)?
            .ok_or_else(|| L1Error::BlockNotFound(format!("number {number}")))?;
        Ok(block.header.hash)
    }

    pub async fn block_header_by_number(&self, number: u64) -> Result<L1Header> {
        let block = self
            .provider
            .get_block_by_number(BlockNumberOrTag::Number(number))
            .await
            .map_err(Self::rpc_err)?
            .ok_or_else(|| L1Error::BlockNotFound(format!("number {number}")))?;
        Ok(header_from(&block.header))
    }

    /// Fetch a block by number and assemble the combined [`L1BlockData`].
    ///
    /// Receipts are requested by the fetched block's hash so a reorg between
    /// the two reads cannot pair its body with another block's receipts.
    pub async fn block_data_by_number(&self, number: u64) -> Result<L1BlockData> {
        let block = self.block_by_number(number).await?;
        if block.header.inner.number != number {
            return Err(L1Error::BlockNumberMismatch {
                requested: number,
                got: block.header.inner.number,
            });
        }
        self.assemble(block).await
    }

    /// Fetch a block by hash and assemble the combined [`L1BlockData`].
    pub async fn block_data_by_hash(&self, hash: B256) -> Result<L1BlockData> {
        let block = self.block_by_hash(hash).await?;
        self.assemble(block).await
    }

    // Request receipts for this exact block, not its potentially reorged height.
    // The RPC contents remain trusted; this path does not verify the receipt root.
    //
    // One block's receipts are one response that any Ethereum sender can fill
    // with logs, so an RPC may refuse it as too large or fail to deliver it.
    // Any failure other than `null` falls back to one read per transaction,
    // each bounded by the per-transaction gas cap.
    async fn assemble(&self, block: Block) -> Result<L1BlockData> {
        let receipts = match self.block_receipts(BlockId::from(block.header.hash)).await {
            Ok(receipts) => receipts,
            Err(error @ L1Error::BlockNotFound(_)) => return Err(error),
            Err(_) => self.transaction_receipts(&block).await?,
        };
        assemble_block(block, receipts)
    }

    /// `eth_getTransactionReceipt` for each transaction of `block`, in order.
    /// These reads follow the RPC's canonical chain, not a block hash, so each
    /// receipt must name `block`: `null` or another block means `block` left the
    /// canonical chain between reads, which the follower retries.
    async fn transaction_receipts(&self, block: &Block) -> Result<Vec<TransactionReceipt>> {
        let hash = block.header.hash;
        futures::stream::iter(block.transactions.hashes())
            .map(|tx| async move {
                match self
                    .provider
                    .get_transaction_receipt(tx)
                    .await
                    .map_err(Self::rpc_err)?
                {
                    Some(receipt) if receipt.block_hash == Some(hash) => Ok(receipt),
                    _ => Err(L1Error::BlockNotFound(format!(
                        "receipt of {tx} in block {hash}"
                    ))),
                }
            })
            .buffered(RECEIPT_FALLBACK_CONCURRENCY)
            .try_collect()
            .await
    }
}

fn parse_url(rpc_url: &str) -> Result<Url> {
    Url::parse(rpc_url).map_err(|e| L1Error::Rpc(format!("bad rpc url: {e}")))
}

/// Convert an RPC header into the domain [`L1Header`].
pub fn header_from(h: &RpcHeader) -> L1Header {
    L1Header {
        number: h.inner.number,
        hash: h.hash,
        parent_hash: h.inner.parent_hash,
        timestamp: h.inner.timestamp,
    }
}

/// Convert an RPC transaction into the domain [`L1Tx`].
pub fn tx_from(tx: &RpcTx) -> Result<L1Tx> {
    let tx_index = tx
        .transaction_index()
        .ok_or_else(|| L1Error::MissingTxIndex(tx.tx_hash()))?;
    Ok(L1Tx {
        hash: tx.tx_hash(),
        from: tx.from(),
        to: tx.to(),
        input: tx.input().clone(),
        blob_versioned_hashes: tx.blob_versioned_hashes().unwrap_or_default().to_vec(),
        blob_resolution: Default::default(),
        tx_index,
    })
}

/// Convert an RPC receipt into the domain [`L1Receipt`]. Receipt logs carrying
/// more than four topics cannot come from a canonical Ethereum block; they are
/// rejected as fatal shape errors so log-leaf hashing never sees them.
pub fn receipt_from(r: &TransactionReceipt, transaction_index: u64) -> Result<L1Receipt> {
    let mut logs = Vec::with_capacity(r.logs().len());
    for (log_index, log) in r.logs().iter().enumerate() {
        let topics = log.topics().to_vec();
        if topics.len() > 4 {
            return Err(L1Error::LogTopicCount {
                transaction_index,
                log_index: log_index as u64,
                count: topics.len(),
            });
        }
        logs.push(crate::types::L1Log {
            transaction_index,
            log_index: log_index as u64,
            emitter: log.address(),
            topics,
            data: log.data().data.clone(),
        });
    }
    Ok(L1Receipt { logs })
}

/// Map a full RPC block plus its receipts into [`L1BlockData`], aligned by
/// transaction index. A body without a full transaction list and tx/receipt
/// count or index mismatches are fatal because derivation requires complete,
/// aligned inputs.
pub fn assemble_block(block: Block, receipts: Vec<TransactionReceipt>) -> Result<L1BlockData> {
    let header = header_from(&block.header);
    let number = header.number;

    // Rejects hash-only and uncle responses outright, so an empty transaction
    // list can only mean a genuinely empty block.
    let txs = block
        .try_into_transactions()
        .map_err(|_| L1Error::NotFullTransactions(number))?;
    if txs.len() != receipts.len() {
        return Err(L1Error::TxReceiptCountMismatch {
            block: number,
            txs: txs.len(),
            receipts: receipts.len(),
        });
    }

    let mut out = Vec::with_capacity(txs.len());
    for (position, (tx, receipt)) in (0u64..).zip(txs.iter().zip(receipts.iter())) {
        let l1_tx = tx_from(tx)?;
        // Alignment check: receipts arrive in index order; the position must
        // equal both the tx and receipt indices, else the L1 log tree would
        // file logs under the wrong transaction.
        if l1_tx.tx_index != position
            || receipt
                .transaction_index
                .is_some_and(|index| index != position)
        {
            return Err(L1Error::TxReceiptIndexMismatch {
                block: number,
                position,
                tx_index: l1_tx.tx_index,
                receipt_index: receipt.transaction_index,
            });
        }
        let receipt = receipt_from(receipt, l1_tx.tx_index)?;
        out.push((l1_tx, receipt));
    }

    Ok(L1BlockData::new(header, out))
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
    use alloy_json_rpc::ErrorPayload;
    use alloy_transport::TransportErrorKind;
    use std::borrow::Cow;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    fn rpc_error(code: i64, message: &'static str) -> TransportError {
        TransportError::ErrorResp(ErrorPayload {
            code,
            message: Cow::Borrowed(message),
            data: None,
        })
    }

    const CAPTURED_BLOCK: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/block_3000000.json"
    ));
    const CAPTURED_RECEIPTS: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/receipts_3000000.json"
    ));

    fn captured_pair() -> (Block, Vec<TransactionReceipt>) {
        (
            serde_json::from_str(CAPTURED_BLOCK).unwrap(),
            serde_json::from_str(CAPTURED_RECEIPTS).unwrap(),
        )
    }

    #[derive(Clone)]
    struct ReorgTransport(Arc<std::sync::Mutex<ReorgState>>);

    struct ReorgState {
        current_hash: B256,
        serve_old_hash: bool,
        requests: Vec<(String, serde_json::Value)>,
    }

    impl Service<RequestPacket> for ReorgTransport {
        type Response = ResponsePacket;
        type Error = TransportError;
        type Future = TransportFut<'static>;

        fn poll_ready(
            &mut self,
            _: &mut Context<'_>,
        ) -> Poll<std::result::Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn call(&mut self, request: RequestPacket) -> Self::Future {
            let state = self.0.clone();
            Box::pin(async move {
                let RequestPacket::Single(request) = request else {
                    panic!("unexpected batch")
                };
                let params: serde_json::Value =
                    serde_json::from_str(request.params().expect("RPC params").get()).unwrap();
                let (old_block, _) = captured_pair();
                let old_hash = old_block.header.hash;
                let mut state = state.lock().unwrap();
                state
                    .requests
                    .push((request.method().to_string(), params.clone()));
                let payload: serde_json::Value = match request.method() {
                    "eth_getBlockByNumber" => {
                        assert_eq!(params[0], "0x2dc6c0");
                        assert_eq!(params[1], true);
                        state.current_hash = B256::repeat_byte(0x11);
                        serde_json::from_str(CAPTURED_BLOCK).unwrap()
                    }
                    "eth_getBlockReceipts" => {
                        let requested_hash = params[0]
                            .get("blockHash")
                            .and_then(serde_json::Value::as_str)
                            .or_else(|| params[0].as_str().filter(|value| value.len() >= 66));
                        if requested_hash == Some(old_hash.to_string().as_str()) {
                            if state.serve_old_hash {
                                serde_json::from_str(CAPTURED_RECEIPTS).unwrap()
                            } else {
                                serde_json::Value::Null
                            }
                        } else {
                            assert_eq!(params[0], "0x2dc6c0");
                            let mut newer: serde_json::Value =
                                serde_json::from_str(CAPTURED_RECEIPTS).unwrap();
                            newer[1]["gasUsed"] = serde_json::json!("0x1");
                            newer[1]["logs"] = serde_json::json!([]);
                            newer
                        }
                    }
                    method => panic!("unexpected RPC method {method}"),
                };
                Ok(ResponsePacket::Single(alloy_json_rpc::Response {
                    id: request.id().clone(),
                    payload: alloy_json_rpc::ResponsePayload::Success(
                        serde_json::value::to_raw_value(&payload).unwrap(),
                    ),
                }))
            })
        }
    }

    fn reorg_client(serve_old_hash: bool) -> (L1Client, ReorgTransport) {
        let (block, _) = captured_pair();
        let transport = ReorgTransport(Arc::new(std::sync::Mutex::new(ReorgState {
            current_hash: block.header.hash,
            serve_old_hash,
            requests: Vec::new(),
        })));
        (L1Client::from_transport(transport.clone(), true), transport)
    }

    #[tokio::test]
    async fn number_fetch_pins_receipts_to_fetched_hash_across_reorg() {
        let (client, transport) = reorg_client(true);
        let data = client.block_data_by_number(3_000_000).await.unwrap();
        let (block, receipts) = captured_pair();
        let expected = receipt_from(&receipts[1], 1).unwrap();
        assert_eq!(data.header.hash, block.header.hash);
        assert_eq!(data.txs[1].1, expected);

        let state = transport.0.lock().unwrap();
        assert_ne!(state.current_hash, data.header.hash);
        assert_eq!(state.requests.len(), 2);
        assert_eq!(state.requests[0].0, "eth_getBlockByNumber");
        assert_eq!(state.requests[1].0, "eth_getBlockReceipts");
        let receipt_id = &state.requests[1].1[0];
        let requested_hash = receipt_id
            .get("blockHash")
            .and_then(serde_json::Value::as_str)
            .or_else(|| receipt_id.as_str());
        assert_eq!(requested_hash, Some(block.header.hash.to_string().as_str()));
    }

    #[tokio::test]
    async fn unavailable_fetched_hash_does_not_use_new_canonical_receipts() {
        let (client, transport) = reorg_client(false);
        assert!(matches!(
            client.block_data_by_number(3_000_000).await,
            Err(L1Error::BlockNotFound(_))
        ));
        let state = transport.0.lock().unwrap();
        assert_eq!(state.requests.len(), 2);
        assert_eq!(state.requests[1].0, "eth_getBlockReceipts");
    }

    type Requests = Arc<std::sync::Mutex<Vec<(String, serde_json::Value)>>>;

    /// Serves the captured block, fails its whole-block receipts read with
    /// `refusal`, and serves each transaction's receipt, applying `edit_last`
    /// to the block's last one.
    #[derive(Clone)]
    struct ReceiptFallbackTransport {
        refusal: fn() -> TransportError,
        edit_last: fn(&mut serde_json::Value),
        requests: Requests,
    }

    impl Service<RequestPacket> for ReceiptFallbackTransport {
        type Response = ResponsePacket;
        type Error = TransportError;
        type Future = TransportFut<'static>;

        fn poll_ready(
            &mut self,
            _: &mut Context<'_>,
        ) -> Poll<std::result::Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn call(&mut self, request: RequestPacket) -> Self::Future {
            let transport = self.clone();
            Box::pin(async move {
                let RequestPacket::Single(request) = request else {
                    panic!("unexpected batch")
                };
                let params: serde_json::Value =
                    serde_json::from_str(request.params().expect("RPC params").get()).unwrap();
                transport
                    .requests
                    .lock()
                    .unwrap()
                    .push((request.method().to_string(), params.clone()));
                let payload = match request.method() {
                    "eth_getBlockByNumber" => serde_json::from_str(CAPTURED_BLOCK).unwrap(),
                    "eth_getBlockReceipts" => match (transport.refusal)() {
                        TransportError::ErrorResp(error) => {
                            return Ok(ResponsePacket::Single(alloy_json_rpc::Response {
                                id: request.id().clone(),
                                payload: alloy_json_rpc::ResponsePayload::Failure(error),
                            }))
                        }
                        error => return Err(error),
                    },
                    "eth_getTransactionReceipt" => {
                        let receipts: Vec<serde_json::Value> =
                            serde_json::from_str(CAPTURED_RECEIPTS).unwrap();
                        let last = receipts.len() - 1;
                        let (index, mut receipt) = receipts
                            .into_iter()
                            .enumerate()
                            .find(|(_, receipt)| receipt["transactionHash"] == params[0])
                            .expect("receipt of a captured transaction");
                        if index == last {
                            (transport.edit_last)(&mut receipt);
                        }
                        receipt
                    }
                    method => panic!("unexpected RPC method {method}"),
                };
                Ok(ResponsePacket::Single(alloy_json_rpc::Response {
                    id: request.id().clone(),
                    payload: alloy_json_rpc::ResponsePayload::Success(
                        serde_json::value::to_raw_value(&payload).unwrap(),
                    ),
                }))
            })
        }
    }

    fn receipt_fallback_client(
        refusal: fn() -> TransportError,
        edit_last: fn(&mut serde_json::Value),
    ) -> (L1Client, Requests) {
        let requests = Requests::default();
        let transport = ReceiptFallbackTransport {
            refusal,
            edit_last,
            requests: requests.clone(),
        };
        (L1Client::from_transport(transport, true), requests)
    }

    #[tokio::test(start_paused = true)]
    async fn undeliverable_block_receipts_fall_back_to_transaction_receipts() {
        let refusals: [fn() -> TransportError; 2] = [
            // reth's answer above `--rpc.max-response-size`.
            || rpc_error(-32008, "Response is too big"),
            // Retried until the request budget is exhausted.
            || TransportErrorKind::http_error(504, "gateway timeout".to_string()),
        ];
        for refusal in refusals {
            let (client, requests) = receipt_fallback_client(refusal, |_| {});
            let data = client.block_data_by_number(3_000_000).await.unwrap();
            let (block, receipts) = captured_pair();
            let expected = assemble_block(block.clone(), receipts).unwrap();
            assert_eq!(data.header, expected.header);
            assert_eq!(data.txs, expected.txs);

            let mut read = requests
                .lock()
                .unwrap()
                .iter()
                .filter(|(method, _)| method == "eth_getTransactionReceipt")
                .map(|(_, params)| params[0].as_str().unwrap().to_string())
                .collect::<Vec<_>>();
            let mut transactions = block
                .transactions
                .hashes()
                .map(|hash| hash.to_string())
                .collect::<Vec<_>>();
            read.sort();
            transactions.sort();
            assert_eq!(read, transactions);
        }
    }

    #[tokio::test]
    async fn transaction_receipt_outside_fetched_block_is_a_reorg() {
        let edits: [fn(&mut serde_json::Value); 2] = [
            |receipt| *receipt = serde_json::Value::Null,
            |receipt| receipt["blockHash"] = serde_json::json!(B256::repeat_byte(0x22)),
        ];
        for edit_last in edits {
            let (client, _) =
                receipt_fallback_client(|| rpc_error(-32008, "Response is too big"), edit_last);
            let result = client.block_data_by_number(3_000_000).await;
            assert!(
                matches!(result, Err(L1Error::BlockNotFound(_))),
                "{:?}",
                result.map(|data| data.header)
            );
        }
    }

    #[test]
    fn retries_all_but_non_rate_limit_answers() {
        for status in [400, 401, 403, 408, 429, 500, 501, 502, 503, 504, 599] {
            let error = TransportErrorKind::http_error(status, "HTTP error".to_string());
            assert!(should_retry(&error), "HTTP {status}");
        }

        let malformed = TransportError::deser_err(
            serde_json::from_str::<serde_json::Value>("bad json").unwrap_err(),
            "bad json",
        );
        assert!(should_retry(&malformed));

        let alchemy = rpc_error(429, "compute units per second exceeded");
        assert!(should_retry(&alchemy));

        let infura = rpc_error(-32005, "project ID request rate exceeded");
        assert!(should_retry(&infura));

        let quicknode = rpc_error(-32007, "100/second request limit reached");
        assert!(should_retry(&quicknode));

        let invalid_params = rpc_error(-32602, "invalid params");
        assert!(!should_retry(&invalid_params));

        let too_big = rpc_error(-32008, "Response is too big");
        assert!(!should_retry(&too_big));

        let custom = TransportErrorKind::custom_str("mock failure");
        assert!(should_retry(&custom));
    }

    /// A listener that accepts every connection and never answers it.
    fn silent_server() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let mut held = Vec::new();
            while let Ok((socket, _)) = listener.accept() {
                held.push(socket);
            }
        });
        url
    }

    #[tokio::test(start_paused = true)]
    async fn unanswered_request_times_out() {
        let client = L1Client::new(&silent_server()).unwrap();
        // The paused clock jumps to the next pending timer. Without a request
        // timeout that is this bound, so the test fails instead of hanging.
        let result = tokio::time::timeout(Duration::from_hours(1), client.chain_id())
            .await
            .expect("an unanswered L1 request must time out on its own");
        assert!(matches!(result, Err(L1Error::Rpc(_))));
    }

    /// Answers one `eth_chainId` request with a body that arrives one byte per
    /// `gap`, and returns the request it read.
    fn trickling_chain_id_server(
        gap: Duration,
        padding: usize,
    ) -> (String, std::sync::mpsc::Receiver<String>) {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (request_tx, request_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_nodelay(true).unwrap();
            let mut buf = [0u8; 16_384];
            let read = socket.read(&mut buf).unwrap();
            request_tx
                .send(String::from_utf8_lossy(&buf[..read]).into_owned())
                .unwrap();
            let (head, tail) = (r#"{"jsonrpc":"2.0","id":0,"result":"#, r#""0xaa36a7"}"#);
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                head.len() + padding + tail.len()
            );
            socket.write_all(headers.as_bytes()).unwrap();
            socket.write_all(head.as_bytes()).unwrap();
            for _ in 0..padding {
                std::thread::sleep(gap);
                socket.write_all(b" ").unwrap();
            }
            socket.write_all(tail.as_bytes()).unwrap();
        });
        (url, request_rx)
    }

    #[tokio::test]
    async fn response_that_keeps_arriving_outlasts_the_read_timeout() {
        let read_timeout = Duration::from_millis(500);
        let (url, request) = trickling_chain_id_server(Duration::from_millis(100), 15);
        let client = L1Client {
            provider: build_provider(parse_url(&url).unwrap(), None, read_timeout).unwrap(),
        };
        let started = Instant::now();
        assert_eq!(client.chain_id().await.unwrap(), 11_155_111);
        assert!(started.elapsed() > read_timeout);
        assert!(request
            .recv()
            .unwrap()
            .to_ascii_lowercase()
            .contains("accept-encoding: gzip"));
    }

    #[derive(Clone)]
    struct ScriptedTransport(
        Arc<std::sync::Mutex<std::collections::VecDeque<Option<TransportError>>>>,
    );

    impl Service<RequestPacket> for ScriptedTransport {
        type Response = ResponsePacket;
        type Error = TransportError;
        type Future = TransportFut<'static>;

        fn poll_ready(
            &mut self,
            _: &mut Context<'_>,
        ) -> Poll<std::result::Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn call(&mut self, request: RequestPacket) -> Self::Future {
            let result = self
                .0
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected extra RPC attempt");
            Box::pin(async move {
                let RequestPacket::Single(request) = request else {
                    panic!("unexpected batch")
                };
                // Like the HTTP transport, deliver JSON-RPC errors as a
                // response body rather than a transport failure.
                let payload = match result {
                    Some(TransportError::ErrorResp(error)) => {
                        alloy_json_rpc::ResponsePayload::Failure(error)
                    }
                    Some(error) => return Err(error),
                    None => alloy_json_rpc::ResponsePayload::Success(
                        serde_json::value::to_raw_value("0xaa36a7").unwrap(),
                    ),
                };
                Ok(ResponsePacket::Single(alloy_json_rpc::Response {
                    id: request.id().clone(),
                    payload,
                }))
            })
        }
    }

    fn scripted_client(errors: Vec<Option<TransportError>>) -> (L1Client, ScriptedTransport) {
        let transport = ScriptedTransport(Arc::new(std::sync::Mutex::new(errors.into())));
        let client = ClientBuilder::default()
            .layer(RetryLayer {
                backoff: ExponentialBuilder::default()
                    .with_min_delay(Duration::from_millis(1))
                    .with_max_times(2),
            })
            .transport(transport.clone(), true);
        (
            L1Client {
                provider: RootProvider::new(client),
            },
            transport,
        )
    }

    #[tokio::test]
    async fn exhausted_retries_fail_and_next_read_recovers() {
        let mut responses = (0..3)
            .map(|_| Some(TransportErrorKind::http_error(403, String::new())))
            .collect::<Vec<_>>();
        responses.push(None);
        let (client, transport) = scripted_client(responses);
        assert!(matches!(client.chain_id().await, Err(L1Error::Rpc(_))));
        assert_eq!(client.chain_id().await.unwrap(), 11_155_111);
        assert!(transport.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn transient_403_recovers_inside_request_budget() {
        let (client, transport) = scripted_client(vec![
            Some(TransportErrorKind::http_error(403, String::new())),
            None,
        ]);
        assert_eq!(client.chain_id().await.unwrap(), 11_155_111);
        assert!(transport.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn rate_limit_error_body_is_retried() {
        let (client, transport) = scripted_client(vec![
            Some(rpc_error(429, "compute units per second exceeded")),
            None,
        ]);
        assert_eq!(client.chain_id().await.unwrap(), 11_155_111);
        assert!(transport.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn rpc_error_answer_after_outage_is_returned() {
        let (client, transport) = scripted_client(vec![
            Some(TransportErrorKind::http_error(403, String::new())),
            Some(rpc_error(-32602, "invalid params")),
        ]);
        assert!(matches!(
            client.chain_id().await.unwrap_err(),
            L1Error::Rpc(_)
        ));
        assert!(transport.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn malformed_response_is_retried() {
        let error = TransportError::deser_err(
            serde_json::from_str::<serde_json::Value>("bad json").unwrap_err(),
            "bad json",
        );
        let (client, transport) = scripted_client(vec![Some(error), None]);
        assert_eq!(client.chain_id().await.unwrap(), 11_155_111);
        assert!(transport.0.lock().unwrap().is_empty());
    }

    /// Answers one `eth_chainId` request per entry of `cut_off`: a `true` entry
    /// sends a 200 whose body ends before its `Content-Length` and closes the
    /// connection, a `false` entry sends the whole body.
    fn cutting_chain_id_server(cut_off: &'static [bool]) -> String {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let body = r#"{"jsonrpc":"2.0","id":0,"result":"0xaa36a7"}"#;
            for &truncate in cut_off {
                let (mut socket, _) = listener.accept().unwrap();
                let mut buf = [0u8; 16_384];
                let _ = socket.read(&mut buf).unwrap();
                let sent = if truncate { &body[..10] } else { body };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{sent}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).unwrap();
            }
        });
        url
    }

    #[tokio::test]
    async fn response_cut_off_mid_body_is_retried() {
        let client = ClientBuilder::default()
            .layer(RetryLayer {
                backoff: ExponentialBuilder::default()
                    .with_min_delay(Duration::from_millis(1))
                    .with_max_times(1),
            })
            .http(parse_url(&cutting_chain_id_server(&[true, false])).unwrap());
        let client = L1Client {
            provider: RootProvider::new(client),
        };
        assert_eq!(client.chain_id().await.unwrap(), 11_155_111);
    }

    #[tokio::test]
    async fn rpc_error_keeps_its_causes() {
        let url = cutting_chain_id_server(&[true]);
        let error = alloy_transport_http::reqwest::Client::new()
            .post(&url)
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap_err();
        let shown = error.to_string();
        let L1Error::Rpc(message) = L1Client::rpc_err(TransportErrorKind::custom(error)) else {
            panic!("expected an RPC error");
        };
        assert!(
            message.starts_with(&format!("{shown}: ")) && message.matches(&shown).count() == 1,
            "{message}"
        );
    }

    fn jsonrpc_chain_id_server() -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::atomic::AtomicUsize;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let hits = Arc::new(AtomicUsize::new(0));
        let counted = hits.clone();
        std::thread::spawn(move || {
            while let Ok((mut socket, _)) = listener.accept() {
                counted.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let mut buf = [0u8; 16_384];
                let _ = socket.read(&mut buf);
                let body = br#"{"jsonrpc":"2.0","id":1,"result":"0xaa36a7"}"#;
                let headers = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = socket.write_all(headers.as_bytes());
                let _ = socket.write_all(body);
            }
        });
        (url, hits)
    }

    #[tokio::test]
    async fn request_budget_paces_http_requests() {
        let (url, hits) = jsonrpc_chain_id_server();
        let client = L1Client::with_max_requests_per_second(&url, 2).unwrap();
        let started = Instant::now();
        let mut tasks = Vec::new();
        for _ in 0..6 {
            let client = client.clone();
            tasks.push(tokio::spawn(async move { client.chain_id().await }));
        }
        for task in tasks {
            task.await.unwrap().unwrap();
        }
        assert!(
            started.elapsed() >= Duration::from_millis(1_200),
            "throttled client clones must share one pace, not fire as a burst"
        );
        assert_eq!(hits.load(std::sync::atomic::Ordering::Relaxed), 6);
    }
}
