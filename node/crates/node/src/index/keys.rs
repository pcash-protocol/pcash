use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};

use alloy_primitives::{Address, B256, I256, U256};

use crate::node::{AccountReceiptData, ReceiptRecord};
use pcash_state::codec::codec_struct;
use pcash_state::{StateError, TransactionOutcome};

pub(super) const T_RECEIPTS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("receipts");
/// One derived-block summary per L1 block, keyed by the 8-byte big-endian L1
/// block number, the same coordinate that leads the receipt keys, so `rewind_to`
/// drops the orphaned rows of both tables from one range bound.
pub(super) const T_BLOCKS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("blocks");
/// One issuance-economics row per PCASH block, keyed by the 8-byte big-endian
/// PCASH block number so a range read yields a contiguous block series without
/// loading block bodies or material rows.
pub(super) const T_BLOCK_ECONOMICS: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("block_economics");
pub(super) const T_L1_LOGS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("l1_logs");
pub(super) const T_L1_LOG_BLOCKS: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("l1_log_blocks");
pub(super) const T_L1_LOG_NODES: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("l1_log_nodes");
pub(super) const T_META: TableDefinition<&str, &[u8]> = TableDefinition::new("meta");
/// One row per PCASH block, keyed by the 8-byte big-endian PCASH block number.
pub(super) const T_INDEXED_BLOCKS: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("indexed_blocks");
pub(super) const T_OUTPUTS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("outputs");
pub(super) const T_INDEX_UNDO: TableDefinition<&[u8], &[u8]> = TableDefinition::new("index_undo");
pub(super) const T_RECEIVE_MATERIAL: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("receive_material");
pub(super) const T_CONTRACT_MATERIAL: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("contract_material");
/// Immutable contract address by `pcashBlockNumber || pcashTransactionIndex`.
pub(super) const T_CONTRACT_BY_CREATION: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("contract_by_creation");
/// Source-verification status and configuration-opening count by contract address.
pub(super) const T_CONTRACT_SOURCE_INFO: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("contract_source_info");
/// Verified contract address by `pcashBlockNumber || pcashTransactionIndex`.
pub(super) const T_VERIFIED_CONTRACT_BY_CREATION: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("verified_contract_by_creation");

pub(super) const INDEX_SCHEMA: &[u8] = b"pcash-derived-index:payout-components";
pub(super) const M_SCHEMA: &str = "schema";
pub(super) const M_CHAIN_ID: &str = "chain_id";
pub(super) const M_GENESIS_HASH: &str = "genesis_hash";
pub(super) const M_CURSOR: &str = "cursor";
pub(super) const M_TOTAL_SUCCEEDED: &str = "total_succeeded";
pub(super) const M_TOTAL_FAILED: &str = "total_failed";
pub(super) fn pcash_block_key(number: u64) -> [u8; 8] {
    number.to_be_bytes()
}

pub(super) fn output_key(index: u64) -> [u8; 8] {
    index.to_be_bytes()
}

pub(super) fn contract_creation_key(block_number: u64, transaction_index: u64) -> [u8; 16] {
    let mut key = [0u8; 16];
    key[..8].copy_from_slice(&block_number.to_be_bytes());
    key[8..].copy_from_slice(&transaction_index.to_be_bytes());
    key
}

pub(super) fn l1_log_block_key(number: u64) -> [u8; 8] {
    number.to_be_bytes()
}

pub(super) fn l1_log_key(block_number: u64, transaction_index: u64, log_index: u64) -> [u8; 24] {
    let mut key = [0u8; 24];
    key[..8].copy_from_slice(&block_number.to_be_bytes());
    key[8..16].copy_from_slice(&transaction_index.to_be_bytes());
    key[16..].copy_from_slice(&log_index.to_be_bytes());
    key
}

