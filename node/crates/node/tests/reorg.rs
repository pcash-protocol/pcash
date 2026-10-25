#![allow(
    clippy::unreadable_literal,
    reason = "test fixtures preserve protocol chain identifiers"
)]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]
//! Deterministic integrated reorg test.
//!
//! Drives the real node pipeline — [`L1Client`] → [`Follower`] reorg detection →
//! `handle_reorg` walk-back → `NodeInner` state rollback + prune — over a
//! fully in-process mock L1. A custom method-dispatching transport (behind
//! [`L1Client::from_transport`]) serves canned blocks/receipts from a mutable
//! chain model, so a reorg is injected by swapping the chain between two loop
//! passes with the SAME follower (its `last_hash` still points at the orphaned
//! tip, which is exactly what triggers the parent-hash discontinuity).
//!
//! Coverage: a shallow-suffix replacement leaves the node equal to a clean
//! derivation of the replacement branch; orphaned receipts and wallet outputs
//! disappear; a fork point exactly at finalized restores; a fork strictly below
//! finalized halts; and the whole scenario repeats after dropping and
//! re-`create`-ing the redb file over the same path (F5 — no stale state).

mod common;

use common::{field_element, sender, word, FaultyBackend, IndexMetrics};

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use alloy_consensus::transaction::Recovered;
use alloy_consensus::{
    Eip658Value, Header as ConsensusHeader, Receipt, ReceiptEnvelope, ReceiptWithBloom, Signed,
    TxEip4844, TxEip4844Variant, TxEnvelope, TxLegacy,
};
use alloy_json_rpc::{
    ErrorPayload, RequestPacket, Response, ResponsePacket, ResponsePayload, SerializedRequest,
};
use alloy_primitives::{Address, Bloom, Bytes, Signature, TxKind, B256, U256};
use alloy_rpc_types_eth::{
    Block, BlockTransactions, Header as RpcHeader, Transaction as RpcTransaction,
    TransactionReceipt,
};
use alloy_transport::{TransportError, TransportErrorKind, TransportFut};
use pcash_state::CircuitWord;

use pcash_crypto::Fr;
use pcash_derive::private_value_profiles::PrivateValueShape;
use pcash_derive::{
    AccountCreationAuthorization, ContractAccountCreation, ContractBody, ContractFunction,
    ContractFunding, PrivateValueSection, ReceiveKeyUpdate, SectionLayout, Transaction,
    UserAccountCreation, UserAccountUpdate,
};
use pcash_l1::{Follower, L1Client, L1Error, Step};
use pcash_metrics::{Metrics, NoopMetrics, PrometheusMetrics};
use pcash_node::index::{DerivedIndexLifecycle, IndexBlockId};
use pcash_node::{
    build_node, catch_up_derived_index, handle_reorg, maintain_derived_index, resume_or_build_node,
    resume_or_build_node_with_force_resync, BeaconClient, NetworkConfig, NodeHandle, NodeInner,
    StartPlan, CATCHUP_FETCH_CONCURRENCY, DEFAULT_INBOX, L1_CHAIN_ID,
};
use pcash_rpc::{
    AccountChangeLimits, AccountChangesRequest, AccountHistoryQuery, BlockId, BlockTag,
    DerivationDto, ExplorerCursorDto, IndexReadError, L1DeliveryBatchContinuationDto,
    L1DeliveryBatchLimits, L1DeliveryBatchPageDto, L1DeliveryBatchesRequest, NodeApi, OutputLimits,
    OutputRequest, ReceiptQuery, StallCause, SubmissionQuery, TransactionsQuery,
};
use pcash_state::{fr_to_bytes, StateDb, RECENT_PCASH_BLOCK_WINDOW_SECONDS};
use pcash_verify::{Verifier, VerifyError};

const PCASH_CHAIN_ID: u32 = 1346589512;
const GENESIS: u64 = 100;
const L1_TIMESTAMP_BASE: u64 = 1_800_000_000;
const BASE_FEE: u64 = 1_000_000_000; // 1 gwei
const GAS_USED: u64 = 21_000;

fn beacon() -> Arc<BeaconClient> {
    Arc::new(BeaconClient::for_test())
}

/// L1 block at which the crossover fixture's fork activates, and the header
/// timestamp that activation is keyed to. Every other fixture in this
/// file runs under the release fork schedule, which is empty, so only the
/// crossover test ever crosses a boundary.
const FORK_ACTIVATION_BLOCK: u64 = 102;
const FORK_ACTIVATION_TIMESTAMP: u64 = L1_TIMESTAMP_BASE + FORK_ACTIVATION_BLOCK;

/// Transaction type tags, duplicated here to keep the test
/// self-contained; equal to `pcash_derive::params::TYPE_*`.
const KIND_PRIVATE_VALUE: u8 = 0;

/// Accepts every proof: the crafted transfers below have valid public inputs but
/// no real proof, so acceptance is gated only on this stub returning `true`.
/// Garbage-signature records never reach it (they fail the ECDSA recover first),
/// so they still skip as intended.
struct YesVerify;
impl Verifier for YesVerify {
    fn verify(&self, _: &[u8], _: &[u8], _: &[u8]) -> Result<bool, VerifyError> {
        Ok(true)
    }
}

struct OffLockRejectVerifier {
    inner: Arc<Mutex<NodeInner>>,
    calls: Arc<AtomicUsize>,
}

impl Verifier for OffLockRejectVerifier {
    fn verify(&self, _: &[u8], _: &[u8], _: &[u8]) -> Result<bool, VerifyError> {
        assert!(
            self.inner.try_lock().is_ok(),
            "follow must verify during off-lock prewarm"
        );
        self.calls.fetch_add(1, Ordering::Relaxed);
        Ok(false)
    }
}

/// Holds the current block's derivation until the transport records a full-body
/// request from the fetch-ahead window. With a two-worker Tokio runtime, this
/// proves read-ahead is progressing on another worker while derivation is still
/// inside the verifier.
struct PrefetchProbeVerifier {
    calls: CallLog,
    saw_read_ahead: Arc<AtomicBool>,
}

impl Verifier for PrefetchProbeVerifier {
    fn verify(&self, _: &[u8], _: &[u8], _: &[u8]) -> Result<bool, VerifyError> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            let full_block_fetches = self
                .calls
                .lock()
                .unwrap()
                .iter()
                .filter(|(method, full)| method == "eth_getBlockByNumber" && *full)
                .count();
            if full_block_fetches >= 30 {
                self.saw_read_ahead.store(true, Ordering::Release);
                break;
            }
            std::thread::yield_now();
        }
        Ok(true)
    }
}

// ===========================================================================
// Mock L1: a mutable chain model + a method-dispatching transport.
// ===========================================================================

/// A minimal mutable L1 the transport reads from. Blocks and their receipts are
/// keyed by number; `head`/`finalized` are the reported tags.
#[derive(Default)]
struct ChainModel {
    blocks: BTreeMap<u64, Block>,
    receipts: BTreeMap<u64, Vec<TransactionReceipt>>,
    /// `eth_getBlockByNumber(requested)` serves this height's block instead.
    serve_number_as: BTreeMap<u64, u64>,
    transient_failures: BTreeMap<String, u32>,
    fault: Option<RpcFault>,
    /// Answer every `eth_getBlockReceipts` as an RPC whose response-size cap
    /// the block exceeds.
    refuse_block_receipts: bool,
    head: u64,
    finalized: u64,
    /// When `Some(false)`, body/receipt RPCs wait until the watch becomes true.
    rpc_hold: Option<tokio::sync::watch::Receiver<bool>>,
    rpc_in_flight: Arc<AtomicUsize>,
}

impl ChainModel {
    fn insert(&mut self, block: Block, receipts: Vec<TransactionReceipt>) {
        let n = block.header.inner.number;
        self.receipts.insert(n, receipts);
        self.blocks.insert(n, block);
    }

    /// Drop every block strictly above `number` (used to model an orphaned
    /// suffix before the replacement branch is written).
    fn truncate_above(&mut self, number: u64) {
        self.blocks.retain(|&n, _| n <= number);
        self.receipts.retain(|&n, _| n <= number);
    }

    fn receipt_of(&self, transaction: B256) -> Option<&TransactionReceipt> {
        self.receipts
            .values()
            .flatten()
            .find(|receipt| receipt.transaction_hash == transaction)
    }

    /// The block whose receipts an `eth_getTransactionReceipt` request reads.
    fn transaction_block(&self, request: &SerializedRequest) -> Option<B256> {
        if request.method() != "eth_getTransactionReceipt" {
            return None;
        }
        let params: serde_json::Value = serde_json::from_str(request.params()?.get()).ok()?;
        let transaction = params.get(0)?.as_str()?.parse().ok()?;
        self.receipt_of(transaction)?.block_hash
    }

    fn number_for_hash(&self, hash: B256) -> Option<u64> {
        self.blocks
            .iter()
            .find(|(_, b)| b.header.hash == hash)
            .map(|(&n, _)| n)
    }

    fn fail_next(&mut self, method: &str) {
        *self
            .transient_failures
            .entry(method.to_string())
            .or_default() += 1;
    }
}

/// An outage at one read site lasts longer than the client's retry budget,
/// including its per-transaction fallback for a one-transaction block's receipts.
struct RpcFault {
    method: &'static str,
    first_param: Option<serde_json::Value>,
    full: Option<bool>,
    remaining: u32,
    hits: u32,
    malformed: bool,
    /// Answer `null` rather than fail the transport.
    null: bool,
}

impl RpcFault {
    fn outage(
        method: &'static str,
        first_param: Option<serde_json::Value>,
        full: Option<bool>,
    ) -> Self {
        Self {
            method,
            first_param,
            full,
            remaining: 16,
            hits: 0,
            malformed: false,
            null: false,
        }
    }

    /// One `null` result, as a provider whose backends lag one another gives
    /// for a block it has already reported.
    fn null_once(method: &'static str, first_param: serde_json::Value, full: Option<bool>) -> Self {
        Self {
            remaining: 1,
            null: true,
            ..Self::outage(method, Some(first_param), full)
        }
    }

    /// `transaction_block` holds the transaction an `eth_getTransactionReceipt`
    /// request reads. That is a read of its block's receipts, so a fault on the
    /// block's `eth_getBlockReceipts` covers it too.
    fn matches(&self, request: &SerializedRequest, transaction_block: Option<B256>) -> bool {
        if request.method() == "eth_getTransactionReceipt" {
            return self.method == "eth_getBlockReceipts"
                && self.first_param.as_ref().is_none_or(|expected| {
                    transaction_block.map(|hash| serde_json::json!(hash.to_string()))
                        == Some(expected.clone())
                });
        }
        let params = request
            .params()
            .map(|p| serde_json::from_str::<serde_json::Value>(p.get()).unwrap());
        request.method() == self.method
            && self.first_param.as_ref().is_none_or(|expected| {
                params
                    .as_ref()
                    .and_then(|p| p.get(0))
                    .map(|p| p.get("blockHash").unwrap_or(p))
                    == Some(expected)
            })
            && self.full.is_none_or(|expected| {
                params
                    .as_ref()
                    .and_then(|p| p.get(1))
                    .and_then(|p| p.as_bool())
                    == Some(expected)
            })
    }
}

/// A recorded RPC call: `(method, full_transactions)`. `full` is meaningful only
/// for `eth_getBlockByNumber` (its second positional param), and lets a test
/// assert that header-only paths never request full transaction bodies.
type CallLog = Arc<Mutex<Vec<(String, bool)>>>;

#[derive(Clone)]
struct MockTransport {
    chain: Arc<Mutex<ChainModel>>,
    calls: CallLog,
}

impl MockTransport {
    fn client(chain: Arc<Mutex<ChainModel>>) -> L1Client {
        Self::client_with_log(chain).0
    }

    /// Like [`Self::client`] but also returns the shared call log, for tests that
    /// assert on the shape of the RPC calls made (header-only vs full).
    fn client_with_log(chain: Arc<Mutex<ChainModel>>) -> (L1Client, CallLog) {
        let calls: CallLog = Arc::new(Mutex::new(Vec::new()));
        let client = L1Client::from_transport(
            MockTransport {
                chain,
                calls: calls.clone(),
            },
            true,
        );
        (client, calls)
    }
}

/// Record `(method, full)` for each request; `full` is the `eth_getBlockByNumber`
/// second positional param (defaults to `false` when absent / another method).
fn account_call(calls: &CallLog, r: &SerializedRequest) {
    let full = r
        .params()
        .and_then(|p| serde_json::from_str::<serde_json::Value>(p.get()).ok())
        .and_then(|v| v.get(1).and_then(|b| b.as_bool()))
        .unwrap_or(false);
    calls.lock().unwrap().push((r.method().to_string(), full));
}

/// Serialize a value into the `Box<RawValue>` a success payload carries.
fn raw<T: serde::Serialize>(v: &T) -> Result<Box<serde_json::value::RawValue>, String> {
    let s = serde_json::to_string(v).map_err(|e| e.to_string())?;
    serde_json::value::RawValue::from_string(s).map_err(|e| e.to_string())
}

/// Dispatch one JSON-RPC request against the chain model.
fn respond(
    chain: &Arc<Mutex<ChainModel>>,
    req: &SerializedRequest,
) -> Result<Box<serde_json::value::RawValue>, String> {
    let g = chain.lock().unwrap();
    let params: serde_json::Value = match req.params() {
        Some(p) => serde_json::from_str(p.get()).map_err(|e| e.to_string())?,
        None => serde_json::Value::Null,
    };
    match req.method() {
        "eth_blockNumber" => raw(&format!("0x{:x}", g.head)),
        "eth_getBlockByNumber" => {
            let tag = params
                .get(0)
                .and_then(|v| v.as_str())
                .ok_or("getBlockByNumber: missing tag")?;
            let number = match tag {
                "finalized" => g.finalized,
                "latest" => g.head,
                hex => u64::from_str_radix(hex.trim_start_matches("0x"), 16)
                    .map_err(|e| format!("bad block number {hex}: {e}"))?,
            };
            let served = g.serve_number_as.get(&number).copied().unwrap_or(number);
            match g.blocks.get(&served) {
                Some(b) => raw(b),
                None => raw(&serde_json::Value::Null),
            }
        }
        "eth_getBlockReceipts" => {
            let id = params.get(0).ok_or("getBlockReceipts: missing block id")?;
            let hash_str = id
                .get("blockHash")
                .and_then(|h| h.as_str())
                .or_else(|| id.as_str().filter(|s| s.len() >= 66))
                .ok_or("getBlockReceipts: expected block hash")?;
            let hash: B256 = hash_str.parse().map_err(|_| "bad block hash".to_string())?;
            let number = g.number_for_hash(hash).ok_or("unknown block hash")?;
            let empty = Vec::new();
            raw(g.receipts.get(&number).unwrap_or(&empty))
        }
        "eth_getTransactionReceipt" => {
            let transaction: B256 = params
                .get(0)
                .and_then(|v| v.as_str())
                .ok_or("getTransactionReceipt: missing hash")?
                .parse()
                .map_err(|_| "bad transaction hash".to_string())?;
            match g.receipt_of(transaction) {
                Some(receipt) => raw(receipt),
                None => raw(&serde_json::Value::Null),
            }
        }
        other => Err(format!("mock L1: unhandled method {other}")),
    }
}

impl tower::Service<RequestPacket> for MockTransport {
    type Response = ResponsePacket;
    type Error = TransportError;
    type Future = TransportFut<'static>;

    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, req: RequestPacket) -> Self::Future {
        let chain = self.chain.clone();
        let calls = self.calls.clone();
        Box::pin(async move {
            match &req {
                RequestPacket::Single(r) => maybe_hold_rpc(&chain, r).await,
                RequestPacket::Batch(rs) => {
                    for r in rs {
                        maybe_hold_rpc(&chain, r).await;
                    }
                }
            }
            let one = |r: &SerializedRequest| -> Result<Response, TransportError> {
                account_call(&calls, r);
                {
                    let mut model = chain.lock().unwrap();
                    let transaction_block = model.transaction_block(r);
                    if let Some(fault) = model
                        .fault
                        .as_mut()
                        .filter(|fault| fault.matches(r, transaction_block))
                    {
                        fault.hits += 1;
                        if fault.malformed {
                            return Ok(Response {
                                id: r.id().clone(),
                                payload: ResponsePayload::Success(
                                    raw(&"invalid block number").unwrap(),
                                ),
                            });
                        }
                        if fault.remaining > 0 {
                            fault.remaining -= 1;
                            if fault.null {
                                return Ok(Response {
                                    id: r.id().clone(),
                                    payload: ResponsePayload::Success(
                                        raw(&serde_json::Value::Null).unwrap(),
                                    ),
                                });
                            }
                            return Err(TransportErrorKind::http_error(403, String::new()));
                        }
                    }
                }
                let should_fail = {
                    let mut g = chain.lock().unwrap();
                    match g.transient_failures.get_mut(r.method()) {
                        Some(remaining) if *remaining > 0 => {
                            *remaining -= 1;
                            true
                        }
                        _ => false,
                    }
                };
                if should_fail {
                    return Err(TransportErrorKind::http_error(
                        504,
                        "error code: 504".to_string(),
                    ));
                }
                if r.method() == "eth_getBlockReceipts"
                    && chain.lock().unwrap().refuse_block_receipts
                {
                    return Ok(Response {
                        id: r.id().clone(),
                        payload: ResponsePayload::Failure(ErrorPayload {
                            code: -32008,
                            message: "Response is too big".into(),
                            data: None,
                        }),
                    });
                }
                let payload = respond(&chain, r).map_err(|m| TransportErrorKind::custom_str(&m))?;
                Ok(Response {
                    id: r.id().clone(),
                    payload: ResponsePayload::Success(payload),
                })
            };
            match req {
                RequestPacket::Single(r) => Ok(ResponsePacket::Single(one(&r)?)),
                RequestPacket::Batch(rs) => {
                    let mut out = Vec::with_capacity(rs.len());
                    for r in rs {
                        out.push(one(&r)?);
                    }
                    Ok(ResponsePacket::Batch(out))
                }
            }
        })
    }
}

fn is_held_full_block(request: &SerializedRequest) -> bool {
    request.method() == "eth_getBlockByNumber"
        && request
            .params()
            .and_then(|p| serde_json::from_str::<serde_json::Value>(p.get()).ok())
            .and_then(|v| v.get(1).and_then(|b| b.as_bool()))
            .unwrap_or(false)
}

async fn maybe_hold_rpc(chain: &Arc<Mutex<ChainModel>>, request: &SerializedRequest) {
    if !is_held_full_block(request) {
        return;
    }
    let (hold, in_flight) = {
        let model = chain.lock().unwrap();
        (model.rpc_hold.clone(), model.rpc_in_flight.clone())
    };
    let Some(mut hold) = hold else {
        return;
    };
    in_flight.fetch_add(1, Ordering::SeqCst);
    struct Dec(Arc<AtomicUsize>);
    impl Drop for Dec {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }
    let _guard = Dec(in_flight);
    while !*hold.borrow() {
        if hold.changed().await.is_err() {
            break;
        }
    }
}

// ===========================================================================
// L1 block / tx / receipt builders (typed → round-trips through serde).
// ===========================================================================

/// A distinct block hash for `(branch, number)`. Common blocks use branch 0 so
/// both forks agree on their shared prefix.
fn bh(branch: u8, number: u64) -> B256 {
    let mut b = [0u8; 32];
    b[0] = branch;
    b[24..32].copy_from_slice(&number.to_be_bytes());
    B256::from(b)
}

/// One inbox transaction carrying `calldata` to the routing-tag address, plus
/// its receipt. `tx_hash` and `sender` are fixture identities.
fn inbox_tx(
    sender: Address,
    calldata: Vec<u8>,
    tx_hash: B256,
    block_hash: B256,
    number: u64,
    timestamp: u64,
) -> (RpcTransaction, TransactionReceipt) {
    let legacy = TxLegacy {
        chain_id: None,
        nonce: 0,
        gas_price: u128::from(BASE_FEE),
        gas_limit: GAS_USED,
        to: TxKind::Call(DEFAULT_INBOX),
        value: U256::ZERO,
        input: Bytes::from(calldata),
    };
    let signed = Signed::new_unchecked(
        legacy,
        Signature::new(U256::from(1u64), U256::from(1u64), false),
        tx_hash,
    );
    let tx = RpcTransaction {
        inner: Recovered::new_unchecked(TxEnvelope::Legacy(signed), sender),
        block_hash: Some(block_hash),
        block_number: Some(number),
        transaction_index: Some(0),
        effective_gas_price: Some(u128::from(BASE_FEE)),
        block_timestamp: Some(timestamp),
    };
    let receipt = TransactionReceipt {
        inner: ReceiptEnvelope::Legacy(ReceiptWithBloom {
            receipt: Receipt {
                status: Eip658Value::Eip658(true),
                cumulative_gas_used: GAS_USED,
                logs: vec![],
            },
            logs_bloom: Bloom::default(),
        }),
        transaction_hash: tx_hash,
        transaction_index: Some(0),
        block_hash: Some(block_hash),
        block_number: Some(number),
        gas_used: GAS_USED,
        effective_gas_price: u128::from(BASE_FEE),
        blob_gas_used: None,
        blob_gas_price: None,
        from: sender,
        to: Some(DEFAULT_INBOX),
        contract_address: None,
    };
    (tx, receipt)
}

/// One inbox blob transaction without a sidecar in the execution payload.
fn blob_inbox_tx(
    sender: Address,
    versioned_hash: B256,
    tx_hash: B256,
    block_hash: B256,
    number: u64,
    timestamp: u64,
) -> (RpcTransaction, TransactionReceipt) {
    let blob = TxEip4844 {
        chain_id: L1_CHAIN_ID,
        nonce: 0,
        gas_limit: GAS_USED,
        max_fee_per_gas: u128::from(BASE_FEE),
        max_priority_fee_per_gas: 0,
        to: DEFAULT_INBOX,
        value: U256::ZERO,
        access_list: Default::default(),
        blob_versioned_hashes: vec![versioned_hash],
        max_fee_per_blob_gas: 1,
        input: Bytes::new(),
    };
    let signed = Signed::new_unchecked(
        TxEip4844Variant::from(blob),
        Signature::new(U256::from(1u64), U256::from(1u64), false),
        tx_hash,
    );
    let tx = RpcTransaction {
        inner: Recovered::new_unchecked(TxEnvelope::Eip4844(signed), sender),
        block_hash: Some(block_hash),
        block_number: Some(number),
        transaction_index: Some(0),
        effective_gas_price: Some(u128::from(BASE_FEE)),
        block_timestamp: Some(timestamp),
    };
    let receipt = TransactionReceipt {
        inner: ReceiptEnvelope::Legacy(ReceiptWithBloom {
            receipt: Receipt {
                status: Eip658Value::Eip658(true),
                cumulative_gas_used: GAS_USED,
                logs: vec![],
            },
            logs_bloom: Bloom::default(),
        }),
        transaction_hash: tx_hash,
        transaction_index: Some(0),
        block_hash: Some(block_hash),
        block_number: Some(number),
        gas_used: GAS_USED,
        effective_gas_price: u128::from(BASE_FEE),
        blob_gas_used: Some(131_072),
        blob_gas_price: Some(1),
        from: sender,
        to: Some(DEFAULT_INBOX),
        contract_address: None,
    };
    (tx, receipt)
}

