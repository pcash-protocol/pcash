//! Canonical output-frontier, account-change, and delivery-manifest feeds to
//! RPC mapping.

use pcash_rpc::dto::{
    AccountChangeContinuationDto, AccountChangeDto, AccountChangePageDto, AccountChangeTargetDto,
    BlockId, L1DeliveryBatchContinuationDto, L1DeliveryBatchDto, L1DeliveryBatchPageDto,
    OutputFrontierDto,
};
use pcash_rpc::{AccountChangesRequest, IndexReadError, L1DeliveryBatchesRequest};
use pcash_state::{fr_to_bytes, AccountWriteEntry, RedbReadSnapshot};

/// Require `target` to name a committed canonical block. A height beyond the
/// head is not available yet; another hash at a committed height is another
/// branch.
fn canonical_target(state: &RedbReadSnapshot, target: BlockId) -> Result<(), IndexReadError> {
    if state.canonical_block_number(target.block_hash)? == Some(target.block_number) {
        return Ok(());
    }
    let head = state.canonical_tip_summary()?.map(|tip| tip.number);
    if head.is_none_or(|head| target.block_number > head) {
        return Err(IndexReadError::Unavailable(
            "target is beyond the canonical head".into(),
        ));
    }
    Err(IndexReadError::CursorMismatch)
}

pub(crate) fn get_output_frontier(
    state: &RedbReadSnapshot,
    block: BlockId,
) -> Result<OutputFrontierDto, IndexReadError> {
    canonical_target(state, block)?;
    let frontier = state.output_frontier(block.block_number)?.ok_or_else(|| {
        IndexReadError::Unavailable("canonical block has no state preimage".into())
    })?;
    Ok(OutputFrontierDto {
        block,
        output_count: frontier.output_count,
        output_root: frontier.output_root,
        ommers: frontier.ommers,
    })
}

fn account_change(entry: AccountWriteEntry) -> AccountChangeDto {
    let account = entry.write.account;
    AccountChangeDto {
        origin: BlockId {
            block_number: entry.block_number,
            block_hash: entry.block_hash,
        },
        account_index: account.index,
        address: entry.write.address,
        nullifier_key_commitment: fr_to_bytes(account.nullifier_key_commitment),
        account_rule_set_commitment: fr_to_bytes(account.account_rule_set_commitment),
        account_kind: account.kind,
        account_revision: account.revision,
        receive_key_hash: account.receive_key_hash,
        receive_key: entry.write.published_receive_key.map(Into::into),
    }
}

/// One page of account writes, `fromBlock` through the target block, in
/// canonical order. Page size is charged by each change's JSON encoding.
pub(crate) fn get_account_changes(
    state: &RedbReadSnapshot,
    request: AccountChangesRequest,
) -> Result<AccountChangePageDto, IndexReadError> {
    let target = request.target;
    canonical_target(state, target)?;
    if request.from_block > target.block_number.saturating_add(1) {
        return Err(IndexReadError::CursorMismatch);
    }
    let (next_block, next_ordinal) = match request.continuation {
        Some(continuation) => {
            if continuation.from_block != request.from_block
                || continuation.target != target
                || continuation.next_block < request.from_block
                || continuation.next_block > target.block_number
            {
                return Err(IndexReadError::CursorMismatch);
            }
            (continuation.next_block, continuation.next_ordinal)
        }
        None => (request.from_block, 0),
    };
    let account_count = state
        .state_components_at(target.block_number)?
        .ok_or_else(|| IndexReadError::Unavailable("canonical block has no state preimage".into()))?
        .account_count;

    let max_changes = request.limits.max_changes as usize;
    let max_bytes = request.limits.max_bytes as usize;
    let mut changes = Vec::new();
    let mut encoded_bytes = 0usize;
    let mut next = None;
    for entry in state.account_writes(next_block, next_ordinal, target.block_number)? {
        let entry = entry?;
        let position = (entry.block_number, entry.ordinal);
        let change = account_change(entry);
        let change_bytes = serde_json::to_vec(&change)
            .map_err(|error| IndexReadError::Unavailable(error.to_string()))?
            .len();
        if !changes.is_empty()
            && (changes.len() >= max_changes
                || encoded_bytes.saturating_add(change_bytes) > max_bytes)
        {
            next = Some(position);
            break;
        }
        if changes.is_empty() && change_bytes > max_bytes {
            return Err(IndexReadError::Invalid(
                "maxBytes is too small for one account change".into(),
            ));
        }
        encoded_bytes = encoded_bytes.saturating_add(change_bytes);
        changes.push(change);
    }
    Ok(AccountChangePageDto {
        from_block: request.from_block,
        target: AccountChangeTargetDto {
            block: target,
            account_count,
        },
        changes,
        continuation: next.map(|(next_block, next_ordinal)| AccountChangeContinuationDto {
            from_block: request.from_block,
            target,
            next_block,
            next_ordinal,
        }),
        complete: next.is_none(),
    })
}

