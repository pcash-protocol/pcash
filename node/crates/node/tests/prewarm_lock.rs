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
//! Off-lock proof-prewarming test: a block's wire proofs are verified
//! BEFORE the node lock is taken, so `apply_block` — run under the lock exactly
//! as the follow loop runs it — issues zero verifier calls when the prewarm
//! covered every proof-bearing transaction. Follow uses complete-cache mode so a miss
//! fails closed without an under-lock verifier call; generic fallback mode
//! remains available and is tested separately.

mod common;

use common::{batch, item_results, word, ItemResult, SUCCEEDED};

use std::cell::Cell;
use std::sync::{Arc, Mutex};

use alloy_primitives::{Address, Bytes, B256};
use pcash_crypto::Fr;
use pcash_derive::private_value_profiles::PrivateValueShape;
use pcash_derive::{
    derive_prepared_block, prepare_block, AccountCreationAuthorization, PrivateValueSection,
    ProtocolRules, SectionLayout, Transaction, UserAccountCreation,
};
use pcash_l1::{L1BlockData, L1Header, L1Receipt, L1Tx};
use pcash_node::{build_node, NetworkConfig, NodeInner, DEFAULT_INBOX, L1_CHAIN_ID};
use pcash_state::{fr_to_bytes, CircuitWord, DerivationSource, StateDb, TransactionOutcome};
use pcash_verify::{CachedVerifier, Verifier, VerifyCache, VerifyError};

const PCASH_CHAIN_ID: u32 = 1346589512;
const GENESIS: u64 = 100;

/// A verifier that returns a fixed clean verdict and counts every invocation, so
/// a test can assert exactly how many verifications happened, and where.
struct Counting {
    calls: Cell<usize>,
    verdict: bool,
}
impl Counting {
    fn new(verdict: bool) -> Self {
        Self {
            calls: Cell::new(0),
            verdict,
        }
    }
    fn count(&self) -> usize {
        self.calls.get()
    }
}
impl Verifier for Counting {
    fn verify(&self, _: &[u8], _: &[u8], _: &[u8]) -> Result<bool, VerifyError> {
        self.calls.set(self.calls.get() + 1);
        Ok(self.verdict)
    }
}

struct Failing {
    calls: Cell<usize>,
}

impl Failing {
    fn new() -> Self {
        Self {
            calls: Cell::new(0),
        }
    }

    fn count(&self) -> usize {
        self.calls.get()
    }
}

impl Verifier for Failing {
    fn verify(&self, _: &[u8], _: &[u8], _: &[u8]) -> Result<bool, VerifyError> {
        self.calls.set(self.calls.get() + 1);
        Err(VerifyError::Abnormal {
            exit: "1".into(),
            stdout: String::new(),
            stderr: "off-lock verifier failure".into(),
        })
    }
}

/// A kind-0 private_value transaction whose public inputs pass validation
/// against the recent canonical snapshot, so the only remaining cryptographic
/// gate is the wire-proof verdict.
/// Distinct nullifiers make two of these distinct verification triples.
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
    // Dummy nullifiers for the two unused input slots: distinct from the
    // reals and from each other.
    let nul2 = nul0 + Fr::from(1_000_000u64);
    let nul3 = nul1 + Fr::from(2_000_000u64);
    Transaction::PrivateValue(
        PrivateValueSection::new(
            PrivateValueShape::S,
            PCASH_CHAIN_ID,
            &[
                recent_pcash_block_hash,
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
                // validUntilTimestamp is after block_at()'s header timestamp.
                word(1_800_000_000 + GENESIS + 200),
                word(0), // carrierContextHash
                word(0), // eventsCommitment
            ],
            vec![0u8; SectionLayout::PrivateValue(PrivateValueShape::S).proof_bytes()],
            [
                output_data0,
                output_data1,
                output_data2,
                output_data3,
                output_data4,
            ]
            .map(common::output_data)
            .to_vec(),
            common::arena(),
        )
        .unwrap(),
    )
    .encode(PCASH_CHAIN_ID)
    .unwrap()
}