/// Header timestamp for reorg fixtures. Every fixture is 12 s-free and simply
/// tracks the block number; the crossover fixture pins its activation to the
/// same mapping, so `FORK_ACTIVATION_BLOCK` is exactly the first forked block.
fn fixture_timestamp(number: u64) -> u64 {
    L1_TIMESTAMP_BASE + number
}

/// Assemble a full block with one inbox transaction and an explicit timestamp.
fn inbox_block_at_timestamp(
    number: u64,
    timestamp: u64,
    hash: B256,
    parent: B256,
    sender: Address,
    calldata: Vec<u8>,
    tx_hash: B256,
) -> (Block, Vec<TransactionReceipt>) {
    let (tx, receipt) = inbox_tx(sender, calldata, tx_hash, hash, number, timestamp);
    let header = RpcHeader {
        hash,
        inner: ConsensusHeader {
            number,
            parent_hash: parent,
            base_fee_per_gas: Some(BASE_FEE),
            timestamp,
            ..Default::default()
        },
        total_difficulty: None,
        size: None,
    };
    let block = Block {
        header,
        uncles: vec![],
        transactions: BlockTransactions::Full(vec![tx]),
        withdrawals: None,
    };
    (block, vec![receipt])
}

/// Assemble an ordinary pre-fork fixture block with one inbox transaction.
fn inbox_block(
    number: u64,
    hash: B256,
    parent: B256,
    sender: Address,
    calldata: Vec<u8>,
    tx_hash: B256,
) -> (Block, Vec<TransactionReceipt>) {
    inbox_block_at_timestamp(
        number,
        fixture_timestamp(number),
        hash,
        parent,
        sender,
        calldata,
        tx_hash,
    )
}

fn blob_inbox_block(
    number: u64,
    hash: B256,
    parent: B256,
    sender: Address,
    versioned_hash: B256,
    tx_hash: B256,
) -> (Block, Vec<TransactionReceipt>) {
    let timestamp = fixture_timestamp(number);
    let (tx, receipt) = blob_inbox_tx(sender, versioned_hash, tx_hash, hash, number, timestamp);
    let block = Block {
        header: RpcHeader {
            hash,
            inner: ConsensusHeader {
                number,
                parent_hash: parent,
                base_fee_per_gas: Some(BASE_FEE),
                timestamp,
                ..Default::default()
            },
            total_difficulty: None,
            size: None,
        },
        uncles: vec![],
        transactions: BlockTransactions::Full(vec![tx]),
        withdrawals: None,
    };
    (block, vec![receipt])
}

// ===========================================================================
// PCASH inbox-batch / transaction builders.
// ===========================================================================

fn framed_batch(items: &[Vec<u8>]) -> Vec<u8> {
    pcash_derive::Batch {
        version: pcash_derive::BatchVersion::V1,
        poster_owner_commitment: field_element(word(1)),
        poster_context: word(0),
        items: items.iter().map(Vec::as_slice).collect(),
    }
    .encode()
    .unwrap()
}

/// A kind-1 user-account creation with a garbage signature — admitted, rejected
/// at derivation (InvalidAccountSignature), so it produces a stored receipt
/// (accepted = false) without touching the account state tree. `tag` makes
/// each fixture's bytes distinct.
fn account_transaction(tag: u8) -> Vec<u8> {
    Transaction::UserAccountCreation(UserAccountCreation::new(
        word(u64::from(tag)),
        CircuitWord::ZERO,
        None,
        CircuitWord::ZERO, // unreached: bad signature
        0,
        AccountCreationAuthorization::Eip712 {
            sig_r: CircuitWord::ZERO,
            sig_s: CircuitWord::ZERO,
            y_parity: false,
        },
    ))
    .encode(PCASH_CHAIN_ID)
    .unwrap()
}

/// A type-0 private_value transaction whose public inputs pass validation against
/// the recent canonical snapshot. With [`YesVerify`] the proof check passes and
/// the transaction is accepted.
#[allow(
    clippy::too_many_arguments,
    reason = "fixture constructor names every encoded field"
)]
fn transfer_transaction(
    nul0: Fr,
    nul1: Fr,
    recent_pcash_block_hash: B256,
    output_data0: &[u8],
    output_data1: &[u8],
    output_data2: &[u8],
    output_data3: &[u8],
    output_data4: &[u8],
) -> Vec<u8> {
    Transaction::PrivateValue(transfer_section(
        nul0,
        nul1,
        recent_pcash_block_hash,
        [
            output_data0,
            output_data1,
            output_data2,
            output_data3,
            output_data4,
        ],
    ))
    .encode(PCASH_CHAIN_ID)
    .unwrap()
}

/// The S private-value section of [`transfer_transaction`].
fn transfer_section(
    nul0: Fr,
    nul1: Fr,
    recent_pcash_block_hash: B256,
    output_data: [&[u8]; 5],
) -> PrivateValueSection {
    // Dummy nullifiers for the two unused input slots.
    let nul2 = nul0 + Fr::from(1_000_000u64);
    let nul3 = nul1 + Fr::from(2_000_000u64);
    PrivateValueSection::new(
        PrivateValueShape::S,
        PCASH_CHAIN_ID,
        &[
            recent_pcash_block_hash, // recentPcashBlockHash (genesis boundary)
            fr_to_bytes(nul0),
            fr_to_bytes(nul1),
            fr_to_bytes(nul2),
            fr_to_bytes(nul3),
            fr_to_bytes(Fr::from(1u64)), // body0
            fr_to_bytes(Fr::from(2u64)), // body1
            fr_to_bytes(Fr::from(3u64)), // body2
            fr_to_bytes(Fr::from(4u64)), // body3
            fr_to_bytes(Fr::from(5u64)), // body4
            word(0),                     // openFeeAmount
            word(1),                     // issuanceOwnerCommitment
            word(0),                     // notBeforeTimestamp
            // validUntilTimestamp is after inbox_block()'s header timestamp.
            word(L1_TIMESTAMP_BASE + GENESIS + 100),
            word(0), // carrierContextHash
            word(0), // eventsCommitment
        ],
        vec![0u8; SectionLayout::PrivateValue(PrivateValueShape::S).proof_bytes()],
        output_data.map(common::output_data).to_vec(),
        common::arena(),
    )
    .unwrap()
}

/// The S private-value section of [`transfer_transaction`], carried by an account
/// action.
fn account_action_section(
    nul0: Fr,
    nul1: Fr,
    recent_pcash_block_hash: B256,
    label: &[u8],
) -> PrivateValueSection {
    transfer_section(nul0, nul1, recent_pcash_block_hash, [label; 5])
}

/// [`transfer_transaction`] on the open route: its payout pays the including
/// batch's poster.
fn open_transfer_transaction(
    nul0: Fr,
    nul1: Fr,
    recent_pcash_block_hash: B256,
    label: &[u8],
) -> Vec<u8> {
    let mut section = transfer_section(nul0, nul1, recent_pcash_block_hash, [label; 5]);
    *section
        .public_input_mut(PrivateValueShape::S.profile().issuance_owner_offset)
        .unwrap() = CircuitWord::ZERO;
    Transaction::PrivateValue(section)
        .encode(PCASH_CHAIN_ID)
        .unwrap()
}

/// A creation of its carrier's L1 sender.
fn direct_account_transaction(
    recent_pcash_block_hash: B256,
    valid_until_timestamp: u64,
) -> Vec<u8> {
    Transaction::UserAccountCreation(UserAccountCreation::new(
        word(0x41),
        word(0x42),
        None,
        recent_pcash_block_hash,
        valid_until_timestamp,
        AccountCreationAuthorization::DirectL1,
    ))
    .encode(PCASH_CHAIN_ID)
    .unwrap()
}

fn account_update_transaction(
    address: Address,
    new_rule_set_commitment: CircuitWord,
    account_update_commitment: CircuitWord,
    mut section: PrivateValueSection,
) -> Vec<u8> {
    section
        .proof
        .resize(SectionLayout::UserAccountUpdate.proof_bytes(), 0);
    Transaction::UserAccountUpdate(UserAccountUpdate {
        address,
        new_rule_set_commitment,
        receive_key_update: ReceiveKeyUpdate::Keep,
        account_update_commitment,
        section,
    })
    .encode(PCASH_CHAIN_ID)
    .unwrap()
}

fn contract_creation_transaction(mut fee: PrivateValueSection) -> Vec<u8> {
    fee.proof
        .resize(SectionLayout::ContractAccountCreation.proof_bytes(), 0);
    Transaction::ContractAccountCreation(ContractAccountCreation {
        // Publishes a nullifier-key commitment, not nkRoot; no receive key.
        body: ContractBody::new(
            false,
            word(0x51),
            None,
            vec![ContractFunction {
                selector: 0,
                application_vk_hash: word(0x52),
                configuration_commitment: word(0x53),
            }],
        )
        .unwrap(),
        funding: ContractFunding::Sponsored(fee),
    })
    .encode(PCASH_CHAIN_ID)
    .unwrap()
}

fn section_nullifiers(nul0: Fr, nul1: Fr) -> [B256; 4] {
    [
        fr_to_bytes(nul0),
        fr_to_bytes(nul1),
        fr_to_bytes(nul0 + Fr::from(1_000_000u64)),
        fr_to_bytes(nul1 + Fr::from(2_000_000u64)),
    ]
}

fn addr(b: u8) -> Address {
    Address::from([b; 20])
}
fn nul(x: u64) -> Fr {
    Fr::from(7_000_000 + x)
}
fn inclusion_tx_id(l1_block_hash: B256) -> B256 {
    pcash_state::transaction_id(l1_block_hash, 0, 0)
}
fn a_transfer_id() -> B256 {
    inclusion_tx_id(bh(0xaa, 102))
}
fn a_account_id() -> B256 {
    inclusion_tx_id(bh(0xaa, 103))
}
fn b_account0_id() -> B256 {
    inclusion_tx_id(bh(0xbb, 102))
}
fn b_transfer_id() -> B256 {
    inclusion_tx_id(bh(0xbb, 103))
}
fn b_account1_id() -> B256 {
    inclusion_tx_id(bh(0xbb, 104))
}
/// A checked-in 32-byte hash.
fn known_hash(value: &str) -> B256 {
    B256::from_slice(&hex::decode(value).expect("known answer must be hex"))
}

// ===========================================================================
// Scenario construction.
// ===========================================================================

/// The canonical transaction sequence and its identifying artifacts.
#[derive(Clone)]
struct Transactions {
    recent_hash: B256,
    a_transfer: Vec<u8>, // branch-A transfer (block 102)
    a_account: Vec<u8>,  // branch-A account (block 103)
    b_account0: Vec<u8>, // branch-B account (block 102)
    b_transfer: Vec<u8>, // branch-B transfer (block 103)
    b_account1: Vec<u8>, // branch-B account (block 104)
}

/// The PCASH block hash committed at genesis (100). It is common to
/// every branch, and — pushed at genesis's boundary — stays in-window for a
/// transfer at any later block (101/102/103), so both the reorged and the clean
/// derivations accept the transfers identically. A transfer must reference a
/// PCASH block committed *before* its own block, so genesis's is the one value
/// valid at every placement the tests use.
async fn genesis_pcash_block_hash() -> eyre::Result<B256> {
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    {
        let mut g = chain.lock().unwrap();
        g.finalized = GENESIS;
        let (b100, r100) = inbox_block(
            100,
            bh(0, 100),
            bh(0, 99),
            sender(),
            framed_batch(&[account_transaction(0xc0)]),
            bh(0xf0, 100),
        );
        g.insert(b100, r100);
        g.head = 100;
    }
    let tmp = tempfile::tempdir()?;
    let inner = fresh_node(&tmp.path().join("prefix.redb"));
    let mut follower = Follower::new(MockTransport::client(chain.clone()), GENESIS);
    drive(&inner, &mut follower, &YesVerify).await?;
    let hash = inner.lock().unwrap().state.canonical_tip().unwrap().hash;
    Ok(hash)
}

async fn transactions() -> eyre::Result<Transactions> {
    let recent_hash = genesis_pcash_block_hash().await?;
    Ok(Transactions {
        recent_hash,
        a_transfer: transfer_transaction(
            nul(1),
            nul(2),
            recent_hash,
            b"A-env-0",
            b"A-env-1",
            b"A-env-2",
            b"A-env-3",
            b"A-env-4",
        ),
        a_account: account_transaction(0xa3),
        b_account0: account_transaction(0xb2),
        b_transfer: transfer_transaction(
            nul(3),
            nul(4),
            recent_hash,
            b"B-env-0",
            b"B-env-1",
            b"B-env-2",
            b"B-env-3",
            b"B-env-4",
        ),
        b_account1: account_transaction(0xb4),
    })
}

/// Populate branch A: common blocks 100/101 (records) then A-specific 102
/// (transfer) and 103 (record). `finalized` is set by the caller.
fn write_branch_a(chain: &Arc<Mutex<ChainModel>>, e: &Transactions, finalized: u64) {
    let mut g = chain.lock().unwrap();
    *g = ChainModel::default();
    g.finalized = finalized;
    // Common prefix (branch tag 0) — identical on both forks.
    let (b100, r100) = inbox_block(
        100,
        bh(0, 100),
        bh(0, 99),
        sender(),
        framed_batch(&[account_transaction(0xc0)]),
        bh(0xf0, 100),
    );
    let (b101, r101) = inbox_block(
        101,
        bh(0, 101),
        bh(0, 100),
        sender(),
        framed_batch(&[account_transaction(0xc1)]),
        bh(0xf0, 101),
    );
    g.insert(b100, r100);
    g.insert(b101, r101);
    // Branch-A suffix (tag 0xAA).
    let (b102, r102) = inbox_block(
        102,
        bh(0xAA, 102),
        bh(0, 101),
        sender(),
        framed_batch(std::slice::from_ref(&e.a_transfer)),
        bh(0xf1, 102),
    );
    let (b103, r103) = inbox_block(
        103,
        bh(0xAA, 103),
        bh(0xAA, 102),
        sender(),
        framed_batch(std::slice::from_ref(&e.a_account)),
        bh(0xf1, 103),
    );
    g.insert(b102, r102);
    g.insert(b103, r103);
    g.head = 103;
}

/// Reorg to branch B: keep 100/101, replace 102/103 (tag 0xBB), extend to 104.
fn write_branch_b(chain: &Arc<Mutex<ChainModel>>, e: &Transactions) {
    let mut g = chain.lock().unwrap();
    g.truncate_above(101);
    let (b102, r102) = inbox_block(
        102,
        bh(0xBB, 102),
        bh(0, 101),
        sender(),
        framed_batch(std::slice::from_ref(&e.b_account0)),
        bh(0xf2, 102),
    );
    let (b103, r103) = inbox_block(
        103,
        bh(0xBB, 103),
        bh(0xBB, 102),
        sender(),
        framed_batch(std::slice::from_ref(&e.b_transfer)),
        bh(0xf2, 103),
    );
    let (b104, r104) = inbox_block(
        104,
        bh(0xBB, 104),
        bh(0xBB, 103),
        sender(),
        framed_batch(std::slice::from_ref(&e.b_account1)),
        bh(0xf2, 104),
    );
    g.insert(b102, r102);
    g.insert(b103, r103);
    g.insert(b104, r104);
    g.head = 104;
}

/// Serve Beacon chain configuration, then replace branch A with branch B while
/// answering the first blob request with no data. This makes the unavailable
/// block an orphan before the follow loop retries its height.
fn reorging_beacon(
    chain: Arc<Mutex<ChainModel>>,
    transactions: Transactions,
) -> (String, std::sync::mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (request_tx, requests) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let responses = [
            br#"{"data":{"genesis_time":"1800000000"}}"#.as_slice(),
            br#"{"data":{"SECONDS_PER_SLOT":"1"}}"#.as_slice(),
            &[][..],
        ];
        for (index, body) in responses.into_iter().enumerate() {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 4_096];
            loop {
                let read = socket.read(&mut chunk).unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            request_tx
                .send(String::from_utf8(request).unwrap())
                .unwrap();
            if index == 2 {
                write_branch_b(&chain, &transactions);
            }
            let content_type = if index == 2 {
                "application/octet-stream"
            } else {
                "application/json"
            };
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(headers.as_bytes()).unwrap();
            socket.write_all(body).unwrap();
        }
    });
    (endpoint, requests)
}

fn fresh_node(path: &std::path::Path) -> Arc<Mutex<NodeInner>> {
    let cfg = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        GENESIS,
        bh(0, GENESIS),
    );
    build_node(path, &cfg).unwrap()
}

/// One forward pass of the follow loop's core: refresh, then derive up to the
/// (unfinalized) head, walking back on any reorg. Deterministic — no polling.
async fn drive(
    inner: &Arc<Mutex<NodeInner>>,
    follower: &mut Follower,
    verifier: &YesVerify,
) -> eyre::Result<()> {
    follower.refresh().await?;
    // Mirror `run_follow`: `l1_finalized` is advanced only behind a derived block
    // (clamped to its height), never from the raw tag before deriving.
    let ceiling = follower.head();
    *inner
        .lock()
        .unwrap()
        .observed_l1_block_number
        .write()
        .unwrap() = Some(ceiling);
    while follower.cursor() <= ceiling {
        match follower.next().await? {
            Step::Block(data) => {
                let mut g = inner.lock().unwrap();
                let n = data.header.number;
                g.apply_block(&data, verifier)?;
                let fin = follower.finalized().min(n);
                g.prune_finalized(fin)?;
            }
            Step::Reorg(reorg) => handle_reorg(inner, follower, reorg).await?,
            Step::AtHead => break,
        }
    }
    Ok(())
}

/// Run the full A→B reorg against a node at `path` with the given finalized
/// height, returning the reorged node (already on branch B).
async fn run_reorg_scenario(
    path: &std::path::Path,
    chain: &Arc<Mutex<ChainModel>>,
    e: &Transactions,
    finalized: u64,
) -> eyre::Result<Arc<Mutex<NodeInner>>> {
    write_branch_a(chain, e, finalized);
    let inner = fresh_node(path);
    let mut follower = Follower::new(MockTransport::client(chain.clone()), GENESIS);
    drive(&inner, &mut follower, &YesVerify).await?;

    write_branch_b(chain, e);
    drive(&inner, &mut follower, &YesVerify).await?;
    Ok(inner)
}

/// State root of a node that derives the CURRENT chain from genesis with no
/// reorg — the clean baseline the reorged node must equal.
async fn clean_derivation_root(chain: &Arc<Mutex<ChainModel>>) -> eyre::Result<B256> {
    let (_tmp, inner) = clean_derivation(chain).await?;
    let g = inner.lock().unwrap();
    Ok(g.state.state_root().0)
}

/// A fresh node that derived `chain` from genesis; the directory must outlive it.
async fn clean_derivation(
    chain: &Arc<Mutex<ChainModel>>,
) -> eyre::Result<(tempfile::TempDir, Arc<Mutex<NodeInner>>)> {
    let tmp = tempfile::tempdir()?;
    let inner = fresh_node(&tmp.path().join("clean.redb"));
    let mut follower = Follower::new(MockTransport::client(chain.clone()), GENESIS);
    drive(&inner, &mut follower, &YesVerify).await?;
    Ok((tmp, inner))
}

// ===========================================================================
// Tests.
// ===========================================================================

