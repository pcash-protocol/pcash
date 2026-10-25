#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]
mod common;

use common::{field_element, item_results, word, SUCCEEDED};

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use alloy_primitives::{keccak256, Address, Bytes, B256, U256};
use k256::ecdsa::SigningKey;
use pcash_derive::private_value_profiles::PrivateValueShape;
use pcash_derive::{
    eip712::account_signing_hash, user_account_update_commitment, AccountCreationAuthorization,
    ContractAccountCreation, ContractBody, ContractFunction, ContractFunding, PrivateValueSection,
    ReceiveKeyUpdate, Transaction, UserAccountCreation, UserAccountUpdate, WIRE_PROOF_BYTES,
};
use pcash_l1::{L1BlockData, L1Header, L1Receipt, L1Tx};
use pcash_metrics::{AdmissionOutcome, AdmissionSource, Metrics, PrometheusMetrics};
use pcash_node::{
    build_node, start_p2p, start_p2p_with_metrics, AdmissionPool, MempoolLimits, MempoolService,
    MempoolStatus, NetworkConfig, NodeHandle, NodeInner, DEFAULT_ADMISSION_QUEUE, DEFAULT_INBOX,
    L1_CHAIN_ID, PCASH_CHAIN_ID,
};
use pcash_p2p::{CandidateOrigin, InventoryEntry, Multiaddr, P2pConfig, P2pEvent, PeerInfo};
use pcash_rpc::{
    serve, AdminApi, BlockId, NodeApi, PrepareRelayRequest, ReceiptQuery, TransactionKind,
};
use pcash_state::{CircuitWord, StateDb};
use pcash_verify::BbProcessVerifier;
use serde_json::{json, Value};

struct TestNode {
    inner: Arc<Mutex<NodeInner>>,
    mempool: Arc<MempoolService>,
    admissions: Arc<PeerAdmissionRecorder>,
}

#[derive(Default)]
struct PeerAdmissionRecorder {
    invalid: AtomicUsize,
    state: AtomicUsize,
    policy: AtomicUsize,
}

impl Metrics for PeerAdmissionRecorder {
    fn record_mempool_admission(&self, source: AdmissionSource, outcome: AdmissionOutcome) {
        if source == AdmissionSource::P2p {
            match outcome {
                AdmissionOutcome::Invalid => {
                    self.invalid.fetch_add(1, Ordering::Relaxed);
                }
                AdmissionOutcome::State => {
                    self.state.fetch_add(1, Ordering::Relaxed);
                }
                AdmissionOutcome::Policy => {
                    self.policy.fetch_add(1, Ordering::Relaxed);
                }
                _ => {}
            }
        }
    }
}

fn open_test_node(root: &Path, config: &NetworkConfig) -> TestNode {
    open_test_node_with_verifier(
        root,
        config,
        BbProcessVerifier::new(root.join("unused-bb")),
        1_000,
    )
}

fn open_test_node_with_verifier(
    root: &Path,
    config: &NetworkConfig,
    verifier: BbProcessVerifier,
    genesis_timestamp: u64,
) -> TestNode {
    open_test_node_with_limits(
        root,
        config,
        vec![verifier],
        genesis_timestamp,
        MempoolLimits {
            accept_unpaid_registration: true,
            ..MempoolLimits::default()
        },
    )
}

fn open_test_node_with_limits(
    root: &Path,
    config: &NetworkConfig,
    verifiers: Vec<BbProcessVerifier>,
    genesis_timestamp: u64,
    limits: MempoolLimits,
) -> TestNode {
    let inner = build_node(&root.join("state.redb"), config).unwrap();
    let genesis_l1_hash = config.genesis_l1_block_hash;
    inner
        .lock()
        .unwrap()
        .apply_block(
            &L1BlockData::new(
                L1Header {
                    number: config.genesis_l1_block,
                    hash: genesis_l1_hash,
                    parent_hash: B256::ZERO,
                    timestamp: genesis_timestamp,
                },
                Vec::new(),
            ),
            &BbProcessVerifier::new(root.join("unused-bb")),
        )
        .unwrap();
    let admission = AdmissionPool::new(verifiers, DEFAULT_ADMISSION_QUEUE).unwrap();
    let admissions = Arc::new(PeerAdmissionRecorder::default());
    let mempool = MempoolService::open_with_metrics(
        inner.clone(),
        root.join("mempool.redb"),
        admission,
        limits,
        admissions.clone(),
    )
    .unwrap();
    TestNode {
        inner,
        mempool,
        admissions,
    }
}

fn p2p_config(
    root: &Path,
    capability: pcash_p2p::ForkCapability,
    bootstrap: Vec<Multiaddr>,
) -> P2pConfig {
    // Use the node's real fork capability so raw `pcash_p2p::start` peers stay
    // compatible after `start_p2p` refreshes its advertised capability from the
    // mempool (every inventory interval).
    P2pConfig {
        connectivity: pcash_p2p::ConnectivityConfig::disabled(),
        chain_id: capability.chain_id,
        genesis_hash: capability.genesis_hash,
        identity: pcash_p2p::load_or_create_identity(&root.join("p2p-identity.pb")).unwrap(),
        listen: "/ip4/127.0.0.1/tcp/0".parse().unwrap(),
        bootstrap,
        max_inventory: 1,
        anti_entropy_interval: Duration::from_millis(200),
        fork_capability: capability,
        peer_ban_duration: pcash_p2p::PEER_BAN_DURATION,
    }
}

fn node_capability(node: &TestNode) -> pcash_p2p::ForkCapability {
    node.mempool.fork_capability()
}

fn signer_address(signing_key: &SigningKey) -> Address {
    let point = signing_key.verifying_key().to_encoded_point(false);
    Address::from_slice(&keccak256(&point.as_bytes()[1..65]).as_slice()[12..])
}

/// A creation of the account [`signer_address`] recovers for the `0x31` key.
fn signed_account(node: &TestNode) -> Vec<u8> {
    let signing_key = SigningKey::from_slice(&[0x31; 32]).unwrap();
    let mut nullifier_key_commitment = CircuitWord::ZERO;
    nullifier_key_commitment.0[31] = 1;
    let rule_set = CircuitWord::ZERO;
    let (recent_pcash_block_hash, selected_timestamp, source) = {
        let guard = node.inner.lock().unwrap();
        let tip = guard.state.canonical_tip().unwrap();
        (
            tip.hash,
            tip.header.timestamp,
            guard.state.derivation_source(),
        )
    };
    let valid_until_timestamp = selected_timestamp + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let mut creation = UserAccountCreation::new(
        nullifier_key_commitment,
        rule_set,
        None,
        recent_pcash_block_hash,
        valid_until_timestamp,
        AccountCreationAuthorization::DirectL1,
    );
    let digest = account_signing_hash(&creation, &source);
    let (signature, recovery_id) = signing_key
        .sign_prehash_recoverable(digest.as_slice())
        .unwrap();

    creation.authorization = AccountCreationAuthorization::Eip712 {
        sig_r: CircuitWord::from_slice(&signature.r().to_bytes()),
        sig_s: CircuitWord::from_slice(&signature.s().to_bytes()),
        y_parity: recovery_id.is_y_odd(),
    };
    Transaction::UserAccountCreation(creation)
        .encode(PCASH_CHAIN_ID)
        .unwrap()
}

