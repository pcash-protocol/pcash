//! Canonical PCASH block types and commitments.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "public infallible APIs are backed by fixed-width internal representations"
)]

use crate::codec::{codec_enum, codec_struct};
use crate::commitment_tree::TypedCommitmentTree;
use crate::field::{fr_from_canonical_bytes, fr_from_internal_word, fr_to_bytes, u256_to_fr};
use crate::{
    CanonicalBlockHistory, CommittedBoundary, L1LogLeaf, PayoutRecord, StateComponents,
    TransactionEffects,
};
use alloy_primitives::{keccak256, B256};
use pcash_crypto::{bytes32_limbs, domain_tags, merkle, poseidon, Fr};
use serde::{Deserialize, Serialize};

pub const COMMITMENT_TREE_DEPTH: usize = 4;
pub const BLOCK_HEADER_LEAF_COUNT: usize = 8;

pub const BLOCK_HEADER_KEY_PARENT_HASH: u64 = 0;
pub const BLOCK_HEADER_KEY_NUMBER: u64 = 1;
pub const BLOCK_HEADER_KEY_TIMESTAMP: u64 = 2;
pub const BLOCK_HEADER_KEY_TRANSACTION_RESULTS_ROOT: u64 = 3;
pub const BLOCK_HEADER_KEY_STATE_ROOT: u64 = 4;
pub const BLOCK_HEADER_KEY_L1_ORIGIN_ROOT: u64 = 5;
pub const BLOCK_HEADER_KEY_HISTORY_ROOT: u64 = 6;

/// Depth of the tree of a block's transaction and payout results.
pub const TRANSACTION_RESULTS_TREE_DEPTH: usize = 64;

/// Keccak digest of one transaction's exact serialized bytes.
pub fn content_hash(transaction: &[u8]) -> B256 {
    keccak256(transaction)
}

/// Reorg-sensitive identifier of one exact canonical L1 inclusion, as its
/// canonical field bytes.
pub fn transaction_id(
    l1_block_hash: B256,
    l1_transaction_index: u64,
    batch_item_index: u64,
) -> B256 {
    let (block_hash_high, block_hash_low) = bytes32_limbs(&l1_block_hash.0);
    fr_to_bytes(poseidon(&[
        domain_tags::TRANSACTION_ID_DOMAIN,
        block_hash_high,
        block_hash_low,
        Fr::from(l1_transaction_index),
        Fr::from(batch_item_index),
    ]))
}

/// Consensus outcome assigned to one admitted transaction.
///
/// The integer discriminants are protocol values. New outcomes may be appended,
/// but an existing discriminant must never be reassigned.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u16)]
#[serde(rename_all = "camelCase")]
pub enum TransactionOutcome {
    Succeeded = 0,
    PublicInputNotInField = 1,
    RecentPcashBlockNotInWindow = 2,
    Expired = 3,
    NotYetValid = 4,
    ZeroNullifier = 5,
    DuplicateInputNullifier = 6,
    NullifierAlreadySpent = 7,
    ProofRejected = 8,
    OutputCapacity = 9,
    AccountCapacity = 10,
    InvalidAccountSignature = 11,
    AccountNotFound = 12,
    AccountAlreadyExists = 13,
    AccountRevisionExhausted = 14,
    WrongAccountKind = 15,
    ClearWithoutReceiveKey = 16,
    ReplaceWithIdenticalReceiveKey = 17,
    AccountUpdateCommitmentMismatch = 18,
    NonCanonicalAccountField = 19,
    ContractAddressExists = 20,
    NonCanonicalContractField = 21,
    EmptyContractFunctionSet = 22,
    SelectorsNotStrictlyIncreasing = 23,
    CarrierContextMismatch = 24,
    AccountCreationMismatch = 25,
}

codec_enum!(TransactionOutcome: u16 {
    Succeeded,
    PublicInputNotInField,
    RecentPcashBlockNotInWindow,
    Expired,
    NotYetValid,
    ZeroNullifier,
    DuplicateInputNullifier,
    NullifierAlreadySpent,
    ProofRejected,
    OutputCapacity,
    AccountCapacity,
    InvalidAccountSignature,
    AccountNotFound,
    AccountAlreadyExists,
    AccountRevisionExhausted,
    WrongAccountKind,
    ClearWithoutReceiveKey,
    ReplaceWithIdenticalReceiveKey,
    AccountUpdateCommitmentMismatch,
    NonCanonicalAccountField,
    ContractAddressExists,
    NonCanonicalContractField,
    EmptyContractFunctionSet,
    SelectorsNotStrictlyIncreasing,
    CarrierContextMismatch,
    AccountCreationMismatch,
});