#[tokio::test]
async fn reorg_replaces_suffix_matches_clean_derivation() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    let tmp = tempfile::tempdir()?;

    // Fork point 101 sits above finalized (100): a normal unfinalized reorg.
    // Each branch's last block also carries a carrier event, whose item takes
    // the position after its transaction's Inbox item.
    write_branch_a(&chain, &e, 100);
    add_carrier_event(
        &chain,
        103,
        addr(0xe1),
        framed_batch(&[account_transaction(0xa6)]),
    );
    let inner = fresh_node(&tmp.path().join("state.redb"));
    let handle = NodeHandle::new(inner.clone());
    let mut follower = Follower::new(MockTransport::client(chain.clone()), GENESIS);
    drive(&inner, &mut follower, &YesVerify).await?;
    let a_event_id = pcash_state::transaction_id(bh(0xaa, 103), 0, 1);
    let a_deliveries = deliveries(&handle, bh(0xf1, 103))?;
    assert_eq!(
        a_deliveries
            .iter()
            .map(|delivery| (delivery.carrier_type, delivery.log_index))
            .collect::<Vec<_>>(),
        [
            (pcash_rpc::CarrierTypeDto::Calldata, None),
            (pcash_rpc::CarrierTypeDto::Event, Some(0)),
        ]
    );
    assert_eq!(
        handle.get_receipt(ReceiptQuery::tx_id(a_event_id))?.len(),
        1
    );

    write_branch_b(&chain, &e);
    add_carrier_event(
        &chain,
        104,
        addr(0xe2),
        framed_batch(&[account_transaction(0xb6)]),
    );
    drive(&inner, &mut follower, &YesVerify).await?;

    // The orphaned carrier event's manifests and result are gone; the
    // replacement's are canonical.
    assert!(deliveries(&handle, bh(0xf1, 103))?.is_empty());
    assert!(handle
        .get_receipt(ReceiptQuery::tx_id(a_event_id))?
        .is_empty());
    let b_deliveries = deliveries(&handle, bh(0xf2, 104))?;
    assert_eq!(b_deliveries.len(), 2);
    assert_eq!(b_deliveries[1].emitter, Some(addr(0xe2)));
    assert_eq!(b_deliveries[1].items[0].batch_item_index, 1);
    assert_eq!(
        handle
            .get_receipt(ReceiptQuery::tx_id(pcash_state::transaction_id(
                bh(0xbb, 104),
                0,
                1
            )))?
            .len(),
        1
    );

    // State, payout records, and receipts equal a clean derivation of the
    // replacement branch.
    let reorged_root = { inner.lock().unwrap().state.state_root().0 };
    let (_clean_dir, clean) = clean_derivation(&chain).await?;
    let clean_root = clean.lock().unwrap().state.state_root().0;
    assert_eq!(
        reorged_root, clean_root,
        "reorged state must equal clean branch-B derivation"
    );
    assert_eq!(
        handle.get_payouts(pcash_rpc::PayoutQuery::default())?,
        NodeHandle::new(clean.clone()).get_payouts(pcash_rpc::PayoutQuery::default())?,
        "reorged payout records must equal clean branch-B derivation"
    );
    {
        let (reorged, clean) = (inner.lock().unwrap(), clean.lock().unwrap());
        assert_eq!(
            reorged.index.load_receipts_up_to(u64::MAX)?,
            clean.index.load_receipts_up_to(u64::MAX)?,
            "reorged receipts must equal clean branch-B derivation"
        );
    }

    // Head advanced to the branch-B tip.
    assert_eq!(handle.status().unwrap().latest_block, 4);

    // The canonical feeds equal a clean derivation of the replacement branch
    // at every block.
    let clean_handle = NodeHandle::new(clean.clone());
    for number in 0..=4 {
        let block = handle.get_block(number, false)?.expect("canonical block");
        let target = BlockId {
            block_number: number,
            block_hash: block.hash,
        };
        assert_eq!(
            handle.get_output_frontier(target)?,
            clean_handle.get_output_frontier(target)?
        );
        assert_eq!(
            account_changes(&handle, target)?,
            account_changes(&clean_handle, target)?
        );
    }

    // Orphaned receipts disappear; replacement receipts are present.
    assert!(
        handle
            .get_receipt(ReceiptQuery::tx_id(a_transfer_id()))
            .unwrap()
            .is_empty(),
        "orphaned branch-A transfer receipt must be gone"
    );
    assert!(
        handle
            .get_receipt(ReceiptQuery::tx_id(a_account_id()))
            .unwrap()
            .is_empty(),
        "orphaned branch-A record receipt must be gone"
    );
    assert_eq!(
        handle
            .get_receipt(ReceiptQuery::tx_id(b_transfer_id()))
            .unwrap()
            .len(),
        1,
        "branch-B transfer receipt present"
    );
    assert_eq!(
        handle
            .get_receipt(ReceiptQuery::tx_id(b_account1_id()))
            .unwrap()
            .len(),
        1,
        "branch-B record receipt present"
    );

    // The orphaned transfer's payout is gone; the replacement's is
    // attributed to its canonical inclusion.
    let payouts = handle.get_payouts(pcash_rpc::PayoutQuery::default())?;
    assert_eq!(payouts.records.len(), 1);
    assert_eq!(payouts.records[0].block_number, 3);
    assert_eq!(
        payouts.records[0].payout.transaction_id,
        Some(b_transfer_id())
    );
    let b_receipt = &handle.get_receipt(ReceiptQuery::tx_id(b_transfer_id()))?[0];
    assert_eq!(b_receipt.issuance_owner_commitment, Some(word(1)));
    assert!(!b_receipt.settled_issuance_amount.is_zero());

    // Orphaned wallet outputs disappear; replacement outputs are present.
    let outputs = wallet_outputs(&handle, 4);
    let bytes: Vec<Vec<u8>> = outputs.iter().map(|(_, data)| data.clone()).collect();
    assert!(
        bytes.iter().any(|b| b == &common::output_data(b"B-env-0")),
        "branch-B data 0 present"
    );
    assert!(
        bytes.iter().any(|b| b == &common::output_data(b"B-env-1")),
        "branch-B data 1 present"
    );
    assert!(
        !bytes.iter().any(|b| b == &common::output_data(b"A-env-0")),
        "orphaned branch-A data must be gone"
    );
    assert!(
        !bytes.iter().any(|b| b == &common::output_data(b"A-env-1")),
        "orphaned branch-A data must be gone"
    );

    // The re-derived transfer's absolute leaf indices are 0..4 (empty output tree
    // after the reorg; the orphaned transfer's leaves are gone).
    let b_envs: Vec<_> = outputs
        .iter()
        .filter(|(_, data)| {
            data.get(1..)
                .is_some_and(|bytes| bytes.starts_with(b"B-env"))
        })
        .collect();
    assert_eq!(b_envs.len(), 5);
    let mut leaves: Vec<u64> = b_envs.iter().map(|(leaf, _)| *leaf).collect();
    leaves.sort_unstable();
    assert_eq!(leaves, vec![0, 1, 2, 3, 4]);
    Ok(())
}

/// One page of an L1 transaction's manifests.
fn delivery_page(
    handle: &NodeHandle,
    l1_transaction_hash: B256,
    continuation: Option<L1DeliveryBatchContinuationDto>,
    max_batches: u32,
    max_bytes: u32,
) -> Result<L1DeliveryBatchPageDto, IndexReadError> {
    handle.get_l1_delivery_batches(L1DeliveryBatchesRequest {
        l1_transaction_hash,
        continuation,
        limits: L1DeliveryBatchLimits {
            max_batches,
            max_bytes,
        },
    })
}

/// Every manifest of an L1 transaction with few carriers.
fn deliveries(
    handle: &NodeHandle,
    l1_transaction_hash: B256,
) -> Result<Vec<pcash_rpc::L1DeliveryBatchDto>, IndexReadError> {
    let page = delivery_page(handle, l1_transaction_hash, None, 100, 1 << 20)?;
    assert!(page.complete);
    Ok(page.batches)
}

#[tokio::test]
async fn delivery_manifests_page_in_carrier_order_within_their_block() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    let tmp = tempfile::tempdir()?;
    write_branch_a(&chain, &e, 100);
    for (emitter, tag) in [(0xe1, 0xa6), (0xe2, 0xa7), (0xe3, 0xa8)] {
        add_carrier_event(
            &chain,
            103,
            addr(emitter),
            framed_batch(&[account_transaction(tag)]),
        );
    }
    let inner = fresh_node(&tmp.path().join("state.redb"));
    let handle = NodeHandle::new(inner.clone());
    let mut follower = Follower::new(MockTransport::client(chain.clone()), GENESIS);
    drive(&inner, &mut follower, &YesVerify).await?;

    let transaction = bh(0xf1, 103);
    let whole = deliveries(&handle, transaction)?;
    assert_eq!(
        whole
            .iter()
            .map(|delivery| (delivery.carrier_type, delivery.emitter))
            .collect::<Vec<_>>(),
        [
            (pcash_rpc::CarrierTypeDto::Calldata, None),
            (pcash_rpc::CarrierTypeDto::Event, Some(addr(0xe1))),
            (pcash_rpc::CarrierTypeDto::Event, Some(addr(0xe2))),
            (pcash_rpc::CarrierTypeDto::Event, Some(addr(0xe3))),
        ]
    );

    // One manifest per page walks every manifest in carrier order.
    let mut walked = Vec::new();
    let mut continuation = None;
    loop {
        let page = delivery_page(&handle, transaction, continuation, 1, 1 << 20)?;
        assert_eq!(page.l1_transaction_hash, transaction);
        assert_eq!(page.batches.len(), 1);
        walked.extend(page.batches);
        continuation = page.continuation;
        let Some(next) = continuation else {
            assert!(page.complete);
            break;
        };
        assert!(!page.complete);
        assert_eq!(next.next_batch, walked.len() as u64);
    }
    assert_eq!(walked, whole);

    // A page holds whole manifests within its byte bound, and always at least one.
    let size = |delivery| serde_json::to_vec(delivery).unwrap().len() as u32;
    let two = size(&whole[0]) + size(&whole[1]);
    for (max_bytes, held) in [(two, 2), (two - 1, 1), (1, 1)] {
        let page = delivery_page(&handle, transaction, None, 100, max_bytes)?;
        assert_eq!(page.batches, whole[..held]);
        assert_eq!(
            page.continuation.map(|next| next.next_batch),
            Some(held as u64)
        );
    }

    // A continuation reads the requested transaction's manifests from its
    // position; one at or past the last manifest reads an empty, complete page.
    let issued = delivery_page(&handle, transaction, None, 1, 1 << 20)?
        .continuation
        .expect("a one-manifest page of four continues");
    for (next_batch, held) in [(0, &whole[..]), (3, &whole[3..]), (4, &[]), (u64::MAX, &[])] {
        let page = delivery_page(
            &handle,
            transaction,
            Some(L1DeliveryBatchContinuationDto {
                next_batch,
                ..issued
            }),
            100,
            1 << 20,
        )?;
        assert_eq!(page.batches, held, "{next_batch}");
        assert!(page.complete && page.continuation.is_none(), "{next_batch}");
    }
    // A continuation names the block that retains the manifests.
    let forged = L1DeliveryBatchContinuationDto {
        block: BlockId {
            block_hash: bh(0xf1, 103),
            ..issued.block
        },
        ..issued
    };
    assert!(matches!(
        delivery_page(&handle, transaction, Some(forged), 1, 1 << 20),
        Err(IndexReadError::CursorMismatch)
    ));

    // A continuation is bound to the block that retains the manifests, so one
    // from an orphaned branch is refused.
    let orphaned = Some(issued);
    write_branch_b(&chain, &e);
    drive(&inner, &mut follower, &YesVerify).await?;
    assert!(deliveries(&handle, transaction)?.is_empty());
    assert!(matches!(
        delivery_page(&handle, transaction, orphaned, 1, 1 << 20),
        Err(IndexReadError::CursorMismatch)
    ));
    Ok(())
}

#[tokio::test]
async fn reorg_fork_point_exactly_at_finalized_restores() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    let tmp = tempfile::tempdir()?;

    // finalized == 101 == the fork point: the anchor savepoint at 101 is
    // retained (exclusive prune), so the walk-back restores it rather than
    // treating the fork as fatal.
    let inner = run_reorg_scenario(&tmp.path().join("state.redb"), &chain, &e, 101).await?;

    assert_eq!(
        inner.lock().unwrap().latest_block(),
        4,
        "reorg with fork == finalized must complete"
    );
    let reorged_root = { inner.lock().unwrap().state.state_root().0 };
    let clean_root = clean_derivation_root(&chain).await?;
    assert_eq!(reorged_root, clean_root);
    Ok(())
}

#[tokio::test]
async fn reorg_below_finalized_halts() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    let tmp = tempfile::tempdir()?;

    // finalized == 102 forces the fork point (101) strictly below finalized:
    // nothing restorable there, so the walk-back bails.
    write_branch_a(&chain, &e, 102);
    let inner = fresh_node(&tmp.path().join("state.redb"));
    let mut follower = Follower::new(MockTransport::client(chain.clone()), GENESIS);
    drive(&inner, &mut follower, &YesVerify).await?;

    write_branch_b(&chain, &e);
    let err = drive(&inner, &mut follower, &YesVerify)
        .await
        .expect_err("a reorg below finalized must be fatal");
    assert!(
        err.to_string().contains("below locally finalized"),
        "unexpected error: {err}"
    );
    Ok(())
}

#[tokio::test]
async fn fresh_create_refuses_to_overwrite_existing_state() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    let tmp = tempfile::tempdir()?;
    let path = tmp.path().join("state.redb");

    let expected_root = {
        let inner = run_reorg_scenario(&path, &chain, &e, 100).await?;
        let root = { inner.lock().unwrap().state.state_root().0 };
        drop(inner);
        root
    };
    let error = match build_node(&path, &cfg()) {
        Ok(_) => panic!("fresh create unexpectedly replaced existing canonical state"),
        Err(error) => error,
    };
    assert!(error
        .to_string()
        .contains("refusing to create canonical state"));
    assert_eq!(expected_root, clean_derivation_root(&chain).await?);
    Ok(())
}

/// Sanity that the top-level `run_follow` (always-latest, no mode) derives the
/// mock chain forward and prunes without error.
#[tokio::test]
async fn run_follow_forward_over_mock() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    write_branch_a(&chain, &e, 100);
    let tmp = tempfile::tempdir()?;
    let inner = fresh_node(&tmp.path().join("state.redb"));
    let follower = Follower::new(MockTransport::client(chain.clone()), GENESIS);

    pcash_node::run_follow(
        inner.clone(),
        follower,
        YesVerify,
        Some(103),
        std::time::Duration::from_millis(10),
        beacon(),
        None,
        Arc::new(NoopMetrics),
    )
    .await?;

    let handle = NodeHandle::new(inner.clone());
    let status = handle.status().unwrap();
    assert_eq!(status.latest_block, 3);
    assert_eq!(status.finalized_block, 0);
    assert_eq!(status.latest_l1_block_number, 103);
    assert_eq!(status.observed_l1_block_number, Some(103));
    assert_eq!(status.finalized_l1_block_number, 100);
    assert!(status.issued_so_far > U256::ZERO);
    // The branch-A transfer at block 102 was accepted and produced wallet outputs.
    assert_eq!(
        handle
            .get_receipt(ReceiptQuery::tx_id(a_transfer_id()))
            .unwrap()
            .len(),
        1
    );
    Ok(())
}

/// A tip replaced at its own height, with the L1 head held there, is a reorg.
/// No later block arrives to show it through parent continuity, so the follow
/// loop must compare the last derived block's hash while it waits at head.
#[tokio::test]
async fn run_follow_at_head_reorgs_a_tip_replaced_at_its_height() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    write_branch_a(&chain, &e, 100);
    let tmp = tempfile::tempdir()?;
    let inner = fresh_node(&tmp.path().join("state.redb"));
    let mut follower = Follower::new(MockTransport::client(chain.clone()), GENESIS);
    drive(&inner, &mut follower, &YesVerify).await?;
    assert_eq!(inner.lock().unwrap().block_hashes[&103], bh(0xAA, 103));

    write_branch_b(&chain, &e);
    {
        let mut g = chain.lock().unwrap();
        g.truncate_above(103);
        g.head = 103;
    }
    pcash_node::run_follow(
        inner.clone(),
        follower,
        YesVerify,
        Some(103),
        std::time::Duration::from_millis(1),
        beacon(),
        None,
        Arc::new(NoopMetrics),
    )
    .await?;

    assert_eq!(inner.lock().unwrap().block_hashes[&103], bh(0xBB, 103));
    Ok(())
}

#[tokio::test]
async fn unavailable_blob_orphan_does_not_stall_reorg_detection() -> eyre::Result<()> {
    let transactions = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    write_branch_a(&chain, &transactions, 100);

    let mut versioned_hash = B256::repeat_byte(0x44);
    versioned_hash.0[0] = 1;
    let (orphan, receipt) = blob_inbox_block(
        102,
        bh(0xAA, 102),
        bh(0, 101),
        sender(),
        versioned_hash,
        bh(0xf1, 102),
    );
    chain.lock().unwrap().insert(orphan, receipt);

    let (endpoint, requests) = reorging_beacon(chain.clone(), transactions);
    let beacon = Arc::new(BeaconClient::connect(&endpoint).await?);
    let tmp = tempfile::tempdir()?;
    let inner = fresh_node(&tmp.path().join("unavailable-orphan.redb"));
    pcash_node::run_follow(
        inner.clone(),
        Follower::new(MockTransport::client(chain.clone()), GENESIS),
        YesVerify,
        Some(104),
        std::time::Duration::from_millis(1),
        beacon,
        None,
        Arc::new(NoopMetrics),
    )
    .await?;

    let _ = requests.recv().unwrap();
    let _ = requests.recv().unwrap();
    let blob_request = requests.recv().unwrap();
    assert!(blob_request.contains(&format!("versioned_hashes={versioned_hash}")));
    assert_eq!(inner.lock().unwrap().head, Some(104));
    assert_eq!(inner.lock().unwrap().block_hashes[&104], bh(0xBB, 104));
    let followed_root = inner.lock().unwrap().state.state_root().0;
    let clean_root = clean_derivation_root(&chain).await?;
    assert_eq!(followed_root, clean_root);
    Ok(())
}

#[tokio::test]
async fn run_follow_skips_malformed_proof_and_continues() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    write_branch_a(&chain, &e, 100);
    let tmp = tempfile::tempdir()?;
    let inner = fresh_node(&tmp.path().join("state.redb"));
    let follower = Follower::new(MockTransport::client(chain.clone()), GENESIS);
    let calls = Arc::new(AtomicUsize::new(0));
    let verifier = OffLockRejectVerifier {
        inner: inner.clone(),
        calls: calls.clone(),
    };

    pcash_node::run_follow(
        inner.clone(),
        follower,
        verifier,
        Some(103),
        std::time::Duration::from_millis(10),
        beacon(),
        None,
        Arc::new(NoopMetrics),
    )
    .await?;

    assert_eq!(
        calls.load(Ordering::Relaxed),
        1,
        "the malformed proof is classified once during prewarm"
    );
    let handle = NodeHandle::new(inner.clone());
    let transfer = handle
        .get_receipt(ReceiptQuery::tx_id(a_transfer_id()))
        .unwrap();
    assert_eq!(transfer.len(), 1);
    assert!(!transfer[0].accepted());
    assert_eq!(transfer[0].inclusion.l1_block_number, 102);
    let following = handle
        .get_receipt(ReceiptQuery::tx_id(a_account_id()))
        .unwrap();
    assert_eq!(following.len(), 1);
    assert_eq!(following[0].inclusion.l1_block_number, 103);
    assert_eq!(handle.status().unwrap().latest_block, 3);
    assert_eq!(inner.lock().unwrap().state.output_count(), 0);
    Ok(())
}

/// During catch-up the L1 finalized tag may run ahead of the derived head.
/// Pruning is clamped to the head so its savepoint and block-hash trail remain.
#[tokio::test]
async fn catch_up_prune_keeps_head_savepoint_and_hash() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    // L1 latest == finalized == 103, but derive only through block 101.
    write_branch_a(&chain, &e, 103);
    let tmp = tempfile::tempdir()?;
    let inner = fresh_node(&tmp.path().join("state.redb"));
    let follower = Follower::new(MockTransport::client(chain.clone()), GENESIS);

    pcash_node::run_follow(
        inner.clone(),
        follower,
        YesVerify,
        Some(101),
        std::time::Duration::from_millis(10),
        beacon(),
        None,
        Arc::new(NoopMetrics),
    )
    .await?;

    let mut g = inner.lock().unwrap();
    assert_eq!(
        g.latest_block(),
        1,
        "PCASH head is 1 while L1 finalized is 103"
    );
    // The head's block hash survives pruning.
    assert!(
        g.block_hashes.contains_key(&101),
        "head block hash must survive the catch-up prune"
    );
    // head_id() pins the canonical PCASH head.
    let id = g.head_id();
    assert_eq!(id.block_number, 1);
    assert_eq!(
        id.block_hash,
        g.state.block(1).unwrap().unwrap().hash,
        "head id must pin the canonical PCASH block-1 hash"
    );
    assert_ne!(
        id.block_hash,
        g.state.canonical_genesis_hash().unwrap(),
        "head id must not fall back to the genesis hash"
    );
    // The head savepoint survives, so rollback to the head still works.
    g.rollback_to(101)
        .expect("head savepoint must be restorable after the catch-up prune");
    Ok(())
}

/// A reorg that replaces the pcash genesis block itself must halt with a clear
/// "genesis" error, not decrement the walk-back cursor below genesis into
/// nonexistent-block fetches / a `u64` underflow. Here finalized == genesis ==
/// 100, so the finalized guard alone would not catch the sub-genesis walk.
#[tokio::test]
async fn reorg_below_genesis_halts_with_clear_error() -> eyre::Result<()> {
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    let tmp = tempfile::tempdir()?;

    // Branch A: genesis 100 and 101 (branch tag 0xAA); finalized == genesis.
    {
        let mut g = chain.lock().unwrap();
        g.finalized = 100;
        let (b100, r100) = inbox_block(
            100,
            bh(0xAA, 100),
            bh(0xAA, 99),
            sender(),
            framed_batch(&[account_transaction(0xc0)]),
            bh(0xf0, 100),
        );
        let (b101, r101) = inbox_block(
            101,
            bh(0xAA, 101),
            bh(0xAA, 100),
            sender(),
            framed_batch(&[account_transaction(0xc1)]),
            bh(0xf0, 101),
        );
        g.insert(b100, r100);
        g.insert(b101, r101);
        g.head = 101;
    }
    let cfg = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        GENESIS,
        bh(0xAA, GENESIS),
    );
    let inner = build_node(&tmp.path().join("state.redb"), &cfg).unwrap();
    let mut follower = Follower::new(MockTransport::client(chain.clone()), GENESIS);
    drive(&inner, &mut follower, &YesVerify).await?;

    // Branch B: replace genesis 100 and 101 (tag 0xBB) and extend to 102, so the
    // parent-hash discontinuity is detected at the head and the walk-back must
    // descend through the reorged genesis and off the bottom of the trail.
    {
        let mut g = chain.lock().unwrap();
        *g = ChainModel::default();
        g.finalized = 100;
        let (b100, r100) = inbox_block(
            100,
            bh(0xBB, 100),
            bh(0xBB, 99),
            sender(),
            framed_batch(&[account_transaction(0xd0)]),
            bh(0xf2, 100),
        );
        let (b101, r101) = inbox_block(
            101,
            bh(0xBB, 101),
            bh(0xBB, 100),
            sender(),
            framed_batch(&[account_transaction(0xd1)]),
            bh(0xf2, 101),
        );
        let (b102, r102) = inbox_block(
            102,
            bh(0xBB, 102),
            bh(0xBB, 101),
            sender(),
            framed_batch(&[account_transaction(0xd2)]),
            bh(0xf2, 102),
        );
        g.insert(b100, r100);
        g.insert(b101, r101);
        g.insert(b102, r102);
        g.head = 102;
    }
    let err = drive(&inner, &mut follower, &YesVerify)
        .await
        .expect_err("a reorg through the pcash genesis block must be fatal");
    assert!(
        err.to_string().contains("genesis"),
        "expected a genesis-bound halt, got: {err}"
    );
    Ok(())
}

/// A node that reconciled `finalized` to 100, stalled, then observed the L1
/// `finalized` tag at 102 must keep the reconciled bound during reorg recovery.
/// The fork point (101) is above that bound with a live savepoint, so phase-2
/// recovery through the real `run_follow` must succeed.
#[tokio::test]
async fn finalized_tag_jump_across_stall_does_not_falsely_bound_reorg() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    let tmp = tempfile::tempdir()?;

    // Phase 1: branch A up to 103 with `finalized` reconciled to 100.
    write_branch_a(&chain, &e, 100);
    let inner = fresh_node(&tmp.path().join("state.redb"));
    let mut follower = Follower::new(MockTransport::client(chain.clone()), GENESIS);
    drive(&inner, &mut follower, &YesVerify).await?;
    assert_eq!(
        inner.lock().unwrap().l1_finalized,
        100,
        "reconciled finality is 100"
    );
    assert_eq!(inner.lock().unwrap().latest_block(), 3);

    // Phase 2: wake to branch B (fork at 101) with the observed tag jumped to 102.
    write_branch_b(&chain, &e);
    {
        chain.lock().unwrap().finalized = 102;
    }
    pcash_node::run_follow(
        inner.clone(),
        follower,
        YesVerify,
        Some(104),
        std::time::Duration::from_millis(10),
        beacon(),
        None,
        Arc::new(NoopMetrics),
    )
    .await?;

    // Recovery completed on branch B, byte-for-byte a clean derivation.
    let reorged_root = { inner.lock().unwrap().state.state_root().0 };
    let clean_root = clean_derivation_root(&chain).await?;
    assert_eq!(
        reorged_root, clean_root,
        "reorged state must equal a clean branch-B derivation"
    );
    assert_eq!(inner.lock().unwrap().latest_block(), 4);
    Ok(())
}

