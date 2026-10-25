//! Ordered transaction execution and complete-block note settlement.
//!
//! Derivation executes each admitted transaction against the state produced by
//! all prior successful transactions (committed state plus this block's pending
//! mutations). A transaction either succeeds, folding its nullifiers, output
//! commitments, and account writes into the block's execution context and
//! in-block overlay, or fails atomically with its first failing check, leaving
//! state unchanged. After every transaction executes, each successful
//! transaction's open fee settles to its poster and its issuance settles to
//! the designated owner or poster. The block's [`BlockUpdate`] is built from
//! the executed mutations and the settlement, then committed.

use crate::private_value_profiles::PrivateValueProfile;
#[cfg(test)]
use crate::private_value_profiles::S;
use std::collections::{HashMap, HashSet};

use alloy_primitives::{keccak256, Address, B256, U256};
use pcash_crypto::{domain_tags, poseidon, Fr};
use pcash_l1::{
    carrier_context_hash, inbox_carrier_context_hash, Carrier, CarrierKind, CarrierSource,
    L1BlockData, L1Header, L1Tx, NormalizedLogBlock,
};
use pcash_state::{
    account_state_commitment, addr_to_fr, content_hash, fr_from_canonical_bytes,
    fr_from_internal_word, fr_to_bytes, output_commitment, payout_output_commitment,
    transaction_statement_hash, AcceptedEffects, AccountField, AccountKindDetail, AccountOp,
    AccountResult, BatchExclusionReason, BlockEconomics, BlockInput, BlockUpdate,
    CanonicalBlockHistory, CarrierType, CircuitWord, CommittedBoundary, ContractField,
    DerivationSource, FailureDetail, FailureDetailSeed, ItemExclusionReason, L1DeliveryBatch,
    L1DeliveryItem, L1LogLeaf, L1Origin, PayoutComponent, PayoutIntent, PayoutRecord, PayoutSource,
    ReceiveKeyOperation, RejectedEffects, SparseTree, StateDb, StateError, TransactionEffects,
    TransactionOutcome, TransactionResult, MAX_LEAVES, RECENT_PCASH_BLOCK_WINDOW_SECONDS,
};
use pcash_verify::{Verifier, VerifyError};
use std::time::Instant;

use crate::admission::{AdmittedTransaction, ContractBodyCheck};
use crate::params::{
    ProtocolRules, ACCOUNT_KIND_CONTRACT, ACCOUNT_KIND_USER, KIND_CONTRACT_ACCOUNT_CREATION,
    KIND_PRIVATE_VALUE, KIND_USER_ACCOUNT_UPDATE,
};
use crate::prewarm::{
    CarrierFraming, PreparedBatch, PreparedBatchItem, PreparedBlock, PreparedCarrier,
};
use crate::transaction::{
    words_blob, ContractAccountCreation, ContractBody, ContractFunding, PrivateValueSection,
    ReceiveKeyUpdate, UserAccountCreation, UserAccountUpdate,
};

const ACCOUNT_RULE_TREE_DEPTH: usize = 8;

/// A fatal derivation error halts the node. A verifier *tool* failure or a
/// state backend failure means we cannot compute the block's
/// consensus transition. A failing transaction is never an error; it is an
/// outcome other than [`TransactionOutcome::Succeeded`].
#[derive(Debug, thiserror::Error)]
pub enum DeriveError {
    #[error("verifier tool failure: {0}")]
    Verify(#[from] VerifyError),
    #[error("state backend failure: {0}")]
    State(#[from] StateError),
    #[error("L1 genesis anchor mismatch at block {block}: expected {expected}, got {actual}")]
    GenesisAnchorMismatch {
        block: u64,
        expected: B256,
        actual: B256,
    },
    /// A block's header timestamp went backwards relative to the previously
    /// derived block. Ethereum PoS consensus forbids this, so it can only mean
    /// corrupt input; deriving through it would mis-schedule
    /// transaction timing, so it halts the node.
    #[error(
        "L1 header timestamp regression at block {block}: parent ts {parent_ts}, block ts {ts}"
    )]
    TimestampRegression { block: u64, parent_ts: u64, ts: u64 },
    #[error("PCASH block number overflow")]
    BlockNumberOverflow,
    #[error("blob carrier for L1 transaction {transaction} was not resolved")]
    UnresolvedBlobCarrier { transaction: B256 },
}

/// Only successful type `0x00` actions earn issuance. The qualifying-action
/// count, the issuance slot reservation, settlement, receipts, and the
/// mempool's paying classification all use this predicate.
pub const fn earns_issuance(kind: u8) -> bool {
    kind == KIND_PRIVATE_VALUE
}

/// The full transition derived from one L1 block. The committed boundary
/// records every transaction's outcome and every excluded item's reason.
#[derive(Clone, Debug)]
pub struct BlockOutcome {
    pub committed_boundary: CommittedBoundary,
    /// The effects of every admitted transaction, aligned with the block's
    /// transaction results.
    pub transaction_effects: Vec<TransactionEffects>,
    /// Every log of the L1 block and its tree; the commit stores the leaves.
    pub l1_logs: NormalizedLogBlock,
}

/// Execute ordered admitted transactions against the supplied state snapshot
/// in one shared, non-committing overlay, returning each one's outcome. A
/// successful transaction affects later ones in the slice exactly as it does
/// within an L1 block, including first-valid-wins nullifier handling,
/// account-revision overlays, and output-leaf assignment. Execution is the same
/// [`BlockCtx::execute`] path L1 derivation uses.
///
/// `current_timestamp` is the candidate L1 timestamp used for expiry and root
/// window checks; the caller admitted each transaction at that timestamp, for
/// `carrier`'s kind or for an Inbox carrier when there is none. The
/// transactions execute as the items of `carrier`: a nonzero
/// `carrierContextHash` is checked against its hash, and a direct-mode
/// creation, which admission excludes from an event carrier, registers its
/// address. Without a carrier, no carrier-context condition is evaluated and
/// a direct-mode creation names no account. Fee deltas remain inside the
/// discarded validation context.
pub fn validate_transactions<S: StateDb, V: Verifier>(
    state: &S,
    rules: &ProtocolRules,
    verifier: &V,
    current_timestamp: u64,
    carrier: Option<CarrierContext>,
    transactions: &[&AdmittedTransaction],
) -> Result<Vec<TransactionOutcome>, DeriveError> {
    let mut ctx = validation_context(state, rules, current_timestamp);
    // With no batch poster, every transaction's poster owner commitment is
    // zero.
    transactions
        .iter()
        .map(|transaction| {
            Ok(ctx
                .execute(
                    state,
                    verifier,
                    carrier.map(|carrier| carrier.address),
                    carrier.map(|carrier| carrier.hash),
                    Fr::from(0u64),
                    transaction,
                )?
                .outcome)
        })
        .collect()
}

/// A carrier context (§9.1), by its hash: the carrier assumed to deliver the
/// transactions that [`validate_transactions`] executes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CarrierContext {
    kind: CarrierKind,
    /// The Inbox transaction's sender or the carrier event's emitter.
    address: Address,
    hash: Fr,
}

impl CarrierContext {
    /// An Inbox transaction sent by `sender`.
    pub fn inbox(sender: Address) -> Self {
        Self {
            kind: CarrierKind::Inbox,
            address: sender,
            hash: inbox_carrier_context_hash(sender),
        }
    }

    /// A `PcashBatch` event emitted by `emitter` with `context`.
    pub fn event(emitter: Address, context: &[u8]) -> Self {
        Self {
            kind: CarrierKind::Event,
            address: emitter,
            hash: carrier_context_hash(CarrierKind::Event, emitter.into_array(), context),
        }
    }

    pub fn kind(&self) -> CarrierKind {
        self.kind
    }
}

/// A non-committing context for executing transactions in a block at
/// `current_timestamp` on top of `state`.
fn validation_context<'a, S: StateDb>(
    state: &S,
    rules: &'a ProtocolRules,
    current_timestamp: u64,
) -> BlockCtx<'a> {
    let elapsed_seconds = state.canonical_tip().map_or(0, |_| {
        current_timestamp.saturating_sub(state.last_l1_timestamp())
    });
    BlockCtx::new(
        rules,
        state.derivation_source(),
        current_timestamp,
        state.output_count(),
        state.account_count(),
        pcash_issuance::reward_slot_active(state.issuance_state(), elapsed_seconds),
    )
}

/// Derive one L1 block against the current state and commit it. The network
/// identity is the state's own derivation source, and items are admitted at
/// the block's L1 timestamp.
pub fn derive_block<S: StateDb, V: Verifier>(
    state: &mut S,
    block: &L1BlockData,
    rules: &ProtocolRules,
    verifier: &V,
) -> Result<BlockOutcome, DeriveError> {
    let prepared =
        crate::prewarm::prepare_block(block, rules, &state.derivation_source(), verifier);
    let cached = pcash_verify::CachedVerifier::new_complete(prepared.cache(), verifier);
    derive_prepared_block(state, &prepared, &cached)
}

/// Derive the exact block admitted and prewarmed off-lock by `prepare_block`:
/// execute its transactions, settle, and commit.
pub fn derive_prepared_block<S: StateDb, V: Verifier>(
    state: &mut S,
    prepared: &PreparedBlock<'_>,
    verifier: &V,
) -> Result<BlockOutcome, DeriveError> {
    let header = &prepared.block.header;
    let source = state.derivation_source();
    let last_ts = state.last_l1_timestamp();
    check_l1_header(header, &source, last_ts)?;
    let elapsed_seconds = controller_elapsed_seconds(
        header.number,
        source.genesis_l1_block,
        header.timestamp,
        last_ts,
    );
    let issuance_terms = pcash_issuance::block_terms(state.issuance_state(), elapsed_seconds);
    let ctx = BlockCtx::new(
        prepared.rules,
        source,
        header.timestamp,
        state.output_count(),
        state.account_count(),
        issuance_terms.quote.reward_possible(),
    );

    let execute_started = Instant::now();
    let executed = ctx.execute_carriers(state, verifier, prepared)?;
    let execute_ms = execute_started.elapsed().as_millis() as u64;

    // Settle only after the complete successful set is known. All destinations
    // and contexts were captured by the same execution pass as the ledger
    // effects.
    let fee_started = Instant::now();
    let settlement = settle_block(
        issuance_terms,
        &executed.transactions,
        executed.next_output_index,
    );
    let update = BlockUpdate {
        nullifiers: executed.nullifiers,
        account_ops: executed.account_ops,
        output_commitments: [executed.output_commitments, settlement.payout_commitments].concat(),
        issuance: settlement.issuance,
    };
    let fee_ms = fee_started.elapsed().as_millis() as u64;

    let pcash_number = next_pcash_number(state.canonical_tip().map(|tip| tip.header.number))?;
    let l1_logs = prepared.block.normalized_logs().clone();
    let carriers = executed.batches.len();
    let transactions = executed.transactions.len();
    let block_input = assemble_block_input(
        header,
        pcash_number,
        &l1_logs,
        executed.transactions,
        CanonicalBlockHistory {
            l1_delivery_batches: executed.batches,
            economics: settlement.economics,
            payouts: settlement.payouts,
        },
    );

    let commit_started = Instant::now();
    let (committed_boundary, transaction_effects) = state.commit(block_input, update)?;
    let commit_ms = commit_started.elapsed().as_millis() as u64;
    tracing::debug!(
        block = header.number,
        carriers,
        transactions,
        execute_ms,
        fee_ms,
        commit_ms,
        "derived block phases"
    );
    Ok(BlockOutcome {
        committed_boundary,
        transaction_effects,
        l1_logs,
    })
}

/// Halt on an L1 header that cannot extend the derived chain.
fn check_l1_header(
    header: &L1Header,
    source: &DerivationSource,
    last_ts: u64,
) -> Result<(), DeriveError> {
    if header.number == source.genesis_l1_block && header.hash != source.genesis_l1_block_hash {
        return Err(DeriveError::GenesisAnchorMismatch {
            block: header.number,
            expected: source.genesis_l1_block_hash,
            actual: header.hash,
        });
    }
    // Header timestamps never regress under PoS consensus; equal timestamps
    // (instant-mining devnets) are tolerated and simply cover zero seconds. Only
    // post-genesis blocks have a previous timestamp to compare against.
    if header.number != source.genesis_l1_block && header.timestamp < last_ts {
        return Err(DeriveError::TimestampRegression {
            block: header.number,
            parent_ts: last_ts,
            ts: header.timestamp,
        });
    }
    Ok(())
}

/// One admitted transaction's execution at its position: its committed
/// result, which names the poster settlement pays, its exact bytes, and its
/// batch's poster context.
struct ExecutedTransaction<'a> {
    result: TransactionResult,
    raw: &'a [u8],
    effects: TransactionEffects,
    poster_context: B256,
}

/// What executing the block's carriers hands to settlement and the commit:
/// the executed transactions, their delivery records, and the successful
/// transactions' nullifiers, output commitments, and account writes in
/// execution order.
struct ExecutedCarriers<'a> {
    /// Every admitted transaction of every accepted batch, in canonical order.
    transactions: Vec<ExecutedTransaction<'a>>,
    /// One delivery record per carrier.
    batches: Vec<L1DeliveryBatch>,
    nullifiers: Vec<B256>,
    output_commitments: Vec<Fr>,
    account_ops: Vec<AccountOp>,
    /// The output index after the transactions' outputs, where payouts start.
    next_output_index: u64,
}

impl BlockCtx<'_> {
    /// Execute every carrier's admitted transactions, ordered by L1
    /// transaction index, then carrier order, then position in the batch.
    /// `batchItemIndex` counts the items of every validly framed carrier of
    /// one L1 transaction in that order.
    fn execute_carriers<'a, S: StateDb, V: Verifier>(
        mut self,
        state: &S,
        verifier: &V,
        prepared: &'a PreparedBlock<'_>,
    ) -> Result<ExecutedCarriers<'a>, DeriveError> {
        let mut transactions = Vec::new();
        let mut batches = Vec::with_capacity(prepared.carriers.len());
        // The L1 transaction of the previous carrier and the batch item index
        // its next framed item takes.
        let mut next_item = None;
        for PreparedCarrier { carrier, framing } in &prepared.carriers {
            let tx = carrier.tx;
            let first_item_index = match next_item {
                Some((tx_index, index)) if tx_index == tx.tx_index => index,
                _ => 0,
            };
            let delivery = match framing {
                CarrierFraming::Ignored => {
                    let (identity, exclusion_reason) = ignored_carrier(carrier);
                    delivery_batch(
                        carrier,
                        identity,
                        Some(exclusion_reason),
                        None,
                        first_item_index,
                        Vec::new(),
                    )
                }
                CarrierFraming::Unresolved => {
                    return Err(DeriveError::UnresolvedBlobCarrier {
                        transaction: tx.hash,
                    });
                }
                // Batch-level failure → whole batch ignored.
                CarrierFraming::Excluded { bytes, reason } => delivery_batch(
                    carrier,
                    carrier_identity(carrier, bytes),
                    Some(*reason),
                    None,
                    first_item_index,
                    Vec::new(),
                ),
                CarrierFraming::Batch(batch) => {
                    let items = self.execute_batch(
                        state,
                        verifier,
                        tx,
                        first_item_index,
                        batch,
                        &mut transactions,
                    )?;
                    delivery_batch(
                        carrier,
                        carrier_identity(carrier, batch.bytes),
                        None,
                        Some(batch),
                        first_item_index,
                        items,
                    )
                }
            };
            next_item = Some((tx.tx_index, first_item_index + delivery.items.len() as u64));
            batches.push(delivery);
        }
        Ok(ExecutedCarriers {
            transactions,
            batches,
            nullifiers: self.nullifiers,
            output_commitments: self.output_commitments,
            account_ops: self.account_ops,
            next_output_index: self.next_output_index,
        })
    }

    /// Execute one accepted batch's admitted transactions in order, its first
    /// item at `first_item_index`, appending each to `transactions` and
    /// returning the batch's delivery items. `tx.from` is the sender a
    /// direct-mode creation registers; admission excludes direct mode from
    /// every carrier but an Inbox carrier.
    fn execute_batch<'a, S: StateDb, V: Verifier>(
        &mut self,
        state: &S,
        verifier: &V,
        tx: &L1Tx,
        first_item_index: u64,
        batch: &'a PreparedBatch<'_>,
        transactions: &mut Vec<ExecutedTransaction<'a>>,
    ) -> Result<Vec<L1DeliveryItem>, DeriveError> {
        let mut items = Vec::with_capacity(batch.items.len());
        for (position, PreparedBatchItem { raw, admission }) in batch.items.iter().enumerate() {
            let batch_item_index = first_item_index + position as u64;
            let exclusion_reason = match admission {
                Ok(transaction) => {
                    let execution = self.execute(
                        state,
                        verifier,
                        Some(tx.from),
                        Some(batch.carrier_context_hash),
                        batch.poster_owner_commitment,
                        transaction,
                    )?;
                    let output_start_index = execution
                        .effects
                        .accepted()
                        .and_then(|effects| effects.output_leaf_start)
                        .unwrap_or(0);
                    transactions.push(ExecutedTransaction {
                        result: TransactionResult {
                            tx_type: transaction.kind(),
                            funding_mode: transaction.funding_mode(),
                            l1_transaction_index: tx.tx_index,
                            batch_item_index,
                            outcome: execution.outcome,
                            poster_owner_commitment: fr_to_bytes(batch.poster_owner_commitment),
                            output_start_index,
                            statement_hash: execution.statement_hash,
                        },
                        raw,
                        effects: execution.effects,
                        poster_context: batch.poster_context,
                    });
                    None
                }
                Err(reason) => Some(*reason),
            };
            items.push(delivery_item(
                batch_item_index,
                raw,
                batch.bytes,
                content_hash(raw),
                exclusion_reason,
            ));
        }
        Ok(items)
    }
}