fn account_update(node: &TestNode, new_rule_set_commitment: CircuitWord) -> Vec<u8> {
    let signing_key = SigningKey::from_slice(&[0x31; 32]).unwrap();
    let address = signer_address(&signing_key);
    let (current, recent_pcash_block_hash, selected_timestamp) = {
        let guard = node.inner.lock().unwrap();
        let tip = guard.state.canonical_tip().unwrap();
        (
            guard.state.account_of(address).unwrap().unwrap(),
            tip.hash,
            tip.header.timestamp,
        )
    };
    let valid_until_timestamp = selected_timestamp + pcash_state::RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    let account_update_commitment = user_account_update_commitment(
        address,
        &current,
        field_element(new_rule_set_commitment),
        B256::ZERO,
    );
    // A zero-fee private-value section: the recent block first, distinct
    // nonzero nullifiers and bodies, the deadline and event commitment, and
    // fixed-size output data. The account update commitment is appended.
    let mut wire_inputs = vec![recent_pcash_block_hash];
    wire_inputs
        .extend((0..9u64).map(|slot| word(0x7700 + slot + u64::from(new_rule_set_commitment[31]))));
    // Open fee, issuance owner, notBeforeTimestamp, validUntilTimestamp,
    // carrierContextHash, eventsCommitment.
    wire_inputs.extend([
        CircuitWord::ZERO,
        CircuitWord::ZERO,
        CircuitWord::ZERO,
        word(valid_until_timestamp),
        CircuitWord::ZERO,
        CircuitWord::ZERO,
    ]);
    let section = PrivateValueSection::new(
        PrivateValueShape::S,
        PCASH_CHAIN_ID,
        &wire_inputs,
        vec![0x2au8; WIRE_PROOF_BYTES],
        vec![common::output_data(&[]); 5],
        common::arena(),
    )
    .unwrap();

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

fn frame_transaction(raw: &[u8]) -> Vec<u8> {
    pcash_derive::Batch {
        version: pcash_derive::BatchVersion::V1,
        poster_owner_commitment: field_element(word(1)),
        poster_context: word(0),
        items: vec![raw],
    }
    .encode()
    .unwrap()
}

/// A state-valid kind-0 transaction with the release-sized proof payload. The test bb
/// executable below accepts the inert proof bytes, keeping this test independent
/// of generated proving fixtures while still exercising the real verifier
/// process, P2P proof budget, admission, and exact wire encoding on both nodes.
fn proof_bearing_transfer(node: &TestNode, valid_until: u64) -> Vec<u8> {
    proof_bearing_transfer_with_nonce(node, valid_until, 0)
}

fn proof_bearing_transfer_with_nonce(node: &TestNode, valid_until: u64, nonce: u64) -> Vec<u8> {
    publication_proof_transfer(node, valid_until, nonce, 25, CircuitWord::ZERO)
}

fn publication_proof_transfer(
    node: &TestNode,
    valid_until: u64,
    nonce: u64,
    fee: u64,
    issuance_owner_commitment: CircuitWord,
) -> Vec<u8> {
    Transaction::PrivateValue(publication_proof_section(
        node,
        valid_until,
        nonce,
        fee,
        issuance_owner_commitment,
    ))
    .encode(PCASH_CHAIN_ID)
    .unwrap()
}

/// The S section of [`publication_proof_transfer`].
fn publication_proof_section(
    node: &TestNode,
    valid_until: u64,
    nonce: u64,
    fee: u64,
    issuance_owner_commitment: CircuitWord,
) -> PrivateValueSection {
    let recent_pcash_block_hash = {
        let guard = node.inner.lock().unwrap();
        guard.state.canonical_tip().unwrap().hash
    };
    let output_data0 = common::output_data(&[0x11, 0x22]);
    let output_data1 = common::output_data(&[0x33, 0x44]);
    let output_data2 = common::output_data(&[0x55, 0x66]);
    let output_data3 = common::output_data(&[0x77, 0x88]);
    let output_data4 = common::output_data(&[0x99, 0xaa]);
    let wire_inputs = [
        recent_pcash_block_hash,
        word(0x201 + nonce * 16),
        word(0x202 + nonce * 16),
        word(0x203 + nonce * 16),
        word(0x204 + nonce * 16),
        word(0x301 + nonce * 16),
        word(0x302 + nonce * 16),
        word(0x303 + nonce * 16),
        CircuitWord::ZERO,
        CircuitWord::ZERO,
        word(fee),
        issuance_owner_commitment,
        word(0), // immediately valid
        word(valid_until),
        CircuitWord::ZERO, // carrierContextHash
        CircuitWord::ZERO, // eventsCommitment
    ];

    PrivateValueSection::new(
        PrivateValueShape::S,
        PCASH_CHAIN_ID,
        &wire_inputs,
        vec![0x2au8; pcash_derive::WIRE_PROOF_BYTES],
        vec![
            output_data0,
            output_data1,
            output_data2,
            output_data3,
            output_data4,
        ],
        common::arena(),
    )
    .unwrap()
}

fn zero_open_fee_contract_creation(node: &TestNode, valid_until: u64, nonce: u64) -> Vec<u8> {
    let fee = publication_proof_section(node, valid_until, nonce, 0, CircuitWord::ZERO);
    // Publishes a nullifier-key commitment, not nkRoot; no receive key.
    let body = ContractBody::new(
        false,
        word(0x900 + nonce),
        None,
        vec![ContractFunction {
            selector: 0,
            application_vk_hash: word(0x52),
            configuration_commitment: word(0x53),
        }],
    )
    .unwrap();
    Transaction::ContractAccountCreation(ContractAccountCreation {
        body,
        funding: ContractFunding::Sponsored(fee),
    })
    .encode(PCASH_CHAIN_ID)
    .unwrap()
}

#[cfg(unix)]
fn framed_bb(root: &Path, accepted: bool) -> (PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;

    let path = root.join(if accepted {
        "accepting-bb"
    } else {
        "rejecting-bb"
    });
    let log = root.join("bb-verifications.log");
    let source = r#"#!/usr/bin/env python3
import os
import sys

LOG = "__LOG__"
ACCEPTED = __ACCEPTED__

def read_exact(count):
    data = b""
    while len(data) < count:
        chunk = sys.stdin.buffer.read(count - len(data))
        if not chunk:
            return None
        data += chunk
    return data

request_count = 0

def pack_string(value):
    data = value.encode("utf8")
    return bytes([0xa0 | len(data)]) + data

def pack_bin(value):
    return b"\xc4" + bytes([len(value)]) + value

def pack_array(values):
    prefix = bytes([0x90 | len(values)]) if len(values) < 16 else b"\xdc" + len(values).to_bytes(2, "big")
    return prefix + b"".join(values)

def pack_map(values):
    return bytes([0x80 | len(values)]) + b"".join(pack_string(k) + v for k, v in values)

def decompressed(payload):
    proof = None
    for length in (__PRIVATE_LENGTH__, __LARGE_LENGTH__, __ACCOUNT_LENGTH__):
        offset = len(payload) - length - 3
        if offset >= 0 and payload[offset] == 0xc5 and int.from_bytes(payload[offset + 1:offset + 3], "big") == length:
            proof = payload[-length:]
            break
    if proof is None:
        sys.exit(22)
    fields = [proof[index:index + 32] for index in range(0, min(__MAX_INPUT_BYTES__, len(proof)), 32)]
    chonk_proof = pack_map([
        ("hiding_oink_proof", pack_array([pack_bin(field) for field in fields])),
        ("merge_proof", pack_array([])),
        ("eccvm_proof", pack_array([])),
        ("ipa_proof", pack_array([])),
        ("joint_proof", pack_array([])),
    ])
    return b"\x92" + pack_string("ChonkDecompressProofResponse") + pack_map([("proof", chonk_proof)])

def verified(verdict):
    return b"\x92" + pack_string("ChonkVerifyResponse") + pack_map([("valid", b"\xc3" if verdict else b"\xc2")])

while True:
    prefix = read_exact(4)
    if prefix is None:
        break
    payload = read_exact(int.from_bytes(prefix, "little"))
    if payload is None:
        sys.exit(20)
    is_decompression = request_count % 2 == 0
    if request_count < __KNOWN_ANSWER_REQUESTS__:
        verdict = (request_count // 2) % 2 == 0
    else:
        verdict = ACCEPTED
        if not is_decompression:
            with open(LOG, "a", encoding="utf8") as handle:
                handle.write(f"verify {os.getpid()}\n")
    request_count += 1
    if not is_decompression and not verdict:
        # bb's own report is what makes a refusal a rejection.
        sys.stderr.write("ChonkVerifier: verification failed at ECCVM step\n")
        sys.stderr.flush()
    frame = decompressed(payload) if is_decompression else verified(verdict)
    sys.stdout.buffer.write(len(frame).to_bytes(4, "little") + frame)
    sys.stdout.buffer.flush()
"#
    .replace(
        "__KNOWN_ANSWER_REQUESTS__",
        &pcash_verify::STARTUP_KNOWN_ANSWER_REQUESTS.to_string(),
    )
    .replace("__PRIVATE_LENGTH__", &(pcash_derive::WIRE_PROOF_BYTES + pcash_derive::private_value_profiles::S.public_inputs * 32).to_string())
    .replace("__LARGE_LENGTH__", &(pcash_derive::WIRE_PROOF_BYTES + pcash_derive::private_value_profiles::L.public_inputs * 32).to_string())
    .replace("__MAX_INPUT_BYTES__", &(pcash_derive::private_value_profiles::L.public_inputs * 32).to_string())
    .replace("__ACCOUNT_LENGTH__", &(pcash_derive::WIRE_PROOF_BYTES + pcash_derive::USER_ACCOUNT_UPDATE_PUBLIC_INPUTS * 32).to_string())
    .replace("__LOG__", &log.to_string_lossy())
    .replace("__ACCEPTED__", if accepted { "True" } else { "False" });
    std::fs::write(&path, source).unwrap();
    let mut permissions = std::fs::metadata(&path).unwrap().permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&path, permissions).unwrap();
    (path, log)
}

#[cfg(unix)]
fn accepting_bb(root: &Path) -> (PathBuf, PathBuf) {
    framed_bb(root, true)
}

#[cfg(unix)]
fn rejecting_bb(root: &Path) -> (PathBuf, PathBuf) {
    framed_bb(root, false)
}

fn apply_account_block(node: &TestNode, raw: Vec<u8>, block_hash: B256) {
    apply_account_block_from(node, raw, block_hash, Address::repeat_byte(0x55));
}

fn apply_account_block_from(node: &TestNode, raw: Vec<u8>, block_hash: B256, sender: Address) {
    let (number, parent_hash) = {
        let guard = node.inner.lock().unwrap();
        let head = guard.head.unwrap();
        (head + 1, *guard.block_hashes.get(&head).unwrap())
    };
    let block = L1BlockData::new(
        L1Header {
            number,
            hash: block_hash,
            parent_hash,
            timestamp: 1_000,
        },
        vec![(
            L1Tx {
                hash: keccak256(&raw),
                from: sender,
                to: Some(DEFAULT_INBOX),
                input: Bytes::from(frame_transaction(&raw)),
                blob_versioned_hashes: Vec::new(),
                blob_resolution: pcash_l1::BlobResolution::Unresolved,
                tx_index: 0,
            },
            L1Receipt { logs: Vec::new() },
        )],
    );
    let verifier = BbProcessVerifier::new("unused-bb");
    let outcome = node
        .inner
        .lock()
        .unwrap()
        .apply_block(&block, &verifier)
        .unwrap();
    assert_eq!(item_results(&outcome), [SUCCEEDED]);
    node.mempool
        .on_applied_block(
            BlockId {
                block_number: outcome.committed_boundary.block.header.number,
                block_hash: outcome.committed_boundary.block.hash,
            },
            &[pcash_state::content_hash(&raw)],
            &outcome
                .transaction_effects
                .iter()
                .zip(&outcome.committed_boundary.block.transaction_bytes)
                .filter(|(_, raw)| {
                    raw[0] != pcash_derive::KIND_USER_ACCOUNT_CREATION
                        || raw[pcash_derive::transaction::ENVELOPE_BYTES] != 0
                })
                .filter_map(|(effects, _)| effects.accepted())
                .collect::<Vec<_>>(),
        )
        .unwrap();
}

fn bootstrap_address(address: Multiaddr, peer_id: pcash_p2p::PeerId) -> Multiaddr {
    format!("{address}/p2p/{peer_id}").parse().unwrap()
}

async fn wait_for_peer(node: &pcash_node::RunningP2p) {
    wait_for_peer_count(node, 1).await;
}

async fn wait_for_peer_count(node: &pcash_node::RunningP2p, expected: usize) {
    wait_for_handle_peer_count(&node.handle, expected).await;
}

async fn wait_for_compatible_peer(node: &pcash_node::RunningP2p) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if node.peers().iter().any(|peer| peer.compatible) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("compatible peer capability was not recorded");
}

async fn wait_for_entry(mempool: &MempoolService, content_hash: B256) {
    wait_for_entry_within(mempool, content_hash, Duration::from_secs(10)).await;
}

async fn wait_for_entry_within(mempool: &MempoolService, content_hash: B256, timeout: Duration) {
    tokio::time::timeout(timeout, async {
        loop {
            if mempool
                .transaction(&content_hash)
                .unwrap()
                .is_some_and(|entry| entry.status == "ready")
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("entry was not admitted");
}

async fn wait_for_raw_peer(handle: &pcash_p2p::P2pHandle) {
    wait_for_handle_peer_count(handle, 1).await;
}

async fn wait_for_handle_peer_count(handle: &pcash_p2p::P2pHandle, expected: usize) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if handle.peer_count() == expected {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("node did not reach {expected} connected peers"));
}

async fn wait_for_peer_info(
    handle: &pcash_p2p::P2pHandle,
    peer: pcash_p2p::PeerId,
    ready: impl Fn(&PeerInfo) -> bool,
) -> PeerInfo {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Some(info) = handle.peer(peer).filter(&ready) {
                return info;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("peer accounting did not update: {:?}", handle.peer(peer)))
}

async fn wait_for_peer_admission(counter: &AtomicUsize) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while counter.load(Ordering::Relaxed) == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("peer candidate did not reach the expected admission outcome");
}

async fn wait_for_raw_candidate(
    events: &mut tokio::sync::mpsc::Receiver<P2pEvent>,
) -> (Vec<u8>, CandidateOrigin) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(P2pEvent::Candidate { tx_bytes, origin }) = events.recv().await {
                return (tx_bytes, origin);
            }
        }
    })
    .await
    .expect("raw P2P candidate was not delivered")
}

async fn assert_no_raw_candidate(
    events: &mut tokio::sync::mpsc::Receiver<P2pEvent>,
    duration: Duration,
) {
    let candidate = tokio::time::timeout(duration, async {
        loop {
            match events.recv().await {
                Some(P2pEvent::Candidate { tx_bytes, .. }) => return Some(tx_bytes),
                Some(_) => {}
                None => return None,
            }
        }
    })
    .await;
    assert!(
        candidate.is_err(),
        "unexpected forwarded candidate: {candidate:?}"
    );
}

async fn rpc_call(client: &reqwest::Client, url: &str, method: &str, params: Value) -> Value {
    let response = client
        .post(url)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        }))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let body: Value = response.json().await.unwrap();
    assert!(body.get("error").is_none(), "RPC {method} failed: {body}");
    body.get("result")
        .cloned()
        .expect("RPC response has no result")
}

