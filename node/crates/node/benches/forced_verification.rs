//! Worst-case forced proof verification, with the pinned verifier.
//!
//! Run with:
//! `just bench-forced-verification`
//!
//! which is `cargo bench -p pcash-node --features benchmarks --bench
//! forced_verification` inside `node scripts/circuits/bundle.mjs exec --`. The
//! pinned `bb` comes from `PCASH_TOOL_ROOT`; the release S proof and its public
//! inputs come from the circuit bundle's `private_value` known answer.
//!
//! Every proof a node verifies arrived on Ethereum, so the most verification
//! one block can force is the most distinct proof-bearing items its gas and
//! blob limits can carry. Each must pass every check before its proof and miss
//! the verify cache. An attacker gets both from one valid proof of their own:
//! copies mutated apart share its statement, and each fails as
//! `ProofRejected` and consumes nothing, so the next copy passes the same
//! checks. How long a rejection takes depends on where verification fails.
//!
//! The verifier cases time the release proof, its negative known answer, a
//! rejection caused by the statement alone, and a mutation of every proof
//! word after the accumulator under the release statement, keeping the word
//! whose rejection is slowest: the attacker's copy.
//!
//! The block cases derive whole blocks through `NodeInner::apply_block`:
//! receipt normalization, carrier extraction and context hashing, prewarm,
//! execution, the canonical commit, and the derived index. A case is
//! `calldata/events/blobs`: items in Inbox calldata, carrier events of one
//! item each, and items in Inbox blobs (four per blob, at most six blobs per
//! transaction). Block items are profile-S transfers that pass every check
//! before their proof (recent block, time bounds, no carrier context, nonzero,
//! distinct, unspent nullifiers) and carry the release proof mutated at that
//! word. Their statements are not the release statement, so bb rejects them
//! early; each measured block is therefore followed by the same count of the
//! attacker's copies verified one after another as prewarm verifies them, and
//! `worst_block` is the block without its own verification plus that prewarm.
//! The parallel cases split the largest case's copies across that many
//! verifier workers.
//!
//! Settings: `PCASH_BENCH_FORCED_CASES` (default `59/0/84,0/233/0,0/233/84`),
//! `PCASH_BENCH_FORCED_WARMUP_BLOCKS` (1), `PCASH_BENCH_FORCED_MEASURE_BLOCKS`
//! (3), `PCASH_BENCH_VERIFY_RUNS` (7), `PCASH_BENCH_PARALLEL_WORKERS`
//! (`1,2,4,8,16`), and `PCASH_BENCH_REJECTION_SITE` to skip the word sweep. An
//! empty list skips its phase. `HARDWARE_CONCURRENCY` reaches `bb` and sets
//! its thread count.

#![allow(
    clippy::print_stdout,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "benchmark harness prints measurements and expects infallible fixture construction"
)]

use std::cell::Cell;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use alloy_primitives::{Address, Bytes, B256};
use pcash_derive::private_value_profiles::{PrivateValueShape, S};
use pcash_derive::{
    admit, Batch, BatchVersion, PrivateValueSection, ProofStatement, ProtocolRules, Transaction,
    OUTPUT_DATA_BYTES,
};
use pcash_l1::{
    BlobResolution, CarrierKind, L1BlockData, L1Header, L1Log, L1Receipt, L1Tx, PCASH_BATCH_TOPIC,
};
use pcash_node::{build_node, NetworkConfig, DEFAULT_INBOX, L1_CHAIN_ID, PCASH_CHAIN_ID};
use pcash_state::{CircuitWord, Fr, StateDb, TransactionOutcome};
use pcash_verify::{BbProcessVerifier, Verifier, VerifyError};

const GENESIS: u64 = 10_000_000;
const GENESIS_TIMESTAMP: u64 = 1_800_000_000;
const SLOT_SECONDS: u64 = 12;
/// EIP-7825 caps one Ethereum transaction at 2^24 gas, about 65 one-item
/// carrier events.
const EVENTS_PER_TX: usize = 65;
/// Calldata items per Inbox transaction under the same cap at the EIP-7623
/// floor, about 1.0M gas for an item whose output data and arena are zero.
const CALLDATA_ITEMS_PER_TX: usize = 16;
const ITEMS_PER_BLOB: usize = 4;
const BLOBS_PER_TX: usize = 6;
const DEFAULT_CASES: &str = "59/0/84,0/233/0,0/233/84";
const DEFAULT_WORKERS: &str = "1,2,4,8,16";
/// A posted proof opens with the hiding kernel's accumulator: 28 limbs that
/// bb converts to points before verifying.
const ACCUMULATOR_WORDS: usize = 28;