/// The delivery record of one batch item, with the reason it was excluded if
/// it was not admitted. `raw` is a subslice of `batch_bytes`.
fn delivery_item(
    batch_item_index: u64,
    raw: &[u8],
    batch_bytes: &[u8],
    content_hash: B256,
    exclusion_reason: Option<ItemExclusionReason>,
) -> L1DeliveryItem {
    L1DeliveryItem {
        batch_item_index,
        content_hash,
        byte_offset: (raw.as_ptr() as usize - batch_bytes.as_ptr() as usize) as u64,
        byte_length: raw.len() as u64,
        exclusion_reason,
    }
}

/// The hash and length a carrier's manifest records: a carrier event's whole
/// log data, and an Inbox carrier's candidate `batch` bytes.
fn carrier_identity(carrier: &Carrier<'_>, batch: &[u8]) -> (B256, usize) {
    match carrier.source {
        CarrierSource::Inbox => (keccak256(batch), batch.len()),
        CarrierSource::Event { log, .. } => (keccak256(&log.data), log.data.len()),
    }
}

/// The delivery record of one carrier with its manifest hash and length.
/// `batch` is present exactly when the batch was accepted.
fn delivery_batch(
    carrier: &Carrier<'_>,
    (carrier_hash, carrier_length): (B256, usize),
    exclusion_reason: Option<BatchExclusionReason>,
    batch: Option<&PreparedBatch<'_>>,
    first_batch_item_index: u64,
    items: Vec<L1DeliveryItem>,
) -> L1DeliveryBatch {
    let tx = carrier.tx;
    let (carrier_type, blob_versioned_hashes) = match carrier.source {
        CarrierSource::Inbox if tx.blob_versioned_hashes.is_empty() => {
            (CarrierType::Calldata, Vec::new())
        }
        CarrierSource::Inbox => (CarrierType::Blob, tx.blob_versioned_hashes.clone()),
        CarrierSource::Event { log, decoded } => (
            CarrierType::Event {
                log_index: log.log_index,
                emitter: log.emitter,
                context: decoded.map(|data| data.context.to_vec()),
            },
            Vec::new(),
        ),
    };
    L1DeliveryBatch {
        l1_transaction_index: tx.tx_index,
        l1_transaction_hash: tx.hash,
        l1_sender: tx.from,
        carrier_type,
        carrier_hash,
        carrier_length: carrier_length as u64,
        blob_versioned_hashes,
        exclusion_reason,
        poster_owner_commitment: batch.map(|batch| fr_to_bytes(batch.poster_owner_commitment)),
        poster_context: batch.map(|batch| batch.poster_context),
        first_batch_item_index,
        items,
    }
}

/// The manifest hash and length and the exclusion reason of a carrier that
/// yields no candidate batch bytes. An Inbox carrier's identity is its
/// calldata followed by its blob versioned hashes.
fn ignored_carrier(carrier: &Carrier<'_>) -> ((B256, usize), BatchExclusionReason) {
    let tx = carrier.tx;
    if let CarrierSource::Event { log, .. } = carrier.source {
        return (
            (keccak256(&log.data), log.data.len()),
            BatchExclusionReason::InvalidCarrierEncoding,
        );
    }
    let mut carrier_identity = tx.input.to_vec();
    for hash in &tx.blob_versioned_hashes {
        carrier_identity.extend_from_slice(hash.as_slice());
    }
    let exclusion_reason = if (!tx.input.is_empty() && !tx.blob_versioned_hashes.is_empty())
        || tx.blob_versioned_hashes.len() > pcash_da::MAX_BATCH_BLOBS
        || tx
            .blob_versioned_hashes
            .iter()
            .any(|hash| hash.as_slice()[0] != 0x01)
    {
        BatchExclusionReason::UnsupportedCarrierEncoding
    } else {
        BatchExclusionReason::InvalidCarrierEncoding
    };
    (
        (keccak256(carrier_identity), tx.input.len()),
        exclusion_reason,
    )
}

/// The block's payouts, economics, and next issuance state.
struct BlockSettlement {
    payouts: Vec<PayoutRecord>,
    /// The output commitment of each payout, in order.
    payout_commitments: Vec<Fr>,
    economics: BlockEconomics,
    issuance: pcash_issuance::IssuanceState,
}

/// Settle the block's issuance and open fees over its complete transaction set.
fn settle_block(
    issuance_terms: pcash_issuance::BlockTerms,
    transactions: &[ExecutedTransaction<'_>],
    first_output_index: u64,
) -> BlockSettlement {
    let qualifying_actions = transactions
        .iter()
        .filter(|transaction| {
            transaction
                .effects
                .accepted()
                .is_some_and(|effects| earns_issuance(effects.kind))
        })
        .count() as u64;
    let quote = issuance_terms.quote;
    let settled = pcash_issuance::settle(issuance_terms, qualifying_actions);
    let (payouts, payout_commitments, open_fees_total) =
        settle_payouts(transactions, settled.reward_each, first_output_index);
    BlockSettlement {
        payouts,
        payout_commitments,
        economics: BlockEconomics {
            open_fees_total,
            issuance_total: settled.new_issuance,
            qualifying_actions,
            reward_each: settled.reward_each,
            baseline: quote.baseline,
            internal_offer: quote.internal_offer,
            block_allowance: quote.block_allowance,
        },
        issuance: settled.state,
    }
}

/// PCASH numbering is intrinsic: every accepted derivation input produces the
/// next PCASH block. The node follower supplies the contiguous L1 stream and
/// L1 coordinates remain provenance rather than a header-number formula.
fn next_pcash_number(tip_number: Option<u64>) -> Result<u64, DeriveError> {
    match tip_number {
        Some(number) => number
            .checked_add(1)
            .ok_or(DeriveError::BlockNumberOverflow),
        None => Ok(0),
    }
}

/// Assemble the canonical commit input: each admitted transaction's result,
/// exact bytes, and effects, aligned.
fn assemble_block_input(
    header: &L1Header,
    number: u64,
    l1_logs: &NormalizedLogBlock,
    transactions: Vec<ExecutedTransaction<'_>>,
    history: CanonicalBlockHistory,
) -> BlockInput {
    let mut transaction_results = Vec::with_capacity(transactions.len());
    let mut transaction_bytes = Vec::with_capacity(transactions.len());
    let mut transaction_effects = Vec::with_capacity(transactions.len());
    for transaction in transactions {
        transaction_results.push(transaction.result);
        transaction_bytes.push(transaction.raw.to_vec());
        transaction_effects.push(transaction.effects);
    }
    BlockInput {
        number,
        timestamp: header.timestamp,
        transaction_results,
        transaction_bytes,
        l1_origin: L1Origin {
            block_number: header.number,
            block_hash: header.hash,
            block_timestamp: header.timestamp,
            l1_logs_root: l1_logs.root,
            l1_log_count: l1_logs.count(),
        },
        history,
        transaction_effects,
        l1_logs: l1_logs
            .logs
            .iter()
            .map(|log| L1LogLeaf {
                transaction_index: log.transaction_index,
                log_index: log.log_index,
                leaf: log.leaf,
            })
            .collect(),
    }
}

fn controller_elapsed_seconds(
    current_block: u64,
    genesis_l1_block: u64,
    current_timestamp: u64,
    parent_timestamp: u64,
) -> u64 {
    if current_block == genesis_l1_block {
        0
    } else {
        current_timestamp - parent_timestamp
    }
}

/// Open fee and issuance owed to one `posterOwnerCommitment` across the block.
struct PosterGroup {
    owner: Fr,
    open_fee: U256,
    issuance: U256,
    /// Contributing L1 transaction indices in encounter order.
    sources: Vec<u64>,
    /// Distinct contexts of the contributing batches in encounter order.
    contexts: Vec<B256>,
}

/// One admitted transaction's outcome, its statement hash on success (zero
/// otherwise), and the effects stored beside its result.
struct Execution {
    outcome: TransactionOutcome,
    statement_hash: B256,
    effects: TransactionEffects,
}

/// The consensus-relevant values of one private-value section, extracted from
/// its public inputs. Type `0x00`, a user-account update, and a sponsored
/// contract-account creation all run the same checks and effects over it.
struct SectionValues {
    profile: PrivateValueProfile,
    recent_pcash_block_hash: CircuitWord,
    nullifiers: Vec<Fr>,
    bodies: Vec<Fr>,
    open_fee_amount: U256,
    issuance_owner_commitment: Fr,
    /// Whether the carrying transaction kind earns issuance on success.
    earns_issuance: bool,
}

impl SectionValues {
    /// `section` is a [`ProofCandidate`]'s, so its words are canonical.
    fn from_section(section: &PrivateValueSection, kind: u8) -> Self {
        let profile = section.shape().profile();
        let field = |offset| fr_from_internal_word(section.public_input(offset));
        Self {
            profile,
            recent_pcash_block_hash: section.public_input(profile.recent_block_hash_offset),
            nullifiers: (profile.nullifiers_offset..profile.outputs_offset)
                .map(field)
                .collect(),
            bodies: (profile.outputs_offset..profile.delivery_commitment_offset)
                .map(field)
                .collect(),
            open_fee_amount: pi_u256(&section.public_input(profile.open_fee_amount_offset)),
            issuance_owner_commitment: field(profile.issuance_owner_offset),
            earns_issuance: earns_issuance(kind),
        }
    }
}

/// A committed transaction failure: the outcome and its optional detail.
#[derive(Debug)]
struct Rejection {
    outcome: TransactionOutcome,
    detail: Option<FailureDetailSeed>,
}

impl Rejection {
    fn with_detail(outcome: TransactionOutcome, detail: FailureDetail) -> Self {
        Self {
            outcome,
            detail: Some(FailureDetailSeed::Complete(detail)),
        }
    }

    fn without_detail(outcome: TransactionOutcome) -> Self {
        Self {
            outcome,
            detail: None,
        }
    }
}

/// Why checking a transaction stopped: it failed, or derivation itself cannot
/// continue.
#[derive(Debug)]
enum Halt {
    Rejected(Rejection),
    Fatal(DeriveError),
}

impl From<Rejection> for Halt {
    fn from(rejection: Rejection) -> Self {
        Self::Rejected(rejection)
    }
}

impl From<VerifyError> for Halt {
    fn from(error: VerifyError) -> Self {
        Self::Fatal(error.into())
    }
}

impl From<StateError> for Halt {
    fn from(error: StateError) -> Self {
        Self::Fatal(error.into())
    }
}

/// Everything one successful transaction adds to the block, and the hash of
/// the statement its result commits.
struct TransactionDiff {
    section: Option<SectionDiff>,
    account: Option<AccountDiff>,
    statement_hash: Fr,
}

/// What a verified private-value section marks, appends, reserves, and pays,
/// with the block's output index and payout reservation after it, checked
/// against capacity before verification.
struct SectionDiff {
    nullifiers: Vec<B256>,
    output_commitments: Vec<Fr>,
    next_output_index: u64,
    pending_payout_slots: u64,
    payout: PayoutIntent,
}

/// One account write. Revision 1 is a creation, which takes the next account
/// index; any later revision rewrites the account's existing leaf.
struct AccountDiff {
    op: AccountOp,
    index: u64,
    revision: u32,
    result: AccountResult,
}

/// What one proof-bearing transaction asks the verifier to accept: its type's
/// hiding-kernel verification key, its proof, and its complete public-input
/// blob.
/// Prewarming, execution, and the mempool each obtain it through one
/// `ProofCandidate`, so all three name one statement for one transaction.
pub struct ProofStatement<'a> {
    pub vk: &'a [u8],
    pub proof: &'a [u8],
    pub public_inputs: Vec<u8>,
}

impl<'a> ProofStatement<'a> {
    /// The statement the proof of `transaction` must attest at any timestamp,
    /// or `None` when execution never verifies one: the type carries no
    /// proof, or the transaction fails one of `ProofCandidate`'s static
    /// checks. `Some` does not mean execution verifies it.
    pub fn of(rules: &'a ProtocolRules, transaction: &'a AdmittedTransaction) -> Option<Self> {
        ProofCandidate::of(rules, transaction).map(|candidate| candidate.statement().0)
    }

    /// The statement execution verifies for `transaction` in a block at `ts`,
    /// delivered by a carrier whose carrier context hash is
    /// `carrier_context_hash`, when the checks that follow pass (the zero and
    /// duplicate input nullifier checks and the state checks), or `None` when
    /// no state lets execution reach its proof.
    pub(crate) fn reachable(
        rules: &'a ProtocolRules,
        transaction: &'a AdmittedTransaction,
        ts: u64,
        carrier_context_hash: Fr,
    ) -> Option<Self> {
        ProofCandidate::of(rules, transaction)?
            .meets_validity_conditions(ts, Some(carrier_context_hash))
            .ok()
            .map(|candidate| candidate.statement().0)
    }
}

/// A proof-bearing transaction that passed its type's static checks, which
/// read neither state, the timestamp, nor the carrier. The zero and duplicate
/// input nullifier checks read none of these either but run later, in
/// `section_diff`, so a candidate can still fail them.
/// Its statement is built only after [`Self::meets_validity_conditions`].
/// Prewarming and execution reach a statement through these two steps alone,
/// so execution never asks for a verdict prewarming did not cache.
struct ProofCandidate<'a> {
    section: &'a PrivateValueSection,
    vk: &'a [u8],
    /// The carrying type's verifier input after the section's own: an
    /// update's account update commitment, or a sponsored creation's derived
    /// address.
    appended: Option<CircuitWord>,
}

impl<'a> ProofCandidate<'a> {
    fn new(
        section: &'a PrivateValueSection,
        vk: &'a [u8],
        appended: Option<CircuitWord>,
    ) -> Result<Self, Rejection> {
        section_pure_check(section, appended)?;
        Ok(Self {
            section,
            vk,
            appended,
        })
    }

    fn private_value(
        rules: &'a ProtocolRules,
        section: &'a PrivateValueSection,
    ) -> Result<Self, Rejection> {
        Self::new(
            section,
            rules.private_value_hiding_kernel_vk(section.shape()),
            None,
        )
    }