/// The JSON-RPC error object a call must return.
async fn rpc_call_error(client: &reqwest::Client, url: &str, method: &str, params: Value) -> Value {
    let body: Value = client
        .post(url)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    body.get("error")
        .cloned()
        .unwrap_or_else(|| panic!("RPC {method} succeeded: {body}"))
}

#[cfg(unix)]
async fn wait_for_verification_count(path: &Path, expected: usize) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let count =
                std::fs::read_to_string(path).map_or(0, |contents| contents.lines().count());
            if count == expected {
                return;
            }
            assert!(
                count < expected,
                "observed {count} verifications, expected {expected}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("verifier did not reach {expected} invocations"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn signed_account_gossips_and_late_peer_syncs_through_real_admission() {
    let root = tempfile::tempdir().unwrap();
    let genesis_l1_hash = B256::from([0xa5; 32]);
    let config = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        100,
        genesis_l1_hash,
    );

    let a_data = root.path().join("a");
    let b_data = root.path().join("b");
    let c_data = root.path().join("c");
    std::fs::create_dir_all(&a_data).unwrap();
    std::fs::create_dir_all(&b_data).unwrap();
    std::fs::create_dir_all(&c_data).unwrap();

    let a_node = open_test_node(&a_data, &config);
    let b_node = open_test_node(&b_data, &config);
    let c_node = open_test_node(&c_data, &config);

    let a_p2p = start_p2p(
        p2p_config(&a_data, node_capability(&a_node), Vec::new()),
        a_node.mempool.clone(),
    )
    .await
    .unwrap();
    let a_bootstrap = bootstrap_address(
        a_p2p.listen_address().await.unwrap(),
        a_p2p.handle.peer_id(),
    );
    let b_p2p = start_p2p(
        p2p_config(&b_data, node_capability(&b_node), vec![a_bootstrap.clone()]),
        b_node.mempool.clone(),
    )
    .await
    .unwrap();
    wait_for_peer(&a_p2p).await;
    wait_for_peer(&b_p2p).await;

    // Connection establishment precedes gossipsub mesh formation. Allow the
    // first heartbeat to exchange subscriptions before the one-shot RPC publish.
    tokio::time::sleep(Duration::from_millis(1_250)).await;
    let raw = signed_account(&a_node);
    let content_hash = pcash_state::content_hash(&raw);
    let a_api = NodeHandle::new(a_node.inner.clone())
        .with_mempool(a_node.mempool.clone())
        .with_p2p(a_p2p.handle.clone(), a_p2p.listen_addresses_watch());
    wait_for_compatible_peer(&a_p2p).await;
    // Per-peer compatibility moved off `pcash_status` onto the operator-only
    // admin surface, where it arrives with the rest of the peer's detail.
    assert!(AdminApi::peers(&a_api)
        .unwrap()
        .iter()
        .any(|peer| peer.compatible));
    let admitted = a_api.submit_raw_transaction(raw.clone()).await.unwrap();
    assert_eq!(admitted.content_hash, content_hash);
    assert_eq!(admitted.kind, TransactionKind::UserAccountCreation);
    assert_eq!(admitted.status, "ready");
    // Inventory snapshots refresh every five seconds. Requiring admission well
    // before that boundary makes this an actual gossip assertion rather than
    // an eventual-convergence assertion that could silently fall back to sync.
    wait_for_entry_within(&b_node.mempool, content_hash, Duration::from_secs(3)).await;

    // The owner loop periodically installs the admitted ready set as the
    // request/response inventory. C starts only after that real refresh, so its
    // admission path is inventory/get rather than receiving A's original gossip.
    tokio::time::sleep(Duration::from_millis(5_100)).await;
    let c_p2p = start_p2p(
        p2p_config(&c_data, node_capability(&c_node), vec![a_bootstrap]),
        c_node.mempool.clone(),
    )
    .await
    .unwrap();
    wait_for_peer(&c_p2p).await;
    wait_for_entry(&c_node.mempool, content_hash).await;

    let c_entry = c_node.mempool.transaction(&content_hash).unwrap().unwrap();
    assert_eq!(c_entry.raw_transaction, Some(raw.into()));

    c_p2p.handle.shutdown().await.unwrap();
    b_p2p.handle.shutdown().await.unwrap();
    a_p2p.handle.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn http_submission_gossips_to_peer_and_prepares_through_peer_rpc() {
    let root = tempfile::tempdir().unwrap();
    let genesis_l1_hash = B256::from([0xb5; 32]);
    let config = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        100,
        genesis_l1_hash,
    );
    let a_data = root.path().join("rpc-a");
    let b_data = root.path().join("rpc-b");
    std::fs::create_dir_all(&a_data).unwrap();
    std::fs::create_dir_all(&b_data).unwrap();
    let a_node = open_test_node(&a_data, &config);
    let b_node = open_test_node(&b_data, &config);
    let a_p2p = start_p2p(
        p2p_config(&a_data, node_capability(&a_node), Vec::new()),
        a_node.mempool.clone(),
    )
    .await
    .unwrap();
    let a_bootstrap = bootstrap_address(
        a_p2p.listen_address().await.unwrap(),
        a_p2p.handle.peer_id(),
    );
    let b_p2p = start_p2p(
        P2pConfig {
            bootstrap: vec![a_bootstrap],
            ..p2p_config(&b_data, node_capability(&b_node), Vec::new())
        },
        b_node.mempool.clone(),
    )
    .await
    .unwrap();
    wait_for_peer(&a_p2p).await;
    wait_for_peer(&b_p2p).await;
    tokio::time::sleep(Duration::from_millis(1_250)).await;

    let a_api: Arc<dyn NodeApi> = Arc::new(
        NodeHandle::new(a_node.inner.clone())
            .with_mempool(a_node.mempool.clone())
            .with_p2p(a_p2p.handle.clone(), a_p2p.listen_addresses_watch()),
    );
    let b_api: Arc<dyn NodeApi> = Arc::new(
        NodeHandle::new(b_node.inner.clone())
            .with_mempool(b_node.mempool.clone())
            .with_p2p(b_p2p.handle.clone(), b_p2p.listen_addresses_watch()),
    );
    let (a_rpc_addr, a_rpc) = serve("127.0.0.1:0".parse().unwrap(), a_api).await.unwrap();
    let (b_rpc_addr, b_rpc) = serve("127.0.0.1:0".parse().unwrap(), b_api).await.unwrap();
    let a_url = format!("http://{a_rpc_addr}");
    let b_url = format!("http://{b_rpc_addr}");
    let client = reqwest::Client::new();

    let raw = signed_account(&a_node);
    let content_hash = pcash_state::content_hash(&raw);
    let content_hash_hex = format!("0x{}", hex::encode(content_hash));
    let submitted = rpc_call(
        &client,
        &a_url,
        "pcash_submitRawTransaction",
        json!([format!("0x{}", hex::encode(&raw))]),
    )
    .await;
    assert_eq!(submitted["contentHash"], content_hash_hex);
    assert_eq!(submitted["kind"], "userAccountCreation");
    assert_eq!(submitted["status"], "ready");

    let peer_copy = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let result = rpc_call(
                &client,
                &b_url,
                "pcash_getMempoolTransaction",
                json!([content_hash_hex]),
            )
            .await;
            if !result.is_null() {
                return result;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("peer RPC did not expose the gossiped transaction");
    assert_eq!(
        peer_copy["rawTransaction"],
        format!("0x{}", hex::encode(&raw))
    );

    let expected_batch = frame_transaction(&raw);
    let prepared = rpc_call(
        &client,
        &b_url,
        "pcash_prepareRelay",
        json!([{
            "contentHashes": [content_hash_hex],
            "controlledIssuanceOwnerCommitments": [],
            "maxBatchBytes": format!("0x{:x}", expected_batch.len()),
        }]),
    )
    .await;
    assert_eq!(
        prepared["selectedContentHashes"],
        json!([format!("0x{}", hex::encode(content_hash))])
    );
    assert_eq!(
        prepared["selectedTransactions"],
        json!([format!("0x{}", hex::encode(&raw))])
    );

    a_rpc.stop().unwrap();
    b_rpc.stop().unwrap();
    b_p2p.handle.shutdown().await.unwrap();
    a_p2p.handle.shutdown().await.unwrap();
}

/// Type-0 issuance remains a public-pool paying class for either destination.
#[cfg(unix)]
#[tokio::test]
async fn designated_zero_fee_private_value_is_publicly_admitted() {
    let root = tempfile::tempdir().unwrap();
    let genesis_timestamp = 1_800_000_000;
    let config = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        100,
        B256::from([0xc7; 32]),
    );
    let (bb, verify_log) = accepting_bb(root.path());
    let node = open_test_node_with_limits(
        root.path(),
        &config,
        vec![BbProcessVerifier::new(bb)],
        genesis_timestamp,
        MempoolLimits::default(),
    );
    let api = NodeHandle::new(node.inner.clone()).with_mempool(node.mempool.clone());
    let open = publication_proof_transfer(&node, genesis_timestamp + 600, 1, 0, CircuitWord::ZERO);
    let designated = publication_proof_transfer(&node, genesis_timestamp + 600, 2, 0, word(9));
    let admitted = api.submit_raw_transaction(open.clone()).await.unwrap();
    assert_eq!(admitted.content_hash, pcash_state::content_hash(&open));
    assert_eq!(admitted.status, "ready");
    assert_eq!(admitted.open_fee_amount, U256::ZERO);
    assert_eq!(admitted.issuance_route, pcash_rpc::IssuanceRoute::Open);
    assert!(node
        .mempool
        .transaction(&pcash_state::content_hash(&open))
        .unwrap()
        .is_some());
    let designated_admission = api
        .submit_raw_transaction(designated.clone())
        .await
        .unwrap();
    assert_eq!(
        designated_admission.issuance_route,
        pcash_rpc::IssuanceRoute::Designated
    );
    assert_eq!(designated_admission.open_fee_amount, U256::ZERO);
    assert!(node
        .mempool
        .transaction(&pcash_state::content_hash(&designated))
        .unwrap()
        .is_some());
    // Proof-bearing zero-fee account actions pass the cheap peer policy and
    // consume the bounded unpaid proof budget at admission.
    let mut section =
        publication_proof_section(&node, genesis_timestamp + 600, 3, 0, CircuitWord::ZERO);
    section.proof.resize(WIRE_PROOF_BYTES, 0);
    let account_update = Transaction::UserAccountUpdate(UserAccountUpdate {
        address: Address::ZERO,
        new_rule_set_commitment: CircuitWord::ZERO,
        receive_key_update: ReceiveKeyUpdate::Keep,
        account_update_commitment: CircuitWord::ZERO,
        section,
    })
    .encode(PCASH_CHAIN_ID)
    .unwrap();
    node.mempool
        .check_admission_policy(&account_update)
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(&verify_log)
            .unwrap()
            .lines()
            .count(),
        2,
        "both type-0 routes reach proof verification"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn proof_bearing_zero_open_account_actions_are_admitted_by_default() {
    let root = tempfile::tempdir().unwrap();
    let genesis_timestamp = 1_000;
    let config = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        100,
        B256::repeat_byte(0xc8),
    );
    let (bb, verify_log) = accepting_bb(root.path());
    let node = open_test_node_with_limits(
        root.path(),
        &config,
        vec![BbProcessVerifier::new(bb)],
        genesis_timestamp,
        MempoolLimits::default(),
    );
    let signed_creation = signed_account(&node);
    assert!(matches!(
        node.mempool.check_admission_policy(&signed_creation),
        Err(pcash_rpc::MempoolApiError::Policy(_))
    ));
    assert!(matches!(
        node.mempool.submit(signed_creation.clone()).await,
        Err(pcash_rpc::MempoolApiError::Policy(_))
    ));
    apply_account_block(&node, signed_creation, B256::repeat_byte(0xc9));

    let update = account_update(&node, word(0x9999));
    let creation = zero_open_fee_contract_creation(&node, genesis_timestamp + 600, 5);
    let api = NodeHandle::new(node.inner.clone()).with_mempool(node.mempool.clone());
    for raw in [update, creation] {
        node.mempool.check_admission_policy(&raw).unwrap();
        let admitted = api.submit_raw_transaction(raw.clone()).await.unwrap();
        assert_eq!(admitted.status, "ready");
        assert_eq!(admitted.open_fee_amount, U256::ZERO);
        assert!(node
            .mempool
            .transaction(&pcash_state::content_hash(&raw))
            .unwrap()
            .is_some());
    }
    assert_eq!(
        std::fs::read_to_string(verify_log).unwrap().lines().count(),
        2
    );
}