fn env_usize(name: &str, default: usize) -> usize {
    match std::env::var(name) {
        Ok(value) => value
            .parse::<usize>()
            .unwrap_or_else(|error| panic!("{name} must be a whole number: {error}")),
        Err(_) => default,
    }
}

fn env_list(name: &str, default: &str) -> Vec<String> {
    std::env::var(name)
        .unwrap_or_else(|_| default.to_owned())
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

fn median(samples: &mut [Duration]) -> Duration {
    samples.sort();
    samples[samples.len() / 2]
}

fn hash(number: u64) -> B256 {
    let mut bytes = [0u8; 32];
    bytes[24..].copy_from_slice(&number.to_be_bytes());
    B256::from(bytes)
}

fn address(number: u64) -> Address {
    let mut bytes = [0u8; 20];
    bytes[12..].copy_from_slice(&number.to_be_bytes());
    Address::from(bytes)
}

/// A canonical word with a high tag byte below the field modulus's `0x30`.
fn tagged_word(tag: u8, value: u64) -> CircuitWord {
    let mut bytes = [0u8; 32];
    bytes[0] = tag;
    bytes[24..].copy_from_slice(&value.to_be_bytes());
    CircuitWord::from(bytes)
}

fn small_word(value: u64) -> CircuitWord {
    tagged_word(0, value)
}

/// The release profile-S proof, its public inputs, and its rejected variant.
struct KnownAnswer {
    proof: Vec<u8>,
    rejected: Vec<u8>,
    public_inputs: Vec<u8>,
}

impl KnownAnswer {
    fn read() -> Self {
        let bundle = std::env::var("PCASH_CIRCUIT_BUNDLE")
            .ok()
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .expect("run inside `node scripts/circuits/bundle.mjs exec --`");
        let known = bundle.join("known-answers").join("private_value");
        let read = |name: &str| std::fs::read(known.join(name)).unwrap();
        let answer = Self {
            proof: read("proof"),
            rejected: read("proof.rejected"),
            public_inputs: read("public_inputs"),
        };
        assert_eq!(answer.public_inputs.len(), S.public_inputs * 32);
        answer
    }

    fn word(&self, offset: usize) -> CircuitWord {
        CircuitWord::from(<[u8; 32]>::try_from(&self.public_inputs[offset * 32..][..32]).unwrap())
    }

    /// The release proof with the low eight bytes of proof word `word` XORed
    /// with `tag`.
    fn mutated_proof(&self, word: usize, tag: u64) -> Vec<u8> {
        assert_ne!(tag, 0);
        let mut proof = self.proof.clone();
        let end = (word + 1) * 32;
        for (byte, mask) in proof[end - 8..end].iter_mut().zip(tag.to_be_bytes()) {
            *byte ^= mask;
        }
        proof
    }
}

/// One forced-verification item: a profile-S transfer valid in a block at
/// `timestamp` on top of `recent`, with nullifiers distinct by `tag` and the
/// release proof mutated at word `site` by `tag`.
fn forced_item(
    known: &KnownAnswer,
    recent: B256,
    timestamp: u64,
    site: usize,
    tag: u64,
) -> Vec<u8> {
    let profile = S;
    let mut wire = Vec::with_capacity(profile.wire_inputs);
    for offset in 0..profile.public_inputs {
        if offset == profile.chain_id_offset || offset == profile.delivery_commitment_offset {
            continue;
        }
        let word = if offset == profile.recent_block_hash_offset {
            CircuitWord::from(recent.0)
        } else if (profile.nullifiers_offset..profile.nullifiers_offset + profile.inputs)
            .contains(&offset)
        {
            tagged_word(0x0e, tag * 16 + (offset - profile.nullifiers_offset) as u64)
        } else if offset == profile.not_before_offset {
            small_word(0)
        } else if offset == profile.valid_until_offset {
            small_word(timestamp + 600)
        } else if offset == profile.carrier_context_hash_offset {
            CircuitWord::ZERO
        } else {
            known.word(offset)
        };
        wire.push(word);
    }
    let section = PrivateValueSection::new(
        PrivateValueShape::S,
        PCASH_CHAIN_ID,
        &wire,
        known.mutated_proof(site, tag),
        // Zero output data and arena: the cheapest calldata, and any bytes
        // serve a proof that commits them.
        vec![vec![0; OUTPUT_DATA_BYTES]; profile.outputs],
        vec![0; profile.arena_bytes],
    )
    .unwrap();
    Transaction::PrivateValue(section)
        .encode(PCASH_CHAIN_ID)
        .unwrap()
}

fn batch(items: &[Vec<u8>]) -> Vec<u8> {
    Batch {
        version: BatchVersion::V1,
        poster_owner_commitment: Fr::from(0xbeef_u64),
        poster_context: B256::ZERO,
        items: items.iter().map(Vec::as_slice).collect(),
    }
    .encode()
    .unwrap()
}

/// The canonical ABI encoding of `PcashBatch(bytes context, bytes batch)` data
/// with an empty context.
fn carrier_event_data(batch: &[u8]) -> Bytes {
    let word = |value: usize| {
        let mut out = [0u8; 32];
        out[24..].copy_from_slice(&(value as u64).to_be_bytes());
        out
    };
    let mut data = Vec::with_capacity(128 + batch.len().next_multiple_of(32));
    data.extend(word(0x40));
    data.extend(word(0x60));
    data.extend(word(0));
    data.extend(word(batch.len()));
    data.extend(batch);
    data.resize(128 + batch.len().next_multiple_of(32), 0);
    Bytes::from(data)
}

#[derive(Clone, Copy)]
struct Case {
    calldata: usize,
    events: usize,
    blobs: usize,
}

impl Case {
    fn parse(text: &str) -> Self {
        let parts: Vec<usize> = text
            .split('/')
            .map(|part| part.parse().expect("a case is calldata/events/blobs"))
            .collect();
        let [calldata, events, blobs] = parts[..] else {
            panic!("a case is calldata/events/blobs, got {text}");
        };
        Self {
            calldata,
            events,
            blobs,
        }
    }

    fn items(self) -> usize {
        self.calldata + self.events + self.blobs
    }

    fn label(self) -> String {
        format!(
            "calldata={} events={} blobs={}",
            self.calldata, self.events, self.blobs
        )
    }
}

/// What one Ethereum transaction of a forced block carries.
enum Carriage {
    Calldata(Vec<u8>),
    Events(Vec<Bytes>),
    /// One resolved blob batch and the number of blobs that carry it.
    Blobs(Vec<u8>, usize),
}

/// The attacker contract that emits carrier events.
const EMITTER: u64 = 0x7007;

fn forced_tx(number: u64, index: u64, carriage: Carriage) -> (L1Tx, L1Receipt) {
    let mut versioned = [0x55u8; 32];
    versioned[0] = 0x01;
    let (to, input, blob_versioned_hashes, blob_resolution, logs) = match carriage {
        Carriage::Calldata(batch) => (
            DEFAULT_INBOX,
            batch,
            Vec::new(),
            BlobResolution::Unresolved,
            Vec::new(),
        ),
        Carriage::Events(logs) => (
            address(EMITTER),
            Vec::new(),
            Vec::new(),
            BlobResolution::Unresolved,
            logs,
        ),
        Carriage::Blobs(batch, blobs) => (
            DEFAULT_INBOX,
            Vec::new(),
            vec![B256::from(versioned); blobs],
            BlobResolution::Batch(Bytes::from(batch)),
            Vec::new(),
        ),
    };
    let logs = logs
        .into_iter()
        .enumerate()
        .map(|(log_index, data)| L1Log {
            transaction_index: index,
            log_index: log_index as u64,
            emitter: address(EMITTER),
            topics: vec![PCASH_BATCH_TOPIC],
            data,
        })
        .collect();
    let tx = L1Tx {
        hash: hash(number << 16 | index),
        from: address(0xa000 + index),
        to: Some(to),
        input: Bytes::from(input),
        blob_versioned_hashes,
        blob_resolution,
        tx_index: index,
    };
    (tx, L1Receipt { logs })
}

/// An L1 block at `number` carrying `case`'s items, each built by `item`
/// from its block-wide ordinal.
fn forced_block(number: u64, case: Case, mut item: impl FnMut(usize) -> Vec<u8>) -> L1BlockData {
    let mut ordinal = 0;
    let mut next_items = |count: usize| -> Vec<Vec<u8>> {
        let items = (ordinal..ordinal + count).map(&mut item).collect();
        ordinal += count;
        items
    };
    let mut carriages = Vec::new();
    let mut remaining = case.calldata;
    while remaining > 0 {
        let count = remaining.min(CALLDATA_ITEMS_PER_TX);
        remaining -= count;
        carriages.push(Carriage::Calldata(batch(&next_items(count))));
    }
    let mut remaining = case.events;
    while remaining > 0 {
        let count = remaining.min(EVENTS_PER_TX);
        remaining -= count;
        let logs = (0..count)
            .map(|_| carrier_event_data(&batch(&next_items(1))))
            .collect();
        carriages.push(Carriage::Events(logs));
    }
    let mut remaining = case.blobs;
    while remaining > 0 {
        let count = remaining.min(ITEMS_PER_BLOB * BLOBS_PER_TX);
        remaining -= count;
        carriages.push(Carriage::Blobs(
            batch(&next_items(count)),
            count.div_ceil(ITEMS_PER_BLOB),
        ));
    }
    let txs: Vec<_> = carriages
        .into_iter()
        .enumerate()
        .map(|(index, carriage)| forced_tx(number, index as u64, carriage))
        .collect();
    L1BlockData::new(
        L1Header {
            number,
            hash: hash(number),
            parent_hash: hash(number - 1),
            timestamp: GENESIS_TIMESTAMP + (number - GENESIS) * SLOT_SECONDS,
        },
        txs,
    )
}

/// The real verifier, timed: total time inside it and its verdicts.
struct TimingVerifier<'a> {
    inner: &'a BbProcessVerifier,
    elapsed: Cell<Duration>,
    accepted: Cell<usize>,
    rejected: Cell<usize>,
}