    /// Also returns the proposed rule-set commitment as a field element.
    fn user_account_update(
        rules: &'a ProtocolRules,
        update: &'a UserAccountUpdate,
    ) -> Result<(Self, Fr), Rejection> {
        let candidate = Self::new(
            &update.section,
            &rules.user_account_update_hiding_kernel_vk,
            Some(update.account_update_commitment),
        )?;
        let Some(new_rule_set_commitment) = fr_from_canonical_bytes(update.new_rule_set_commitment)
        else {
            return Err(Rejection::with_detail(
                TransactionOutcome::NonCanonicalAccountField,
                FailureDetail::NonCanonicalAccountField {
                    field: AccountField::RuleSetCommitment,
                    supplied: update.new_rule_set_commitment,
                },
            ));
        };
        Ok((candidate, new_rule_set_commitment))
    }

    /// `section` is a sponsored creation's section. Also returns the account
    /// material its body derives.
    fn contract_account_creation(
        rules: &'a ProtocolRules,
        section: &'a PrivateValueSection,
        check: &ContractBodyCheck,
    ) -> Result<(Self, ContractMaterial), Rejection> {
        // Section canonicality precedes the body's static checks.
        let material = match contract_material(check) {
            Ok(material) => material,
            Err(rejection) => {
                section_pure_check(section, None)?;
                return Err(rejection);
            }
        };
        let candidate = Self::new(
            section,
            &rules.contract_creation_hiding_kernel_vk,
            Some(CircuitWord::left_padding_from(material.address.as_slice())),
        )?;
        Ok((candidate, material))
    }

    /// The candidate of any admitted transaction, or `None` when it carries
    /// no proof or fails one of the checks above.
    fn of(rules: &'a ProtocolRules, transaction: &'a AdmittedTransaction) -> Option<Self> {
        match transaction {
            AdmittedTransaction::PrivateValue(section) => Self::private_value(rules, section).ok(),
            AdmittedTransaction::UserAccountUpdate(update) => {
                Self::user_account_update(rules, update)
                    .ok()
                    .map(|(candidate, _)| candidate)
            }
            // Only a sponsored creation carries a proof.
            AdmittedTransaction::ContractAccountCreation(creation, check) => {
                Self::contract_account_creation(rules, creation.section()?, check)
                    .ok()
                    .map(|(candidate, _)| candidate)
            }
            AdmittedTransaction::UserAccountCreation(_) => None,
        }
    }

    /// The candidate, when its section's validity conditions hold in a block
    /// at `ts` for a carrier whose carrier context hash is
    /// `carrier_context_hash`: the expiry gate, the not-before gate, then the
    /// carrier-context condition, which is not evaluated without a carrier.
    fn meets_validity_conditions(
        self,
        ts: u64,
        carrier_context_hash: Option<Fr>,
    ) -> Result<Self, Rejection> {
        let profile = self.section.shape().profile();
        // `validUntilTimestamp` is a pure deadline against the block's L1 header
        // timestamp; wallet policy, not consensus, limits how far ahead it is set.
        let valid_until = pi_u256(&self.section.public_input(profile.valid_until_offset));
        if U256::from(ts) > valid_until {
            return Err(Rejection::with_detail(
                TransactionOutcome::Expired,
                FailureDetail::Expired {
                    valid_until,
                    block_timestamp: ts,
                },
            ));
        }
        let not_before = pi_u256(&self.section.public_input(profile.not_before_offset));
        if U256::from(ts) < not_before {
            return Err(Rejection::with_detail(
                TransactionOutcome::NotYetValid,
                FailureDetail::NotYetValid {
                    not_before,
                    block_timestamp: ts,
                },
            ));
        }
        // Zero states no condition.
        if let Some(carrier) = carrier_context_hash.map(fr_to_bytes) {
            let required = self.section.carrier_context_hash();
            if !required.is_zero() && required != carrier {
                return Err(Rejection::with_detail(
                    TransactionOutcome::CarrierContextMismatch,
                    FailureDetail::CarrierContextMismatch { required, carrier },
                ));
            }
        }
        Ok(self)
    }

