//! Request types for the `pcash_*` methods that take an object parameter.
//!
//! The server deserializes exactly these types and the client serializes them,
//! so the two halves of a request shape cannot drift. That holds for every
//! object parameter in the namespace, catalog requests included: those are read
//! from a `Value` so their failures keep the catalog's own error code, but the
//! value is deserialized into the type declared here rather than walked by
//! hand.
//!
//! These describe the wire only. The checks a request must also pass — canonical
//! BN254 field encodings, per-call caps, namespace syntax, a content ID that
//! matches its artifact — stay in the handlers, because they are not statements
//! about JSON. Methods whose parameters are bare scalars take them positionally
//! and are not represented here.

use alloy_primitives::{Address, Bytes, FixedBytes, B256, U256};
use serde::{Deserialize, Serialize};

use crate::dto::{
    AccountChangeContinuationDto, BlockId, ExplorerCursorDto, L1DeliveryBatchContinuationDto,
    MempoolSort, MempoolStatusFilter, OutputContinuationDto, TransactionKind,
};

/// Transaction kinds that can declare a relay fee.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FeeBearingKind {
    PrivateValue,
    ContractAccount,
    UserAccountUpdate,
}

/// `pcash_estimateFee` — an exact byte size or a kind supplying its default.
/// When both are present, the explicit size takes precedence.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FeeEstimateQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<FeeBearingKind>,
    #[serde(
        default,
        with = "alloy_serde::quantity::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub byte_size: Option<u64>,
}

/// `pcash_getBlocks` — an inclusive PCASH height window. An absent `fromBlock`
/// means genesis; an absent (or past-tip) `toBlock` resolves to the current tip.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BlockRangeQuery {
    #[serde(
        default,
        with = "alloy_serde::quantity::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub from_block: Option<u64>,
    #[serde(
        default,
        with = "alloy_serde::quantity::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub to_block: Option<u64>,
    #[serde(default)]
    pub full_transactions: bool,
}

/// `pcash_getTransactions` — newest-first canonical accepted transactions.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TransactionsQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<ExplorerCursorDto>,
    #[serde(
        default,
        with = "alloy_serde::quantity::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub limit: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<TransactionKind>,
    #[serde(
        default,
        with = "alloy_serde::quantity::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub block_number: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SubmissionQuery {
    pub content_hash: B256,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<ExplorerCursorDto>,
    #[serde(
        default,
        with = "alloy_serde::quantity::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub limit: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AccountHistoryQuery {
    pub address: Address,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<ExplorerCursorDto>,
    #[serde(
        default,
        with = "alloy_serde::quantity::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub limit: Option<u64>,
}

/// `pcash_getContracts` — newest-first immutable contract creations.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ContractsQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<ExplorerCursorDto>,
    #[serde(
        default,
        with = "alloy_serde::quantity::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub limit: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_only: Option<bool>,
}

/// `pcash_getMempool` — a page of this node's local, non-consensus view.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MempoolQuery {
    /// Exclusive lower bound: a content hash from a previous page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<B256>,
    #[serde(
        default,
        with = "alloy_serde::quantity::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub limit: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<TransactionKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_open_fee: Option<U256>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<MempoolStatusFilter>,
    /// Keep only entries with publication fields that are open-route or
    /// designated to a listed issuance commitment. Entries without a section, such as
    /// user-account creations, appear only in the unfiltered view.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub controlled_issuance_owner_commitments: Option<Vec<B256>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort: Option<MempoolSort>,
    /// Keep only entries whose arena carries a matching public record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arena: Option<ArenaRecordQuery>,
}

/// A public arena record of `schema` whose data holds every `data` match.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ArenaRecordQuery {
    pub schema: FixedBytes<4>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub data: Vec<ArenaDataMatch>,
}

/// `bytes` at byte `offset` of a record's data.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ArenaDataMatch {
    #[serde(with = "alloy_serde::quantity")]
    pub offset: u64,
    pub bytes: Bytes,
}

/// `pcash_prepareRelay` — the ordered selection a relayer wants framed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PrepareRelayQuery {
    pub content_hashes: Vec<B256>,
    /// Designated commitments the relayer controls, beside the open route.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub controlled_issuance_owner_commitments: Vec<B256>,
    /// Exact entries whose designated issuance the caller independently controls.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub controlled_issuance_content_hashes: Vec<B256>,
    #[serde(with = "alloy_serde::quantity")]
    pub max_batch_bytes: u64,
}

/// `pcash_checkRawTransaction` — exact transaction bytes, and the carrier
/// assumed to deliver them. Byte fields are hex strings, which the server
/// bounds before it decodes them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CheckRawTransactionQuery {
    pub transaction: String,
    pub carrier: CarrierContextQuery,
}

/// A carrier context: an Inbox transaction's sender, which carries an empty
/// context, or a `PcashBatch` event's emitter and hex context.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields, rename_all = "camelCase")]
pub enum CarrierContextQuery {
    Inbox { address: Address },
    Event { address: Address, context: String },
}

/// Page ceilings for `pcash_getL1DeliveryBatches`. Zero or above-bound values are rejected.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct L1DeliveryBatchLimitsQuery {
    #[serde(
        default,
        with = "alloy_serde::quantity::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub max_batches: Option<u32>,
    #[serde(
        default,
        with = "alloy_serde::quantity::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub max_bytes: Option<u32>,
}