/// A replaced-branch receipt must never be reported finalized:
/// `l1_finalized` advances only behind the derived, parent-linked head.
#[tokio::test]
async fn replaced_branch_receipt_is_never_reported_finalized() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    let tmp = tempfile::tempdir()?;

    // Phase 1: branch A up to 103, `finalized` reconciled to 100. The branch-A
    // transfer sits at block 102 — above reconciled finality, so not yet final.
    write_branch_a(&chain, &e, 100);
    let inner = fresh_node(&tmp.path().join("state.redb"));
    let handle = NodeHandle::new(inner.clone());
    let mut follower = Follower::new(MockTransport::client(chain.clone()), GENESIS);
    drive(&inner, &mut follower, &YesVerify).await?;
    assert_eq!(handle.status().unwrap().finalized_block, 0);
    assert_eq!(
        handle
            .get_receipt(ReceiptQuery::tx_id(a_transfer_id()))
            .unwrap()
            .len(),
        1,
        "branch-A transfer indexed"
    );
    assert!(
        handle.status().unwrap().finalized_block < 2,
        "the branch-A transfer at block 102 must not yet be finalized"
    );

    // Phase 2: wake to branch B (fork at 101) with the observed tag jumped to 102.
    write_branch_b(&chain, &e);
    {
        chain.lock().unwrap().finalized = 102;
    }
    let result = pcash_node::run_follow(
        inner.clone(),
        follower,
        YesVerify,
        Some(104),
        std::time::Duration::from_millis(10),
        beacon(),
        None,
        Arc::new(NoopMetrics),
    )
    .await;

    // Finality safety holds on the resulting state regardless of outcome: any
    // still-present branch-A receipt must be above the reported finalized height.
    let status = handle.status().unwrap();
    let fin = status.finalized_l1_block_number;
    assert!(
        status.finalized_block <= status.latest_block,
        "finalized PCASH block must never exceed head"
    );
    for r in handle
        .get_receipt(ReceiptQuery::tx_id(a_transfer_id()))
        .unwrap()
    {
        assert!(
            r.inclusion.l1_block_number > fin,
            "replaced branch-A receipt at block {} reported finalized (finalized_block={})",
            r.inclusion.l1_block_number,
            fin
        );
    }

    // Recovery removes the branch-A transfer, and finality covers only canonical
    // branch-B blocks (block 102 == b_account0).
    result?;
    assert_eq!(handle.status().unwrap().latest_block, 4);
    assert_eq!(handle.status().unwrap().finalized_block, 2);
    assert!(
        handle
            .get_receipt(ReceiptQuery::tx_id(a_transfer_id()))
            .unwrap()
            .is_empty(),
        "replaced branch-A transfer receipt must be gone after recovery"
    );
    let b0 = handle
        .get_receipt(ReceiptQuery::tx_id(b_account0_id()))
        .unwrap();
    assert_eq!(b0.len(), 1, "canonical branch-B block-102 receipt present");
    assert!(
        b0[0].inclusion.l1_block_number <= handle.status().unwrap().finalized_l1_block_number,
        "canonical branch-B block-102 is now legitimately finalized"
    );
    Ok(())
}

// ===========================================================================
// Restart resume: reopen the DB at the persisted checkpoint.
// ===========================================================================

fn cfg() -> NetworkConfig {
    NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        GENESIS,
        bh(0, GENESIS),
    )
}

/// The fork schedule the crossover fixture compiles: one fork at
/// `FORK_ACTIVATION_TIMESTAMP` that retires user-account creation (type
/// `0x01`) and introduces no verifier.
fn forked_rules() -> pcash_derive::ProtocolRules {
    pcash_node::config::compiled_rules().with_fork(pcash_derive::ForkActivation {
        name: "retire user-account creation",
        activation_timestamp: FORK_ACTIVATION_TIMESTAMP,
        accepted_transaction_types: vec![
            KIND_PRIVATE_VALUE,
            pcash_derive::KIND_CONTRACT_ACCOUNT_CREATION,
            pcash_derive::KIND_USER_ACCOUNT_UPDATE,
        ],
        accepted_batch_versions: pcash_derive::BASE_BATCH_VERSIONS.to_vec(),
        hiding_kernel_vks: Vec::new(),
    })
}

#[tokio::test]
/// Frozen cold-replay fixture spanning the launch rule set into a fork that
/// retires user-account creation. The deterministic inputs and
/// accepted/skipped receipts are paired with fixed transaction, genesis,
/// state-root, and canonical-block known answers below; restart must reproduce
/// the same crossover tip before the replacement-branch assertions.
///
/// Covers, in one chain: activation at an exact timestamp; the same account
/// creation bytes admitted before the fork and excluded after it; restart from
/// a checkpoint written before the fork; historical replay of the forked block
/// under the rules of its own timestamp; and a reorg that replaces the first
/// forked block.
async fn cold_replay_restart_and_reorg_across_a_fork_boundary() -> eyre::Result<()> {
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    let tmp = tempfile::tempdir()?;
    let path = tmp.path().join("state.redb");

    // Derive genesis first so the H-1 transfer can reference its real PCASH block
    // hash rather than a test-only seeded history record.
    {
        let mut g = chain.lock().unwrap();
        g.finalized = GENESIS;
        let (block, receipts) = inbox_block(
            GENESIS,
            bh(0, GENESIS),
            bh(0, GENESIS - 1),
            sender(),
            framed_batch(&[account_transaction(0xc0)]),
            bh(0xf0, GENESIS),
        );
        g.insert(block, receipts);
        g.head = GENESIS;
    }
    let cold = pcash_node::build_node_with_rules(&path, &cfg(), forked_rules())?;
    let mut cold_follower = Follower::new(MockTransport::client(chain.clone()), GENESIS);
    drive(&cold, &mut cold_follower, &YesVerify).await?;
    let genesis_pcash_block_hash = cold.lock().unwrap().state.canonical_tip().unwrap().hash;
    // Before the fork the account creation is admitted and fails on its signature.
    let genesis_account_tx_id = inclusion_tx_id(bh(0, GENESIS));
    let genesis_account = NodeHandle::new(cold.clone())
        .get_receipt(ReceiptQuery::tx_id(genesis_account_tx_id))
        .unwrap();
    assert_eq!(genesis_account.len(), 1);
    assert!(!genesis_account[0].accepted());

    let v1_nul0 = nul(101);
    let v1_nul1 = nul(102);
    let v1_nullifiers = [
        fr_to_bytes(v1_nul0),
        fr_to_bytes(v1_nul1),
        fr_to_bytes(v1_nul0 + Fr::from(1_000_000u64)),
        fr_to_bytes(v1_nul1 + Fr::from(2_000_000u64)),
    ];
    let v1_transaction = transfer_transaction(
        v1_nul0,
        v1_nul1,
        genesis_pcash_block_hash,
        b"V1-env-0",
        b"V1-env-1",
        b"V1-env-2",
        b"V1-env-3",
        b"V1-env-4",
    );
    let v1_tx_id = inclusion_tx_id(bh(0, FORK_ACTIVATION_BLOCK - 1));

    // H-1 is finalized, making it the persisted restart checkpoint.
    {
        let mut g = chain.lock().unwrap();
        g.finalized = FORK_ACTIVATION_BLOCK - 1;
        let (block, receipts) = inbox_block(
            FORK_ACTIVATION_BLOCK - 1,
            bh(0, FORK_ACTIVATION_BLOCK - 1),
            bh(0, FORK_ACTIVATION_BLOCK - 2),
            sender(),
            framed_batch(std::slice::from_ref(&v1_transaction)),
            bh(0xf0, FORK_ACTIVATION_BLOCK - 1),
        );
        g.insert(block, receipts);
        g.head = FORK_ACTIVATION_BLOCK - 1;
    }
    drive(&cold, &mut cold_follower, &YesVerify).await?;
    assert_eq!(cold.lock().unwrap().l1_finalized, FORK_ACTIVATION_BLOCK - 1);

    let recent_pcash_block_hash = {
        let g = cold.lock().unwrap();
        g.state.canonical_tip().unwrap().hash
    };
    let a_nul0 = nul(201);
    let a_nul1 = nul(202);
    let a_nullifiers = [
        fr_to_bytes(a_nul0),
        fr_to_bytes(a_nul1),
        fr_to_bytes(a_nul0 + Fr::from(1_000_000u64)),
        fr_to_bytes(a_nul1 + Fr::from(2_000_000u64)),
    ];
    let a_transaction = transfer_transaction(
        a_nul0,
        a_nul1,
        recent_pcash_block_hash,
        b"FORK-A-0",
        b"FORK-A-1",
        b"FORK-A-2",
        b"FORK-A-3",
        b"FORK-A-4",
    );
    let a_tx_id = inclusion_tx_id(bh(0xaa, FORK_ACTIVATION_BLOCK));
    // The same creation bytes in the first forked block are excluded, so they
    // have no transaction result or receipt.
    let retired_account = account_transaction(0xc1);
    let retired_account_tx_id = pcash_state::transaction_id(bh(0xaa, FORK_ACTIVATION_BLOCK), 0, 1);

    {
        let mut g = chain.lock().unwrap();
        let (block, receipts) = inbox_block(
            FORK_ACTIVATION_BLOCK,
            bh(0xaa, FORK_ACTIVATION_BLOCK),
            bh(0, FORK_ACTIVATION_BLOCK - 1),
            sender(),
            framed_batch(&[a_transaction, retired_account]),
            bh(0xf1, FORK_ACTIVATION_BLOCK),
        );
        g.insert(block, receipts);
        g.head = FORK_ACTIVATION_BLOCK;
    }
    drive(&cold, &mut cold_follower, &YesVerify).await?;
    {
        let handle = NodeHandle::new(cold.clone());
        let status = handle.status().unwrap();
        let tip = handle
            .get_blocks(status.latest_block, status.latest_block, false)
            .unwrap()
            .into_iter()
            .next()
            .expect("crossover tip");
        assert_eq!(
            status.state_root,
            known_hash("1d9411dcc78c0c78f7ec6ad4e54d12d96ef57dd056c3dce0a25b9a7157000c81")
        );
        assert_eq!(
            tip.hash,
            known_hash("1ec008180cdd1b03d5b21993031731cf3f3ea4e5a306e51b9df6aebfffe39587")
        );
        assert_eq!(
            status.genesis_hash,
            known_hash("11fae261c2bb46b5efb193958daa94db52602917736fe4f30b748dcc10959144")
        );
        assert_eq!(
            v1_tx_id,
            known_hash("2be63971daa496a5940e594ef59e884c143dd50b3baccb9e3f182a5753cb82a8")
        );
        assert_eq!(
            a_tx_id,
            known_hash("1c1b0d82080b0b315470223a620f429c0732daed29c27501ad4c4a1aec7aee82")
        );
        let v1_receipts = handle.get_receipt(ReceiptQuery::tx_id(v1_tx_id)).unwrap();
        assert_eq!(v1_receipts.len(), 1);
        assert!(v1_receipts[0].accepted());
        assert_eq!(v1_receipts[0].outputs_added, 5);
        assert_eq!(v1_receipts[0].nullifiers, Some(v1_nullifiers.to_vec()));
        let a_receipts = handle.get_receipt(ReceiptQuery::tx_id(a_tx_id)).unwrap();
        assert_eq!(a_receipts.len(), 1);
        assert!(a_receipts[0].accepted());
        assert_eq!(a_receipts[0].outputs_added, 5);
        assert_eq!(a_receipts[0].nullifiers, Some(a_nullifiers.to_vec()));
        assert!(handle
            .get_receipt(ReceiptQuery::tx_id(retired_account_tx_id))
            .unwrap()
            .is_empty());
    }

    // Restart restores F = H-1 and trims the previously-derived H suffix.
    drop(cold_follower);
    drop(cold);
    let client = MockTransport::client(chain.clone());
    let StartPlan {
        inner,
        follower_start,
        anchor,
        ..
    } = pcash_node::resume_or_build_node_with_rules(&path, &cfg(), &client, forked_rules()).await?;
    catch_up_derived_index(&path, &inner).await?;
    assert_eq!(follower_start, FORK_ACTIVATION_BLOCK);
    assert_eq!(anchor, Some(bh(0, FORK_ACTIVATION_BLOCK - 1)));
    let handle = NodeHandle::new(inner.clone());
    assert_eq!(
        handle.status().unwrap().latest_block,
        FORK_ACTIVATION_BLOCK - 1 - GENESIS
    );
    assert_eq!(
        handle.status().unwrap().accepted_transaction_types,
        pcash_derive::BASE_TRANSACTION_TYPES
    );
    assert_eq!(
        handle
            .get_receipt(ReceiptQuery::tx_id(v1_tx_id))
            .unwrap()
            .len(),
        1
    );
    assert!(handle
        .get_receipt(ReceiptQuery::tx_id(a_tx_id))
        .unwrap()
        .is_empty());

    // Historical replay applies the fork's type set from block H, restoring the
    // transfer's receipt and accepted-nullifier indexes and excluding the
    // retired creation again.
    let mut follower = Follower::new(MockTransport::client(chain.clone()), follower_start);
    follower.rewind_to(follower_start, anchor);
    drive(&inner, &mut follower, &YesVerify).await?;
    assert_eq!(
        handle.status().unwrap().accepted_transaction_types,
        vec![0, 2, 3]
    );
    let a_receipts = handle.get_receipt(ReceiptQuery::tx_id(a_tx_id)).unwrap();
    assert_eq!(a_receipts.len(), 1);
    assert!(a_receipts[0].accepted());
    assert_eq!(a_receipts[0].outputs_added, 5);
    assert_eq!(a_receipts[0].nullifiers, Some(a_nullifiers.to_vec()));
    assert!(handle
        .get_receipt(ReceiptQuery::tx_id(retired_account_tx_id))
        .unwrap()
        .is_empty());
    for nullifier in a_nullifiers {
        assert_eq!(
            handle
                .get_receipt(ReceiptQuery::nullifier(nullifier))
                .unwrap()
                .into_iter()
                .next()
                .map(|receipt| receipt.tx_id),
            Some(a_tx_id)
        );
    }
    let replayed_status = handle.status().unwrap();
    let replayed_tip = handle
        .get_blocks(
            replayed_status.latest_block,
            replayed_status.latest_block,
            false,
        )
        .unwrap()
        .into_iter()
        .next()
        .expect("replayed crossover tip");
    assert_eq!(
        replayed_status.state_root,
        known_hash("1d9411dcc78c0c78f7ec6ad4e54d12d96ef57dd056c3dce0a25b9a7157000c81")
    );
    assert_eq!(
        replayed_tip.hash,
        known_hash("1ec008180cdd1b03d5b21993031731cf3f3ea4e5a306e51b9df6aebfffe39587")
    );

    let b_nul0 = nul(301);
    let b_nul1 = nul(302);
    let b_nullifiers = [
        fr_to_bytes(b_nul0),
        fr_to_bytes(b_nul1),
        fr_to_bytes(b_nul0 + Fr::from(1_000_000u64)),
        fr_to_bytes(b_nul1 + Fr::from(2_000_000u64)),
    ];
    let b_transaction = transfer_transaction(
        b_nul0,
        b_nul1,
        recent_pcash_block_hash,
        b"FORK-B-0",
        b"FORK-B-1",
        b"FORK-B-2",
        b"FORK-B-3",
        b"FORK-B-4",
    );
    let b_tx_id = inclusion_tx_id(bh(0xbb, FORK_ACTIVATION_BLOCK));

    // Replace H and extend one block so the follower observes the parent mismatch,
    // restores H-1, and replays the replacement post-fork branch.
    {
        let mut g = chain.lock().unwrap();
        g.truncate_above(FORK_ACTIVATION_BLOCK - 1);
        let (block_h, receipts_h) = inbox_block(
            FORK_ACTIVATION_BLOCK,
            bh(0xbb, FORK_ACTIVATION_BLOCK),
            bh(0, FORK_ACTIVATION_BLOCK - 1),
            sender(),
            framed_batch(std::slice::from_ref(&b_transaction)),
            bh(0xf2, FORK_ACTIVATION_BLOCK),
        );
        let (block_next, receipts_next) = inbox_block(
            FORK_ACTIVATION_BLOCK + 1,
            bh(0xbb, FORK_ACTIVATION_BLOCK + 1),
            bh(0xbb, FORK_ACTIVATION_BLOCK),
            sender(),
            framed_batch(&[account_transaction(0xc3)]),
            bh(0xf2, FORK_ACTIVATION_BLOCK + 1),
        );
        g.insert(block_h, receipts_h);
        g.insert(block_next, receipts_next);
        g.head = FORK_ACTIVATION_BLOCK + 1;
    }
    drive(&inner, &mut follower, &YesVerify).await?;

    let final_status = handle.status().unwrap();
    let final_tip = handle
        .get_blocks(final_status.latest_block, final_status.latest_block, false)
        .unwrap()
        .into_iter()
        .next()
        .expect("replacement tip");
    assert_eq!(
        final_status.state_root,
        known_hash("29b720410dfbe79c4d3f9284faeda0e542273916ff5938247062c92eb7b19daa")
    );
    assert_eq!(
        final_tip.hash,
        known_hash("20bb12b3802eed1aef9ac7f05f30d1dd423867d02dc24a230ca0fda360c8ff29")
    );
    assert_eq!(
        b_tx_id,
        known_hash("2993d50169cb95fb6acc8d371fee1b5fa8a48d3ec48bef784bb8cb71934f9e17")
    );

    assert_eq!(
        handle
            .get_receipt(ReceiptQuery::tx_id(v1_tx_id))
            .unwrap()
            .len(),
        1
    );
    for nullifier in v1_nullifiers {
        assert_eq!(
            handle
                .get_receipt(ReceiptQuery::nullifier(nullifier))
                .unwrap()
                .into_iter()
                .next()
                .map(|receipt| receipt.tx_id),
            Some(v1_tx_id)
        );
    }
    assert!(handle
        .get_receipt(ReceiptQuery::tx_id(a_tx_id))
        .unwrap()
        .is_empty());
    for nullifier in a_nullifiers {
        assert!(handle
            .get_receipt(ReceiptQuery::nullifier(nullifier))
            .unwrap()
            .is_empty());
    }
    let b_receipts = handle.get_receipt(ReceiptQuery::tx_id(b_tx_id)).unwrap();
    assert_eq!(b_receipts.len(), 1);
    assert!(b_receipts[0].accepted());
    assert_eq!(b_receipts[0].outputs_added, 5);
    assert_eq!(b_receipts[0].nullifiers, Some(b_nullifiers.to_vec()));
    for nullifier in b_nullifiers {
        assert_eq!(
            handle
                .get_receipt(ReceiptQuery::nullifier(nullifier))
                .unwrap()
                .into_iter()
                .next()
                .map(|receipt| receipt.tx_id),
            Some(b_tx_id)
        );
    }
    Ok(())
}

/// Build a linear (no-reorg) branch-0 chain `GENESIS..=to`. The block at
/// `transfer_at` carries the accepted branch-A transfer (emitting A-env-*); every
/// other block carries a skipped record — filler that advances history and
/// leaves the note/account state trees empty, keeping the transfer's empty-root
/// references in-window. Resets the model and sets `finalized`/`head`. Block
/// hashes are deterministic (`bh(0, n)`), so a later rebuild reproduces the exact
/// prefix a checkpoint validates against.
fn write_linear(
    chain: &Arc<Mutex<ChainModel>>,
    e: &Transactions,
    transfer_at: u64,
    to: u64,
    finalized: u64,
    head: u64,
) {
    let mut g = chain.lock().unwrap();
    *g = ChainModel::default();
    g.finalized = finalized;
    for n in GENESIS..=to {
        let calldata = if n == transfer_at {
            framed_batch(std::slice::from_ref(&e.a_transfer))
        } else {
            framed_batch(&[account_transaction(
                0xc0u8.wrapping_add((n - GENESIS) as u8),
            )])
        };
        let (b, r) = inbox_block(n, bh(0, n), bh(0, n - 1), sender(), calldata, bh(0xf0, n));
        g.insert(b, r);
    }
    g.head = head;
}

fn state_root(inner: &Arc<Mutex<NodeInner>>) -> B256 {
    inner.lock().unwrap().state.state_root().0
}

/// Every account change from genesis through `target`, in one page.
fn account_changes(
    handle: &NodeHandle,
    target: BlockId,
) -> Result<pcash_rpc::dto::AccountChangePageDto, IndexReadError> {
    handle.get_account_changes(AccountChangesRequest {
        from_block: 0,
        target,
        continuation: None,
        limits: AccountChangeLimits {
            max_changes: 10_000,
            max_bytes: 4 * 1024 * 1024,
        },
    })
}

fn wallet_outputs(handle: &NodeHandle, target_number: u64) -> Vec<(u64, Vec<u8>)> {
    wallet_outputs_from(handle, 0, target_number)
}

fn wallet_outputs_from(
    handle: &NodeHandle,
    from_output_index: u64,
    target_number: u64,
) -> Vec<(u64, Vec<u8>)> {
    let target = handle
        .get_block(target_number, false)
        .unwrap()
        .expect("wallet scan target must be canonical");
    handle
        .get_outputs(OutputRequest {
            from_output_index,
            target: BlockId {
                block_number: target.number,
                block_hash: target.hash,
            },
            continuation: None,
            limits: OutputLimits {
                max_outputs: 10_000,
                max_bytes: 4 * 1024 * 1024,
            },
        })
        .unwrap()
        .outputs
        .into_iter()
        .filter_map(|output| match output.material {
            pcash_rpc::OutputMaterialDto::Ordinary { output_data, .. } => {
                Some((output.output_index, output_data.to_vec()))
            }
            pcash_rpc::OutputMaterialDto::System { .. } => None,
        })
        .collect()
}