impl<'a> TimingVerifier<'a> {
    fn new(inner: &'a BbProcessVerifier) -> Self {
        Self {
            inner,
            elapsed: Cell::new(Duration::ZERO),
            accepted: Cell::new(0),
            rejected: Cell::new(0),
        }
    }
}

impl Verifier for TimingVerifier<'_> {
    fn verify(&self, vk: &[u8], proof: &[u8], public_inputs: &[u8]) -> Result<bool, VerifyError> {
        let started = Instant::now();
        let verdict = self.inner.verify(vk, proof, public_inputs);
        self.elapsed.set(self.elapsed.get() + started.elapsed());
        match verdict {
            Ok(true) => self.accepted.set(self.accepted.get() + 1),
            Ok(false) => self.rejected.set(self.rejected.get() + 1),
            Err(_) => {}
        }
        verdict
    }
}

fn time_verification(
    verifier: &BbProcessVerifier,
    runs: usize,
    vk: &[u8],
    proof: &[u8],
    public_inputs: &[u8],
    expected: bool,
) -> Duration {
    let mut samples: Vec<Duration> = (0..runs)
        .map(|_| {
            let started = Instant::now();
            let verdict = verifier.verify(vk, proof, public_inputs).unwrap();
            let elapsed = started.elapsed();
            assert_eq!(verdict, expected);
            elapsed
        })
        .collect();
    median(&mut samples)
}