pub(super) fn l1_log_node_key(block_number: u64, height: u8, index: u64) -> [u8; 17] {
    let mut key = [0u8; 17];
    key[..8].copy_from_slice(&block_number.to_be_bytes());
    key[8] = height;
    key[9..].copy_from_slice(&index.to_be_bytes());
    key
}

pub(super) fn receive_material_key(address: &Address, revision: u32) -> [u8; 24] {
    let mut key = [0u8; 24];
    key[..20].copy_from_slice(address.as_slice());
    key[20..].copy_from_slice(&revision.to_be_bytes());
    key
}

// Secondary indexes resolve lookup dimensions to primary receipt keys.
// `rewind_to` removes an orphaned receipt from every index. Transaction IDs
// commit inclusion coordinates; repeated bytes share a content hash, not an ID.
pub(super) const T_RECEIPT_BY_TXID: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("receipt_by_txid");
pub(super) const T_RECEIPT_BY_NULLIFIER: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("receipt_by_nullifier");
pub(super) const T_RECEIPT_BY_ACCOUNT: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("receipt_by_account");
pub(super) const T_RECEIPT_BY_CONTENT: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("receipt_by_content");
pub(super) const T_SUCCEEDED_RECEIPT_BY_CONTENT: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("succeeded_receipt_by_content");
pub(super) const T_RECEIPT_BY_BLOCK_ORDINAL: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("receipt_by_block_ordinal");
pub(super) const T_RECEIPT_BY_KIND_BLOCK_ORDINAL: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("receipt_by_kind_block_ordinal");
pub(super) const T_RECEIPT_BY_LIFECYCLE_ADDRESS: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("receipt_by_lifecycle_address");

pub(super) fn be<E: std::fmt::Display>(e: E) -> StateError {
    StateError::Backend(e.to_string())
}

pub(super) fn validate_index_schema(db: &Database) -> Result<(), StateError> {
    crate::redb_schema::require_tables(
        db,
        &[
            "blocks",
            "block_economics",
            "contract_by_creation",
            "contract_material",
            "contract_source_info",
            "verified_contract_by_creation",
            "l1_log_blocks",
            "l1_log_nodes",
            "l1_logs",
            "index_undo",
            "indexed_blocks",
            "meta",
            "outputs",
            "receipt_by_nullifier",
            "receipt_by_account",
            "receipt_by_content",
            "succeeded_receipt_by_content",
            "receipt_by_block_ordinal",
            "receipt_by_kind_block_ordinal",
            "receipt_by_lifecycle_address",
            "receipt_by_txid",
            "receipts",
            "receive_material",
        ],
    )
    .map_err(|_| StateError::Backend("incompatible derived index table schema".into()))?;

    let read = db.begin_read().map_err(be)?;
    let meta = read.open_table(T_META).map_err(be)?;
    let keys = meta
        .iter()
        .map_err(be)?
        .map(|row| row.map(|(key, _)| key.value().to_owned()).map_err(be))
        .collect::<Result<Vec<_>, _>>()?;
    crate::redb_schema::require_meta_keys(
        keys,
        &[
            &[
                M_SCHEMA.as_bytes(),
                M_TOTAL_SUCCEEDED.as_bytes(),
                M_TOTAL_FAILED.as_bytes(),
            ],
            &[
                M_CHAIN_ID.as_bytes(),
                M_GENESIS_HASH.as_bytes(),
                M_SCHEMA.as_bytes(),
                M_TOTAL_SUCCEEDED.as_bytes(),
                M_TOTAL_FAILED.as_bytes(),
            ],
            &[
                M_CHAIN_ID.as_bytes(),
                M_CURSOR.as_bytes(),
                M_GENESIS_HASH.as_bytes(),
                M_SCHEMA.as_bytes(),
                M_TOTAL_SUCCEEDED.as_bytes(),
                M_TOTAL_FAILED.as_bytes(),
            ],
        ],
    )
    .map_err(|_| StateError::Backend("incompatible derived index metadata schema".into()))?;
    Ok(())
}