/// (a) Equivalence: derive to n, drop the node, reopen + resume, continue to m —
/// the state root, receipts, and wallet projection all equal a clean cold
/// derivation to m. Resume restores state to the finalized checkpoint F and
/// re-derives F+1..m.
#[tokio::test]
async fn resume_then_continue_matches_cold_derivation() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    let tmp = tempfile::tempdir()?;
    let path = tmp.path().join("state.redb");

    // Cold-derive to block 103 with finalized 101 (checkpoint lands at F = 101).
    write_linear(&chain, &e, 102, 103, 101, 103);
    let cold = fresh_node(&path);
    let mut f1 = Follower::new(MockTransport::client(chain.clone()), GENESIS);
    drive(&cold, &mut f1, &YesVerify).await?;
    assert_eq!(cold.lock().unwrap().l1_finalized, 101);
    // Close the node (release the redb file locks) with run-1 tables and
    // savepoints still on disk.
    drop(f1);
    drop(cold);

    // Extend the L1 chain to block 105 (same 100..103 prefix) and resume.
    write_linear(&chain, &e, 102, 105, 101, 105);
    let client = MockTransport::client(chain.clone());
    let StartPlan {
        inner,
        follower_start,
        anchor,
        ..
    } = resume_or_build_node(&path, &cfg(), &client).await?;
    catch_up_derived_index(&path, &inner).await?;
    assert_eq!(
        follower_start, 102,
        "resume must start the follower at F + 1"
    );
    assert_eq!(
        anchor,
        Some(bh(0, 101)),
        "resume anchors continuity on F's hash"
    );
    assert_eq!(inner.lock().unwrap().latest_block(), 1, "resumed head is F");

    // Continue to block 105.
    let mut f2 = Follower::new(MockTransport::client(chain.clone()), follower_start);
    if let Some(h) = anchor {
        f2.rewind_to(follower_start, Some(h));
    }
    drive(&inner, &mut f2, &YesVerify).await?;
    assert_eq!(inner.lock().unwrap().latest_block(), 5);

    // Clean baseline: a fresh cold derivation of the same chain to block 105.
    let clean = fresh_node(&tmp.path().join("clean.redb"));
    let mut f3 = Follower::new(MockTransport::client(chain.clone()), GENESIS);
    drive(&clean, &mut f3, &YesVerify).await?;

    assert_eq!(
        state_root(&inner),
        state_root(&clean),
        "resumed+continued state root must equal a clean derivation to m"
    );
    {
        let (g, gc) = (inner.lock().unwrap(), clean.lock().unwrap());
        assert_eq!(
            g.index.load_receipts_up_to(u64::MAX).unwrap(),
            gc.index.load_receipts_up_to(u64::MAX).unwrap(),
            "receipts must match the clean derivation"
        );
    }
    assert_eq!(
        wallet_outputs(&NodeHandle::new(inner.clone()), 5),
        wallet_outputs(&NodeHandle::new(clean.clone()), 5),
        "wallet projection must match the clean derivation"
    );
    let resumed_payouts =
        NodeHandle::new(inner.clone()).get_payouts(pcash_rpc::PayoutQuery::default())?;
    assert_eq!(resumed_payouts.records.len(), 1);
    assert_eq!(
        resumed_payouts,
        NodeHandle::new(clean.clone()).get_payouts(pcash_rpc::PayoutQuery::default())?,
        "payout records must match the clean derivation"
    );
    Ok(())
}

#[tokio::test]
async fn uncheckpointed_state_restarts_without_recreation() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    let tmp = tempfile::tempdir()?;
    let path = tmp.path().join("state.redb");
    write_linear(&chain, &e, 102, 102, 100, 102);
    let cold = fresh_node(&path);
    let client = MockTransport::client(chain.clone());
    for number in GENESIS..=102 {
        let block = client.block_data_by_number(number).await?;
        cold.lock().unwrap().apply_block(&block, &YesVerify)?;
    }
    let expected_root = state_root(&cold);
    drop(cold);
    assert!(pcash_state::RedbState::peek_checkpoint(&path)?.is_none());

    let client = MockTransport::client(chain);
    let StartPlan {
        inner,
        follower_start,
        anchor,
        ..
    } = resume_or_build_node(&path, &cfg(), &client).await?;
    catch_up_derived_index(&path, &inner).await?;
    assert_eq!(follower_start, 103);
    assert_eq!(anchor, Some(bh(0, 102)));
    assert_eq!(state_root(&inner), expected_root);
    assert_eq!(
        NodeHandle::new(inner)
            .get_receipt(ReceiptQuery::tx_id(inclusion_tx_id(bh(0, 102))))?
            .len(),
        1
    );
    Ok(())
}

/// Derive a transfer at L1 block 102, stop the node with its derived index one
/// block behind the canonical tip, and empty the L1 mock so nothing after the
/// stop can come from Ethereum. Returns the client, the tip, and its parent.
async fn stop_with_index_one_block_behind(
    e: &Transactions,
    path: &std::path::Path,
) -> eyre::Result<(
    L1Client,
    pcash_state::BlockSummary,
    pcash_state::PcashBlockMetadata,
)> {
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    write_linear(&chain, e, 102, 102, 100, 102);
    let node = fresh_node(path);
    let client = MockTransport::client(chain.clone());
    for number in GENESIS..=102 {
        let block = client.block_data_by_number(number).await?;
        node.lock().unwrap().apply_block(&block, &YesVerify)?;
    }
    let (tip, parent) = {
        let guard = node.lock().unwrap();
        let tip = guard.state.canonical_tip_summary().unwrap();
        let parent = guard
            .state
            .canonical_block_metadata(tip.number - 1)?
            .unwrap();
        guard.index.rewind_to(IndexBlockId {
            number: parent.header.number,
            hash: parent.hash,
        })?;
        (tip, parent)
    };
    drop(node);
    *chain.lock().unwrap() = ChainModel::default();
    Ok((client, tip, parent))
}

/// A crash between the canonical commit and its index write leaves the index
/// one block behind. Startup applies that block from stored canonical records
/// in place: the L1 chain serves nothing once the node restarts.
#[tokio::test]
async fn index_one_block_behind_catches_up_from_its_cursor_without_l1() -> eyre::Result<()> {
    use std::os::unix::fs::MetadataExt;

    let e = transactions().await?;
    let tmp = tempfile::tempdir()?;
    let path = tmp.path().join("state.redb");
    let index_path = tmp.path().join("state.index.redb");
    let (client, tip, parent) = stop_with_index_one_block_behind(&e, &path).await?;
    let index_file = std::fs::metadata(&index_path)?.ino();

    let StartPlan { inner, .. } = resume_or_build_node(&path, &cfg(), &client).await?;
    assert!(matches!(
        inner.lock().unwrap().index_lifecycle(),
        DerivedIndexLifecycle::CatchingUp { cursor: Some(cursor) }
            if cursor.pcash_number == parent.header.number && cursor.pcash_hash == parent.hash
    ));
    catch_up_derived_index(&path, &inner).await?;
    assert!(matches!(
        inner.lock().unwrap().index_lifecycle(),
        DerivedIndexLifecycle::Ready(cursor)
            if cursor.pcash_number == tip.number && cursor.pcash_hash == tip.hash
    ));
    assert_eq!(std::fs::metadata(&index_path)?.ino(), index_file);
    assert_eq!(
        NodeHandle::new(inner)
            .get_receipt(ReceiptQuery::tx_id(inclusion_tx_id(bh(0, 102))))?
            .len(),
        1
    );
    Ok(())
}

/// An apply failure leaves the index unavailable and preserves the failed
/// index file rather than retrying the whole history.
#[tokio::test]
async fn failed_catch_up_preserves_the_index_and_returns_the_error() -> eyre::Result<()> {
    use std::os::unix::fs::MetadataExt;

    let e = transactions().await?;
    let tmp = tempfile::tempdir()?;
    let path = tmp.path().join("state.redb");
    let index_path = tmp.path().join("state.index.redb");
    let (client, _, parent) = stop_with_index_one_block_behind(&e, &path).await?;
    {
        // A malformed transaction counter keeps the cursor readable and makes
        // the next apply fail.
        let index = redb::Database::open(&index_path)?;
        let write = index.begin_write()?;
        write
            .open_table(redb::TableDefinition::<&str, &[u8]>::new("meta"))?
            .insert("total_succeeded", [0u8; 3].as_slice())?;
        write.commit()?;
    }
    let index_file = std::fs::metadata(&index_path)?.ino();

    let StartPlan { inner, .. } = resume_or_build_node(&path, &cfg(), &client).await?;
    assert!(matches!(
        inner.lock().unwrap().index_lifecycle(),
        DerivedIndexLifecycle::CatchingUp { cursor: Some(cursor) }
            if cursor.pcash_number == parent.header.number && cursor.pcash_hash == parent.hash
    ));
    let error = catch_up_derived_index(&path, &inner).await.unwrap_err();
    assert!(error.to_string().contains("apply stored PCASH block"));
    assert!(matches!(
        inner.lock().unwrap().index_lifecycle(),
        DerivedIndexLifecycle::Unavailable
    ));
    assert_eq!(std::fs::metadata(&index_path)?.ino(), index_file);
    let cursor = inner.lock().unwrap().index.cursor()?.unwrap();
    assert_eq!(cursor.pcash_number, parent.header.number);
    assert_eq!(cursor.pcash_hash, parent.hash);
    assert_eq!(NodeHandle::new(inner).status()?.index.status, "unavailable");
    Ok(())
}

#[tokio::test]
async fn cancelled_index_catch_up_restarts_from_its_committed_cursor() -> eyre::Result<()> {
    let e = transactions().await?;
    let tmp = tempfile::tempdir()?;
    let path = tmp.path().join("state.redb");
    let (client, tip, _) = stop_with_index_one_block_behind(&e, &path).await?;
    let StartPlan { inner, .. } = resume_or_build_node(&path, &cfg(), &client).await?;
    inner
        .lock()
        .unwrap()
        .set_index_lifecycle(DerivedIndexLifecycle::Unavailable);

    let mut catch_up = Box::pin(catch_up_derived_index(&path, &inner));
    assert!(futures_util::poll!(&mut catch_up).is_pending());
    let cursor = inner.lock().unwrap().index.cursor()?.unwrap();
    assert_eq!(cursor.pcash_number, 0);
    assert!(cursor.pcash_number < tip.number);
    drop(catch_up);
    drop(inner);

    let StartPlan { inner, .. } = resume_or_build_node(&path, &cfg(), &client).await?;
    assert!(matches!(
        inner.lock().unwrap().index_lifecycle(),
        DerivedIndexLifecycle::CatchingUp { cursor: Some(resumed) } if resumed == cursor
    ));
    catch_up_derived_index(&path, &inner).await?;
    assert!(matches!(
        inner.lock().unwrap().index_lifecycle(),
        DerivedIndexLifecycle::Ready(cursor)
            if cursor.pcash_number == tip.number && cursor.pcash_hash == tip.hash
    ));
    assert_eq!(
        NodeHandle::new(inner)
            .get_receipt(ReceiptQuery::tx_id(inclusion_tx_id(bh(0, 102))))?
            .len(),
        1
    );
    Ok(())
}

/// Give L1 block `number`'s inbox transaction one receipt log.
fn add_receipt_log(chain: &Arc<Mutex<ChainModel>>, number: u64) {
    let mut model = chain.lock().unwrap();
    let ReceiptEnvelope::Legacy(receipt) = &mut model.receipts.get_mut(&number).unwrap()[0].inner
    else {
        panic!("fixture receipts are legacy receipts");
    };
    receipt.receipt.logs.push(alloy_rpc_types_eth::Log {
        inner: alloy_primitives::Log::new(
            sender(),
            vec![B256::repeat_byte(0x99)],
            Bytes::from(vec![1, 2, 3]),
        )
        .unwrap(),
        ..Default::default()
    });
}

alloy_sol_types::sol! {
    event PcashBatch(bytes context, bytes batch);
}

/// Give L1 block `number`'s transaction a carrier event from `emitter` that
/// delivers `batch`.
fn add_carrier_event(
    chain: &Arc<Mutex<ChainModel>>,
    number: u64,
    emitter: Address,
    batch: Vec<u8>,
) {
    use alloy_sol_types::SolEvent;
    let data = PcashBatch {
        context: Bytes::from_static(b"reorg"),
        batch: batch.into(),
    }
    .encode_data();
    let mut model = chain.lock().unwrap();
    let ReceiptEnvelope::Legacy(receipt) = &mut model.receipts.get_mut(&number).unwrap()[0].inner
    else {
        panic!("fixture receipts are legacy receipts");
    };
    receipt.receipt.logs.push(alloy_rpc_types_eth::Log {
        inner: alloy_primitives::Log::new(emitter, vec![PcashBatch::SIGNATURE_HASH], data.into())
            .unwrap(),
        ..Default::default()
    });
}

/// Follow the mock chain from L1 block `start` through `target`. A `start`
/// above genesis continues from its already derived parent.
async fn follow_from(
    inner: &Arc<Mutex<NodeInner>>,
    chain: &Arc<Mutex<ChainModel>>,
    start: u64,
    target: u64,
    metrics: Arc<dyn Metrics>,
) -> eyre::Result<()> {
    let mut follower = Follower::new(MockTransport::client(chain.clone()), start);
    if start > GENESIS {
        follower.rewind_to(start, Some(bh(0, start - 1)));
    }
    chain.lock().unwrap().head = target;
    pcash_node::run_follow(
        inner.clone(),
        follower,
        YesVerify,
        Some(target),
        Duration::from_millis(10),
        beacon(),
        None,
        metrics,
    )
    .await
}

/// A linear chain through L1 105 with its head at 102, whose blocks 104 and 105
/// each carry one receipt log.
fn chain_with_late_logs(e: &Transactions) -> Arc<Mutex<ChainModel>> {
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    write_linear(&chain, e, 102, 105, 100, 102);
    add_receipt_log(&chain, 104);
    add_receipt_log(&chain, 105);
    chain
}

/// Run index maintenance on the node until `pcash_status` reports its index
/// ready.
async fn maintain_until_ready(
    path: &std::path::Path,
    inner: &Arc<Mutex<NodeInner>>,
    metrics: &Arc<dyn Metrics>,
) -> eyre::Result<()> {
    let handle = NodeHandle::new(inner.clone());
    tokio::time::timeout(Duration::from_secs(30), async {
        tokio::select! {
            never = maintain_derived_index(Some(path), inner, metrics) => match never {},
            () = async {
                while handle.status().unwrap().index.status != "ready" {
                    tokio::task::yield_now().await;
                }
            } => {}
        }
    })
    .await?;
    Ok(())
}

/// One failed head write leaves the index behind and reported as such. The
/// retry catches it up from stored canonical data in place, and the head path
/// indexes again, all on the running node.
#[tokio::test]
async fn failed_index_write_is_retried_until_the_index_serves_later_blocks() -> eyre::Result<()> {
    use std::os::unix::fs::MetadataExt;

    let e = transactions().await?;
    let chain = chain_with_late_logs(&e);
    let tmp = tempfile::tempdir()?;
    let path = tmp.path().join("state.redb");
    let index_path = tmp.path().join("state.index.redb");
    let inner = fresh_node(&path);
    let handle = NodeHandle::new(inner.clone());
    let recorder = Arc::new(IndexMetrics::default());
    let metrics: Arc<dyn Metrics> = recorder.clone();

    follow_from(&inner, &chain, GENESIS, 102, metrics.clone()).await?;
    assert_eq!(handle.status()?.index.status, "ready");
    assert!(recorder.ready.load(Ordering::SeqCst));

    // The index loses its newest block behind the lifecycle's back, so the
    // write of the next block fails its parent check.
    {
        let node = inner.lock().unwrap();
        let parent = node.state.canonical_block_metadata(1)?.unwrap();
        node.index.rewind_to(IndexBlockId {
            number: parent.header.number,
            hash: parent.hash,
        })?;
    }
    let index_file = std::fs::metadata(&index_path)?.ino();
    follow_from(&inner, &chain, 103, 104, metrics.clone()).await?;

    let status = handle.status()?;
    assert_eq!(status.latest_l1_block_number, 104);
    assert_eq!(status.index.status, "unavailable");
    assert_eq!(status.index.cursor.unwrap().block_number, 1);
    assert!(!recorder.ready.load(Ordering::SeqCst));
    assert_eq!(recorder.write_failures.load(Ordering::SeqCst), 1);
    assert!(matches!(
        handle.get_l1_log_proof(status.latest_block_hash, 104, 0, 0),
        Err(IndexReadError::Unavailable(_))
    ));

    maintain_until_ready(&path, &inner, &metrics).await?;

    let status = handle.status()?;
    assert_eq!(
        status.index.cursor.unwrap().block_hash,
        status.latest_block_hash
    );
    assert!(recorder.ready.load(Ordering::SeqCst));
    assert_eq!(recorder.write_failures.load(Ordering::SeqCst), 1);
    assert_eq!(std::fs::metadata(&index_path)?.ino(), index_file);
    let proof = handle
        .get_l1_log_proof(status.latest_block_hash, 104, 0, 0)?
        .expect("the log derived while the index was behind");
    assert_eq!(proof.block.l1_block_hash, bh(0, 104));

    follow_from(&inner, &chain, 105, 105, metrics.clone()).await?;
    let status = handle.status()?;
    assert_eq!(status.latest_l1_block_number, 105);
    assert_eq!(status.index.status, "ready");
    assert_eq!(
        status.index.cursor.unwrap().block_hash,
        status.latest_block_hash
    );
    assert!(recorder.ready.load(Ordering::SeqCst));
    assert!(handle
        .get_l1_log_proof(status.latest_block_hash, 105, 0, 0)?
        .is_some());
    Ok(())
}

/// A storage failure on a head write leaves redb refusing every later write on
/// that handle while its cached cursor still reads. Recovery reopens the file
/// and continues from the cursor once the storage works again.
#[tokio::test]
async fn index_storage_failure_is_recovered_by_reopening_the_index() -> eyre::Result<()> {
    use std::os::unix::fs::MetadataExt;

    let e = transactions().await?;
    let chain = chain_with_late_logs(&e);
    let tmp = tempfile::tempdir()?;
    let path = tmp.path().join("state.redb");
    let index_path = tmp.path().join("state.index.redb");
    let inner = fresh_node(&path);
    let handle = NodeHandle::new(inner.clone());
    let recorder = Arc::new(IndexMetrics::default());
    let metrics: Arc<dyn Metrics> = recorder.clone();
    follow_from(&inner, &chain, GENESIS, 102, metrics.clone()).await?;

    let storage_fails = Arc::new(AtomicBool::new(false));
    pcash_node::reopen_index_with_backend(
        &mut inner.lock().unwrap(),
        FaultyBackend::open(&index_path, storage_fails.clone()),
    )?;
    let index_file = std::fs::metadata(&index_path)?.ino();
    storage_fails.store(true, Ordering::SeqCst);
    follow_from(&inner, &chain, 103, 104, metrics.clone()).await?;
    storage_fails.store(false, Ordering::SeqCst);

    // The storage works again, but the handle does not: it still reads its
    // cursor and refuses even a write that would change nothing.
    {
        let node = inner.lock().unwrap();
        let cursor = node.index.cursor()?.expect("cached index cursor");
        assert_eq!(cursor.pcash_number, 2);
        assert!(node
            .index
            .rewind_to(IndexBlockId {
                number: cursor.pcash_number,
                hash: cursor.pcash_hash,
            })
            .is_err());
    }
    let status = handle.status()?;
    assert_eq!(status.latest_l1_block_number, 104);
    assert_eq!(status.index.status, "unavailable");
    assert_eq!(recorder.write_failures.load(Ordering::SeqCst), 1);
    assert!(matches!(
        handle.get_l1_log_proof(status.latest_block_hash, 104, 0, 0),
        Err(IndexReadError::Unavailable(_))
    ));

    maintain_until_ready(&path, &inner, &metrics).await?;

    assert_eq!(recorder.write_failures.load(Ordering::SeqCst), 1);
    assert_eq!(std::fs::metadata(&index_path)?.ino(), index_file);
    let status = handle.status()?;
    assert_eq!(
        status.index.cursor.unwrap().block_hash,
        status.latest_block_hash
    );
    assert!(handle
        .get_l1_log_proof(status.latest_block_hash, 104, 0, 0)?
        .is_some());

    follow_from(&inner, &chain, 105, 105, metrics.clone()).await?;
    let status = handle.status()?;
    assert_eq!(status.index.status, "ready");
    assert!(handle
        .get_l1_log_proof(status.latest_block_hash, 105, 0, 0)?
        .is_some());
    Ok(())
}

/// A rollback between two catch-up blocks reaches the catch-up through the
/// lifecycle. Here it rewinds the index below the catch-up's cursor and hands
/// it back to the head path, so the suspended catch-up ends without applying
/// a block of the replaced branch or undoing the rollback's result.
#[tokio::test]
async fn rollback_between_catch_up_blocks_redirects_the_catch_up() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    write_linear(&chain, &e, 102, 104, 100, 104);
    let tmp = tempfile::tempdir()?;
    let path = tmp.path().join("state.redb");
    let inner = fresh_node(&path);
    let handle = NodeHandle::new(inner.clone());
    let mut follower = Follower::new(MockTransport::client(chain.clone()), GENESIS);
    drive(&inner, &mut follower, &YesVerify).await?;

    // The index falls back to block zero and is no longer ready.
    {
        let mut node = inner.lock().unwrap();
        let genesis = node.state.canonical_block_metadata(0)?.unwrap();
        node.index.rewind_to(IndexBlockId {
            number: 0,
            hash: genesis.hash,
        })?;
        node.set_index_lifecycle(DerivedIndexLifecycle::Unavailable);
    }
    let recorder = Arc::new(IndexMetrics::default());
    let metrics: Arc<dyn Metrics> = recorder.clone();
    let mut maintenance = Box::pin(maintain_derived_index(Some(&path), &inner, &metrics));
    let caught_up_through = || match inner.lock().unwrap().index_lifecycle() {
        DerivedIndexLifecycle::CatchingUp {
            cursor: Some(cursor),
        } => Some(cursor.pcash_number),
        _ => None,
    };

    // Each poll applies one stored block and yields.
    assert!(futures_util::poll!(&mut maintenance).is_pending());
    assert_eq!(caught_up_through(), Some(1));

    // The follower derives another block before the next one is applied.
    {
        let mut model = chain.lock().unwrap();
        let (block, receipts) = inbox_block(
            105,
            bh(0, 105),
            bh(0, 104),
            sender(),
            framed_batch(&[account_transaction(0xc5)]),
            bh(0xf0, 105),
        );
        model.insert(block, receipts);
        model.head = 105;
    }
    drive(&inner, &mut follower, &YesVerify).await?;
    assert!(futures_util::poll!(&mut maintenance).is_pending());
    assert_eq!(caught_up_through(), Some(2));
    assert_eq!(handle.status()?.latest_block, 5);

    // L1 replaces block 102 onward, below the catch-up's cursor. The rollback
    // rewinds the index to the fork point and the head path indexes the new
    // branch.
    {
        let mut model = chain.lock().unwrap();
        model.truncate_above(101);
        for number in 102..=106 {
            let parent = if number == 102 {
                bh(0, 101)
            } else {
                bh(1, number - 1)
            };
            let (block, receipts) = inbox_block(
                number,
                bh(1, number),
                parent,
                sender(),
                framed_batch(&[account_transaction(0xd0 + (number - GENESIS) as u8)]),
                bh(0xf1, number),
            );
            model.insert(block, receipts);
        }
        model.head = 106;
    }
    add_receipt_log(&chain, 105);
    drive(&inner, &mut follower, &YesVerify).await?;
    let status = handle.status()?;
    assert_eq!(status.latest_l1_block_hash, bh(1, 106));
    let followed_by_head = inner.lock().unwrap().index_lifecycle();
    assert!(matches!(
        followed_by_head,
        DerivedIndexLifecycle::Ready(cursor) if cursor.pcash_hash == status.latest_block_hash
    ));

    // The suspended catch-up reads that lifecycle, ends, and waits again.
    assert!(futures_util::poll!(&mut maintenance).is_pending());
    assert_eq!(inner.lock().unwrap().index_lifecycle(), followed_by_head);
    assert_eq!(handle.status()?.index.status, "ready");
    assert!(recorder.ready.load(Ordering::SeqCst));
    assert_eq!(recorder.write_failures.load(Ordering::SeqCst), 0);
    let proof = handle
        .get_l1_log_proof(status.latest_block_hash, 105, 0, 0)?
        .expect("a log on the canonical branch");
    assert_eq!(proof.block.l1_block_hash, bh(1, 105));
    Ok(())
}