    /// The statement, and the verifier inputs it states as field elements for
    /// the result's statement hash. The section's delivery commitment is
    /// computed here on its first statement.
    fn statement(&self) -> (ProofStatement<'a>, Vec<Fr>) {
        let mut words = self.section.public_inputs();
        words.extend(self.appended);
        let fields = words
            .iter()
            .map(|word| fr_from_internal_word(*word))
            .collect();
        (
            ProofStatement {
                vk: self.vk,
                proof: &self.section.proof,
                public_inputs: words_blob(&words),
            },
            fields,
        )
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ContractMaterial {
    pub address: Address,
    pub nk_commitment: Fr,
    pub function_set_commitment: Fr,
    receive_key_hash: B256,
}

fn contract_material_from_commitments(
    body: &ContractBody,
    nk_commitment: Fr,
    commitments: &[Fr],
) -> ContractMaterial {
    let function_set_commitment = contract_function_set_material(body, commitments);
    let receive_key_hash = body
        .receive_key
        .as_deref()
        .map_or(B256::ZERO, |key| pcash_state::receive_key_hash(key));
    ContractMaterial {
        address: contract_address(
            nk_commitment,
            function_set_commitment,
            fr_from_internal_word(receive_key_hash),
            u8::from(body.publishes_nk_root),
        ),
        nk_commitment,
        function_set_commitment,
        receive_key_hash,
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ContractStaticFailure {
    outcome: TransactionOutcome,
    detail: Option<FailureDetail>,
}

impl ContractStaticFailure {
    fn with_detail(outcome: TransactionOutcome, detail: FailureDetail) -> Self {
        Self {
            outcome,
            detail: Some(detail),
        }
    }

    fn without_detail(outcome: TransactionOutcome) -> Self {
        Self {
            outcome,
            detail: None,
        }
    }
}

pub(crate) type ContractValidation = Result<ContractMaterial, ContractStaticFailure>;

pub(crate) fn prepare_contract_body(ce: &ContractBody) -> ContractValidation {
    let fields = contract_fields(ce)?;
    let nk_commitment =
        contract_nullifier_key_commitment(ce.publishes_nk_root, fields.nullifier_key_material);

    if ce.functions.is_empty() {
        return Err(ContractStaticFailure::without_detail(
            TransactionOutcome::EmptyContractFunctionSet,
        ));
    }
    let mut commitments = Vec::with_capacity(ce.functions.len());
    let mut previous_selector: Option<(usize, u8)> = None;
    for (index, (function, &(application_vk_hash, configuration_commitment))) in
        ce.functions.iter().zip(&fields.functions).enumerate()
    {
        if let Some((previous_index, previous)) = previous_selector {
            if function.selector <= previous {
                return Err(ContractStaticFailure::with_detail(
                    TransactionOutcome::SelectorsNotStrictlyIncreasing,
                    FailureDetail::SelectorsNotStrictlyIncreasing {
                        previous_function_index: previous_index as u16,
                        previous_selector: previous,
                        function_index: index as u16,
                        selector: function.selector,
                    },
                ));
            }
        }
        previous_selector = Some((index, function.selector));
        let commitment =
            contract_function_commitment(application_vk_hash, configuration_commitment);
        commitments.push(commitment);
    }

    Ok(contract_material_from_commitments(
        ce,
        nk_commitment,
        &commitments,
    ))
}

/// A contract body's external words as field elements.
struct ContractFields {
    nullifier_key_material: Fr,
    /// `(applicationVkHash, configurationCommitment)` of each function.
    functions: Vec<(Fr, Fr)>,
}

/// Accept a contract body's words as field elements, reporting the first that
/// fails in body order. The body carries exactly one representation of the
/// nullifier-key material; it and every function word must be canonical.
fn contract_fields(ce: &ContractBody) -> Result<ContractFields, ContractStaticFailure> {
    let noncanonical = |field, function_index, supplied| {
        ContractStaticFailure::with_detail(
            TransactionOutcome::NonCanonicalContractField,
            FailureDetail::NonCanonicalContractField {
                field,
                function_index,
                supplied,
            },
        )
    };
    let nullifier_key_material =
        fr_from_canonical_bytes(ce.nullifier_key_material).ok_or_else(|| {
            noncanonical(
                ContractField::NullifierKeyMaterial,
                None,
                ce.nullifier_key_material,
            )
        })?;
    let functions = ce
        .functions
        .iter()
        .enumerate()
        .map(|(index, function)| {
            let function_index = Some(index as u16);
            let application_vk_hash = fr_from_canonical_bytes(function.application_vk_hash)
                .ok_or_else(|| {
                    noncanonical(
                        ContractField::ApplicationVkHash,
                        function_index,
                        function.application_vk_hash,
                    )
                })?;
            let configuration_commitment =
                fr_from_canonical_bytes(function.configuration_commitment).ok_or_else(|| {
                    noncanonical(
                        ContractField::ConfigurationCommitment,
                        function_index,
                        function.configuration_commitment,
                    )
                })?;
            Ok((application_vk_hash, configuration_commitment))
        })
        .collect::<Result<_, _>>()?;
    Ok(ContractFields {
        nullifier_key_material,
        functions,
    })
}

/// In-flight state for one L1 block: the nullifiers, output commitments, and
/// account writes of its successful transactions so far, plus the overlay
/// needed to execute later transactions against earlier ones in the same
/// block, including first-valid-wins nullifiers and account-revision
/// monotonicity. [`derive_prepared_block`] builds the block's [`BlockUpdate`]
/// from these after settlement.
///
/// Every check reads the context and returns a [`TransactionDiff`] or a
/// [`Rejection`]; [`BlockCtx::apply`] is the only place a transaction mutates
/// it. [`BlockCtx::execute_carriers`] consumes the context and returns only
/// what its callers use.
struct BlockCtx<'a> {
    rules: &'a ProtocolRules,
    /// The network identity of the state being derived into.
    source: DerivationSource,
    current_timestamp: u64,
    nullifiers: Vec<B256>,
    output_commitments: Vec<Fr>,
    account_ops: Vec<AccountOp>,
    /// Nullifiers marked by successful transactions this block (dedup vs committed set
    /// is done against `state`; this covers within-block reuse).
    pending_nullifiers: HashSet<B256>,
    /// Next output index (committed count plus outputs appended so far).
    next_output_index: u64,
    /// Next account index (committed count plus accounts created so far).
    next_account_index: u64,
    /// Complete live account state rows created or updated earlier in this block.
    account_overlay: HashMap<Address, pcash_state::AccountState>,
    pending_payout_slots: u64,
    /// Poster owner commitments with a successful positive open fee in this block.
    posters_with_open_fees: HashSet<Fr>,
    reward_active: bool,
}

impl<'a> BlockCtx<'a> {
    fn new(
        rules: &'a ProtocolRules,
        source: DerivationSource,
        current_timestamp: u64,
        output_count: u64,
        account_count: u64,
        reward_active: bool,
    ) -> Self {
        Self {
            rules,
            source,
            current_timestamp,
            nullifiers: Vec::new(),
            output_commitments: Vec::new(),
            account_ops: Vec::new(),
            pending_nullifiers: HashSet::new(),
            next_output_index: output_count,
            next_account_index: account_count,
            account_overlay: HashMap::new(),
            pending_payout_slots: 0,
            posters_with_open_fees: HashSet::new(),
            reward_active,
        }
    }

    /// Execute one admitted transaction against the block so far and, if it
    /// succeeds, apply its diff. `l1_sender` and `carrier_context_hash` are
    /// the sender a direct-mode creation registers and the carrier context
    /// hash of the carrier that delivers it, both `None` outside any carrier.
    /// `poster_owner` is the enclosing batch's poster, whose earlier
    /// successful open fees in the block size the transaction's payout
    /// reservation.
    fn execute<S: StateDb, V: Verifier>(
        &mut self,
        state: &S,
        verifier: &V,
        l1_sender: Option<Address>,
        carrier_context_hash: Option<Fr>,
        poster_owner: Fr,
        transaction: &AdmittedTransaction,
    ) -> Result<Execution, DeriveError> {
        // The first failed check determines the committed outcome. Reordering
        // checks can change block hashes even if the successful set is
        // unchanged. `account` is the account the transaction bytes address,
        // which a failure records whatever check failed.
        let (account, checked) = match transaction {
            AdmittedTransaction::PrivateValue(section) => (
                None,
                self.check_private_value(
                    state,
                    verifier,
                    carrier_context_hash,
                    poster_owner,
                    section,
                ),
            ),
            AdmittedTransaction::UserAccountCreation(creation) => {
                let (account, checked) =
                    self.check_user_account_creation(state, creation, l1_sender);
                (account, checked)
            }
            AdmittedTransaction::UserAccountUpdate(update) => (
                Some(update.address),
                self.check_user_account_update(
                    state,
                    verifier,
                    carrier_context_hash,
                    poster_owner,
                    update,
                ),
            ),
            AdmittedTransaction::ContractAccountCreation(creation, check) => (
                check.address(),
                self.check_contract_account_creation(
                    state,
                    verifier,
                    carrier_context_hash,
                    poster_owner,
                    creation,
                    check,
                ),
            ),
        };
        let diff = match checked {
            Ok(diff) => diff,
            Err(Halt::Rejected(rejection)) => {
                return Ok(Execution {
                    outcome: rejection.outcome,
                    statement_hash: B256::ZERO,
                    effects: TransactionEffects::Rejected(RejectedEffects {
                        account,
                        detail: rejection.detail,
                    }),
                });
            }
            Err(Halt::Fatal(error)) => return Err(error),
        };
        let (output_commitments, nullifiers) = diff.section.as_ref().map_or_else(
            || (Vec::new(), Vec::new()),
            |section| {
                (
                    section
                        .output_commitments
                        .iter()
                        .map(|commitment| fr_to_bytes(*commitment))
                        .collect(),
                    section.nullifiers.clone(),
                )
            },
        );
        let effects = AcceptedEffects {
            kind: transaction.kind(),
            output_leaf_start: (!output_commitments.is_empty()).then_some(self.next_output_index),
            output_commitments,
            nullifiers,
            account: diff.account.as_ref().map(|account| account.result.clone()),
            payout: diff.section.as_ref().map(|section| section.payout.clone()),
        };
        let statement_hash = fr_to_bytes(diff.statement_hash);
        self.apply(poster_owner, diff);
        Ok(Execution {
            outcome: TransactionOutcome::Succeeded,
            statement_hash,
            effects: TransactionEffects::Accepted(effects),
        })
    }

    /// Fold one successful transaction into the block. Only a fully checked
    /// and verified transaction reaches this point, and the diff must come
    /// from this exact context: its output commitments bind
    /// `next_output_index`, and its section carries the output index and
    /// payout reservation it checked against capacity.
    fn apply(&mut self, poster_owner: Fr, diff: TransactionDiff) {
        if let Some(section) = diff.section {
            self.pending_nullifiers
                .extend(section.nullifiers.iter().copied());
            self.nullifiers.extend(section.nullifiers);
            self.pending_payout_slots = section.pending_payout_slots;
            if !section.payout.open_fee_amount.is_zero() {
                self.posters_with_open_fees.insert(poster_owner);
            }
            self.next_output_index = section.next_output_index;
            self.output_commitments.extend(section.output_commitments);
        }
        if let Some(account) = diff.account {
            if account.revision == 1 {
                // `account_capacity_check` bounded the creations to `MAX_LEAVES`.
                self.next_account_index += 1;
            }
            self.account_overlay.insert(
                account.op.address,
                pcash_state::AccountState {
                    index: account.index,
                    revision: account.revision,
                    nullifier_key_commitment: account.op.nullifier_key_commitment,
                    account_rule_set_commitment: account.op.account_rule_set_commitment,
                    kind: account.op.kind,
                    receive_key_hash: account.op.receive_key_hash,
                },
            );
            self.account_ops.push(account.op);
        }
    }

    // ---- private_value --------------------------------------------------

    fn check_private_value<S: StateDb, V: Verifier>(
        &self,
        state: &S,
        verifier: &V,
        carrier_context_hash: Option<Fr>,
        poster_owner: Fr,
        pv: &PrivateValueSection,
    ) -> Result<TransactionDiff, Halt> {
        let candidate = ProofCandidate::private_value(self.rules, pv)?;
        let values = SectionValues::from_section(pv, KIND_PRIVATE_VALUE);
        let candidate =
            self.section_validity_check(state, &values, candidate, carrier_context_hash)?;
        let section = self.section_diff(state, poster_owner, &values)?;

        let (statement, fields) = candidate.statement();
        if !verifier.verify(statement.vk, statement.proof, &statement.public_inputs)? {
            return Err(Rejection::without_detail(TransactionOutcome::ProofRejected).into());
        }
        Ok(TransactionDiff {
            section: Some(section),
            account: None,
            statement_hash: transaction_statement_hash(&fields),
        })
    }

    // ---- private-value section, shared by every kind that carries one -------

    /// The recent-block window, then the candidate's validity conditions:
    /// expiry, not-before, and the carrier context of the carrier whose hash
    /// is `carrier_context_hash`, when there is one.
    fn section_validity_check<'s, S: StateDb>(
        &self,
        state: &S,
        values: &SectionValues,
        candidate: ProofCandidate<'s>,
        carrier_context_hash: Option<Fr>,
    ) -> Result<ProofCandidate<'s>, Rejection> {
        if !state.recent_pcash_block_hash_in_window(
            values.recent_pcash_block_hash,
            self.current_timestamp,
        ) {
            return Err(Rejection::with_detail(
                TransactionOutcome::RecentPcashBlockNotInWindow,
                FailureDetail::RecentPcashBlockNotInWindow {
                    referenced_block_hash: B256::from(values.recent_pcash_block_hash),
                    window_start_timestamp: self
                        .current_timestamp
                        .saturating_sub(RECENT_PCASH_BLOCK_WINDOW_SECONDS),
                    window_end_timestamp: self.current_timestamp,
                },
            ));
        }
        candidate.meets_validity_conditions(self.current_timestamp, carrier_context_hash)
    }

    /// The nullifier and output checks, in consensus order, returning what the
    /// section marks, appends, reserves, and pays once its proof verifies.
    fn section_diff<S: StateDb>(
        &self,
        state: &S,
        poster_owner: Fr,
        values: &SectionValues,
    ) -> Result<SectionDiff, Halt> {
        if let Some(slot) = values
            .nullifiers
            .iter()
            .position(|nullifier| *nullifier == Fr::from(0u64))
        {
            return Err(Rejection::with_detail(
                TransactionOutcome::ZeroNullifier,
                FailureDetail::ZeroNullifier {
                    input_slot: slot as u16,
                },
            )
            .into());
        }
        let nullifiers = values
            .nullifiers
            .iter()
            .map(|nullifier| fr_to_bytes(*nullifier))
            .collect::<Vec<_>>();
        let mut distinct: HashMap<CircuitWord, usize> = HashMap::new();
        for (slot, word) in nullifiers.iter().enumerate() {
            if let Some(first) = distinct.insert(*word, slot) {
                return Err(Rejection::with_detail(
                    TransactionOutcome::DuplicateInputNullifier,
                    FailureDetail::DuplicateInputNullifier {
                        first_input_slot: first as u16,
                        duplicate_input_slot: slot as u16,
                        nullifier: *word,
                    },
                )
                .into());
            }
        }
        for (slot, nullifier) in nullifiers.iter().enumerate() {
            if self.pending_nullifiers.contains(nullifier) || state.nullifier_seen(*nullifier)? {
                return Err(Rejection {
                    outcome: TransactionOutcome::NullifierAlreadySpent,
                    detail: Some(FailureDetailSeed::NullifierAlreadySpent {
                        input_slot: slot as u16,
                        nullifier: *nullifier,
                    }),
                }
                .into());
            }
        }

        let outputs_added = values.bodies.len() as u64;
        let pending_payout_slots =
            self.pending_payout_slots + self.payout_reservation(poster_owner, values);
        let leaf_start = self.next_output_index;
        let requested_count = leaf_start + outputs_added + pending_payout_slots;
        if requested_count > MAX_LEAVES {
            return Err(Rejection::with_detail(
                TransactionOutcome::OutputCapacity,
                FailureDetail::OutputCapacity {
                    requested_count,
                    limit: MAX_LEAVES,
                },
            )
            .into());
        }
        let output_commitments = values
            .bodies
            .iter()
            .enumerate()
            .map(|(index, body)| output_commitment(*body, leaf_start + index as u64))
            .collect::<Vec<_>>();
        Ok(SectionDiff {
            nullifiers,
            output_commitments,
            next_output_index: leaf_start + outputs_added,
            pending_payout_slots,
            payout: PayoutIntent {
                open_fee_amount: values.open_fee_amount,
                issuance_owner_commitment: values.issuance_owner_commitment,
                context: payout_transaction_context(
                    self.source.pcash_chain_id,
                    values.profile,
                    &values.nullifiers,
                ),
            },
        })
    }

    // ---- user-account creation --------------------------------

    /// Also returns the account the creation addresses: the carrier's sender
    /// for a direct creation, the recovered signer for a signed one, and
    /// `None` when the signature does not recover or a direct creation has no
    /// carrier.
    fn check_user_account_creation<S: StateDb>(
        &self,
        state: &S,
        re: &UserAccountCreation,
        l1_sender: Option<Address>,
    ) -> (Option<Address>, Result<TransactionDiff, Halt>) {
        let receive_key_hash = re.receive_key_hash();
        let account = re.account_with_receive_key_hash(l1_sender, &self.source, receive_key_hash);
        let checked = match account {
            Some(address) => {
                self.check_resolved_user_account_creation(state, re, address, receive_key_hash)
            }
            None => {
                Err(Rejection::without_detail(TransactionOutcome::InvalidAccountSignature).into())
            }
        };
        (account, checked)
    }

    /// The checks after a creation's authorization resolved its account to
    /// `address`.
    fn check_resolved_user_account_creation<S: StateDb>(
        &self,
        state: &S,
        re: &UserAccountCreation,
        address: Address,
        receive_key_hash: CircuitWord,
    ) -> Result<TransactionDiff, Halt> {
        let nullifier_key_commitment = fr_from_canonical_bytes(re.nullifier_key_commitment);
        let account_rule_set_fr = fr_from_canonical_bytes(re.rule_set_commitment);
        let (Some(nullifier_key_commitment), Some(account_rule_set_fr)) =
            (nullifier_key_commitment, account_rule_set_fr)
        else {
            let (field, supplied) = if nullifier_key_commitment.is_none() {
                (
                    AccountField::NullifierKeyCommitment,
                    re.nullifier_key_commitment,
                )
            } else {
                (AccountField::RuleSetCommitment, re.rule_set_commitment)
            };
            return Err(Rejection::with_detail(
                TransactionOutcome::NonCanonicalAccountField,
                FailureDetail::NonCanonicalAccountField { field, supplied },
            )
            .into());
        };

        // Ethereum creation authorization cannot replace installed account
        // authority; subsequent changes require the account rules.
        if let Some(existing) = self.current_account(state, address)? {
            return Err(Rejection::with_detail(
                TransactionOutcome::AccountAlreadyExists,
                FailureDetail::AccountAlreadyExists {
                    address,
                    existing_revision: existing.revision,
                },
            )
            .into());
        }
        self.account_creation_timing_check(
            state,
            re.recent_pcash_block_hash,
            re.valid_until_timestamp,
        )?;
        self.account_capacity_check()?;

        let op = AccountOp {
            address,
            nullifier_key_commitment,
            account_rule_set_commitment: account_rule_set_fr,
            kind: ACCOUNT_KIND_USER,
            receive_key_hash,
            published_receive_key: re.receive_key().map(|key| key.to_vec()),
        };
        Ok(TransactionDiff {
            section: None,
            statement_hash: account_creation_statement_hash(&op),
            account: Some(AccountDiff {
                op,
                index: self.next_account_index,
                revision: 1,
                result: AccountResult::User {
                    address,
                    revision: 1,
                    receive_key: if re.receive_key().is_some() {
                        ReceiveKeyOperation::Replace
                    } else {
                        ReceiveKeyOperation::Clear
                    },
                    prior_state: None,
                },
            }),
        })
    }

    fn check_user_account_update<S: StateDb, V: Verifier>(
        &self,
        state: &S,
        verifier: &V,
        carrier_context_hash: Option<Fr>,
        poster_owner: Fr,
        update: &UserAccountUpdate,
    ) -> Result<TransactionDiff, Halt> {
        let (candidate, new_rule_set_commitment) =
            ProofCandidate::user_account_update(self.rules, update)?;
        let values = SectionValues::from_section(&update.section, KIND_USER_ACCOUNT_UPDATE);
        let candidate =
            self.section_validity_check(state, &values, candidate, carrier_context_hash)?;

        let Some(current) = self.current_account(state, update.address)? else {
            return Err(Rejection::with_detail(
                TransactionOutcome::AccountNotFound,
                FailureDetail::AccountNotFound {
                    address: update.address,
                },
            )
            .into());
        };
        if current.kind != ACCOUNT_KIND_USER {
            return Err(Rejection::with_detail(
                TransactionOutcome::WrongAccountKind,
                FailureDetail::WrongAccountKind {
                    address: update.address,
                    expected: AccountKindDetail::User,
                    actual: AccountKindDetail::Contract,
                },
            )
            .into());
        }
        let Some(expected_revision) = current.revision.checked_add(1) else {
            return Err(Rejection::with_detail(
                TransactionOutcome::AccountRevisionExhausted,
                FailureDetail::AccountRevisionExhausted {
                    address: update.address,
                    revision: current.revision,
                },
            )
            .into());
        };
        let (new_receive_key_hash, receive_key_operation) = match &update.receive_key_update {
            ReceiveKeyUpdate::Keep => (current.receive_key_hash, ReceiveKeyOperation::Keep),
            ReceiveKeyUpdate::Clear => {
                if current.receive_key_hash == B256::ZERO {
                    return Err(Rejection::with_detail(
                        TransactionOutcome::ClearWithoutReceiveKey,
                        FailureDetail::ClearWithoutReceiveKey {
                            address: update.address,
                        },
                    )
                    .into());
                }
                (B256::ZERO, ReceiveKeyOperation::Clear)
            }
            ReceiveKeyUpdate::Replace(key) => {
                let replacement = pcash_state::receive_key_hash(key.as_slice());
                if current.receive_key_hash == replacement {
                    return Err(Rejection::with_detail(
                        TransactionOutcome::ReplaceWithIdenticalReceiveKey,
                        FailureDetail::ReplaceWithIdenticalReceiveKey {
                            address: update.address,
                            receive_key_hash: current.receive_key_hash,
                        },
                    )
                    .into());
                }
                (replacement, ReceiveKeyOperation::Replace)
            }
        };
        let expected = user_account_update_commitment(
            update.address,
            &current,
            new_rule_set_commitment,
            new_receive_key_hash,
        );
        if expected != update.account_update_commitment {
            return Err(Rejection::with_detail(
                TransactionOutcome::AccountUpdateCommitmentMismatch,
                FailureDetail::AccountUpdateCommitmentMismatch {
                    expected,
                    supplied: B256::from(update.account_update_commitment),
                },
            )
            .into());
        }
        let section = self.section_diff(state, poster_owner, &values)?;

        let (statement, fields) = candidate.statement();
        if !verifier.verify(statement.vk, statement.proof, &statement.public_inputs)? {
            return Err(Rejection::without_detail(TransactionOutcome::ProofRejected).into());
        }

        Ok(TransactionDiff {
            section: Some(section),
            statement_hash: transaction_statement_hash(&fields),
            account: Some(AccountDiff {
                op: AccountOp {
                    address: update.address,
                    nullifier_key_commitment: current.nullifier_key_commitment,
                    account_rule_set_commitment: new_rule_set_commitment,
                    kind: ACCOUNT_KIND_USER,
                    receive_key_hash: new_receive_key_hash,
                    published_receive_key: match &update.receive_key_update {
                        ReceiveKeyUpdate::Replace(key) => Some(key.to_vec()),
                        _ => None,
                    },
                },
                index: current.index,
                revision: expected_revision,
                result: AccountResult::User {
                    address: update.address,
                    revision: expected_revision,
                    receive_key: receive_key_operation,
                    prior_state: Some(Box::new(current)),
                },
            }),
        })
    }

    fn current_account<S: StateDb>(
        &self,
        state: &S,
        address: Address,
    ) -> Result<Option<pcash_state::AccountState>, StateError> {
        match self.account_overlay.get(&address).copied() {
            Some(account) => Ok(Some(account)),
            None => state.account_of(address),
        }
    }

    // ---- contract account creation -------------------------------------

    /// Both funding modes share one order: sponsored section canonicality,
    /// the body, its address and account capacity, timing and, sponsored
    /// only, the carrier context, then the sponsor's payment and proof.
    fn check_contract_account_creation<S: StateDb, V: Verifier>(
        &self,
        state: &S,
        verifier: &V,
        carrier_context_hash: Option<Fr>,
        poster_owner: Fr,
        ce: &ContractAccountCreation,
        check: &ContractBodyCheck,
    ) -> Result<TransactionDiff, Halt> {
        let (material, section, fields) = match &ce.funding {
            ContractFunding::Unfunded {
                recent_pcash_block_hash,
                valid_until_timestamp,
            } => {
                let material = contract_material(check)?;
                self.contract_account_available(state, material.address)?;
                self.account_creation_timing_check(
                    state,
                    *recent_pcash_block_hash,
                    *valid_until_timestamp,
                )?;
                (material, None, None)
            }
            // The sponsor pays through the section: its window, nullifiers,
            // and outputs are checked and its proof verified against the
            // derived address before any effect is applied.
            ContractFunding::Sponsored(section) => {
                let (candidate, material) =
                    ProofCandidate::contract_account_creation(self.rules, section, check)?;
                self.contract_account_available(state, material.address)?;
                let values = SectionValues::from_section(section, KIND_CONTRACT_ACCOUNT_CREATION);
                let candidate =
                    self.section_validity_check(state, &values, candidate, carrier_context_hash)?;
                let diff = self.section_diff(state, poster_owner, &values)?;
                let (statement, fields) = candidate.statement();
                if !verifier.verify(statement.vk, statement.proof, &statement.public_inputs)? {
                    return Err(Rejection::without_detail(TransactionOutcome::ProofRejected).into());
                }
                (material, Some(diff), Some(fields))
            }
        };

        // Any fee effects, then the kind-1 leaf and receive material,
        // atomically. A sponsored creation states its verifier inputs and an
        // unfunded one the account it writes.
        let account = self.contract_account_diff(&ce.body, material);
        let statement_hash = fields.map_or_else(
            || account_creation_statement_hash(&account.op),
            |fields| transaction_statement_hash(&fields),
        );
        Ok(TransactionDiff {
            section,
            account: Some(account),
            statement_hash,
        })
    }

    /// The derived address must hold no account (this block's overlay or
    /// committed state) — smart-contract creation never collides — and one
    /// more account must fit.
    fn contract_account_available<S: StateDb>(
        &self,
        state: &S,
        address: Address,
    ) -> Result<(), Halt> {
        if self.current_account(state, address)?.is_some() {
            return Err(Rejection::with_detail(
                TransactionOutcome::ContractAddressExists,
                FailureDetail::ContractAddressExists { address },
            )
            .into());
        }
        Ok(self.account_capacity_check()?)
    }

    /// Require capacity for one new account state commitment.
    fn account_capacity_check(&self) -> Result<(), Rejection> {
        let requested_count = self.next_account_index + 1;
        if requested_count <= MAX_LEAVES {
            return Ok(());
        }
        Err(Rejection::with_detail(
            TransactionOutcome::AccountCapacity,
            FailureDetail::AccountCapacity {
                requested_count,
                limit: MAX_LEAVES,
            },
        ))
    }

    fn contract_account_diff(&self, ce: &ContractBody, material: ContractMaterial) -> AccountDiff {
        let ContractMaterial {
            address,
            nk_commitment,
            function_set_commitment,
            receive_key_hash,
        } = material;
        AccountDiff {
            op: AccountOp {
                address,
                nullifier_key_commitment: nk_commitment,
                account_rule_set_commitment: function_set_commitment,
                kind: ACCOUNT_KIND_CONTRACT,
                receive_key_hash,
                published_receive_key: ce.receive_key.as_deref().map(|key| key.to_vec()),
            },
            index: self.next_account_index,
            revision: 1,
            result: AccountResult::Contract {
                address,
                nullifier_key_commitment: fr_to_bytes(nk_commitment),
                function_set_commitment: fr_to_bytes(function_set_commitment),
            },
        }
    }

    fn account_creation_timing_check<S: StateDb>(
        &self,
        state: &S,
        recent_pcash_block_hash: CircuitWord,
        valid_until_timestamp: u64,
    ) -> Result<(), Rejection> {
        if !state.recent_pcash_block_hash_in_window(recent_pcash_block_hash, self.current_timestamp)
        {
            return Err(Rejection::with_detail(
                TransactionOutcome::RecentPcashBlockNotInWindow,
                FailureDetail::RecentPcashBlockNotInWindow {
                    referenced_block_hash: B256::from(recent_pcash_block_hash),
                    window_start_timestamp: self
                        .current_timestamp
                        .saturating_sub(RECENT_PCASH_BLOCK_WINDOW_SECONDS),
                    window_end_timestamp: self.current_timestamp,
                },
            ));
        }
        if self.current_timestamp > valid_until_timestamp {
            return Err(Rejection::with_detail(
                TransactionOutcome::Expired,
                FailureDetail::Expired {
                    valid_until: U256::from(valid_until_timestamp),
                    block_timestamp: self.current_timestamp,
                },
            ));
        }
        Ok(())
    }

    /// Payout notes this section may add at settlement: one open-fee slot for
    /// a positive fee when the batch's poster has no earlier successful
    /// positive fee in the block, plus one potential issuance slot for a
    /// qualifying action while the block's one-action maximum is positive.
    fn payout_reservation(&self, poster_owner: Fr, values: &SectionValues) -> u64 {
        let fee_slots = u64::from(
            !values.open_fee_amount.is_zero()
                && !self.posters_with_open_fees.contains(&poster_owner),
        );
        let issuance_slots = u64::from(self.reward_active && values.earns_issuance);
        fee_slots + issuance_slots
    }
}

/// The stateless section check: every public input of the carrying
/// transaction canonical, in verifier order, ending with `appended`, the
/// carrying type's own input. Public input 0 is the network's chain-ID word,
/// which admission matched against the envelope. The delivery commitment is a
/// field element by construction and is not computed here.
fn section_pure_check(
    section: &PrivateValueSection,
    appended: Option<CircuitWord>,
) -> Result<(), Rejection> {
    let profile = section.shape().profile();
    let mut inputs = (0..profile.public_inputs)
        .filter(|offset| *offset != profile.delivery_commitment_offset)
        .map(|offset| (offset, section.public_input(offset)))
        .chain(appended.map(|word| (profile.public_inputs, word)));
    match inputs.find(|(_, word)| fr_from_canonical_bytes(*word).is_none()) {
        Some((index, supplied)) => Err(Rejection::with_detail(
            TransactionOutcome::PublicInputNotInField,
            FailureDetail::PublicInputNotInField {
                public_input_index: index as u16,
                supplied,
            },
        )),
        None => Ok(()),
    }
}

/// Reconstruct the statement of an already successful canonical transaction.
#[allow(
    clippy::expect_used,
    reason = "successful derivation established the account and contract material"
)]
pub fn successful_statement_words(
    rules: &ProtocolRules,
    source: &pcash_state::DerivationSource,
    transaction: &AdmittedTransaction,
    l1_sender: Address,
) -> Vec<Fr> {
    if let Some(candidate) = ProofCandidate::of(rules, transaction) {
        return candidate.statement().1;
    }
    match transaction {
        AdmittedTransaction::UserAccountCreation(creation) => account_creation_statement(
            addr_to_fr(
                creation
                    .account_with_receive_key_hash(
                        Some(l1_sender),
                        source,
                        creation.receive_key_hash(),
                    )
                    .expect("successful creation has an account"),
            ),
            fr_from_internal_word(creation.nullifier_key_commitment),
            fr_from_internal_word(creation.rule_set_commitment),
            creation.receive_key_hash(),
        )
        .to_vec(),
        AdmittedTransaction::ContractAccountCreation(_, check) => {
            let material =
                contract_material(check).expect("successful creation has contract material");
            account_creation_statement(
                addr_to_fr(material.address),
                material.nk_commitment,
                material.function_set_commitment,
                material.receive_key_hash,
            )
            .to_vec()
        }
        _ => unreachable!("successful proof-bearing transaction has a statement"),
    }
}

