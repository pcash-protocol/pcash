//! Canonical non-state history retained by every full node.

use crate::codec::{codec_enum, codec_struct, codec_variants, Codec};
use crate::{fr_from_internal_word, output_commitment, u256_to_fr};
use alloy_primitives::{Address, B256, U256};
use pcash_crypto::{domain_tags, poseidon, Fr};
use serde::{Deserialize, Serialize};

/// How a carrier delivered its batch: an Inbox transaction's calldata or
/// blobs, or a carrier event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CarrierType {
    Calldata,
    Blob,
    /// The log at receipt-local `log_index` emitted by `emitter`, and its
    /// `context` when its data is the canonical encoding.
    Event {
        log_index: u64,
        emitter: Address,
        context: Option<Vec<u8>>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BatchExclusionReason {
    UnsupportedCarrierEncoding,
    InvalidCarrierEncoding,
    UnsupportedBatchVersion,
    InvalidPosterOwnerCommitment,
    InvalidPosterContext,
    BatchCountLimit,
    TruncatedFraming,
    TrailingBatchBytes,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemExclusionReason {
    ItemTooLarge,
    Empty,
    UnknownKind,
    UnknownPrivateValueShape,
    UnknownAuthorizationMode,
    UnknownFundingMode,
    UnknownReceiveKeyMode,
    UnknownPublishesNkRootFlag,
    UnknownYParity,
    Truncated,
    TrailingBytes,
    WrongChainId,
    DirectModeOutsideInbox,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct L1DeliveryItem {
    #[serde(with = "alloy_serde::quantity")]
    pub batch_item_index: u64,
    pub content_hash: B256,
    /// The item's offset in its carrier's candidate batch. A carrier event's
    /// batch is its decoded `batch` field, which starts after the log data's
    /// ABI head, context, and batch length, while the carrier hash and length
    /// cover the whole log data.
    #[serde(with = "alloy_serde::quantity")]
    pub byte_offset: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub byte_length: u64,
    /// `None` exactly when the item was admitted.
    pub exclusion_reason: Option<ItemExclusionReason>,
}

/// Compact manifest for one carrier. It deliberately retains no raw rejected
/// bytes; its L1 coordinates, log index, and blob hashes identify the external
/// retrieval path when those bytes are needed. Its Ethereum block is the L1
/// origin of the block that retains it. For a carrier event, the carrier hash
/// and length cover the log's whole data.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct L1DeliveryBatch {
    pub l1_transaction_index: u64,
    pub l1_transaction_hash: B256,
    pub l1_sender: Address,
    pub carrier_type: CarrierType,
    pub carrier_hash: B256,
    pub carrier_length: u64,
    pub blob_versioned_hashes: Vec<B256>,
    pub poster_owner_commitment: Option<B256>,
    pub poster_context: Option<B256>,
    pub exclusion_reason: Option<BatchExclusionReason>,
    /// The batch item index of the first item: the number of items in the
    /// L1 transaction's earlier carriers. A carrier with no items has one too.
    pub first_batch_item_index: u64,
    pub items: Vec<L1DeliveryItem>,
}

/// The delivery batch and manifest item of one admitted transaction, from its
/// block's batches, by `(l1TransactionIndex, batchItemIndex)`. Batches are in
/// L1 transaction order and then carrier order, and a batch's items are dense
/// by batch item index, so each batch ends where the next one in its L1
/// transaction starts and one binary search finds the item.
pub fn admitted_delivery<'a>(
    batches: &'a [L1DeliveryBatch],
    result: &crate::TransactionResult,
) -> Option<(&'a L1DeliveryBatch, &'a L1DeliveryItem)> {
    let position = batches.partition_point(|batch| {
        (
            batch.l1_transaction_index,
            batch.first_batch_item_index + batch.items.len() as u64,
        ) <= (result.l1_transaction_index, result.batch_item_index)
    });
    let batch = batches
        .get(position)
        .filter(|batch| batch.l1_transaction_index == result.l1_transaction_index)?;
    let offset = result
        .batch_item_index
        .checked_sub(batch.first_batch_item_index)?;
    Some((batch, batch.items.get(usize::try_from(offset).ok()?)?))
}

/// One system payout note. The source identifies its provenance; the component
/// identifies whether the note contains an open fee or issuance.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PayoutRecord {
    pub source: PayoutSource,
    pub component: PayoutComponent,
    pub amount: U256,
    pub owner_commitment: B256,
    pub output_index: u64,
    /// Designated: the transaction context. Poster: the distinct contexts of
    /// the contributing batches in encounter order.
    pub contexts: Vec<B256>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PayoutComponent {
    OpenFee,
    Issuance,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PayoutSource {
    /// Issuance of one transaction paid to its nonzero
    /// `issuanceOwnerCommitment`.
    DesignatedIssuance {
        l1_transaction_index: u64,
        batch_item_index: u64,
    },
    /// Open fees or issuance aggregated across the block for one
    /// `posterOwnerCommitment`, paid as separate notes.
    PosterPayout { l1_transaction_indices: Vec<u64> },
}

/// The output commitment of a payout: a native (`assetId = 0`) note of
/// `amount` owned by `owner`, at `output_index`.
pub fn payout_output_commitment(owner: Fr, amount: U256, output_index: u64) -> Fr {
    let body = poseidon(&[
        domain_tags::NOTE_BODY_COMMITMENT_DOMAIN,
        owner,
        Fr::from(0u64),
        u256_to_fr(amount),
    ]);
    output_commitment(body, output_index)
}

impl PayoutRecord {
    /// The [`payout_output_commitment`] of this stored record.
    pub fn output_commitment(&self) -> Fr {
        payout_output_commitment(
            fr_from_internal_word(self.owner_commitment),
            self.amount,
            self.output_index,
        )
    }

    /// The existing two-component preimage committed by the payout result.
    pub fn result_components(&self) -> (U256, U256) {
        match self.component {
            PayoutComponent::OpenFee => (self.amount, U256::ZERO),
            PayoutComponent::Issuance => (U256::ZERO, self.amount),
        }
    }

    /// The source transaction of a designated payout in the block whose L1
    /// origin hash is `l1_block_hash`. Poster payouts have none.
    pub fn transaction_id(&self, l1_block_hash: B256) -> Option<B256> {
        match &self.source {
            PayoutSource::DesignatedIssuance {
                l1_transaction_index,
                batch_item_index,
            } => Some(crate::transaction_id(
                l1_block_hash,
                *l1_transaction_index,
                *batch_item_index,
            )),
            PayoutSource::PosterPayout { .. } => None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BlockEconomics {
    pub open_fees_total: U256,
    pub issuance_total: U256,
    pub qualifying_actions: u64,
    pub reward_each: U256,
    pub baseline: U256,
    pub internal_offer: U256,
    pub block_allowance: U256,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CanonicalBlockHistory {
    pub l1_delivery_batches: Vec<L1DeliveryBatch>,
    pub economics: BlockEconomics,
    pub payouts: Vec<PayoutRecord>,
}

impl crate::codec::Codec for CarrierType {
    fn write(&self, w: &mut crate::codec::Writer) {
        match self {
            Self::Calldata => w.u8(0),
            Self::Blob => w.u8(1),
            Self::Event {
                log_index,
                emitter,
                context,
            } => {
                w.u8(2);
                log_index.write(w);
                emitter.write(w);
                context.write(w);
            }
        }
    }

    fn read(r: &mut crate::codec::Reader<'_>) -> Result<Self, crate::codec::DecodeError> {
        Ok(match u8::read(r)? {
            0 => Self::Calldata,
            1 => Self::Blob,
            2 => Self::Event {
                log_index: Codec::read(r)?,
                emitter: Codec::read(r)?,
                context: Codec::read(r)?,
            },
            _ => return Err(crate::codec::DecodeError::Invalid("CarrierType")),
        })
    }
}

codec_enum!(BatchExclusionReason: u8 {
    UnsupportedCarrierEncoding,
    InvalidCarrierEncoding,
    UnsupportedBatchVersion,
    InvalidPosterOwnerCommitment,
    InvalidPosterContext,
    BatchCountLimit,
    TruncatedFraming,
    TrailingBatchBytes,
});

codec_enum!(ItemExclusionReason: u8 {
    ItemTooLarge,
    Empty,
    UnknownKind,
    UnknownPrivateValueShape,
    UnknownAuthorizationMode,
    UnknownFundingMode,
    UnknownReceiveKeyMode,
    UnknownPublishesNkRootFlag,
    UnknownYParity,
    Truncated,
    TrailingBytes,
    WrongChainId,
    DirectModeOutsideInbox,
});

codec_struct!(L1DeliveryItem {
    batch_item_index,
    content_hash,
    byte_offset,
    byte_length,
    exclusion_reason,
});

codec_struct!(L1DeliveryBatch {
    l1_transaction_index,
    l1_transaction_hash,
    l1_sender,
    carrier_type,
    carrier_hash,
    carrier_length,
    blob_versioned_hashes,
    poster_owner_commitment,
    poster_context,
    exclusion_reason,
    first_batch_item_index,
    items,
});

codec_variants!(PayoutSource: u8 {
    0 => DesignatedIssuance { l1_transaction_index, batch_item_index },
    1 => PosterPayout { l1_transaction_indices },
});

codec_enum!(PayoutComponent: u8 { OpenFee, Issuance });

codec_struct!(PayoutRecord {
    source,
    component,
    amount,
    owner_commitment,
    output_index,
    contexts,
});

codec_struct!(BlockEconomics {
    open_fees_total,
    issuance_total,
    qualifying_actions,
    reward_each,
    baseline,
    internal_offer,
    block_allowance,
});

codec_struct!(CanonicalBlockHistory {
    l1_delivery_batches,
    economics,
    payouts,
});

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    reason = "tests use direct assertions for fixture setup"
)]
mod tests {
    use super::*;

    fn manifest(l1_transaction_index: u64, items: std::ops::Range<u64>) -> L1DeliveryBatch {
        L1DeliveryBatch {
            l1_transaction_index,
            l1_transaction_hash: B256::with_last_byte(l1_transaction_index as u8),
            l1_sender: Address::ZERO,
            carrier_type: CarrierType::Calldata,
            carrier_hash: B256::ZERO,
            carrier_length: 0,
            blob_versioned_hashes: Vec::new(),
            poster_owner_commitment: None,
            poster_context: None,
            exclusion_reason: None,
            first_batch_item_index: items.start,
            items: items
                .map(|batch_item_index| L1DeliveryItem {
                    batch_item_index,
                    content_hash: B256::with_last_byte(batch_item_index as u8),
                    byte_offset: 0,
                    byte_length: 0,
                    exclusion_reason: None,
                })
                .collect(),
        }
    }

    fn result(l1_transaction_index: u64, batch_item_index: u64) -> crate::TransactionResult {
        crate::TransactionResult {
            tx_type: 0,
            funding_mode: 0,
            l1_transaction_index,
            batch_item_index,
            outcome: crate::TransactionOutcome::Succeeded,
            poster_owner_commitment: B256::ZERO,
            output_start_index: 0,
            statement_hash: B256::ZERO,
        }
    }

    /// An item is found by its coordinates among every carrier of its
    /// Ethereum transaction, including ignored carriers with no items.
    #[test]
    fn an_admitted_item_is_found_among_its_transactions_carriers() {
        let batches = [
            manifest(1, 0..1),
            manifest(2, 0..2),
            manifest(2, 2..2),
            manifest(2, 2..5),
            manifest(5, 0..0),
            manifest(5, 0..1),
            manifest(5, 1..1),
        ];
        for (l1_transaction_index, batch_item_index, batch) in [
            (1, 0, 0),
            (2, 0, 1),
            (2, 1, 1),
            (2, 2, 3),
            (2, 4, 3),
            (5, 0, 5),
        ] {
            let (found, item) =
                admitted_delivery(&batches, &result(l1_transaction_index, batch_item_index))
                    .unwrap();
            assert_eq!(found, &batches[batch]);
            assert_eq!(item.batch_item_index, batch_item_index);
        }
        for (l1_transaction_index, batch_item_index) in [(2, 5), (3, 0), (1, 1), (5, 1), (6, 0)] {
            assert!(
                admitted_delivery(&batches, &result(l1_transaction_index, batch_item_index))
                    .is_none()
            );
        }
    }
}