/// An index that cannot catch up does not stop the node: canonical reads are
/// served and the catch-up is retried with a growing delay.
#[tokio::test(start_paused = true)]
async fn failing_index_catch_up_is_retried_while_canonical_reads_are_served() -> eyre::Result<()> {
    let e = transactions().await?;
    let tmp = tempfile::tempdir()?;
    let path = tmp.path().join("state.redb");
    let index_path = tmp.path().join("state.index.redb");
    let (client, tip, parent) = stop_with_index_one_block_behind(&e, &path).await?;
    {
        // A malformed transaction counter keeps the cursor readable and makes
        // every apply fail.
        let index = redb::Database::open(&index_path)?;
        let write = index.begin_write()?;
        write
            .open_table(redb::TableDefinition::<&str, &[u8]>::new("meta"))?
            .insert("total_succeeded", [0u8; 3].as_slice())?;
        write.commit()?;
    }

    let StartPlan { inner, .. } = resume_or_build_node(&path, &cfg(), &client).await?;
    let handle = NodeHandle::new(inner.clone());
    assert_eq!(handle.status()?.index.status, "catchingUp");

    let recorder = Arc::new(IndexMetrics::default());
    let metrics: Arc<dyn Metrics> = recorder.clone();
    // Attempts at 0s, 1s, and 3s; the next waits until 7s.
    let retrying = tokio::time::timeout(
        Duration::from_secs(5),
        maintain_derived_index(Some(&path), &inner, &metrics),
    )
    .await;
    assert!(retrying.is_err());
    assert_eq!(recorder.write_failures.load(Ordering::SeqCst), 3);
    assert!(!recorder.ready.load(Ordering::SeqCst));

    let status = handle.status()?;
    assert_eq!(status.latest_block, tip.number);
    assert_eq!(status.latest_block_hash, tip.hash);
    assert_eq!(status.index.status, "unavailable");
    assert_eq!(status.index.cursor.unwrap().block_hash, parent.hash);
    assert!(handle.get_block_header(BlockTag::Latest)?.is_some());
    assert!(handle.get_block(tip.number, true)?.is_some());
    Ok(())
}

/// (d) The persisted wallet projection remains available after resume before
/// any re-derivation. Here the transfer sits at block 101 and F = 102.
#[tokio::test]
async fn wallet_projection_before_restart_is_served_after_resume() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    let tmp = tempfile::tempdir()?;
    let path = tmp.path().join("state.redb");

    // Transfer at block 101 (<= F); finalized 102 so the checkpoint covers it.
    write_linear(&chain, &e, 101, 103, 102, 103);
    let cold = fresh_node(&path);
    let mut f1 = Follower::new(MockTransport::client(chain.clone()), GENESIS);
    drive(&cold, &mut f1, &YesVerify).await?;
    assert_eq!(cold.lock().unwrap().l1_finalized, 102);
    drop(f1);
    drop(cold);

    // Resume and immediately query — no forward derivation yet.
    let client = MockTransport::client(chain.clone());
    let StartPlan { inner, .. } = resume_or_build_node(&path, &cfg(), &client).await?;
    assert!(matches!(
        inner.lock().unwrap().index_lifecycle(),
        DerivedIndexLifecycle::Ready(_)
    ));
    catch_up_derived_index(&path, &inner).await?;
    assert!(matches!(
        inner.lock().unwrap().index_lifecycle(),
        DerivedIndexLifecycle::Ready(_)
    ));
    let handle = NodeHandle::new(inner.clone());
    let outputs = wallet_outputs(&handle, 2);
    let bytes: Vec<Vec<u8>> = outputs.into_iter().map(|(_, data)| data).collect();
    assert!(
        bytes.iter().any(|b| b == &common::output_data(b"A-env-0"))
            && bytes.iter().any(|b| b == &common::output_data(b"A-env-1")),
        "pre-restart outputs must be served from the persisted wallet projection"
    );
    assert_eq!(
        handle
            .get_receipt(ReceiptQuery::tx_id(inclusion_tx_id(bh(0, 101))))
            .unwrap()
            .len(),
        1
    );
    // Before any post-resume block is derived, status must report F's real header
    // timestamp, not zero — a zero latestBlockTimestamp sends
    // wallets' default validUntil to the Unix epoch and it expires on arrival.
    let status = handle.status().unwrap();
    assert_eq!(status.latest_block_timestamp, fixture_timestamp(102));
    assert_eq!(status.finalized_block_timestamp, fixture_timestamp(102));
    Ok(())
}

/// (b) A checkpoint whose finalized block no longer has the stored hash on L1
/// (deep reorg / wrong endpoint) fails closed and preserves the database. Only an
/// explicit force-resync authorizes an isolated replacement.
#[tokio::test]
async fn resume_hash_mismatch_at_f_fails_closed_unless_forced() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    let tmp = tempfile::tempdir()?;
    let path = tmp.path().join("state.redb");

    write_linear(&chain, &e, 102, 103, 101, 103);
    let cold = fresh_node(&path);
    let mut f1 = Follower::new(MockTransport::client(chain.clone()), GENESIS);
    drive(&cold, &mut f1, &YesVerify).await?;
    drop(f1);
    drop(cold);

    // Rewrite the checkpoint height and its suffix as one internally consistent
    // alternative chain.
    {
        let mut g = chain.lock().unwrap();
        g.truncate_above(100);
        for number in 101..=103 {
            let parent = if number == 101 {
                bh(0, 100)
            } else {
                bh(0xCC, number - 1)
            };
            let (block, receipts) = inbox_block(
                number,
                bh(0xCC, number),
                parent,
                sender(),
                framed_batch(&[account_transaction(0xc0 + (number - 100) as u8)]),
                bh(0xf9, number),
            );
            g.insert(block, receipts);
        }
        g.head = 103;
    }

    let checkpoint_before = pcash_state::RedbState::peek_checkpoint(&path)?.unwrap();
    let client = MockTransport::client(chain.clone());
    let error = match resume_or_build_node(&path, &cfg(), &client).await {
        Ok(_) => panic!("finalized hash mismatch must fail closed"),
        Err(error) => error,
    };
    let message = format!("{error:#}");
    assert!(
        message.contains("resume checkpoint L1 hash mismatch"),
        "unexpected startup error: {message}"
    );
    assert_eq!(
        pcash_state::RedbState::peek_checkpoint(&path)?.unwrap(),
        checkpoint_before,
        "failed validation must not replace the restart anchor"
    );

    let mut forced = resume_or_build_node_with_force_resync(&path, &cfg(), &client, true).await?;
    assert!(forced.anchor.is_none(), "forced recovery cold-starts");
    assert_eq!(forced.follower_start, GENESIS);
    assert_eq!(forced.replacement_target(), Some((103, bh(0xCC, 103))));
    assert!(
        forced.inner.lock().unwrap().head.is_none(),
        "forced recovery yields a fresh node"
    );
    pcash_node::run_follow(
        forced.inner.clone(),
        Follower::new(client.clone(), GENESIS),
        YesVerify,
        Some(103),
        std::time::Duration::from_millis(10),
        beacon(),
        None,
        Arc::new(NoopMetrics),
    )
    .await?;
    forced.promote_replacement()?;
    drop(forced);
    let replaced = pcash_state::RedbState::peek_checkpoint(&path)?.unwrap();
    assert_eq!(replaced.finalized_l1_hash, bh(0xCC, 101));
    assert_ne!(replaced, checkpoint_before);
    Ok(())
}

/// (c) A checkpoint written under a different derivation configuration (here a
/// different inbox) fails closed without wiping.
#[tokio::test]
async fn resume_changed_derivation_config_preserves_state() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    let tmp = tempfile::tempdir()?;
    let path = tmp.path().join("state.redb");

    write_linear(&chain, &e, 102, 103, 101, 103);
    let cold = fresh_node(&path);
    let mut f1 = Follower::new(MockTransport::client(chain.clone()), GENESIS);
    drive(&cold, &mut f1, &YesVerify).await?;
    drop(f1);
    drop(cold);

    // Resume with a different inbox → different derivation-config guard.
    let checkpoint_before = pcash_state::RedbState::peek_checkpoint(&path)?.unwrap();
    let other_inbox = Address::from([0x99u8; 20]);
    let mut cfg2 = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        GENESIS,
        bh(0, GENESIS),
    );
    cfg2.inbox = other_inbox;
    let client = MockTransport::client(chain.clone());
    let error = match resume_or_build_node(&path, &cfg2, &client).await {
        Ok(_) => panic!("derivation config mismatch must fail closed"),
        Err(error) => error,
    };
    let message = format!("{error:#}");
    assert!(
        message.contains("state database derivation source does not match the configured source"),
        "unexpected startup error: {message}"
    );
    assert_eq!(
        pcash_state::RedbState::peek_checkpoint(&path)?.unwrap(),
        checkpoint_before,
        "config mismatch must leave the checkpoint intact"
    );
    Ok(())
}

/// A transient/endpoint RPC failure while validating F is not evidence that the
/// finalized anchor is invalid. Startup must halt and preserve it for a retry.
#[tokio::test]
async fn resume_checkpoint_rpc_error_preserves_state() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    let tmp = tempfile::tempdir()?;
    let path = tmp.path().join("state.redb");

    write_linear(&chain, &e, 102, 103, 101, 103);
    let cold = fresh_node(&path);
    let mut follower = Follower::new(MockTransport::client(chain.clone()), GENESIS);
    drive(&cold, &mut follower, &YesVerify).await?;
    drop(follower);
    drop(cold);

    let checkpoint_before = pcash_state::RedbState::peek_checkpoint(&path)?.unwrap();
    // Make the checkpoint header unavailable. The provider returns `null`, which
    // the L1 client surfaces as BlockNotFound just like an unavailable RPC read.
    chain
        .lock()
        .unwrap()
        .blocks
        .remove(&checkpoint_before.finalized_l1_block);
    let client = MockTransport::client(chain.clone());
    let error = match resume_or_build_node(&path, &cfg(), &client).await {
        Ok(_) => panic!("checkpoint RPC failure must halt startup"),
        Err(error) => error,
    };
    let message = format!("{error:#}");
    assert!(
        message.contains("fetching L1 block 101 for resume checkpoint"),
        "unexpected startup error: {message}"
    );
    assert_eq!(
        pcash_state::RedbState::peek_checkpoint(&path)?.unwrap(),
        checkpoint_before,
        "RPC failure must preserve the checkpoint for a later retry"
    );
    Ok(())
}

/// (e) A reorg after resume restores correctly with the anchor at F: resume at F =
/// 101, re-derive branch A (102/103), then reorg to branch B (fork at 101 == F).
/// The walk-back restores the resume anchor at 101 and re-derives branch B.
#[tokio::test]
async fn reorg_after_resume_restores_with_anchor_at_f() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    let tmp = tempfile::tempdir()?;
    let path = tmp.path().join("state.redb");

    // Cold-derive branch A to 103 with finalized 101 (F = 101, the eventual fork).
    write_branch_a(&chain, &e, 101);
    let cold = fresh_node(&path);
    let mut f1 = Follower::new(MockTransport::client(chain.clone()), GENESIS);
    drive(&cold, &mut f1, &YesVerify).await?;
    assert_eq!(cold.lock().unwrap().l1_finalized, 101);
    drop(f1);
    drop(cold);

    // Resume on branch A and re-derive 102/103.
    let client = MockTransport::client(chain.clone());
    let StartPlan {
        inner,
        follower_start,
        anchor,
        ..
    } = resume_or_build_node(&path, &cfg(), &client).await?;
    assert_eq!(follower_start, 102);
    let mut follower = Follower::new(MockTransport::client(chain.clone()), follower_start);
    follower.rewind_to(follower_start, anchor);
    drive(&inner, &mut follower, &YesVerify).await?;
    assert_eq!(inner.lock().unwrap().latest_block(), 3);

    // Reorg to branch B (fork at 101 == F). The walk-back must restore the resume
    // anchor at 101 rather than treating the fork as fatal.
    write_branch_b(&chain, &e);
    drive(&inner, &mut follower, &YesVerify).await?;
    assert_eq!(
        inner.lock().unwrap().latest_block(),
        4,
        "recovery completes on branch B"
    );

    let clean = clean_derivation_root(&chain).await?;
    assert_eq!(
        state_root(&inner),
        clean,
        "reorged-after-resume state must equal a clean branch-B derivation"
    );
    Ok(())
}

// ===========================================================================
// L1 fetch shape and wallet projection.
// ===========================================================================

#[tokio::test(start_paused = true)]
async fn run_follow_recovers_exhausted_rpc_outages_without_skipping_blocks() -> eyre::Result<()> {
    let e = transactions().await?;
    let cases = [
        ("head", "eth_blockNumber", None, None, 103),
        (
            "finalized",
            "eth_getBlockByNumber",
            Some(serde_json::json!("finalized")),
            Some(false),
            103,
        ),
        (
            "serial",
            "eth_getBlockReceipts",
            Some(serde_json::json!(bh(0, 102).to_string())),
            None,
            103,
        ),
        (
            "first-window",
            "eth_getBlockReceipts",
            Some(serde_json::json!(bh(0, 110).to_string())),
            None,
            168,
        ),
        (
            "prefetch",
            "eth_getBlockReceipts",
            Some(serde_json::json!(bh(0, 140).to_string())),
            None,
            168,
        ),
    ];
    for (name, method, param, full, head) in cases {
        let chain = Arc::new(Mutex::new(ChainModel::default()));
        write_linear(&chain, &e, 102, head, 100, head);
        let tmp = tempfile::tempdir()?;
        let clean = fresh_node(&tmp.path().join("clean.redb"));
        let mut clean_follower = Follower::new(MockTransport::client(chain.clone()), GENESIS);
        drive(&clean, &mut clean_follower, &YesVerify).await?;
        chain.lock().unwrap().fault = Some(RpcFault::outage(method, param, full));
        let recovered = fresh_node(&tmp.path().join("recovered.redb"));
        tokio::time::timeout(
            std::time::Duration::from_mins(5),
            pcash_node::run_follow(
                recovered.clone(),
                Follower::new(MockTransport::client(chain.clone()), GENESIS),
                YesVerify,
                Some(head),
                std::time::Duration::from_millis(10),
                beacon(),
                None,
                Arc::new(NoopMetrics),
            ),
        )
        .await??;
        assert!(
            chain.lock().unwrap().fault.as_ref().unwrap().hits >= 13,
            "{name}: outage must exhaust the per-request retries"
        );
        assert_eq!(state_root(&recovered), state_root(&clean), "{name}");
        assert_eq!(
            NodeHandle::new(recovered.clone())
                .status()?
                .observed_l1_block_number,
            Some(head),
            "{name}"
        );
        let (actual, expected) = (recovered.lock().unwrap(), clean.lock().unwrap());
        assert_eq!(actual.head, expected.head, "{name}");
        assert_eq!(actual.l1_finalized, expected.l1_finalized, "{name}");
        assert_eq!(
            actual.index.load_receipts_up_to(u64::MAX)?,
            expected.index.load_receipts_up_to(u64::MAX)?,
            "{name}"
        );
    }
    Ok(())
}

#[tokio::test]
async fn run_follow_derives_through_refused_block_receipts() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    // Far enough behind the head that catch-up and the serial path both read.
    write_linear(&chain, &e, 120, 168, 110, 168);
    let expected = clean_derivation_root(&chain).await?;
    chain.lock().unwrap().refuse_block_receipts = true;
    let tmp = tempfile::tempdir()?;
    let inner = fresh_node(&tmp.path().join("state.redb"));
    pcash_node::run_follow(
        inner.clone(),
        Follower::new(MockTransport::client(chain.clone()), GENESIS),
        YesVerify,
        Some(168),
        Duration::from_millis(10),
        beacon(),
        None,
        Arc::new(NoopMetrics),
    )
    .await?;
    assert_eq!(state_root(&inner), expected);
    assert_eq!(inner.lock().unwrap().head, Some(168));
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn run_follow_retries_null_l1_responses() -> eyre::Result<()> {
    let e = transactions().await?;
    let cases = [
        (
            "block",
            "eth_getBlockByNumber",
            serde_json::json!("0x66"),
            Some(true),
        ),
        (
            "receipts",
            "eth_getBlockReceipts",
            serde_json::json!(bh(0, 102).to_string()),
            None,
        ),
        (
            "finalized",
            "eth_getBlockByNumber",
            serde_json::json!("finalized"),
            Some(false),
        ),
    ];
    for (name, method, param, full) in cases {
        let chain = Arc::new(Mutex::new(ChainModel::default()));
        write_linear(&chain, &e, 102, 103, 100, 103);
        let tmp = tempfile::tempdir()?;
        let clean = fresh_node(&tmp.path().join("clean.redb"));
        let mut clean_follower = Follower::new(MockTransport::client(chain.clone()), GENESIS);
        drive(&clean, &mut clean_follower, &YesVerify).await?;
        chain.lock().unwrap().fault = Some(RpcFault::null_once(method, param, full));
        let recovered = fresh_node(&tmp.path().join("recovered.redb"));
        tokio::time::timeout(
            std::time::Duration::from_mins(5),
            pcash_node::run_follow(
                recovered.clone(),
                Follower::new(MockTransport::client(chain.clone()), GENESIS),
                YesVerify,
                Some(103),
                std::time::Duration::from_millis(10),
                beacon(),
                None,
                Arc::new(NoopMetrics),
            ),
        )
        .await??;
        assert_eq!(
            chain.lock().unwrap().fault.as_ref().unwrap().hits,
            2,
            "{name}: one null, then the retried read"
        );
        assert_eq!(state_root(&recovered), state_root(&clean), "{name}");
        assert_eq!(
            recovered.lock().unwrap().head,
            clean.lock().unwrap().head,
            "{name}"
        );
    }
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn run_follow_recovers_rpc_outage_during_reorg_walkback() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    write_branch_a(&chain, &e, 100);
    let tmp = tempfile::tempdir()?;
    let inner = fresh_node(&tmp.path().join("state.redb"));
    let mut follower = Follower::new(MockTransport::client(chain.clone()), GENESIS);
    drive(&inner, &mut follower, &YesVerify).await?;
    write_branch_b(&chain, &e);
    {
        let mut model = chain.lock().unwrap();
        model.finalized = 102;
        model.fault = Some(RpcFault::outage(
            "eth_getBlockByNumber",
            Some(serde_json::json!("0x67")),
            Some(false),
        ));
    }
    tokio::time::timeout(
        std::time::Duration::from_mins(5),
        pcash_node::run_follow(
            inner.clone(),
            follower,
            YesVerify,
            Some(104),
            std::time::Duration::from_millis(10),
            beacon(),
            None,
            Arc::new(NoopMetrics),
        ),
    )
    .await??;
    assert!(chain.lock().unwrap().fault.as_ref().unwrap().hits >= 13);
    assert_eq!(state_root(&inner), clean_derivation_root(&chain).await?);
    assert_eq!(inner.lock().unwrap().latest_block(), 4);
    assert!(NodeHandle::new(inner)
        .get_receipt(ReceiptQuery::tx_id(a_transfer_id()))?
        .is_empty());
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn run_follow_stalls_without_advancing_state_during_persistent_outage() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    write_branch_a(&chain, &e, 100);
    let tmp = tempfile::tempdir()?;
    let inner = fresh_node(&tmp.path().join("state.redb"));
    let mut follower = Follower::new(MockTransport::client(chain.clone()), GENESIS);
    drive(&inner, &mut follower, &YesVerify).await?;
    assert_eq!(
        NodeHandle::new(inner.clone())
            .status()?
            .observed_l1_block_number,
        Some(103)
    );
    let initial_root = state_root(&inner);
    write_branch_b(&chain, &e);
    {
        let mut model = chain.lock().unwrap();
        model.finalized = 102;
        let mut fault = RpcFault::outage("eth_blockNumber", None, None);
        fault.remaining = u32::MAX;
        model.fault = Some(fault);
    }
    let result = tokio::time::timeout(
        std::time::Duration::from_mins(10),
        pcash_node::run_follow(
            inner.clone(),
            follower,
            YesVerify,
            Some(104),
            std::time::Duration::from_millis(10),
            beacon(),
            None,
            Arc::new(NoopMetrics),
        ),
    )
    .await;
    assert!(
        result.is_err(),
        "unavailable upstream must stall rather than stop the node"
    );
    assert!(chain.lock().unwrap().fault.as_ref().unwrap().hits > 11);
    assert_eq!(state_root(&inner), initial_root);
    let status = NodeHandle::new(inner.clone()).status()?;
    assert_eq!(status.observed_l1_block_number, None);
    assert_eq!(status.latest_l1_block_number, 103);
    let state = inner.lock().unwrap();
    assert_eq!(state.head, Some(103));
    assert_eq!(state.l1_finalized, 100);
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn run_follow_does_not_retry_malformed_rpc_response() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    write_branch_a(&chain, &e, 100);
    let mut fault = RpcFault::outage("eth_blockNumber", None, None);
    fault.malformed = true;
    chain.lock().unwrap().fault = Some(fault);
    let tmp = tempfile::tempdir()?;
    let inner = fresh_node(&tmp.path().join("state.redb"));
    let result = tokio::time::timeout(
        std::time::Duration::from_mins(5),
        pcash_node::run_follow(
            inner.clone(),
            Follower::new(MockTransport::client(chain.clone()), GENESIS),
            YesVerify,
            Some(103),
            std::time::Duration::from_millis(10),
            beacon(),
            None,
            Arc::new(NoopMetrics),
        ),
    )
    .await?;
    assert!(result.is_err(), "malformed RPC data must remain fatal");
    assert_eq!(chain.lock().unwrap().fault.as_ref().unwrap().hits, 1);
    assert!(inner.lock().unwrap().head.is_none());
    Ok(())
}