/// The statement of an account creation without a proof: the account row it
/// writes, less the kind its type fixes and the creation revision `1`.
fn account_creation_statement_hash(op: &AccountOp) -> Fr {
    transaction_statement_hash(&account_creation_statement(
        addr_to_fr(op.address),
        op.nullifier_key_commitment,
        op.account_rule_set_commitment,
        op.receive_key_hash,
    ))
}

fn account_creation_statement(
    address: Fr,
    nullifier_key: Fr,
    rules: Fr,
    receive_key: B256,
) -> [Fr; 4] {
    [
        address,
        nullifier_key,
        rules,
        fr_from_internal_word(receive_key),
    ]
}

/// The account material a contract body derives, or the rejection of the
/// first static check the body fails.
fn contract_material(check: &ContractBodyCheck) -> Result<ContractMaterial, Rejection> {
    match &check.0 {
        Ok(material) => Ok(*material),
        Err(failure) => Err(Rejection {
            outcome: failure.outcome,
            detail: failure.detail.clone().map(FailureDetailSeed::Complete),
        }),
    }
}

/// Settle open fees to successful posters and issuance to the designated
/// owner or poster. Designated issuance appends per transaction in canonical
/// order, then poster groups in first-positive-contributor order, fees before issuance. Payout notes
/// take consecutive output indices from `first_output_index`. Returns the
/// payout records, their output commitments in the same order, and the open
/// fee total.
fn settle_payouts(
    transactions: &[ExecutedTransaction<'_>],
    reward_each: U256,
    first_output_index: u64,
) -> (Vec<PayoutRecord>, Vec<Fr>, U256) {
    let mut payouts = Vec::new();
    let mut open_fees_total = U256::ZERO;
    let mut poster_groups: Vec<PosterGroup> = Vec::new();
    let mut poster_positions = HashMap::new();
    for executed in transactions {
        let Some(effects) = executed.effects.accepted() else {
            continue;
        };
        let Some(intent) = &effects.payout else {
            continue;
        };
        open_fees_total += intent.open_fee_amount;
        let issuance = if earns_issuance(effects.kind) {
            reward_each
        } else {
            U256::ZERO
        };
        if intent.open_fee_amount.is_zero() && issuance.is_zero() {
            continue;
        }
        if intent.issuance_owner_commitment != Fr::from(0u64) {
            append_payout(
                &mut payouts,
                first_output_index,
                PayoutSource::DesignatedIssuance {
                    l1_transaction_index: executed.result.l1_transaction_index,
                    batch_item_index: executed.result.batch_item_index,
                },
                intent.issuance_owner_commitment,
                PayoutComponent::Issuance,
                issuance,
                vec![intent.context],
            );
            // A designated destination excludes a positive open fee, so the
            // transaction adds nothing to its poster's group.
            continue;
        }
        let owner = fr_from_internal_word(executed.result.poster_owner_commitment);
        let context = executed.poster_context;
        let position = *poster_positions.entry(owner).or_insert_with(|| {
            poster_groups.push(PosterGroup {
                owner,
                open_fee: U256::ZERO,
                issuance: U256::ZERO,
                sources: Vec::new(),
                contexts: Vec::new(),
            });
            poster_groups.len() - 1
        });
        let group = &mut poster_groups[position];
        group.open_fee += intent.open_fee_amount;
        group.issuance += issuance;
        if group.sources.last() != Some(&executed.result.l1_transaction_index) {
            group.sources.push(executed.result.l1_transaction_index);
        }
        // One L1 transaction can carry several of the poster's batches.
        if !group.contexts.contains(&context) {
            group.contexts.push(context);
        }
    }
    for group in poster_groups {
        append_payout(
            &mut payouts,
            first_output_index,
            PayoutSource::PosterPayout {
                l1_transaction_indices: group.sources.clone(),
            },
            group.owner,
            PayoutComponent::OpenFee,
            group.open_fee,
            group.contexts.clone(),
        );
        append_payout(
            &mut payouts,
            first_output_index,
            PayoutSource::PosterPayout {
                l1_transaction_indices: group.sources,
            },
            group.owner,
            PayoutComponent::Issuance,
            group.issuance,
            group.contexts,
        );
    }
    let (payouts, payout_commitments) = payouts.into_iter().unzip();
    (payouts, payout_commitments, open_fees_total)
}

/// Record one payout component for `owner`, with its output commitment, at
/// the next output index after those in `payouts`; a zero amount
/// appends nothing. One note always suffices: open fees are bounded by gross
/// issuance and new issuance by the remaining supply, so a payout never exceeds
/// the supply cap.
fn append_payout(
    payouts: &mut Vec<(PayoutRecord, Fr)>,
    first_output_index: u64,
    source: PayoutSource,
    owner: Fr,
    component: PayoutComponent,
    amount: U256,
    contexts: Vec<B256>,
) {
    if amount.is_zero() {
        return;
    }
    let output_index = first_output_index + payouts.len() as u64;
    payouts.push((
        PayoutRecord {
            source,
            component,
            amount,
            owner_commitment: fr_to_bytes(owner),
            output_index,
            contexts,
        },
        payout_output_commitment(owner, amount, output_index),
    ));
}

fn payout_transaction_context(
    chain_id: u32,
    profile: PrivateValueProfile,
    nullifiers: &[Fr],
) -> B256 {
    let mut fields = vec![
        domain_tags::PAYOUT_TX_CONTEXT_DOMAIN,
        Fr::from(u64::from(chain_id)),
        Fr::from(u64::from(profile.shape_id)),
        Fr::from(profile.inputs as u64),
        Fr::from(profile.outputs as u64),
    ];
    fields.extend_from_slice(nullifiers);
    fr_to_bytes(poseidon(&fields))
}

// ---- field / hash helpers -------------------------------------------------

fn pi_u256(word: &CircuitWord) -> U256 {
    pcash_state::word_to_u256(*word)
}

/// Live compare-and-swap commitment of a type-`0x03` update: the current
/// account leaf and its proposed successor.
fn account_update_commitment(current_leaf: Fr, new_leaf: Fr) -> Fr {
    poseidon(&[
        domain_tags::ACCOUNT_UPDATE_COMMITMENT_DOMAIN,
        current_leaf,
        new_leaf,
    ])
}

/// The account update commitment a type-`0x03` update of `current` to the
/// given rule set and receive-key hash must carry.
pub fn user_account_update_commitment(
    address: Address,
    current: &pcash_state::AccountState,
    new_rule_set_commitment: Fr,
    new_receive_key_hash: B256,
) -> CircuitWord {
    let current_leaf = account_state_commitment(
        address,
        current.nullifier_key_commitment,
        current.account_rule_set_commitment,
        current.kind,
        current.revision,
        current.receive_key_hash,
    );
    let new_leaf = account_state_commitment(
        address,
        current.nullifier_key_commitment,
        new_rule_set_commitment,
        current.kind,
        current.revision + 1,
        new_receive_key_hash,
    );
    fr_to_bytes(account_update_commitment(current_leaf, new_leaf))
}

/// `accountRuleEntryCommitment = poseidon(ACCOUNT_RULE_ENTRY_DOMAIN, applicationVkHash, configurationCommitment, commitmentBlinder)`.
fn account_rule_entry_commitment(
    application_vk_hash: Fr,
    configuration_commitment: Fr,
    commitment_blinder: Fr,
) -> Fr {
    poseidon(&[
        domain_tags::ACCOUNT_RULE_ENTRY_DOMAIN,
        application_vk_hash,
        configuration_commitment,
        commitment_blinder,
    ])
}

/// Contract address derivation: `uint160(poseidon(CONTRACT_ADDRESS_DOMAIN,
/// nullifierKeyCommitment, functionSetCommitment, receiveKeyHash,
/// publishesNkRoot))` — the low 160 bits of the canonical integer.
fn contract_address(
    nullifier_key_commitment: Fr,
    function_set_commitment: Fr,
    receive_key_hash: Fr,
    publishes_nk_root: u8,
) -> Address {
    let preimage = poseidon(&[
        domain_tags::CONTRACT_ADDRESS_DOMAIN,
        nullifier_key_commitment,
        function_set_commitment,
        receive_key_hash,
        Fr::from(u64::from(publishes_nk_root)),
    ]);
    Address::from_slice(&fr_to_bytes(preimage)[12..32])
}

/// The body serializes exactly one representation of the nullifier-key
/// material, so the commitment is either that material itself or the
/// commitment derived from the published `nkRoot`.
fn contract_nullifier_key_commitment(publishes_nk_root: bool, material: Fr) -> Fr {
    if publishes_nk_root {
        poseidon(&[domain_tags::NULLIFIER_KEY_COMMITMENT_DOMAIN, material])
    } else {
        material
    }
}

fn contract_function_set_material(body: &ContractBody, commitments: &[Fr]) -> Fr {
    let mut tree = SparseTree::new(ACCOUNT_RULE_TREE_DEPTH);
    let leaves = body
        .functions
        .iter()
        .zip(commitments)
        .map(|(function, &commitment)| (u64::from(function.selector), commitment))
        .collect::<Vec<_>>();
    tree.set_leaves(&leaves);
    tree.root()
}

/// `contractFunctionCommitment = accountRuleEntryCommitment(vkHash, config, 0)`.
/// A contract publishes its complete function list on Ethereum DA, so a
/// published per-function blinder hides nothing.
fn contract_function_commitment(application_vk_hash: Fr, configuration_commitment: Fr) -> Fr {
    account_rule_entry_commitment(
        application_vk_hash,
        configuration_commitment,
        Fr::from(0u64),
    )
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions"
)]
mod issuance_time_tests {
    use super::*;

    #[test]
    fn anchor_actions_use_zero_elapsed_time_and_the_initial_multiplier() {
        let elapsed = controller_elapsed_seconds(7, 7, 1_900_000_000, 0);
        assert_eq!(elapsed, 0);
        let quote = pcash_issuance::quote(pcash_issuance::initial_state(), elapsed);
        let settled = pcash_issuance::transition(pcash_issuance::initial_state(), elapsed, 1);
        assert_eq!(quote.multiplier_q, pcash_issuance::scale());
        assert_eq!(settled.reward_each, quote.max_single_action_reward);
        assert!(!settled.reward_each.is_zero());
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions"
)]
mod test_fixtures {
    use super::*;

    /// A successful transaction at `(l1_transaction_index, batch_item_index)`
    /// in a batch posted by `poster`, with exactly these settlement inputs.
    pub(super) fn accepted(
        l1_transaction_index: u64,
        batch_item_index: u64,
        kind: u8,
        open_fee_amount: U256,
        issuance_owner_commitment: Fr,
        poster: Fr,
    ) -> ExecutedTransaction<'static> {
        executed(
            l1_transaction_index,
            batch_item_index,
            TransactionOutcome::Succeeded,
            TransactionEffects::Accepted(AcceptedEffects {
                kind,
                output_leaf_start: None,
                output_commitments: Vec::new(),
                nullifiers: Vec::new(),
                account: None,
                payout: Some(PayoutIntent {
                    open_fee_amount,
                    issuance_owner_commitment,
                    context: B256::with_last_byte(0xc0),
                }),
            }),
            poster,
        )
    }

    pub(super) fn executed(
        l1_transaction_index: u64,
        batch_item_index: u64,
        outcome: TransactionOutcome,
        effects: TransactionEffects,
        poster: Fr,
    ) -> ExecutedTransaction<'static> {
        ExecutedTransaction {
            result: TransactionResult {
                tx_type: effects
                    .accepted()
                    .map_or(KIND_PRIVATE_VALUE, |effects| effects.kind),
                funding_mode: 0,
                l1_transaction_index,
                batch_item_index,
                outcome,
                poster_owner_commitment: fr_to_bytes(poster),
                output_start_index: 0,
                statement_hash: B256::ZERO,
            },
            raw: &[],
            effects,
            poster_context: B256::with_last_byte(0xc1),
        }
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions"
)]
mod block_phase_tests {
    use super::test_fixtures::{accepted, executed};
    use super::*;
    use alloy_primitives::Bytes;
    use pcash_l1::{BlobResolution, NormalizedLog};

