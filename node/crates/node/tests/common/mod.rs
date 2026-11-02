//! Fixture primitives shared by the node's integration tests.
//!
//! Only encodings and test doubles that are the same in every test live here.
//! Transaction and block constructors stay in the test that owns them, because
//! each shapes its fixtures around the behavior it is exercising.

#![allow(dead_code, reason = "each test binary uses a subset of these")]

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use alloy_primitives::{keccak256, Address, B256};
use pcash_derive::BlockOutcome;
use pcash_metrics::Metrics;
use pcash_state::{CircuitWord, ItemExclusionReason, TransactionOutcome};

/// A `u64` as a big-endian 32-byte circuit word.
pub fn word(value: u64) -> CircuitWord {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&value.to_be_bytes());
    CircuitWord::from(out)
}

/// The field element of a canonical test word.
pub fn field_element(word: CircuitWord) -> pcash_state::Fr {
    pcash_state::fr_from_canonical_bytes(word).expect("test word is canonical")
}

/// Keccak identifier of one exact typed transaction.
pub fn tx_id(raw: &[u8]) -> B256 {
    keccak256(raw)
}

/// The L1 sender every fixture batch is posted from.
pub fn sender() -> Address {
    Address::from([0x11u8; 20])
}

/// Frame items into a version-1 batch payload.
pub fn batch(items: &[Vec<u8>]) -> Vec<u8> {
    pcash_derive::Batch {
        version: pcash_derive::BatchVersion::V1,
        poster_owner_commitment: field_element(word(1)),
        poster_context: word(0),
        items: items.iter().map(Vec::as_slice).collect(),
    }
    .encode()
    .unwrap()
}

/// An ML-KEM-768 receive key from its exact bytes.
pub fn receive_key(bytes: &[u8]) -> pcash_derive::ReceiveKey {
    Box::new(bytes.try_into().expect("an ML-KEM-768 public key"))
}

/// Compliant opaque delivery data with a recognizable test payload.
pub fn output_data(payload: &[u8]) -> Vec<u8> {
    let mut data = vec![0; pcash_derive::OUTPUT_DATA_BYTES];
    data[0] = 1;
    data[1..=payload.len()].copy_from_slice(payload);
    data
}

/// An opaque profile-S arena.
pub fn arena() -> Vec<u8> {
    vec![2; pcash_derive::private_value_profiles::S.arena_bytes]
}

/// Records the index gauges and the index write-failure counter.
#[derive(Default)]
pub struct IndexMetrics {
    pub ready: AtomicBool,
    pub write_failures: AtomicUsize,
}

impl Metrics for IndexMetrics {
    fn set_index_progress(&self, _cursor: u64, ready: bool) {
        self.ready.store(ready, Ordering::SeqCst);
    }

    fn record_index_write_failure(&self) {
        self.write_failures.fetch_add(1, Ordering::SeqCst);
    }
}

/// File storage for a redb database whose writes and syncs fail while `fail`
/// is set. It takes no file lock, so it can be built while another handle on
/// the file is still open.
#[derive(Debug)]
pub struct FaultyBackend {
    file: Mutex<File>,
    fail: Arc<AtomicBool>,
}

impl FaultyBackend {
    pub fn open(path: &Path, fail: Arc<AtomicBool>) -> Self {
        let file = File::options().read(true).write(true).open(path).unwrap();
        Self {
            file: Mutex::new(file),
            fail,
        }
    }

    fn check(&self) -> io::Result<()> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(io::Error::other("injected index storage failure"));
        }
        Ok(())
    }
}

impl redb::StorageBackend for FaultyBackend {
    fn len(&self) -> io::Result<u64> {
        Ok(self.file.lock().unwrap().metadata()?.len())
    }

    fn read(&self, offset: u64, out: &mut [u8]) -> io::Result<()> {
        let mut file = self.file.lock().unwrap();
        file.seek(SeekFrom::Start(offset))?;
        file.read_exact(out)
    }

    fn set_len(&self, len: u64) -> io::Result<()> {
        self.check()?;
        self.file.lock().unwrap().set_len(len)
    }

    fn sync_data(&self) -> io::Result<()> {
        self.check()?;
        self.file.lock().unwrap().sync_data()
    }

    fn write(&self, offset: u64, data: &[u8]) -> io::Result<()> {
        self.check()?;
        let mut file = self.file.lock().unwrap();
        file.seek(SeekFrom::Start(offset))?;
        file.write_all(data)
    }
}

/// One framed item's result in a derived block.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ItemResult {
    Admitted(TransactionOutcome),
    Excluded(ItemExclusionReason),
}

/// A successful admitted transaction.
pub const SUCCEEDED: ItemResult = ItemResult::Admitted(TransactionOutcome::Succeeded);

/// Every framed item's result in canonical order, read from the committed
/// delivery manifest and transaction results.
pub fn item_results(outcome: &BlockOutcome) -> Vec<ItemResult> {
    let boundary = &outcome.committed_boundary;
    let mut results = boundary.block.transaction_results.iter();
    boundary
        .history
        .l1_delivery_batches
        .iter()
        .flat_map(|batch| &batch.items)
        .map(|item| match item.exclusion_reason {
            Some(reason) => ItemResult::Excluded(reason),
            None => ItemResult::Admitted(
                results
                    .next()
                    .expect("one result per admitted item")
                    .outcome,
            ),
        })
        .collect()
}