pub(super) fn block_of(key: &[u8]) -> u64 {
    u64::from_be_bytes(key[0..8].try_into().unwrap())
}

pub(super) fn receipt_key(block: u64, tx_index: u64, entry_index: u64) -> [u8; 24] {
    let mut k = [0u8; 24];
    k[0..8].copy_from_slice(&block.to_be_bytes());
    k[8..16].copy_from_slice(&tx_index.to_be_bytes());
    k[16..24].copy_from_slice(&entry_index.to_be_bytes());
    k
}

pub(super) fn content_receipt_key(content_hash: B256, primary: &[u8; 24]) -> [u8; 56] {
    let mut key = [0u8; 56];
    key[..32].copy_from_slice(content_hash.as_slice());
    key[32..].copy_from_slice(primary);
    key
}

pub(super) fn block_ordinal_key(block: u64, ordinal: u64) -> [u8; 16] {
    let mut key = [0u8; 16];
    key[..8].copy_from_slice(&block.to_be_bytes());
    key[8..].copy_from_slice(&ordinal.to_be_bytes());
    key
}

pub(super) fn kind_block_ordinal_key(kind: u8, block: u64, ordinal: u64) -> [u8; 17] {
    let mut key = [0u8; 17];
    key[0] = kind;
    key[1..9].copy_from_slice(&block.to_be_bytes());
    key[9..].copy_from_slice(&ordinal.to_be_bytes());
    key
}

pub(super) fn lifecycle_receipt_key(address: Address, primary: &[u8; 24]) -> [u8; 44] {
    let mut key = [0u8; 44];
    key[..20].copy_from_slice(address.as_slice());
    key[20..].copy_from_slice(primary);
    key
}

/// Stable account identifier: `address || account_revision`.
pub(super) fn account_key(address: &Address, revision: u32) -> [u8; 24] {
    let mut k = [0u8; 24];
    k[0..20].copy_from_slice(address.as_slice());
    k[20..24].copy_from_slice(&revision.to_be_bytes());
    k
}

/// Rebuild a [`ReceiptRecord`] from its primary key (holding the block/tx/entry
/// coordinates) and stored row.
pub(super) fn receipt_from_row(key: &[u8], rr: ReceiptRow) -> ReceiptRecord {
    ReceiptRecord {
        pcash_transaction_index: rr.pcash_transaction_index,
        l1_block_number: block_of(key),
        l1_block_hash: rr.hash,
        l1_transaction_index: u64::from_be_bytes(key[8..16].try_into().unwrap()),
        l1_transaction_hash: rr.l1_transaction_hash,
        batch_item_index: u64::from_be_bytes(key[16..24].try_into().unwrap()),
        content_hash: rr.content_hash,
        tx_id: rr.tx_id,
        outcome: rr.outcome,
        failure_detail: rr.failure_detail,
        l1_sender: rr.l1_sender,
        issuance_owner_commitment: rr.issuance_owner_commitment,
        settled_open_fee_amount: rr.settled_open_fee_amount,
        settled_issuance_amount: rr.settled_issuance_amount,
        has_open_fee: rr.has_open_fee,
        byte_size: rr.byte_size,
        kind: rr.kind,
        account_creation: rr.account_creation,
        lifecycle_address: rr.lifecycle_address,
        output_leaf_start: rr.output_leaf_start,
        outputs_added: rr.outputs_added,
        nullifiers: rr.nullifiers,
        account: rr.account,
    }
}