    /// A source anchored at `genesis_l1_block` with the hash [`header`] gives
    /// every block.
    fn source(genesis_l1_block: u64) -> DerivationSource {
        DerivationSource {
            pcash_chain_id: 1,
            l1_chain_id: 1,
            inbox_address: Address::ZERO,
            genesis_l1_block,
            genesis_l1_block_hash: B256::repeat_byte(0xaa),
        }
    }

    fn header(number: u64, timestamp: u64) -> L1Header {
        L1Header {
            number,
            hash: B256::repeat_byte(0xaa),
            parent_hash: B256::repeat_byte(0x99),
            timestamp,
        }
    }

    fn tx(input: &[u8], blob_versioned_hashes: Vec<B256>) -> L1Tx {
        L1Tx {
            hash: B256::repeat_byte(0x01),
            from: Address::repeat_byte(0x02),
            to: Some(Address::ZERO),
            input: Bytes::copy_from_slice(input),
            blob_versioned_hashes,
            blob_resolution: BlobResolution::Invalid,
            tx_index: 3,
        }
    }

    fn inbox_carrier(tx: &L1Tx) -> Carrier<'_> {
        Carrier {
            tx,
            source: CarrierSource::Inbox,
        }
    }

    fn versioned_hash(version: u8) -> B256 {
        let mut hash = B256::repeat_byte(0x55);
        hash.0[0] = version;
        hash
    }

    #[test]
    fn genesis_header_must_match_the_anchor_and_ignores_the_previous_timestamp() {
        let mut source = source(7);
        // The previous timestamp is not compared at genesis.
        check_l1_header(&header(7, 10), &source, 1_000).unwrap();
        source.genesis_l1_block_hash = B256::repeat_byte(0xbb);
        assert!(matches!(
            check_l1_header(&header(7, 10), &source, 0),
            Err(DeriveError::GenesisAnchorMismatch { block: 7, .. })
        ));
        // The anchor binds only the genesis block.
        check_l1_header(&header(8, 10), &source, 10).unwrap();
    }

    #[test]
    fn post_genesis_header_timestamp_may_repeat_but_not_regress() {
        let source = source(7);
        check_l1_header(&header(8, 100), &source, 99).unwrap();
        check_l1_header(&header(8, 100), &source, 100).unwrap();
        assert!(matches!(
            check_l1_header(&header(8, 100), &source, 101),
            Err(DeriveError::TimestampRegression {
                block: 8,
                parent_ts: 101,
                ts: 100,
            })
        ));
    }

    #[test]
    fn ignored_carrier_separates_unsupported_from_invalid_encodings() {
        let valid = versioned_hash(0x01);
        for (carrier, expected) in [
            // Calldata and blobs together.
            (
                tx(&[1, 2], vec![valid]),
                BatchExclusionReason::UnsupportedCarrierEncoding,
            ),
            // An unknown versioned-hash version.
            (
                tx(&[], vec![versioned_hash(0x02)]),
                BatchExclusionReason::UnsupportedCarrierEncoding,
            ),
            // More blobs than a batch may span.
            (
                tx(&[], vec![valid; pcash_da::MAX_BATCH_BLOBS + 1]),
                BatchExclusionReason::UnsupportedCarrierEncoding,
            ),
            // A supported blob carrier whose payload did not decode.
            (
                tx(&[], vec![valid]),
                BatchExclusionReason::InvalidCarrierEncoding,
            ),
            // Calldata longer than a candidate batch may be.
            (
                tx(&vec![0; pcash_da::MAX_BATCH_BYTES + 1], Vec::new()),
                BatchExclusionReason::InvalidCarrierEncoding,
            ),
        ] {
            assert_eq!(ignored_carrier(&inbox_carrier(&carrier)).1, expected);
        }

        let mut identity = vec![1, 2];
        identity.extend_from_slice(valid.as_slice());
        assert_eq!(
            ignored_carrier(&inbox_carrier(&tx(&[1, 2], vec![valid]))).0,
            (keccak256(identity), 2)
        );
    }

    #[test]
    fn delivery_batch_records_the_poster_only_for_an_accepted_batch() {
        let blob = tx(&[], vec![versioned_hash(0x01)]);
        let excluded = delivery_batch(
            &inbox_carrier(&blob),
            (B256::repeat_byte(0x77), 5),
            Some(BatchExclusionReason::TruncatedFraming),
            None,
            0,
            Vec::new(),
        );
        assert_eq!(excluded.l1_transaction_index, 3);
        assert_eq!(excluded.carrier_type, CarrierType::Blob);
        assert_eq!(excluded.carrier_length, 5);
        assert_eq!(excluded.poster_owner_commitment, None);
        assert_eq!(excluded.poster_context, None);

        let batch = PreparedBatch {
            bytes: &[],
            carrier_context_hash: Fr::from(0u64),
            poster_owner_commitment: Fr::from(1u64),
            poster_context: B256::with_last_byte(2),
            items: Vec::new(),
        };
        let calldata = tx(&[1], Vec::new());
        let accepted = delivery_batch(
            &inbox_carrier(&calldata),
            (B256::ZERO, 1),
            None,
            Some(&batch),
            0,
            Vec::new(),
        );
        assert_eq!(accepted.carrier_type, CarrierType::Calldata);
        assert_eq!(
            accepted.poster_owner_commitment,
            Some(B256::with_last_byte(1))
        );
        assert_eq!(accepted.poster_context, Some(B256::with_last_byte(2)));
    }

    #[test]
    fn delivery_item_locates_the_item_within_its_batch() {
        let batch_bytes = [0u8; 10];
        let raw = &batch_bytes[4..7];

        let admitted = delivery_item(1, raw, &batch_bytes, B256::repeat_byte(0x22), None);
        assert_eq!(admitted.batch_item_index, 1);
        assert_eq!(admitted.byte_offset, 4);
        assert_eq!(admitted.byte_length, 3);
        assert_eq!(admitted.content_hash, B256::repeat_byte(0x22));
        assert_eq!(admitted.exclusion_reason, None);

        let excluded = delivery_item(
            1,
            raw,
            &batch_bytes,
            B256::ZERO,
            Some(ItemExclusionReason::Truncated),
        );
        assert_eq!(
            excluded.exclusion_reason,
            Some(ItemExclusionReason::Truncated)
        );
    }

    #[test]
    fn settlement_counts_only_successful_issuance_earning_transactions() {
        let poster = Fr::from(9u64);
        let transactions = [
            accepted(
                0,
                0,
                KIND_PRIVATE_VALUE,
                U256::from(5),
                Fr::from(0u64),
                poster,
            ),
            accepted(
                0,
                1,
                KIND_USER_ACCOUNT_UPDATE,
                U256::from(7),
                Fr::from(0u64),
                poster,
            ),
            executed(
                0,
                2,
                TransactionOutcome::OutputCapacity,
                TransactionEffects::Rejected(RejectedEffects {
                    account: None,
                    detail: None,
                }),
                poster,
            ),
            accepted(1, 0, KIND_PRIVATE_VALUE, U256::ZERO, Fr::from(0u64), poster),
        ];
        let settlement = settle_block(
            pcash_issuance::block_terms(pcash_issuance::initial_state(), 0),
            &transactions,
            40,
        );

        let expected = pcash_issuance::transition(pcash_issuance::initial_state(), 0, 2);
        assert_eq!(settlement.economics.qualifying_actions, 2);
        assert_eq!(settlement.economics.open_fees_total, U256::from(12));
        assert_eq!(settlement.economics.reward_each, expected.reward_each);
        assert_eq!(settlement.economics.issuance_total, expected.new_issuance);
        assert_eq!(settlement.issuance, expected.state);

        // One poster earns every open fee and both rewards, from index 40.
        assert_eq!(settlement.payouts[0].output_index, 40);
        assert!(settlement
            .payouts
            .iter()
            .all(|payout| payout.owner_commitment == fr_to_bytes(poster)));
        let (open_fees, issuance) =
            settlement
                .payouts
                .iter()
                .fold((U256::ZERO, U256::ZERO), |(fees, issuance), payout| {
                    let (open_fee_amount, issuance_amount) = payout.result_components();
                    (fees + open_fee_amount, issuance + issuance_amount)
                });
        assert_eq!(open_fees, U256::from(12));
        assert_eq!(issuance, expected.reward_each * U256::from(2));
    }

    #[test]
    fn pcash_number_starts_at_zero_and_increments_the_tip() {
        assert_eq!(next_pcash_number(None).unwrap(), 0);
        assert_eq!(next_pcash_number(Some(0)).unwrap(), 1);
        assert_eq!(next_pcash_number(Some(41)).unwrap(), 42);
        assert!(matches!(
            next_pcash_number(Some(u64::MAX)),
            Err(DeriveError::BlockNumberOverflow)
        ));
    }

    #[test]
    fn block_input_has_one_aligned_result_per_admitted_transaction() {
        let poster = Fr::from(9u64);
        let transactions = vec![
            ExecutedTransaction {
                raw: &[1],
                ..accepted(2, 1, KIND_PRIVATE_VALUE, U256::ZERO, Fr::from(0u64), poster)
            },
            ExecutedTransaction {
                raw: &[2, 3],
                ..executed(
                    5,
                    0,
                    TransactionOutcome::OutputCapacity,
                    TransactionEffects::Rejected(RejectedEffects {
                        account: None,
                        detail: None,
                    }),
                    poster,
                )
            },
        ];
        let header = header(9, 100);
        let l1_logs = NormalizedLogBlock::from_logs(vec![
            NormalizedLog {
                transaction_index: 2,
                log_index: 0,
                leaf: B256::with_last_byte(0x31),
            },
            NormalizedLog {
                transaction_index: 6,
                log_index: 1,
                leaf: B256::with_last_byte(0x32),
            },
        ]);
        let calldata = tx(&[1], Vec::new());
        let history = CanonicalBlockHistory {
            l1_delivery_batches: vec![delivery_batch(
                &inbox_carrier(&calldata),
                (B256::repeat_byte(0x77), 1),
                Some(BatchExclusionReason::TruncatedFraming),
                None,
                0,
                Vec::new(),
            )],
            economics: BlockEconomics {
                open_fees_total: U256::from(12),
                qualifying_actions: 3,
                ..BlockEconomics::default()
            },
            payouts: vec![PayoutRecord {
                source: PayoutSource::PosterPayout {
                    l1_transaction_indices: vec![2],
                },
                component: PayoutComponent::OpenFee,
                amount: U256::from(12),
                owner_commitment: fr_to_bytes(poster),
                output_index: 40,
                contexts: vec![B256::with_last_byte(0xc1)],
            }],
        };

        let input = assemble_block_input(&header, 4, &l1_logs, transactions, history.clone());

        assert_eq!(input.number, 4);
        assert_eq!(input.timestamp, 100);
        assert_eq!(input.l1_origin.block_number, 9);
        assert_eq!(input.l1_origin.block_hash, B256::repeat_byte(0xaa));
        assert_eq!(input.l1_origin.block_timestamp, 100);
        assert_eq!(input.l1_origin.l1_logs_root, l1_logs.root);
        assert_ne!(
            input.l1_origin.l1_logs_root,
            NormalizedLogBlock::empty().root
        );
        assert_eq!(input.l1_origin.l1_log_count, 2);
        let leaves: Vec<_> = input
            .l1_logs
            .iter()
            .map(|log| (log.transaction_index, log.log_index, log.leaf))
            .collect();
        assert_eq!(
            leaves,
            [
                (2, 0, B256::with_last_byte(0x31)),
                (6, 1, B256::with_last_byte(0x32)),
            ]
        );
        assert_eq!(input.transaction_bytes, [vec![1], vec![2, 3]]);
        assert_eq!(input.history, history);
        let positions: Vec<_> = input
            .transaction_results
            .iter()
            .map(|result| {
                (
                    result.l1_transaction_index,
                    result.batch_item_index,
                    result.outcome,
                )
            })
            .collect();
        assert_eq!(
            positions,
            [
                (2, 1, TransactionOutcome::Succeeded),
                (5, 0, TransactionOutcome::OutputCapacity),
            ]
        );
        assert!(matches!(
            input.transaction_effects.as_slice(),
            [
                TransactionEffects::Accepted(_),
                TransactionEffects::Rejected(RejectedEffects {
                    account: None,
                    detail: None,
                })
            ]
        ));
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions"
)]
mod payout_capacity_tests {
    use super::*;

    /// Every section inserts no more nullifiers than it appends outputs, so
    /// the nullifier count never exceeds the output count. The nullifier tree
    /// is one level deeper than the output tree to hold the sentinel too.
    #[test]
    fn no_profile_has_more_inputs_than_outputs() {
        let profiles = (0..=u8::MAX)
            .filter_map(crate::private_value_profiles::private_value_profile)
            .collect::<Vec<_>>();
        assert!(!profiles.is_empty());
        for profile in profiles {
            assert!(profile.inputs <= profile.outputs, "{profile:?}");
        }
        assert_eq!(
            1u128 << pcash_state::NULLIFIER_TREE_DEPTH,
            2 * u128::from(MAX_LEAVES)
        );
    }

    fn section(seed: u64, fee: u64, earns_issuance: bool) -> SectionValues {
        SectionValues {
            profile: S,
            recent_pcash_block_hash: B256::ZERO,
            nullifiers: (0..S.inputs).map(|i| Fr::from(seed + i as u64)).collect(),
            bodies: vec![Fr::from(seed); 5],
            open_fee_amount: U256::from(fee),
            issuance_owner_commitment: Fr::from(0u64),
            earns_issuance,
        }
    }

    fn section_only(section: SectionDiff) -> TransactionDiff {
        TransactionDiff {
            section: Some(section),
            account: None,
            statement_hash: Fr::from(0u64),
        }
    }

    fn stub_rules() -> ProtocolRules {
        ProtocolRules::new([vec![], vec![]], vec![], vec![])
    }

    fn test_source() -> DerivationSource {
        DerivationSource {
            pcash_chain_id: 1,
            l1_chain_id: 1,
            inbox_address: Address::ZERO,
            genesis_l1_block: 0,
            genesis_l1_block_hash: B256::with_last_byte(1),
        }
    }

    fn empty_state() -> pcash_state::MemState {
        pcash_state::MemState::new(test_source())
    }

    #[test]
    fn issuance_slot_is_reserved_only_for_qualifying_actions_while_a_reward_is_possible() {
        let rules = stub_rules();
        let active = pcash_issuance::initial_state();
        let exhausted = pcash_issuance::IssuanceState {
            issued_so_far: pcash_issuance::supply_cap(),
            lag_q: active.lag_q,
        };
        for (issuance, values, expected) in [
            // A zero-fee qualifying action reserves exactly its issuance note.
            (active, section(1, 0, true), 1),
            // A positive open fee may need a separate poster note.
            (active, section(1, 1, true), 2),
            // Account operations never earn issuance.
            (active, section(1, 0, false), 0),
            (active, section(1, 1, false), 1),
            // No issuance slot once the one-action maximum is zero.
            (exhausted, section(1, 0, true), 0),
        ] {
            let ctx = BlockCtx::new(
                &rules,
                test_source(),
                12,
                0,
                0,
                pcash_issuance::reward_slot_active(issuance, 0),
            );
            assert_eq!(ctx.payout_reservation(Fr::from(0u64), &values), expected);
        }
    }