#[cfg(unix)]
#[tokio::test]
async fn public_selected_submission_rejects_invalid_proof_without_mempool_insertion() {
    let root = tempfile::tempdir().unwrap();
    let genesis_timestamp = 1_800_000_000;
    let config = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        100,
        B256::repeat_byte(0xd1),
    );
    let (bb, verify_log) = rejecting_bb(root.path());
    let node = open_test_node_with_limits(
        root.path(),
        &config,
        vec![BbProcessVerifier::new(bb)],
        genesis_timestamp,
        MempoolLimits::default(),
    );
    let raw = publication_proof_transfer(&node, genesis_timestamp + 600, 1, 0, word(9));
    let content_hash = pcash_state::content_hash(&raw);
    let api = NodeHandle::new(node.inner.clone()).with_mempool(node.mempool.clone());
    assert!(matches!(
        api.submit_raw_transaction(raw).await,
        Err(pcash_rpc::MempoolApiError::Invalid(message)) if message == "proof rejected"
    ));
    assert_eq!(
        std::fs::read_to_string(verify_log).unwrap().lines().count(),
        1
    );
    assert!(node.mempool.transaction(&content_hash).unwrap().is_none());
}

#[cfg(unix)]
#[tokio::test]
async fn public_selected_submission_rejects_spent_nullifier_without_mempool_insertion() {
    let root = tempfile::tempdir().unwrap();
    let genesis_timestamp = 1_800_000_000;
    let genesis_hash = B256::repeat_byte(0xd2);
    let config = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        100,
        genesis_hash,
    );
    let (bb, verify_log) = accepting_bb(root.path());
    let node = open_test_node_with_limits(
        root.path(),
        &config,
        vec![BbProcessVerifier::new(bb.clone())],
        genesis_timestamp,
        MempoolLimits::default(),
    );
    let raw = publication_proof_transfer(&node, genesis_timestamp + 600, 2, 0, word(9));
    let content_hash = pcash_state::content_hash(&raw);
    let api = NodeHandle::new(node.inner.clone()).with_mempool(node.mempool.clone());
    let block = L1BlockData::new(
        L1Header {
            number: 101,
            hash: B256::repeat_byte(0xd3),
            parent_hash: genesis_hash,
            timestamp: genesis_timestamp + 12,
        },
        vec![(
            L1Tx {
                hash: keccak256(&raw),
                from: Address::repeat_byte(0x55),
                to: Some(DEFAULT_INBOX),
                input: Bytes::from(frame_transaction(&raw)),
                blob_versioned_hashes: Vec::new(),
                blob_resolution: pcash_l1::BlobResolution::Unresolved,
                tx_index: 0,
            },
            L1Receipt { logs: Vec::new() },
        )],
    );
    let outcome = node
        .inner
        .lock()
        .unwrap()
        .apply_block(&block, &BbProcessVerifier::new(bb))
        .unwrap();
    assert_eq!(item_results(&outcome), [SUCCEEDED]);
    assert!(matches!(
        api.submit_raw_transaction(raw).await,
        Err(pcash_rpc::MempoolApiError::State(message)) if message.contains("NullifierAlreadySpent")
    ));
    assert_eq!(
        std::fs::read_to_string(verify_log).unwrap().lines().count(),
        1
    );
    assert!(node.mempool.transaction(&content_hash).unwrap().is_none());
}