/// `pcash_getL1DeliveryBatches` — the manifest of every carrier of one L1
/// transaction, in carrier order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct L1DeliveryBatchesQuery {
    pub l1_transaction_hash: B256,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuation: Option<L1DeliveryBatchContinuationDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limits: Option<L1DeliveryBatchLimitsQuery>,
}

/// One exact L1 batch-entry coordinate.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReceiptInclusionKey {
    pub l1_block_hash: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub l1_transaction_index: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub batch_item_index: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReceiptInclusionQuery {
    pub inclusion_id: ReceiptInclusionKey,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReceiptNullifierQuery {
    pub nullifier: B256,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReceiptAccountQuery {
    pub address: Address,
    #[serde(with = "alloy_serde::quantity")]
    pub account_revision: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReceiptContentQuery {
    pub content_hash: B256,
}

/// The five ways to name an inclusion. Every object form is a closed shape, so a
/// request cannot select one key while another is silently ignored.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ReceiptQuery {
    /// One inclusion-specific transaction ID.
    TxId(B256),
    /// Every canonical inclusion of one exact serialized transaction.
    Content(ReceiptContentQuery),
    Inclusion(ReceiptInclusionQuery),
    Nullifier(ReceiptNullifierQuery),
    Account(ReceiptAccountQuery),
}

impl ReceiptQuery {
    pub fn tx_id(tx_id: B256) -> Self {
        Self::TxId(tx_id)
    }

    pub fn nullifier(nullifier: B256) -> Self {
        Self::Nullifier(ReceiptNullifierQuery { nullifier })
    }

    pub fn content_hash(content_hash: B256) -> Self {
        Self::Content(ReceiptContentQuery { content_hash })
    }

    pub fn inclusion(
        l1_block_hash: B256,
        l1_transaction_index: u64,
        batch_item_index: u64,
    ) -> Self {
        Self::Inclusion(ReceiptInclusionQuery {
            inclusion_id: ReceiptInclusionKey {
                l1_block_hash,
                l1_transaction_index,
                batch_item_index,
            },
        })
    }

    pub fn account(address: Address, account_revision: u32) -> Self {
        Self::Account(ReceiptAccountQuery {
            address,
            account_revision,
        })
    }
}

/// Page ceilings a caller may ask for. Zero or above-bound values are rejected.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OutputLimitsQuery {
    #[serde(
        default,
        with = "alloy_serde::quantity::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub max_outputs: Option<u32>,
    #[serde(
        default,
        with = "alloy_serde::quantity::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub max_bytes: Option<u32>,
}

/// `pcash_getOutputs` — output rows in a output-index interval pinned to one block.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OutputQuery {
    #[serde(with = "alloy_serde::quantity")]
    pub from_output_index: u64,
    pub target: BlockId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuation: Option<OutputContinuationDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limits: Option<OutputLimitsQuery>,
}

/// Page ceilings for `pcash_getAccountChanges`. Zero or above-bound values are rejected.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AccountChangeLimitsQuery {
    #[serde(
        default,
        with = "alloy_serde::quantity::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub max_changes: Option<u32>,
    #[serde(
        default,
        with = "alloy_serde::quantity::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub max_bytes: Option<u32>,
}

/// `pcash_getAccountChanges` — every account write from `fromBlock` through
/// the target block, both inclusive, in canonical order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AccountChangesQuery {
    #[serde(with = "alloy_serde::quantity")]
    pub from_block: u64,
    pub target: BlockId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuation: Option<AccountChangeContinuationDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limits: Option<AccountChangeLimitsQuery>,
}

/// `pcash_catalogList` — one page of a namespace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CatalogListQuery {
    pub namespace: String,
    /// Exclusive lower bound. It need not exist, so a caller may page from any
    /// content ID.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<B256>,
    #[serde(
        default,
        with = "alloy_serde::quantity::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub limit: Option<u64>,
}

/// `pcash_catalogGet` — one record by content ID.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CatalogGetQuery {
    pub namespace: String,
    pub content_id: B256,
}

/// Witnesses collected from one current canonical snapshot.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WitnessSnapshotQuery {
    #[serde(default)]
    pub accounts: Vec<Address>,
    #[serde(default)]
    pub contracts: Vec<Address>,
    #[serde(default, with = "alloy_serde::quantity::vec")]
    pub outputs: Vec<u64>,
    #[serde(default)]
    pub nullifiers: Vec<B256>,
    #[serde(default)]
    pub l1_logs: Vec<WitnessL1LogQuery>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WitnessL1LogQuery {
    #[serde(with = "alloy_serde::quantity")]
    pub l1_block_number: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub transaction_index: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub log_index: u64,
}

/// A forward range of per-block issuance economics from the derived index.
/// Records aggregate `bucket` consecutive PCASH blocks, aligned to multiples
/// of `bucket`, starting at the bucket containing `fromBlock`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlockEconomicsQuery {
    #[serde(
        default,
        with = "alloy_serde::quantity::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub from_block: Option<u64>,
    #[serde(
        default,
        with = "alloy_serde::quantity::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub limit: Option<u64>,
    #[serde(
        default,
        with = "alloy_serde::quantity::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub bucket: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PayoutQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<crate::dto::PayoutCursorDto>,
    #[serde(
        default,
        with = "alloy_serde::quantity::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub limit: Option<u64>,
    #[serde(
        default,
        with = "alloy_serde::quantity::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub from_block: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IssuanceQuoteQuery {
    #[serde(with = "alloy_serde::quantity")]
    pub candidate_timestamp: u64,
}
