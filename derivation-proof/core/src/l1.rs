//! Ethereum blocks authenticated from their encodings.
//!
//! Each header is hashed, linked to the block before it, and its transactions
//! and receipts are checked against its roots. The result is the node's
//! `L1BlockData` with every field taken from authenticated bytes, as the node's
//! RPC conversion would fill it (pcash-l1 `client::assemble_block`), and with
//! its inbox blob carriers resolved as the node's blob client resolves them
//! (pcash-node `blob::BeaconClient::resolve_block`).

use std::collections::BTreeMap;

use alloy_consensus::transaction::SignerRecoverable;
use alloy_consensus::{Header, ReceiptEnvelope, Transaction, TxEnvelope};
use alloy_eips::eip2718::Decodable2718;
use alloy_eips::eip4844::{kzg_to_versioned_hash, Blob};
use alloy_primitives::{keccak256, Address, Bytes, B256};
use alloy_rlp::Decodable;
use alloy_trie::root::ordered_trie_root_with_encoder;
use derivation_proof_types::RawBlock;
use pcash_da::{classify_inbox_carrier, decode_canonical_refs, InboxEncoding, MAX_BATCH_BYTES};
use pcash_l1::{BlobResolution, L1BlockData, L1Header, L1Log, L1Receipt, L1Tx};

/// The chain authenticated so far: the next block number and the hash the
/// next header must name as its parent.
pub struct Chain {
    next_number: u64,
    parent_hash: Option<B256>,
    inbox: Address,
}

impl Chain {
    /// A chain starting at the anchor block. Derivation itself requires the
    /// anchor's hash to equal the source's.
    pub fn from_anchor(genesis_l1_block: u64, inbox: Address) -> Self {
        Self {
            next_number: genesis_l1_block,
            parent_hash: None,
            inbox,
        }
    }

    /// A chain continuing from the Ethereum block a checkpoint derived.
    pub fn from_checkpoint(l1_number: u64, l1_hash: B256, inbox: Address) -> Self {
        Self {
            next_number: l1_number + 1,
            parent_hash: Some(l1_hash),
            inbox,
        }
    }

    /// Authenticate the next block and convert it. Panics on any mismatch, so
    /// a proof's blocks are those of the chain its last block's hash names.
    pub fn authenticate(&mut self, raw: &RawBlock) -> L1BlockData {
        let hash = keccak256(&raw.header);
        let mut encoded = raw.header.as_slice();
        let header = Header::decode(&mut encoded).expect("header RLP");
        assert!(encoded.is_empty(), "trailing bytes after header");
        assert_eq!(header.number, self.next_number, "block number");
        if let Some(parent_hash) = self.parent_hash {
            assert_eq!(header.parent_hash, parent_hash, "parent hash");
        }
        assert_eq!(
            ordered_root(&raw.transactions),
            header.transactions_root,
            "transactions root"
        );
        assert_eq!(
            ordered_root(&raw.receipts),
            header.receipts_root,
            "receipts root"
        );
        assert_eq!(
            raw.transactions.len(),
            raw.receipts.len(),
            "transaction and receipt counts"
        );

        let mut txs: Vec<_> = (0u64..)
            .zip(raw.transactions.iter().zip(&raw.receipts))
            .map(|(tx_index, (tx, receipt))| (transaction(tx, tx_index), receipt_logs(receipt, tx_index)))
            .collect();
        resolve_blob_carriers(&mut txs, self.inbox, raw);

        self.next_number = header.number + 1;
        self.parent_hash = Some(hash);
        L1BlockData::new(
            L1Header {
                number: header.number,
                hash,
                parent_hash: header.parent_hash,
                timestamp: header.timestamp,
            },
            txs,
        )
    }

    /// The last block authenticated, as (number, hash).
    pub fn last(&self) -> (u64, B256) {
        (
            self.next_number - 1,
            self.parent_hash.expect("no block authenticated"),
        )
    }
}

/// The root of a trie keyed by RLP-encoded index whose values are the given
/// encodings, which is how a header commits its transactions and receipts.
fn ordered_root(encodings: &[Vec<u8>]) -> B256 {
    ordered_trie_root_with_encoder(encodings, |encoding, out| out.extend_from_slice(encoding))
}

