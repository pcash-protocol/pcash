//! Domain structs the rest of the node consumes.
//!
//! These are the *only* L1 facts the node keeps: each header's number, hash, parent hash, and
//! timestamp; each top-level transaction's hash, index, sender, `to`, calldata, ordered blob
//! versioned hashes, and resolved blob payload; and each receipt's logs.

use alloy_primitives::{Address, Bytes, B256};
use pcash_da::{classify_inbox_carrier, InboxEncoding};
use std::sync::OnceLock;

/// Minimal L1 block header: block identity, parent link for continuity
/// checks, and the timestamp derivation uses as the PCASH block timestamp.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct L1Header {
    pub number: u64,
    pub hash: B256,
    pub parent_hash: B256,
    pub timestamp: u64,
}

/// A single top-level L1 transaction, reduced to the fields derivation uses.
///
/// `from` is the top-level transaction sender.
/// `input` is the raw calldata; batch parsing consumes it only
/// when `to == INBOX_ADDRESS`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct L1Tx {
    pub hash: B256,
    pub from: Address,
    /// `None` for contract-creation transactions.
    pub to: Option<Address>,
    pub input: Bytes,
    /// Ordered EIP-4844 versioned hashes. Empty for every non-blob transaction.
    pub blob_versioned_hashes: Vec<B256>,
    /// Canonical candidate-batch bytes recovered from verified blobs. This is
    /// populated by availability resolution before derivation.
    pub blob_resolution: BlobResolution,
    pub tx_index: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum BlobResolution {
    #[default]
    Unresolved,
    Invalid,
    Batch(Bytes),
}

/// What a carrier yields: its candidate batch bytes, nothing because it is
/// ignored in full, or nothing yet because its blobs are unresolved.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CarrierBatch<'a> {
    Bytes(&'a [u8]),
    Ignore,
    Unresolved,
}

impl L1Tx {
    /// Select the Inbox carrier's already-resolved candidate batch without
    /// performing I/O.
    pub fn inbox_batch(&self) -> CarrierBatch<'_> {
        match classify_inbox_carrier(&self.input, &self.blob_versioned_hashes) {
            InboxEncoding::Calldata => CarrierBatch::Bytes(&self.input),
            InboxEncoding::Invalid => CarrierBatch::Ignore,
            InboxEncoding::Blob => match &self.blob_resolution {
                BlobResolution::Unresolved => CarrierBatch::Unresolved,
                BlobResolution::Invalid => CarrierBatch::Ignore,
                BlobResolution::Batch(batch) => CarrierBatch::Bytes(batch.as_ref()),
            },
        }
    }
}

/// Per-transaction receipt data: the receipt logs, committed through the
/// block's L1 origin leaf.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct L1Receipt {
    pub logs: Vec<L1Log>,
}

/// One canonical receipt log in transaction-local order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct L1Log {
    pub transaction_index: u64,
    pub log_index: u64,
    pub emitter: Address,
    pub topics: Vec<B256>,
    pub data: Bytes,
}

/// A full L1 block reduced for PCASH derivation: the header plus every
/// top-level transaction paired with its receipt, aligned by transaction index.
#[derive(Debug)]
pub struct L1BlockData {
    pub header: L1Header,
    /// `(tx, receipt)` pairs in transaction-index order. `txs[i].0.tx_index == i`.
    pub txs: Vec<(L1Tx, L1Receipt)>,
    normalized: OnceLock<crate::logs::NormalizedLogBlock>,
}

impl Clone for L1BlockData {
    fn clone(&self) -> Self {
        Self::new(self.header.clone(), self.txs.clone())
    }
}

impl PartialEq for L1BlockData {
    fn eq(&self, other: &Self) -> bool {
        self.header == other.header && self.txs == other.txs
    }
}

impl Eq for L1BlockData {}

impl L1BlockData {
    pub fn new(header: L1Header, txs: Vec<(L1Tx, L1Receipt)>) -> Self {
        Self {
            header,
            txs,
            normalized: OnceLock::new(),
        }
    }

    /// The block's normalized logs, computed on first use.
    pub fn normalized_logs(&self) -> &crate::logs::NormalizedLogBlock {
        self.normalized
            .get_or_init(|| crate::logs::normalize_block(self))
    }
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
    use crate::carrier::CarrierSource;
    use alloy_primitives::{address, b256};

    fn tx(idx: u64) -> L1Tx {
        L1Tx {
            hash: b256!("0xcc00000000000000000000000000000000000000000000000000000000000000"),
            from: address!("0x88130d3121eaf7f3285fdd7bbd3a1ef53f2d6e16"),
            to: Some(address!("0x5977bf230719fb405aaf2aadadd8e026000f2436")),
            input: Bytes::from_static(&[0xde, 0xad, 0xbe, 0xef]),
            blob_versioned_hashes: Vec::new(),
            blob_resolution: BlobResolution::Unresolved,
            tx_index: idx,
        }
    }