impl TransactionOutcome {
    pub const fn as_u16(self) -> u16 {
        self as u16
    }

    pub const fn is_succeeded(self) -> bool {
        matches!(self, Self::Succeeded)
    }
}

/// Canonical result of one admitted transaction at its exact L1 inclusion
/// position. Its dense position in the block is its `pcashTransactionIndex`;
/// the block's L1 origin supplies the L1 block.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransactionResult {
    pub tx_type: u8,
    /// Account creation: 0 for none, 1 for insertion, 2 for reuse.
    pub account_creation: u8,
    pub l1_transaction_index: u64,
    pub batch_item_index: u64,
    pub outcome: TransactionOutcome,
    /// The `posterOwnerCommitment` of the transaction's batch.
    pub poster_owner_commitment: B256,
    /// The first output index a successful private-value section appended;
    /// zero for any other result.
    pub output_start_index: u64,
    /// [`transaction_statement_hash`] of a successful transaction's
    /// statement; zero for a failed one.
    pub statement_hash: B256,
}

codec_struct!(TransactionResult {
    tx_type,
    account_creation,
    l1_transaction_index,
    batch_item_index,
    outcome,
    poster_owner_commitment,
    output_start_index,
    statement_hash,
});

/// `poseidon(TRANSACTION_STATEMENT_DOMAIN, statement...)`. A proof-bearing
/// transaction's statement is its verifier's public inputs; an account
/// creation without a proof states the account row it writes.
pub fn transaction_statement_hash(statement: &[Fr]) -> Fr {
    let mut inputs = Vec::with_capacity(statement.len() + 1);
    inputs.push(domain_tags::TRANSACTION_STATEMENT_DOMAIN);
    inputs.extend_from_slice(statement);
    poseidon(&inputs)
}

/// The leaf omits `pcashTransactionIndex`: the leaf's tree index is the
/// transaction's position.
fn transaction_result_leaf(result: &TransactionResult) -> Fr {
    poseidon(&[
        domain_tags::TRANSACTION_RESULT_DOMAIN,
        Fr::from(u64::from(result.tx_type)),
        Fr::from(u64::from(result.account_creation)),
        Fr::from(result.l1_transaction_index),
        Fr::from(result.batch_item_index),
        Fr::from(u64::from(result.outcome.as_u16())),
        fr_from_internal_word(result.poster_owner_commitment),
        Fr::from(result.output_start_index),
        fr_from_internal_word(result.statement_hash),
    ])
}

fn payout_result_leaf(payout: &PayoutRecord) -> Fr {
    let (open_fee_amount, issuance_amount) = payout.result_components();
    poseidon(&[
        domain_tags::PAYOUT_RESULT_DOMAIN,
        Fr::from(payout.output_index),
        fr_from_internal_word(payout.owner_commitment),
        u256_to_fr(open_fee_amount),
        u256_to_fr(issuance_amount),
    ])
}

/// Header value committing every admitted transaction's result in block
/// order, then every system payout in settlement order: their depth-64 tree
/// root, bound with both counts.
pub fn transaction_results_root(
    transaction_results: &[TransactionResult],
    payouts: &[PayoutRecord],
) -> B256 {
    fr_to_bytes(poseidon(&[
        domain_tags::TRANSACTION_RESULTS_ROOT_DOMAIN,
        Fr::from(transaction_results.len() as u64),
        Fr::from(payouts.len() as u64),
        result_tree_levels(transaction_results, payouts)[TRANSACTION_RESULTS_TREE_DEPTH]
            .first()
            .copied()
            .unwrap_or_else(|| merkle::empty(TRANSACTION_RESULTS_TREE_DEPTH)),
    ]))
}

fn result_tree_levels(results: &[TransactionResult], payouts: &[PayoutRecord]) -> Vec<Vec<Fr>> {
    let leaves = results
        .iter()
        .map(transaction_result_leaf)
        .chain(payouts.iter().map(payout_result_leaf))
        .collect();
    merkle::dense_levels(leaves, TRANSACTION_RESULTS_TREE_DEPTH)
}