#[cfg(unix)]
/// Concurrent RPC submissions wait for the next free verifier worker instead of
/// failing while another proof is in flight.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_rpc_submissions_all_admit_across_verifier_workers() {
    let root = tempfile::tempdir().unwrap();
    let genesis_timestamp = 1_800_000_000;
    let config = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        100,
        B256::repeat_byte(0xd7),
    );
    let (bb, verify_log) = accepting_bb(root.path());
    let node = open_test_node_with_limits(
        root.path(),
        &config,
        (0..4).map(|_| BbProcessVerifier::new(&bb)).collect(),
        genesis_timestamp,
        MempoolLimits::default(),
    );
    let api = NodeHandle::new(node.inner.clone()).with_mempool(node.mempool.clone());
    let raws = (0..8)
        .map(|nonce| proof_bearing_transfer_with_nonce(&node, genesis_timestamp + 600, nonce))
        .collect::<Vec<_>>();

    let admissions = futures_util::future::join_all(
        raws.iter()
            .map(|raw| api.submit_raw_transaction(raw.clone())),
    )
    .await;
    for (raw, admitted) in raws.iter().zip(admissions) {
        let admitted = admitted.unwrap();
        assert_eq!(admitted.content_hash, pcash_state::content_hash(raw));
        assert_eq!(admitted.status, "ready");
    }
    wait_for_verification_count(&verify_log, 8).await;
    // Each fake verifier logs its process id, one per worker.
    let workers = std::fs::read_to_string(&verify_log)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect::<std::collections::HashSet<_>>()
        .len();
    assert!(workers > 1, "every admission ran on one verifier worker");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn proof_bearing_transfer_gossips_prepares_and_settles_on_peer() {
    let root = tempfile::tempdir().unwrap();
    let genesis_l1_hash = B256::from([0xc5; 32]);
    let genesis_timestamp = 1_800_000_000;
    let config = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        100,
        genesis_l1_hash,
    );

    let a_data = root.path().join("proof-a");
    let b_data = root.path().join("proof-b");
    std::fs::create_dir_all(&a_data).unwrap();
    std::fs::create_dir_all(&b_data).unwrap();
    let (a_bb, a_verify_log) = accepting_bb(&a_data);
    let (b_bb, b_verify_log) = accepting_bb(&b_data);
    let a_node = open_test_node_with_verifier(
        &a_data,
        &config,
        BbProcessVerifier::new(a_bb.clone()),
        genesis_timestamp,
    );
    let b_node = open_test_node_with_verifier(
        &b_data,
        &config,
        BbProcessVerifier::new(b_bb.clone()),
        genesis_timestamp,
    );

    // Commit the same empty genesis boundary so the transfer's note root and
    // recent PCASH block hash are current on both independently persisted nodes.
    let raw = proof_bearing_transfer(&a_node, genesis_timestamp + 600);
    let content_hash = pcash_state::content_hash(&raw);

    let a_p2p = start_p2p(
        p2p_config(&a_data, node_capability(&a_node), Vec::new()),
        a_node.mempool.clone(),
    )
    .await
    .unwrap();
    let a_bootstrap = bootstrap_address(
        a_p2p.listen_address().await.unwrap(),
        a_p2p.handle.peer_id(),
    );
    let b_p2p = start_p2p(
        p2p_config(&b_data, node_capability(&b_node), vec![a_bootstrap]),
        b_node.mempool.clone(),
    )
    .await
    .unwrap();
    wait_for_peer(&a_p2p).await;
    wait_for_peer(&b_p2p).await;

    // Wait for the first heartbeat so A's one-shot publish reaches B's mesh.
    tokio::time::sleep(Duration::from_millis(1_250)).await;
    let a_api = NodeHandle::new(a_node.inner.clone())
        .with_mempool(a_node.mempool.clone())
        .with_p2p(a_p2p.handle.clone(), a_p2p.listen_addresses_watch());
    let admitted = a_api.submit_raw_transaction(raw.clone()).await.unwrap();
    assert_eq!(admitted.content_hash, content_hash);
    assert_eq!(admitted.kind, TransactionKind::PrivateValue);
    assert_eq!(admitted.status, "ready");
    wait_for_entry_within(&b_node.mempool, content_hash, Duration::from_secs(3)).await;

    let b_entry = b_node.mempool.transaction(&content_hash).unwrap().unwrap();
    assert_eq!(b_entry.kind, TransactionKind::PrivateValue);
    assert_eq!(b_entry.raw_transaction, Some(raw.clone().into()));
    assert_eq!(
        std::fs::read_to_string(&a_verify_log)
            .unwrap()
            .lines()
            .count(),
        1
    );
    assert_eq!(
        std::fs::read_to_string(&b_verify_log)
            .unwrap()
            .lines()
            .count(),
        1
    );

    let relayer = Address::from([0x77; 20]);
    let b_api = NodeHandle::new(b_node.inner.clone()).with_mempool(b_node.mempool.clone());
    let expected_batch = frame_transaction(&raw);
    let prepared = b_api
        .prepare_relay(PrepareRelayRequest {
            content_hashes: vec![content_hash],
            controlled_issuance_owner_commitments: Vec::new(),
            controlled_issuance_content_hashes: Vec::new(),
            max_batch_bytes: expected_batch.len(),
        })
        .unwrap();
    assert_eq!(prepared.selected_content_hashes, vec![content_hash]);
    assert!(prepared.rejected.is_empty());
    assert_eq!(prepared.collectible_open_fee, U256::from(25u64));
    assert_eq!(prepared.collectible_qualifying_actions, 1);
    assert_eq!(prepared.selected_qualifying_actions, 1);
    assert_eq!(
        prepared.selected_transactions,
        vec![Bytes::from(raw.clone())]
    );
    assert_eq!(prepared.batch_bytes, expected_batch.len() as u64);

    // Inject the prepared batch as calldata in the next canonical L1 block. This covers
    // derivation, receipt indexing, and mempool inclusion in the offline node
    // harness; Ethereum broadcast/provider behavior remains outside this test.
    let relay_block_hash = B256::from([0xc6; 32]);
    let relay_block = L1BlockData::new(
        L1Header {
            number: 101,
            hash: relay_block_hash,
            parent_hash: genesis_l1_hash,
            timestamp: genesis_timestamp + 12,
        },
        vec![(
            L1Tx {
                hash: keccak256(&expected_batch),
                from: relayer,
                to: Some(DEFAULT_INBOX),
                input: expected_batch.into(),
                blob_versioned_hashes: Vec::new(),
                blob_resolution: pcash_l1::BlobResolution::Unresolved,
                tx_index: 0,
            },
            L1Receipt { logs: Vec::new() },
        )],
    );
    let outcome = b_node
        .inner
        .lock()
        .unwrap()
        .apply_block(&relay_block, &BbProcessVerifier::new(b_bb))
        .unwrap();
    assert_eq!(item_results(&outcome), [SUCCEEDED]);
    b_node
        .mempool
        .on_applied_block(
            BlockId {
                block_number: outcome.committed_boundary.block.header.number,
                block_hash: outcome.committed_boundary.block.hash,
            },
            &[content_hash],
            &outcome
                .transaction_effects
                .iter()
                .filter_map(|effects| effects.accepted())
                .collect::<Vec<_>>(),
        )
        .unwrap();

    let inclusion_id = pcash_state::transaction_id(relay_block.header.hash, 0, 0);
    assert_ne!(inclusion_id, content_hash);
    assert!(b_node.mempool.transaction(&inclusion_id).unwrap().is_none());
    let receipts = b_api
        .get_receipt(ReceiptQuery::tx_id(inclusion_id))
        .unwrap();
    assert_eq!(receipts.len(), 1);
    assert!(receipts[0].accepted());
    assert_eq!(receipts[0].kind, TransactionKind::PrivateValue);
    let earned = b_api
        .get_payouts(pcash_rpc::PayoutQuery::default())
        .unwrap();
    let reward_each = outcome.committed_boundary.history.economics.reward_each;
    assert_eq!(earned.records.len(), 2);
    let fee_payout = &earned.records[0].payout.payout;
    let issuance_payout = &earned.records[1].payout.payout;
    for payout in [fee_payout, issuance_payout] {
        assert!(matches!(
            payout.source,
            pcash_state::PayoutSource::PosterPayout { .. }
        ));
        assert_eq!(payout.owner_commitment, word(1));
    }
    assert_eq!(fee_payout.component, pcash_state::PayoutComponent::OpenFee);
    assert_eq!(fee_payout.amount, U256::from(25u64));
    assert_eq!(
        issuance_payout.component,
        pcash_state::PayoutComponent::Issuance
    );
    assert_eq!(issuance_payout.amount, reward_each);
    assert_eq!(fee_payout.contexts, issuance_payout.contexts);
    assert_eq!(
        b_node
            .mempool
            .transaction(&content_hash)
            .unwrap()
            .unwrap()
            .status,
        "included_unfinalized"
    );
    assert_eq!(
        std::fs::read_to_string(&b_verify_log)
            .unwrap()
            .lines()
            .count(),
        2
    );

    b_p2p.handle.shutdown().await.unwrap();
    a_p2p.handle.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn inventory_candidate_is_admitted_then_gossiped_downstream() {
    let root = tempfile::tempdir().unwrap();
    let genesis_l1_hash = B256::from([0xd0; 32]);
    let config = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        100,
        genesis_l1_hash,
    );
    let a_data = root.path().join("sync-source");
    let b_data = root.path().join("sync-relay");
    let c_data = root.path().join("gossip-observer");
    for data in [&a_data, &b_data, &c_data] {
        std::fs::create_dir_all(data).unwrap();
    }

    let a_node = open_test_node(&a_data, &config);
    let b_node = open_test_node(&b_data, &config);
    let raw = signed_account(&a_node);
    let content_hash = pcash_state::content_hash(&raw);
    assert_eq!(
        a_node.mempool.submit(raw.clone()).await.unwrap().status,
        MempoolStatus::Ready
    );

    // Start the middle node and downstream observer first. When A connects,
    // B can only learn A's pre-existing entry through inventory sync; B must
    // then announce the admitted bytes to its already-connected downstream.
    let b_p2p = start_p2p(
        p2p_config(&b_data, node_capability(&b_node), Vec::new()),
        b_node.mempool.clone(),
    )
    .await
    .unwrap();
    let b_bootstrap = bootstrap_address(
        b_p2p.listen_address().await.unwrap(),
        b_p2p.handle.peer_id(),
    );
    let (c_p2p, mut c_events) = pcash_p2p::start(P2pConfig {
        bootstrap: vec![b_bootstrap.clone()],
        ..p2p_config(&c_data, node_capability(&b_node), Vec::new())
    })
    .await
    .unwrap();
    wait_for_raw_peer(&c_p2p).await;
    wait_for_peer(&b_p2p).await;
    tokio::time::sleep(Duration::from_millis(1_250)).await;

    let a_p2p = start_p2p(
        P2pConfig {
            bootstrap: vec![b_bootstrap],
            ..p2p_config(&a_data, node_capability(&a_node), Vec::new())
        },
        a_node.mempool.clone(),
    )
    .await
    .unwrap();
    wait_for_peer_count(&b_p2p, 2).await;
    wait_for_peer(&a_p2p).await;

    wait_for_entry(&b_node.mempool, content_hash).await;
    let accepted = wait_for_peer_info(&b_p2p.handle, a_p2p.handle.peer_id(), |info| {
        info.tx_accepted > 0
    })
    .await;
    assert!(accepted.score > 0);
    assert_eq!(accepted.tx_rejected, 0);
    let (received, origin) = wait_for_raw_candidate(&mut c_events).await;
    assert_eq!(received, raw);
    assert!(matches!(
        origin,
        CandidateOrigin::Gossip {
            publisher,
            propagation_source,
            ..
        } if publisher == b_p2p.handle.peer_id()
            && propagation_source == b_p2p.handle.peer_id()
    ));

    c_p2p.shutdown().await.unwrap();
    a_p2p.handle.shutdown().await.unwrap();
    b_p2p.handle.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn service_restart_advertises_persisted_ready_inventory_immediately() {
    let root = tempfile::tempdir().unwrap();
    let genesis_l1_hash = B256::from([0xd1; 32]);
    let config = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        100,
        genesis_l1_hash,
    );
    let a_data = root.path().join("restart-source");
    let b_data = root.path().join("restart-peer");
    std::fs::create_dir_all(&a_data).unwrap();
    std::fs::create_dir_all(&b_data).unwrap();

    let first_peer_id = pcash_p2p::load_or_create_identity(&a_data.join("p2p-identity.pb"))
        .unwrap()
        .public()
        .to_peer_id();
    let (a_inner, raw) = {
        let a_node = open_test_node(&a_data, &config);
        let raw = signed_account(&a_node);
        assert_eq!(
            a_node.mempool.submit(raw.clone()).await.unwrap().status,
            MempoolStatus::Ready
        );
        (a_node.inner.clone(), raw)
    };
    let content_hash = pcash_state::content_hash(&raw);

    let a_node = TestNode {
        inner: a_inner.clone(),
        admissions: Arc::new(PeerAdmissionRecorder::default()),
        mempool: MempoolService::open(
            a_inner,
            a_data.join("mempool.redb"),
            AdmissionPool::new(
                vec![BbProcessVerifier::new(a_data.join("unused-bb"))],
                DEFAULT_ADMISSION_QUEUE,
            )
            .unwrap(),
            MempoolLimits {
                accept_unpaid_registration: true,
                ..MempoolLimits::default()
            },
        )
        .unwrap(),
    };
    assert_eq!(
        a_node
            .mempool
            .transaction(&content_hash)
            .unwrap()
            .unwrap()
            .status,
        "ready"
    );
    let b_node = open_test_node(&b_data, &config);
    let a_p2p = start_p2p(
        p2p_config(&a_data, node_capability(&a_node), Vec::new()),
        a_node.mempool.clone(),
    )
    .await
    .unwrap();
    assert_eq!(a_p2p.handle.peer_id(), first_peer_id);
    let a_bootstrap = bootstrap_address(
        a_p2p.listen_address().await.unwrap(),
        a_p2p.handle.peer_id(),
    );
    let b_p2p = start_p2p(
        P2pConfig {
            bootstrap: vec![a_bootstrap],
            ..p2p_config(&b_data, node_capability(&b_node), Vec::new())
        },
        b_node.mempool.clone(),
    )
    .await
    .unwrap();

    wait_for_peer(&a_p2p).await;
    wait_for_peer(&b_p2p).await;
    wait_for_entry_within(&b_node.mempool, content_hash, Duration::from_secs(3)).await;
    assert_eq!(
        b_node
            .mempool
            .transaction(&content_hash)
            .unwrap()
            .unwrap()
            .raw_transaction,
        Some(raw.into())
    );

    b_p2p.handle.shutdown().await.unwrap();
    a_p2p.handle.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn included_entry_stops_syncing_and_rollback_readvertises_it() {
    let root = tempfile::tempdir().unwrap();
    let genesis_l1_hash = B256::from([0xd2; 32]);
    let config = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        100,
        genesis_l1_hash,
    );
    let a_data = root.path().join("lifecycle-source");
    let b_data = root.path().join("lifecycle-peer");
    std::fs::create_dir_all(&a_data).unwrap();
    std::fs::create_dir_all(&b_data).unwrap();
    let a_node = open_test_node(&a_data, &config);
    let b_node = open_test_node(&b_data, &config);
    let raw = signed_account(&a_node);
    let content_hash = pcash_state::content_hash(&raw);
    assert_eq!(
        a_node.mempool.submit(raw.clone()).await.unwrap().status,
        MempoolStatus::Ready
    );
    apply_account_block(&a_node, raw.clone(), B256::from([0xd3; 32]));
    assert_eq!(
        a_node
            .mempool
            .transaction(&content_hash)
            .unwrap()
            .unwrap()
            .status,
        "included_unfinalized"
    );

    let a_p2p = start_p2p(
        p2p_config(&a_data, node_capability(&a_node), Vec::new()),
        a_node.mempool.clone(),
    )
    .await
    .unwrap();
    let a_bootstrap = bootstrap_address(
        a_p2p.listen_address().await.unwrap(),
        a_p2p.handle.peer_id(),
    );
    let b_p2p = start_p2p(
        P2pConfig {
            bootstrap: vec![a_bootstrap],
            ..p2p_config(&b_data, node_capability(&b_node), Vec::new())
        },
        b_node.mempool.clone(),
    )
    .await
    .unwrap();
    wait_for_peer(&a_p2p).await;
    wait_for_peer(&b_p2p).await;

    // The initial inventory snapshot is built after inclusion and therefore
    // must not expose the tombstoned transaction to this late peer.
    tokio::time::sleep(Duration::from_millis(750)).await;
    assert!(b_node.mempool.transaction(&content_hash).unwrap().is_none());

    a_node
        .inner
        .lock()
        .unwrap()
        .rollback_to(config.genesis_l1_block)
        .unwrap();
    a_node.mempool.on_rollback(0).unwrap();
    assert_eq!(
        a_node
            .mempool
            .transaction(&content_hash)
            .unwrap()
            .unwrap()
            .status,
        "ready"
    );
    wait_for_entry(&b_node.mempool, content_hash).await;

    b_p2p.handle.shutdown().await.unwrap();
    a_p2p.handle.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn verifier_rejected_sync_penalizes_the_serving_peer() {
    let root = tempfile::tempdir().unwrap();
    let config = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        100,
        B256::repeat_byte(0xd7),
    );
    let source_data = root.path().join("invalid-sync-source");
    let receiver_data = root.path().join("invalid-sync-receiver");
    for data in [&source_data, &receiver_data] {
        std::fs::create_dir_all(data).unwrap();
    }
    let genesis_timestamp = 1_800_000_000;
    let (bb, verification_log) = rejecting_bb(&receiver_data);
    let receiver = open_test_node_with_verifier(
        &receiver_data,
        &config,
        BbProcessVerifier::new(bb),
        genesis_timestamp,
    );
    let raw = proof_bearing_transfer(&receiver, genesis_timestamp + 600);
    let content_hash = pcash_state::content_hash(&raw);
    let receiver_p2p = start_p2p(
        P2pConfig {
            // The handshake starts a sync session. Keep later rounds outside
            // the assertion deadline so one rejected entry cannot cause a ban
            // before the peer accounting snapshot is published.
            anti_entropy_interval: Duration::from_secs(30),
            ..p2p_config(&receiver_data, node_capability(&receiver), Vec::new())
        },
        receiver.mempool.clone(),
    )
    .await
    .unwrap();
    let bootstrap = bootstrap_address(
        receiver_p2p.listen_address().await.unwrap(),
        receiver_p2p.handle.peer_id(),
    );
    // This peer only serves inventory/Get; it never publishes gossip. The
    // advertised hash is the hash of the actual returned proof-bearing bytes,
    // so transport request binding succeeds before admission rejects the proof.
    let (source, _events) = pcash_p2p::start_with_inventory(
        P2pConfig {
            anti_entropy_interval: Duration::from_secs(30),
            ..p2p_config(&source_data, node_capability(&receiver), vec![bootstrap])
        },
        vec![InventoryEntry {
            content_hash,
            tx_bytes: raw,
        }],
    )
    .await
    .unwrap();
    wait_for_raw_peer(&source).await;
    wait_for_peer(&receiver_p2p).await;
    wait_for_verification_count(&verification_log, 1).await;
    wait_for_peer_admission(&receiver.admissions.invalid).await;
    let info = wait_for_peer_info(&receiver_p2p.handle, source.peer_id(), |info| {
        info.tx_rejected > 0
    })
    .await;
    assert_eq!(info.tx_received, 1);
    assert_eq!(info.tx_rejected, 1);
    assert_eq!(info.tx_accepted, 0);
    assert!(
        info.score < 0,
        "invalid sync did not lower peer score: {info:?}"
    );
    assert!(receiver
        .mempool
        .transaction(&content_hash)
        .unwrap()
        .is_none());

    source.shutdown().await.unwrap();
    receiver_p2p.handle.shutdown().await.unwrap();
}