    #[test]
    fn inbox_batch_selects_calldata_and_resolved_blobs() {
        let calldata = tx(0);
        assert_eq!(
            calldata.inbox_batch(),
            CarrierBatch::Bytes(&[0xde, 0xad, 0xbe, 0xef])
        );

        let mut blob = tx(0);
        blob.input = Bytes::new();
        let mut versioned_hash = B256::ZERO;
        versioned_hash.0[0] = 1;
        blob.blob_versioned_hashes = vec![versioned_hash];
        assert_eq!(blob.inbox_batch(), CarrierBatch::Unresolved);
        blob.blob_resolution = BlobResolution::Batch(Bytes::from_static(&[1, 2, 3]));
        assert_eq!(blob.inbox_batch(), CarrierBatch::Bytes(&[1, 2, 3]));
    }

    alloy_sol_types::sol! {
        event PcashBatch(bytes context, bytes batch);
    }

    fn event_data(context: &[u8], batch: &[u8]) -> Bytes {
        use alloy_sol_types::SolEvent;
        PcashBatch {
            context: context.to_vec().into(),
            batch: batch.to_vec().into(),
        }
        .encode_data()
        .into()
    }

    fn log(tx_index: u64, log_index: u64, topics: Vec<B256>, data: Bytes) -> L1Log {
        L1Log {
            transaction_index: tx_index,
            log_index,
            emitter: Address::repeat_byte(0x40 + log_index as u8),
            topics,
            data,
        }
    }

    /// The carriers of a block as `(tx index, log index or None for the
    /// Inbox carrier, candidate batch)`.
    fn carriers(block: &L1BlockData, inbox: Address) -> Vec<(u64, Option<u64>, CarrierBatch<'_>)> {
        block
            .carriers(inbox)
            .map(|carrier| {
                let log_index = match carrier.source {
                    CarrierSource::Inbox => None,
                    CarrierSource::Event { log, .. } => Some(log.log_index),
                };
                (carrier.tx.tx_index, log_index, carrier.batch())
            })
            .collect()
    }

    #[test]
    fn carriers_are_the_inbox_carrier_then_one_topic_batch_events_in_log_order() {
        let inbox = address!("0x5977bf230719fb405aaf2aadadd8e026000f2436");
        let topic = crate::carrier::PCASH_BATCH_TOPIC;
        let other = B256::repeat_byte(0x77);
        let oversize = vec![0; pcash_da::MAX_BATCH_BYTES + 1];
        let mut malformed = event_data(&[1], &[2]).to_vec();
        malformed.push(0);
        let inbox_tx = tx(0);
        let mut plain_tx = tx(1);
        plain_tx.to = Some(Address::repeat_byte(0x99));
        let block = L1BlockData::new(
            L1Header {
                number: 1,
                hash: B256::ZERO,
                parent_hash: B256::ZERO,
                timestamp: 0,
            },
            vec![
                (
                    inbox_tx,
                    L1Receipt {
                        logs: vec![
                            log(0, 0, vec![other], event_data(&[], &[0xaa])),
                            log(0, 1, vec![topic], event_data(&[3], &[0xbb])),
                            log(0, 2, vec![topic, other], event_data(&[], &[0xcc])),
                        ],
                    },
                ),
                (
                    plain_tx,
                    L1Receipt {
                        logs: vec![
                            log(1, 0, vec![topic], Bytes::from(malformed)),
                            log(1, 1, vec![], event_data(&[], &[0xdd])),
                            log(1, 2, vec![topic], event_data(&[4, 5], &oversize)),
                            log(1, 3, vec![topic], event_data(&[], &[])),
                        ],
                    },
                ),
            ],
        );
        assert_eq!(
            carriers(&block, inbox),
            vec![
                (0, None, CarrierBatch::Bytes(&[0xde, 0xad, 0xbe, 0xef])),
                (0, Some(1), CarrierBatch::Bytes(&[0xbb])),
                (1, Some(0), CarrierBatch::Ignore),
                (1, Some(2), CarrierBatch::Ignore),
                (1, Some(3), CarrierBatch::Bytes(&[])),
            ]
        );
        // The context survives an oversize batch but not a malformed encoding.
        let contexts: Vec<_> = block
            .carriers(inbox)
            .map(|carrier| match carrier.source {
                CarrierSource::Inbox => None,
                CarrierSource::Event { decoded, .. } => Some(decoded.map(|data| data.context)),
            })
            .collect();
        assert_eq!(
            contexts,
            vec![
                None,
                Some(Some(&[3][..])),
                Some(None),
                Some(Some(&[4, 5][..])),
                Some(Some(&[][..])),
            ]
        );
    }

    #[test]
    fn inbox_batch_ignores_mixed_and_unsupported_blob_carriers() {
        let mut mixed = tx(0);
        let mut versioned_hash = B256::ZERO;
        versioned_hash.0[0] = 1;
        mixed.blob_versioned_hashes = vec![versioned_hash];
        assert_eq!(mixed.inbox_batch(), CarrierBatch::Ignore);

        let mut unsupported = tx(0);
        unsupported.input = Bytes::new();
        unsupported.blob_versioned_hashes = vec![B256::repeat_byte(2)];
        assert_eq!(unsupported.inbox_batch(), CarrierBatch::Ignore);
    }
}
