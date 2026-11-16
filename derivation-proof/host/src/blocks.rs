//! Ethereum blocks in their consensus encodings, with the blobs of inbox blob
//! carriers and their KZG proofs.

use alloy_eips::eip2718::{Decodable2718, Encodable2718};
use alloy_primitives::{keccak256, Address, FixedBytes, B256};
use alloy_provider::{Provider, RootProvider};
use alloy_rpc_types_eth::{Block, BlockNumberOrTag, TransactionReceipt};
use alloy_trie::root::ordered_trie_root_with_encoder;
use derivation_proof_core::RawBlock;
use eyre::{ensure, eyre, Result};
use futures::{StreamExt, TryStreamExt};
use std::path::Path;

/// Blocks requested from the Ethereum endpoint at once.
const CONCURRENCY: usize = 16;

/// Blocks `from..=to`: from `cache` when it holds them, else fetched (and
/// written to `cache`), each with its carrier blobs' KZG proofs.
pub async fn load(
    rpc: &str,
    beacon_api: &str,
    inbox: Address,
    from: u64,
    to: u64,
    cache: Option<&Path>,
) -> Result<Vec<RawBlock>> {
    let mut blocks = match cached(cache, from, to)? {
        Some(blocks) => blocks,
        None => {
            let started = std::time::Instant::now();
            let blocks = fetch(rpc, beacon_api, inbox, from, to).await?;
            eprintln!("fetched {} blocks in {:?}", blocks.len(), started.elapsed());
            if let Some(path) = cache {
                std::fs::write(path, serde_json::to_vec(&blocks)?)?;
            }
            blocks
        }
    };
    add_blob_proofs(&mut blocks)?;
    Ok(blocks)
}

/// The number of the endpoint's finalized block.
pub async fn finalized(rpc: &str) -> Result<u64> {
    let provider = RootProvider::<alloy_provider::network::Ethereum>::new_http(rpc.parse()?);
    let block = provider
        .get_block_by_number(BlockNumberOrTag::Finalized)
        .await?
        .ok_or_else(|| eyre!("no finalized block"))?;
    Ok(block.header.number)
}

/// The RLP-encoded headers of blocks `from..=to`, each checked against its hash.
pub async fn headers(rpc: &str, from: u64, to: u64) -> Result<Vec<Vec<u8>>> {
    let provider = RootProvider::<alloy_provider::network::Ethereum>::new_http(rpc.parse()?);
    futures::stream::iter(from..=to)
        .map(|number| {
            let provider = &provider;
            async move {
                let block = provider
                    .get_block_by_number(BlockNumberOrTag::Number(number))
                    .await?
                    .ok_or_else(|| eyre!("block {number} not found"))?;
                let header = alloy_rlp::encode(&block.header.inner);
                ensure!(keccak256(&header) == block.header.hash, "block {number}: header encoding hash");
                Ok(header)
            }
        })
        .buffered(CONCURRENCY)
        .try_collect()
        .await
}

fn cached(path: Option<&Path>, from: u64, to: u64) -> Result<Option<Vec<RawBlock>>> {
    let Some(path) = path else { return Ok(None) };
    if !path.exists() {
        return Ok(None);
    }
    let mut blocks: Vec<RawBlock> = serde_json::from_slice(&std::fs::read(path)?)?;
    let expected = usize::try_from(to - from + 1)?;
    ensure!(blocks.len() >= expected, "{} holds {} blocks, fewer than {expected}", path.display(), blocks.len());
    blocks.truncate(expected);
    Ok(Some(blocks))
}

async fn fetch(rpc: &str, beacon_api: &str, inbox: Address, from: u64, to: u64) -> Result<Vec<RawBlock>> {
    let provider = RootProvider::<alloy_provider::network::Ethereum>::new_http(rpc.parse()?);
    let beacon = Beacon::connect(beacon_api).await?;
    futures::stream::iter(from..=to)
        .map(|number| fetch_block(&provider, &beacon, inbox, number))
        .buffered(CONCURRENCY)
        .try_collect()
        .await
}

async fn fetch_block(provider: &RootProvider, beacon: &Beacon, inbox: Address, number: u64) -> Result<RawBlock> {
    let block = provider
        .get_block_by_number(BlockNumberOrTag::Number(number))
        .full()
        .await?
        .ok_or_else(|| eyre!("block {number} not found"))?;
    let receipts = provider
        .get_block_receipts(number.into())
        .await?
        .ok_or_else(|| eyre!("receipts of block {number} not found"))?;
    let timestamp = block.header.timestamp;
    let mut raw = encode(block, receipts)?;
    let requested = blob_carrier_hashes(&raw, inbox);
    if !requested.is_empty() {
        raw.blobs = beacon.blobs(number, timestamp, &requested).await?;
    }
    Ok(raw)
}

/// The versioned hashes of the block's inbox blob carriers, once each: the
/// blobs the guest needs. Transactions to the inbox with blobs and no calldata
/// have that shape; the guest classifies them exactly.
fn blob_carrier_hashes(block: &RawBlock, inbox: Address) -> Vec<B256> {
    use alloy_consensus::Transaction;
    let mut hashes = Vec::new();
    for encoding in &block.transactions {
        let Ok(tx) = alloy_consensus::TxEnvelope::decode_2718_exact(encoding) else { continue };
        if tx.to() != Some(inbox) || !tx.input().is_empty() {
            continue;
        }
        for hash in tx.blob_versioned_hashes().unwrap_or_default() {
            if !hashes.contains(hash) {
                hashes.push(*hash);
            }
        }
    }
    hashes
}