/// A transaction that requires a carrier context is refused by node policy,
/// which a later release may relax: RPC answers with the policy code, and a
/// peer that serves the bytes is not penalized.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn carrier_bound_transactions_are_refused_by_policy_without_penalizing_peers() {
    use pcash_derive::private_value_profiles::S;
    let root = tempfile::tempdir().unwrap();
    let config = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        100,
        B256::repeat_byte(0xd8),
    );
    let source_data = root.path().join("carrier-bound-source");
    let receiver_data = root.path().join("carrier-bound-receiver");
    for data in [&source_data, &receiver_data] {
        std::fs::create_dir_all(data).unwrap();
    }
    // The refusal precedes state and proof work, so the verifier never runs.
    let receiver = open_test_node(&receiver_data, &config);
    let mut section = publication_proof_section(&receiver, 2_000, 9, 25, CircuitWord::ZERO);
    *section
        .public_input_mut(S.carrier_context_hash_offset)
        .unwrap() = word(0xcc);
    let raw = Transaction::PrivateValue(section)
        .encode(PCASH_CHAIN_ID)
        .unwrap();
    let content_hash = pcash_state::content_hash(&raw);

    let api: Arc<dyn NodeApi> =
        Arc::new(NodeHandle::new(receiver.inner.clone()).with_mempool(receiver.mempool.clone()));
    let (rpc_addr, rpc) = serve("127.0.0.1:0".parse().unwrap(), api).await.unwrap();
    let error = rpc_call_error(
        &reqwest::Client::new(),
        &format!("http://{rpc_addr}"),
        "pcash_submitRawTransaction",
        json!([format!("0x{}", hex::encode(&raw))]),
    )
    .await;
    assert_eq!(error["code"], -32015, "{error}");
    assert!(
        error["message"]
            .as_str()
            .unwrap()
            .contains("requires a carrier context"),
        "{error}"
    );

    // The runtime records its shape-only refusal of peer bytes to the same
    // recorder as admission.
    let receiver_p2p = start_p2p_with_metrics(
        P2pConfig {
            anti_entropy_interval: Duration::from_secs(30),
            ..p2p_config(&receiver_data, node_capability(&receiver), Vec::new())
        },
        receiver.mempool.clone(),
        receiver.admissions.clone(),
    )
    .await
    .unwrap();
    let bootstrap = bootstrap_address(
        receiver_p2p.listen_address().await.unwrap(),
        receiver_p2p.handle.peer_id(),
    );
    let (source, _events) = pcash_p2p::start_with_inventory(
        P2pConfig {
            anti_entropy_interval: Duration::from_secs(30),
            ..p2p_config(&source_data, node_capability(&receiver), vec![bootstrap])
        },
        vec![InventoryEntry {
            content_hash,
            tx_bytes: raw,
        }],
    )
    .await
    .unwrap();
    wait_for_raw_peer(&source).await;
    wait_for_peer(&receiver_p2p).await;
    wait_for_peer_admission(&receiver.admissions.policy).await;
    let info = wait_for_peer_info(&receiver_p2p.handle, source.peer_id(), |info| {
        info.tx_received > 0
    })
    .await;
    assert_eq!(info.tx_received, 1);
    assert_eq!(info.tx_rejected, 0);
    assert_eq!(info.score, 0);
    assert!(info.banned_for.is_none());
    assert_eq!(receiver.admissions.invalid.load(Ordering::Relaxed), 0);
    assert!(receiver
        .mempool
        .transaction(&content_hash)
        .unwrap()
        .is_none());

    source.shutdown().await.unwrap();
    receiver_p2p.handle.shutdown().await.unwrap();
    rpc.stop().unwrap();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn malformed_and_verifier_rejected_gossip_is_not_stored_or_forwarded() {
    let root = tempfile::tempdir().unwrap();
    let genesis_l1_hash = B256::from([0xd4; 32]);
    let genesis_timestamp = 1_800_000_000;
    let config = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        100,
        genesis_l1_hash,
    );
    let a_data = root.path().join("bad-proof-publisher");
    let b_data = root.path().join("bad-proof-validator");
    let c_data = root.path().join("bad-proof-observer");
    for data in [&a_data, &b_data, &c_data] {
        std::fs::create_dir_all(data).unwrap();
    }
    let (bb, verification_log) = rejecting_bb(&b_data);
    let b_node = open_test_node_with_verifier(
        &b_data,
        &config,
        BbProcessVerifier::new(bb),
        genesis_timestamp,
    );
    let raw = proof_bearing_transfer(&b_node, genesis_timestamp + 600);
    let content_hash = pcash_state::content_hash(&raw);

    let b_p2p = start_p2p(
        p2p_config(&b_data, node_capability(&b_node), Vec::new()),
        b_node.mempool.clone(),
    )
    .await
    .unwrap();
    let b_bootstrap = bootstrap_address(
        b_p2p.listen_address().await.unwrap(),
        b_p2p.handle.peer_id(),
    );
    let (a_p2p, _a_events) = pcash_p2p::start(P2pConfig {
        bootstrap: vec![b_bootstrap.clone()],
        ..p2p_config(&a_data, node_capability(&b_node), Vec::new())
    })
    .await
    .unwrap();
    let (c_p2p, mut c_events) = pcash_p2p::start(P2pConfig {
        bootstrap: vec![b_bootstrap],
        ..p2p_config(&c_data, node_capability(&b_node), Vec::new())
    })
    .await
    .unwrap();
    wait_for_raw_peer(&a_p2p).await;
    wait_for_raw_peer(&c_p2p).await;
    wait_for_peer_count(&b_p2p, 2).await;
    tokio::time::sleep(Duration::from_millis(1_250)).await;

    let malformed = vec![0xff];
    let malformed_content_hash = pcash_state::content_hash(&malformed);
    a_p2p.announce(malformed).await.unwrap();
    assert_no_raw_candidate(&mut c_events, Duration::from_millis(500)).await;
    assert!(b_node
        .mempool
        .transaction(&malformed_content_hash)
        .unwrap()
        .is_none());

    a_p2p.announce(raw).await.unwrap();
    wait_for_verification_count(&verification_log, 1).await;
    assert!(b_node.mempool.transaction(&content_hash).unwrap().is_none());
    assert_no_raw_candidate(&mut c_events, Duration::from_millis(750)).await;

    c_p2p.shutdown().await.unwrap();
    a_p2p.shutdown().await.unwrap();
    b_p2p.handle.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn proof_budget_suppresses_excess_work_without_blocking_accounts() {
    let root = tempfile::tempdir().unwrap();
    let genesis_l1_hash = B256::from([0xd5; 32]);
    let genesis_timestamp = 1_800_000_000;
    let config = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        100,
        genesis_l1_hash,
    );
    let a_data = root.path().join("budget-publisher");
    let b_data = root.path().join("budget-validator");
    std::fs::create_dir_all(&a_data).unwrap();
    std::fs::create_dir_all(&b_data).unwrap();
    let (bb, verification_log) = accepting_bb(&b_data);
    let b_node = open_test_node_with_verifier(
        &b_data,
        &config,
        BbProcessVerifier::new(bb),
        genesis_timestamp,
    );
    let b_p2p = start_p2p(
        p2p_config(&b_data, node_capability(&b_node), Vec::new()),
        b_node.mempool.clone(),
    )
    .await
    .unwrap();
    let b_bootstrap = bootstrap_address(
        b_p2p.listen_address().await.unwrap(),
        b_p2p.handle.peer_id(),
    );
    let (a_p2p, _a_events) = pcash_p2p::start(P2pConfig {
        bootstrap: vec![b_bootstrap],
        ..p2p_config(&a_data, node_capability(&b_node), Vec::new())
    })
    .await
    .unwrap();
    wait_for_raw_peer(&a_p2p).await;
    wait_for_peer(&b_p2p).await;
    tokio::time::sleep(Duration::from_millis(1_250)).await;

    let proofs = (0..5)
        .map(|nonce| proof_bearing_transfer_with_nonce(&b_node, genesis_timestamp + 600, nonce))
        .collect::<Vec<_>>();
    for proof in &proofs {
        a_p2p.announce(proof.clone()).await.unwrap();
    }
    wait_for_verification_count(&verification_log, 4).await;
    for proof in proofs.iter().take(4) {
        wait_for_entry(&b_node.mempool, pcash_state::content_hash(proof)).await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(b_node
        .mempool
        .transaction(&pcash_state::content_hash(&proofs[4]))
        .unwrap()
        .is_none());

    let record = signed_account(&b_node);
    let account_content_hash = pcash_state::content_hash(&record);
    a_p2p.announce(record).await.unwrap();
    wait_for_entry_within(
        &b_node.mempool,
        account_content_hash,
        Duration::from_secs(3),
    )
    .await;
    assert_eq!(
        std::fs::read_to_string(&verification_log)
            .unwrap()
            .lines()
            .count(),
        4
    );

    // A publisher receives one new proof token after the ten-second refill.
    tokio::time::sleep(Duration::from_millis(10_100)).await;
    let after_refill = proof_bearing_transfer_with_nonce(&b_node, genesis_timestamp + 600, 6);
    let after_refill_content_hash = pcash_state::content_hash(&after_refill);
    a_p2p.announce(after_refill).await.unwrap();
    wait_for_verification_count(&verification_log, 5).await;
    wait_for_entry(&b_node.mempool, after_refill_content_hash).await;

    a_p2p.shutdown().await.unwrap();
    b_p2p.handle.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn connected_stale_node_retries_account_update_inventory_after_catching_up() {
    let root = tempfile::tempdir().unwrap();
    let genesis_l1_hash = B256::from([0xb6; 32]);
    let config = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        100,
        genesis_l1_hash,
    );
    let a_data = root.path().join("retry-a");
    let c_data = root.path().join("retry-c");
    std::fs::create_dir_all(&a_data).unwrap();
    std::fs::create_dir_all(&c_data).unwrap();
    let (a_bb, _) = accepting_bb(&a_data);
    let (c_bb, _) = accepting_bb(&c_data);
    let a_node =
        open_test_node_with_verifier(&a_data, &config, BbProcessVerifier::new(a_bb), 1_000);
    let c_node =
        open_test_node_with_verifier(&c_data, &config, BbProcessVerifier::new(c_bb), 1_000);

    let creation = signed_account(&a_node);
    let creation_block_hash = B256::from([0xb7; 32]);
    apply_account_block(&a_node, creation.clone(), creation_block_hash);
    let update = account_update(&a_node, word(0x9999));
    let update_content_hash = pcash_state::content_hash(&update);
    assert_eq!(
        a_node.mempool.submit(update.clone()).await.unwrap().status,
        MempoolStatus::Ready
    );

    let a_p2p = start_p2p(
        p2p_config(&a_data, node_capability(&a_node), Vec::new()),
        a_node.mempool.clone(),
    )
    .await
    .unwrap();
    let bootstrap = bootstrap_address(
        a_p2p.listen_address().await.unwrap(),
        a_p2p.handle.peer_id(),
    );
    let c_p2p = start_p2p(
        p2p_config(&c_data, node_capability(&c_node), vec![bootstrap]),
        c_node.mempool.clone(),
    )
    .await
    .unwrap();
    wait_for_peer(&a_p2p).await;
    wait_for_peer(&c_p2p).await;

    // C has not derived the creation. Wait for admission's actual State
    // outcome, then for the transport to publish the received candidate's
    // accounting, before asserting this sync attempt carried no penalty.
    wait_for_peer_admission(&c_node.admissions.state).await;
    let ineligible = wait_for_peer_info(&c_p2p.handle, a_p2p.handle.peer_id(), |info| {
        info.tx_received > 0
    })
    .await;
    assert!(c_node
        .mempool
        .transaction(&update_content_hash)
        .unwrap()
        .is_none());
    assert_eq!(ineligible.tx_accepted, 0);
    assert_eq!(ineligible.tx_rejected, 0);
    assert_eq!(ineligible.score, 0);

    // Catch C up without reconnecting. A later anti-entropy round must fetch
    // and admit the same exact update bytes against the now-current record.
    apply_account_block(&c_node, creation, creation_block_hash);
    wait_for_entry(&c_node.mempool, update_content_hash).await;
    let accepted = wait_for_peer_info(&c_p2p.handle, a_p2p.handle.peer_id(), |info| {
        info.tx_accepted > 0
    })
    .await;
    assert_eq!(accepted.tx_rejected, 0);
    assert!(accepted.score > 0);
    assert_eq!(
        c_node
            .mempool
            .transaction(&update_content_hash)
            .unwrap()
            .unwrap()
            .raw_transaction,
        Some(update.into())
    );

    c_p2p.handle.shutdown().await.unwrap();
    a_p2p.handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn ethereum_signed_type_two_cannot_rewrite_an_existing_account() {
    let root = tempfile::tempdir().unwrap();
    let genesis_l1_hash = B256::from([0xb6; 32]);
    let config = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        100,
        genesis_l1_hash,
    );
    let a_data = root.path().join("retry-a");
    std::fs::create_dir_all(&a_data).unwrap();
    let a_node = open_test_node(&a_data, &config);

    let creation = signed_account(&a_node);
    apply_account_block(&a_node, creation.clone(), genesis_l1_hash);
    let error = a_node.mempool.submit(creation).await.unwrap_err();
    assert!(error.to_string().contains("AccountAlreadyExists"));
}