/// The statement a node verifies for `raw` in a block at `timestamp`.
fn statement(rules: &ProtocolRules, raw: &[u8], timestamp: u64) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let admitted = admit(raw, rules, PCASH_CHAIN_ID, timestamp, CarrierKind::Event).unwrap();
    let statement = ProofStatement::of(rules, &admitted).unwrap();
    (
        statement.vk.to_vec(),
        statement.proof.to_vec(),
        statement.public_inputs,
    )
}

/// The proof word whose mutations, under the release statement, take longest
/// to reject. A mutation that fails decompression, as many do at a
/// compressed point, is rejected at once, so a word counts only as fast as
/// the fastest of several mutations; the slowest few words are timed again
/// over `runs` further distinct mutations, and the word with the slowest
/// fastest one wins.
fn slowest_rejection_site(
    verifier: &BbProcessVerifier,
    vk: &[u8],
    known: &KnownAnswer,
    runs: usize,
) -> (usize, Duration) {
    const SWEEP_TAGS: u64 = 4;
    const RETIMED: usize = 8;
    let fastest_of = |site: usize, round: u64, tags: u64| -> Result<Vec<Duration>, String> {
        (1..=tags)
            .map(|tag| {
                let proof = known.mutated_proof(site, round << 32 | tag);
                let started = Instant::now();
                match verifier.verify(vk, &proof, &known.public_inputs) {
                    Ok(false) => Ok(started.elapsed()),
                    Ok(true) => panic!("a mutation of word {site} verified"),
                    Err(error) => Err(format!("word {site}: {error}")),
                }
            })
            .collect()
    };
    let mut no_verdict = Vec::new();
    let mut sites: Vec<(Duration, usize)> = (ACCUMULATOR_WORDS..known.proof.len() / 32)
        .filter_map(|site| match fastest_of(site, 1, SWEEP_TAGS) {
            Ok(times) => Some((times.into_iter().min().unwrap(), site)),
            Err(error) => {
                no_verdict.push(error);
                None
            }
        })
        .collect();
    assert!(
        no_verdict.is_empty(),
        "mutations without a verdict:\n{}",
        no_verdict.join("\n")
    );
    sites.sort_by(|a, b| b.0.cmp(&a.0));
    let swept = sites.len();
    let mut slowest: Vec<(Duration, Duration, usize)> = sites[..RETIMED]
        .iter()
        .map(|&(_, site)| {
            let mut times = fastest_of(site, 2, runs as u64).unwrap();
            let fastest = *times.iter().min().unwrap();
            (fastest, median(&mut times), site)
        })
        .collect();
    slowest.sort_by(|a, b| b.0.cmp(&a.0));
    let listed: Vec<String> = slowest
        .iter()
        .map(|(fastest, median, site)| {
            format!("{site}:{:.2}/{:.2}", millis(*fastest), millis(*median))
        })
        .collect();
    let fastest = sites.last().unwrap();
    println!(
        "rejection_sites swept={swept} slowest_ms_min/median=[{}] fastest_ms={:.2}@{}",
        listed.join(" "),
        millis(fastest.0),
        fastest.1,
    );
    (slowest[0].2, slowest[0].1)
}