/// A result leaf opening and the unbound tree root.
pub fn result_tree_path(
    results: &[TransactionResult],
    payouts: &[PayoutRecord],
    index: u64,
) -> Option<(Fr, [Fr; TRANSACTION_RESULTS_TREE_DEPTH])> {
    if index >= (results.len() + payouts.len()) as u64 {
        return None;
    }
    let levels = result_tree_levels(results, payouts);
    let siblings = std::array::from_fn(|height| {
        levels[height]
            .get(((index >> height) ^ 1) as usize)
            .copied()
            .unwrap_or_else(|| merkle::empty(height))
    });
    Some((levels[TRANSACTION_RESULTS_TREE_DEPTH][0], siblings))
}

fn commitment_tree(leaves: &[Fr; BLOCK_HEADER_LEAF_COUNT]) -> TypedCommitmentTree {
    TypedCommitmentTree::new(domain_tags::BLOCK_HEADER_DOMAIN, leaves)
}

/// Intrinsic PCASH block header.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockHeader {
    pub parent_hash: B256,
    pub number: u64,
    pub timestamp: u64,
    pub transaction_results_root: B256,
    pub state_root: B256,
    pub l1_origin_root: B256,
    pub history_root: B256,
}

codec_struct!(BlockHeader {
    parent_hash,
    number,
    timestamp,
    transaction_results_root,
    state_root,
    l1_origin_root,
    history_root,
});

impl BlockHeader {
    /// Leaves in key order (`BLOCK_HEADER_KEY_*`); key 7 is unassigned.
    pub fn leaves(&self) -> Option<[Fr; BLOCK_HEADER_LEAF_COUNT]> {
        Some([
            fr_from_canonical_bytes(self.parent_hash)?,
            Fr::from(self.number),
            Fr::from(self.timestamp),
            fr_from_canonical_bytes(self.transaction_results_root)?,
            fr_from_canonical_bytes(self.state_root)?,
            fr_from_canonical_bytes(self.l1_origin_root)?,
            fr_from_canonical_bytes(self.history_root)?,
            Fr::from(0u64),
        ])
    }

    pub fn try_hash(&self) -> Option<B256> {
        let leaves = self.leaves()?;
        Some(fr_to_bytes(commitment_tree(&leaves).root()))
    }

    pub fn hash(&self) -> B256 {
        self.try_hash()
            .expect("block header contains a noncanonical field encoding")
    }

    pub fn path(&self, key: u64) -> Option<(Fr, [Fr; COMMITMENT_TREE_DEPTH])> {
        if key >= 1u64 << COMMITMENT_TREE_DEPTH {
            return None;
        }
        let leaves = self.leaves()?;
        let tree = commitment_tree(&leaves);
        tree.path(key)
    }

    pub fn is_well_formed(&self) -> bool {
        self.try_hash().is_some()
            && (self.number == 0 || self.parent_hash != B256::ZERO)
            && self.state_root != B256::ZERO
            && self.l1_origin_root != B256::ZERO
            && self.history_root != B256::ZERO
    }
}

/// Ethereum input that produced a PCASH block. This is provenance, not header data.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct L1Origin {
    pub block_number: u64,
    pub block_hash: B256,
    pub block_timestamp: u64,
    pub l1_logs_root: B256,
    pub l1_log_count: u64,
}

codec_struct!(L1Origin {
    block_number,
    block_hash,
    block_timestamp,
    l1_logs_root,
    l1_log_count,
});

impl L1Origin {
    pub fn same_block(&self, other: &Self) -> bool {
        self.block_number == other.block_number && self.block_hash == other.block_hash
    }
}

/// Inputs known before the post-transition state root is computed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockInput {
    pub number: u64,
    pub timestamp: u64,
    pub transaction_results: Vec<TransactionResult>,
    /// Exact `txBytes` for each admitted transaction, in the same dense order
    /// as `transaction_results`.
    pub transaction_bytes: Vec<Vec<u8>>,
    pub l1_origin: L1Origin,
    pub history: CanonicalBlockHistory,
    /// Stored with the block, aligned with `transaction_results`.
    pub transaction_effects: Vec<TransactionEffects>,
    /// Every log of the L1 origin in leaf order, stored with the block.
    pub l1_logs: Vec<L1LogLeaf>,
}