/// One unlabelled gauge from the metrics exposition.
fn gauge(metrics: &PrometheusMetrics, name: &str) -> u64 {
    let text = metrics.encode().unwrap();
    text.lines()
        .find_map(|line| line.strip_prefix(name)?.strip_prefix(' ')?.parse().ok())
        .unwrap_or_else(|| panic!("{name} is not exposed:\n{text}"))
}

/// The cause and block of a stalled derivation state.
fn stalled_at(state: DerivationDto) -> Option<(StallCause, u64)> {
    match state {
        DerivationDto::Stalled {
            cause,
            l1_block_number,
            ..
        } => Some((cause, l1_block_number)),
        _ => None,
    }
}

/// A stall at `stuck` on a chain written through `to`: one beside the head, and
/// one far enough behind it to take the catch-up pipeline.
const STALL_FIXTURES: [(u64, u64); 2] = [(102, 103), (110, 168)];

#[tokio::test(start_paused = true)]
async fn rpc_outage_reports_stalled_while_lag_keeps_advancing() -> eyre::Result<()> {
    let e = transactions().await?;
    for (stuck, to) in STALL_FIXTURES {
        let chain = Arc::new(Mutex::new(ChainModel::default()));
        write_linear(&chain, &e, 102, to, 100, to);
        // Only the stuck block's receipts are unreadable, so the head stays observable.
        let mut fault = RpcFault::outage(
            "eth_getBlockReceipts",
            Some(serde_json::json!(bh(0, stuck).to_string())),
            None,
        );
        fault.remaining = u32::MAX;
        chain.lock().unwrap().fault = Some(fault);
        let tmp = tempfile::tempdir()?;
        let inner = fresh_node(&tmp.path().join("state.redb"));
        let metrics = Arc::new(PrometheusMetrics::new());
        let follow = pcash_node::run_follow(
            inner.clone(),
            Follower::new(MockTransport::client(chain.clone()), GENESIS),
            YesVerify,
            Some(to),
            Duration::from_millis(10),
            beacon(),
            None,
            metrics.clone(),
        );
        tokio::pin!(follow);
        let handle = NodeHandle::new(inner.clone());

        assert!(tokio::time::timeout(Duration::from_mins(5), &mut follow)
            .await
            .is_err());
        let status = handle.status()?;
        let stalled = status.derivation;
        assert_eq!(
            stalled_at(stalled),
            Some((StallCause::L1Rpc, stuck)),
            "{stalled:?}"
        );
        assert_eq!(status.latest_l1_block_number, stuck - 1);
        assert_eq!(
            gauge(&metrics, "pcash_node_l1_lag_blocks"),
            to - (stuck - 1)
        );
        let text = metrics.encode().unwrap();
        assert!(
            text.contains(r#"pcash_node_derivation_state{state="stalled",cause="l1Rpc"} 1"#),
            "{text}"
        );
        assert!(
            text.contains(r#"pcash_node_derivation_state{state="following",cause=""} 0"#),
            "{text}"
        );

        chain.lock().unwrap().head = to + 7;
        assert!(tokio::time::timeout(Duration::from_mins(10), &mut follow)
            .await
            .is_err());
        assert_eq!(
            handle.status()?.derivation,
            stalled,
            "a retried stall keeps its block and start time"
        );
        assert_eq!(
            gauge(&metrics, "pcash_node_l1_lag_blocks"),
            to + 7 - (stuck - 1)
        );

        chain.lock().unwrap().fault = None;
        tokio::time::timeout(Duration::from_mins(5), &mut follow).await??;
        let resumed = handle.status()?.derivation;
        assert!(
            matches!(resumed, DerivationDto::Following { .. }),
            "{resumed:?}"
        );
    }
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn finality_read_outage_reports_stalled_while_lag_keeps_advancing() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    write_linear(&chain, &e, 102, 103, 100, 101);
    let tmp = tempfile::tempdir()?;
    let inner = fresh_node(&tmp.path().join("state.redb"));
    let metrics = Arc::new(PrometheusMetrics::new());
    let follow = pcash_node::run_follow(
        inner.clone(),
        Follower::new(MockTransport::client(chain.clone()), GENESIS),
        YesVerify,
        Some(103),
        Duration::from_millis(10),
        beacon(),
        None,
        metrics.clone(),
    );
    tokio::pin!(follow);
    let handle = NodeHandle::new(inner.clone());

    // Derive to the head at 101 before the finality read starts failing.
    assert!(tokio::time::timeout(Duration::from_secs(1), &mut follow)
        .await
        .is_err());
    assert_eq!(handle.status()?.latest_l1_block_number, 101);
    {
        let mut model = chain.lock().unwrap();
        model.head = 103;
        // The head read keeps answering; only the `finalized` tag does not.
        let mut fault = RpcFault::outage(
            "eth_getBlockByNumber",
            Some(serde_json::json!("finalized")),
            Some(false),
        );
        fault.remaining = u32::MAX;
        model.fault = Some(fault);
    }

    assert!(tokio::time::timeout(Duration::from_mins(5), &mut follow)
        .await
        .is_err());
    let status = handle.status()?;
    let stalled = status.derivation;
    assert_eq!(
        stalled_at(stalled),
        Some((StallCause::L1Rpc, 102)),
        "{stalled:?}"
    );
    assert_eq!(status.latest_l1_block_number, 101);
    assert_eq!(gauge(&metrics, "pcash_node_l1_lag_blocks"), 2);

    chain.lock().unwrap().head = 110;
    assert!(tokio::time::timeout(Duration::from_mins(10), &mut follow)
        .await
        .is_err());
    assert_eq!(
        handle.status()?.derivation,
        stalled,
        "a retried stall keeps its block and start time"
    );
    assert_eq!(gauge(&metrics, "pcash_node_l1_lag_blocks"), 9);
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn missing_blob_reports_stalled_while_lag_keeps_advancing() -> eyre::Result<()> {
    let e = transactions().await?;
    for (stuck, to) in STALL_FIXTURES {
        let chain = Arc::new(Mutex::new(ChainModel::default()));
        write_linear(&chain, &e, 102, to, 100, to);
        // The stuck block's timestamp is not on a slot boundary, so the test
        // beacon reports its blob unavailable without a network call.
        let mut versioned_hash = B256::repeat_byte(0x44);
        versioned_hash.0[0] = 1;
        let (carrier, receipt) = blob_inbox_block(
            stuck,
            bh(0, stuck),
            bh(0, stuck - 1),
            sender(),
            versioned_hash,
            bh(0xf1, stuck),
        );
        chain.lock().unwrap().insert(carrier, receipt);
        let tmp = tempfile::tempdir()?;
        let inner = fresh_node(&tmp.path().join("state.redb"));
        let metrics = Arc::new(PrometheusMetrics::new());
        let follow = pcash_node::run_follow(
            inner.clone(),
            Follower::new(MockTransport::client(chain.clone()), GENESIS),
            YesVerify,
            Some(to),
            Duration::from_secs(1),
            beacon(),
            None,
            metrics.clone(),
        );
        tokio::pin!(follow);
        let handle = NodeHandle::new(inner.clone());

        assert!(tokio::time::timeout(Duration::from_secs(5), &mut follow)
            .await
            .is_err());
        let status = handle.status()?;
        let stalled = status.derivation;
        assert_eq!(
            stalled_at(stalled),
            Some((StallCause::Blobs, stuck)),
            "{stalled:?}"
        );
        assert_eq!(status.latest_l1_block_number, stuck - 1);
        assert_eq!(
            gauge(&metrics, "pcash_node_l1_lag_blocks"),
            to - (stuck - 1)
        );

        chain.lock().unwrap().head = to + 7;
        assert!(tokio::time::timeout(Duration::from_secs(5), &mut follow)
            .await
            .is_err());
        assert_eq!(
            handle.status()?.derivation,
            stalled,
            "a retried stall keeps its block and start time"
        );
        assert_eq!(
            gauge(&metrics, "pcash_node_l1_lag_blocks"),
            to + 7 - (stuck - 1)
        );
    }
    Ok(())
}

/// A restart is how a halt is cleared, so a new follower must overwrite what the
/// previous process last reported for every state, not only the one it is in.
#[tokio::test]
async fn a_new_follower_zeroes_every_derivation_state_it_is_not_in() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    write_branch_a(&chain, &e, 100);
    let tmp = tempfile::tempdir()?;
    let inner = fresh_node(&tmp.path().join("state.redb"));
    let metrics = Arc::new(PrometheusMetrics::new());
    pcash_node::run_follow(
        inner.clone(),
        Follower::new(MockTransport::client(chain.clone()), GENESIS),
        YesVerify,
        Some(103),
        Duration::from_millis(10),
        beacon(),
        None,
        metrics.clone(),
    )
    .await?;

    let text = metrics.encode().unwrap();
    let expected = [
        (r#"{state="following",cause=""}"#, 1),
        (r#"{state="stalled",cause="l1Rpc"}"#, 0),
        (r#"{state="stalled",cause="blobs"}"#, 0),
        (r#"{state="halted",cause="verifier"}"#, 0),
        (r#"{state="halted",cause="storage"}"#, 0),
        (r#"{state="halted",cause="l1Input"}"#, 0),
        (r#"{state="halted",cause="internal"}"#, 0),
    ];
    for (labels, value) in expected {
        assert!(
            text.contains(&format!("pcash_node_derivation_state{labels} {value}\n")),
            "{labels}: {text}"
        );
    }
    assert_eq!(
        text.matches("pcash_node_derivation_state{").count(),
        expected.len(),
        "{text}"
    );
    Ok(())
}

/// A verifier that cannot give a verdict, which derivation must not guess past.
struct FailingVerify;
impl Verifier for FailingVerify {
    fn verify(&self, _: &[u8], _: &[u8], _: &[u8]) -> Result<bool, VerifyError> {
        Err(VerifyError::Abnormal {
            exit: "1".into(),
            stdout: String::new(),
            stderr: "verifier unavailable".into(),
        })
    }
}

/// The whole `pcash_status` response from a listener, on the real clock: the
/// request crosses a socket.
async fn status_over_http(address: std::net::SocketAddr) -> eyre::Result<serde_json::Value> {
    tokio::time::resume();
    Ok(reqwest::Client::new()
        .post(format!("http://{address}"))
        .json(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "pcash_status",
            "params": [],
        }))
        .send()
        .await?
        .json()
        .await?)
}

#[derive(Clone, Copy)]
enum StorageFailure {
    Commit,
    NullifierRead,
    AccountRead,
}

/// A canonical storage failure leaves the prior commit visible and reports the
/// failed block as a storage halt.
async fn assert_storage_halt(failure: StorageFailure) -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    write_linear(
        &chain,
        &e,
        if matches!(failure, StorageFailure::AccountRead) {
            103
        } else {
            102
        },
        103,
        100,
        101,
    );
    if matches!(failure, StorageFailure::AccountRead) {
        let creation = direct_account_transaction(e.recent_hash, L1_TIMESTAMP_BASE + GENESIS + 100);
        let (block, receipt) = inbox_block(
            102,
            bh(0, 102),
            bh(0, 101),
            sender(),
            framed_batch(&[creation]),
            bh(0xf0, 102),
        );
        chain.lock().unwrap().insert(block, receipt);
    }
    let tmp = tempfile::tempdir()?;
    let inner = fresh_node(&tmp.path().join("state.redb"));
    let api: Arc<dyn NodeApi> = Arc::new(NodeHandle::new(inner.clone()));
    let (address, _server) = pcash_rpc::serve("127.0.0.1:0".parse()?, api).await?;
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let held = pcash_node::follow_until_stopped(
        pcash_node::run_follow(
            inner.clone(),
            Follower::new(MockTransport::client(chain.clone()), GENESIS),
            YesVerify,
            None,
            Duration::from_millis(10),
            beacon(),
            None,
            Arc::new(NoopMetrics),
        ),
        stopped,
    );
    tokio::pin!(held);

    // Derive to the head at 101.
    assert!(tokio::time::timeout(Duration::from_secs(1), &mut held)
        .await
        .is_err());
    assert_eq!(inner.lock().unwrap().head, Some(101));

    {
        let node = inner.lock().unwrap();
        match failure {
            StorageFailure::Commit => {
                node.state.fail_next_persist();
                node.fail_canonical_reads.store(true, Ordering::Relaxed);
            }
            StorageFailure::NullifierRead | StorageFailure::AccountRead => {
                node.state.fail_next_state_db_read();
            }
        }
    }
    chain.lock().unwrap().head = 103;
    assert!(
        tokio::time::timeout(Duration::from_hours(1), &mut held)
            .await
            .is_err(),
        "a halted node keeps running until it is stopped"
    );

    let response = status_over_http(address).await?;
    let status = &response["result"];
    assert_eq!(status["latestL1BlockNumber"], "0x65", "{response}");
    assert_eq!(status["latestBlock"], "0x1", "{response}");
    let derivation = &status["derivation"];
    assert_eq!(derivation["state"], "halted", "{response}");
    assert_eq!(derivation["cause"], "storage", "{response}");
    assert_eq!(derivation["l1BlockNumber"], "0x66", "{response}");

    stop.send(()).unwrap();
    let error = held.await.unwrap_err();
    assert!(
        matches!(
            error.downcast_ref::<pcash_derive::DeriveError>(),
            Some(pcash_derive::DeriveError::State(_))
        ),
        "{error:#}"
    );
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn storage_halt_is_reported_when_the_canonical_store_cannot_be_read() -> eyre::Result<()> {
    assert_storage_halt(StorageFailure::Commit).await
}

#[tokio::test(start_paused = true)]
async fn nullifier_read_failure_during_execution_halts_as_storage() -> eyre::Result<()> {
    assert_storage_halt(StorageFailure::NullifierRead).await
}

#[tokio::test(start_paused = true)]
async fn account_read_failure_during_execution_halts_as_storage() -> eyre::Result<()> {
    assert_storage_halt(StorageFailure::AccountRead).await
}

#[tokio::test(start_paused = true)]
async fn fatal_error_reports_halted_and_rpc_keeps_answering() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    // Block 102 carries the one proof that reaches the verifier.
    write_branch_a(&chain, &e, 100);
    let tmp = tempfile::tempdir()?;
    let inner = fresh_node(&tmp.path().join("state.redb"));
    let api: Arc<dyn NodeApi> = Arc::new(NodeHandle::new(inner.clone()));
    let (address, _server) = pcash_rpc::serve("127.0.0.1:0".parse()?, api).await?;
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let held = pcash_node::follow_until_stopped(
        pcash_node::run_follow(
            inner.clone(),
            Follower::new(MockTransport::client(chain.clone()), GENESIS),
            FailingVerify,
            None,
            Duration::from_millis(10),
            beacon(),
            None,
            Arc::new(NoopMetrics),
        ),
        stopped,
    );
    tokio::pin!(held);
    assert!(
        tokio::time::timeout(Duration::from_hours(1), &mut held)
            .await
            .is_err(),
        "a halted node keeps running until it is stopped"
    );

    let response = status_over_http(address).await?;
    let status = &response["result"];
    assert_eq!(status["latestL1BlockNumber"], "0x65", "{response}");
    let derivation = &status["derivation"];
    assert_eq!(derivation["state"], "halted", "{response}");
    assert_eq!(derivation["cause"], "verifier", "{response}");
    assert_eq!(derivation["l1BlockNumber"], "0x66", "{response}");
    assert!(
        !response.to_string().contains("verifier unavailable"),
        "the raw error stays in the log: {response}"
    );

    stop.send(()).unwrap();
    let error = held.await.unwrap_err();
    assert!(
        error.downcast_ref::<pcash_derive::DeriveError>().is_some(),
        "{error:#}"
    );
    Ok(())
}

#[tokio::test]
async fn follower_refresh_retries_transient_rpc_failures() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    write_branch_a(&chain, &e, 100);
    {
        let mut g = chain.lock().unwrap();
        g.fail_next("eth_blockNumber");
        g.fail_next("eth_getBlockByNumber");
    }
    let (client, calls) = MockTransport::client_with_log(chain);
    let mut follower = Follower::new(client, GENESIS);

    follower.refresh().await?;

    assert_eq!(follower.head(), 103);
    assert_eq!(follower.finalized(), 100);
    let log = calls.lock().unwrap();
    assert_eq!(
        log.iter()
            .filter(|(method, _)| method == "eth_blockNumber")
            .count(),
        2
    );
    assert_eq!(
        log.iter()
            .filter(|(method, _)| method == "eth_getBlockByNumber")
            .count(),
        2
    );
    Ok(())
}

/// The finalized-tag read and reorg walk-back are
/// header/number calls, never full-body fetches. `finalized_block_number` and
/// `block_hash_by_number` both omit `.full()`, so every `eth_getBlockByNumber`
/// they issue carries `fullTransactions = false`.
#[tokio::test]
async fn finalized_and_walk_back_fetches_are_header_only() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    write_branch_a(&chain, &e, 100);
    let (client, calls) = MockTransport::client_with_log(chain.clone());

    // The walk-back primitive returns the right hash for the height...
    assert_eq!(client.block_hash_by_number(101).await?, bh(0, 101));
    // ...and the finalized read returns only the number.
    assert_eq!(client.finalized_block_number().await?, 100);

    let log = calls.lock().unwrap();
    let block_calls: Vec<_> = log
        .iter()
        .filter(|(m, _)| m == "eth_getBlockByNumber")
        .collect();
    assert!(!block_calls.is_empty(), "expected getBlockByNumber calls");
    assert!(
        block_calls.iter().all(|(_, full)| !*full),
        "header-only paths must not request full transaction bodies: {block_calls:?}"
    );
    Ok(())
}

/// A cold sync spanning more than two catch-up windows
/// fetches window N+1 while window N is still deriving, and reaches state
/// byte-for-byte identical to the serial (one-block-at-a-time) path — state
/// root, receipts, and wallet projection all match.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pipelined_catchup_matches_serial_derivation() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    // Genesis 100 .. head 168 (69 blocks) spans two full 32-block windows and a
    // five-block tail. The transfer in the first window activates the verifier
    // probe while the second window's RPC requests run on the other worker.
    write_linear(&chain, &e, 120, 168, 110, 168);
    let tmp = tempfile::tempdir()?;

    // Pipelined: run_follow drives one full window of background read-ahead.
    let piped = fresh_node(&tmp.path().join("piped.redb"));
    let (client, calls) = MockTransport::client_with_log(chain.clone());
    let follower = Follower::new(client, GENESIS);
    let saw_read_ahead = Arc::new(AtomicBool::new(false));
    pcash_node::run_follow(
        piped.clone(),
        follower,
        PrefetchProbeVerifier {
            calls,
            saw_read_ahead: saw_read_ahead.clone(),
        },
        Some(168),
        std::time::Duration::from_millis(10),
        beacon(),
        None,
        Arc::new(NoopMetrics),
    )
    .await?;
    assert!(
        saw_read_ahead.load(Ordering::Acquire),
        "catch-up must keep a full read-ahead window of fetches in flight during derive"
    );

    // Serial: drive() fetches one block at a time (the steady-state path).
    let serial = fresh_node(&tmp.path().join("serial.redb"));
    let mut f2 = Follower::new(MockTransport::client(chain.clone()), GENESIS);
    drive(&serial, &mut f2, &YesVerify).await?;

    assert_eq!(
        state_root(&piped),
        state_root(&serial),
        "pipelined catch-up state must equal serial derivation"
    );
    {
        let (gp, gs) = (piped.lock().unwrap(), serial.lock().unwrap());
        assert_eq!(gp.latest_block(), 68);
        assert_eq!(gp.l1_finalized, 110);
        assert_eq!(
            gp.index.load_receipts_up_to(u64::MAX).unwrap(),
            gs.index.load_receipts_up_to(u64::MAX).unwrap(),
            "receipts identical to serial"
        );
    }
    assert_eq!(
        wallet_outputs(&NodeHandle::new(piped.clone()), 68),
        wallet_outputs(&NodeHandle::new(serial.clone()), 68),
        "wallet projection identical to serial"
    );
    Ok(())
}

/// A bounded catch-up reads through the exact target, including a partial final
/// window, without issuing speculative block or receipt requests above it.
#[tokio::test]
async fn catchup_prefetch_stops_at_target() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    write_linear(&chain, &e, 120, 168, 110, 168);
    let tmp = tempfile::tempdir()?;
    let inner = fresh_node(&tmp.path().join("bounded.redb"));
    let (client, calls) = MockTransport::client_with_log(chain);

    pcash_node::run_follow(
        inner.clone(),
        Follower::new(client, GENESIS),
        YesVerify,
        Some(150),
        std::time::Duration::from_millis(10),
        beacon(),
        None,
        Arc::new(NoopMetrics),
    )
    .await?;

    assert_eq!(inner.lock().unwrap().latest_block(), 50);
    let calls = calls.lock().unwrap();
    let full_block_fetches = calls
        .iter()
        .filter(|(method, full)| method == "eth_getBlockByNumber" && *full)
        .count();
    let receipt_fetches = calls
        .iter()
        .filter(|(method, _)| method == "eth_getBlockReceipts")
        .count();
    assert_eq!(
        full_block_fetches, 51,
        "catch-up must fetch exactly blocks 100..=150"
    );
    assert_eq!(
        receipt_fetches, 51,
        "catch-up must fetch receipts exactly for blocks 100..=150"
    );
    Ok(())
}

/// Finalized wallet outputs remain in the canonical chronological projection.
#[tokio::test]
async fn finalized_wallet_outputs_remain_scannable() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    let tmp = tempfile::tempdir()?;

    // Transfer at 102; finalized 105; head 110.
    write_linear(&chain, &e, 102, 110, 105, 110);
    let inner = fresh_node(&tmp.path().join("state.redb"));
    let mut f = Follower::new(MockTransport::client(chain.clone()), GENESIS);
    drive(&inner, &mut f, &YesVerify).await?;
    let handle = NodeHandle::new(inner.clone());

    assert_eq!(inner.lock().unwrap().l1_finalized, 105);
    let full = wallet_outputs(&handle, 10);
    let bytes: Vec<Vec<u8>> = full.iter().map(|(_, data)| data.clone()).collect();
    assert!(
        bytes.iter().any(|b| b == &common::output_data(b"A-env-0"))
            && bytes.iter().any(|b| b == &common::output_data(b"A-env-1")),
        "finalized block-102 outputs must remain in the wallet projection"
    );
    // Absolute leaf indices survive finality and persistence.
    let mut leaves: Vec<u64> = full
        .iter()
        .filter(|(_, data)| {
            data.get(1..)
                .is_some_and(|bytes| bytes.starts_with(b"A-env"))
        })
        .map(|(leaf, _)| *leaf)
        .collect();
    leaves.sort_unstable();
    assert_eq!(leaves, vec![0, 1, 2, 3, 4]);
    Ok(())
}

#[tokio::test]
async fn canonical_rejections_resume_without_replaying_the_index() -> eyre::Result<()> {
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    let tmp = tempfile::tempdir()?;
    let path = tmp.path().join("state.redb");
    {
        let mut model = chain.lock().unwrap();
        model.finalized = GENESIS + 4;
        model.head = GENESIS + 4;
        for number in GENESIS..=GENESIS + 4 {
            let pcash_number = number - GENESIS;
            let timestamp = L1_TIMESTAMP_BASE
                .checked_add(pcash_number * (RECENT_PCASH_BLOCK_WINDOW_SECONDS + 1))
                .unwrap();
            let (block, receipts) = inbox_block_at_timestamp(
                number,
                timestamp,
                bh(0, number),
                bh(0, number - 1),
                sender(),
                framed_batch(&[account_transaction(0xd0u8.wrapping_add(pcash_number as u8))]),
                bh(0xf0, number),
            );
            model.insert(block, receipts);
        }
    }

    let inner = fresh_node(&path);
    let client = MockTransport::client(chain.clone());
    let mut follower = Follower::new(client.clone(), GENESIS);
    drive(&inner, &mut follower, &YesVerify).await?;
    {
        let node = inner.lock().unwrap();
        let retention = node
            .state
            .boundary_retention()
            .expect("canonical retention");
        assert_eq!(retention.oldest_contiguous, 0);
        assert_eq!(retention.tip, 4);
        assert!(node.state.committed_boundary(1)?.is_some());
        assert!(node.state.canonical_block(1)?.is_some());
    }
    drop(follower);
    drop(inner);

    let StartPlan { inner: resumed, .. } = resume_or_build_node(&path, &cfg(), &client).await?;
    {
        let node = resumed.lock().unwrap();
        assert_eq!(
            node.state.boundary_retention().unwrap().oldest_contiguous,
            0
        );
        assert!(matches!(
            node.index_lifecycle(),
            DerivedIndexLifecycle::Ready(_)
        ));
    }
    let handle = NodeHandle::new(resumed.clone());
    assert_eq!(handle.get_blocks(0, 4, false)?.len(), 5);
    assert!(handle.get_block(1, false)?.is_some());
    assert!(handle.get_block_header(BlockTag::Number(1))?.is_some());
    assert!(matches!(
        resumed.lock().unwrap().index_lifecycle(),
        DerivedIndexLifecycle::Ready(_)
    ));
    Ok(())
}

/// An output-tree cursor resumes encrypted-output discovery without a
/// server-side session and includes later unfinalized outputs. A cursor inside
/// a transaction resumes at that transaction's first output.
#[tokio::test]
async fn output_commitment_scan_resumes_from_explicit_index() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    let tmp = tempfile::tempdir()?;

    // Transfer at 108 (> finalized 105); head 110.
    write_linear(&chain, &e, 108, 110, 105, 110);
    let inner = fresh_node(&tmp.path().join("state.redb"));
    let mut f = Follower::new(MockTransport::client(chain.clone()), GENESIS);
    drive(&inner, &mut f, &YesVerify).await?;
    let handle = NodeHandle::new(inner.clone());

    assert_eq!(inner.lock().unwrap().l1_finalized, 105);
    let hot = wallet_outputs_from(&handle, 1, 10);
    assert_eq!(
        hot.iter().map(|(index, _)| *index).collect::<Vec<_>>(),
        (0..5).collect::<Vec<_>>()
    );
    assert_eq!(hot[0].1, common::output_data(b"A-env-0"));
    assert_eq!(hot[1].1, common::output_data(b"A-env-1"));
    let past = wallet_outputs_from(&handle, 5, 10);
    assert!(past
        .iter()
        .all(|(index, data)| *index >= 5 && data != &common::output_data(b"A-env-4")));
    Ok(())
}