fn benchmark_verifier(
    verifier: &BbProcessVerifier,
    rules: &ProtocolRules,
    known: &KnownAnswer,
    runs: usize,
) -> Worst {
    let vk = rules.private_value_hiding_kernel_vk(PrivateValueShape::S);
    let valid = time_verification(verifier, runs, vk, &known.proof, &known.public_inputs, true);
    let rejected = time_verification(
        verifier,
        runs,
        vk,
        &known.rejected,
        &known.public_inputs,
        false,
    );
    let mut changed = known.public_inputs.clone();
    changed[S.nullifiers_offset * 32 + 31] ^= 1;
    let statement_only = time_verification(verifier, runs, vk, &known.proof, &changed, false);
    let (site, slowest) = match std::env::var("PCASH_BENCH_REJECTION_SITE") {
        Ok(site) => {
            let site = site
                .parse()
                .expect("PCASH_BENCH_REJECTION_SITE is a word index");
            let mut times: Vec<Duration> = (1..=runs as u64)
                .map(|tag| {
                    let proof = known.mutated_proof(site, 2 << 32 | tag);
                    let started = Instant::now();
                    assert!(!verifier.verify(vk, &proof, &known.public_inputs).unwrap());
                    started.elapsed()
                })
                .collect();
            (site, median(&mut times))
        }
        Err(_) => slowest_rejection_site(verifier, vk, known, runs),
    };
    let timestamp = GENESIS_TIMESTAMP + SLOT_SECONDS;
    let raw = forced_item(known, hash(GENESIS), timestamp, site, 1);
    let (item_vk, item_proof, item_inputs) = statement(rules, &raw, timestamp);
    let item = time_verification(verifier, runs, &item_vk, &item_proof, &item_inputs, false);
    println!(
        "verify_ms_median runs={runs} valid={:.2} known_answer_rejected={:.2} statement_rejected={:.2} slowest_rejection={:.2}@word{site} block_item_rejected={:.2} item_tx_bytes={}",
        millis(valid),
        millis(rejected),
        millis(statement_only),
        millis(slowest),
        millis(item),
        raw.len(),
    );
    Worst {
        vk: vk.to_vec(),
        site,
    }
}