/// The Beacon API's blobs endpoint, addressed as the node addresses it: by
/// slot, or by execution block number on Anvil's shim, which has no spec.
struct Beacon {
    client: reqwest::Client,
    base: String,
    slots: Option<(u64, u64)>,
}

impl Beacon {
    async fn connect(base: &str) -> Result<Self> {
        let client = reqwest::Client::new();
        let base = base.trim_end_matches('/').to_owned();
        let spec = client.get(format!("{base}/eth/v1/config/spec")).send().await;
        let slots = match spec {
            Ok(response) if response.status().is_success() => {
                let spec: serde_json::Value = response.json().await?;
                let seconds_per_slot = spec["data"]["SECONDS_PER_SLOT"]
                    .as_str()
                    .ok_or_else(|| eyre!("spec omits SECONDS_PER_SLOT"))?
                    .parse()?;
                let genesis: serde_json::Value =
                    client.get(format!("{base}/eth/v1/beacon/genesis")).send().await?.json().await?;
                let genesis_time = genesis["data"]["genesis_time"]
                    .as_str()
                    .ok_or_else(|| eyre!("genesis omits genesis_time"))?
                    .parse()?;
                Some((genesis_time, seconds_per_slot))
            }
            _ => None,
        };
        Ok(Self { client, base, slots })
    }

    async fn blobs(&self, number: u64, timestamp: u64, hashes: &[B256]) -> Result<Vec<Vec<u8>>> {
        let block_id = match self.slots {
            Some((genesis_time, seconds_per_slot)) => (timestamp - genesis_time) / seconds_per_slot,
            None => number,
        };
        let mut blobs = Vec::new();
        for hash in hashes {
            let response: serde_json::Value = self
                .client
                .get(format!("{}/eth/v1/beacon/blobs/{block_id}?versioned_hashes={hash}", self.base))
                .header(reqwest::header::ACCEPT, "application/json")
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            // The endpoint returns one blob per occurrence of the hash in the
            // block, and a hash may occur more than once. Derivation checks
            // the first against the hash.
            let blob = response["data"]
                .get(0)
                .ok_or_else(|| eyre!("block {number}: no blob for {hash}"))?;
            let blob: alloy_primitives::Bytes = serde_json::from_value(blob.clone())?;
            blobs.push(blob.to_vec());
        }
        Ok(blobs)
    }
}

/// The block's consensus encodings, checked against its own hash and roots
/// so a host bug shows here rather than as a guest failure.
fn encode(block: Block, receipts: Vec<TransactionReceipt>) -> Result<RawBlock> {
    let number = block.header.number;
    let header = alloy_rlp::encode(&block.header.inner);
    ensure!(keccak256(&header) == block.header.hash, "block {number}: header encoding hash");
    let transactions: Vec<Vec<u8>> = block
        .transactions
        .into_transactions()
        .map(|tx| tx.inner.inner().encoded_2718())
        .collect();
    let receipts: Vec<Vec<u8>> = receipts
        .into_iter()
        .map(|receipt| receipt.inner.into_primitives_receipt().encoded_2718())
        .collect();
    ensure!(
        ordered_root(&transactions) == block.header.transactions_root,
        "block {number}: transactions root"
    );
    ensure!(ordered_root(&receipts) == block.header.receipts_root, "block {number}: receipts root");
    Ok(RawBlock { header, transactions, receipts, ..RawBlock::default() })
}

/// Each carrier blob's KZG commitment and blob proof, which the guest verifies
/// in place of recomputing the commitment (as op-succinct's `OnlineBlobStore`
/// prepares them).
fn add_blob_proofs(blocks: &mut [RawBlock]) -> Result<()> {
    let settings = c_kzg::ethereum_kzg_settings(0);
    for block in blocks {
        if block.commitments.len() == block.blobs.len() && block.proofs.len() == block.blobs.len() {
            continue;
        }
        block.commitments.clear();
        block.proofs.clear();
        for bytes in &block.blobs {
            let blob = c_kzg::Blob::from_bytes(bytes)?;
            let commitment = settings.blob_to_kzg_commitment(&blob)?.to_bytes();
            let proof = settings.compute_blob_kzg_proof(&blob, &commitment)?.to_bytes();
            block.commitments.push(FixedBytes::from(*commitment));
            block.proofs.push(FixedBytes::from(*proof));
        }
    }
    Ok(())
}

fn ordered_root(encodings: &[Vec<u8>]) -> B256 {
    ordered_trie_root_with_encoder(encodings, |encoding, out| out.extend_from_slice(encoding))
}

pub fn log_count(block: &RawBlock) -> usize {
    block
        .receipts
        .iter()
        .map(|receipt| {
            alloy_consensus::ReceiptEnvelope::decode_2718_exact(receipt)
                .map_or(0, |receipt| receipt.logs().len())
        })
        .sum()
}