/// A kind-1 user-account creation with a garbage signature: admitted, rejected
/// at derivation, so it commits a block that leaves the note/account state trees
/// empty — a warm-up whose end-of-block commit creates the first usable snapshot.
fn skipped_account() -> Vec<u8> {
    Transaction::UserAccountCreation(UserAccountCreation::new(
        word(7),
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

fn block_bytes(n: u64, tag: u8) -> B256 {
    let mut b = [0u8; 32];
    b[0] = tag;
    b[24..32].copy_from_slice(&n.to_be_bytes());
    B256::from(b)
}

/// A block at height `number` carrying one inbox transaction whose batch is
/// `items`.
fn block_at(number: u64, items: &[Vec<u8>]) -> L1BlockData {
    let header = L1Header {
        number,
        hash: block_bytes(number, 0xaa),
        parent_hash: block_bytes(number - 1, 0xaa),
        timestamp: 1_800_000_000 + number,
    };
    let tx = L1Tx {
        hash: block_bytes(number, 0xcc),
        from: Address::from([0x11u8; 20]),
        to: Some(DEFAULT_INBOX),
        input: Bytes::from(batch(items)),
        blob_versioned_hashes: Vec::new(),
        blob_resolution: Default::default(),
        tx_index: 0,
    };
    let receipt = L1Receipt { logs: Vec::new() };
    L1BlockData::new(header, vec![(tx, receipt)])
}

fn fresh_node(dir: &std::path::Path) -> Arc<Mutex<NodeInner>> {
    let cfg = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        GENESIS,
        block_bytes(GENESIS, 0xaa),
    );
    build_node(&dir.join("state.redb"), &cfg).unwrap()
}

/// The rules and source the follow loop captures for off-lock prewarming.
fn prewarm_inputs(inner: &Arc<Mutex<NodeInner>>) -> (Arc<ProtocolRules>, DerivationSource) {
    let node = inner.lock().unwrap();
    (Arc::clone(&node.rules), node.source)
}

fn two_transfers(recent_pcash_block_hash: B256) -> Vec<Vec<u8>> {
    vec![
        transfer_transaction(
            Fr::from(11u64),
            Fr::from(12u64),
            recent_pcash_block_hash,
            b"env-0a",
            b"env-0b",
            b"env-0c",
            b"env-0d",
            b"env-0e",
        ),
        transfer_transaction(
            Fr::from(21u64),
            Fr::from(22u64),
            recent_pcash_block_hash,
            b"env-1a",
            b"env-1b",
            b"env-1c",
            b"env-1d",
            b"env-1e",
        ),
    ]
}

/// The PCASH hash the warm-up block committed at GENESIS — the value the
/// GENESIS + 1 transfers must reference.
fn recent_pcash_block_hash(inner: &Arc<Mutex<NodeInner>>) -> B256 {
    inner.lock().unwrap().state.canonical_tip().unwrap().hash
}

/// Derive a warm-up block (a skipped record) at GENESIS so its end-of-block
/// commit creates the first usable recent PCASH block, exactly as a real chain's
/// earlier blocks do. The transfer block references that snapshot at GENESIS + 1.
fn warmup(inner: &Arc<Mutex<NodeInner>>) {
    let block = block_at(GENESIS, &[skipped_account()]);
    let v = Counting::new(true);
    let mut g = inner.lock().unwrap();
    g.apply_block(&block, &v).unwrap();
    // A garbage-signature record never reaches proof verification.
    assert_eq!(v.count(), 0, "account writes carry no wire proof");
}

/// Prewarm covering every proof-bearing transaction ⇒ zero verifier calls while the
/// node lock is held, and the memoized verdicts still drive derivation.
#[test]
fn prewarm_covers_block_zero_verifier_calls_under_lock() {
    let tmp = tempfile::tempdir().unwrap();
    let inner = fresh_node(tmp.path());
    let (rules, source) = prewarm_inputs(&inner);
    warmup(&inner);

    let recent_pcash_block_hash = recent_pcash_block_hash(&inner);
    let block = block_at(GENESIS + 1, &two_transfers(recent_pcash_block_hash));
    let counter = Counting::new(true);

    // Prewarm OUTSIDE the lock: each distinct proof-bearing transaction is verified once.
    let prepared = prepare_block(&block, &rules, &source, &counter);
    let after_prewarm = counter.count();
    assert_eq!(after_prewarm, 2, "prewarm verified each proof exactly once");

    // Under the lock — exactly the follow loop's critical section.
    let outcome = {
        let mut g = inner.lock().unwrap();
        let cached = CachedVerifier::new(prepared.cache(), &counter);
        g.apply_block(&block, &cached).unwrap()
    };

    assert_eq!(
        counter.count(),
        after_prewarm,
        "no verifier call may happen while the lock is held when the prewarm covered every transaction"
    );
    // The cached accepts flowed through: both transfers derived as accepted.
    assert_eq!(
        item_results(&outcome),
        [SUCCEEDED; 2],
        "a cache-hit accept must derive as accepted"
    );
    assert_eq!(
        inner.lock().unwrap().state.output_count(),
        12,
        "two accepted transfers append five ordinary outputs and one issuance note each"
    );
}

/// The generic fallback constructor still delegates a miss to the inner
/// verifier. Follow does not use this mode; it uses `new_complete`, tested below.
#[test]
fn prewarm_miss_falls_back_to_inner_verifier_under_lock() {
    let tmp = tempfile::tempdir().unwrap();
    let inner = fresh_node(tmp.path());
    warmup(&inner);

    let recent_pcash_block_hash = recent_pcash_block_hash(&inner);
    let block = block_at(GENESIS + 1, &two_transfers(recent_pcash_block_hash));
    let reject = Counting::new(false);
    let empty = VerifyCache::new();

    let outcome = {
        let mut g = inner.lock().unwrap();
        let cached = CachedVerifier::new(&empty, &reject);
        g.apply_block(&block, &cached).unwrap()
    };

    // Empty cache ⇒ every proof misses ⇒ the inner verifier is consulted once each.
    assert_eq!(
        reject.count(),
        2,
        "an empty cache forces both proofs through the inner verifier"
    );
    // The inner reject verdict is respected on the miss path.
    assert_eq!(
        item_results(&outcome),
        [ItemResult::Admitted(TransactionOutcome::ProofRejected); 2],
        "a miss must route to the inner verdict (reject → ProofRejected)"
    );
    assert_eq!(
        inner.lock().unwrap().state.output_count(),
        0,
        "rejected transfers append no notes"
    );
}

#[test]
fn cached_tool_failure_surfaces_only_when_derivation_reaches_proof() {
    // A transaction whose recent-block-hash fails the state window is proof-bearing
    // and therefore prewarmed, but the engine skips it before verification
    // (state-dependent gate). Its cached tool failure must remain dormant and
    // must not change the block outcome.
    {
        let tmp = tempfile::tempdir().unwrap();
        let inner = fresh_node(tmp.path());
        let (rules, source) = prewarm_inputs(&inner);
        warmup(&inner);
        let recent_pcash_block_hash = recent_pcash_block_hash(&inner);
        let mut transaction = two_transfers(recent_pcash_block_hash).remove(0);
        // a canonical word that simply is not any recent PCASH block hash
        transaction[33..65].copy_from_slice(B256::repeat_byte(0x2a).as_slice());
        let block = block_at(GENESIS + 1, &[transaction]);
        let failing = Failing::new();
        let prepared = prepare_block(&block, &rules, &source, &failing);
        assert_eq!(failing.count(), 1);

        let outcome = {
            let mut guard = inner.lock().unwrap();
            let cached = CachedVerifier::new_complete(prepared.cache(), &failing);
            guard.apply_block(&block, &cached).unwrap()
        };
        assert_eq!(
            item_results(&outcome),
            [ItemResult::Admitted(
                TransactionOutcome::RecentPcashBlockNotInWindow
            )]
        );
        assert_eq!(
            failing.count(),
            1,
            "skipped transaction must not consult cached error"
        );
    }

    // A valid-shape transaction reaches verification, so the exact cached failure is
    // fatal without invoking the inner verifier again under the state lock.
    {
        let tmp = tempfile::tempdir().unwrap();
        let inner = fresh_node(tmp.path());
        let (rules, source) = prewarm_inputs(&inner);
        warmup(&inner);
        let recent_pcash_block_hash = recent_pcash_block_hash(&inner);
        let block = block_at(
            GENESIS + 1,
            &[two_transfers(recent_pcash_block_hash).remove(0)],
        );
        let failing = Failing::new();
        let prepared = prepare_block(&block, &rules, &source, &failing);
        assert_eq!(failing.count(), 1);

        let error = {
            let mut guard = inner.lock().unwrap();
            let cached = CachedVerifier::new_complete(prepared.cache(), &failing);
            guard.apply_block(&block, &cached).unwrap_err()
        };
        assert!(error.to_string().contains("cached verifier tool failure"));
        assert_eq!(
            failing.count(),
            1,
            "cached failure must not retry the inner verifier under lock"
        );
    }
}

#[test]
fn complete_cache_miss_fails_without_under_lock_verifier_call() {
    let tmp = tempfile::tempdir().unwrap();
    let inner = fresh_node(tmp.path());
    warmup(&inner);
    let recent_pcash_block_hash = recent_pcash_block_hash(&inner);
    let block = block_at(
        GENESIS + 1,
        &[two_transfers(recent_pcash_block_hash).remove(0)],
    );
    let inner_verifier = Counting::new(true);
    let empty = VerifyCache::new();

    let error = {
        let mut guard = inner.lock().unwrap();
        let cached = CachedVerifier::new_complete(&empty, &inner_verifier);
        guard.apply_block(&block, &cached).unwrap_err()
    };
    assert!(error.to_string().contains("complete verifier cache miss"));
    assert_eq!(inner_verifier.count(), 0);
}

#[test]
fn prepared_path_surfaces_cached_tool_failure_only_at_reached_proof() {
    let temp = tempfile::tempdir().unwrap();
    let inner = fresh_node(temp.path());
    warmup(&inner);
    let (rules, source) = prewarm_inputs(&inner);
    let recent = recent_pcash_block_hash(&inner);
    let block = block_at(GENESIS + 1, &[two_transfers(recent).remove(0)]);
    let failing = Failing::new();
    let prepared = prepare_block(&block, &rules, &source, &failing);
    assert_eq!(failing.count(), 1, "proof was verified off lock");
    let error = {
        let mut node = inner.lock().unwrap();
        let cached = CachedVerifier::new_complete(prepared.cache(), &failing);
        derive_prepared_block(&mut node.state, &prepared, &cached).unwrap_err()
    };
    assert!(error.to_string().contains("cached verifier tool failure"));
    assert_eq!(failing.count(), 1, "derivation did not retry the tool");
}