/// The attacker's slowest rejection: the release statement, whose checks
/// before the proof pass for whoever proved it, with the proof mutated at
/// `site`.
struct Worst {
    vk: Vec<u8>,
    site: usize,
}

impl Worst {
    /// `items` distinct proofs, as one attacker's block would carry, tagged
    /// apart from every other `round`'s.
    fn proofs(&self, known: &KnownAnswer, round: u64, items: usize) -> Vec<Vec<u8>> {
        (1..=items as u64)
            .map(|ordinal| known.mutated_proof(self.site, round << 32 | ordinal))
            .collect()
    }
}

/// Verify `proofs` against the release statement on `verifier`, one after
/// another, as prewarm does.
fn sequential_prewarm(
    verifier: &BbProcessVerifier,
    worst: &Worst,
    known: &KnownAnswer,
    proofs: &[Vec<u8>],
) -> Duration {
    let started = Instant::now();
    for proof in proofs {
        assert!(!verifier
            .verify(&worst.vk, proof, &known.public_inputs)
            .unwrap());
    }
    started.elapsed()
}

fn benchmark_block(
    verifier: &BbProcessVerifier,
    worst: &Worst,
    known: &KnownAnswer,
    case: Case,
    warmup_blocks: usize,
    measure_blocks: usize,
) {
    let temp = tempfile::tempdir().expect("create benchmark directory");
    let cfg = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        GENESIS,
        hash(GENESIS),
    );
    let shared = build_node(&temp.path().join("state.redb"), &cfg).expect("build benchmark node");
    let mut node = shared.lock().expect("benchmark node lock");
    let genesis = L1BlockData::new(
        L1Header {
            number: GENESIS,
            hash: hash(GENESIS),
            parent_hash: hash(GENESIS - 1),
            timestamp: GENESIS_TIMESTAMP,
        },
        Vec::new(),
    );
    node.apply_block(&genesis, verifier)
        .expect("genesis must derive");
    node.state.set_persist_reorg_savepoint(true);

    let mut totals = Vec::new();
    let mut verifications = Vec::new();
    let mut normalizations = Vec::new();
    let mut prewarms = Vec::new();
    let mut log_bytes = 0;
    for offset in 1..=(warmup_blocks + measure_blocks) as u64 {
        let number = GENESIS + offset;
        let recent = node.state.canonical_tip().unwrap().hash;
        let timestamp = GENESIS_TIMESTAMP + offset * SLOT_SECONDS;
        let block = forced_block(number, case, |ordinal| {
            let tag = offset << 32 | (ordinal as u64 + 1);
            forced_item(known, recent, timestamp, worst.site, tag)
        });
        log_bytes = block
            .txs
            .iter()
            .flat_map(|(_, receipt)| &receipt.logs)
            .map(|log| log.data.len())
            .sum::<usize>();
        // Receipt normalization alone, on a copy with its own empty cache.
        let copy = block.clone();
        let started = Instant::now();
        std::hint::black_box(copy.normalized_logs());
        let normalization = started.elapsed();

        let timed = TimingVerifier::new(verifier);
        let started = Instant::now();
        let outcome = node
            .apply_block(&block, &timed)
            .expect("forced block derives");
        let total = started.elapsed();

        let results = &outcome.committed_boundary.block.transaction_results;
        assert_eq!(results.len(), case.items());
        assert!(results
            .iter()
            .all(|result| result.outcome == TransactionOutcome::ProofRejected));
        assert_eq!(
            timed.rejected.get(),
            case.items(),
            "one verification per item"
        );
        assert_eq!(timed.accepted.get(), 0);
        if offset > warmup_blocks as u64 {
            totals.push(total);
            verifications.push(timed.elapsed.get());
            normalizations.push(normalization);
            // The same count of the attacker's slowest rejections, verified
            // as prewarm verifies them, in place of the block's own.
            let proofs = worst.proofs(known, offset, case.items());
            prewarms.push(sequential_prewarm(verifier, worst, known, &proofs));
        }
    }
    let mean = |samples: &[Duration]| samples.iter().sum::<Duration>() / samples.len() as u32;
    let total = mean(&totals);
    let verification = mean(&verifications);
    let items = case.items() as u32;
    println!(
        "block {} items={} log_bytes={log_bytes} blocks={}: total_ms mean={:.0} max={:.0} verify_ms={:.0} per_verification_ms={:.2} other_ms={:.0} normalization_ms={:.0}",
        case.label(),
        case.items(),
        totals.len(),
        millis(total),
        millis(*totals.iter().max().unwrap()),
        millis(verification),
        millis(verification / items),
        millis(total.saturating_sub(verification)),
        millis(mean(&normalizations)),
    );
    let worst_blocks: Vec<Duration> = totals
        .iter()
        .zip(&verifications)
        .zip(&prewarms)
        .map(|((total, verification), prewarm)| total.saturating_sub(*verification) + *prewarm)
        .collect();
    let prewarm = mean(&prewarms);
    let worst_block = mean(&worst_blocks);
    println!(
        "worst_block {} items={}: prewarm_ms={:.0} per_verification_ms={:.2} block_ms mean={:.0} min={:.0} max={:.0} slot_share={:.2}",
        case.label(),
        case.items(),
        millis(prewarm),
        millis(prewarm / items),
        millis(worst_block),
        millis(*worst_blocks.iter().min().unwrap()),
        millis(*worst_blocks.iter().max().unwrap()),
        worst_block.as_secs_f64() / SLOT_SECONDS as f64,
    );
}