/// Value payload for a receipt row (the coordinate fields live in the key).
pub(super) struct ReceiptRow {
    pub(super) pcash_transaction_index: u64,
    pub(super) hash: B256,
    pub(super) l1_transaction_hash: B256,
    pub(super) content_hash: B256,
    pub(super) tx_id: B256,
    pub(super) outcome: TransactionOutcome,
    pub(super) failure_detail: Option<pcash_state::FailureDetail>,
    pub(super) l1_sender: Address,
    pub(super) issuance_owner_commitment: Option<B256>,
    pub(super) settled_open_fee_amount: alloy_primitives::U256,
    pub(super) settled_issuance_amount: alloy_primitives::U256,
    pub(super) has_open_fee: bool,
    pub(super) byte_size: u64,
    pub(super) kind: u8,
    pub(super) account_creation: u8,
    pub(super) lifecycle_address: Option<Address>,
    pub(super) output_leaf_start: Option<u64>,
    pub(super) outputs_added: u64,
    pub(super) nullifiers: Option<Vec<B256>>,
    /// Stable account identifier, present only for accepted account writes.
    pub(super) account: Option<AccountReceiptData>,
}

codec_struct!(ReceiptRow {
    pcash_transaction_index,
    hash,
    l1_transaction_hash,
    content_hash,
    tx_id,
    outcome,
    failure_detail,
    l1_sender,
    issuance_owner_commitment,
    settled_open_fee_amount,
    settled_issuance_amount,
    has_open_fee,
    byte_size,
    kind,
    account_creation,
    lifecycle_address,
    output_leaf_start,
    outputs_added,
    nullifiers,
    account
});

/// Value payload for a block-summary row (the L1 block number lives in the key).
pub(super) struct DerivationSummaryRow {
    pub(super) pcash_number: u64,
    pub(super) l1_hash: B256,
    pub(super) timestamp: u64,
    pub(super) state_root: B256,
    pub(super) block_hash: B256,
    pub(super) accepted_count: u64,
    pub(super) skipped_count: u64,
    pub(super) payout_notes: u64,
}

codec_struct!(DerivationSummaryRow {
    pcash_number,
    l1_hash,
    timestamp,
    state_root,
    block_hash,
    accepted_count,
    skipped_count,
    payout_notes
});

impl DerivationSummaryRow {
    pub(super) fn from_boundary(boundary: &pcash_state::CommittedBoundary) -> Self {
        let results = &boundary.block.transaction_results;
        let accepted_count = results
            .iter()
            .filter(|result| result.outcome.is_succeeded())
            .count() as u64;
        Self {
            pcash_number: boundary.block.header.number,
            l1_hash: boundary.l1_origin.block_hash,
            timestamp: boundary.l1_origin.block_timestamp,
            state_root: boundary.block.header.state_root,
            block_hash: boundary.block.hash,
            accepted_count,
            skipped_count: results.len() as u64 - accepted_count,
            payout_notes: boundary.history.payouts.len() as u64,
        }
    }
}

/// Per-block issuance economics mirrored from canonical history plus the
/// post-settlement lag from the authenticated boundary.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockEconomicsRow {
    pub l1_number: u64,
    pub timestamp: u64,
    pub qualifying_actions: u64,
    pub reward_each: U256,
    pub issuance_total: U256,
    pub open_fees_total: U256,
    pub baseline: U256,
    pub internal_offer: U256,
    pub block_allowance: U256,
    pub lag_q: I256,
}

codec_struct!(BlockEconomicsRow {
    l1_number,
    timestamp,
    qualifying_actions,
    reward_each,
    issuance_total,
    open_fees_total,
    baseline,
    internal_offer,
    block_allowance,
    lag_q
});

impl BlockEconomicsRow {
    pub fn from_boundary(boundary: &pcash_state::CommittedBoundary) -> Self {
        let economics = &boundary.history.economics;
        Self {
            l1_number: boundary.l1_origin.block_number,
            timestamp: boundary.block.header.timestamp,
            qualifying_actions: economics.qualifying_actions,
            reward_each: economics.reward_each,
            issuance_total: economics.issuance_total,
            open_fees_total: economics.open_fees_total,
            baseline: economics.baseline,
            internal_offer: economics.internal_offer,
            block_allowance: economics.block_allowance,
            lag_q: boundary.state.state_components().issuance.lag_q,
        }
    }
}