    #[test]
    fn separate_open_fee_and_issuance_settlement_stays_within_reservations() {
        let rules = stub_rules();
        let state = empty_state();
        let designated_owner = Fr::from(7u64);
        let poster = Fr::from(9u64);
        let sections = [
            (
                section(1, 0, true),
                crate::params::KIND_PRIVATE_VALUE,
                designated_owner,
            ),
            (
                section(11, 3, true),
                crate::params::KIND_PRIVATE_VALUE,
                Fr::from(0u64),
            ),
            (
                section(21, 0, true),
                crate::params::KIND_PRIVATE_VALUE,
                designated_owner,
            ),
            (
                section(31, 5, false),
                crate::params::KIND_USER_ACCOUNT_UPDATE,
                Fr::from(0u64),
            ),
        ];
        // Ordinary outputs 4 x 5; payout reservations 1 + 2 + 1 + 0, since the
        // account update's fee joins the poster's existing fee note.
        let reserved = 20 + 4;
        let mut ctx = BlockCtx::new(
            &rules,
            test_source(),
            12,
            MAX_LEAVES - reserved,
            0,
            pcash_issuance::reward_slot_active(pcash_issuance::initial_state(), 0),
        );
        let mut outcomes = Vec::new();
        for (index, (values, kind, owner)) in sections.iter().enumerate() {
            let diff = ctx.section_diff(&state, poster, values).unwrap();
            ctx.apply(poster, section_only(diff));
            outcomes.push(test_fixtures::accepted(
                0,
                index as u64,
                *kind,
                values.open_fee_amount,
                *owner,
                poster,
            ));
        }
        assert_eq!(ctx.pending_payout_slots, 4);
        assert!(matches!(
            ctx.section_diff(&state, poster, &section(41, 0, false)),
            Err(Halt::Rejected(Rejection {
                outcome: TransactionOutcome::OutputCapacity,
                ..
            }))
        ));
        let reward_each =
            pcash_issuance::transition(pcash_issuance::initial_state(), 0, 3).reward_each;
        assert!(!reward_each.is_zero());
        let (payouts, _, open_fees_total) =
            settle_payouts(&outcomes, reward_each, ctx.next_output_index);
        assert!(ctx.next_output_index + payouts.len() as u64 <= MAX_LEAVES);
        assert_eq!(payouts.len(), 4);
        assert_eq!(open_fees_total, U256::from(8));
        let poster_payout = &payouts[2];
        assert_eq!(poster_payout.owner_commitment, fr_to_bytes(poster));
        assert_eq!(poster_payout.component, PayoutComponent::OpenFee);
        assert_eq!(poster_payout.amount, U256::from(8));
        assert_eq!(payouts[3].owner_commitment, fr_to_bytes(poster));
        assert_eq!(payouts[3].component, PayoutComponent::Issuance);
        assert_eq!(payouts[3].amount, reward_each);
        assert_eq!(payouts[3].contexts, poster_payout.contexts);
    }

    #[test]
    fn a_poster_reserves_one_fee_slot_but_a_new_poster_needs_capacity() {
        let rules = stub_rules();
        let state = empty_state();
        for (amount, change_owner, fits) in [
            (U256::from(1), false, true),
            (U256::from(u128::MAX), false, true),
            (U256::from(1), true, false),
        ] {
            let mut ctx = BlockCtx::new(
                &rules,
                test_source(),
                12,
                MAX_LEAVES - 11,
                0,
                pcash_issuance::reward_slot_active(pcash_issuance::initial_state(), 0),
            );
            let mut first = section(1, 1, false);
            first.open_fee_amount = amount;
            let diff = ctx.section_diff(&state, Fr::from(0u64), &first).unwrap();
            ctx.apply(Fr::from(0u64), section_only(diff));
            let second_poster = if change_owner {
                Fr::from(9u64)
            } else {
                Fr::from(0u64)
            };
            let second = section(11, 1, false);
            let result = ctx.section_diff(&state, second_poster, &second);
            assert_eq!(result.is_ok(), fits);
            assert!(ctx.posters_with_open_fees.contains(&Fr::from(0u64)));
            assert_eq!(ctx.pending_payout_slots, 1);
            if let Ok(diff) = result {
                ctx.apply(second_poster, section_only(diff));
                assert_eq!(ctx.pending_payout_slots, 1);
                assert_eq!(ctx.next_output_index + ctx.pending_payout_slots, MAX_LEAVES);
            }
        }
    }

    #[test]
    fn only_a_successful_section_reserves_slots_or_marks_its_poster() {
        let rules = stub_rules();
        let state = empty_state();
        let poster = Fr::from(9u64);
        let mut ctx = BlockCtx::new(
            &rules,
            test_source(),
            12,
            0,
            0,
            pcash_issuance::reward_slot_active(pcash_issuance::initial_state(), 0),
        );
        // A section that passes its capacity check but then fails, such as on
        // proof verification, is never applied.
        let failed = ctx
            .section_diff(&state, poster, &section(1, 1, true))
            .unwrap();
        assert_eq!(failed.pending_payout_slots, 2);
        assert_eq!(ctx.pending_payout_slots, 0);
        assert!(ctx.posters_with_open_fees.is_empty());
        let fee_only = section(11, 1, false);
        assert_eq!(ctx.payout_reservation(poster, &fee_only), 1);
        let diff = ctx.section_diff(&state, poster, &fee_only).unwrap();
        ctx.apply(poster, section_only(diff));
        assert_eq!(ctx.pending_payout_slots, 1);
        assert_eq!(ctx.payout_reservation(poster, &section(21, 1, false)), 0);
    }

    #[test]
    fn oversized_unverified_open_fees_reserve_one_fee_slot() {
        let rules = stub_rules();
        let state = empty_state();
        let issuance = pcash_issuance::initial_state();
        for hostile_fee in [U256::from(1) << 192, U256::from(1) << 253] {
            let mut ctx = BlockCtx::new(
                &rules,
                test_source(),
                12,
                0,
                0,
                pcash_issuance::reward_slot_active(issuance, 0),
            );
            let mut values = section(1, 0, false);
            values.open_fee_amount = hostile_fee;
            // The proof's fee bound rejects the transaction after this check.
            let diff = ctx.section_diff(&state, Fr::from(0u64), &values).unwrap();
            assert_eq!(diff.pending_payout_slots, 1);
            ctx.posters_with_open_fees.insert(Fr::from(0u64));
            let diff = ctx.section_diff(&state, Fr::from(0u64), &values).unwrap();
            assert_eq!(diff.pending_payout_slots, 0);
        }
    }

    #[test]
    fn reservations_cover_prior_payouts_and_unused_slots_create_no_leaves() {
        let rules = stub_rules();
        let state = empty_state();
        let mut ctx = BlockCtx::new(
            &rules,
            test_source(),
            12,
            MAX_LEAVES - 12,
            0,
            pcash_issuance::reward_slot_active(pcash_issuance::initial_state(), 0),
        );
        let first = section(1, 1, true);
        let diff = ctx.section_diff(&state, Fr::from(0u64), &first).unwrap();
        ctx.apply(Fr::from(0u64), section_only(diff));
        assert_eq!(ctx.pending_payout_slots, 2);
        assert!(matches!(
            ctx.section_diff(&state, Fr::from(0u64), &section(11, 1, true)),
            Err(Halt::Rejected(Rejection {
                outcome: TransactionOutcome::OutputCapacity,
                detail: Some(FailureDetailSeed::Complete(FailureDetail::OutputCapacity {
                    requested_count,
                    limit: MAX_LEAVES,
                })),
            })) if requested_count == MAX_LEAVES + 1
        ));
        // A later action needing no payout fits without reconsidering the rejected action.
        let later = section(21, 0, false);
        let diff = ctx.section_diff(&state, Fr::from(0u64), &later).unwrap();
        ctx.apply(Fr::from(0u64), section_only(diff));
        assert_eq!(ctx.output_commitments.len(), 10);
        // If the issuance rounds to zero, only the positive fee appends.
        let poster = Fr::from(7u64);
        let (payouts, _, _) = settle_payouts(
            &[test_fixtures::accepted(
                0,
                0,
                crate::params::KIND_PRIVATE_VALUE,
                U256::from(1),
                Fr::from(0u64),
                poster,
            )],
            U256::ZERO,
            ctx.next_output_index,
        );
        assert_eq!(payouts.len(), 1);
        assert_eq!(payouts[0].output_index, MAX_LEAVES - 2);
        assert_eq!(payouts[0].amount, U256::from(1));
    }

    #[test]
    fn zero_payouts_append_nothing() {
        let poster = Fr::from(9u64);
        let transactions = [
            test_fixtures::accepted(
                0,
                0,
                crate::params::KIND_PRIVATE_VALUE,
                U256::ZERO,
                Fr::from(7u64),
                poster,
            ),
            test_fixtures::accepted(
                0,
                1,
                crate::params::KIND_PRIVATE_VALUE,
                U256::ZERO,
                Fr::from(0u64),
                poster,
            ),
        ];
        let (payouts, _, open_fees_total) = settle_payouts(&transactions, U256::ZERO, 40);
        assert!(payouts.is_empty());
        assert!(open_fees_total.is_zero());
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions"
)]
mod protocol_vector_tests {
    use super::*;
    use serde_json::Value;

    fn vectors() -> Value {
        serde_json::from_str(include_str!("../../../../vectors/protocol_vectors.json"))
            .expect("parse published protocol vectors")
    }

    fn bytes32(value: &str) -> [u8; 32] {
        let digits = value.strip_prefix("0x").expect("vector hex must use 0x");
        let padded;
        let digits = if digits.len().is_multiple_of(2) {
            digits
        } else {
            padded = format!("0{digits}");
            &padded
        };
        let bytes = hex::decode(digits).expect("decode vector hex");
        assert!(bytes.len() <= 32, "vector word exceeds 32 bytes");
        let mut word = [0u8; 32];
        word[32 - bytes.len()..].copy_from_slice(&bytes);
        word
    }

    fn field(value: &Value) -> Fr {
        fr_from_canonical_bytes(B256::from(bytes32(
            value.as_str().expect("vector field must be a string"),
        )))
        .expect("vector field must be canonical")
    }

    #[test]
    fn profile_payout_contexts_match_independent_vectors() {
        let published = vectors();
        let chain_id = u32::try_from(published["chainId"].as_u64().unwrap()).unwrap();
        for vector in published["privateValueProfiles"].as_array().unwrap() {
            let shape = crate::private_value_profiles::PrivateValueShape::from_wire_byte(
                vector["shape"].as_u64().unwrap() as u8,
            )
            .unwrap();
            let nullifiers: Vec<Fr> = vector["nullifiers"]
                .as_array()
                .unwrap()
                .iter()
                .map(field)
                .collect();
            assert_eq!(nullifiers.len(), shape.profile().inputs);
            assert_eq!(
                payout_transaction_context(chain_id, shape.profile(), &nullifiers),
                fr_to_bytes(field(&vector["transactionContext"]))
            );
        }
    }

    fn typed_root(domain: Fr, leaf: Fr, key: u64, siblings: &[Fr]) -> Fr {
        siblings
            .iter()
            .enumerate()
            .fold(leaf, |current, (height, sibling)| {
                if (key >> height) & 1 == 0 {
                    poseidon(&[domain, current, *sibling])
                } else {
                    poseidon(&[domain, *sibling, current])
                }
            })
    }

    fn address(value: &Value) -> Address {
        let word = bytes32(value.as_str().expect("vector address must be a string"));
        Address::from_slice(&word[12..])
    }

    fn u64_word(value: &Value) -> u64 {
        let word = bytes32(value.as_str().expect("vector integer must be a string"));
        assert_eq!(&word[..24], &[0u8; 24], "vector integer exceeds u64");
        u64::from_be_bytes(word[24..].try_into().unwrap())
    }

    fn state_components(vectors: &Value) -> pcash_state::StateComponents {
        let state = &vectors["stateCommitment"]["input"];
        pcash_state::StateComponents {
            output_root: B256::from(bytes32(state["outputRoot"].as_str().unwrap())),
            output_count: u64_word(&state["outputCount"]),
            issuance: pcash_issuance::IssuanceState {
                issued_so_far: U256::from_be_bytes(bytes32(state["issuedSoFar"].as_str().unwrap())),
                lag_q: state["lagQ"].as_str().unwrap().parse().unwrap(),
            },
            account_state_root: B256::from(bytes32(state["accountStateRoot"].as_str().unwrap())),
            account_count: u64_word(&state["accountCount"]),
            nullifier_root: B256::from(bytes32(state["nullifierRoot"].as_str().unwrap())),
            nullifier_count: u64_word(&state["nullifierCount"]),
        }
    }

    #[test]
    fn output_l1_origin_and_history_paths_match_published_vectors() {
        let vectors = vectors();
        let output = &vectors["outputCommitment"];
        assert_eq!(
            output_commitment(
                field(&output["outputBody"]),
                output["outputIndex"].as_u64().unwrap(),
            ),
            field(&output["value"])
        );

        let l1 = &vectors["l1OriginLeaf"];
        let block_hash = bytes32(l1["blockHash"].as_str().unwrap());
        let l1_origin_leaf = pcash_state::l1_origin_leaf(&L1Origin {
            block_number: u64::from_be_bytes(
                bytes32(l1["blockNumber"].as_str().unwrap())[24..]
                    .try_into()
                    .unwrap(),
            ),
            block_hash: B256::from(block_hash),
            block_timestamp: u64_word(&l1["blockTimestamp"]),
            l1_logs_root: B256::from(bytes32(l1["l1LogsRoot"].as_str().unwrap())),
            l1_log_count: u64_word(&l1["l1LogCount"]),
        });
        assert_eq!(l1_origin_leaf, field(&l1["leaf"]));
        let l1_origin_siblings: Vec<_> = l1["siblings"]
            .as_array()
            .unwrap()
            .iter()
            .map(field)
            .collect();
        assert_eq!(
            pcash_crypto::merkle::root_from_index(l1_origin_leaf, 0, &l1_origin_siblings),
            field(&l1["root"])
        );

        let history = &vectors["history"];
        let history_number = u64_word(&history["blockNumber"]);
        let history_hash = bytes32(history["blockHash"].as_str().unwrap());
        let history_leaf = pcash_state::history_leaf(B256::from(history_hash));
        assert_eq!(history_leaf, field(&history["leaf"]));
        let history_siblings: Vec<_> = history["siblings"]
            .as_array()
            .unwrap()
            .iter()
            .map(field)
            .collect();
        assert_eq!(
            pcash_crypto::merkle::root_from_index(history_leaf, history_number, &history_siblings),
            field(&history["root"])
        );
    }

    #[test]
    fn account_state_commitment_and_entry_formulas_match_published_vectors() {
        let vectors = vectors();
        let account = &vectors["accountStateCommitment"];
        assert_eq!(
            account_rule_entry_commitment(
                field(&account["applicationVkHash"]),
                field(&account["configurationCommitment"]),
                field(&account["commitmentBlinder"]),
            ),
            field(&account["accountRuleEntryCommitment"])
        );
        assert_eq!(
            account_state_commitment(
                address(&account["address"]),
                field(&account["nullifierKeyCommitment"]),
                field(&account["accountRuleSetCommitment"]),
                0,
                u32::try_from(u64_word(&account["accountRevision"])).unwrap(),
                B256::from(bytes32(account["receiveKeyHash"].as_str().unwrap())),
            ),
            field(&account["userPresent"])
        );
        assert_eq!(
            account_state_commitment(
                address(&account["address"]),
                field(&account["nullifierKeyCommitment"]),
                field(&account["accountRuleSetCommitment"]),
                0,
                u32::try_from(u64_word(&account["accountRevision"])).unwrap(),
                B256::ZERO,
            ),
            field(&account["userAbsent"])
        );
        // A contract leaf commits the contract function-set root, which is
        // built from zero-blinded entries — not the user rule-set root above.
        let contract = &vectors["contractAddress"];
        assert_ne!(
            field(&contract["functionSetCommitment"]),
            field(&account["accountRuleSetCommitment"])
        );
        assert_eq!(
            account_state_commitment(
                address(&contract["address"]),
                field(&account["nullifierKeyCommitment"]),
                field(&contract["functionSetCommitment"]),
                1,
                u32::try_from(u64_word(&account["contractRevision"])).unwrap(),
                B256::ZERO,
            ),
            field(&account["contractAbsent"])
        );
        // The published function commitment is the shared four-field entry
        // with the canonical blinder 0.
        assert_eq!(
            account_rule_entry_commitment(
                field(&contract["applicationVkHash"]),
                field(&contract["configurationCommitment"]),
                Fr::from(0u64),
            ),
            field(&contract["functionCommitment"])
        );
    }