/// The end-to-end case peer management exists for: a node started with no
/// bootnode at all joins the network at runtime, purely through `admin_addPeer`,
/// and then participates in gossip like any other peer.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn admin_add_peer_joins_an_unconnected_node_and_gossip_flows() {
    let root = tempfile::tempdir().unwrap();
    let genesis_l1_hash = B256::from([0xa5; 32]);
    let config = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        100,
        genesis_l1_hash,
    );

    let a_data = root.path().join("a");
    let b_data = root.path().join("b");
    std::fs::create_dir_all(&a_data).unwrap();
    std::fs::create_dir_all(&b_data).unwrap();
    let a_node = open_test_node(&a_data, &config);
    let b_node = open_test_node(&b_data, &config);

    // Neither node is given a bootnode, so nothing connects them at startup.
    let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = socket.local_addr().unwrap().port();
    let mut a_config = p2p_config(&a_data, node_capability(&a_node), Vec::new());
    a_config.listen = format!("/ip4/127.0.0.1/tcp/{port}").parse().unwrap();
    a_config.connectivity.advertised_address = Some(a_config.listen.clone());
    a_config.connectivity.allow_private_addresses = true;
    drop(socket);
    let a_p2p = start_p2p(a_config, a_node.mempool.clone()).await.unwrap();
    let b_p2p = start_p2p(
        p2p_config(&b_data, node_capability(&b_node), Vec::new()),
        b_node.mempool.clone(),
    )
    .await
    .unwrap();
    a_p2p.listen_address().await.unwrap();
    b_p2p.listen_address().await.unwrap();
    assert_eq!(a_p2p.peer_count(), 0);
    assert_eq!(b_p2p.peer_count(), 0);

    let a_api = NodeHandle::new(a_node.inner.clone())
        .with_mempool(a_node.mempool.clone())
        .with_p2p(a_p2p.handle.clone(), a_p2p.listen_addresses_watch());
    let b_api = NodeHandle::new(b_node.inner.clone())
        .with_mempool(b_node.mempool.clone())
        .with_p2p(b_p2p.handle.clone(), b_p2p.listen_addresses_watch());

    // `admin_nodeInfo` reports the exact string `admin_addPeer` takes, so an
    // operator never has to assemble a multiaddress or read a log to find one.
    let a_info = b_api.node_info().unwrap();
    assert_eq!(a_info.peer_count, 0);
    let a_bootstrap = a_api
        .node_info()
        .unwrap()
        .bootstrap_addresses
        .into_iter()
        .next()
        .expect("a bound node reports at least one bootstrap address");

    let added = b_api.add_peer(a_bootstrap).await.unwrap();
    assert_eq!(added.peer_id, a_p2p.handle.peer_id().to_string());

    wait_for_peer(&b_p2p).await;
    wait_for_peer(&a_p2p).await;
    wait_for_compatible_peer(&b_p2p).await;

    // The peer record carries what an operator needs to see, from the side that
    // dialed and the side that accepted.
    let peers = AdminApi::peers(&b_api).unwrap();
    assert_eq!(peers.len(), 1);
    assert_eq!(peers[0].peer_id, a_p2p.handle.peer_id().to_string());
    assert_eq!(peers[0].direction, pcash_rpc::PeerDirectionDto::Outbound);
    assert_eq!(
        AdminApi::peers(&a_api).unwrap()[0].direction,
        pcash_rpc::PeerDirectionDto::Inbound
    );

    // Connection establishment precedes gossipsub mesh formation.
    tokio::time::sleep(Duration::from_millis(1_250)).await;
    let raw = signed_account(&a_node);
    let content_hash = pcash_state::content_hash(&raw);
    a_api.submit_raw_transaction(raw).await.unwrap();
    wait_for_entry(&b_node.mempool, content_hash).await;

    // Traffic is attributed to the peer that carried it. Counters are
    // republished on the swarm's timer rather than per message, so this polls
    // rather than reading once immediately after admission.
    let attributed = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let peers = AdminApi::peers(&b_api).unwrap();
            if peers[0].payload_bytes_received > 0 {
                break peers;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("gossip payload was never attributed to the peer that sent it");
    assert!(attributed[0].tx_received > 0);

    // Removing the peer disconnects it and, with no bootnode entry left behind,
    // it stays disconnected.
    let removed = b_api
        .remove_peer(a_p2p.handle.peer_id().to_string(), false)
        .await
        .unwrap();
    assert!(removed.removed);
    assert!(!removed.banned);
    wait_for_peer_count(&b_p2p, 0).await;
}

#[tokio::test]
async fn direct_account_creation_is_not_admitted_from_rpc_or_peers() {
    let root = tempfile::tempdir().unwrap();
    let config = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        100,
        B256::repeat_byte(0xa5),
    );
    let node = open_test_node(root.path(), &config);
    let signed = signed_account(&node);
    // The same creation authorized by its carrier: the mode byte follows the
    // type and chain id, and the signature is the last 65 bytes.
    let mut direct = signed[..signed.len() - 65].to_vec();
    direct[5] = 0;
    let content_hash = pcash_state::content_hash(&direct);
    let api = NodeHandle::new(node.inner.clone()).with_mempool(node.mempool.clone());
    let rpc_error = api
        .submit_raw_transaction(direct.clone())
        .await
        .unwrap_err();
    assert!(rpc_error
        .to_string()
        .contains("requires an owner-sent L1 transaction"));
    let peer_error = node
        .mempool
        .submit_from_peer(direct.clone())
        .await
        .unwrap_err();
    assert!(peer_error
        .to_string()
        .contains("requires an owner-sent L1 transaction"));
    assert!(node.mempool.transaction(&content_hash).unwrap().is_none());
    // The signer posting the direct form creates its account, which the
    // pending signed form then fails to create again.
    let signed_content_hash = pcash_state::content_hash(&signed);
    assert_eq!(
        node.mempool.submit(signed).await.unwrap().status,
        MempoolStatus::Ready
    );
    let owner = signer_address(&SigningKey::from_slice(&[0x31; 32]).unwrap());
    apply_account_block_from(&node, direct, B256::repeat_byte(0xb6), owner);
    assert_eq!(
        node.mempool
            .transaction(&signed_content_hash)
            .unwrap()
            .unwrap()
            .status,
        "suspended"
    );
}