/// One page of the manifests of one L1 transaction's carriers, in carrier
/// order. Page size is charged by each manifest's JSON encoding.
///
/// A page holds at least one manifest whatever `maxBytes` asks, so every
/// manifest is retrievable, and one manifest always fits a response. A carrier
/// event's context is part of its log's data; EIP-7825 caps an Ethereum
/// transaction at 2^24 gas and a log spends 8 gas per data byte, so a context
/// holds fewer than 2^21 bytes, under 4 MiB as JSON hex. A manifest has at most
/// `MAX_BATCH_ENTRIES` (1,024) items of under 240 JSON bytes each, about
/// 240 KB, and at most six blob hashes. With its fixed fields, a response
/// holding one manifest is under 4.3 MiB, below the 10 MiB response ceiling.
/// Any other page holds at most `maxBytes`, at most 4 MiB, of manifests.
pub(crate) fn get_l1_delivery_batches(
    state: &RedbReadSnapshot,
    request: L1DeliveryBatchesRequest,
) -> Result<L1DeliveryBatchPageDto, IndexReadError> {
    let l1_transaction_hash = request.l1_transaction_hash;
    let Some((number, batches)) = state.transaction_delivery_batches(l1_transaction_hash)? else {
        // A continuation names manifests that are no longer canonical.
        if request.continuation.is_some() {
            return Err(IndexReadError::CursorMismatch);
        }
        return Ok(L1DeliveryBatchPageDto {
            l1_transaction_hash,
            batches: Vec::new(),
            continuation: None,
            complete: true,
        });
    };
    let stored = state
        .canonical_stored_block(number)?
        .ok_or_else(|| IndexReadError::Unavailable("delivery manifest block is missing".into()))?;
    let block = BlockId {
        block_number: number,
        block_hash: stored.hash,
    };
    // A position at or past the last manifest yields an empty, complete page.
    let start = match request.continuation {
        Some(continuation) => {
            if continuation.block != block {
                return Err(IndexReadError::CursorMismatch);
            }
            usize::try_from(continuation.next_batch).unwrap_or(usize::MAX)
        }
        None => 0,
    };

    let max_batches = request.limits.max_batches as usize;
    let max_bytes = request.limits.max_bytes as usize;
    let mut page = Vec::new();
    let mut encoded_bytes = 0usize;
    let mut next = None;
    for (position, batch) in batches.into_iter().enumerate().skip(start) {
        let batch = L1DeliveryBatchDto::new(&stored.l1_origin, batch);
        let batch_bytes = serde_json::to_vec(&batch)
            .map_err(|error| IndexReadError::Unavailable(error.to_string()))?
            .len();
        if !page.is_empty()
            && (page.len() >= max_batches || encoded_bytes.saturating_add(batch_bytes) > max_bytes)
        {
            next = Some(position as u64);
            break;
        }
        encoded_bytes = encoded_bytes.saturating_add(batch_bytes);
        page.push(batch);
    }
    Ok(L1DeliveryBatchPageDto {
        l1_transaction_hash,
        batches: page,
        continuation: next.map(|next_batch| L1DeliveryBatchContinuationDto { block, next_batch }),
        complete: next.is_none(),
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "tests use direct assertions")]

    use super::*;
    use alloy_primitives::{Address, Bytes, B256};
    use pcash_rpc::dto::CarrierTypeDto;
    use pcash_state::{BatchExclusionReason, ItemExclusionReason, L1DeliveryItem};

    /// The bound stated on [`get_l1_delivery_batches`]: a page holding only the
    /// largest manifest Ethereum allows fits the RPC response ceiling.
    #[test]
    fn the_largest_manifest_fits_one_response() {
        let max_context_bytes = (1usize << 24) / 8;
        let word = B256::repeat_byte(0xff);
        let item = L1DeliveryItem {
            batch_item_index: u64::MAX,
            content_hash: word,
            byte_offset: u64::MAX,
            byte_length: u64::MAX,
            exclusion_reason: Some(ItemExclusionReason::UnknownPublishesNkRootFlag),
        };
        let item_bytes = serde_json::to_vec(&item).unwrap().len();
        assert!(item_bytes < 240, "{item_bytes}");
        let batch = L1DeliveryBatchDto {
            l1_block_number: u64::MAX,
            l1_block_hash: word,
            l1_transaction_index: u64::MAX,
            l1_transaction_hash: word,
            l1_sender: Address::repeat_byte(0xff),
            carrier_type: CarrierTypeDto::Event,
            log_index: Some(u64::MAX),
            emitter: Some(Address::repeat_byte(0xff)),
            context: Some(Bytes::from(vec![0xff; max_context_bytes])),
            carrier_hash: word,
            carrier_length: u64::MAX,
            blob_versioned_hashes: vec![word; pcash_da::MAX_BATCH_BLOBS],
            poster_owner_commitment: Some(word),
            poster_context: Some(word),
            exclusion_reason: Some(BatchExclusionReason::InvalidPosterOwnerCommitment),
            items: vec![item; pcash_derive::MAX_BATCH_ENTRIES],
        };
        let page = L1DeliveryBatchPageDto {
            l1_transaction_hash: word,
            batches: vec![batch],
            continuation: Some(L1DeliveryBatchContinuationDto {
                block: BlockId {
                    block_number: u64::MAX,
                    block_hash: word,
                },
                next_batch: u64::MAX,
            }),
            complete: false,
        };
        let response = serde_json::json!({ "jsonrpc": "2.0", "id": u64::MAX, "result": page });
        let response_bytes = serde_json::to_vec(&response).unwrap().len();
        assert!(response_bytes < 43 * (1 << 20) / 10, "{response_bytes}");
        assert!(response_bytes <= pcash_rpc::server::MAX_RPC_RESPONSE_BODY_BYTES as usize);
    }
}