#[tokio::test]
async fn rebuild_preserves_contract_and_account_update_nullifier_receipts() -> eyre::Result<()> {
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    let tmp = tempfile::tempdir()?;
    let path = tmp.path().join("state.redb");
    let inner = fresh_node(&path);
    let client = MockTransport::client(chain.clone());
    let mut follower = Follower::new(client.clone(), GENESIS);

    // Establish block zero, then create a real user account through direct L1
    // authorization so the following type-3 update has a live parent row.
    {
        let mut model = chain.lock().unwrap();
        let (block, receipts) = inbox_block(
            GENESIS,
            bh(0, GENESIS),
            bh(0, GENESIS - 1),
            sender(),
            framed_batch(&[account_transaction(0xd0)]),
            bh(0xf0, GENESIS),
        );
        model.insert(block, receipts);
        model.finalized = GENESIS;
        model.head = GENESIS;
    }
    drive(&inner, &mut follower, &YesVerify).await?;
    let genesis_pcash_hash = inner.lock().unwrap().state.canonical_tip().unwrap().hash;
    let user = addr(0x61);
    let deadline = L1_TIMESTAMP_BASE + GENESIS + 100;
    let creation = direct_account_transaction(genesis_pcash_hash, deadline);
    {
        let mut model = chain.lock().unwrap();
        let (block, receipts) = inbox_block(
            GENESIS + 1,
            bh(0, GENESIS + 1),
            bh(0, GENESIS),
            user,
            framed_batch(std::slice::from_ref(&creation)),
            bh(0xf0, GENESIS + 1),
        );
        model.insert(block, receipts);
        model.head = GENESIS + 1;
    }
    drive(&inner, &mut follower, &YesVerify).await?;

    let update_nul0 = nul(501);
    let update_nul1 = nul(502);
    let contract_nul0 = nul(503);
    let contract_nul1 = nul(504);
    let (recent, current) = {
        let node = inner.lock().unwrap();
        (
            node.state.canonical_tip().unwrap().hash,
            node.state
                .account_of(user)
                .expect("account read succeeds")
                .expect("direct account creation succeeds"),
        )
    };
    let new_rule_set = word(0x43);
    let update_action = pcash_derive::user_account_update_commitment(
        user,
        &current,
        field_element(new_rule_set),
        B256::ZERO,
    );
    let update = account_update_transaction(
        user,
        new_rule_set,
        update_action,
        account_action_section(update_nul0, update_nul1, recent, b"update-rebuild"),
    );
    let contract = contract_creation_transaction(account_action_section(
        contract_nul0,
        contract_nul1,
        recent,
        b"contract-rebuild",
    ));
    let designated_transfer = transfer_transaction(
        nul(505),
        nul(506),
        recent,
        b"designated-rebuild",
        b"designated-rebuild",
        b"designated-rebuild",
        b"designated-rebuild",
        b"designated-rebuild",
    );
    let open_transfer = open_transfer_transaction(nul(507), nul(508), recent, b"open-rebuild");
    let block_hash = bh(0, GENESIS + 2);
    {
        let mut model = chain.lock().unwrap();
        let (block, receipts) = inbox_block(
            GENESIS + 2,
            block_hash,
            bh(0, GENESIS + 1),
            sender(),
            framed_batch(&[
                update.clone(),
                contract.clone(),
                designated_transfer.clone(),
                open_transfer.clone(),
            ]),
            bh(0xf0, GENESIS + 2),
        );
        model.insert(block, receipts);
        model.head = GENESIS + 2;
    }
    drive(&inner, &mut follower, &YesVerify).await?;

    let update_id = pcash_state::transaction_id(block_hash, 0, 0);
    let contract_id = pcash_state::transaction_id(block_hash, 0, 1);
    let update_nullifiers = section_nullifiers(update_nul0, update_nul1);
    let contract_nullifiers = section_nullifiers(contract_nul0, contract_nul1);
    let handle = NodeHandle::new(inner.clone());
    for (tx_id, nullifiers) in [
        (update_id, update_nullifiers),
        (contract_id, contract_nullifiers),
    ] {
        let receipts = handle.get_receipt(ReceiptQuery::tx_id(tx_id))?;
        assert_eq!(receipts.len(), 1);
        assert!(receipts[0].accepted());
        assert_eq!(receipts[0].nullifiers, Some(nullifiers.to_vec()));
    }
    let transaction_ids = [update_id, contract_id]
        .into_iter()
        .chain(
            [&designated_transfer, &open_transfer]
                .into_iter()
                .zip(2u64..)
                .map(|(_, index)| pcash_state::transaction_id(block_hash, 0, index)),
        )
        .collect::<Vec<_>>();
    let payout_block = {
        let block = handle.get_block(2, false)?.expect("payout block");
        BlockId {
            block_number: block.number,
            block_hash: block.hash,
        }
    };
    let payout_snapshot = |handle: &NodeHandle| -> eyre::Result<_> {
        let receipts = transaction_ids
            .iter()
            .map(|tx_id| handle.get_receipt(ReceiptQuery::tx_id(*tx_id)))
            .collect::<Result<Vec<_>, _>>()?;
        Ok((
            receipts,
            handle.get_payouts(pcash_rpc::PayoutQuery::default())?,
            handle.get_block_payouts(payout_block)?,
        ))
    };
    let before = payout_snapshot(&handle)?;
    let payouts = &before.1.records;
    assert_eq!(payouts.len(), 2);
    assert!(matches!(
        payouts[0].payout.payout.source,
        pcash_state::PayoutSource::DesignatedIssuance { .. }
    ));
    assert!(matches!(
        payouts[1].payout.payout.source,
        pcash_state::PayoutSource::PosterPayout { .. }
    ));
    assert!(payouts.iter().all(|record| record.payout.payout.component
        == pcash_state::PayoutComponent::Issuance
        && !record.payout.payout.amount.is_zero()));
    assert_eq!(
        before.0[3][0].settled_issuance_amount,
        payouts[1].payout.payout.amount
    );
    assert!(before.0[..2]
        .iter()
        .all(|receipts| receipts[0].settled_issuance_amount.is_zero()));

    // Rebuild the index from stored records, then require every nullifier
    // lookup to resolve identically.
    inner
        .lock()
        .unwrap()
        .set_index_lifecycle(DerivedIndexLifecycle::Unavailable);
    catch_up_derived_index(&path, &inner).await?;
    assert!(matches!(
        inner.lock().unwrap().index_lifecycle(),
        DerivedIndexLifecycle::Ready(_)
    ));
    for (tx_id, nullifiers) in [
        (update_id, update_nullifiers),
        (contract_id, contract_nullifiers),
    ] {
        let receipts = handle.get_receipt(ReceiptQuery::tx_id(tx_id))?;
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].nullifiers, Some(nullifiers.to_vec()));
        for nullifier in nullifiers {
            let by_nullifier = handle.get_receipt(ReceiptQuery::nullifier(nullifier))?;
            assert_eq!(by_nullifier.len(), 1);
            assert_eq!(by_nullifier[0].tx_id, tx_id);
        }
    }
    assert_eq!(payout_snapshot(&handle)?, before);

    // The rebuilt output feed carries each section's nullifiers on its
    // slot-0 row.
    let sections = handle
        .get_outputs(OutputRequest {
            from_output_index: 0,
            target: payout_block,
            continuation: None,
            limits: OutputLimits {
                max_outputs: 10_000,
                max_bytes: 4 * 1024 * 1024,
            },
        })?
        .outputs
        .into_iter()
        .filter_map(|output| match output.material {
            pcash_rpc::OutputMaterialDto::Ordinary {
                output_slot: 0,
                transaction_id,
                nullifiers,
                ..
            } => Some((transaction_id, nullifiers)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        sections[..2],
        [
            (update_id, update_nullifiers.to_vec()),
            (contract_id, contract_nullifiers.to_vec()),
        ]
    );

    // The account feed lists the creation, the keep update, and the contract.
    let changes = account_changes(&handle, payout_block)?.changes;
    assert_eq!(
        changes
            .iter()
            .map(|change| (
                change.origin.block_number,
                change.account_revision,
                change.account_kind,
                change.receive_key.is_some(),
            ))
            .collect::<Vec<_>>(),
        vec![(1, 1, 0, false), (2, 2, 0, false), (2, 1, 1, false)]
    );
    assert_eq!(changes[0].address, user);
    assert_eq!(changes[1].address, user);
    assert_eq!(changes[1].account_index, changes[0].account_index);
    assert_eq!(changes[1].account_rule_set_commitment, new_rule_set);
    Ok(())
}

#[tokio::test]
async fn canonical_advancement_continues_while_index_awaits_rebuild() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    write_linear(&chain, &e, 102, 103, 100, 103);
    let tmp = tempfile::tempdir()?;
    let path = tmp.path().join("state.redb");
    let inner = fresh_node(&path);
    let client = MockTransport::client(chain.clone());
    let mut follower = Follower::new(client.clone(), GENESIS);
    drive(&inner, &mut follower, &YesVerify).await?;

    {
        let mut node = inner.lock().unwrap();
        let genesis = node.state.canonical_block(0)?.unwrap();
        let cursor = IndexBlockId {
            number: 0,
            hash: genesis.hash,
        };
        node.index.rewind_to(cursor)?;
        let rewound = node.index.cursor()?.expect("rewound index cursor");
        node.set_index_lifecycle(DerivedIndexLifecycle::Ready(rewound));
    }
    {
        let mut model = chain.lock().unwrap();
        let (block, receipts) = inbox_block(
            104,
            bh(0, 104),
            bh(0, 103),
            sender(),
            framed_batch(&[account_transaction(0xc4)]),
            bh(0xf0, 104),
        );
        model.insert(block, receipts);
        model.head = 104;
    }
    drive(&inner, &mut follower, &YesVerify).await?;
    let delivery_hash = {
        let node = inner.lock().unwrap();
        assert_eq!(node.head, Some(104));
        assert_eq!(
            node.index
                .cursor()?
                .expect("lagging index cursor")
                .pcash_number,
            0
        );
        assert!(matches!(
            node.index_lifecycle(),
            DerivedIndexLifecycle::Unavailable
        ));
        node.state
            .committed_boundary(2)?
            .and_then(|boundary| boundary.history.l1_delivery_batches.first().cloned())
            .expect("canonical L1 delivery manifest")
            .l1_transaction_hash
    };
    let handle = NodeHandle::new(inner.clone());
    let full_block = handle.get_block(2, true)?.expect("canonical full block");
    assert!(full_block
        .transaction_bytes
        .as_ref()
        .is_some_and(|transactions| !transactions.is_empty()));
    assert!(handle
        .get_block_payouts(BlockId {
            block_number: full_block.number,
            block_hash: full_block.hash,
        })?
        .is_some());
    assert!(handle
        .get_receipt(ReceiptQuery::tx_id(inclusion_tx_id(bh(0, 102))))?
        .is_empty());
    assert!(!deliveries(&handle, delivery_hash)?.is_empty());

    catch_up_derived_index(&path, &inner).await?;
    let leftovers: Vec<_> = std::fs::read_dir(tmp.path())?
        .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
        .collect::<Result<_, _>>()?;
    assert!(
        !leftovers.iter().any(|name| name.contains("index-rebuild")),
        "index replacement must not leave its scratch file, found {leftovers:?}"
    );
    let mut resumed_follower = Follower::new(client.clone(), 105);
    drive(&inner, &mut resumed_follower, &YesVerify).await?;
    assert_eq!(inner.lock().unwrap().head, Some(104));
    assert_eq!(
        handle
            .get_receipt(ReceiptQuery::tx_id(inclusion_tx_id(bh(0, 102))))?
            .len(),
        1
    );
    assert!(matches!(
        inner.lock().unwrap().index_lifecycle(),
        DerivedIndexLifecycle::Ready(_)
    ));
    let status = handle.status().unwrap();
    let as_of = BlockId {
        block_number: status.latest_block,
        block_hash: status.latest_block_hash,
    };
    let transactions = handle.get_transactions(TransactionsQuery {
        limit: Some(2),
        ..TransactionsQuery::default()
    })?;
    let first = transactions.items.first().expect("indexed transaction");
    let unrelated = ExplorerCursorDto {
        head: transactions.head,
        block_number: first.block.block_number,
        pcash_transaction_index: first.pcash_transaction_index,
    };
    assert!(matches!(
        handle.get_submission(SubmissionQuery {
            content_hash: B256::repeat_byte(0xdd),
            cursor: Some(unrelated),
            limit: Some(10),
        }),
        Err(IndexReadError::CursorMismatch)
    ));
    assert!(matches!(
        handle.get_account_history(AccountHistoryQuery {
            address: Address::repeat_byte(0xdd),
            cursor: Some(unrelated),
            limit: Some(10),
        }),
        Err(IndexReadError::CursorMismatch)
    ));
    assert!(matches!(
        handle.get_payouts(pcash_rpc::PayoutQuery {
            cursor: Some(pcash_rpc::PayoutCursorDto {
                anchor: BlockId {
                    block_number: as_of.block_number,
                    block_hash: B256::repeat_byte(0xee)
                },
                next_block: 0,
                next_payout_index: 0
            }),
            ..Default::default()
        }),
        Err(IndexReadError::CursorMismatch)
    ));
    Ok(())
}

#[tokio::test]
async fn block_number_fetch_uses_one_hash_receipt_request() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    write_linear(&chain, &e, 102, 103, 100, 103);
    let (client, calls) = MockTransport::client_with_log(chain);
    let block = client.block_data_by_number(102).await?;
    assert_eq!(block.header.hash, bh(0, 102));
    let receipt_fetches = calls
        .lock()
        .unwrap()
        .iter()
        .filter(|(method, _)| method == "eth_getBlockReceipts")
        .count();
    assert_eq!(receipt_fetches, 1);
    Ok(())
}

#[tokio::test]
async fn wrong_height_response_fails_before_catchup_hangs() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    // 81 blocks: longer than the 42-slot outstanding-work buffer.
    write_linear(&chain, &e, 120, 181, 110, 180);
    {
        let mut model = chain.lock().unwrap();
        model.serve_number_as = (GENESIS..=180).map(|n| (n, n + 1)).collect();
    }
    let tmp = tempfile::tempdir()?;
    let inner = fresh_node(&tmp.path().join("wrong-height.redb"));
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        pcash_node::run_follow(
            inner,
            Follower::new(MockTransport::client(chain), GENESIS),
            YesVerify,
            Some(180),
            Duration::from_millis(10),
            beacon(),
            None,
            Arc::new(NoopMetrics),
        ),
    )
    .await
    .expect("wrong-height L1 responses must error rather than hang the pipeline");
    let error = result.expect_err("wrong-height L1 block must be fatal");
    let mismatch = error.downcast_ref::<L1Error>();
    assert!(
        matches!(
            mismatch,
            Some(L1Error::BlockNumberMismatch { requested, got }) if *got == requested.saturating_add(1)
        ),
        "unexpected error: {error}"
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn abandoned_pipeline_cancels_inflight_rpcs() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    write_linear(&chain, &e, 120, 168, 110, 168);
    let (hold_tx, hold_rx) = tokio::sync::watch::channel(false);
    let in_flight;
    {
        let mut model = chain.lock().unwrap();
        in_flight = model.rpc_in_flight.clone();
        model.rpc_hold = Some(hold_rx);
    }

    for restart in 0..3 {
        let tmp = tempfile::tempdir()?;
        let inner = fresh_node(&tmp.path().join(format!("cancel-{restart}.redb")));
        let handle = tokio::spawn(pcash_node::run_follow(
            inner,
            Follower::new(MockTransport::client(chain.clone()), GENESIS),
            YesVerify,
            Some(168),
            Duration::from_millis(10),
            beacon(),
            None,
            Arc::new(NoopMetrics),
        ));
        let deadline = Instant::now() + Duration::from_secs(2);
        while in_flight.load(Ordering::SeqCst) < CATCHUP_FETCH_CONCURRENCY {
            assert!(
                Instant::now() <= deadline,
                "restart {restart}: expected {CATCHUP_FETCH_CONCURRENCY} held RPCs, in_flight={}",
                in_flight.load(Ordering::SeqCst)
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        handle.abort();
        let _ = handle.await;
        let deadline = Instant::now() + Duration::from_secs(2);
        while in_flight.load(Ordering::SeqCst) > 0 {
            assert!(
                Instant::now() <= deadline,
                "restart {restart}: abandoned fetches still in flight ({})",
                in_flight.load(Ordering::SeqCst)
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
    drop(hold_tx);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn catchup_downloads_at_most_its_fetch_concurrency() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    write_linear(&chain, &e, 120, 168, 110, 168);
    let (hold_tx, hold_rx) = tokio::sync::watch::channel(false);
    let in_flight = {
        let mut model = chain.lock().unwrap();
        model.rpc_hold = Some(hold_rx);
        model.rpc_in_flight.clone()
    };
    let tmp = tempfile::tempdir()?;
    let inner = fresh_node(&tmp.path().join("state.redb"));
    let follow = tokio::spawn(pcash_node::run_follow(
        inner.clone(),
        Follower::new(MockTransport::client(chain.clone()), GENESIS),
        YesVerify,
        Some(168),
        Duration::from_millis(10),
        beacon(),
        None,
        Arc::new(NoopMetrics),
    ));
    let deadline = Instant::now() + Duration::from_secs(2);
    while in_flight.load(Ordering::SeqCst) < CATCHUP_FETCH_CONCURRENCY {
        assert!(
            Instant::now() <= deadline,
            "expected {CATCHUP_FETCH_CONCURRENCY} held RPCs, in_flight={}",
            in_flight.load(Ordering::SeqCst)
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    // The inventory has room for every remaining block; only the fetch cap
    // holds the rest back.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(in_flight.load(Ordering::SeqCst), CATCHUP_FETCH_CONCURRENCY);

    hold_tx.send(true)?;
    tokio::time::timeout(Duration::from_secs(30), follow).await???;
    assert_eq!(state_root(&inner), clean_derivation_root(&chain).await?);
    Ok(())
}

/// A bounded follow whose last blocks are already L1-finalized must still
/// write a durable checkpoint before returning success. Resume restores that
/// checkpoint, so a partial None-commit group would otherwise rewind.
#[tokio::test]
async fn bounded_finalized_follow_checkpoints_before_success() -> eyre::Result<()> {
    let e = transactions().await?;
    let chain = Arc::new(Mutex::new(ChainModel::default()));
    write_linear(&chain, &e, 108, 110, 110, 110);
    let tmp = tempfile::tempdir()?;
    let path = tmp.path().join("partial-checkpoint.redb");
    let inner = fresh_node(&path);
    let client = MockTransport::client(chain.clone());
    pcash_node::run_follow(
        inner.clone(),
        Follower::new(client.clone(), GENESIS),
        YesVerify,
        Some(110),
        Duration::from_millis(10),
        beacon(),
        None,
        Arc::new(NoopMetrics),
    )
    .await?;
    assert_eq!(inner.lock().unwrap().latest_block(), 10);
    drop(inner);

    let StartPlan {
        inner: resumed,
        follower_start,
        ..
    } = resume_or_build_node(&path, &cfg(), &client).await?;
    assert_eq!(
        resumed.lock().unwrap().latest_block(),
        10,
        "resume must keep the bounded finalized suffix, not rewind to genesis"
    );
    assert_eq!(follower_start, 111);
    Ok(())
}