/// One canonical PCASH block plus its non-header derivation provenance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PcashBlock {
    pub header: BlockHeader,
    pub hash: B256,
    pub transaction_results: Vec<TransactionResult>,
    /// Canonical block-body transactions, aligned with `transaction_results`.
    /// The L1 origin's block hash commits them through their carriers.
    pub transaction_bytes: Vec<Vec<u8>>,
    pub l1_origin: L1Origin,
}

/// A canonical block without its transactions: header, hash, L1 origin, and
/// the named components of its state root. Fixed size, so tip, root, and count
/// reads never decode a transaction list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredBlock {
    pub header: BlockHeader,
    pub hash: B256,
    pub l1_origin: L1Origin,
    pub state: StateComponents,
}

codec_struct!(StoredBlock {
    header,
    hash,
    l1_origin,
    state,
});

codec_struct!(pcash_issuance::IssuanceState {
    issued_so_far,
    lag_q
});

codec_struct!(StateComponents {
    output_root,
    output_count,
    issuance,
    account_state_root,
    account_count,
    nullifier_root,
    nullifier_count,
});

impl From<&CommittedBoundary> for StoredBlock {
    fn from(boundary: &CommittedBoundary) -> Self {
        Self {
            header: boundary.block.header.clone(),
            hash: boundary.block.hash,
            l1_origin: boundary.l1_origin.clone(),
            state: boundary.state.state_components(),
        }
    }
}

impl StoredBlock {
    pub fn with_transaction_results(
        self,
        transaction_results: Vec<TransactionResult>,
    ) -> PcashBlockMetadata {
        PcashBlockMetadata {
            header: self.header,
            hash: self.hash,
            transaction_results,
            l1_origin: self.l1_origin,
        }
    }
}

/// A canonical block with its transaction results but not their bodies.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PcashBlockMetadata {
    pub header: BlockHeader,
    pub hash: B256,
    pub transaction_results: Vec<TransactionResult>,
    pub l1_origin: L1Origin,
}

impl From<&PcashBlock> for PcashBlockMetadata {
    fn from(block: &PcashBlock) -> Self {
        Self {
            header: block.header.clone(),
            hash: block.hash,
            transaction_results: block.transaction_results.clone(),
            l1_origin: block.l1_origin.clone(),
        }
    }
}

impl PcashBlockMetadata {
    pub fn with_transaction_bytes(self, transaction_bytes: Vec<Vec<u8>>) -> PcashBlock {
        PcashBlock {
            header: self.header,
            hash: self.hash,
            transaction_results: self.transaction_results,
            transaction_bytes,
            l1_origin: self.l1_origin,
        }
    }
}

/// Identity and timestamp of a canonical block, without its transaction list.
/// Metadata-only reads take this so serving head data never copies the tip.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BlockSummary {
    pub number: u64,
    pub hash: B256,
    pub timestamp: u64,
}

impl From<&StoredBlock> for BlockSummary {
    fn from(block: &StoredBlock) -> Self {
        Self {
            number: block.header.number,
            hash: block.hash,
            timestamp: block.header.timestamp,
        }
    }
}

impl PcashBlock {
    pub fn new(
        parent_hash: B256,
        input: &BlockInput,
        state_root: B256,
        l1_origin_root: Fr,
        history_root: Fr,
    ) -> Self {
        let header = BlockHeader {
            parent_hash,
            number: input.number,
            timestamp: input.timestamp,
            transaction_results_root: transaction_results_root(
                &input.transaction_results,
                &input.history.payouts,
            ),
            state_root,
            l1_origin_root: fr_to_bytes(l1_origin_root),
            history_root: fr_to_bytes(history_root),
        };
        let hash = header.hash();
        Self {
            header,
            hash,
            transaction_results: input.transaction_results.clone(),
            transaction_bytes: input.transaction_bytes.clone(),
            l1_origin: input.l1_origin.clone(),
        }
    }

