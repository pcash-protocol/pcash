//! Altered input the range program must refuse.

use alloy_eips::eip2718::{Decodable2718, Encodable2718};
use clap::ValueEnum;
use derivation_proof_core::{RawBlock, Source};
use eyre::{ensure, eyre, Result};

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum Tamper {
    /// Change one byte of one log's data.
    LogByte,
    /// Remove one transaction.
    DropTransaction,
    /// Swap two transactions.
    ReorderTransactions,
    /// Remove one receipt.
    DropReceipt,
    /// Replace a header with a different one (its timestamp changed).
    ForeignHeader,
    /// Leave one block out.
    SkipBlock,
    /// Name a different anchor hash in the source.
    WrongAnchor,
    /// Leave out one blob a blob carrier names.
    DropBlob,
    /// Change one byte of one blob.
    BlobByte,
}

pub fn apply(tamper: Tamper, source: &mut Source, blocks: &mut Vec<RawBlock>) -> Result<()> {
    ensure!(blocks.len() >= 3, "tampering needs at least three blocks");
    let middle = blocks.len() / 2;
    let with_transactions = |count: usize| {
        blocks
            .iter()
            .position(|block| block.transactions.len() >= count)
            .ok_or_else(|| eyre!("no block has {count} transactions"))
    };
    match tamper {
        Tamper::LogByte => {
            let (block, receipt) = blocks
                .iter()
                .enumerate()
                .find_map(|(b, block)| {
                    block.receipts.iter().position(|receipt| {
                        alloy_consensus::ReceiptEnvelope::decode_2718_exact(receipt)
                            .is_ok_and(|r| r.logs().iter().any(|log| !log.data.data.is_empty()))
                    })
                    .map(|r| (b, r))
                })
                .ok_or_else(|| eyre!("no log with data"))?;
            let mut envelope =
                alloy_consensus::ReceiptEnvelope::decode_2718_exact(&blocks[block].receipts[receipt])?;
            let (alloy_consensus::ReceiptEnvelope::Legacy(with_bloom)
            | alloy_consensus::ReceiptEnvelope::Eip2930(with_bloom)
            | alloy_consensus::ReceiptEnvelope::Eip1559(with_bloom)
            | alloy_consensus::ReceiptEnvelope::Eip4844(with_bloom)
            | alloy_consensus::ReceiptEnvelope::Eip7702(with_bloom)) = &mut envelope;
            let log = with_bloom
                .receipt
                .logs
                .iter_mut()
                .find(|log| !log.data.data.is_empty())
                .ok_or_else(|| eyre!("log vanished"))?;
            let mut data = log.data.data.to_vec();
            data[0] ^= 1;
            log.data = alloy_primitives::LogData::new_unchecked(log.data.topics().to_vec(), data.into());
            blocks[block].receipts[receipt] = envelope.encoded_2718();
        }
        Tamper::DropTransaction => {
            let block = with_transactions(1)?;
            blocks[block].transactions.pop();
        }
        Tamper::ReorderTransactions => {
            let block = with_transactions(2)?;
            blocks[block].transactions.swap(0, 1);
        }
        Tamper::DropReceipt => {
            let block = with_transactions(1)?;
            blocks[block].receipts.pop();
        }
        Tamper::ForeignHeader => {
            let mut encoded = blocks[middle].header.as_slice();
            let mut header = <alloy_consensus::Header as alloy_rlp::Decodable>::decode(&mut encoded)?;
            header.timestamp += 1;
            blocks[middle].header = alloy_rlp::encode(&header);
        }
        Tamper::SkipBlock => {
            blocks.remove(middle);
        }
        Tamper::WrongAnchor => {
            source.genesis_l1_block_hash.0[0] ^= 1;
        }
        Tamper::DropBlob => {
            let block = blocks
                .iter()
                .position(|block| !block.blobs.is_empty())
                .ok_or_else(|| eyre!("no block has carrier blobs"))?;
            blocks[block].blobs.remove(0);
            blocks[block].commitments.remove(0);
            blocks[block].proofs.remove(0);
        }
        Tamper::BlobByte => {
            let block = blocks
                .iter()
                .position(|block| !block.blobs.is_empty())
                .ok_or_else(|| eyre!("no block has carrier blobs"))?;
            // A byte inside the second field element's payload, so the blob
            // stays a valid KZG input and only its proof fails.
            blocks[block].blobs[0][40] ^= 1;
        }
    }
    Ok(())
}