fn transaction(encoding: &[u8], tx_index: u64) -> L1Tx {
    let tx = TxEnvelope::decode_2718_exact(encoding).expect("transaction encoding");
    L1Tx {
        hash: keccak256(encoding),
        from: tx.recover_signer().expect("transaction signature"),
        to: tx.to(),
        input: tx.input().clone(),
        blob_versioned_hashes: tx.blob_versioned_hashes().unwrap_or_default().to_vec(),
        blob_resolution: Default::default(),
        tx_index,
    }
}

fn is_blob_carrier(tx: &L1Tx, inbox: Address) -> bool {
    tx.to == Some(inbox)
        && classify_inbox_carrier(&tx.input, &tx.blob_versioned_hashes) == InboxEncoding::Blob
}

/// Bind each supplied blob to a versioned hash, then decode each blob
/// carrier's blobs, in the order its transaction names them, with the PCASH
/// blob codec. A KZG-bound but noncanonical payload is an invalid carrier. A
/// missing blob or a failed proof panics: the node halts there too, waiting for
/// availability.
///
/// The binding follows op-succinct's `BlobStore`: the host supplies each
/// blob's KZG commitment and blob proof, the batch of proofs is verified, and
/// the versioned hash is taken from the commitment. The node instead recomputes
/// each commitment from its blob; under KZG binding both tie a blob to exactly
/// one versioned hash.
fn resolve_blob_carriers(txs: &mut [(L1Tx, L1Receipt)], inbox: Address, raw: &RawBlock) {
    if !txs.iter().any(|(tx, _)| is_blob_carrier(tx, inbox)) {
        return;
    }
    #[cfg(target_os = "zkvm")]
    println!("cycle-tracker-report-start: kzg");
    assert!(
        raw.blobs.len() == raw.commitments.len() && raw.blobs.len() == raw.proofs.len(),
        "a commitment and a proof for every blob"
    );
    let blobs = raw
        .blobs
        .iter()
        .map(|blob| kzg_rs::Blob::from_slice(blob).expect("blob size"))
        .collect();
    let commitments = raw.commitments.iter().map(|commitment| kzg_rs::Bytes48(commitment.0)).collect();
    let proofs = raw.proofs.iter().map(|proof| kzg_rs::Bytes48(proof.0)).collect();
    let valid = kzg_rs::KzgProof::verify_blob_kzg_proof_batch(blobs, commitments, proofs, &kzg_rs::get_kzg_settings())
        .expect("blob KZG proofs");
    assert!(valid, "blob KZG proofs");
    let verified: BTreeMap<B256, Blob> = raw
        .commitments
        .iter()
        .map(|commitment| kzg_to_versioned_hash(commitment.as_slice()))
        .zip(raw.blobs.iter().map(|blob| Blob::try_from(blob.as_slice()).expect("blob size")))
        .collect();
    #[cfg(target_os = "zkvm")]
    println!("cycle-tracker-report-end: kzg");
    for (tx, _) in txs.iter_mut().filter(|(tx, _)| is_blob_carrier(tx, inbox)) {
        let ordered: Vec<&Blob> = tx
            .blob_versioned_hashes
            .iter()
            .map(|hash| verified.get(hash).unwrap_or_else(|| panic!("blob {hash} unavailable")))
            .collect();
        tx.blob_resolution = match decode_canonical_refs(&ordered, MAX_BATCH_BYTES) {
            Ok(batch) => BlobResolution::Batch(Bytes::from(batch)),
            Err(_) => BlobResolution::Invalid,
        };
    }
}

fn receipt_logs(encoding: &[u8], transaction_index: u64) -> L1Receipt {
    let receipt = ReceiptEnvelope::decode_2718_exact(encoding).expect("receipt encoding");
    let logs = (0u64..)
        .zip(receipt.logs())
        .map(|(log_index, log)| {
            let topics = log.topics().to_vec();
            // As the node: a receipt log with more than four topics is a
            // shape failure that halts derivation.
            assert!(topics.len() <= 4, "log topic count");
            L1Log {
                transaction_index,
                log_index,
                emitter: log.address,
                topics,
                data: log.data.data.clone(),
            }
        })
        .collect();
    L1Receipt { logs }
}