    /// `payouts` are the block's payout records, whose results the header
    /// commits after the transaction results.
    pub fn is_well_formed(&self, payouts: &[PayoutRecord]) -> bool {
        self.header.is_well_formed()
            && self.header.try_hash() == Some(self.hash)
            && self.header.transaction_results_root
                == transaction_results_root(&self.transaction_results, payouts)
            && self.transaction_bytes.len() == self.transaction_results.len()
            && self.transaction_results.windows(2).all(|pair| {
                let previous = &pair[0];
                let next = &pair[1];
                if next.l1_transaction_index == previous.l1_transaction_index {
                    next.batch_item_index > previous.batch_item_index
                } else {
                    next.l1_transaction_index > previous.l1_transaction_index
                }
            })
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

    fn canonical(value: u64) -> B256 {
        fr_to_bytes(Fr::from(value))
    }

    #[test]
    fn typed_header_paths_reconstruct_the_domain_separated_root() {
        let header = BlockHeader {
            parent_hash: canonical(1),
            number: 7,
            timestamp: 1_800_000_000,
            transaction_results_root: transaction_results_root(&[], &[]),
            state_root: canonical(2),
            l1_origin_root: canonical(3),
            history_root: canonical(4),
        };
        let key = BLOCK_HEADER_KEY_STATE_ROOT;
        let (leaf, path) = header.path(key).unwrap();
        assert_eq!(leaf, Fr::from(2u64));
        let root = path
            .iter()
            .enumerate()
            .fold(leaf, |current, (height, sibling)| {
                if (key >> height) & 1 == 0 {
                    poseidon(&[domain_tags::BLOCK_HEADER_DOMAIN, current, *sibling])
                } else {
                    poseidon(&[domain_tags::BLOCK_HEADER_DOMAIN, *sibling, current])
                }
            });
        assert_eq!(header.hash(), fr_to_bytes(root));
    }

    #[test]
    fn arbitrary_header_field_encodings_are_rejected() {
        let header = BlockHeader {
            parent_hash: canonical(1),
            number: 1,
            timestamp: 2,
            transaction_results_root: transaction_results_root(&[], &[]),
            state_root: canonical(2),
            l1_origin_root: canonical(3),
            history_root: canonical(4),
        };
        assert!(header.is_well_formed());
        let mut noncanonical = header.clone();
        noncanonical.state_root = B256::repeat_byte(0xff);
        assert!(!noncanonical.is_well_formed());
        noncanonical = header;
        noncanonical.transaction_results_root = B256::repeat_byte(0xff);
        assert!(!noncanonical.is_well_formed());
    }

    #[test]
    fn transaction_id_matches_published_vector() {
        let vectors: serde_json::Value =
            serde_json::from_str(include_str!("../../../../vectors/protocol_vectors.json"))
                .unwrap();
        let vector = &vectors["transactionId"];
        let word = |value: &serde_json::Value| value.as_str().unwrap().parse::<B256>().unwrap();
        assert_eq!(
            transaction_id(
                word(&vector["l1BlockHash"]),
                vector["l1TransactionIndex"].as_u64().unwrap(),
                vector["batchItemIndex"].as_u64().unwrap(),
            ),
            word(&vector["value"])
        );
    }

    #[test]
    fn transaction_outcomes_are_pinned() {
        let codes = [
            TransactionOutcome::Succeeded,
            TransactionOutcome::PublicInputNotInField,
            TransactionOutcome::RecentPcashBlockNotInWindow,
            TransactionOutcome::Expired,
            TransactionOutcome::NotYetValid,
            TransactionOutcome::ZeroNullifier,
            TransactionOutcome::DuplicateInputNullifier,
            TransactionOutcome::NullifierAlreadySpent,
            TransactionOutcome::ProofRejected,
            TransactionOutcome::OutputCapacity,
            TransactionOutcome::AccountCapacity,
            TransactionOutcome::InvalidAccountSignature,
            TransactionOutcome::AccountNotFound,
            TransactionOutcome::AccountAlreadyExists,
            TransactionOutcome::AccountRevisionExhausted,
            TransactionOutcome::WrongAccountKind,
            TransactionOutcome::ClearWithoutReceiveKey,
            TransactionOutcome::ReplaceWithIdenticalReceiveKey,
            TransactionOutcome::AccountUpdateCommitmentMismatch,
            TransactionOutcome::NonCanonicalAccountField,
            TransactionOutcome::ContractAddressExists,
            TransactionOutcome::NonCanonicalContractField,
            TransactionOutcome::EmptyContractFunctionSet,
            TransactionOutcome::SelectorsNotStrictlyIncreasing,
            TransactionOutcome::CarrierContextMismatch,
            TransactionOutcome::AccountCreationMismatch,
        ];
        for (expected, code) in codes.into_iter().enumerate() {
            assert_eq!(usize::from(code.as_u16()), expected);
        }
    }
}