/// Verify `items` of the attacker's slowest rejections across `workers`
/// independent verifier workers, as a parallel prewarm would.
fn benchmark_parallel(worst: &Worst, known: &KnownAnswer, items: usize, workers: usize) {
    let proofs = worst.proofs(known, 0, items);
    let verifiers: Vec<_> = (0..workers)
        .map(|_| {
            let verifier = BbProcessVerifier::from_env().expect("pinned bb (set PCASH_TOOL_ROOT)");
            verifier.assert_known_answers().unwrap();
            verifier
        })
        .collect();
    let started = Instant::now();
    std::thread::scope(|scope| {
        for (worker, verifier) in verifiers.iter().enumerate() {
            let share: Vec<_> = proofs
                .iter()
                .skip(worker)
                .step_by(workers)
                .cloned()
                .collect();
            scope.spawn(move || sequential_prewarm(verifier, worst, known, &share));
        }
    });
    let elapsed = started.elapsed();
    println!(
        "parallel workers={workers} items={items}: wall_ms={:.0} per_item_ms={:.2}",
        millis(elapsed),
        millis(elapsed / items as u32),
    );
}

fn main() {
    let cases: Vec<Case> = env_list("PCASH_BENCH_FORCED_CASES", DEFAULT_CASES)
        .iter()
        .map(|case| Case::parse(case))
        .collect();
    let warmup_blocks = env_usize("PCASH_BENCH_FORCED_WARMUP_BLOCKS", 1);
    let measure_blocks = env_usize("PCASH_BENCH_FORCED_MEASURE_BLOCKS", 3);
    let runs = env_usize("PCASH_BENCH_VERIFY_RUNS", 7);
    let workers: Vec<usize> = env_list("PCASH_BENCH_PARALLEL_WORKERS", DEFAULT_WORKERS)
        .iter()
        .map(|workers| workers.parse().expect("workers are whole numbers"))
        .collect();
    assert!(measure_blocks > 0 && runs > 0);
    println!(
        "pcash_forced_verification_benchmark available_parallelism={} bb_hardware_concurrency={}",
        std::thread::available_parallelism().map_or(0, usize::from),
        std::env::var("HARDWARE_CONCURRENCY").unwrap_or_else(|_| "default".to_owned()),
    );

    let known = KnownAnswer::read();
    let rules = pcash_node::config::compiled_rules();
    let verifier = BbProcessVerifier::from_env().expect("pinned bb (set PCASH_TOOL_ROOT)");
    // A fresh worker proves its startup known answers before it is timed.
    verifier.assert_known_answers().unwrap();
    let worst = benchmark_verifier(&verifier, &rules, &known, runs);
    for case in &cases {
        benchmark_block(
            &verifier,
            &worst,
            &known,
            *case,
            warmup_blocks,
            measure_blocks,
        );
    }
    if let Some(items) = cases.iter().map(|case| case.items()).max() {
        for workers in workers {
            benchmark_parallel(&worst, &known, items, workers);
        }
    }
}