fn unfunded_contract_creation(node: &TestNode) -> Vec<u8> {
    let (recent, deadline) = {
        let guard = node.inner.lock().unwrap();
        (
            guard.state.canonical_tip().unwrap().hash,
            guard.state.last_l1_timestamp() + 600,
        )
    };
    Transaction::ContractAccountCreation(ContractAccountCreation {
        body: ContractBody::new(
            false,
            word(0x951),
            None,
            vec![ContractFunction {
                selector: 0,
                application_vk_hash: word(0x52),
                configuration_commitment: word(0x53),
            }],
        )
        .unwrap(),
        funding: ContractFunding::Unfunded {
            recent_pcash_block_hash: recent,
            valid_until_timestamp: deadline,
        },
    })
    .encode(PCASH_CHAIN_ID)
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unfunded_contract_gossips_and_prepares_without_a_verifier() {
    let root = tempfile::tempdir().unwrap();
    let config = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        100,
        B256::repeat_byte(0xfa),
    );
    let a_data = root.path().join("unfunded-a");
    let b_data = root.path().join("unfunded-b");
    std::fs::create_dir_all(&a_data).unwrap();
    std::fs::create_dir_all(&b_data).unwrap();
    let a_node = open_test_node(&a_data, &config);
    let b_node = open_test_node(&b_data, &config);
    let a_p2p = start_p2p(
        p2p_config(&a_data, node_capability(&a_node), Vec::new()),
        a_node.mempool.clone(),
    )
    .await
    .unwrap();
    let bootstrap = bootstrap_address(
        a_p2p.listen_address().await.unwrap(),
        a_p2p.handle.peer_id(),
    );
    let b_p2p = start_p2p(
        p2p_config(&b_data, node_capability(&b_node), vec![bootstrap]),
        b_node.mempool.clone(),
    )
    .await
    .unwrap();
    wait_for_peer(&a_p2p).await;
    wait_for_peer(&b_p2p).await;
    tokio::time::sleep(Duration::from_millis(1_250)).await;
    let raw = unfunded_contract_creation(&a_node);
    let content_hash = pcash_state::content_hash(&raw);
    let a_api = NodeHandle::new(a_node.inner.clone())
        .with_mempool(a_node.mempool.clone())
        .with_p2p(a_p2p.handle.clone(), a_p2p.listen_addresses_watch());
    let admitted = a_api.submit_raw_transaction(raw.clone()).await.unwrap();
    assert_eq!(admitted.kind, TransactionKind::ContractAccount);
    assert_eq!(
        admitted.funding_mode,
        Some(pcash_rpc::ContractFundingMode::Unfunded)
    );
    wait_for_entry_within(&b_node.mempool, content_hash, Duration::from_secs(3)).await;
    let b_entry = b_node.mempool.transaction(&content_hash).unwrap().unwrap();
    assert_eq!(
        b_entry.funding_mode,
        Some(pcash_rpc::ContractFundingMode::Unfunded)
    );
    assert_eq!(b_entry.raw_transaction, Some(raw.into()));
    let prepared = b_node
        .mempool
        .prepare(pcash_rpc::PrepareRelayRequest {
            content_hashes: vec![content_hash],
            controlled_issuance_owner_commitments: Vec::new(),
            controlled_issuance_content_hashes: Vec::new(),
            max_batch_bytes: 1_000,
        })
        .unwrap();
    assert_eq!(prepared.selected_content_hashes, vec![content_hash]);
    assert_eq!(prepared.selected_qualifying_actions, 0);
    assert_eq!(prepared.collectible_qualifying_actions, 0);
    assert_eq!(prepared.collectible_open_fee, U256::ZERO);
    b_p2p.handle.shutdown().await.unwrap();
    a_p2p.handle.shutdown().await.unwrap();
}

/// Error-level log output of every test in this binary. The node logs from its
/// own tasks, so the capture is the process-wide subscriber, installed once.
fn error_log() -> &'static Mutex<Vec<u8>> {
    struct Capture(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Capture {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    static LOG: OnceLock<Arc<Mutex<Vec<u8>>>> = OnceLock::new();
    LOG.get_or_init(|| {
        let log = Arc::new(Mutex::new(Vec::new()));
        let writer = log.clone();
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::ERROR)
            .with_ansi(false)
            .with_writer(move || Capture(writer.clone()))
            .init();
        log
    })
}

/// Derive an empty L1 block on top of the node's head and return the PCASH
/// block hash.
fn apply_empty_block(node: &TestNode, l1_block_hash: B256) -> B256 {
    let (number, parent_hash) = {
        let guard = node.inner.lock().unwrap();
        let head = guard.head.unwrap();
        (head + 1, *guard.block_hashes.get(&head).unwrap())
    };
    let block = L1BlockData::new(
        L1Header {
            number,
            hash: l1_block_hash,
            parent_hash,
            timestamp: 1_000,
        },
        Vec::new(),
    );
    node.inner
        .lock()
        .unwrap()
        .apply_block(&block, &BbProcessVerifier::new("unused-bb"))
        .unwrap()
        .committed_boundary
        .block
        .hash
}

fn divergence_count(metrics: &PrometheusMetrics) -> String {
    metrics
        .encode()
        .unwrap()
        .lines()
        .find(|line| line.starts_with("pcash_node_p2p_block_hash_divergences_total "))
        .expect("divergence counter is exported")
        .to_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn nodes_on_the_same_chain_report_no_block_hash_divergence() {
    let root = tempfile::tempdir().unwrap();
    let config = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        100,
        B256::repeat_byte(0xa6),
    );
    let a_data = root.path().join("a");
    let b_data = root.path().join("b");
    std::fs::create_dir_all(&a_data).unwrap();
    std::fs::create_dir_all(&b_data).unwrap();
    let a_node = open_test_node(&a_data, &config);
    let b_node = open_test_node(&b_data, &config);
    for l1_block_hash in [B256::repeat_byte(0x31), B256::repeat_byte(0x32)] {
        assert_eq!(
            apply_empty_block(&a_node, l1_block_hash),
            apply_empty_block(&b_node, l1_block_hash)
        );
    }

    let a_metrics = Arc::new(PrometheusMetrics::new());
    let b_metrics = Arc::new(PrometheusMetrics::new());
    let a_p2p = start_p2p_with_metrics(
        p2p_config(&a_data, node_capability(&a_node), Vec::new()),
        a_node.mempool.clone(),
        a_metrics.clone(),
    )
    .await
    .unwrap();
    let a_listen = a_p2p.listen_address().await.unwrap();
    let b_p2p = start_p2p_with_metrics(
        p2p_config(
            &b_data,
            node_capability(&b_node),
            vec![bootstrap_address(a_listen, a_p2p.handle.peer_id())],
        ),
        b_node.mempool.clone(),
        b_metrics.clone(),
    )
    .await
    .unwrap();
    wait_for_compatible_peer(&a_p2p).await;
    wait_for_compatible_peer(&b_p2p).await;

    // Several anti-entropy rounds, each of which compares heads.
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    for (p2p, metrics) in [(&a_p2p, &a_metrics), (&b_p2p, &b_metrics)] {
        assert!(p2p.peers().iter().all(|peer| peer.divergence.is_none()));
        assert_eq!(
            divergence_count(metrics),
            "pcash_node_p2p_block_hash_divergences_total 0"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_peer_advertising_another_block_hash_is_reported_and_derivation_continues() {
    let root = tempfile::tempdir().unwrap();
    let config = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        100,
        B256::repeat_byte(0xa7),
    );
    let data = root.path().join("node");
    std::fs::create_dir_all(&data).unwrap();
    let node = open_test_node(&data, &config);
    apply_empty_block(&node, B256::repeat_byte(0x41));
    let l1_block_hash = B256::repeat_byte(0x42);
    let block_hash = apply_empty_block(&node, l1_block_hash);
    let tip = node.inner.lock().unwrap().latest_block();

    let log = error_log();
    let metrics = Arc::new(PrometheusMetrics::new());
    let p2p = start_p2p_with_metrics(
        p2p_config(&data, node_capability(&node), Vec::new()),
        node.mempool.clone(),
        metrics.clone(),
    )
    .await
    .unwrap();
    let listen = p2p.listen_address().await.unwrap();
    let api = NodeHandle::new(node.inner.clone())
        .with_mempool(node.mempool.clone())
        .with_p2p(p2p.handle.clone(), p2p.listen_addresses_watch());

    // Two test peers claim L1 block 102. One names this node's L1 block with
    // another PCASH hash; the other is on another L1 fork at that height.
    let wrong_hash = B256::repeat_byte(0xee);
    let peer = |name: &str, heads: Vec<pcash_p2p::CanonicalHead>| {
        let dir = root.path().join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let config = p2p_config(
            &dir,
            node_capability(&node),
            vec![bootstrap_address(listen.clone(), p2p.handle.peer_id())],
        );
        async move {
            let (handle, events) = pcash_p2p::start(config).await.unwrap();
            handle.try_replace_heads(heads).unwrap();
            (handle, events)
        }
    };
    let (liar, mut liar_events) = peer(
        "liar",
        vec![pcash_p2p::CanonicalHead {
            l1_block_number: 102,
            l1_block_hash,
            block_hash: wrong_hash,
        }],
    )
    .await;
    let (forked, _forked_events) = peer(
        "forked",
        vec![pcash_p2p::CanonicalHead {
            l1_block_number: 102,
            l1_block_hash: B256::repeat_byte(0x99),
            block_hash: wrong_hash,
        }],
    )
    .await;

    let liar_id = liar.peer_id().to_string();
    let reported = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if let Some(peer) = AdminApi::peers(&api)
                .unwrap()
                .into_iter()
                .find(|peer| peer.peer_id == liar_id && peer.divergence.is_some())
            {
                break peer;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("divergence was not reported");
    assert_eq!(
        reported.divergence,
        Some(pcash_rpc::BlockHashDivergenceDto {
            l1_block_number: 102,
            l1_block_hash,
            local_block_hash: block_hash,
            peer_block_hash: wrong_hash,
        })
    );

    // Later rounds repeat the same claim; it is not reported again.
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    assert_eq!(
        divergence_count(&metrics),
        "pcash_node_p2p_block_hash_divergences_total 1"
    );
    let errors = String::from_utf8_lossy(&log.lock().unwrap()).into_owned();
    let lines = errors
        .lines()
        .filter(|line| line.contains(&liar_id))
        .collect::<Vec<_>>();
    assert_eq!(lines.len(), 1, "{lines:?}");
    for field in [
        "l1_block_number=102".to_owned(),
        format!("l1_block_hash={l1_block_hash}"),
        format!("local_block_hash={block_hash}"),
        format!("peer_block_hash={wrong_hash}"),
    ] {
        assert!(
            lines[0].contains(&field),
            "{field} missing from {}",
            lines[0]
        );
    }
    let peers = AdminApi::peers(&api).unwrap();
    let forked_id = forked.peer_id().to_string();
    let forked_peer = peers
        .iter()
        .find(|peer| peer.peer_id == forked_id)
        .expect("the forked peer stays connected");
    assert!(forked_peer.compatible);
    assert_eq!(forked_peer.divergence, None);
    let liar_peer = peers
        .iter()
        .find(|peer| peer.peer_id == liar_id)
        .expect("the reported peer stays connected");
    assert_eq!(liar_peer.score, 0);
    assert_eq!(liar_peer.banned_seconds, None);

    // The node advertises its real heads: the liar's own swarm compares them
    // with its claim and sees the same disagreement from the other side.
    let node_id = p2p.handle.peer_id();
    let liar_view = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            match liar_events.recv().await.expect("liar event stream") {
                P2pEvent::BlockHashDivergence { peer, divergence } if peer == node_id => {
                    break divergence;
                }
                _ => {}
            }
        }
    })
    .await
    .expect("the node did not advertise its heads");
    assert_eq!(
        liar_view,
        pcash_p2p::BlockHashDivergence {
            l1_block_number: 102,
            l1_block_hash,
            local_block_hash: wrong_hash,
            peer_block_hash: block_hash,
        }
    );

    // Derivation is untouched by the report.
    apply_empty_block(&node, B256::repeat_byte(0x43));
    assert_eq!(node.inner.lock().unwrap().latest_block(), tip + 1);
}