    #[test]
    fn account_update_commitment_matches_published_vector() {
        let vectors = vectors();
        let update = &vectors["accountUpdateCommitment"];
        let operands = &update["operands"];
        let derived = &update["derived"];
        let address = address(&operands["address"]);
        let current_revision =
            u32::try_from(u64_word(&operands["currentAccountRevision"])).unwrap();
        let new_revision = u32::try_from(u64_word(&operands["newAccountRevision"])).unwrap();
        assert_eq!(new_revision, current_revision + 1);
        assert_eq!(operands["currentAccountKind"].as_u64(), Some(0));
        assert_eq!(operands["newAccountKind"].as_u64(), Some(0));

        let current_receive_key_hash =
            B256::from(bytes32(operands["currentReceiveKeyHash"].as_str().unwrap()));
        let new_receive_key_hash =
            B256::from(bytes32(operands["newReceiveKeyHash"].as_str().unwrap()));
        let current = pcash_state::AccountState {
            index: 0,
            revision: current_revision,
            nullifier_key_commitment: field(&operands["nullifierKeyCommitment"]),
            account_rule_set_commitment: field(&operands["currentRuleSetCommitment"]),
            kind: ACCOUNT_KIND_USER,
            receive_key_hash: current_receive_key_hash,
        };
        let new_rule_set = field(&operands["newRuleSetCommitment"]);

        assert_eq!(
            account_state_commitment(
                address,
                current.nullifier_key_commitment,
                current.account_rule_set_commitment,
                ACCOUNT_KIND_USER,
                current_revision,
                current_receive_key_hash,
            ),
            field(&derived["currentAccountStateCommitment"])
        );
        assert_eq!(
            account_state_commitment(
                address,
                current.nullifier_key_commitment,
                new_rule_set,
                ACCOUNT_KIND_USER,
                new_revision,
                new_receive_key_hash,
            ),
            field(&derived["newAccountStateCommitment"])
        );
        assert_eq!(
            user_account_update_commitment(address, &current, new_rule_set, new_receive_key_hash),
            fr_to_bytes(field(&update["value"]))
        );
    }

    #[test]
    fn maximum_function_set_matches_frozen_sdk_material() {
        let body = ContractBody {
            publishes_nk_root: false,
            nullifier_key_material: fr_to_bytes(Fr::from(0x51u64)),
            receive_key: None,
            functions: (0..255)
                .map(|selector| crate::transaction::ContractFunction {
                    selector,
                    application_vk_hash: fr_to_bytes(Fr::from(0x52u64)),
                    configuration_commitment: fr_to_bytes(Fr::from(0x53u64)),
                })
                .collect(),
        };
        let material = prepare_contract_body(&body).unwrap();
        assert_eq!(
            fr_to_bytes(material.function_set_commitment),
            "0x15173aa9b2dae6dbd0e67e7e02d1212efaf8710d659462cb29bdd550d59345a5"
                .parse::<B256>()
                .unwrap()
        );
        assert_eq!(
            material.address,
            "0x98eed164c952a4b342cd475c8062fdf5806139f6"
                .parse::<Address>()
                .unwrap()
        );
    }

    #[test]
    fn contract_address_formula_matches_published_vector() {
        let vectors = vectors();
        let account = &vectors["accountStateCommitment"];
        let contract = &vectors["contractAddress"];
        assert_eq!(
            contract_address(
                field(&account["nullifierKeyCommitment"]),
                field(&contract["functionSetCommitment"]),
                field(&contract["receiveKeyHash"]),
                u8::from(contract["publishesNkRoot"].as_bool().unwrap()),
            ),
            address(&contract["address"])
        );
    }

    #[test]
    fn asset_composition_formulas_match_published_vectors() {
        let vectors = vectors();
        let asset = &vectors["assetComposition"];
        let asset_secret_commitment = poseidon(&[
            domain_tags::ASSET_SECRET_COMMITMENT_DOMAIN,
            field(&asset["assetSecret"]),
        ]);
        assert_eq!(
            asset_secret_commitment,
            field(&asset["assetSecretCommitment"])
        );
        let asset_id = poseidon(&[
            domain_tags::ASSET_ID_DOMAIN,
            field(&asset["metadataCommitment"]),
            field(&asset["initialSupply"]),
            asset_secret_commitment,
        ]);
        assert_eq!(asset_id, field(&asset["assetId"]));
        let marker = poseidon(&[
            domain_tags::ASSET_CREATION_MARKER_DOMAIN,
            asset_id,
            field(&asset["assetSecret"]),
        ]);
        assert_eq!(marker, field(&asset["marker"]));
    }

    #[test]
    fn source_and_state_root_match_published_vectors() {
        let vectors = vectors();
        let source_vector = &vectors["genesisParentHash"];
        let anchor_vector = &vectors["l1OriginLeaf"];
        let source = pcash_state::DerivationSource {
            pcash_chain_id: u32::try_from(u64_word(&source_vector["pcashChainId"])).unwrap(),
            l1_chain_id: u64_word(&source_vector["l1ChainId"]),
            inbox_address: address(&source_vector["inboxAddress"]),
            genesis_l1_block: u64_word(&anchor_vector["blockNumber"]),
            genesis_l1_block_hash: B256::from(bytes32(
                anchor_vector["blockHash"].as_str().unwrap(),
            )),
        };
        assert_eq!(source.genesis_parent_hash(), field(&source_vector["value"]));

        assert_eq!(
            pcash_state::state_root_from_components(state_components(&vectors)).0,
            B256::from(bytes32(
                vectors["stateCommitment"]["root"].as_str().unwrap()
            ))
        );
    }

    #[test]
    fn transaction_and_payout_results_match_published_vector() {
        let vector = &vectors()["transactionResults"];
        assert_eq!(
            vector["depth"].as_u64().unwrap() as usize,
            pcash_state::TRANSACTION_RESULTS_TREE_DEPTH
        );
        let small = |value: &Value| value.as_u64().unwrap();
        let mut private_value_lengths = Vec::new();
        let results: Vec<TransactionResult> = vector["transactions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|result| {
                if let Some(statement) = result["statement"].as_array() {
                    let length = statement.len();
                    match (
                        u8::try_from(small(&result["txType"])).unwrap(),
                        small(&result["fundingMode"]),
                    ) {
                        (KIND_PRIVATE_VALUE, _) => private_value_lengths.push(length),
                        (KIND_USER_ACCOUNT_UPDATE, _) => {
                            assert_eq!(length, crate::params::USER_ACCOUNT_UPDATE_PUBLIC_INPUTS);
                        }
                        (KIND_CONTRACT_ACCOUNT_CREATION, 1) => {
                            assert_eq!(length, crate::params::CONTRACT_CREATION_PUBLIC_INPUTS);
                        }
                        // A proofless creation states its account row less kind and revision.
                        _ => assert_eq!(length, 4),
                    }
                    let statement: Vec<Fr> = statement.iter().map(field).collect();
                    assert_eq!(
                        transaction_statement_hash(&statement),
                        field(&result["statementHash"])
                    );
                }
                let outcome_code = u16::try_from(small(&result["outcomeCode"])).unwrap();
                TransactionResult {
                    tx_type: u8::try_from(small(&result["txType"])).unwrap(),
                    funding_mode: u8::try_from(small(&result["fundingMode"])).unwrap(),
                    l1_transaction_index: small(&result["l1TransactionIndex"]),
                    batch_item_index: small(&result["batchItemIndex"]),
                    outcome: <TransactionOutcome as pcash_state::Codec>::decode(
                        &outcome_code.to_be_bytes(),
                    )
                    .unwrap(),
                    poster_owner_commitment: fr_to_bytes(field(&result["posterOwnerCommitment"])),
                    output_start_index: small(&result["outputStartIndex"]),
                    statement_hash: fr_to_bytes(field(&result["statementHash"])),
                }
            })
            .collect();
        assert_eq!(
            private_value_lengths,
            [
                S.public_inputs,
                crate::private_value_profiles::L.public_inputs
            ]
        );
        let payouts: Vec<PayoutRecord> = vector["payouts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|payout| {
                let open_fee_amount =
                    U256::from_be_bytes(bytes32(payout["openFeeAmount"].as_str().unwrap()));
                let issuance_amount =
                    U256::from_be_bytes(bytes32(payout["issuanceAmount"].as_str().unwrap()));
                let (component, amount) = if open_fee_amount.is_zero() {
                    (PayoutComponent::Issuance, issuance_amount)
                } else {
                    (PayoutComponent::OpenFee, open_fee_amount)
                };
                PayoutRecord {
                    source: PayoutSource::PosterPayout {
                        l1_transaction_indices: Vec::new(),
                    },
                    component,
                    amount,
                    owner_commitment: fr_to_bytes(field(&payout["ownerCommitment"])),
                    output_index: small(&payout["outputIndex"]),
                    contexts: Vec::new(),
                }
            })
            .collect();
        assert_eq!(
            pcash_state::transaction_results_root(&results, &payouts),
            B256::from(bytes32(vector["root"].as_str().unwrap()))
        );
        assert_eq!(
            pcash_state::transaction_results_root(&[], &[]),
            B256::from(bytes32(vector["emptyRoot"].as_str().unwrap()))
        );
    }

    #[test]
    fn state_commitment_and_block_header_match_published_vectors() {
        let vectors = vectors();
        let state_vector = &vectors["stateCommitment"];
        assert_eq!(
            state_vector["depth"].as_u64().unwrap() as usize,
            pcash_state::STATE_TREE_DEPTH
        );
        let state = pcash_state::StateCommitment::new(state_components(&vectors));
        assert_eq!(
            fr_to_bytes(state.root),
            bytes32(state_vector["root"].as_str().unwrap())
        );
        let published_leaves = state_vector["leaves"].as_array().unwrap();
        let published_openings = state_vector["openings"].as_array().unwrap();
        assert_eq!(published_leaves.len(), pcash_state::STATE_LEAF_COUNT);
        assert_eq!(published_openings.len(), pcash_state::STATE_LEAF_COUNT);
        for key in 0..pcash_state::STATE_LEAF_COUNT {
            assert_eq!(published_leaves[key]["key"].as_u64().unwrap(), key as u64);
            assert_eq!(state.leaves[key], field(&published_leaves[key]["value"]));

            let opening = &published_openings[key];
            assert_eq!(opening["key"].as_u64().unwrap(), key as u64);
            let expected_siblings: Vec<_> = opening["siblings"]
                .as_array()
                .unwrap()
                .iter()
                .map(field)
                .collect();
            let (value, siblings) = state.path(key as u64).unwrap();
            assert_eq!(value, field(&opening["value"]));
            assert_eq!(siblings.as_slice(), expected_siblings.as_slice());
            assert_eq!(
                typed_root(
                    domain_tags::STATE_COMMITMENT_DOMAIN,
                    value,
                    key as u64,
                    &siblings,
                ),
                state.root
            );
        }

        let header_vector = &vectors["blockHeader"];
        let header = pcash_state::BlockHeader {
            parent_hash: B256::from(bytes32(header_vector["parentHash"].as_str().unwrap())),
            number: u64_word(&header_vector["number"]),
            timestamp: u64_word(&header_vector["timestamp"]),
            transaction_results_root: B256::from(bytes32(
                header_vector["transactionResultsRoot"].as_str().unwrap(),
            )),
            state_root: B256::from(bytes32(header_vector["stateRoot"].as_str().unwrap())),
            l1_origin_root: B256::from(bytes32(header_vector["l1OriginRoot"].as_str().unwrap())),
            history_root: B256::from(bytes32(header_vector["historyRoot"].as_str().unwrap())),
        };
        assert_eq!(header.state_root, fr_to_bytes(state.root));
        assert!(header.is_well_formed());
        assert_eq!(
            header.hash(),
            B256::from(bytes32(header_vector["hash"].as_str().unwrap()))
        );
        let published_leaves = header_vector["leaves"].as_array().unwrap();
        let published_openings = header_vector["openings"].as_array().unwrap();
        assert_eq!(published_leaves.len(), pcash_state::BLOCK_HEADER_LEAF_COUNT);
        assert_eq!(
            published_openings.len(),
            pcash_state::BLOCK_HEADER_LEAF_COUNT
        );
        for key in 0..pcash_state::BLOCK_HEADER_LEAF_COUNT {
            let opening = &published_openings[key];
            let (value, siblings) = header.path(key as u64).unwrap();
            assert_eq!(published_leaves[key]["key"].as_u64().unwrap(), key as u64);
            assert_eq!(value, field(&published_leaves[key]["value"]));
            assert_eq!(opening["key"].as_u64().unwrap(), key as u64);
            assert_eq!(value, field(&opening["value"]));
            let expected_siblings: Vec<_> = opening["siblings"]
                .as_array()
                .unwrap()
                .iter()
                .map(field)
                .collect();
            assert_eq!(siblings.as_slice(), expected_siblings.as_slice());
            assert_eq!(
                typed_root(
                    domain_tags::BLOCK_HEADER_DOMAIN,
                    value,
                    key as u64,
                    &siblings,
                ),
                fr_from_canonical_bytes(header.hash()).unwrap()
            );
        }
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions"
)]
mod unfunded_contract_capacity_tests {
    use super::*;

    /// An unfunded creation never reaches a verifier.
    struct NoVerifier;

    impl Verifier for NoVerifier {
        fn verify(&self, _vk: &[u8], _proof: &[u8], _pi: &[u8]) -> Result<bool, VerifyError> {
            panic!("an unfunded creation has no proof")
        }
    }

    #[test]
    fn unfunded_account_capacity_precedes_timing() {
        let rules = ProtocolRules::new([vec![], vec![]], vec![], vec![]);
        let source = DerivationSource {
            pcash_chain_id: 1,
            l1_chain_id: 1,
            inbox_address: Address::ZERO,
            genesis_l1_block: 0,
            genesis_l1_block_hash: B256::ZERO,
        };
        let state = pcash_state::MemState::new(source);
        let creation = ContractAccountCreation {
            body: ContractBody {
                publishes_nk_root: false,
                nullifier_key_material: fr_to_bytes(Fr::from(1u64)),
                receive_key: None,
                functions: vec![crate::transaction::ContractFunction {
                    selector: 0,
                    application_vk_hash: B256::from(fr_to_bytes(Fr::from(2u64))),
                    configuration_commitment: B256::from(fr_to_bytes(Fr::from(3u64))),
                }],
            },
            funding: ContractFunding::Unfunded {
                recent_pcash_block_hash: CircuitWord::from([0; 32]),
                valid_until_timestamp: 0,
            },
        };
        let ctx = BlockCtx::new(&rules, source, 12, 0, MAX_LEAVES, false);
        let check = ContractBodyCheck(prepare_contract_body(&creation.body));
        assert!(matches!(
            ctx.check_contract_account_creation(
                &state,
                &NoVerifier,
                None,
                Fr::from(0u64),
                &creation,
                &check
            ),
            Err(Halt::Rejected(Rejection {
                outcome: TransactionOutcome::AccountCapacity,
                detail: Some(FailureDetailSeed::Complete(FailureDetail::AccountCapacity {
                    requested_count,
                    limit: MAX_LEAVES,
                })),
            })) if requested_count == MAX_LEAVES + 1
        ));
        let mut last_slot = BlockCtx::new(&rules, source, 12, 0, MAX_LEAVES - 1, false);
        let material = contract_material(&check).unwrap();
        last_slot
            .contract_account_available(&state, material.address)
            .unwrap();
        let account = last_slot.contract_account_diff(&creation.body, material);
        assert_eq!(account.index, MAX_LEAVES - 1);
        last_slot.apply(
            Fr::from(0u64),
            TransactionDiff {
                section: None,
                account: Some(account),
                statement_hash: Fr::from(0u64),
            },
        );
        assert_eq!(last_slot.next_account_index, MAX_LEAVES);
        let mut another_body = creation.body.clone();
        another_body.nullifier_key_material = fr_to_bytes(Fr::from(2u64));
        let material =
            contract_material(&ContractBodyCheck(prepare_contract_body(&another_body))).unwrap();
        assert!(matches!(
            last_slot.contract_account_available(&state, material.address),
            Err(Halt::Rejected(Rejection {
                outcome: TransactionOutcome::AccountCapacity,
                ..
            }))
        ));
    }
}
